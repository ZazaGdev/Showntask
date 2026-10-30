// Spike: a long MediaRecorder-shaped WebM from a short one, its clusters repeated with their
// times moved on, unknown sizes and no cues, as MediaRecorder writes them.
// node test/spike/loop.mjs <in.webm> <out.webm> <loops>
import fs from 'node:fs';
import { reader, open, clusters, children, ID } from '../../app/lib/ebml.js';

const [src, dst, loops = '86'] = process.argv.slice(2);
const fd = fs.openSync(src, 'r');
const r = reader((pos, len) => { const b = new Uint8Array(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); }, fs.fstatSync(fd).size);
const m = open(r);
const out = fs.openSync(dst, 'w');
const w = b => fs.writeSync(out, b);
w(r.bytes(0, m.seg.data).slice()); // EBML header and the unknown-size Segment header
w(r.bytes(m.info.pos, m.info.end - m.info.pos).slice());
w(r.bytes(m.tracksEl.pos, m.tracksEl.end - m.tracksEl.pos).slice());
const list = [...clusters(r, m)];
const span = 60000;
for (let l = 0; l < Number(loops); l++) {
  for (const c of list) {
    w(Uint8Array.from([0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
    let t = c.time + l * span;
    const tb = []; for (let i = 0; i < 4; i++) { tb.unshift(t & 0xff); t = Math.floor(t / 256); }
    w(Uint8Array.from([0xE7, 0x84, ...tb]));
    for (const k of children(r, c.data, c.end)) if (k.id !== ID.Timecode) w(r.bytes(k.pos, k.end - k.pos).slice());
  }
}
fs.closeSync(out);
console.log('wrote', dst, fs.statSync(dst).size);
