// PNG in and out with Node's zlib, for contact sheets. The MCP server runs as plain Node
// (Electron's main process cannot read a pipe on Windows), so it has no image library: the
// worker writes each candidate's labelled tile as a PNG, and the server tiles them here.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { width, height, rgba } from an 8-bit, non-interlaced RGB or RGBA PNG (what Chromium writes).
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
  let p = 8, width = 0, height = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace || (type !== 2 && type !== 6)) throw new Error('Unsupported PNG');
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4), prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = cur[x * bpp]; rgba[o + 1] = cur[x * bpp + 1]; rgba[o + 2] = cur[x * bpp + 2]; rgba[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(kind, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(kind, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// A PNG of an RGBA buffer: RGB, or RGBA with alpha (the app icon's clear corners).
export function encodePng({ width, height, rgba }, { alpha = false } = {}) {
  const bpp = alpha ? 4 : 3, raw = Buffer.alloc(height * (width * bpp + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (width * bpp + 1);
    raw[o] = 0;
    for (let x = 0; x < width; x++) { const s = (y * width + x) * 4, d = o + 1 + x * bpp; for (let k = 0; k < bpp; k++) raw[d + k] = rgba[s + k]; }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = alpha ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// Tiles pictures into a grid, `cols` wide, on a dark background, each scaled down to fit its cell.
export function tile(pics, { cols = 4, cell = 320, gap = 6 } = {}) {
  const ch = Math.max(...pics.map(p => Math.round((p.height * cell) / p.width)), 1);
  const rows = Math.ceil(pics.length / cols), width = cols * cell + (cols + 1) * gap, height = rows * ch + (rows + 1) * gap;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 24; rgba[i + 1] = 26; rgba[i + 2] = 30; rgba[i + 3] = 255; }
  pics.forEach((p, i) => {
    const ox = gap + (i % cols) * (cell + gap), oy = gap + Math.floor(i / cols) * (ch + gap);
    const w = Math.min(cell, p.width), h = Math.round((p.height * w) / p.width);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * p.width) / w), sy = Math.floor((y * p.height) / h), s = (sy * p.width + sx) * 4, d = ((oy + y) * width + ox + x) * 4;
      rgba[d] = p.rgba[s]; rgba[d + 1] = p.rgba[s + 1]; rgba[d + 2] = p.rgba[s + 2];
    }
  });
  return { width, height, rgba };
}
