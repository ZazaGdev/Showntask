// What a recording's folder holds, read the same way by the app and the MCP server:
// the timed lines, the candidate frames, the tasks, and the prompt files filled in for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, readJson, titleOf, writeText } from './store.js';
import { clock } from './transcript.js';
import { render } from './prompts.js';

export const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
export const promptText = name => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');

export const linesOf = dir => (readJson(files(dir).json, {}) || {}).lines || [];
export const candidatesOf = dir => readJson(files(dir).candidates, []) || [];
export const tasksOf = dir => readJson(files(dir).tasks, []) || [];

// mm:ss, or h:mm:ss, of a recording's length.
export const lengthOf = rec => clock(rec.duration || ((rec.stoppedAt || rec.startedAt) - rec.startedAt) / 1000 || 0);

// The values the prompt files are filled with.
export function promptVars(dir, rec, settings = {}, extra = {}) {
  return {
    id: rec.id, title: titleOf(rec), folder: dir, length: lengthOf(rec),
    lines: String(linesOf(dir).length), candidates: String(candidatesOf(dir).length),
    sheetMax: String(settings.sheetMax || 12), framesPerTask: String(settings.framesPerTask || 3),
    ...extra,
  };
}

// MAKE-TASKS.md in the folder: the make-tasks prompt for agents that read files, not MCP.
export function writeMakeTasks(dir, rec, settings) {
  writeText(files(dir).makeTasks, render(promptText('make-tasks'), promptVars(dir, rec, settings), 'files'));
}

// The one line to paste into an agent that can read files.
export const copyLine = dir => `Read ${path.join(dir, 'MAKE-TASKS.md')} and do what it says.`;
