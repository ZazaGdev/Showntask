// Spike: walk every frame of a WebM or Matroska file and time it. node test/spike/walk.mjs <file>
import fs from 'node:fs';
import { reader, open, clusters, frames } from '../../app/lib/ebml.js';

const file = process.argv[2];
const fd = fs.openSync(file, 'r');
const r = reader((pos, len) => { const b = new Uint8Array(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); }, fs.fstatSync(fd).size);
const t0 = Date.now();
const m = open(r);
console.log('tracks', m.tracks.map(t => ({ n: t.number, kind: t.kind, codec: t.codec, w: t.width, h: t.height, rate: t.rate, ch: t.channels, name: t.name, priv: t.private && t.private.length })));
console.log('duration', m.duration, 'scale', m.timecodeScale, 'cues', !!m.cuesEl);
let nc = 0, nf = 0, keys = 0, last = 0;
const per = {};
for (const c of clusters(r, m)) {
  nc++;
  for (const f of frames(r, m, c)) {
    nf++; per[f.track] = (per[f.track] || 0) + 1;
    if (f.track === 1 && f.key) keys++;
    last = Math.max(last, f.time);
  }
}
console.log({ clusters: nc, frames: nf, per, videoKeys: keys, last, ms: Date.now() - t0 });
