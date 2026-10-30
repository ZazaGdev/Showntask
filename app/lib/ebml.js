// A streaming reader for WebM and Matroska files, and the cues writer that makes a MediaRecorder
// WebM seekable. MediaRecorder writes no length and no seek index, and OBS writes 12 GB files,
// so nothing here loads a whole file: everything goes through read(pos, len), a few MB at a time.
// No ffmpeg.

export const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
  Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F, Name: 0x536E,
  CodecDelay: 0x56AA, DefaultDuration: 0x23E383,
  Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, ReferenceBlock: 0xFB,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
  Tags: 0x1254C367, Chapters: 0x1043A770, Attachments: 0x1941A469, Void: 0xEC,
};
// The Segment's own children: an unknown-size Cluster ends where the next of these starts.
const TOP = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);

// Reads through a window, so walking a file block by block costs one read per few MB.
// read(pos, len) returns a Uint8Array (shorter at the end of the file).
export function reader(read, size, windowSize = 4 << 20) {
  let start = 0, buf = new Uint8Array(0);
  return {
    size,
    bytes(pos, len) {
      if (pos < start || pos + len > start + buf.length) {
        start = pos;
        buf = read(pos, Math.max(len, Math.min(windowSize, size - pos)));
      }
      return buf.subarray(pos - start, Math.min(pos - start + len, buf.length));
    },
  };
}

const vlen = b => { for (let n = 1; n <= 8; n++) if (b & (0x80 >> (n - 1))) return n; return 0; };

// The element starting at pos: { id, pos, data, size, end }; size and end are null when unknown.
// Null when the file ends inside the header (a recording cut off by a crash).
export function header(r, pos) {
  const b = r.bytes(pos, 12);
  if (b.length < 2) return null;
  const il = vlen(b[0]);
  if (!il || il > 4 || b.length < il + 1) return null;
  let id = 0;
  for (let i = 0; i < il; i++) id = id * 256 + b[i];
  const sl = vlen(b[il]);
  if (!sl || b.length < il + sl) return null;
  let size = b[il] & (0xff >> sl), ones = size === (0xff >> sl);
  for (let i = 1; i < sl; i++) { size = size * 256 + b[il + i]; if (b[il + i] !== 0xff) ones = false; }
  const data = pos + il + sl;
  return { id, pos, data, size: ones ? null : size, end: ones ? null : data + size };
}

// The children of an element between start and end. An unknown-size child (a Cluster) gets its
// end by walking its own children up to the next top-level element.
export function* children(r, start, end) {
  let pos = start;
  while (pos < end) {
    const h = header(r, pos);
    if (!h) return;
    // Unknown size, or a cluster cut off by a crash: it ends after its last whole child.
    if (h.id === ID.Cluster && (h.end === null || h.end > end)) h.end = clusterEnd(r, h.data, end);
    else if (h.end === null) h.end = end;
    else if (h.end > end) return; // a half-written element at the end is left out
    yield h;
    pos = h.end;
  }
}

function clusterEnd(r, start, end) {
  let pos = start;
  while (pos < end) {
    const h = header(r, pos);
    if (!h || TOP.has(h.id) || h.end === null || h.end > end) return pos;
    pos = h.end;
  }
  return pos;
}

const uint = b => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
const float = b => { const d = new DataView(b.buffer, b.byteOffset, b.length); return b.length === 4 ? d.getFloat32(0) : b.length === 8 ? d.getFloat64(0) : 0; };
const text = b => new TextDecoder().decode(b).replace(/\0+$/, '');
const body = (r, h) => r.bytes(h.data, h.size).slice();

// The file's layout and tracks. Throws when it is not WebM or Matroska.
export function open(r) {
  const head = header(r, 0);
  if (!head || head.id !== ID.EBML) throw new Error('Not a WebM or Matroska file');
  const seg = header(r, head.end);
  if (!seg || seg.id !== ID.Segment) throw new Error('No Segment in the file');
  const segEnd = seg.end === null ? r.size : Math.min(seg.end, r.size);
  const m = { head, seg, segEnd, timecodeScale: 1000000, duration: null, tracks: [], info: null, tracksEl: null, firstCluster: null, cuesEl: null };
  for (const h of children(r, seg.data, segEnd)) {
    if (h.id === ID.Info) {
      m.info = h;
      for (const c of children(r, h.data, h.end)) {
        if (c.id === ID.TimecodeScale) m.timecodeScale = uint(body(r, c));
        if (c.id === ID.Duration) m.duration = float(body(r, c));
      }
    } else if (h.id === ID.Tracks) {
      m.tracksEl = h;
      for (const t of children(r, h.data, h.end)) if (t.id === ID.TrackEntry) m.tracks.push(track(r, t));
    } else if (h.id === ID.Cues) m.cuesEl = h;
    else if (h.id === ID.Cluster) { m.firstCluster = h.pos; break; }
  }
  if (m.duration !== null) m.duration = (m.duration * m.timecodeScale) / 1e9;
  return m;
}

function track(r, h) {
  const t = { number: 0, type: 0, codec: '', private: null, name: '', width: 0, height: 0, rate: 0, channels: 1, codecDelay: 0 };
  for (const c of children(r, h.data, h.end)) {
    const b = () => body(r, c);
    if (c.id === ID.TrackNumber) t.number = uint(b());
    else if (c.id === ID.TrackType) t.type = uint(b());
    else if (c.id === ID.CodecID) t.codec = text(b());
    else if (c.id === ID.CodecPrivate) t.private = b();
    else if (c.id === ID.Name) t.name = text(b());
    else if (c.id === ID.CodecDelay) t.codecDelay = uint(b());
    else if (c.id === ID.Video || c.id === ID.Audio) for (const v of children(r, c.data, c.end)) {
      if (v.id === ID.PixelWidth) t.width = uint(body(r, v));
      if (v.id === ID.PixelHeight) t.height = uint(body(r, v));
      if (v.id === ID.SamplingFrequency) t.rate = float(body(r, v));
      if (v.id === ID.Channels) t.channels = uint(body(r, v));
    }
  }
  t.kind = t.type === 1 ? 'video' : t.type === 2 ? 'audio' : 'other';
  return t;
}

// The clusters from pos on: { pos, data, end, time } with time in Matroska ticks.
export function* clusters(r, m, from = m.firstCluster) {
  if (from === null) return;
  for (const h of children(r, from, m.segEnd)) {
    if (h.id !== ID.Cluster) continue;
    let time = 0;
    // The Timecode comes first, after a CRC-32 or Void when the muxer wrote one.
    for (const k of children(r, h.data, h.end)) {
      if (k.id === ID.Timecode) { time = uint(body(r, k)); break; }
      if (k.id === ID.SimpleBlock || k.id === ID.BlockGroup) break;
    }
    yield { pos: h.pos, data: h.data, end: h.end, time };
  }
}

// The frames in one cluster: { track, time (seconds), key, pos, len }, pos and len pointing at
// the frame's bytes in the file. Laced blocks give one entry per frame, all at the block's time.
export function* frames(r, m, c) {
  const scale = m.timecodeScale / 1e9;
  for (const h of children(r, c.data, c.end)) {
    if (h.id === ID.SimpleBlock) yield* block(r, h.data, h.end, c.time, scale, null);
    else if (h.id === ID.BlockGroup) {
      let b = null, ref = false;
      for (const g of children(r, h.data, h.end)) {
        if (g.id === ID.Block) b = g;
        if (g.id === ID.ReferenceBlock) ref = true;
      }
      if (b) yield* block(r, b.data, b.end, c.time, scale, !ref);
    }
  }
}

function* block(r, start, end, clusterTime, scale, key) {
  const b = r.bytes(start, Math.min(end - start, 64));
  const tl = vlen(b[0]);
  if (!tl || b.length < tl + 3) return;
  let track = b[0] & (0xff >> tl);
  for (let i = 1; i < tl; i++) track = track * 256 + b[i];
  const rel = (b[tl] << 8 | b[tl + 1]) << 16 >> 16;
  const flags = b[tl + 2];
  const time = (clusterTime + rel) * scale;
  const isKey = key === null ? !!(flags & 0x80) : key;
  let pos = start + tl + 3;
  const lacing = (flags >> 1) & 3;
  if (!lacing) { yield { track, time, key: isKey, pos, len: end - pos }; return; }
  // Laced: a count, then the sizes (Xiph, EBML or all equal), then the frames back to back.
  const n = r.bytes(pos, 1)[0] + 1;
  pos += 1;
  const sizes = [];
  if (lacing === 1) {
    for (let i = 0; i < n - 1; i++) { let s = 0, x; do { x = r.bytes(pos++, 1)[0]; s += x; } while (x === 255); sizes.push(s); }
  } else if (lacing === 3) {
    const v = () => { const x = r.bytes(pos, 8), l = vlen(x[0]); let s = x[0] & (0xff >> l); for (let i = 1; i < l; i++) s = s * 256 + x[i]; pos += l; return { s, l }; };
    let prev = v().s;
    sizes.push(prev);
    for (let i = 1; i < n - 1; i++) { const { s, l } = v(); prev += s - (2 ** (7 * l - 1) - 1); sizes.push(prev); }
  }
  const total = end - pos;
  if (lacing === 2) for (let i = 0; i < n - 1; i++) sizes.push(total / n);
  sizes.push(total - sizes.reduce((a, s) => a + s, 0));
  for (const s of sizes) { yield { track, time, key: isKey, pos, len: s }; pos += s; }
}

// ---------- writing ----------

const idBytes = id => { const out = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff); return out; };
const sizeBytes = (n, len = 8) => { const out = new Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); } out[0] |= 0x80 >> (len - 1); return out; };
const uintBytes = (n, len = 8) => { const out = new Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); } return out; };
const el = (id, payload) => [...idBytes(id), ...sizeBytes(payload.length), ...payload];
const elUint = (id, n, len = 8) => el(id, uintBytes(n, len));
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };

// The plan for a seekable copy: the length, and one cue per cluster that holds a keyframe of the
// cue track. clusterSizes are each cluster's payload size, so unknown sizes can be written out.
export function scan(r, m) {
  const cueTrack = (m.tracks.find(t => t.kind === 'video') || m.tracks[0] || {}).number;
  const list = [];
  let last = 0;
  for (const c of clusters(r, m)) {
    let key = null;
    for (const f of frames(r, m, c)) {
      if (f.time > last) last = f.time;
      if (key === null && f.track === cueTrack && f.key) key = f.time;
    }
    list.push({ pos: c.pos, data: c.data, end: c.end, key });
  }
  return { cueTrack, clusters: list, duration: last };
}

// Writes a seekable copy of a WebM through write(Uint8Array): the EBML header as it was, a
// Segment of known size with a SeekHead, Info with the Duration, Tracks, Cues, then every
// cluster with its size written out. Cue positions use fixed widths, so the layout is known
// before anything is written. Returns { duration, cues }.
export function writeSeekable(r, m, write) {
  if (!m.info || !m.tracksEl) throw new Error('The file has no Info or Tracks');
  const s = scan(r, m);
  const head = r.bytes(m.head.pos, m.head.end - m.head.pos).slice();
  const infoKids = [];
  for (const c of children(r, m.info.data, m.info.end)) if (c.id !== ID.Duration && c.id !== ID.Void) infoKids.push(...r.bytes(c.pos, c.end - c.pos));
  const ticks = (s.duration * 1e9) / m.timecodeScale;
  const info = el(ID.Info, [...infoKids, ...el(ID.Duration, f64(ticks))]);
  const tracks = [...r.bytes(m.tracksEl.pos, m.tracksEl.end - m.tracksEl.pos)];
  const cued = s.clusters.filter(c => c.key !== null);
  const seek = (id, pos) => el(ID.Seek, [...el(ID.SeekID, idBytes(id)), ...elUint(ID.SeekPosition, pos)]);
  const seekHeadOf = (a, b, c) => el(ID.SeekHead, [...seek(ID.Info, a), ...seek(ID.Tracks, b), ...seek(ID.Cues, c)]);
  // Every field has a fixed width, so a dummy entry has the real one's length.
  const cuesLen = 4 + 8 + cued.length * cuePoint({ key: 0, at: 0 }, m, s.cueTrack).length;
  const seekLen = seekHeadOf(0, 0, 0).length;
  const infoAt = seekLen, tracksAt = infoAt + info.length, cuesAt = tracksAt + tracks.length, clustersAt = cuesAt + cuesLen;
  // Each cluster's new position: its header grows to an 8-byte size.
  let at = clustersAt;
  const placed = s.clusters.map(c => { const p = at; at += 4 + 8 + (c.end - c.data); return { ...c, at: p }; });
  const seekHead = seekHeadOf(infoAt, tracksAt, cuesAt);
  const cues = el(ID.Cues, placed.filter(c => c.key !== null).flatMap(c => cuePoint(c, m, s.cueTrack)));
  if (seekHead.length !== seekLen || cues.length !== cuesLen) throw new Error('cue layout mismatch');
  write(head);
  write(Uint8Array.from([...idBytes(ID.Segment), ...sizeBytes(at)]));
  write(Uint8Array.from([...seekHead, ...info, ...tracks, ...cues]));
  for (const c of placed) {
    write(Uint8Array.from([...idBytes(ID.Cluster), ...sizeBytes(c.end - c.data)]));
    for (let p = c.data; p < c.end; p += 4 << 20) write(r.bytes(p, Math.min(4 << 20, c.end - p)));
  }
  return { duration: s.duration, cues: cued.length };
}

function cuePoint(c, m, track) {
  const time = Math.round((c.key * 1e9) / m.timecodeScale);
  return el(ID.CuePoint, [...elUint(ID.CueTime, time), ...el(ID.CueTrackPositions, [...elUint(ID.CueTrack, track, 1), ...elUint(ID.CueClusterPosition, c.at)])]);
}
