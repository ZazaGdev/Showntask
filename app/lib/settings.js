// Showntask's settings: the defaults, and a saved settings file mended into a whole one,
// so a missing or odd value never breaks the app.
import { KEEP_CHOICES } from './cleanup.js';

export const ACTIONS = {
  record: 'Start or stop recording',
  pick: 'Pick a new area and record',
  pause: 'Pause or resume',
  mark: 'Mark this moment',
  mute: 'Mute or unmute the mic',
  pen: 'Drawing on or off',
  clear: 'Clear the drawing',
};

export const MODELS = {
  'ggml-base.en-q5_1.bin': { label: 'base.en, quick, rougher (about 60 MB)', size: 59721011, lang: 'en' },
  'ggml-small.en-q5_1.bin': { label: 'small.en, the default (about 190 MB)', size: 190098681, lang: 'en' },
  'ggml-small-q5_1.bin': { label: 'small, any language (about 190 MB)', size: 190085487, lang: 'auto' },
  'ggml-medium-q5_0.bin': { label: 'medium, any language (about 540 MB)', size: 539212467, lang: 'auto' },
  'ggml-medium.en-q5_0.bin': { label: 'medium.en, best for names and code words (about 540 MB)', size: 539212467, lang: 'en' },
};

export const DEFAULTS = {
  shortcuts: {
    // Not Ctrl+Alt+R: other screen recorders often take it.
    record: 'Control+Alt+T', pick: 'Control+Shift+Alt+T', pause: 'Control+Alt+P', mark: 'Control+Alt+K',
    mute: 'Control+Alt+M', pen: 'Control+Alt+D', clear: 'Control+Alt+Backspace',
  },
  mic: true,
  countdown: true,
  holdCtrl: true, // Ctrl held on its own draws while recording
  clicks: true, // log clicks (for candidates and the click rings)
  clickRings: true,
  cursorSpot: true,
  model: 'ggml-small.en-q5_1.bin',
  language: 'auto', // 'auto' follows the model: English for .en models
  speechDir: '', // empty: %APPDATA%\Showntask\speech
  folder: '', // empty: %USERPROFILE%\Showntask
  deleteAfter: 'never',
  sheetMax: 12,
  frameWidth: 1280,
  framesPerTask: 3,
  viewFrames: true,
};

const ACCEL = /^(?:(?:Control|Ctrl|Alt|Shift|Super|Meta|CommandOrControl|CmdOrCtrl)\+)+(?:[A-Z0-9]|F\d{1,2}|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Space|Tab|Up|Down|Left|Right|Plus|[`\-=[\];',./\\])$/;

// An accelerator Electron can register: at least one modifier and one key. Empty is allowed and
// means no shortcut.
export const validKey = k => k === '' || ACCEL.test(String(k));

// The settings file's contents made whole: unknown keys dropped, odd values back to defaults.
export function mend(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const out = structuredClone(DEFAULTS);
  for (const a of Object.keys(ACTIONS)) {
    const k = s.shortcuts && s.shortcuts[a];
    if (typeof k === 'string' && validKey(k)) out.shortcuts[a] = k;
  }
  for (const k of ['mic', 'countdown', 'holdCtrl', 'clicks', 'clickRings', 'cursorSpot', 'viewFrames']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (typeof s.model === 'string' && /^ggml-[\w.-]+\.bin$/.test(s.model)) out.model = s.model;
  if (typeof s.language === 'string' && /^(auto|[a-z]{2})$/.test(s.language)) out.language = s.language;
  for (const k of ['speechDir', 'folder']) if (typeof s[k] === 'string') out[k] = s[k];
  if (KEEP_CHOICES.includes(s.deleteAfter)) out.deleteAfter = s.deleteAfter;
  const int = (k, lo, hi) => { if (Number.isInteger(s[k]) && s[k] >= lo && s[k] <= hi) out[k] = s[k]; };
  int('sheetMax', 4, 24); int('frameWidth', 640, 3840); int('framesPerTask', 1, 6);
  return out;
}

// The same accelerator on two actions: the later ones, so Settings can say which clash.
export function clashes(shortcuts) {
  const seen = new Map(), out = [];
  for (const [a, k] of Object.entries(shortcuts || {})) {
    if (!k) continue;
    const norm = k.toLowerCase().replace(/ctrl|cmdorctrl|commandorcontrol/g, 'control');
    if (seen.has(norm)) out.push(a); else seen.set(norm, a);
  }
  return out;
}

// Whisper's -l for a model and the language setting: an English-only model is always English.
export function whisperLanguage(model, language) {
  if (/\.en[-.]/.test(model)) return 'en';
  return language || 'auto';
}
