// Showntask's MCP server: hands recordings to the user's own agent. Read-only on
// recordings except save_tasks and mark_filed, which write tasks.json and tasks.md. It reads only
// the recordings folder, never runs commands and never calls a model. Plain Node, no Electron.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadSettings, rootOf, loadAll, dirOf, load, files, titleOf, writeJson, writeText, videoOf } from '../lib/store.js';
import { linesOf, candidatesOf, tasksOf, promptText, promptVars, lengthOf } from '../lib/recfiles.js';
import { timedLine, clock } from '../lib/transcript.js';
import { nearestFrame, inSpan, frameName } from '../lib/frames.js';
import { mendTasks, markFiled, tasksMd } from '../lib/tasks.js';
import { render } from '../lib/prompts.js';
import { decodePng, encodePng, tile } from '../lib/png.js';
import { rankUnseen } from './rank.js';

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...extra });
const fail = msg => ({ content: [{ type: 'text', text: msg }], isError: true });

export function createServer({ version = '0.1.0' } = {}) {
  const server = new McpServer({ name: 'showntask', version }, {
    instructions: 'Showntask holds the user\'s screen recordings with timed transcripts and candidate frames. To turn one into tasks, follow the make-tasks prompt (or call get_instructions). Recording ids look like 2026-10-27-2054; "latest" means the newest ready one.',
  });
  const settings = () => loadSettings();
  const root = () => rootOf(settings());

  // A recording by id or "latest": { dir, rec } or throws a message for the agent.
  function find(id) {
    const all = loadAll(root());
    const rec = !id || id === 'latest' ? all.find(r => r.state === 'ready') : all.find(r => r.id === id);
    if (!rec) throw new Error(id && id !== 'latest' ? `No recording ${id}. Call list_recordings for the ids.` : 'There are no processed recordings yet.');
    if (rec.state !== 'ready') throw new Error(`Recording ${rec.id} is not ready yet (${rec.state}${rec.step ? `: ${rec.step}` : ''}${rec.error ? `: ${rec.error}` : ''}).`);
    return { dir: dirOf(root(), rec.id), rec };
  }
  const tool = (name, config, fn) => server.registerTool(name, config, async args => {
    try { return await fn(args || {}); } catch (e) { return fail(e.message); }
  });
  const id = z.string().describe('Recording id, or "latest"');
  const span = { from: z.number().min(0).optional().describe('Start, seconds'), to: z.number().min(0).optional().describe('End, seconds') };

  const frameImage = (dir, c, width) => {
    const thumb = width && width <= 400;
    const file = path.join(dir, 'frames', thumb ? 'thumbs' : '', c.file);
    return [{ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: `${clock(c.at)} (${c.at} s), ${c.reasons.join(', ')}${c.words.length ? `, words: ${c.words.join(', ')}` : ''}. File: ${path.join(dir, 'frames', c.file)}` }];
  };
  const viewing = () => { if (!settings().viewFrames) throw new Error('Frame viewing is off in Showntask\'s settings. Use suggest_frames to pick frames without looking.'); };
  const near = (lines, t) => lines.filter(l => l.at - 3 <= t && t <= (l.end ?? l.at) + 1).map(l => l.text).join(' ');

  tool('list_recordings', {
    title: 'List recordings', description: 'The user\'s Showntask recordings, newest first: id, title, start time, length, transcript line count, task count.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), since: z.string().optional().describe('Only those started on or after this date (YYYY-MM-DD)') },
    annotations: { readOnlyHint: true },
  }, ({ limit = 20, since }) => {
    const from = since ? Date.parse(since) : 0;
    return text(loadAll(root()).filter(r => r.startedAt >= (from || 0)).slice(0, limit).map(r => {
      const dir = path.join(root(), r.id), tasks = tasksOf(dir);
      return { id: r.id, title: titleOf(r), started: new Date(r.startedAt).toISOString(), length: lengthOf(r), state: r.state, lines: linesOf(dir).length, tasks: tasks.length, filed: tasks.filter(t => (t.filed || []).length).length };
    }));
  });

  tool('get_recording', {
    title: 'Get a recording', description: 'Metadata, the timed transcript ([mm:ss-mm:ss] text lines) and the seconds of the candidate frames. On a long recording use get_transcript in spans instead.',
    inputSchema: { id }, annotations: { readOnlyHint: true },
  }, ({ id: rid }) => {
    const { dir, rec } = find(rid), lines = linesOf(dir), cands = candidatesOf(dir);
    return text([`# ${titleOf(rec)}`, '', `id: ${rec.id}`, `started: ${new Date(rec.startedAt).toISOString()}`, `length: ${lengthOf(rec)}`, `folder: ${dir}`, `video: ${videoOf(dir, rec)}`,
      `tasks saved: ${tasksOf(dir).length}`, `markers (each must become a task): ${cands.filter(c => c.reasons.includes('marker')).map(c => clock(c.at)).join(', ') || 'none'}`,
      '', '## Transcript', '', ...(lines.length ? lines.map(timedLine) : ['Nothing was said.']), '',
      '## Candidate frames (seconds)', '', cands.map(c => c.at).join(', ') || 'none'].join('\n'));
  });

  tool('get_transcript', {
    title: 'Get part of a transcript', description: 'The transcript lines between from and to (seconds).',
    inputSchema: { id, ...span }, annotations: { readOnlyHint: true },
  }, ({ id: rid, from = 0, to = Infinity }) => {
    const { dir } = find(rid);
    const lines = linesOf(dir).filter(l => (l.end ?? l.at) >= from && l.at <= to);
    return text(lines.length ? lines.map(timedLine).join('\n') : 'No lines in that span.');
  });

  tool('get_frame', {
    title: 'Get a frame', description: 'The kept frame nearest a second, as an image, with its real second.',
    inputSchema: { id, at: z.number().min(0).describe('Seconds') }, annotations: { readOnlyHint: true },
  }, ({ id: rid, at }) => {
    viewing();
    const { dir } = find(rid), c = nearestFrame(candidatesOf(dir), at);
    if (!c) throw new Error('This recording has no frames.');
    return { content: frameImage(dir, c) };
  });

  tool('get_frames', {
    title: 'Get several frames', description: 'Up to 6 frames in one call, each the kept frame nearest the second asked for. width 320 gives thumbnails, anything else the full frame.',
    inputSchema: { id, at: z.array(z.number().min(0)).min(1).max(6), width: z.number().int().optional() }, annotations: { readOnlyHint: true },
  }, ({ id: rid, at, width }) => {
    viewing();
    const { dir } = find(rid), list = candidatesOf(dir);
    const picked = [...new Map(at.map(t => nearestFrame(list, t)).filter(Boolean).map(c => [c.at, c])).values()];
    if (!picked.length) throw new Error('This recording has no frames.');
    return { content: picked.flatMap(c => frameImage(dir, c, width)) };
  });

  tool('list_candidates', {
    title: 'List candidate frames', description: 'The candidate frames in a span: second, reasons (scene, click, word, line, marker) and the words said around it.',
    inputSchema: { id, ...span }, annotations: { readOnlyHint: true },
  }, ({ id: rid, from = 0, to = Infinity }) => {
    const { dir } = find(rid), lines = linesOf(dir);
    return text(inSpan(candidatesOf(dir), from, to).map(c => ({ at: c.at, time: clock(c.at), reasons: c.reasons, words: near(lines, c.at) })));
  });

  tool('get_contact_sheet', {
    title: 'Get a contact sheet', description: 'One image tiling the span\'s candidate thumbnails (at most max, spread over the span), each labelled with its time and reason. Look at this first, then fetch the frames you keep with get_frames.',
    inputSchema: { id, ...span, max: z.number().int().min(1).max(24).optional() }, annotations: { readOnlyHint: true },
  }, ({ id: rid, from = 0, to = Infinity, max }) => {
    viewing();
    const { dir } = find(rid), list = inSpan(candidatesOf(dir), from, to, max || settings().sheetMax);
    if (!list.length) throw new Error('No candidate frames in that span. Widen it, or call list_candidates.');
    const pics = list.map(c => decodePng(fs.readFileSync(path.join(dir, 'frames', 'tiles', frameName(c.at, 'png')))));
    const png = encodePng(tile(pics, { cols: list.length <= 4 ? list.length : list.length <= 9 ? 3 : 4, cell: 320 }));
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Left to right, top to bottom: ${list.map(c => `${clock(c.at)} (${c.at} s, ${c.reasons.join('+')})`).join('; ')}` }] };
  });

  tool('suggest_frames', {
    title: 'Suggest frames without looking', description: 'The best candidates in a span ranked without looking at them (a click or scene change near a pointing word first, then a pointing word, then a line\'s middle). For agents that cannot see images.',
    inputSchema: { id, ...span, count: z.number().int().min(1).max(6).optional() }, annotations: { readOnlyHint: true },
  }, ({ id: rid, from = 0, to = Infinity, count = 3 }) => {
    const { dir } = find(rid), lines = linesOf(dir);
    return text(rankUnseen(inSpan(candidatesOf(dir), from, to), count).map(c => ({ at: c.at, time: clock(c.at), reasons: c.reasons, words: near(lines, c.at), file: path.join(dir, 'frames', c.file) })));
  });

  tool('search_transcripts', {
    title: 'Search transcripts', description: 'Lines containing every word of the query, across all recordings, with the recording id and the second.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true },
  }, ({ query, limit = 50 }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean), out = [];
    for (const r of loadAll(root())) {
      for (const l of linesOf(path.join(root(), r.id))) {
        if (words.every(w => l.text.toLowerCase().includes(w))) out.push({ id: r.id, title: titleOf(r), at: l.at, line: timedLine(l) });
        if (out.length >= limit) return text(out);
      }
    }
    return text(out.length ? out : 'No lines match.');
  });

  tool('get_tasks', {
    title: 'Get saved tasks', description: 'The tasks saved for a recording (tasks.json), with where each was filed.',
    inputSchema: { id }, annotations: { readOnlyHint: true },
  }, ({ id: rid }) => {
    const { dir } = find(rid);
    return text(tasksOf(dir).map(t => ({ ...t, frameFiles: t.frames.map(s => { const c = nearestFrame(candidatesOf(dir), s); return c ? path.join(dir, 'frames', c.file) : null; }) })));
  });

  tool('save_tasks', {
    title: 'Save tasks', description: 'Writes the task list for a recording to tasks.json and tasks.md in its folder, replacing what was there. Show the list to the user and get their agreement first.',
    inputSchema: { id, tasks: z.array(z.object({
      id: z.string().optional(), title: z.string(), description: z.string().optional(), steps: z.array(z.string()).optional(), done_when: z.string().optional(),
      kind: z.string().optional(), labels: z.array(z.string()).optional(), quote: z.string().optional(), at: z.number().optional(), frames: z.array(z.number()).optional(),
      unseen: z.boolean().optional(), filed: z.array(z.object({ board: z.string(), url: z.string() })).optional(),
    }).passthrough()) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, ({ id: rid, tasks }) => {
    const { dir, rec } = find(rid), list = mendTasks(tasks, { duration: rec.duration || Infinity, old: tasksOf(dir) });
    writeJson(files(dir).tasks, list);
    writeText(files(dir).tasksMd, tasksMd(list, { title: titleOf(rec), frameFile: s => { const c = nearestFrame(candidatesOf(dir), s); return c ? path.join(dir, 'frames', c.file) : '?'; } }));
    return text(`Saved ${list.length} tasks to ${files(dir).tasks}. Ids: ${list.map(t => t.id).join(', ')}`);
  });

  tool('mark_filed', {
    title: 'Mark a task filed', description: 'Records that a task went to a board, with the new item\'s URL, so a second run does not file it twice.',
    inputSchema: { id, task_id: z.string(), board: z.string(), url: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, ({ id: rid, task_id, board, url }) => {
    const { dir, rec } = find(rid), list = markFiled(tasksOf(dir), task_id, board, url);
    writeJson(files(dir).tasks, list);
    writeText(files(dir).tasksMd, tasksMd(list, { title: titleOf(rec) }));
    return text(`Task ${task_id} marked as filed on ${board}.`);
  });

  // The prompts also as a tool, for clients that show only tools.
  tool('get_instructions', {
    title: 'Get instructions', description: 'How to turn a recording into tasks (the make-tasks prompt), or how to file them (file-tasks with board), as text.',
    inputSchema: { id: id.optional(), which: z.enum(['make-tasks', 'file-tasks', 'summarise-recording']).optional(), board: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, ({ id: rid, which = 'make-tasks', board }) => text(promptFor(which, { recording: rid, board })));

  function promptFor(which, { recording, project, kinds, board }) {
    const { dir, rec } = find(recording);
    const s = settings(), tasks = tasksOf(dir);
    const vars = promptVars(dir, rec, s, { project: project || '', kinds: kinds || '', board: board || 'the board the user names',
      count: String(tasks.length), unfiled: String(tasks.filter(t => !(t.filed || []).some(f => !board || f.board === board)).length) });
    const name = which === 'summarise-recording' ? 'summarise' : which;
    let out = render(promptText(name), vars, 'mcp');
    if (name === 'make-tasks' && !s.viewFrames) out += '\nThe user turned frame viewing off to save tokens: pick frames with suggest_frames only, and mark each task "unseen": true.\n';
    return out;
  }
  const user = t => ({ messages: [{ role: 'user', content: { type: 'text', text: t } }] });
  const promptArg = z.string().optional().describe('Recording id, or "latest" (the default)');
  server.registerPrompt('make-tasks', {
    title: 'Make tasks from a recording', description: 'Turn a Showntask recording into tasks: read the transcript, pick frames from contact sheets, show the list, save it.',
    argsSchema: { recording: promptArg, project: z.string().optional(), kinds: z.string().optional() },
  }, ({ recording, project, kinds }) => { try { return user(promptFor('make-tasks', { recording, project, kinds })); } catch (e) { return user(e.message); } });
  server.registerPrompt('file-tasks', {
    title: 'File tasks on a board', description: 'File a recording\'s saved tasks on a board through your own connector (GitHub, Linear, Jira, Trello, Asana, Azure DevOps).',
    argsSchema: { recording: promptArg, board: z.string().optional() },
  }, ({ recording, board }) => { try { return user(promptFor('file-tasks', { recording, board })); } catch (e) { return user(e.message); } });
  server.registerPrompt('summarise-recording', {
    title: 'Summarise a recording', description: 'A short summary, the decisions and the open questions.',
    argsSchema: { recording: promptArg },
  }, ({ recording }) => { try { return user(promptFor('summarise-recording', { recording })); } catch (e) { return user(e.message); } });

  // Resources: each ready recording's files, for clients that read resources.
  const KINDS = { 'transcript.md': ['md', 'text/markdown'], 'meta.json': ['meta', 'application/json'], 'tasks.json': ['tasks', 'application/json'] };
  server.registerResource('recording-file', new ResourceTemplate('showntask://recordings/{id}/{+file}', {
    list: () => ({ resources: loadAll(root()).filter(r => r.state === 'ready').slice(0, 50).flatMap(r => {
      const dir = path.join(root(), r.id);
      return [
        { uri: `showntask://recordings/${r.id}/transcript.md`, name: `${titleOf(r)}: transcript`, mimeType: 'text/markdown' },
        { uri: `showntask://recordings/${r.id}/meta.json`, name: `${titleOf(r)}: metadata`, mimeType: 'application/json' },
        ...(fs.existsSync(files(dir).tasks) ? [{ uri: `showntask://recordings/${r.id}/tasks.json`, name: `${titleOf(r)}: tasks`, mimeType: 'application/json' }] : []),
        ...candidatesOf(dir).map(c => ({ uri: `showntask://recordings/${r.id}/frames/${c.file}`, name: `${titleOf(r)}: frame at ${clock(c.at)}`, mimeType: 'image/jpeg' })),
      ];
    }) }),
  }), { description: 'A Showntask recording\'s transcript, metadata, tasks and frames' }, (uri, vars) => {
    const { dir, rec } = find(String(vars.id)), file = String(vars.file);
    if (KINDS[file]) {
      const body = file === 'transcript.md' ? fs.readFileSync(files(dir).md, 'utf8') : file === 'tasks.json' ? JSON.stringify(tasksOf(dir), null, 2) : JSON.stringify({ ...rec, title: titleOf(rec), folder: dir }, null, 2);
      return { contents: [{ uri: uri.href, mimeType: KINDS[file][1], text: body }] };
    }
    const m = file.match(/^frames\/([\w.]+\.jpg)$/);
    if (!m || !candidatesOf(dir).some(c => c.file === m[1])) throw new Error(`No such file: ${file}`);
    return { contents: [{ uri: uri.href, mimeType: 'image/jpeg', blob: fs.readFileSync(path.join(dir, 'frames', m[1])).toString('base64') }] };
  });

  return server;
}
