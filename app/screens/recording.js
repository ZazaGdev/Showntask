// One recording: the video, the timed transcript, the candidate frames and the task list.
// The owner can rename it, delete a frame or a span before an agent sees it, edit the tasks,
// copy the prompt for an agent, or export it for a browser chat.
import { h, call, fileUrl, clock, when, STEP, toast, zoom } from './ui.js';

const KINDS = ['bug', 'feature', 'change', 'chore', 'question'];

export function recordingPage({ go, state, id }) {
  const el = h('section', {});
  let r = null, tab = 'transcript', sel = null; // sel: { from, to } in seconds, picked on the transcript
  let tasks = [], dirty = false;

  async function load() {
    r = await call('get', id);
    if (!r) { go('library'); return; }
    if (!dirty) tasks = structuredClone(r.tasks);
    paint();
  }

  const thumb = c => fileUrl(`${r.framesDir}\\thumbs\\${c.file}`);
  const full = c => fileUrl(`${r.framesDir}\\${c.file}`);
  const frameAt = s => r.candidates.reduce((b, c) => (!b || Math.abs(c.at - s) < Math.abs(b.at - s) ? c : b), null);

  function paint() {
    const p = state.progress && state.progress.id === r.id ? state.progress : null;
    const title = h('input', { class: 'title', value: r.title, title: 'Rename', onchange: async e => { if (await call('rename', r.id, e.target.value)) toast('Renamed'); } });
    const status = r.state === 'ready' ? null : h('div', { class: 'card' + (r.state === 'failed' ? ' warn' : '') },
      r.state === 'failed' ? [h('b', {}, 'Processing stopped: '), r.error, ' ', h('button', { onclick: () => call('retry', r.id).then(load) }, 'Try again')]
        : r.state === 'recording' ? 'Still recording.' : [p ? `${STEP[p.step] || 'Processing'}${p.what ? `, ${p.what}` : ''}` : 'Waiting to be processed', p && p.of ? ` (${Math.round((p.at / p.of) * 100)}%)` : '']);
    const video = h('video', { controls: true, preload: 'metadata', src: fileUrl(r.video) });
    const head = h('div', { class: 'head' },
      h('button', { class: 'ghost', onclick: () => go('library') }, 'Back'), title, h('span', { class: 'muted small' }, `${when(r.startedAt)} · ${clock(r.duration)}`));
    const actions = h('div', { class: 'bar' },
      h('button', { class: 'primary', disabled: r.state !== 'ready', title: 'A line to paste into an agent that can read files', onclick: async () => { if (await call('copyPrompt', r.id)) toast('Copied. Paste it into your agent'); } }, 'Copy prompt for my agent'),
      h('button', { disabled: r.state !== 'ready', title: 'A zip with the transcript, the prompt and up to 20 screenshots, for claude.ai, ChatGPT and other browser chats', onclick: async () => { const x = await call('exportChat', r.id); if (x) toast(`Saved with ${x.frames} screenshots`); } }, 'Export for chat'),
      h('button', { onclick: () => call('open', r.id, 'video') }, 'Open video'),
      h('button', { onclick: () => call('open', r.id, 'folder') }, 'Open folder'),
      h('button', { disabled: r.state !== 'ready', title: 'Transcribe again, for example after choosing another Whisper model', onclick: async () => { if (await call('redo', r.id, 'transcript')) { toast('Transcribing again'); load(); } } }, 'Transcribe again'),
      h('span', { class: 'grow' }),
      h('button', { class: 'danger', onclick: async () => { if (await call('delete', r.id)) go('library'); } }, 'Delete'));
    const tabs = h('div', { class: 'tabs' }, ...[['transcript', `Transcript (${r.lines.length})`], ['frames', `Frames (${r.candidates.length})`], ['tasks', `Tasks (${tasks.length})`]]
      .map(([k, label]) => h('button', { class: 'tab' + (tab === k ? ' on' : ''), onclick: () => { tab = k; paint(); } }, label)));
    const body = tab === 'transcript' ? transcriptTab(video) : tab === 'frames' ? framesTab() : tasksTab();
    el.replaceChildren(...[head, status, actions, tabs].filter(Boolean), tab === 'transcript' ? h('div', { class: 'split' }, body, h('div', {}, video, selBox())) : body);
  }

  // The transcript: click a line to jump the video there; shift-click to pick a span.
  function transcriptTab(video) {
    if (!r.lines.length) return h('div', { class: 'empty' }, r.state === 'ready' ? 'Nothing was said.' : 'The transcript comes after processing.');
    return h('div', { class: 'lines' }, ...r.lines.map(l => h('div', {
      class: 'line' + (sel && l.at >= sel.from && l.at <= sel.to ? ' sel' : ''),
      onclick: e => {
        if (e.shiftKey && sel) sel = { from: Math.min(sel.from, l.at), to: Math.max(sel.to, l.end ?? l.at) };
        else { sel = { from: l.at, to: l.end ?? l.at }; video.currentTime = l.at; }
        paint();
      },
    }, h('time', {}, `${clock(l.at)}-${clock(l.end ?? l.at)}`), h('span', {}, l.text))));
  }

  // The picked span's frames, and deleting the span.
  function selBox() {
    if (!sel) return h('p', { class: 'muted small' }, 'Click a line to jump there. Shift-click another to pick a span, to see its frames or delete it before an agent sees it.');
    const inSpan = r.candidates.filter(c => c.at >= sel.from - 1 && c.at <= sel.to + 1);
    return h('div', { class: 'card' }, h('div', { class: 'bar' }, h('b', {}, `${clock(sel.from)}-${clock(sel.to)}`), h('span', { class: 'grow' }),
      h('button', { class: 'danger', title: 'Deletes the transcript lines and frames in this span', onclick: async () => {
        if (!confirm(`Delete everything said and shown from ${clock(sel.from)} to ${clock(sel.to)}? This cannot be undone.`)) return;
        const x = await call('deleteSpan', r.id, sel.from, sel.to);
        if (x) { toast(`Deleted the span and ${x.frames} frames`); sel = null; load(); }
      } }, 'Delete this span')),
    inSpan.length ? h('div', { class: 'grid' }, ...inSpan.map(c => frameCard(c))) : h('p', { class: 'muted small' }, 'No frames in this span.'));
  }

  function frameCard(c) {
    return h('div', { class: 'frame' },
      h('img', { src: thumb(c), loading: 'lazy', onclick: () => zoom(full(c)) }),
      h('button', { class: 'x', title: 'Delete this frame', onclick: async () => { if (await call('deleteFrame', r.id, c.at) !== null) { toast('Frame deleted'); load(); } } }, '×'),
      h('div', { class: 'cap' }, h('span', {}, clock(c.at)), ...c.reasons.map(x => h('span', { class: `reason ${x}` }, x)), c.words.length ? h('span', { class: 'muted' }, `"${c.words.join(', ')}"`) : null));
  }

  function framesTab() {
    if (!r.candidates.length) return h('div', { class: 'empty' }, 'No frames yet.');
    return h('div', {}, h('p', { class: 'muted small' }, 'Candidate frames, picked without AI at scene changes, clicks, marks, pointing words and the middle of each line. Your agent chooses among them. Delete any that show something private.'),
      h('div', { class: 'grid' }, ...r.candidates.map(frameCard)));
  }

  // The task list as the agent saved it, editable before filing or exporting.
  function tasksTab() {
    const save = async () => { const x = await call('saveTasks', r.id, tasks); if (x) { tasks = x; dirty = false; toast('Tasks saved'); load(); } };
    const changed = () => { dirty = true; saveBtn.disabled = false; };
    const saveBtn = h('button', { class: 'primary', disabled: !dirty, onclick: save }, 'Save changes');
    if (!tasks.length) return h('div', { class: 'empty' }, 'No tasks yet. Ask your agent to run make-tasks on this recording (see Connect an agent), or use Copy prompt for my agent.');
    return h('div', {}, h('div', { class: 'bar' }, h('span', { class: 'muted small grow' }, 'Saved by your agent with save_tasks. Edit before filing or exporting.'), saveBtn),
      ...tasks.map((t, i) => h('div', { class: 'task' },
        h('div', { class: 'tline' },
          h('select', { onchange: e => { t.kind = e.target.value; changed(); } }, ...KINDS.map(k => h('option', { value: k, ...(k === t.kind ? { selected: true } : {}) }, k))),
          h('input', { class: 't', value: t.title, oninput: e => { t.title = e.target.value; changed(); } }),
          h('span', { class: 'muted small' }, clock(t.at)),
          h('button', { class: 'danger', title: 'Remove this task', onclick: () => { tasks.splice(i, 1); changed(); paint(); } }, 'Remove')),
        h('textarea', { rows: 3, oninput: e => { t.description = e.target.value; changed(); } }, t.description),
        t.steps.length ? h('div', { class: 'small muted' }, `Steps: ${t.steps.join(' / ')}`) : null,
        t.done_when ? h('div', { class: 'small muted' }, `Done when: ${t.done_when}`) : null,
        h('div', { class: 'chips' }, ...t.frames.map((s, k) => {
          const c = frameAt(s);
          return h('span', { class: 'chip' }, c ? h('img', { src: thumb(c), onclick: () => zoom(full(c)) }) : null, clock(s),
            h('button', { title: 'Remove this frame from the task', onclick: () => { t.frames.splice(k, 1); changed(); paint(); } }, '×'));
        }), (t.filed || []).map(f => h('a', { href: '#', class: 'small', title: f.url }, `filed: ${f.board}`))))));
  }

  load();
  // Progress comes many times a second while processing: the page reloads at most once a second.
  let pending = null;
  return { el, refresh: why => {
    if (why === 'progress' && r && r.state === 'ready') return;
    if (pending) return;
    pending = setTimeout(() => { pending = null; load(); }, why === 'progress' ? 1000 : 0);
  } };
}
