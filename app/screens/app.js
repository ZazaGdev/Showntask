// The main window: Recordings, a recording's page, Settings and Connect.
import { h } from './ui.js';
import { libraryPage } from './library.js';
import { recordingPage } from './recording.js';
import { settingsPage } from './settings.js';
import { connectPage } from './connect.js';

const page = document.getElementById('page');
const state = { progress: null, recorder: { recording: false } };
let current = null; // { name, id, refresh }

export function go(name, id = null) {
  for (const b of document.querySelectorAll('.navbtn')) b.classList.toggle('on', b.dataset.page === name || (name === 'recording' && b.dataset.page === 'library'));
  const make = { library: libraryPage, recording: recordingPage, settings: settingsPage, connect: connectPage }[name];
  const view = make({ go, state, id });
  current = { name, id, refresh: view.refresh || (() => {}) };
  page.replaceChildren(view.el);
}

for (const b of document.querySelectorAll('.navbtn')) b.addEventListener('click', () => go(b.dataset.page));

function paintRec() {
  const el = document.getElementById('recstate'), r = state.recorder;
  el.className = 'recstate' + (r.recording ? ' live' : '');
  el.replaceChildren(r.recording ? `Recording${r.paused ? ' (paused)' : ''}` : '', state.progress ? h('div', { class: 'muted' }, 'Processing in the background') : '');
}

window.api.on('progress', p => { state.progress = p; paintRec(); if (current) current.refresh('progress'); });
window.api.on('recorder', r => { state.recorder = r; paintRec(); if (current) current.refresh('recorder'); });
window.api.on('changed', () => { if (current) current.refresh('changed'); });

window.api.call('state').then(s => { if (s && !s.error) { state.recorder = s.recorder; state.progress = s.progress; paintRec(); } go('library'); });
