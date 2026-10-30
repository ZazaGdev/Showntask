import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reader, open, clusters, frames, header, writeSeekable, ID } from '../app/lib/ebml.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Six seconds recorded by Electron's MediaRecorder: VP8 at 5 fps with a keyframe every 2 s, and
// Opus, no length and no cues, unknown-size clusters.
const REC = fs.readFileSync(path.join(here, 'fixtures', 'rec5.webm'));
const memReader = buf => reader((pos, len) => buf.subarray(pos, Math.min(buf.length, pos + len)), buf.length, 4096);

test('ebml: a MediaRecorder WebM opens with its tracks and no length or cues', () => {
  const r = memReader(REC), m = open(r);
  assert.equal(m.duration, null);
  assert.equal(m.cuesEl, null);
  assert.deepEqual(m.tracks.map(t => [t.kind, t.codec]), [['video', 'V_VP8'], ['audio', 'A_OPUS']]);
  assert.equal(m.tracks[0].width, 1280);
  assert.equal(m.tracks[1].rate, 48000);
});

test('ebml: every frame is found, in time, with keyframes every 2 s', () => {
  const r = memReader(REC), m = open(r);
  const all = [...clusters(r, m)].flatMap(c => [...frames(r, m, c)]);
  const video = all.filter(f => f.track === 1), audio = all.filter(f => f.track === 2);
  assert.ok(video.length >= 28 && video.length <= 32, `video frames: ${video.length}`);
  assert.ok(audio.length >= 90 && audio.length <= 105, `audio frames: ${audio.length}`); // 60 ms Opus packets
  const keys = video.filter(f => f.key).map(f => f.time);
  assert.ok(keys.length >= 3, `keys: ${keys}`);
  assert.equal(keys[0], 0);
  for (const f of all) assert.ok(f.pos > 0 && f.len > 0 && f.pos + f.len <= REC.length);
});

function seekable(buf) {
  const r = memReader(buf), parts = [];
  const res = writeSeekable(r, open(r), b => parts.push(Buffer.from(b)));
  return { res, out: Buffer.concat(parts) };
}

test('ebml: the seekable copy has a length, cues that point at clusters, and the same frames', () => {
  const { res, out } = seekable(REC);
  const r = memReader(out), m = open(r);
  assert.ok(Math.abs(m.duration - res.duration) < 0.002 && res.duration > 5.5, `duration ${m.duration}`);
  assert.equal(m.seg.end, out.length, 'the Segment size covers the file');
  assert.ok(m.cuesEl, 'cues are written');
  // every cue lands on a Cluster
  const cues = [];
  for (const cp of childrenOf(r, m.cuesEl)) {
    const tp = childrenOf(r, cp).find(x => x.id === ID.CueTrackPositions);
    const pos = childrenOf(r, tp).find(x => x.id === ID.CueClusterPosition);
    cues.push(uintAt(r, pos));
  }
  assert.equal(cues.length, res.cues);
  for (const c of cues) assert.equal(header(r, m.seg.data + c).id, ID.Cluster);
  const before = framesOf(memReader(REC)), after = framesOf(r);
  assert.deepEqual(after.map(f => [f.track, f.time, f.key, f.len]), before.map(f => [f.track, f.time, f.key, f.len]));
});

test('ebml: a recording cut off mid-cluster still reads and writes, without the half frame', () => {
  const cut = REC.subarray(0, Math.floor(REC.length * 0.7));
  const all = framesOf(memReader(cut));
  assert.ok(all.length > 60 && all.length < framesOf(memReader(REC)).length);
  for (const f of all) assert.ok(f.pos + f.len <= cut.length);
  const { res, out } = seekable(cut);
  assert.ok(res.duration > 3 && res.duration < 5);
  assert.equal(framesOf(memReader(out)).length, all.length);
});

test('ebml: not a WebM is refused', () => {
  assert.throws(() => open(memReader(Buffer.from('RIFF....WAVEfmt '))), /Not a WebM/);
});

function childrenOf(r, h) {
  const out = [];
  for (let p = h.data; p < h.end;) { const c = header(r, p); out.push(c); p = c.end; }
  return out;
}
const uintAt = (r, h) => [...r.bytes(h.data, h.size)].reduce((v, b) => v * 256 + b, 0);
function framesOf(r) {
  const m = open(r);
  return [...clusters(r, m)].flatMap(c => [...frames(r, m, c)]);
}
