// Spike: candidate counts from saved samples and a Whisper transcript.
// node test/spike/cands.mjs <dir with secs.json, secs.bin, transcript.json> [scene] [settled]
import fs from 'node:fs';
import path from 'node:path';
import { sceneChanges, candidates, nearest } from '../../app/lib/candidates.js';
import { parseWhisper } from '../../app/lib/transcript.js';

const dir = process.argv[2], scene = Number(process.argv[3] || 0.04), settled = Number(process.argv[4] || 0.01);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'secs.json'), 'utf8')), bin = fs.readFileSync(path.join(dir, 'secs.bin'));
const px = meta.sw * meta.sh;
const samples = meta.times.map((time, i) => ({ time, grey: bin.subarray(i * px, (i + 1) * px) }));
let lines = [];
try { lines = parseWhisper(JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'))); } catch { /* none yet */ }
const t0 = Date.now();
const scenes = sceneChanges(samples, { scene, settled });
const list = candidates({ lines, scenes, duration: meta.times.at(-1), pictureAt: t => nearest(samples, t)?.grey });
const by = {};
for (const c of list) by[c.reasons[0]] = (by[c.reasons[0]] || 0) + 1;
const mins = meta.times.at(-1) / 60;
console.log({ dir, minutes: Math.round(mins), lines: lines.length, scenes: scenes.length, candidates: list.length, perMin: +(list.length / mins).toFixed(1), by, ms: Date.now() - t0 });
if (process.argv[5]) fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify(list));
