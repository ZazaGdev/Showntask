// The page side of processing: the recording's sound to the 16 kHz mono wav Whisper
// reads, small frames for the scene check and full ones for the candidates, decoded with
// WebCodecs from the frame lists of lib/demux.js. Runs in a hidden window, never on the main
// side, since only a page has WebCodecs.

// WebCodecs' codec string and description for a Matroska track; null when it cannot decode it.
export function codecOf(t) {
  const hex = n => n.toString(16).padStart(2, '0');
  switch (t.codec) {
    case 'V_VP8': return { codec: 'vp8' };
    case 'V_VP9': return { codec: 'vp09.00.10.08' };
    case 'V_AV1': return { codec: 'av01.0.08M.08' };
    case 'V_MPEG4/ISO/AVC': return t.private && t.private.length > 3 ? { codec: `avc1.${hex(t.private[1])}${hex(t.private[2])}${hex(t.private[3])}`, description: t.private } : null;
    case 'A_OPUS': return { codec: 'opus', description: t.private || undefined };
    case 'A_AAC': return { codec: `mp4a.40.${t.private && t.private.length ? t.private[0] >> 3 : 2}`, description: t.private || undefined };
    case 'A_VORBIS': return { codec: 'vorbis', description: t.private || undefined };
    default: return null;
  }
}

// A resampler from any rate to out, one channel, through a windowed-sinc table with 512 phases,
// so 48 kHz and 44.1 kHz both come out clean enough for speech.
export function resampler(inRate, out = 16000, taps = 16) {
  const ratio = inRate / out, cut = Math.min(1, out / inRate) * 0.92, PH = 512;
  const table = new Float32Array(PH * 2 * taps);
  for (let p = 0; p < PH; p++) {
    let sum = 0;
    for (let k = 0; k < 2 * taps; k++) {
      const x = k - taps + 1 - p / PH, w = 0.5 + 0.5 * Math.cos((Math.PI * x) / taps);
      const v = x === 0 ? cut : Math.sin(Math.PI * cut * x) / (Math.PI * x);
      table[p * 2 * taps + k] = v * w; sum += v * w;
    }
    for (let k = 0; k < 2 * taps; k++) table[p * 2 * taps + k] /= sum;
  }
  let buf = new Float32Array(0), base = 0, next = 0; // buf[0] is input sample number base; next output's input position
  return {
    // Takes mono input samples, returns the output samples they complete.
    push(samples) {
      const merged = new Float32Array(buf.length + samples.length);
      merged.set(buf); merged.set(samples, buf.length);
      buf = merged;
      const outs = [];
      for (;;) {
        const pos = next * ratio, i = Math.floor(pos);
        if (i + taps >= base + buf.length) break;
        const p = Math.floor((pos - i) * PH), row = p * 2 * taps;
        let s = 0;
        for (let k = 0; k < 2 * taps; k++) { const j = i - taps + 1 + k - base; if (j >= 0) s += buf[j] * table[row + k]; }
        outs.push(s); next++;
      }
      const keep = Math.max(0, Math.floor(next * ratio) - taps - base);
      if (keep > 0) { buf = buf.slice(keep); base += keep; }
      return Float32Array.from(outs);
    },
  };
}

// The 44-byte header of a 16-bit mono PCM wav of n samples.
export function wavHeader(n, rate = 16000) {
  const b = new ArrayBuffer(44), d = new DataView(b), s = (o, t) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true);
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); s(36, 'data'); d.setUint32(40, n * 2, true);
  return new Uint8Array(b);
}

// Feeds chunks to a WebCodecs decoder without letting its queue grow without end.
function feeder(dec) {
  let wake = null;
  dec.ondequeue = () => { if (wake && dec.decodeQueueSize < 16) { const w = wake; wake = null; w(); } };
  return async chunk => {
    if (dec.decodeQueueSize >= 64) await new Promise(res => { wake = res; });
    dec.decode(chunk);
  };
}

// The track's sound as 16 kHz mono 16-bit samples, written through out(Int16Array) in order.
// list: the track's frames (lib/demux.js). Gaps in the timestamps (a pause) become silence, so
// the wav's seconds match the video's. Returns the number of samples written.
export async function audioToPcm(r, track, list, out, onProgress = () => {}) {
  const cfg = codecOf(track);
  if (!cfg) throw new Error(`Cannot decode the sound (${track.codec})`);
  const rate = track.rate || 48000;
  const rs = resampler(rate, 16000);
  let written = 0, failed = null, expect = 0; // expect: the input sample number the next AudioData should start at
  const emit = mono => {
    const o = rs.push(mono);
    const pcm = new Int16Array(o.length);
    for (let i = 0; i < o.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(o[i] * 32767)));
    if (pcm.length) { out(pcm); written += pcm.length; }
  };
  const dec = new AudioDecoder({
    output(a) {
      try {
        const n = a.numberOfFrames, ch = a.numberOfChannels, mono = new Float32Array(n), plane = new Float32Array(n);
        for (let c = 0; c < ch; c++) { a.copyTo(plane, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) mono[i] += plane[i] / ch; }
        const at = Math.round((a.timestamp / 1e6) * rate);
        if (at > expect + rate / 10) { emit(new Float32Array(at - expect)); expect = at; } // a gap of over 100 ms
        emit(mono); expect += n;
      } finally { a.close(); }
    },
    error(e) { failed = e; },
  });
  dec.configure({ codec: cfg.codec, sampleRate: rate, numberOfChannels: track.channels || 1, ...(cfg.description ? { description: cfg.description } : {}) });
  const feed = feeder(dec);
  let lastReport = 0;
  for (const f of list) {
    if (failed || dec.state === 'closed') throw failed || new Error('The sound decoder closed');
    await feed(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.time * 1e6), data: r.bytes(f.pos, f.len).slice() }));
    if (f.time - lastReport > 30) { lastReport = f.time; onProgress(f.time); }
  }
  await dec.flush();
  dec.close();
  if (failed) throw failed;
  return written;
}

// True when a frame is never referenced by another, so the scene check and the frame grab can
// skip it: an H.264 frame whose slices all have nal_ref_idc 0 (OBS's B-frames). Only the first
// 64 bytes are read; when the first slice is not in them the frame counts as referenced.
export function skippable(track, bytes) {
  if (track.codec !== 'V_MPEG4/ISO/AVC') return false;
  if (track.private && track.private.length > 4 && (track.private[4] & 3) !== 3) return false; // NAL lengths not 4 bytes
  let p = 0, slices = 0;
  while (p + 4 < bytes.length) {
    const n = (bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3]) >>> 0, h = bytes[p + 4], type = h & 31;
    if (type === 1 || type === 5) { slices++; if ((h >> 5) & 3) return false; }
    p += 4 + n;
  }
  return slices > 0;
}

// The frames to decode: keyframes and the frames others depend on, in decode order.
export const decodable = (r, track, idx) => idx.filter(f => f.key || !skippable(track, r.bytes(f.pos, Math.min(f.len, 64))));

// One picture a second: hands take(frame) the first frame of each new second. Returns when done.
export async function sampleSeconds(r, track, list, take, onProgress = () => {}) {
  let next = 0, last = 0;
  const dec = videoDecoder(track, f => { const ts = f.timestamp / 1e6; if (ts >= next) { take(f, ts); next = Math.floor(ts) + 1; } });
  try {
    for (const f of list) {
      await dec.decode(r, f);
      if (f.time - last > 30) { last = f.time; onProgress(f.time); }
    }
    await dec.flush();
  } finally { dec.close(); }
}

// The frames nearest each of times: grab(frame, t) is called once per time with the first
// decoded frame at or after it (from list, the decodable frames); a time past the last frame
// gets none. Decoding restarts at a keyframe only when the next time lies beyond the current
// group of pictures. Returns how many times got a frame.
export async function grabAt(r, track, list, times, grab) {
  const want = [...times].sort((a, b) => a - b);
  let w = 0;
  const dec = videoDecoder(track, f => {
    const ts = f.timestamp / 1e6;
    while (w < want.length && ts >= want[w] - 0.001) { grab(f, want[w]); w++; }
  });
  const keys = list.map((f, i) => (f.key ? i : -1)).filter(i => i >= 0);
  let fed = -1;
  try {
    for (const t of want) {
      // the last keyframe at or before t
      let k = keys[0] ?? 0;
      for (const i of keys) { if (list[i].time <= t) k = i; else break; }
      let i = k > fed ? k : fed + 1;
      for (; i < list.length; i++) {
        await dec.decode(r, list[i]);
        fed = i;
        if (list[i].time >= t) break;
      }
      if (i >= list.length) break;
    }
    await dec.flush();
  } finally { dec.close(); }
  return w;
}

// A decoder that hands each VideoFrame to onFrame(frame) and closes it afterwards.
export function videoDecoder(track, onFrame) {
  const cfg = codecOf(track);
  if (!cfg) throw new Error(`Cannot decode the video (${track.codec})`);
  let failed = null;
  const dec = new VideoDecoder({
    output(f) { try { onFrame(f); } catch (e) { failed = e; } finally { f.close(); } },
    error(e) { failed = e; },
  });
  const config = { codec: cfg.codec, ...(cfg.description ? { description: cfg.description } : {}) };
  dec.configure(config);
  const feed = feeder(dec);
  return {
    async decode(r, f) {
      if (failed || dec.state === 'closed') throw failed || new Error('The video decoder closed');
      await feed(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.time * 1e6), data: r.bytes(f.pos, f.len).slice() }));
    },
    async flush() { await dec.flush(); if (failed) throw failed; },
    close() { try { dec.close(); } catch { /* closed */ } },
    reset() { dec.reset(); dec.configure(config); },
  };
}
