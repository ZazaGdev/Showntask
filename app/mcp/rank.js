// Frames picked without looking, for agents with no vision: a mark first, then a click or
// scene change at a pointing word, then a pointing word, a click, a scene change, a line's middle.
const score = c => {
  const r = new Set(c.reasons);
  if (r.has('marker')) return 0;
  if (r.has('word') && (r.has('click') || r.has('scene'))) return 1;
  if (r.has('word')) return 2;
  if (r.has('click')) return 3;
  if (r.has('scene')) return 4;
  return 5;
};

export const rankUnseen = (list, count = 3) => [...list].filter(c => c.file).sort((a, b) => score(a) - score(b) || a.at - b.at).slice(0, count).sort((a, b) => a.at - b.at);
