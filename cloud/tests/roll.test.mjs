import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PaperRoll, PAGE_HEIGHT} from '../client/roll.js';

const receipt = id => ({id});
test('back retracts the existing strip and next feeds it forward without adding copies', () => {
  const roll = new PaperRoll();
  roll.select(receipt(1), 1, false);
  roll.select(receipt(2), 1, false);
  const start = roll.position;
  roll.select(receipt(1), -1);
  assert.equal(roll.direction, -1);
  assert.equal(roll.position, start);
  roll.advance(.5);
  assert.equal(roll.position, start - .5);
  roll.select(receipt(2), 1);
  assert.equal(roll.direction, 1, 'next reverses an in-progress retraction');
  roll.advance(100);
  assert.equal(roll.position, 2 * PAGE_HEIGHT);
  assert.equal(roll.pages.length, 2);
});

test('an older receipt outside the strip is inserted without replacing visible print', () => {
  const roll = new PaperRoll();
  roll.select(receipt(4), 1, false);
  roll.select(receipt(3), -1);
  assert.deepEqual(roll.pages.map(page => page.id), [3, 4]);
  assert.equal(roll.position, 2 * PAGE_HEIGHT, 'the currently visible receipt stays at the head');
  assert.equal(roll.target, PAGE_HEIGHT);
  assert.equal(roll.direction, -1);
  roll.advance(.3);
  const offset = roll.position - roll.target;
  roll.select(receipt(2), -1);
  assert.equal(roll.position - 2 * PAGE_HEIGHT, offset, 'rapid navigation preserves the moving texture');
  assert.equal(roll.direction, -1);
});

test('manual feed replays the selected receipt, then back still retracts', () => {
  const roll = new PaperRoll();
  roll.select(receipt(1), 1, false);
  roll.select(receipt(2), 1, false);
  roll.select(receipt(1), -1, false);
  roll.replay();
  assert.equal(roll.pages.at(-1).id, 1);
  assert.equal(roll.direction, 1);
  roll.settle();
  roll.select(receipt(0), -1);
  assert.equal(roll.direction, -1);
});

test('the roll stays bounded across long history and reduced-motion selections settle', () => {
  const roll = new PaperRoll();
  for (let id = 1; id <= 100; id++) roll.select(receipt(id), 1, false);
  for (let id = 99; id >= 1; id--) {
    roll.select(receipt(id), -1);
    assert.equal(roll.direction, -1);
    assert.ok(roll.pages.length <= 8);
    roll.settle();
    assert.equal(roll.direction, 0);
    assert.equal(roll.pages[roll.selected].id, id);
  }
  roll.select(receipt(2), 1, false);
  assert.equal(roll.position, roll.target);
});
