import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { pieces, dropLoops, pcmOf, wavBytes, energy } from '../app/lib/chunks.js';
import { mendTasks, markFiled, tasksMd } from '../app/lib/tasks.js';
import { render } from '../app/lib/prompts.js';
import { decodePng, encodePng, tile } from '../app/lib/png.js';
import { zip, crc32 } from '../app/lib/zip.js';
import { frameName, secondsOf, nearestFrame, inSpan, chatPicks } from '../app/lib/frames.js';
import { mend, validKey, clashes, whisperLanguage, DEFAULTS } from '../app/lib/settings.js';
import { next, newRecording, imported, STEPS, nextToProcess } from '../app/lib/session.js';
import { audioConfig } from '../app/lib/mp4.js';
import { connectLines } from '../app/lib/connect.js';
import { rankUnseen } from '../app/mcp/rank.js';
import { parseWhisper, whisperArgs, transcriptMd, clock } from '../app/lib/transcript.js';
import { validId } from '../app/lib/store.js';

const DASH = String.fromCharCode(0x2014);

test('chunks: long sound is cut at the quietest moment, every piece at most 30 s', () => {
  const rate = 16000, secs = 95, pcm = new Int16Array(rate * secs);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin(i / 7));
  // pauses at 25 s and 52 s
  for (const p of [25, 52]) pcm.fill(0, p * rate, (p + 0.5) * rate);
  const list = pieces(pcm);
  assert.equal(list[0].from, 0);
  assert.equal(list.at(-1).to, pcm.length);
  for (let i = 1; i < list.length; i++) assert.equal(list[i].from, list[i - 1].to);
  for (const p of list) assert.ok(p.to - p.from <= 30 * rate);
  assert.ok(Math.abs(list[0].to / rate - 25.25) < 0.3, `first cut at ${list[0].to / rate}`);
  assert.ok(Math.abs(list[1].to / rate - 52.25) < 0.3, `second cut at ${list[1].to / rate}`);
  assert.equal(energy(new Int16Array(640)).length, 2);
});

test('chunks: a wav written and read back is the same samples', () => {
  const s = Int16Array.from([1, -2, 300, -32768, 32767]);
  assert.deepEqual([...pcmOf(wavBytes(s))], [...s]);
});

test('chunks: Whisper\'s loops keep only two of the same line', () => {
  const l = t => ({ at: 0, end: 1, text: t });
  assert.deepEqual(dropLoops([l('a'), l('b'), l('b'), l('B.'), l('b'), l('c'), l('b')]).map(x => x.text), ['a', 'b', 'b', 'c', 'b']);
});

test('transcript: a piece\'s lines are shifted back to the recording\'s time; whisper takes many wavs', () => {
  const j = { transcription: [{ offsets: { from: 1000, to: 2500 }, text: ' Hi.' }] };
  assert.deepEqual(parseWhisper(j, 60), [{ at: 61, end: 62.5, text: 'Hi.' }]);
  assert.deepEqual(whisperArgs({ model: 'm', wavs: ['a.wav', 'b.wav'], threads: 4, lang: 'en' }), ['-m', 'm', '-f', 'a.wav', '-f', 'b.wav', '-l', 'en', '-t', '4', '-oj', '-np']);
  assert.equal(transcriptMd([{ at: 3, end: 5, text: 'Hello.' }], { title: 'R', video: 'v' }), '# R\n\nVideo: v\n\n[00:03-00:05] Hello.\n');
  assert.equal(clock(3725), '1:02:05');
});

test('tasks: odd input is mended, ids kept or given, dashes and frames cleaned', () => {
  const list = mendTasks([
    { id: 't1', title: ` Fix the timer ${DASH} now. `, description: ['a', ' b '], kind: 'bug', at: 9.84, frames: [11.44, 11.44, -3, 'x', 9999], quote: 'q' },
    { title: '' },
    { id: 't1', title: 'Second', kind: 'nonsense' },
  ], { duration: 100 });
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Fix the timer, now');
  assert.equal(list[0].description, 'a\nb');
  assert.deepEqual(list[0].frames, [11.4, 0, 100]);
  assert.equal(list[0].at, 9.8);
  assert.equal(list[1].id, 't2');
  assert.equal(list[1].kind, 'change');
  assert.throws(() => mendTasks('x'), /list/);
});

test('tasks: filed stays with a task across a save, and mark_filed adds once', () => {
  let list = mendTasks([{ id: 't1', title: 'A' }]);
  list = markFiled(list, 't1', 'github', 'https://x/1');
  assert.equal(markFiled(list, 't1', 'github', 'https://x/1'), list);
  const again = mendTasks([{ id: 't1', title: 'A changed' }], { old: list });
  assert.deepEqual(again[0].filed, [{ board: 'github', url: 'https://x/1' }]);
  assert.throws(() => markFiled(list, 'nope', 'b', 'u'), /No task/);
  const md = tasksMd(list, { title: 'R' });
  assert.match(md, /## A/);
  assert.match(md, /Filed on github: https:\/\/x\/1/);
});

test('prompts: values, optional parts and the reading block for one mode', () => {
  const t = 'Hi {{name}}.\n{{#p}}Project: {{p}}\n{{/p}}<!-- mcp -->\nuse tools\n<!-- /mcp -->\n<!-- files -->\nread {{folder}}\n<!-- /files -->\nend';
  assert.equal(render(t, { name: 'A' }, 'mcp'), 'Hi A.\nuse tools\nend');
  assert.equal(render(t, { name: 'A', p: 'X', folder: 'D:\\r' }, 'files'), 'Hi A.\nProject: X\nread D:\\r\nend');
});

test('png: what is encoded decodes to the same pixels, and tiles fit their grid', () => {
  const pic = { width: 3, height: 2, rgba: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255, 50, 60, 70, 255, 200, 100, 0, 255]) };
  const back = decodePng(encodePng(pic));
  assert.deepEqual([back.width, back.height], [3, 2]);
  assert.deepEqual([...back.rgba], [...pic.rgba]);
  const sheet = tile([pic, pic, pic], { cols: 2, cell: 30, gap: 2 });
  assert.equal(sheet.width, 2 * 30 + 3 * 2);
  assert.equal(sheet.height, 2 * 20 + 3 * 2);
  assert.throws(() => decodePng(Buffer.from('nope')), /Not a PNG/);
});

test('png: rows with each filter type decode (as Chromium writes them)', () => {
  // A 2x5 RGB image, one row per filter 0-4, built by hand.
  const raw = [], prev = [0, 0, 0, 0, 0, 0], rows = [[10, 20, 30, 40, 50, 60], [11, 21, 31, 41, 51, 61], [5, 5, 5, 250, 250, 250], [100, 0, 200, 0, 100, 0], [1, 2, 3, 4, 5, 6]];
  rows.forEach((row, f) => {
    const enc = row.map((v, x) => {
      const a = x >= 3 ? row[x - 3] : 0, b = prev[x], c = x >= 3 ? prev[x - 3] : 0;
      const pred = [0, a, b, (a + b) >> 1, (() => { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })()][f];
      return (v - pred) & 0xff;
    });
    raw.push(f, ...enc);
    prev.splice(0, 6, ...row);
  });
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(5, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (k, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(k, 4); d.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
  const out = decodePng(png);
  rows.forEach((row, y) => assert.deepEqual([...out.rgba.subarray(y * 8, y * 8 + 8)], [row[0], row[1], row[2], 255, row[3], row[4], row[5], 255]));
});

test('zip: a stored zip has its entries, sizes and checksums', () => {
  const z = zip([{ name: 'a.md', data: Buffer.from('hello') }, { name: 'b.jpg', data: Buffer.from([1, 2, 3]) }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.equal(z.readUInt16LE(z.length - 12), 2);
  assert.equal(z.readUInt32LE(14), crc32(Buffer.from('hello')));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('frames: names by second, back again, nearest, and a span spread evenly', () => {
  assert.equal(frameName(252.7), '0412.jpg');
  assert.equal(frameName(3725, 'png'), '1h0205.png');
  assert.equal(secondsOf('1h0205.png'), 3725);
  assert.equal(secondsOf('0412.jpg'), 252);
  assert.equal(secondsOf('x.jpg'), null);
  const list = [0, 10, 20, 30, 40, 50].map(at => ({ at, file: frameName(at) }));
  assert.equal(nearestFrame(list, 26).at, 30);
  assert.equal(nearestFrame([], 3), null);
  assert.deepEqual(inSpan(list, 10, 40).map(c => c.at), [10, 20, 30, 40]);
  assert.deepEqual(inSpan(list, 0, 50, 3).map(c => c.at), [0, 30, 50]);
});

test('settings: a broken file mends to defaults; shortcuts checked; clashes found', () => {
  assert.deepEqual(mend(null), DEFAULTS);
  const s = mend({ shortcuts: { record: 'Control+Alt+F9', pause: 'P', nope: 'Control+X' }, model: '../evil', sheetMax: 999, deleteAfter: 'a week', mic: 'yes' });
  assert.equal(s.shortcuts.record, 'Control+Alt+F9');
  assert.equal(s.shortcuts.pause, DEFAULTS.shortcuts.pause, 'a key with no modifier is refused');
  assert.equal(s.model, DEFAULTS.model);
  assert.equal(s.sheetMax, 12);
  assert.equal(s.deleteAfter, 'a week');
  assert.equal(s.mic, true);
  assert.ok(validKey('Control+Shift+Alt+T') && validKey('') && !validKey('Alt') && !validKey('Control+Alt+Foo'));
  assert.deepEqual(clashes({ a: 'Control+Alt+K', b: 'Ctrl+Alt+K', c: '' }), ['b']);
  assert.equal(whisperLanguage('ggml-small.en-q5_1.bin', 'de'), 'en');
  assert.equal(whisperLanguage('ggml-small-q5_1.bin', 'de'), 'de');
});

test('session: stop, the steps in order, ready; a failure waits for retry; redo from a step', () => {
  let s = next(newRecording('2026-10-28-1200', 1000), { type: 'stop', at: 5000, duration: 4 });
  assert.equal(s.state, 'processing');
  assert.equal(s.duration, 4);
  s = next(s, { type: 'stepDone', step: 'audio', patch: { sound: true } });
  assert.equal(s.sound, true);
  assert.equal(next(s, { type: 'stepDone', step: 'frames' }), s, 'a step out of turn changes nothing');
  s = next(s, { type: 'stepFailed', step: 'scenes', error: 'boom' });
  assert.equal(s.state, 'failed');
  s = next(s, { type: 'retry' });
  for (const step of STEPS.slice(1)) s = next(s, { type: 'stepDone', step });
  assert.equal(s.state, 'ready');
  s = next(s, { type: 'redo', from: 'transcript' });
  assert.deepEqual([s.state, s.step, s.done], ['processing', 'transcript', ['audio', 'scenes', 'chunks']]);
  const im = imported('2026-10-28-1201', 9, 'D:\\v.mkv', 60);
  assert.deepEqual([im.state, im.step, im.imported, im.video], ['processing', 'audio', true, 'D:\\v.mkv']);
  assert.equal(nextToProcess([{ ...im, startedAt: 5 }, { ...im, id: 'b', startedAt: 2 }, { state: 'ready', startedAt: 1 }]).id, 'b');
});

test('mp4: the AAC config is found inside an esds box', () => {
  // version/flags, ES_Descriptor(3) with DecoderConfig(4) holding DecoderSpecificInfo(5) = 11 90
  const esds = Uint8Array.from([0, 0, 0, 0, 3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 0x11, 0x90, 6, 1, 2]);
  assert.deepEqual([...audioConfig(esds)], [0x11, 0x90]);
});

test('connect: each agent gets the command and --mcp', () => {
  const lines = connectLines('C:\\Program Files\\Showntask\\Showntask.exe');
  assert.equal(lines[0].text, 'claude mcp add --scope user showntask -- "C:\\Program Files\\Showntask\\Showntask.exe" --mcp');
  assert.match(lines[1].text, /\[mcp_servers\.showntask\]\ncommand = 'C:\\Program Files\\Showntask\\Showntask\.exe'\nargs = \['--mcp'\]/);
  assert.deepEqual(JSON.parse(lines[2].text).mcpServers.showntask.args, ['--mcp']);
});

test('frames unseen and for chat: marks and clicks first, in time order', () => {
  const c = (at, ...reasons) => ({ at, reasons, words: [], file: frameName(at) });
  const list = [c(1, 'line'), c(5, 'scene', 'word'), c(9, 'word'), c(12, 'marker'), c(20, 'click')];
  assert.deepEqual(rankUnseen(list, 3).map(x => x.at), [5, 9, 12]);
  assert.deepEqual(chatPicks(list, 2).map(x => x.at), [12, 20]);
});

test('store: only real recording ids pass', () => {
  assert.ok(validId('2026-10-27-2054') && validId('2026-10-27-2054-2'));
  assert.ok(!validId('..\\x') && !validId('2026-10-27') && !validId(''));
});
