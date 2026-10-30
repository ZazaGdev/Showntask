// The board-neutral task list: tasks.json as save_tasks and the app's editor write it,
// mended so odd input never lands on disk, and tasks.md, the same list for people.
import { clock } from './transcript.js';

export const KINDS = ['bug', 'feature', 'change', 'chore', 'question'];
const LONG_DASH = new RegExp(`\\s*[${String.fromCharCode(0x2013, 0x2014)}]\\s*`, 'g'); // the owner's rule: no long dashes
const line = s => String(s ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ').replace(LONG_DASH, ', ').trim();
const one = s => line(s).replace(/\s+/g, ' ');
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n * 10) / 10), max) : null; };

// tasks: what an agent or the editor sent. Returns the list to save; throws when it is no list.
// Ids are kept when unique, else given; filed entries stay as they were for a known id.
export function mendTasks(tasks, { duration = Infinity, old = [] } = {}) {
  if (!Array.isArray(tasks)) throw new Error('tasks must be a list');
  const out = [], seen = new Set(), before = new Map(old.map(t => [t.id, t]));
  let n = Math.max(0, ...old.map(t => Number(String(t.id).replace(/^t/, '')) || 0), ...tasks.map(t => Number(String(t && t.id).replace(/^t/, '')) || 0));
  for (const t of tasks) {
    if (!t || typeof t !== 'object' || !one(t.title)) continue;
    let id = /^[\w-]{1,40}$/.test(String(t.id)) && !seen.has(String(t.id)) ? String(t.id) : null;
    if (!id) do { id = `t${++n}`; } while (seen.has(id));
    seen.add(id);
    const prev = before.get(id);
    const frames = [...new Set((Array.isArray(t.frames) ? t.frames : []).map(f => num(f, duration)).filter(f => f !== null))].slice(0, 6);
    out.push({
      id, title: one(t.title).replace(/[.\s]+$/, '').slice(0, 120),
      description: (Array.isArray(t.description) ? t.description.join('\n') : line(t.description)).split('\n').map(one).filter(Boolean).join('\n'),
      steps: (Array.isArray(t.steps) ? t.steps : []).map(one).filter(Boolean).slice(0, 20),
      done_when: one(t.done_when),
      kind: KINDS.includes(t.kind) ? t.kind : 'change',
      labels: (Array.isArray(t.labels) ? t.labels : []).map(one).filter(Boolean).slice(0, 10),
      quote: one(t.quote),
      at: num(t.at, duration) ?? 0,
      frames,
      ...(t.unseen ? { unseen: true } : {}),
      filed: Array.isArray(t.filed) && t.filed.length ? t.filed.filter(f => f && f.board && f.url).map(f => ({ board: one(f.board), url: one(f.url) })) : prev ? prev.filed || [] : [],
    });
  }
  return out;
}

// One task marked as filed on a board; the same list when it already is there.
export function markFiled(tasks, id, board, url) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) throw new Error(`No task ${id}`);
  const t = tasks[i];
  if ((t.filed || []).some(f => f.board === board && f.url === url)) return tasks;
  const out = [...tasks];
  out[i] = { ...t, filed: [...(t.filed || []), { board, url }] };
  return out;
}

// tasks.md: the list for people and for agents without MCP.
export function tasksMd(tasks, { title, frameFile = s => `${s}` }) {
  const out = [`# Tasks from ${title}`, ''];
  if (!tasks.length) out.push('No tasks.');
  for (const t of tasks) {
    out.push(`## ${t.title}`, '', `${t.kind}${t.labels.length ? `, ${t.labels.join(', ')}` : ''}. Said at ${clock(t.at)}: "${t.quote}"`, '');
    if (t.description) out.push(t.description, '');
    if (t.steps.length) out.push('Steps:', ...t.steps.map((s, i) => `${i + 1}. ${s}`), '');
    if (t.done_when) out.push(`Done when: ${t.done_when}`, '');
    if (t.frames.length) out.push(`Frames${t.unseen ? ' (chosen unseen)' : ''}: ${t.frames.map(f => `${clock(f)} (${frameFile(f)})`).join(', ')}`, '');
    for (const f of t.filed || []) out.push(`Filed on ${f.board}: ${f.url}`);
    if ((t.filed || []).length) out.push('');
  }
  return out.join('\n');
}
