// The main window's requests: the recordings library, a recording's transcript, frames
// and tasks, Import, Export for chat, Settings and the Connect page. Every handler checks its
// recording id against the recordings folder, so a page can never reach outside it.
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, dialog, shell, clipboard, BrowserWindow, app } from 'electron';
import { loadAll, dirOf, load, save, files, videoOf, titleOf, readJson, writeJson, writeText, createFolder, size } from './lib/store.js';
import { imported } from './lib/session.js';
import { linesOf, candidatesOf, tasksOf, copyLine, promptText, promptVars, writeMakeTasks } from './lib/recfiles.js';
import { mendTasks, tasksMd } from './lib/tasks.js';
import { render } from './lib/prompts.js';
import { zip } from './lib/zip.js';
import { clock, transcriptMd } from './lib/transcript.js';
import { connectLines } from './lib/connect.js';
import { frameName, chatPicks } from './lib/frames.js';
import { MODELS, ACTIONS, clashes, mend } from './lib/settings.js';
import { locate } from './speech.js';

export function registerApi({ root, settings, setSettings, recorder, pipeline, worker, mcpCommand, log }) {
  const handle = (ch, fn) => ipcMain.handle(`api:${ch}`, async (e, ...a) => {
    try { return await fn(...a); } catch (err) { log(`${ch}: ${err.stack || err.message}`); return { error: err.message }; }
  });
  const need = id => { const d = dirOf(root(), id); if (!d) throw new Error('That recording is gone'); return d; };

  const summary = rec => {
    const dir = path.join(root(), rec.id), tasks = tasksOf(dir);
    return { id: rec.id, title: titleOf(rec), state: rec.state, step: rec.step, error: rec.error, startedAt: rec.startedAt,
      duration: rec.duration, imported: !!rec.imported, lines: linesOf(dir).length, tasks: tasks.length, filed: tasks.filter(t => (t.filed || []).length).length,
      thumb: firstThumb(dir) };
  };
  const firstThumb = dir => { const c = candidatesOf(dir).find(x => x.file); return c ? path.join(dir, 'frames', 'thumbs', c.file) : null; };

  handle('state', () => ({ recorder: recorder.state(), progress: pipeline.progress(), root: root() }));
  handle('list', () => loadAll(root()).map(summary));
  handle('get', id => {
    const dir = need(id), rec = load(dir);
    return { ...summary(rec), dir, video: videoOf(dir, rec), lines: linesOf(dir), candidates: candidatesOf(dir), tasks: tasksOf(dir), copyLine: copyLine(dir),
      framesDir: path.join(dir, 'frames') };
  });
  // Search: recordings whose title or transcript has every word asked for.
  handle('search', q => {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return loadAll(root()).filter(r => {
      if (!words.length) return true;
      const hay = `${titleOf(r)} ${linesOf(path.join(root(), r.id)).map(l => l.text).join(' ')}`.toLowerCase();
      return words.every(w => hay.includes(w));
    }).map(summary);
  });
  handle('rename', (id, title) => {
    const dir = need(id), rec = load(dir);
    save(dir, { ...rec, title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
    if (fs.existsSync(files(dir).candidates)) writeMakeTasks(dir, load(dir), settings());
    return true;
  });
  handle('delete', async id => {
    const dir = need(id), cur = recorder.current();
    if (cur && cur.id === id) throw new Error('It is still recording');
    if (pipeline.progress() && pipeline.progress().id === id) throw new Error('It is being processed; try again when it is done');
    const ok = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Delete "${titleOf(load(dir))}"?`, detail: 'Its video, sound, transcript, frames and tasks are deleted. An imported video stays where it was.' });
    if (ok.response !== 0) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });
  handle('retry', id => pipeline.retry(id));
  handle('redo', (id, from) => pipeline.redo(id, from));

  // The task list from the editor.
  handle('saveTasks', (id, tasks) => {
    const dir = need(id), rec = load(dir), list = mendTasks(tasks, { duration: rec.duration || Infinity, old: tasksOf(dir) });
    writeJson(files(dir).tasks, list);
    writeText(files(dir).tasksMd, tasksMd(list, { title: titleOf(rec), frameFile: s => path.join(dir, 'frames', frameName(s)) }));
    return list;
  });
  // Privacy: a frame, or every frame and transcript line in a span, deleted before an agent sees them.
  const dropFrames = (dir, keep) => {
    const list = candidatesOf(dir), gone = list.filter(c => !keep(c));
    for (const c of gone) for (const [sub, ext] of [['', 'jpg'], ['thumbs', 'jpg'], ['tiles', 'png']]) fs.rmSync(path.join(dir, 'frames', sub, frameName(c.at, ext)), { force: true });
    writeJson(files(dir).candidates, list.filter(keep));
    return gone.length;
  };
  handle('deleteFrame', (id, at) => dropFrames(need(id), c => Math.floor(c.at) !== Math.floor(Number(at))));
  handle('deleteSpan', (id, from, to) => {
    const dir = need(id), rec = load(dir), a = Number(from), b = Number(to);
    if (!(b > a)) throw new Error('The span is empty');
    const n = dropFrames(dir, c => c.at < a || c.at > b);
    const lines = linesOf(dir).filter(l => (l.end ?? l.at) < a || l.at > b);
    writeJson(files(dir).json, { lines });
    writeText(files(dir).md, transcriptMd(lines, { title: titleOf(rec), video: videoOf(dir, rec) }));
    save(dir, { ...rec, cut: [...(rec.cut || []), { from: a, to: b }] });
    writeMakeTasks(dir, load(dir), settings());
    return { frames: n };
  });

  handle('import', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { title: 'Import a video', properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const video = r.filePaths[0];
    const info = await worker.call('probe', { video });
    const v = info.tracks.find(t => t.kind === 'video');
    if (!v) throw new Error('That file has no video track');
    if (/^mp4:/.test(v.codec)) throw new Error(`Showntask cannot read this video's format (${v.codec.slice(4)}). Convert it to H.264 MP4 first, for example with HandBrake.`);
    // Dated by the video's file time, so the library sorts it with when it was made.
    const made = fs.statSync(video).mtimeMs, { id, dir } = createFolder(root(), new Date(made));
    save(dir, { ...imported(id, made, video, info.duration), title: path.basename(video).replace(/\.\w+$/, '') });
    pipeline.kick();
    return { id };
  });

  handle('open', (id, what) => {
    const dir = need(id), rec = load(dir);
    const f = { folder: dir, video: videoOf(dir, rec), transcript: files(dir).md, makeTasks: files(dir).makeTasks }[what];
    if (!f) return false;
    return shell.openPath(f).then(err => err === '');
  });
  handle('copy', text => { clipboard.writeText(String(text)); return true; });
  handle('copyPrompt', id => { clipboard.writeText(copyLine(need(id))); return true; });

  // Export for chat: a zip with one Markdown file (the make-tasks prompt, the transcript and the
  // frames' list) and up to 20 screenshots, for browser chats that cannot reach the PC.
  handle('exportChat', async id => {
    const dir = need(id), rec = load(dir), picks = chatPicks(candidatesOf(dir));
    const vars = promptVars(dir, rec, settings(), { folder: 'this zip' });
    const md = [render(promptText('make-tasks'), vars, 'files')
      .replace(/## Reading it \(files\)[\s\S]*?(?=## Rules)/, '## Reading it\n\nThe transcript is below. The screenshots are in this zip, named by their time (mm:ss). Only these were included, so choose frames from them. Answer with the task list as JSON in the format below, then as a readable list.\n\n'),
    '## Transcript', '', ...linesOf(dir).map(l => `[${clock(l.at)}-${clock(l.end ?? l.at)}] ${l.text}`), '',
    '## Screenshots', '', ...picks.map(c => `- ${c.file}: ${clock(c.at)}, ${c.reasons.join(', ')}${c.words.length ? ` ("${c.words.join('", "')}")` : ''}`), ''].join('\n');
    const entries = [{ name: 'Showntask.md', data: Buffer.from(md, 'utf8') }, ...picks.map(c => ({ name: c.file, data: fs.readFileSync(path.join(dir, 'frames', c.file)) }))];
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), { title: 'Export for chat', defaultPath: path.join(app.getPath('downloads'), `Showntask ${rec.id}.zip`), filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, zip(entries));
    shell.showItemInFolder(r.filePath);
    return { file: r.filePath, frames: picks.length };
  });

  handle('settings', () => ({ settings: settings(), actions: ACTIONS, models: MODELS, speech: locate(settings()), root: root() }));
  handle('setSettings', patch => {
    const next = mend({ ...settings(), ...(patch || {}), shortcuts: { ...settings().shortcuts, ...((patch && patch.shortcuts) || {}) } });
    const clash = clashes(next.shortcuts);
    if (clash.length) throw new Error(`Two actions share a shortcut: ${clash.map(a => ACTIONS[a]).join(', ')}`);
    return setSettings(next);
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('connect', () => ({ lines: connectLines(mcpCommand().command, mcpCommand().args), command: mcpCommand() }));

  handle('record', () => recorder.toggle());
  handle('repick', () => recorder.repick());
  handle('pause', () => recorder.pause());
  handle('mark', () => recorder.mark());

  return { summary, size };
}
