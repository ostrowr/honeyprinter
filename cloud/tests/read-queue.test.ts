import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeReceipt, readOne, renderReceipt} from '../scripts/read-queue.ts';
import type {Receipt} from '../shared/api.ts';

const receipt: Receipt = {schema_version: 1, type: 'receipt', receipt_id: 'receipt-1', created_at_ms: 1,
  first_event_id: 1, last_event_id: 2, summarizer: 'mock',
  counts: {probes: 2, sources: 1, first_ms: 1, last_ms: 2, services: [], outcomes: [], samples: []},
  summary: {title: 'Two knocks', body: 'Two connections.', highlights: ['ssh (2)']}};

test('queue reader decodes Cloudflare base64 JSON and strips terminal controls', () => {
  assert.deepEqual(decodeReceipt(Buffer.from(JSON.stringify(receipt)).toString('base64')), receipt);
  assert.deepEqual(decodeReceipt(JSON.stringify(receipt)), receipt);
  assert.deepEqual(decodeReceipt(receipt), receipt);
  assert.throws(() => decodeReceipt({type: 'receipt'}));
  assert.throws(() => decodeReceipt('a'.repeat(50_000)));
  const text = renderReceipt({...receipt, summary: {...receipt.summary, title: 'hello\x1b[2J\r\u202e'}});
  assert.ok(text.includes('2 probes / 1 sources'));
  assert.ok(!/[\x1b\r\u202e]/.test(text));
});

test('queue acknowledgment follows successful output and redelivery is deduplicated', async () => {
  const actions: string[] = [], seen = new Set<string>();
  const request = async <T>(action: 'pull' | 'ack', body: unknown): Promise<T> => {
    actions.push(action);
    if (action === 'pull') {
      assert.deepEqual(body, {batch_size: 1, visibility_timeout_ms: 60_000});
      return {messages: [{body: receipt, lease_id: 'lease'}]} as T;
    }
    assert.deepEqual(body, {acks: [{lease_id: 'lease'}], retries: []});
    return {} as T;
  };
  const print = async () => { actions.push('print'); };
  assert.equal(await readOne(request, print, seen), true);
  assert.deepEqual(actions, ['pull', 'print', 'ack']);
  actions.length = 0;
  assert.equal(await readOne(request, print, seen), false);
  assert.deepEqual(actions, ['pull', 'ack']);
});

test('output errors and invalid receipts remain unacknowledged; empty queues do nothing', async () => {
  for (const body of [receipt, {type: 'garbage'}]) {
    let acks = 0;
    const request = async <T>(action: 'pull' | 'ack'): Promise<T> => {
      if (action === 'ack') acks++;
      return {messages: [{body, lease_id: 'lease'}]} as T;
    };
    await assert.rejects(readOne(request, async () => { throw new Error('stdout failed'); }, new Set()));
    assert.equal(acks, 0);
  }
  assert.equal(await readOne(async <T>() => ({messages: []}) as T,
    async () => { throw new Error('Unexpected output'); }, new Set()), false);
});
