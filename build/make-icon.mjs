// Draws Showntask's icon (a film reel with a red record dot) as build/icon.png, 512 px, with no
// image tools: node build/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../app/lib/png.js';

const S = 512, rgba = Buffer.alloc(S * S * 4), c = S / 2;
const colour = (x, y) => {
  const d = Math.hypot(x - c, y - c);
  if (d > 240) return null;
  for (let k = 0; k < 6; k++) { // the reel's six holes
    const a = (k * Math.PI) / 3 - Math.PI / 2;
    if (Math.hypot(x - (c + Math.cos(a) * 150), y - (c + Math.sin(a) * 150)) < 46) return [21, 22, 26];
  }
  if (d < 78) return [229, 72, 77]; // the record dot
  if (d < 92) return [21, 22, 26];
  return d > 226 ? [70, 74, 84] : [44, 47, 54];
};
// Each pixel sampled 4x4 times, so the edges are smooth.
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const p = colour(x + (i + 0.5) / 4, y + (j + 0.5) / 4);
    if (p) { r += p[0]; g += p[1]; b += p[2]; n++; }
  }
  const o = (y * S + x) * 4;
  if (n) { rgba[o] = r / n; rgba[o + 1] = g / n; rgba[o + 2] = b / n; }
  rgba[o + 3] = Math.round((n / 16) * 255);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png');
fs.writeFileSync(out, encodePng({ width: S, height: S, rgba }, { alpha: true }));
console.log('wrote', out);
