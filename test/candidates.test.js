import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changed, sceneChanges, candidates, settleShot, nearest } from '../app/lib/candidates.js';

const pic = (v, n = 100) => new Uint8Array(n).fill(v);
// A picture with the first k of 100 pixels changed.
const partly = (base, k) => { const p = pic(base); p.fill(base + 100, 0, k); return p; };

test('candidates: changed is the share of pixels that moved by more than a few levels', () => {
  assert.equal(changed(pic(10), pic(10)), 0);
  assert.equal(changed(pic(10), pic(30)), 0, '20 levels is noise');
  assert.equal(changed(pic(10), partly(10, 25)), 0.25);
});

test('candidates: a scene change is taken once the screen has settled', () => {
  const g = [pic(0), pic(0), partly(0, 50), partly(0, 60), partly(0, 60), partly(0, 60)];
  const samples = g.map((grey, i) => ({ time: i, grey }));
  // second 2 changes, second 3 still moves, second 4 is calm
  assert.deepEqual(sceneChanges(samples), [4]);
});

test('candidates: a screen that never settles still gets its scene after the wait', () => {
  const g = [pic(0), partly(0, 50), partly(0, 30), partly(0, 60), partly(0, 20), partly(0, 70)];
  assert.deepEqual(sceneChanges(g.map((grey, i) => ({ time: i, grey }))), [3]);
});

test('candidates: settleShot moves an early second to its line\'s middle', () => {
  const lines = [{ at: 10, end: 20, text: 'x' }];
  assert.equal(settleShot(11, lines), 15);
  assert.equal(settleShot(17, lines), 17);
  assert.equal(settleShot(25, lines), 25);
});

test('candidates: words, lines, clicks and markers, merged when close and alike', () => {
  const lines = [
    { at: 0, end: 10, text: 'So this button here does nothing' },
    { at: 30, end: 36, text: 'The score is wrong' },
    { at: 50, end: 54, text: 'Moving on' },
  ];
  const list = candidates({ lines, scenes: [52], clicks: [{ t: 31 }], markers: [70, 71.5, 71.8], duration: 80 });
  assert.deepEqual(list.map(c => [c.at, c.reasons]), [
    [5, ['word']], // "this" and "here" both settle to the middle of the first line
    [31.4, ['click']], // the click covers the second line, so it gets no line middle of its own
    [52, ['scene']], // the scene inside "Moving on" stands in for its middle
    [70, ['marker']], [71.5, ['marker']], // markers are not merged across seconds...
  ]); // ...but one second holds one frame, so two marks in it are one
  assert.deepEqual(list[0].words, ['this', 'here']);
});

test('candidates: close candidates with different pictures stay apart', () => {
  const pics = { 10: pic(0), 11: pic(200) };
  const list = candidates({ lines: [], scenes: [10, 11], pictureAt: t => pics[Math.floor(t)] });
  assert.equal(list.length, 2);
});

test('candidates: nearest finds the closest sample', () => {
  const s = [0, 1, 2, 3].map(time => ({ time }));
  assert.equal(nearest(s, 1.4).time, 1);
  assert.equal(nearest(s, 1.6).time, 2);
  assert.equal(nearest(s, 9).time, 3);
  assert.equal(nearest([], 1), null);
});
