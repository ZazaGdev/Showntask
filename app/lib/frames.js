// Frame files: frames/<mmss>.jpg (h<mmss> past an hour, so names sort by time), a 320 px
// copy in frames/thumbs/, and a labelled tile for contact sheets in frames/tiles/<mmss>.png.

const two = n => String(n).padStart(2, '0');

export function frameName(secs, ext = 'jpg') {
  const t = Math.max(0, Math.floor(secs)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h ? `${h}h` : ''}${two(m)}${two(s)}.${ext}`;
}

// The second a frame name stands for, or null.
export function secondsOf(name) {
  const m = String(name).match(/^(?:(\d+)h)?(\d{2})(\d{2})\.\w+$/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// The kept frame nearest t from candidates [{ at, file }], or null when there are none.
export function nearestFrame(list, t) {
  let best = null;
  for (const c of list || []) if (c.file && (!best || Math.abs(c.at - t) < Math.abs(best.at - t))) best = c;
  return best;
}

// The candidates from..to, at most max of them spread evenly when there are more.
export function inSpan(list, from = 0, to = Infinity, max = Infinity) {
  const span = (list || []).filter(c => c.file && c.at >= from && c.at <= to);
  if (span.length <= max) return span;
  const out = [];
  for (let i = 0; i < max; i++) out.push(span[Math.round((i * (span.length - 1)) / Math.max(1, max - 1))]);
  return [...new Set(out)];
}

// The candidates for a chat upload: markers, clicks and pointing words first, then the rest,
// at most cap, in time order.
export function chatPicks(list, cap = 20) {
  const rank = c => (c.reasons.includes('marker') ? 0 : c.reasons.includes('click') ? 1 : c.reasons.includes('word') ? 2 : c.reasons.includes('scene') ? 3 : 4);
  return [...list].filter(c => c.file).sort((a, b) => rank(a) - rank(b) || a.at - b.at).slice(0, cap).sort((a, b) => a.at - b.at);
}

// The label under a tile: its time and why it is a candidate.
export const tileLabel = (c, clock) => `${clock(c.at)} ${c.reasons.join('+')}${c.words && c.words.length ? ` "${c.words.slice(0, 2).join(', ')}"` : ''}`;
