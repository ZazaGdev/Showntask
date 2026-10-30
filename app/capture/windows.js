// The overlay windows, Snipping Tool style: the pick
// windows dim every display and let the owner drag the area, toggle the mic and press Record; a
// 3 s countdown; while recording a border marks the area and a small bar shows the time, Pause,
// Mark, the mic and Stop, with the drawing tools on a row of their own.
// All of them are left out of the screen capture (content protection), so none ends up in the
// video. The drawing layer over the area is the one window that is recorded: with the pen off it
// lets every click through to the apps underneath, with it on the mouse draws. It also draws the
// soft spot under the cursor and a ring at each click.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen, globalShortcut } from 'electron';
import { bigEnough, onDesktop, borderBounds, barSpot } from '../lib/area.js';
import { ctrlHold } from '../lib/ctrl.js';
import { watchKeys } from './keys.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BAR = { width: 380, height: 80 };
const TOOLS = ['pen', 'highlight', 'rect', 'circle', 'arrow'];

// A window that never navigates away from its page and never opens another.
export function guardWindow(win) {
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// quiet: the windows open but stay invisible and never take focus (the smoke run, so the owner's
// screen is not dimmed while they work); the drawing layer still shows, since it is recorded.
// keys(): { pen, clear } accelerators to take while recording, holdCtrl, clicks. onClick({ x, y })
// gets each left click inside the area while the pen is off, in the area's DIP.
export function areaWindows({ log, quiet = false, keys = () => ({}), watch = watchKeys, onClick = () => {} }) {
  const wins = new Map(); // webContents id: { win, kind, init, onSend }
  let pick = null, rec = [], draw = null, bar = null, area = null, pen = false, tool = 'pen', disposed = false;
  let owned = [], stopWatch = () => {}, hold = null, armed = false, byCtrl = null, mouseDown = false, fxTimer = null;

  const open = (kind, bounds, init, onSend, o = {}) => {
    const win = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: o.movable === true, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, focusable: o.focusable !== false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(DIR, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    guardWindow(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (o.recorded !== true) win.setContentProtection(true);
    if (o.clickThrough) win.setIgnoreMouseEvents(true);
    const id = win.webContents.id;
    wins.set(id, { win, kind, init, onSend });
    win.on('closed', () => { const w = wins.get(id); wins.delete(id); if (w && w.onClosed) w.onClosed(); });
    win.loadFile(path.join(DIR, `${kind}.html`));
    if (quiet) win.setOpacity(0); // the smoke run records a canvas, so even the drawing layer stays unseen
    win.once('ready-to-show', () => { if (quiet || o.focusable === false || o.quietFocus) win.showInactive(); else { win.show(); win.focus(); } });
    return win;
  };

  const onInit = e => (wins.get(e.sender.id) || {}).init || null;
  const onMsg = (e, what, data) => { const w = wins.get(e.sender.id); if (w && w.onSend) w.onSend(what, data); };
  ipcMain.handle('capture:win-init', onInit);
  ipcMain.on('capture:win', onMsg);

  // Opens the overlay on every display; the one under the mouse takes the focus. Resolves
  // { display, rect, mic } (rect in that display's DIP) on Record, or null on Cancel or Esc.
  // auto: { rect, mic } answers by itself a moment after the overlay shows (the smoke run).
  function pickArea({ mic, auto = null }) {
    if (disposed) return Promise.resolve(null);
    const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const displays = [under, ...screen.getAllDisplays().filter(d => d.id !== under.id)];
    return new Promise(resolve => {
      let answered = false;
      const end = v => {
        if (answered) return;
        answered = true;
        for (const w of pick || []) if (!w.isDestroyed()) w.close();
        pick = null;
        resolve(v);
      };
      pick = displays.map((d, i) => {
        const win = open('pick', d.bounds, { mic }, (what, data) => {
          if (what === 'drag') { for (const w of pick || []) if (w !== win) tellWin(w, { clear: true }); return; }
          if (what === 'mic') { for (const w of pick || []) if (w !== win) tellWin(w, { mic: data !== false }); return; }
          if (what === 'record') {
            if (!data || !bigEnough(data.rect)) return;
            end({ display: d, rect: data.rect, mic: data.mic !== false });
          } else end(null);
        }, { quietFocus: i > 0 });
        wins.get(win.webContents.id).onClosed = () => end(null);
        return win;
      });
      if (auto) pick[0].once('ready-to-show', () => setTimeout(() => wins.get(pick[0].webContents.id)?.onSend('record', auto), 1200));
    });
  }
  const picking = () => !!pick;
  const cancelPick = () => { for (const w of pick || []) if (!w.isDestroyed()) w.close(); };

  // 3, 2, 1 over the area; resolves after `secs` seconds. Never recorded.
  function countdown({ display, rect, secs = 3 }) {
    if (disposed || secs <= 0) return Promise.resolve();
    const r = onDesktop(rect, display.bounds);
    const win = open('count', r, { secs }, null, { focusable: false, clickThrough: true });
    return new Promise(res => setTimeout(() => { if (!win.isDestroyed()) win.close(); res(); }, secs * 1000));
  }

  const tellWin = (w, s) => { if (w && !w.isDestroyed()) w.webContents.send('capture:win-state', s); };

  function setPen(on) {
    if (!draw || draw.isDestroyed()) return;
    pen = !!on;
    draw.setIgnoreMouseEvents(!pen);
    tellWin(draw, { pen, tool });
    tellWin(bar, { pen, tool });
  }
  function pickTool(t) {
    if (!TOOLS.includes(t)) return;
    byCtrl = null;
    if (pen && tool === t) return setPen(false);
    tool = t;
    setPen(true);
  }
  const clear = () => tellWin(draw, { clear: true });

  // The keys and mouse as Windows reads them: Ctrl held alone draws, a left button
  // going down inside the area is a click.
  function onKeys(k) {
    if (keys().holdCtrl !== false) {
      const r = ctrlHold(hold, k);
      hold = r.state;
      if (r.pen && !armed) {
        armed = true;
        if (!pen) { byCtrl = { tool }; tool = 'pen'; setPen(true); }
      } else if (!r.pen && armed) {
        armed = false;
        if (byCtrl) { tool = byCtrl.tool; byCtrl = null; setPen(false); }
      }
    }
    const down = !!k.mouse;
    if (down && !mouseDown && !pen && area) {
      const p = screen.getCursorScreenPoint();
      if (p.x >= area.x && p.y >= area.y && p.x < area.x + area.width && p.y < area.y + area.height) {
        const at = { x: p.x - area.x, y: p.y - area.y };
        onClick(at);
        if (keys().clickRings !== false) tellWin(draw, { click: at });
      }
    }
    mouseDown = down;
  }

  // The cursor's spot, sent to the drawing layer 30 times a second while it is over the area.
  function followCursor() {
    let last = '';
    fxTimer = setInterval(() => {
      if (!area || keys().cursorSpot === false) return;
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= area.x && p.y >= area.y && p.x < area.x + area.width && p.y < area.y + area.height;
      const at = inside ? { x: p.x - area.x, y: p.y - area.y } : null, s = JSON.stringify(at);
      if (s !== last) { last = s; tellWin(draw, { cursor: at }); }
    }, 33);
  }

  // The drawing layer, the border and the bar for a recording of rect (DIP) on display. The bar
  // opens last, so it stays above the drawing layer. onAction(what, data): stop, pause, mark,
  // mute from the bar.
  function showRecording({ display, rect, mic, onAction }) {
    closeRecording();
    if (disposed) return;
    const r = onDesktop(rect, display.bounds);
    area = r;
    const spot = barSpot(r, display.workArea, BAR);
    pen = false; tool = 'pen';
    const k = keys();
    draw = open('draw', r, {}, null, { focusable: false, clickThrough: true, recorded: true });
    bar = open('bar', { ...spot, ...BAR }, { mic, keys: k.shortcuts || {}, holdCtrl: k.holdCtrl !== false }, (what, data) => {
      if (what === 'tool') pickTool(data);
      else if (what === 'clear') clear();
      else onAction(what, data);
    }, { focusable: false, movable: true });
    rec = [draw, open('border', borderBounds(r), {}, null, { focusable: false, clickThrough: true }), bar];
    const take = (accel, fn, what) => {
      if (!accel) return;
      try { if (globalShortcut.register(accel, fn)) owned.push(accel); else log(`${accel} is taken, so only the ${what} button works`); } catch (e) { log(`${accel}: ${e.message}`); }
    };
    take(k.shortcuts?.pen, () => setPen(!pen), 'Pen');
    take(k.shortcuts?.clear, clear, 'Clear');
    if (k.holdCtrl !== false || k.clicks !== false) stopWatch = watch(onKeys, log);
    followCursor();
  }

  // The bar's view of the recording: { paused, elapsed (ms recorded so far), muted, voice, marked }.
  const barState = s => tellWin(bar, s);

  function closeRecording() {
    for (const a of owned) try { globalShortcut.unregister(a); } catch { /* gone */ }
    owned = [];
    stopWatch(); stopWatch = () => {};
    if (fxTimer) clearInterval(fxTimer);
    fxTimer = null;
    hold = null; armed = false; byCtrl = null; mouseDown = false; area = null;
    for (const w of rec) try { if (!w.isDestroyed()) w.close(); } catch (e) { log(`close: ${e.message}`); }
    rec = [];
    draw = bar = null;
    pen = false; tool = 'pen';
  }

  // The smoke run cannot move a mouse: it draws an outline round the middle of the area.
  function drawTest() {
    if (!draw || draw.isDestroyed()) return false;
    setPen(true);
    const [w, h] = draw.getContentSize(), pts = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; pts.push({ x: w / 2 + Math.cos(a) * w / 4, y: h / 2 + Math.sin(a) * h / 4 }); }
    tellWin(draw, { stroke: pts });
    setPen(false);
    tellWin(draw, { click: { x: w / 2, y: h / 2 } });
    return true;
  }

  return {
    pickArea, picking, cancelPick, countdown, showRecording, closeRecording, barState, drawTest,
    togglePen: () => setPen(!pen), clear, penOn: () => pen,
    openKinds: () => [...wins.values()].map(w => w.kind),
    owns: win => [...wins.values()].some(w => w.win === win),
    dispose() {
      disposed = true;
      closeRecording();
      for (const { win } of wins.values()) try { win.destroy(); } catch { /* gone */ }
      ipcMain.removeHandler('capture:win-init');
      ipcMain.removeListener('capture:win', onMsg);
    },
  };
}
