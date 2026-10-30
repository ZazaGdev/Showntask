// Spike harness: runs test/spike/spike.html in a hidden window and prints what it reports.
// npx electron test/spike/spike-main.mjs <mode> <file> [out-dir]
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(process.argv.findIndex(a => a.endsWith('spike-main.mjs')) + 1);
const [mode, file, out, secs] = args;
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));
  ipcMain.on('log', (e, s) => console.log(s));
  ipcMain.on('done', (e, s) => { console.log('RESULT', JSON.stringify(s, null, 1)); app.quit(); });
  win.loadFile(path.join(here, 'spike.html'), { query: { mode, file, out: out || '', secs: secs || '60' } });
});
