// Candidate frames: the cheap, no-AI picks the user's agent later chooses from. A
// candidate is kept at each scene change once the screen has settled, each click, each pointing
// word moved into its line, each "Mark this" marker, and the middle of every line with none of
// these. Candidates under 2 s apart showing the same picture are merged.

// How much one small grey picture differs from another: the share of pixels that moved by more
// than LEVEL grey levels. A share works better than a mean for screens: a toggle or a number
// changes few pixels, but changes them a lot.
export const LEVEL = 24;
export function changed(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > LEVEL) n++;
  return a.length ? n / a.length : 0;
}

export const SCENE = 0.1; // a scene change: over 10% of the picture differs from the last kept one
export const SETTLED = 0.01; // settled: under 1% differs from the second before...
export const WAIT = 2; // ...or this many seconds have passed (a game or a video never settles)
export const SAME = 0.05; // two candidates show the same picture
export const MERGE_SECS = 2;

// The scene changes in samples [{ time, grey }] taken about once a second: the time of the first
// sample after each change at which the screen has settled. Settled also means calmer than the
// usual second-to-second change here, so a screen that is always moving still gets its picks.
export function sceneChanges(samples, o = {}) {
  const scene = o.scene ?? SCENE, settled = o.settled ?? SETTLED, wait = o.wait ?? WAIT;
  const out = [];
  if (!samples.length) return out;
  const step = samples.map((s, i) => (i ? changed(s.grey, samples[i - 1].grey) : 0));
  let ref = samples[0].grey, since = null, calm = settled;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (since === null && changed(s.grey, ref) > scene) {
      since = s.time;
      calm = Math.max(settled, median(step.slice(Math.max(1, i - 10), i))); // the usual motion before the change
    }
    if (since === null) continue;
    if (step[i] <= calm || s.time - since >= wait) {
      out.push(s.time);
      ref = s.grey;
      since = null;
    }
  }
  return out;
}

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// The pointing words: a frame near them likely shows what is meant.
export const POINTING = /\b(this|these|here|look|see|that button|over there|right there)\b/gi;

// A second in the first half of a line moves to the line's middle: Whisper's start takes in the
// pause before the words, while the screen may still show what came before.
export function settleShot(t, lines) {
  const l = (lines || []).find(x => Number.isFinite(x.end) && x.at <= t && t < x.end);
  if (!l) return t;
  const mid = Math.round(((l.at + l.end) / 2) * 10) / 10;
  return t < mid ? mid : t;
}

// The words' seconds in a line, guessed from where they sit in its text.
function wordTimes(l) {
  const out = [], text = l.text, span = Math.max(0, (l.end ?? l.at) - l.at);
  for (const m of text.matchAll(POINTING)) out.push({ t: l.at + (span * m.index) / Math.max(1, text.length), word: m[0].toLowerCase() });
  return out;
}

const RANK = { marker: 0, click: 1, scene: 2, word: 3, line: 4 };

// All candidates, merged and sorted: [{ at, reasons: [..], words }]. o: { lines, scenes (seconds),
// clicks [{ t }], markers (seconds), duration, pictureAt(t) -> grey or null }. A marker is never
// merged away: it must become its own task.
export function candidates(o) {
  const lines = o.lines || [], dur = o.duration ?? Infinity;
  const raw = [];
  const add = (at, reason, extra = {}) => { if (Number.isFinite(at)) raw.push({ at: Math.round(Math.min(Math.max(0, at), dur) * 10) / 10, reason, ...extra }); };
  for (const t of o.markers || []) add(t, 'marker');
  for (const c of o.clicks || []) add(c.t + 0.4, 'click'); // the screen answers a click a moment later
  for (const t of o.scenes || []) add(t, 'scene');
  for (const l of lines) {
    const words = wordTimes(l);
    for (const w of words) add(settleShot(w.t, lines), 'word', { word: w.word });
    const inside = raw.some(c => c.reason !== 'line' && c.at >= l.at && c.at <= (l.end ?? l.at));
    if (!words.length && !inside) add(settleShot(l.at, lines), 'line');
  }
  raw.sort((a, b) => a.at - b.at || RANK[a.reason] - RANK[b.reason]);
  const out = [];
  for (const c of raw) {
    const prev = out[out.length - 1];
    if (prev && c.reason !== 'marker' && prev.reasons[0] !== 'marker' && c.at - prev.at < MERGE_SECS && samePicture(prev.at, c.at, o.pictureAt)) {
      if (!prev.reasons.includes(c.reason)) prev.reasons.push(c.reason);
      if (c.word && !prev.words.includes(c.word)) prev.words.push(c.word);
      // the better reason's second wins
      if (RANK[c.reason] < RANK[prev.reasons[0]]) { prev.at = c.at; prev.reasons.sort((a, b) => RANK[a] - RANK[b]); }
      continue;
    }
    out.push({ at: c.at, reasons: [c.reason], words: c.word ? [c.word] : [] });
  }
  // One candidate per whole second, since a frame's file is named by its second.
  const bySec = [];
  for (const c of out) {
    const prev = bySec[bySec.length - 1];
    if (prev && Math.floor(prev.at) === Math.floor(c.at)) {
      for (const r of c.reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r);
      for (const w of c.words) if (!prev.words.includes(w)) prev.words.push(w);
      prev.reasons.sort((a, b) => RANK[a] - RANK[b]);
    } else bySec.push(c);
  }
  return bySec;
}

function samePicture(a, b, pictureAt) {
  if (!pictureAt) return true;
  const x = pictureAt(a), y = pictureAt(b);
  return !x || !y || changed(x, y) < SAME;
}

// The picture sampled nearest t, from samples sorted by time.
export function nearest(samples, t) {
  let lo = 0, hi = samples.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].time < t) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(samples[lo - 1].time - t) < Math.abs(samples[lo].time - t)) lo--;
  return samples[lo];
}
