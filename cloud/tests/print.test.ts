import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {layoutReceipt, receiptEscpos, receiptPreview, wrapPrintText} from '../shared/print.ts';
import type {Receipt, ReceiptSample} from '../shared/api.ts';

const sample: ReceiptSample = {id:1,received_at_ms:1,observed_at_ms:1,source:'2001:db8:1234:5678:90ab:cdef:1234:5678',
  service:'http',destination_port:80,tls:false,stage:'application',outcome:'completed',bytes_in:123,bytes_out:90,duration_ms:2,
  details:{method:'GET',path:'/.env?token=private', 'user-agent':'Example-Scanner'}};
const receipt: Receipt = {schema_version:1,type:'receipt',receipt_id:'receipt-100',created_at_ms:60_000,
  first_event_id:1,last_event_id:100,summarizer:'gpt-6-luna',
  counts:{probes:100,sources:9,first_ms:1,last_ms:59_000,services:[{service:'http',count:100}],
    ports:[{port:80,service:'http',count:94},{port:8080,service:'http',count:6}],outcomes:[],samples:[sample,{...sample,id:2}]},
  summary:{title:'HTTP requests',body:'An observed request targeted /.env.',highlights:[]}};

test('physical receipt keeps exact totals, readable columns, full IPs, and distinct bounded examples', () => {
  const lines = layoutReceipt(receipt);
  const preview = receiptPreview(lines);
  assert.ok(lines.every(line => line.text.length <= (line.large ? 24 : 48)));
  assert.match(preview,/100 CONNECTIONS \/ 9 SOURCE IPS/);
  assert.match(preview,/80 \/ HTTP +94\n/);
  assert.match(preview,/8080 \/ HTTP +6\n/);
  assert.match(preview,/SAMPLED PROBES \(1 OF 100\)/);
  assert.ok(preview.includes(sample.source));
  assert.ok(preview.includes('GET /.env'));
  assert.ok(!preview.includes('private'));
  assert.ok(preview.includes('Agent: Example-Scanner'));
  assert.ok(preview.includes('123 bytes in / 90 out / 2 ms'));
  const long = '/' + 'long-path'.repeat(25);
  assert.equal(wrapPrintText(long).join(''),long);
  const old = structuredClone(receipt);
  delete old.counts.ports; delete old.counts.samples[0].details;
  assert.doesNotThrow(() => layoutReceipt(old));
});

test('untrusted text cannot inject ESC/POS commands or terminal controls', () => {
  const hostile = structuredClone(receipt);
  hostile.summary.body = 'Before\x1dV\x00\x1b@\x1bp\x00\u202eafter';
  hostile.counts.samples[0].details = {client_banner:'SSH-2.0-evil\x1b@\x1dV\x00'};
  const lines = layoutReceipt(hostile);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(lines.map(line=>line.text).join('')));
  const encoded = Buffer.from(receiptEscpos(lines));
  assert.equal(encoded.indexOf(Buffer.from([0x1b,0x40])),0);
  assert.equal(encoded.indexOf(Buffer.from([0x1b,0x40]),2),-1,'only our initial reset');
  assert.equal(encoded.indexOf(Buffer.from([0x1b,0x70])),-1,'no cash drawer pulse');
  assert.deepEqual([...encoded.subarray(-3)],[0x1d,0x56,1]);
  assert.equal(encoded.indexOf(Buffer.from([0x1d,0x56])),encoded.length-3,'one final cut only');
  const direct = Buffer.from(receiptEscpos([{text:'untrusted\x1b@text'}]));
  assert.equal(direct.indexOf(Buffer.from([0x1b,0x40]),2),-1,'device boundary sanitizes too');
});

test('one-shot CLI defaults to preview without invoking CUPS or the network', () => {
  const dir = mkdtempSync(join(tmpdir(),'honeyprinter-print-test-'));
  try {
    const path = join(dir,'receipt.json');
    writeFileSync(path,JSON.stringify(receipt));
    const text = execFileSync(process.execPath,['scripts/print-receipt.ts','--file',path],
      {cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,PATH:''},timeout:5000});
    assert.match(text,/HONEYPRINTER/);
    assert.match(text,/GET \/\.env/);
    assert.throws(() => execFileSync(process.execPath,['scripts/print-receipt.ts','--file',path,'--latest'],
      {cwd:new URL('..',import.meta.url),stdio:'pipe',timeout:5000}),/Choose exactly one/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
