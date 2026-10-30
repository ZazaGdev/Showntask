// The app: the main window, the hidden worker, the overlay, global shortcuts, processing,
// and the hidden smoke run (`--smoke`), which records a painted canvas and a tone, never the
// owner's screen or voice, and checks the files a recording ends with.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, globalShortcut, Menu } from 'electron';
import { areaWindows, guardWindow } from './capture/windows.js';
import { recorder as makeRecorder } from './recorder.js';
import { pipeline as makePipeline } from './pipeline.js';
import { registerApi } from './api.js';
import { loadSettings, saveSettings, rootOf, loadAll, dirOf, load, save, files, appData } from './lib/store.js';
import { next } from './lib/session.js';
import { expired } from './lib/cleanup.js';
import { mend } from './lib/settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const SHOTS = !!process.env.SHOWNTASK_SHOTS;
app.setAppUserModelId('com.zazagdev.showntask'); // the same id as the installer's, so the taskbar groups them
if (SMOKE || SHOTS) app.setPath('userData', path.join(os.tmpdir(), `showntask-${SMOKE ? 'smoke' : 'shots'}-${process.pid}`));

const logFile = path.join(SMOKE ? app.getPath('userData') : appData(), 'showntask.log');
const log = s => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch { /* no log */ } if (SMOKE) console.log(s); };

if (!SMOKE && !SHOTS && !app.requestSingleInstanceLock()) app.quit();

let settings = SMOKE ? mend({ folder: path.join(app.getPath('userData'), 'recordings'), countdown: true }) : loadSettings();
const root = () => rootOf(settings);
let mainWin = null, workerWin = null, area = null, rec = null, pipe = null;

// ---------- the worker ----------
function makeWorker() {
  let n = 0, ready = null;
  const pending = new Map();
  const readyP = new Promise(res => { ready = res; });
  ipcMain.on('worker:ready', () => ready());
  ipcMain.on('worker:reply', (e, { id, ok, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(value); else p.reject(new Error(error));
  });
  ipcMain.on('worker:progress', (e, p) => { const x = pending.get(p.id); if (x && x.onProgress) x.onProgress(p); });
  ipcMain.on('worker:voice', (e, v) => { if (rec) rec.voice(v); });
  workerWin = new BrowserWindow({ show: false, width: 640, height: 400, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  guardWindow(workerWin);
  workerWin.loadFile(path.join(HERE, 'record', 'worker.html'));
  workerWin.webContents.on('render-process-gone', (e, d) => {
    log(`worker gone: ${d.reason}`);
    for (const p of pending.values()) p.reject(new Error(`The worker stopped (${d.reason})`));
    pending.clear();
  });
  return {
    async call(kind, args, onProgress) {
      await readyP;
      const id = ++n;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        workerWin.webContents.send('worker:call', { id, kind, args });
      });
    },
  };
}

// ---------- the main window ----------
function showMain() {
  if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1180, height: 780, minWidth: 760, minHeight: 520, show: false, title: 'Showntask', backgroundColor: '#15161a',
    icon: path.join(HERE, 'build', 'icon.png'),
    webPreferences: { preload: path.join(HERE, 'screens', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guardWindow(mainWin);
  mainWin.loadFile(path.join(HERE, 'screens', 'index.html'));
  // SHOWNTASK_HIDDEN keeps the window out of sight for test runs on the owner's PC.
  if (!SMOKE && !process.env.SHOWNTASK_HIDDEN) mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; quitWhenIdle(); });
}
// With the main window closed the app ends, once nothing is recording or processing.
function quitWhenIdle() {
  if (SMOKE || mainWin) return;
  if (!(rec && rec.current()) && !(pipe && pipe.progress())) app.quit();
}
const send = (ch, v) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, v); };

// ---------- shortcuts ----------
// Start/stop and pick are always taken; pause, mark and mute only while recording, so they
// never steal those keys from other apps otherwise. Pen and Clear belong to the overlay.
let owned = [];
function bindKeys() {
  for (const a of owned) try { globalShortcut.unregister(a); } catch { /* gone */ }
  owned = [];
  if (SMOKE || process.env.SHOWNTASK_HIDDEN) return;
  const k = settings.shortcuts, recording = !!(rec && rec.current());
  const take = (accel, fn) => {
    if (!accel) return;
    try { if (globalShortcut.register(accel, fn)) owned.push(accel); else log(`${accel} is taken by another app`); } catch (e) { log(`${accel}: ${e.message}`); }
  };
  take(k.record, () => rec.toggle());
  take(k.pick, () => rec.repick());
  if (recording) { take(k.pause, () => rec.pause()); take(k.mark, () => rec.mark()); take(k.mute, () => rec.mute()); }
}

// ---------- old recordings ----------
function prune() {
  const all = loadAll(root()), cur = rec && rec.current();
  for (const id of expired(all.filter(r => r.state === 'ready' || r.state === 'failed'), settings.deleteAfter, Date.now(), cur && cur.id)) {
    try { fs.rmSync(path.join(root(), id), { recursive: true, force: true }); log(`deleted ${id} (older than ${settings.deleteAfter})`); } catch (e) { log(`prune ${id}: ${e.message}`); }
  }
}

// A recording left in 'recording' by a crash ends when its last chunk was written.
function recover() {
  for (const r of loadAll(root())) {
    if (r.state !== 'recording') continue;
    const dir = dirOf(root(), r.id);
    let at = r.startedAt;
    try { at = fs.statSync(path.join(dir, 'video.webm')).mtimeMs; } catch { /* nothing recorded */ }
    save(dir, next(r, { type: 'resume', at, duration: (at - r.startedAt) / 1000 }));
    log(`${r.id} was cut off; processing what was saved`);
  }
}

// What the Connect page tells agents to start.
const mcpCommand = () => (app.isPackaged ? { command: app.getPath('exe'), args: ['--mcp'] } : { command: process.execPath, args: [path.join(HERE, '..'), '--mcp'] });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const worker = makeWorker();
  area = areaWindows({
    log, quiet: SMOKE,
    keys: () => ({ shortcuts: settings.shortcuts, holdCtrl: settings.holdCtrl, clicks: settings.clicks, clickRings: settings.clickRings, cursorSpot: settings.cursorSpot }),
    onClick: at => { if (settings.clicks && rec) rec.click(at); },
  });
  pipe = makePipeline({ worker, settings: () => settings, root, log, fake: SMOKE, onChange: p => { send('progress', p); if (!p) setTimeout(quitWhenIdle, 1000); } });
  rec = makeRecorder({
    worker, area, settings: () => settings, root, log, fake: SMOKE,
    auto: SMOKE ? { rect: { x: 100, y: 100, width: 480, height: 270 }, mic: true } : null,
    onChange: s => { send('recorder', s); bindKeys(); },
    onStopped: id => { send('changed', id); pipe.kick(); setTimeout(quitWhenIdle, 2000); },
  });
  registerApi({
    root, settings: () => settings, recorder: rec, pipeline: pipe, worker, mcpCommand, log,
    setSettings: s => { settings = s; if (!SMOKE) saveSettings(s); bindKeys(); return s; },
  });
  // A screenshot run only looks: it leaves processing and cleanup to the running app.
  if (!SHOTS) recover();
  bindKeys();
  showMain();
  if (!SHOTS) pipe.kick();
  if (!SMOKE && !SHOTS) { prune(); setInterval(prune, 3600e3); }
  if (process.env.SHOWNTASK_SHOTS) {
    const { takeShots } = await import('./dev-shots.js');
    mainWin.webContents.once('did-finish-load', () => takeShots(mainWin, process.env.SHOWNTASK_SHOTS, loadAll(root())[0]?.id).then(() => app.exit(0), e => { log(e.stack); app.exit(1); }));
  }
  if (SMOKE) smoke().then(ok => app.exit(ok ? 0 : 1), e => { log(`smoke failed: ${e.stack || e.message}`); app.exit(1); });
});

app.on('second-instance', () => showMain());
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (pipe) pipe.stop(); if (area) area.dispose(); });
app.on('window-all-closed', () => app.quit());

// ---------- the smoke run ----------
async function smoke() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (ok, what) => { log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
  let pass = true;
  const s = await rec.start({ repick: true });
  pass = check(!!s.id, `recording started (${s.id || s.error})`) && pass;
  if (!s.id) return false;
  await wait(1500);
  pass = check(area.openKinds().includes('draw') && area.openKinds().includes('bar'), 'the bar and the drawing layer are open') && pass;
  pass = check(area.drawTest(), 'drew on the drawing layer') && pass;
  rec.click({ x: 200, y: 120 });
  await rec.pause(); await wait(800); await rec.pause();
  rec.mark();
  await wait(2500);
  await rec.stop();
  const dir = dirOf(root(), s.id);
  for (let i = 0; i < 240; i++) {
    const r = load(dir);
    if (r.state === 'ready' || r.state === 'failed') break;
    await wait(500);
  }
  const r = load(dir), f = files(dir);
  pass = check(r.state === 'ready', `processed (${r.state}${r.error ? `: ${r.error}` : ''})`) && pass;
  pass = check(fs.existsSync(f.md) && fs.readFileSync(f.md, 'utf8').includes('dashboard'), 'transcript.md written') && pass;
  const cands = JSON.parse(fs.readFileSync(f.candidates, 'utf8'));
  pass = check(cands.length > 0 && cands.every(c => fs.existsSync(path.join(f.frames, c.file)) && fs.existsSync(path.join(f.frames, 'tiles', c.file.replace('.jpg', '.png')))), `${cands.length} candidate frames with tiles`) && pass;
  pass = check(cands.some(c => c.reasons.includes('marker')), 'the mark became a candidate') && pass;
  pass = check(fs.existsSync(f.makeTasks) && fs.readFileSync(f.makeTasks, 'utf8').includes(dir), 'MAKE-TASKS.md written with the folder') && pass;
  const events = JSON.parse(fs.readFileSync(f.events, 'utf8'));
  pass = check(events.clicks.length === 1 && events.pauses.length === 1, 'click and pause logged') && pass;
  pass = check(r.duration > 3 && r.duration < 6, `length without the pause (${r.duration.toFixed(1)} s)`) && pass;
  log(`smoke ${pass ? 'passed' : 'FAILED'}: ${dir}`);
  return pass;
}
