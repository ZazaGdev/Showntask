// The recorder's marked area, mic level and auto-delete rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectOf, bigEnough, cropFor, onDesktop, borderBounds, barSpot, micLevel, micLit } from '../app/lib/area.js';
import { expired, KEEP_CHOICES } from '../app/lib/cleanup.js';
import { parseWhisper, clock, folderName, expandEnv } from '../app/lib/transcript.js';

test('area: the mic icon lights while the owner talks and goes dim in silence', () => {
  const tone = amp => Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 5));
  assert.equal(micLevel([]), 0);
  assert.ok(Math.abs(micLevel(tone(0.2)) - 0.2 / Math.SQRT2) < 0.01);
  assert.equal(micLit(micLevel(tone(0.001))), false);
  assert.equal(micLit(micLevel(tone(0.1))), true);
  assert.equal(micLit(0.015, true), true);
  assert.equal(micLit(0.015, false), false);
});

test('area: a drag gives the area whichever way it went, and a click is no area', () => {
  assert.deepEqual(rectOf({ x: 300, y: 200 }, { x: 100.4, y: 50 }), { x: 100, y: 50, width: 200, height: 150 });
  assert.equal(bigEnough({ x: 0, y: 0, width: 31, height: 200 }), false);
  assert.equal(bigEnough({ x: 0, y: 0, width: 32, height: 32 }), true);
  assert.equal(bigEnough(null), false);
});

test('area: the crop is in the display\'s pixels, even, and inside it', () => {
  const full = { width: 3840, height: 2160 };
  assert.deepEqual(cropFor({ x: 101, y: 51, width: 401, height: 301 }, 1.5, full), { x: 150, y: 76, width: 600, height: 450 });
  assert.deepEqual(cropFor({ x: 2500, y: 1400, width: 500, height: 500 }, 1.5, full), { x: 3750, y: 2100, width: 90, height: 60 });
});

test('area: the border sits outside the area and the bar above it, else below, else inside', () => {
  const d = { x: 1920, y: 0, width: 1920, height: 1040 }, bar = { width: 236, height: 40 };
  const r = onDesktop({ x: 100, y: 200, width: 400, height: 300 }, d);
  assert.deepEqual(borderBounds(r), { x: 2017, y: 197, width: 406, height: 306 });
  assert.deepEqual(barSpot(r, d, bar), { x: 2102, y: 152 });
  assert.deepEqual(barSpot({ x: 1920, y: 10, width: 400, height: 300 }, d, bar), { x: 2002, y: 318 });
  assert.deepEqual(barSpot({ x: 3700, y: 0, width: 140, height: 1040 }, d, bar), { x: 3604, y: 8 });
});

test('cleanup: only recordings older than the choice go, never the open one, never with never', () => {
  const H = 3600e3, NOW = Date.parse('2026-10-18T12:00:00Z');
  const rec = (id, h) => ({ id, startedAt: NOW - h * H - 60e3, stoppedAt: NOW - h * H });
  const all = [rec('a', 2), rec('b', 30), rec('c', 24 * 8), rec('d', 24 * 40)];
  assert.deepEqual(expired(all, 'never', NOW), []);
  assert.deepEqual(expired(all, '24 hours', NOW), ['b', 'c', 'd']);
  assert.deepEqual(expired(all, '24 hours', NOW, 'b'), ['c', 'd']);
  assert.deepEqual(expired(all, 'a week', NOW), ['c', 'd']);
  assert.deepEqual(KEEP_CHOICES, ['never', '24 hours', 'a week', 'a month']);
});

test('transcript: Whisper JSON to lines, clock, folder names, %VAR%', () => {
  const j = { transcription: [{ offsets: { from: 0, to: 2500 }, text: ' Okay.' }, { offsets: { from: 2500, to: 4000 }, text: ' [BLANK_AUDIO]' }] };
  assert.deepEqual(parseWhisper(j), [{ at: 0, end: 2.5, text: 'Okay.' }]);
  assert.deepEqual(parseWhisper(null), []);
  assert.equal(clock(83.9), '01:23');
  assert.equal(folderName(new Date(2026, 9, 16, 9, 30)), '2026-10-16-0930');
  assert.equal(expandEnv('%appdata%\\x', { APPDATA: 'R' }), 'R\\x');
  assert.equal(expandEnv('%NOPE%\\x', {}), '%NOPE%\\x');
});
