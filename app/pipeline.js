// Processing: after Stop or Import, each recording goes through the steps in
// lib/session.js, one recording at a time. Each step writes its file before the next starts and
// is skipped when its file is already there, so after a crash or a freeze the work picks up
// where it stopped. The page-side steps run in the hidden worker; Whisper runs as a child.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { STEPS, next, nextToProcess } from './lib/session.js';
import { loadAll, dirOf, save, load, files, videoOf, size, writeJson, writeText, titleOf, readJson } from './lib/store.js';
import { reader, open as openMkv, writeSeekable } from './lib/ebml.js';
import { pieces, pcmOf, wavBytes, dropLoops } from './lib/chunks.js';
import { parseWhisper, transcriptMd, whisperArgs } from './lib/transcript.js';
import { whisperLanguage } from './lib/settings.js';
import { writeMakeTasks } from './lib/recfiles.js';
import { ensure } from './speech.js';

const BATCH = 8; // Whisper pieces per whisper-cli run: one model load each, and a restart loses little

function fileReader(f) {
  const fd = fs.openSync(f, 'r');
  const r = reader((pos, len) => { const b = new Uint8Array(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); }, fs.fstatSync(fd).size);
  r.close = () => fs.closeSync(fd);
  return r;
}

// A MediaRecorder WebM written again with its length and cues, so players and the frame grab can
// seek it. A file that already has cues is left as it is.
export function makeSeekable(video) {
  const r = fileReader(video);
  let res = null;
  const tmp = video.replace(/\.webm$/, '.seek.webm');
  try {
    const m = openMkv(r);
    if (m.cuesEl && m.duration) return { duration: m.duration, already: true };
    const fd = fs.openSync(tmp, 'w');
    try { res = writeSeekable(r, m, b => fs.writeSync(fd, b)); } finally { fs.closeSync(fd); }
  } finally { r.close(); }
  fs.renameSync(tmp, video);
  return res;
}

// children: the Whisper runs going now, so a quit can stop them.
const children = new Set();
export const killAll = () => { for (const c of children) try { c.kill(); } catch { /* gone */ } children.clear(); };
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      children.delete(c);
      if (!err) return resolve(out);
      reject(new Error(String(errOut || '').trim().split(/\r?\n/).slice(-2).join(' ') || err.message));
    });
    children.add(c);
  });
}

// The canned transcript of the smoke run, which has no voice to transcribe.
const CANNED = [
  { at: 0.5, end: 2.5, text: 'Okay, this is the dashboard and this button here does nothing.' },
  { at: 2.6, end: 4.8, text: 'The score at the top should show the weekly change.' },
];

export function pipeline({ worker, settings, root, onChange = () => {}, log = () => {}, fake = false }) {
  let busy = false, stopped = false, progress = null;
  const tell = () => onChange(progress);

  async function step(dir, rec, name) {
    const f = files(dir), video = videoOf(dir, rec), s = settings();
    const report = (what, at, of) => { progress = { id: rec.id, step: name, what, at, of }; tell(); };
    report('', 0, 0);
    if (name === 'audio') {
      if (fs.existsSync(f.wav)) return {};
      if (!size(video)) throw new Error(rec.imported ? `The video is gone: ${video}` : 'Nothing was recorded');
      let duration = rec.duration;
      if (!rec.imported) { const r = makeSeekable(video); if (r && r.duration) duration = r.duration; }
      const a = await worker.call('audio', { video, wav: f.wav }, p => report('', p.at, p.of));
      return { duration: duration || a.duration, sound: a.sound };
    }
    if (name === 'scenes') {
      if (fs.existsSync(path.join(f.frames, 'samples.bin'))) return {};
      await worker.call('scenes', { video, out: f.frames }, p => report('', p.at, p.of));
      return {};
    }
    if (name === 'chunks') {
      const index = path.join(f.chunks, 'index.json');
      if (fs.existsSync(index)) return {};
      fs.mkdirSync(f.chunks, { recursive: true });
      const pcm = pcmOf(fs.readFileSync(f.wav)), list = pieces(pcm);
      list.forEach((p, i) => fs.writeFileSync(path.join(f.chunks, `${String(i).padStart(4, '0')}.wav`), wavBytes(pcm.subarray(p.from, p.to))));
      writeJson(index, list.map((p, i) => ({ file: `${String(i).padStart(4, '0')}.wav`, at: p.from / 16000, end: p.to / 16000 })));
      return {};
    }
    if (name === 'transcript') {
      if (fs.existsSync(f.json)) return {};
      const list = readJson(path.join(f.chunks, 'index.json'), []);
      let lines = [];
      if (fake) lines = CANNED;
      else if (list.length && rec.sound !== false) {
        const at = await ensure(s, p => report(`Downloading ${p.what}`, p.done, p.total));
        const lang = whisperLanguage(s.model, s.language), threads = Math.max(2, os.cpus().length - 2);
        const todo = list.filter(c => !fs.existsSync(path.join(f.chunks, `${c.file}.json`)));
        const t0 = Date.now(), first = list.length - todo.length;
        for (let i = 0; i < todo.length; i += BATCH) {
          if (stopped) throw new Error('Stopped');
          const batch = todo.slice(i, i + BATCH), done = first + i;
          const left = i ? Math.round(((Date.now() - t0) / i) * (todo.length - i) / 1000) : null;
          report(left !== null ? `about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left` : '', done, list.length);
          await run(at.cli, whisperArgs({ model: at.model, wavs: batch.map(c => path.join(f.chunks, c.file)), threads, lang }));
        }
        for (const c of list) {
          const j = readJson(path.join(f.chunks, `${c.file}.json`), null);
          if (j) lines.push(...parseWhisper(j, c.at));
        }
        lines = dropLoops(lines);
      }
      writeJson(f.json, { lines });
      writeText(f.md, transcriptMd(lines, { title: titleOf(rec), video }));
      return {};
    }
    if (name === 'frames') {
      if (!fs.existsSync(f.candidates)) {
        const ev = readJson(f.events, {}) || {};
        const lines = (readJson(f.json, {}) || {}).lines || [];
        const list = await worker.call('frames', { video, dir, lines, clicks: ev.clicks || [], markers: ev.markers || [], width: s.frameWidth }, p => report('', p.at, p.of));
        writeJson(f.candidates, list);
      }
      writeMakeTasks(dir, rec, s);
      return {};
    }
    throw new Error(`Unknown step ${name}`);
  }

  // Works through every recording waiting in processing, one step at a time.
  async function kick() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (;;) {
        const r = root(), cur = nextToProcess(loadAll(r));
        if (!cur || stopped) break;
        const dir = dirOf(r, cur.id);
        let rec = cur;
        while (rec.state === 'processing' && !stopped) {
          const name = rec.step;
          try {
            const patch = await step(dir, rec, name);
            rec = next(load(dir) || rec, { type: 'stepDone', step: name, patch });
          } catch (e) {
            log(`${rec.id} ${name}: ${e.stack || e.message}`);
            if (stopped) break;
            rec = next(load(dir) || rec, { type: 'stepFailed', step: name, error: e.message });
          }
          save(dir, rec);
          progress = null;
          tell();
        }
      }
    } finally { busy = false; progress = null; tell(); }
  }

  return {
    kick,
    progress: () => progress,
    stop() { stopped = true; killAll(); },
    // A recording processed again from a step: that step's files go first.
    redo(id, from) {
      const dir = dirOf(root(), id);
      if (!dir || !STEPS.includes(from)) return false;
      const rec = load(dir), f = files(dir);
      const gone = { audio: [f.wav], scenes: [path.join(f.frames, 'samples.bin')], chunks: [f.chunks], transcript: [f.json, f.md], frames: [f.candidates, f.makeTasks] };
      for (const s of STEPS.slice(STEPS.indexOf(from))) for (const p of gone[s]) fs.rmSync(p, { recursive: true, force: true });
      if (STEPS.indexOf(from) <= STEPS.indexOf('frames')) for (const sub of ['', 'thumbs', 'tiles']) {
        const d = path.join(f.frames, sub);
        try { for (const n of fs.readdirSync(d)) if (/\.(jpg|png)$/.test(n)) fs.rmSync(path.join(d, n), { force: true }); } catch { /* none */ }
      }
      save(dir, next(rec, { type: 'redo', from }));
      kick();
      return true;
    },
    retry(id) {
      const dir = dirOf(root(), id);
      if (!dir) return false;
      save(dir, next(load(dir), { type: 'retry' }));
      kick();
      return true;
    },
  };
}
