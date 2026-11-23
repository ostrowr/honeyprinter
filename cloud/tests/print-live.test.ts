import {test} from 'node:test';
import assert from 'node:assert/strict';
import {printFresh, type PrintState} from '../scripts/print-live.ts';
import type {Feed, ReceiptRecord} from '../shared/api.ts';

const receipt = (id: number, created_at_ms = 100_000): ReceiptRecord => ({id,schema_version:1,type:'receipt',
  receipt_id:`receipt-${id}`,created_at_ms,first_event_id:id,last_event_id:id,summarizer:'gpt-6-luna',
  counts:{probes:1,sources:1,first_ms:created_at_ms,last_ms:created_at_ms,services:[],samples:[],outcomes:[]},
  summary:{title:'Report',body:'One connection.',highlights:[]}});
const feed = (...items: ReceiptRecord[]): Feed<ReceiptRecord> => ({items,server_time_ms:100_000,cursor:items.at(-1)?.id ?? 0,has_more:false,mode:'openai'});
function harness() {
  let state: PrintState | undefined;
  let busy = false, fail = false;
  const submitted: string[] = [];
  return {
    submitted, get state() { return state; },
    set busy(value: boolean) { busy=value; }, set fail(value: boolean) { fail=value; },
    printer: {
      async busy() { return busy; },
      async reserve(value: PrintState) { state=value; },
      async submit(r: ReceiptRecord) {
        assert.equal(state?.receiptId,r.receipt_id,'reserve before touching the printer');
        if (fail) throw new Error('CUPS unavailable');
        submitted.push(r.receipt_id);
      },
    },
  };
}

test('prints only the newest report and persists the minute limit and deduplication across restarts', async () => {
  const h=harness();
  assert.equal(await printFresh(feed(receipt(1),receipt(2)),undefined,h.printer,100_000),true);
  assert.deepEqual(h.submitted,['receipt-2']);
  const restarted=JSON.parse(JSON.stringify(h.state)) as PrintState;
  assert.equal(await printFresh(feed(receipt(3)),restarted,h.printer,159_999),false);
  assert.equal(await printFresh(feed(receipt(2)),restarted,h.printer,160_000),false);
  assert.equal(await printFresh(feed(receipt(3)),restarted,h.printer,160_000),true);
  assert.deepEqual(h.submitted,['receipt-2','receipt-3']);
});

test('quiet reports print; stale feeds and busy printers never build up a backlog', async () => {
  const h=harness();
  const quiet=receipt(5); quiet.summarizer='quiet'; quiet.counts.probes=0;
  assert.equal(await printFresh({...feed(receipt(1)),server_time_ms:300_000},undefined,h.printer),false);
  assert.equal(await printFresh(feed(),undefined,h.printer),false);
  h.busy=true;
  assert.equal(await printFresh(feed(quiet),undefined,h.printer),false);
  assert.equal(h.state,undefined);
  h.busy=false;
  assert.equal(await printFresh(feed(quiet),undefined,h.printer),true);
  assert.deepEqual(h.submitted,['receipt-5']);
});

test('an ambiguous or failed submission is not reprinted or retried rapidly', async () => {
  const h=harness(); h.fail=true;
  await assert.rejects(printFresh(feed(receipt(1)),undefined,h.printer,100_000),/CUPS unavailable/);
  h.fail=false;
  assert.equal(await printFresh(feed(receipt(1)),h.state,h.printer,200_000),false);
  assert.equal(await printFresh(feed(receipt(2)),h.state,h.printer,159_999),false);
  assert.equal(await printFresh(feed(receipt(2)),h.state,h.printer,160_000),true);
});
