// Draws Showntask's icon (screen-capture corners around a check, with a red record dot, on a dark
// tile) as build/icon.png, 512 px, with no image tools: node build/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../app/lib/png.js';

// The drawing is laid out on a 64-unit grid, the same as the SVG it was designed in.
const S = 512, U = S / 64, rgba = Buffer.alloc(S * S * 4);
const DARK = [29, 32, 39], WHITE = [255, 255, 255], RED = [229, 72, 77];

// Distance from a point to a segment, so a stroke with round caps is "closer than half its width".
const seg = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const near = (x, y, line, half) => line.slice(1).some((p, i) => seg(x, y, line[i], p) <= half);
const corners = [[[11, 23], [11, 11], [23, 11]], [[41, 53], [53, 53], [53, 41]], [[11, 41], [11, 53], [23, 53]]];
const check = [[21, 33], [28, 40], [43, 25]];
const inTile = (x, y) => {
  const r = 14, cx = Math.max(r, Math.min(64 - r, x)), cy = Math.max(r, Math.min(64 - r, y));
  return x >= 0 && x <= 64 && y >= 0 && y <= 64 && Math.hypot(x - cx, y - cy) <= r;
};

const colour = (px, py) => {
  const x = px / U, y = py / U;
  if (!inTile(x, y)) return null;
  if (Math.hypot(x - 49, y - 15) <= 7) return RED;
  if (near(x, y, check, 2.75) || corners.some(c => near(x, y, c, 2.5))) return WHITE;
  return DARK;
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
