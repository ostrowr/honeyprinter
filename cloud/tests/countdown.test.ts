import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportCountdown} from '../client/countdown.ts';

const minute = 1_800_000;
test('countdown reaches zero without promising a report before cron delivers it', () => {
  assert.equal(reportCountdown(minute, minute, true).value, '01:00');
  assert.equal(reportCountdown(minute + 49_001, minute, true).value, '00:11');
  assert.equal(reportCountdown(minute + 59_999, minute, true).value, '00:01');
  assert.equal(reportCountdown(minute + 60_000, minute, true).phase, 'preparing');
  assert.equal(reportCountdown(minute + 100_000, minute, true).phase, 'preparing');
  assert.equal(reportCountdown(minute + 100_000, minute + 60_000, true).value, '00:20');
});

test('empty feeds and outages have an honest state; late reports do not restart a false countdown', () => {
  assert.equal(reportCountdown(minute, undefined, false).phase, 'connecting');
  assert.equal(reportCountdown(minute, undefined, true).phase, 'preparing');
  assert.equal(reportCountdown(minute, minute - 120_000, true).phase, 'preparing');
  assert.equal(reportCountdown(minute + 5_000, minute, false).phase, 'offline');
  assert.equal(reportCountdown(minute + 5_000, minute, true).seconds, 55);
});
