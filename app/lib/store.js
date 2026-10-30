// Recordings on disk, shared by the app and the MCP server: one folder each, named by
// its start time, under the recordings folder (%USERPROFILE%\Showntask unless Settings says
// otherwise). Plain Node, no Electron, so the MCP server can use it as it is.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { folderName, expandEnv } from './transcript.js';
import { mend } from './settings.js';

export const appData = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Showntask');
export const settingsFile = () => path.join(appData(), 'settings.json');

export function loadSettings() {
  try { return mend(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch { return mend({}); }
}
export function saveSettings(s) {
  fs.mkdirSync(appData(), { recursive: true });
  writeJson(settingsFile(), mend(s));
}

export const rootOf = settings => (settings && settings.folder ? expandEnv(settings.folder, process.env) : path.join(os.homedir(), 'Showntask'));

// Written whole (a temp file, then a rename) so a crash never leaves half a file.
export function writeJson(f, v) {
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2));
  fs.renameSync(f + '.tmp', f);
}
export function readJson(f, fallback = null) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
export function writeText(f, s) {
  fs.writeFileSync(f + '.tmp', s);
  fs.renameSync(f + '.tmp', f);
}

// A new, empty recording folder: { id, dir }.
export function createFolder(root, now = new Date()) {
  const base = folderName(now);
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`, dir = path.join(root, id);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return { id, dir };
  }
}

const ID = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/;
export const validId = id => ID.test(String(id));

// The folder of recording id, or null for an id that is not one (so ../ never gets through).
export function dirOf(root, id) {
  if (!validId(id)) return null;
  const dir = path.join(root, id);
  return fs.existsSync(path.join(dir, 'recording.json')) ? dir : null;
}

export const load = dir => readJson(path.join(dir, 'recording.json'));
export const save = (dir, rec) => writeJson(path.join(dir, 'recording.json'), rec);

// Every recording, newest first.
export function loadAll(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && validId(d.name)).map(d => d.name); } catch { return []; }
  const out = [];
  for (const n of names) { const r = load(path.join(root, n)); if (r && r.id === n) out.push(r); }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// The video a recording plays: its own video.webm, or the imported file where it lies.
export const videoOf = (dir, rec) => (rec && rec.imported && rec.video ? rec.video : path.join(dir, 'video.webm'));

export function size(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

export const files = dir => ({
  wav: path.join(dir, 'audio.wav'), events: path.join(dir, 'events.json'), chunks: path.join(dir, 'chunks'),
  json: path.join(dir, 'transcript.json'), md: path.join(dir, 'transcript.md'), frames: path.join(dir, 'frames'),
  candidates: path.join(dir, 'candidates.json'), makeTasks: path.join(dir, 'MAKE-TASKS.md'),
  tasks: path.join(dir, 'tasks.json'), tasksMd: path.join(dir, 'tasks.md'),
});

// A recording's title: the one the owner gave, else its start time.
export function titleOf(rec) {
  if (rec.title) return rec.title;
  const d = new Date(rec.startedAt), p = n => String(n).padStart(2, '0');
  return `${rec.imported ? 'Imported' : 'Recording'} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
