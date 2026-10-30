// Dev only (SHOWNTASK_SHOTS=<folder>): pictures of the main window's pages, taken with the window
// hidden, so the screens can be checked without showing anything on the owner's screen.
import fs from 'node:fs';
import path from 'node:path';

export async function takeShots(win, out, firstId) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = s => win.webContents.executeJavaScript(s);
  fs.mkdirSync(out, { recursive: true });
  const shot = async name => { await wait(1500); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  await wait(1500);
  await shot('library');
  if (firstId) {
    await js(`[...document.querySelectorAll('.row')].find(r => r.querySelector('.status.ready'))?.click()`); await shot('recording-transcript');
    await js(`[...document.querySelectorAll('.tab')][1]?.click()`); await shot('recording-frames');
    await js(`[...document.querySelectorAll('.tab')][2]?.click()`); await shot('recording-tasks');
  }
  await js(`document.querySelector('[data-page=settings]').click()`); await shot('settings');
  await js(`document.querySelector('[data-page=connect]').click()`); await shot('connect');
}
