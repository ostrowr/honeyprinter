import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wrapText} from '../client/receipt.js';

test('long source addresses wrap without clipping characters at the paper edge', () => {
  const source = '2001:db8:1234:5678:90ab:cdef:1234:5678';
  const context = {measureText: text => ({width: text.length * 8})};
  const lines = wrapText(context, source, 190, 4);
  assert.equal(lines.join(''), source);
  assert.ok(lines.every(line => context.measureText(line).width <= 190));
});
