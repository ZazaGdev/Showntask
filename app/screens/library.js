// Recordings: search, Record, Import, and one row per recording with its state.
import { h, call, fileUrl, clock, when, STEP, toast } from './ui.js';

export function libraryPage({ go, state }) {
  const rows = h('div', { class: 'rows' });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search titles and transcripts', oninput: () => { clearTimeout(t); t = setTimeout(fill, 200); } });
  let t = null;
  const recBtn = h('button', { class: 'rec', onclick: () => call('record') });
  const paintBtn = () => { recBtn.textContent = state.recorder.recording ? 'Stop recording' : 'Record'; };
  paintBtn();
  // The privacy note, shown until the owner has read it once.
  let seen = false;
  try { seen = localStorage.getItem('privacyRead') === '1'; } catch { /* no storage */ }
  const note = seen ? null : h('div', { class: 'card' }, h('b', {}, 'Your recordings stay on this PC. '),
    'Showntask sends nothing anywhere: no account, no telemetry, no update check. The one download is Whisper, for transcribing, the first time you need it. When you let an AI agent read a recording, what it reads goes to that agent\'s provider. ',
    h('button', { onclick: e => { try { localStorage.setItem('privacyRead', '1'); } catch { /* no storage */ } e.target.closest('.card').remove(); } }, 'Got it'));
  const el = h('section', {}, note,
    h('div', { class: 'bar' }, h('h1', {}, 'Recordings'), h('span', { class: 'grow' }), search,
      h('button', { onclick: async () => { const r = await call('import'); if (r && r.id) { toast('Imported. Processing starts now'); fill(); } } }, 'Import a video'),
      h('button', { title: 'Pick a new area, then record', onclick: () => call('repick') }, 'New area'), recBtn),
    rows);

  async function fill() {
    const list = await call('search', search.value);
    if (!list) return;
    if (!list.length) {
      rows.replaceChildren(h('div', { class: 'empty' }, search.value ? 'Nothing matches.' : 'No recordings yet. Press Record (Ctrl+Alt+T), drag over the area to record, and talk.'));
      return;
    }
    rows.replaceChildren(...list.map(r => row(r)));
  }

  function row(r) {
    const p = state.progress && state.progress.id === r.id ? state.progress : null;
    const status = r.state === 'ready' ? 'Ready' : r.state === 'failed' ? 'Failed' : r.state === 'recording' ? 'Recording' : p ? STEP[p.step] || 'Processing' : 'Waiting to process';
    const pct = p && p.of ? Math.min(100, Math.round((p.at / p.of) * 100)) : null;
    const facts = [when(r.startedAt), r.duration ? clock(r.duration) : '', r.lines ? `${r.lines} lines` : '', r.tasks ? `${r.tasks} tasks${r.filed ? `, ${r.filed} filed` : ''}` : ''].filter(Boolean).join(' · ');
    return h('div', { class: 'row', onclick: () => go('recording', r.id) },
      r.thumb ? h('img', { class: 'thumb', src: fileUrl(r.thumb), alt: '' }) : h('div', { class: 'thumb' }),
      h('div', {}, h('h3', {}, r.title), h('div', { class: 'muted small' }, facts),
        r.state === 'failed' && r.error ? h('div', { class: 'small', style: 'color: var(--rec)' }, r.error) : null,
        p ? h('div', { class: 'small muted' }, p.what || '') : null,
        pct !== null ? h('div', { class: 'prog' }, h('div', { style: `width: ${pct}%` })) : null),
      h('span', { class: `status ${r.state}` }, status));
  }

  fill();
  return { el, refresh: why => { paintBtn(); if (why !== 'recorder' || !state.recorder.recording) fill(); } };
}
