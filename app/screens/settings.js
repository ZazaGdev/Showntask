// Settings: shortcuts for every action, recording, Whisper, frames, storage.
import { h, call, toast } from './ui.js';

// The accelerator for a keydown, as Electron writes it; null while only modifiers are down.
function accelOf(e) {
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' }[k];
  const key = named || (/^F\d{1,2}$/.test(k) || ['Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(k) ? k : k.length === 1 ? k.toUpperCase() : null);
  if (!key || !mods.length) return null;
  return [...mods, key].join('+');
}

export function settingsPage() {
  const el = h('section', {}, h('h1', {}, 'Settings'));
  let s = null;

  const set = async patch => {
    const x = await call('setSettings', patch);
    if (x) { s.settings = x; toast('Saved'); }
    paint();
  };

  async function load() { s = await call('settings'); if (s) paint(); }

  function keyInput(action) {
    const v = s.settings.shortcuts[action] || '';
    const inp = h('input', { class: 'keyin', readonly: true, value: v.replace(/Control/g, 'Ctrl') || 'None', title: 'Click, then press the keys. Backspace alone clears it.' });
    inp.addEventListener('focus', () => { inp.classList.add('wait'); inp.value = 'Press the keys...'; });
    inp.addEventListener('blur', () => paint());
    inp.addEventListener('keydown', e => {
      e.preventDefault();
      if (e.key === 'Escape') { inp.blur(); return; }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) { set({ shortcuts: { [action]: '' } }); return; }
      const a = accelOf(e);
      if (a) set({ shortcuts: { [action]: a } });
    });
    return inp;
  }
  const toggle = (key, label) => [h('label', {}, label), h('input', { type: 'checkbox', checked: s.settings[key], onchange: e => set({ [key]: e.target.checked }) })];
  const number = (key, label, min, max) => [h('label', {}, label), h('input', { type: 'number', min, max, value: s.settings[key], onchange: e => set({ [key]: Number(e.target.value) }) })];

  function paint() {
    const st = s.settings, sp = s.speech;
    el.replaceChildren(h('h1', {}, 'Settings'),
      h('h2', {}, 'Shortcuts'),
      h('p', { class: 'muted small' }, 'Work in any app. Pause, Mark and Mute are taken only while recording; Pen and Clear too.'),
      h('div', { class: 'form' }, ...Object.entries(s.actions).flatMap(([a, label]) => [h('label', {}, label), keyInput(a)])),
      h('h2', {}, 'Recording'),
      h('div', { class: 'form' },
        ...toggle('mic', 'Record the mic'), ...toggle('countdown', 'Count down 3 s before recording'),
        ...toggle('holdCtrl', 'Hold Ctrl on its own to draw'), ...toggle('clicks', 'Log clicks (for frame picks)'),
        ...toggle('clickRings', 'Show a ring at each click in the video'), ...toggle('cursorSpot', 'Show a soft spot under the cursor in the video')),
      h('h2', {}, 'Transcription'),
      h('div', { class: 'form' },
        h('label', {}, 'Whisper model'),
        h('select', { onchange: e => set({ model: e.target.value }) }, ...Object.entries(s.models).map(([k, m]) => h('option', { value: k, ...(k === st.model ? { selected: true } : {}) }, m.label))),
        h('label', {}, 'Language'),
        h('select', { disabled: /\.en[-.]/.test(st.model), onchange: e => set({ language: e.target.value }) },
          ...[['auto', 'Detect'], ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ka', 'Georgian'], ['uk', 'Ukrainian'], ['ja', 'Japanese'], ['zh', 'Chinese']]
            .map(([k, n]) => h('option', { value: k, ...(k === st.language ? { selected: true } : {}) }, n))),
        h('label', {}, 'Whisper folder'),
        h('div', { class: 'small' }, sp.missing.length ? `${sp.dir}: the ${sp.missing.join(' and ')} will be downloaded on first use (the only download Showntask makes)` : `${sp.dir}: ready`)),
      h('h2', {}, 'Frames for your agent'),
      h('div', { class: 'form' },
        ...number('sheetMax', 'Thumbnails per contact sheet', 4, 24), ...number('frameWidth', 'Full frame width (px)', 640, 3840),
        ...number('framesPerTask', 'Frames per task, at most', 1, 6), ...toggle('viewFrames', 'Let agents look at frames (off: they pick unseen, saving tokens)')),
      h('h2', {}, 'Storage'),
      h('div', { class: 'form' },
        h('label', {}, 'Recordings folder'),
        h('div', { class: 'bar' }, h('span', { class: 'small' }, s.root), h('button', { onclick: async () => { const f = await call('pickFolder'); if (f) set({ folder: f }); } }, 'Change')),
        h('label', {}, 'Delete recordings after'),
        h('select', { onchange: e => set({ deleteAfter: e.target.value }) }, ...['never', '24 hours', 'a week', 'a month'].map(k => h('option', { value: k, ...(k === st.deleteAfter ? { selected: true } : {}) }, k)))),
      h('p', { class: 'muted small' }, 'Nothing leaves this PC from Showntask: no account, no telemetry, no update check. The one download is Whisper and its model.'));
  }
  load();
  return { el };
}
