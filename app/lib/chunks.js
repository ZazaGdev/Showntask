// Long recordings go to Whisper in pieces of up to 30 s, cut at the quietest moment, so Whisper
// never runs long enough to fall into its repeated-line loops (seen on a 77 minute talk on
// 27 Oct). Each piece's lines are shifted back by its start into one transcript.

export const RATE = 16000;
const FRAME = 320; // 20 ms

// The loudness of each 20 ms of 16-bit samples.
export function energy(pcm) {
  const n = Math.floor(pcm.length / FRAME), out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += pcm[i] * pcm[i];
    out[f] = Math.sqrt(s / FRAME);
  }
  return out;
}

// The pieces as [{ from, to }] in samples: each at most max seconds, cut at the quietest
// 300 ms in its last search seconds, so a cut falls in a pause rather than in a word.
export function pieces(pcm, { max = 30, search = 10 } = {}) {
  const e = energy(pcm), out = [], win = 15; // 15 frames: 300 ms
  let start = 0;
  while (pcm.length - start > max * RATE) {
    const f0 = Math.floor((start + (max - search) * RATE) / FRAME), f1 = Math.floor((start + max * RATE) / FRAME) - win;
    let best = f1, bestE = Infinity;
    for (let f = f0; f <= f1; f++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += e[f + k] || 0;
      if (s < bestE) { bestE = s; best = f; }
    }
    const cut = (best + Math.floor(win / 2)) * FRAME;
    out.push({ from: start, to: cut });
    start = cut;
  }
  if (pcm.length > start) out.push({ from: start, to: pcm.length });
  return out;
}

// Lines Whisper repeated in a loop: the same words more than twice in a row keep only the first two.
export function dropLoops(lines) {
  const out = [], norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let run = 0;
  for (const l of lines) {
    const prev = out[out.length - 1];
    run = prev && norm(prev.text) === norm(l.text) ? run + 1 : 0;
    if (run < 2) out.push(l);
  }
  return out;
}

// The 16-bit samples of a 16 kHz mono wav file's bytes (its 44-byte header skipped).
export function pcmOf(buf) {
  const n = Math.floor((buf.length - 44) / 2);
  if ((buf.byteOffset + 44) % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset + 44, n);
  return new Int16Array(Uint8Array.prototype.slice.call(buf, 44, 44 + n * 2).buffer);
}

// A 16 kHz mono wav file's bytes for samples.
export function wavBytes(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(out, 44);
  return out;
}
