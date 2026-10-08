import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Paper, COLS} from '../client/paper.ts';

const shift = (paper: Paper) => Math.max(...paper.positions.map((value, i) => Math.abs(value - paper.rest[i])));
const step = (paper: Paper, frames: number, printing = false) => { for (let i = 0; i < frames; i++) paper.step(1 / 60, printing); };
const assertPinned = (paper: Paper) => assert.deepEqual(paper.positions.slice(0, (COLS + 1) * 6), paper.rest.slice(0, (COLS + 1) * 6));

test('the loaded sheet rests without drifting and stays attached to the print head', () => {
  const paper = new Paper();
  step(paper, 180, true);
  assertPinned(paper);
  assert.ok(shift(paper) < .1);
});

test('dragging bends the sheet and releasing it lets it settle', () => {
  const paper = new Paper(), row = 30, col = 8, index = (row * (COLS + 1) + col) * 3;
  paper.grab = {row, col, target: [paper.rest[index] + .8, paper.rest[index + 1] - .3, paper.rest[index + 2] + .6]};
  step(paper, 60);
  assert.ok(shift(paper) > .2, 'a drag visibly deforms the paper');
  assertPinned(paper);
  paper.grab = null;
  step(paper, 240);
  assert.ok(shift(paper) < .1, 'the sheet settles after release');
});

test('extreme drags remain finite and above the surface; pausing can reset the sheet', () => {
  const paper = new Paper();
  for (let frame = 0; frame < 180; frame++) {
    paper.grab = {row: 45, col: 4, target: [frame % 2 ? 100 : -100, -100, 100]};
    paper.step(1 / 60, true);
  }
  assertPinned(paper);
  assert.ok(paper.positions.every(Number.isFinite));
  assert.ok(shift(paper) < 3);
  for (let i = 1; i < paper.positions.length; i += 3) assert.ok(paper.positions[i] >= .03);
  paper.reset();
  assert.deepEqual(paper.positions, paper.rest);
  assert.deepEqual(paper.previous, paper.rest);
  assert.equal(paper.grab, null);
});
