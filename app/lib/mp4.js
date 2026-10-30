// A reader for MP4 and MOV files (Loom, phones, OBS's MP4), for Import: the tracks and
// every sample's time and place from the sample tables, without reading the media data. Tracks
// come out in the same shape as lib/ebml.js gives, so the rest of processing does not care which
// container a video came in.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

function boxes(r, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const h = r.bytes(pos, 16), d = new DataView(h.buffer, h.byteOffset, h.length);
    let size = d.getUint32(0), head = 8;
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) { size = Number(d.getBigUint64(8)); head = 16; } else if (size === 0) size = end - pos;
    if (size < head) break;
    out.push({ type, pos, data: pos + head, end: Math.min(pos + size, end) });
    pos += size;
  }
  return out;
}

const find = (r, b, ...path) => {
  let cur = [b];
  for (const t of path) {
    const next = cur.flatMap(x => boxes(r, x.data, x.end)).filter(x => x.type === t);
    if (!next.length) return null;
    cur = next;
  }
  return cur[0];
};
const all = (r, b, t) => boxes(r, b.data, b.end).filter(x => x.type === t);
const view = (r, b) => { const u = r.bytes(b.data, b.end - b.data).slice(); return { u, d: new DataView(u.buffer) }; };

// True when the file starts like an MP4 or MOV.
export function isMp4(r) {
  const h = r.bytes(0, 12);
  const t = String.fromCharCode(h[4], h[5], h[6], h[7]);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(t);
}

// { duration (seconds), tracks: [{ number, kind, codec, private, width, height, rate, channels, samples }] }
// samples: [{ time, key, pos, len }] in decode order, time being the presentation time.
export function openMp4(r) {
  const top = boxes(r, 0, r.size);
  const moov = top.find(b => b.type === 'moov');
  if (!moov) throw new Error('This MP4 has no index (moov). Is the file complete?');
  let duration = 0;
  const mvhd = find(r, moov, 'mvhd');
  if (mvhd) {
    const { d } = view(r, mvhd), v1 = d.getUint8(0) === 1;
    const scale = d.getUint32(v1 ? 20 : 12), dur = v1 ? Number(d.getBigUint64(24)) : d.getUint32(16);
    duration = scale ? dur / scale : 0;
  }
  const tracks = [];
  for (const trak of all(r, moov, 'trak')) {
    const t = track(r, trak, tracks.length + 1);
    if (t) tracks.push(t);
  }
  return { duration, tracks };
}

function track(r, trak, number) {
  const hdlr = find(r, trak, 'mdia', 'hdlr'), mdhd = find(r, trak, 'mdia', 'mdhd'), stbl = find(r, trak, 'mdia', 'minf', 'stbl');
  if (!hdlr || !mdhd || !stbl) return null;
  const kind = { vide: 'video', soun: 'audio' }[String.fromCharCode(...r.bytes(hdlr.data + 8, 4))] || 'other';
  const md = view(r, mdhd).d, scale = md.getUint32(md.getUint8(0) === 1 ? 20 : 12);
  const t = { number, kind, codec: '', private: null, width: 0, height: 0, rate: 0, channels: 1, samples: [] };
  const stsd = find(r, stbl, 'stsd');
  if (stsd) {
    const entry = boxes(r, stsd.data + 8, stsd.end)[0];
    if (entry) entryInfo(r, entry, t);
  }
  t.samples = sampleTable(r, stbl, scale);
  return t;
}

// The codec, size and decoder setup from the first sample description.
function entryInfo(r, e, t) {
  const fourcc = e.type;
  if (t.kind === 'video') {
    const v = r.bytes(e.data, 78);
    t.width = v[24] << 8 | v[25]; t.height = v[26] << 8 | v[27];
    const kids = boxes(r, e.data + 78, e.end);
    if (fourcc === 'avc1' || fourcc === 'avc3') {
      t.codec = 'V_MPEG4/ISO/AVC';
      const avcC = kids.find(k => k.type === 'avcC');
      if (avcC) t.private = r.bytes(avcC.data, avcC.end - avcC.data).slice();
    } else if (fourcc === 'vp09') t.codec = 'V_VP9';
    else if (fourcc === 'av01') t.codec = 'V_AV1';
    else t.codec = `mp4:${fourcc}`; // HEVC and others: not decodable here
  } else if (t.kind === 'audio') {
    const a = r.bytes(e.data, 28);
    t.channels = a[16] << 8 | a[17];
    t.rate = (a[24] << 8 | a[25]) || 48000;
    if (fourcc === 'mp4a') {
      t.codec = 'A_AAC';
      const esds = boxes(r, e.data + 28, e.end).find(k => k.type === 'esds');
      if (esds) t.private = audioConfig(r.bytes(esds.data, esds.end - esds.data).slice());
    } else if (fourcc === 'Opus') t.codec = 'A_OPUS';
    else t.codec = `mp4:${fourcc}`;
  }
}

// The AudioSpecificConfig inside an esds box (the DecoderSpecificInfo, tag 5).
export function audioConfig(u) {
  let p = 4; // version and flags
  const len = () => { let n = 0, b; do { b = u[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80 && p < u.length); return n; };
  while (p < u.length) {
    const tag = u[p++], n = len();
    if (tag === 3) { const flags = u[p + 2]; p += 3; if (flags & 0x80) p += 2; if (flags & 0x40) p += 1 + u[p]; if (flags & 0x20) p += 2; continue; }
    if (tag === 4) { p += 13; continue; }
    if (tag === 5) return u.slice(p, p + n);
    p += n;
  }
  return null;
}

function sampleTable(r, stbl, scale) {
  const get = t => { const b = find(r, stbl, t); return b ? view(r, b) : null; };
  const stsz = get('stsz'), stts = get('stts'), stsc = get('stsc'), ctts = get('ctts'), stss = get('stss');
  const stco = get('stco'), co64 = get('co64');
  if (!stsz || !stts || !stsc || !(stco || co64)) return [];
  const fixed = stsz.d.getUint32(4), count = stsz.d.getUint32(8);
  const size = i => (fixed || stsz.d.getUint32(12 + i * 4));
  const chunks = stco ? stco.d.getUint32(4) : co64.d.getUint32(4);
  const chunkAt = i => (stco ? stco.d.getUint32(8 + i * 4) : Number(co64.d.getBigUint64(8 + i * 8)));
  const keys = stss ? new Set(Array.from({ length: stss.d.getUint32(4) }, (_, i) => stss.d.getUint32(8 + i * 4) - 1)) : null;
  const out = new Array(count);
  // decode times
  let i = 0, dts = 0;
  for (let e = 0, n = stts.d.getUint32(4); e < n && i < count; e++) {
    const c = stts.d.getUint32(8 + e * 8), delta = stts.d.getUint32(12 + e * 8);
    for (let k = 0; k < c && i < count; k++, i++) { out[i] = { dts, time: 0, key: keys ? keys.has(i) : true, pos: 0, len: size(i) }; dts += delta; }
  }
  for (; i < count; i++) out[i] = { dts, time: 0, key: keys ? keys.has(i) : true, pos: 0, len: size(i) };
  // composition offsets
  i = 0;
  if (ctts) {
    const v1 = ctts.d.getUint8(0) === 1;
    for (let e = 0, n = ctts.d.getUint32(4); e < n && i < count; e++) {
      const c = ctts.d.getUint32(8 + e * 8), off = v1 ? ctts.d.getInt32(12 + e * 8) : ctts.d.getUint32(12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) out[i].cts = off;
    }
  }
  // file positions: chunks hold runs of samples, as stsc says
  const runs = stsc.d.getUint32(4);
  let s = 0;
  for (let e = 0; e < runs; e++) {
    const first = stsc.d.getUint32(8 + e * 12) - 1, per = stsc.d.getUint32(12 + e * 12);
    const last = e + 1 < runs ? stsc.d.getUint32(8 + (e + 1) * 12) - 1 : chunks;
    for (let c = first; c < last && s < count; c++) {
      let pos = chunkAt(c);
      for (let k = 0; k < per && s < count; k++, s++) { out[s].pos = pos; pos += out[s].len; }
    }
  }
  for (const x of out) { x.time = (x.dts + (x.cts || 0)) / scale; delete x.dts; delete x.cts; }
  return out;
}
