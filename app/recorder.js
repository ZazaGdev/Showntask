// Recording, the main side: pick the area, count down, start the worker's MediaRecorder,
// then keep the time (paused time left out, as MediaRecorder leaves it out of the video), the
// cursor every 200 ms, the clicks and the "Mark this" markers. events.json is written every few
// seconds, so a crash loses little. Stop hands the recording to processing.
import fs from 'node:fs';
import { desktopCapturer, screen } from 'electron';
import { cropFor } from './lib/area.js';
import { createFolder, save, files, writeJson } from './lib/store.js';
import { newRecording, next } from './lib/session.js';

// The desktop source for a display: its id for getUserMedia and its size in pixels.
async function sourceFor(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (!sources.length) throw new Error('Windows offered no screen to record');
  const one = screen.getAllDisplays().length === 1;
  const src = sources.find(s => String(s.display_id) === String(display.id)) || (one ? sources[0] : null);
  if (!src) throw new Error('Windows did not say which screen is which, so the area could not be found');
  const f = display.scaleFactor || 1;
  return { id: src.id, width: Math.round(display.size.width * f), height: Math.round(display.size.height * f) };
}

export function recorder({ worker, area, settings, root, onChange = () => {}, onStopped = () => {}, log = () => {}, fake = false, auto = null }) {
  let cur = null, last = null, busy = false; // last: the area picked before, for Record without picking

  const t = () => (cur ? (cur.elapsed + (cur.paused ? 0 : Date.now() - cur.since)) / 1000 : 0);
  const round = v => Math.round(v * 10) / 10;
  const flush = () => { if (cur) writeJson(files(cur.dir).events, { clicks: cur.clicks, markers: cur.markers, pauses: cur.pauses, cursor: cur.cursor, area: cur.area }); };
  const state = () => (cur ? { recording: true, id: cur.id, paused: cur.paused, muted: cur.muted, elapsed: Math.round(t() * 1000), markers: cur.markers.length } : { recording: false });
  const tell = () => onChange(state());

  // repick: always show the overlay; else the last area is used again when there is one.
  async function start({ repick = false } = {}) {
    if (cur || busy) return { error: cur ? 'Already recording' : 'Starting' };
    busy = true;
    try {
      const s = settings();
      let picked = !repick && last ? last : null;
      if (!picked) {
        if (area.picking()) { area.cancelPick(); return { cancel: true }; }
        picked = await area.pickArea({ mic: s.mic, auto });
        if (!picked) return { cancel: true };
      }
      last = picked;
      const source = fake ? null : await sourceFor(picked.display);
      const crop = source ? cropFor(picked.rect, picked.display.scaleFactor || 1, source) : null;
      if (s.countdown) await area.countdown({ display: picked.display, rect: picked.rect, secs: fake ? 1 : 3 });
      const { id, dir } = createFolder(root());
      const rec = newRecording(id, Date.now(), { mic: picked.mic, area: picked.rect });
      save(dir, rec);
      try { await worker.call('start', { dir, source, crop, mic: picked.mic, fake }); } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        return { error: e.message };
      }
      cur = { id, dir, rec, elapsed: 0, since: Date.now(), paused: false, muted: false, clicks: [], markers: [], pauses: [], cursor: [], area: picked.rect };
      area.showRecording({ display: picked.display, rect: picked.rect, mic: picked.mic, onAction: what => act(what) });
      const origin = { x: picked.display.bounds.x + picked.rect.x, y: picked.display.bounds.y + picked.rect.y };
      cur.timers = [
        setInterval(() => {
          if (!cur || cur.paused) return;
          const p = screen.getCursorScreenPoint(), x = p.x - origin.x, y = p.y - origin.y;
          if (x >= 0 && y >= 0 && x < picked.rect.width && y < picked.rect.height) cur.cursor.push([round(t()), x, y]);
        }, 200),
        setInterval(flush, 5000),
      ];
      tell();
      return { id };
    } catch (e) {
      return { error: e.message };
    } finally { busy = false; }
  }

  async function pause() {
    if (!cur) return false;
    if (cur.paused) {
      await worker.call('resume');
      cur.paused = false; cur.since = Date.now();
      cur.pauses[cur.pauses.length - 1].resumed = Date.now();
    } else {
      await worker.call('pause');
      cur.elapsed += Date.now() - cur.since; cur.paused = true;
      cur.pauses.push({ at: round(t()), paused: Date.now() });
    }
    area.barState({ paused: cur.paused, elapsed: Math.round(t() * 1000) });
    tell();
    return true;
  }

  function mark() {
    if (!cur) return false;
    cur.markers.push(round(t()));
    area.barState({ marked: true });
    flush(); tell();
    return true;
  }

  async function mute() {
    if (!cur || !cur.rec.mic) return false;
    cur.muted = !cur.muted;
    await worker.call('mute', { on: cur.muted });
    area.barState({ muted: cur.muted });
    tell();
    return true;
  }

  async function stop() {
    const c = cur;
    if (!c) return false;
    const duration = t();
    for (const x of c.timers || []) clearInterval(x);
    area.closeRecording();
    try { await worker.call('stop'); } catch (e) { log(`stop: ${e.message}`); }
    flush();
    cur = null;
    save(c.dir, next(c.rec, { type: 'stop', at: Date.now(), duration }));
    tell();
    onStopped(c.id);
    return true;
  }

  function act(what) {
    if (what === 'stop') return stop();
    if (what === 'pause') return pause();
    if (what === 'mark') return mark();
    if (what === 'mute') return mute();
    return null;
  }

  return {
    start, stop, pause, mark, mute, state,
    toggle: () => (cur ? stop() : start()),
    repick: () => (cur ? null : start({ repick: true })),
    current: () => cur,
    voice: v => area.barState({ voice: v }),
    // A click inside the area, from the overlay's mouse watcher.
    click: at => { if (cur && !cur.paused) cur.clicks.push({ t: round(t()), x: at.x, y: at.y }); },
  };
}
