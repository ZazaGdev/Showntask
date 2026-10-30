// Spike: time the cues writer. node test/spike/seekable.mjs <in.webm> <out.webm>
import fs from 'node:fs';
import { reader, open, writeSeekable } from '../../app/lib/ebml.js';

const [src, dst] = process.argv.slice(2);
const t0 = Date.now();
const fd = fs.openSync(src, 'r');
const r = reader((pos, len) => { const b = new Uint8Array(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); }, fs.fstatSync(fd).size);
const out = fs.openSync(dst, 'w');
const res = writeSeekable(r, open(r), b => fs.writeSync(out, b));
fs.closeSync(out);
console.log({ ...res, bytes: fs.statSync(dst).size, ms: Date.now() - t0 });
