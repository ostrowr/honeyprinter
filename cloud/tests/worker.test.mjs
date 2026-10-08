import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {randomUUID} from 'node:crypto';

let mf, db;
const base = 'https://example.com/honeyprinter';
const probe = (changes = {}) => ({schema_version:1,type:'probe',event_id:randomUUID(),observed_at_ms:Date.now(),source_ip:'203.0.113.17',source_port:42133,destination_port:22,service:'ssh',tls:false,stage:'application',outcome:'completed',duration_ms:3,bytes_in:12,bytes_out:20,details:{client_banner:'SSH-2.0-example'},...changes});
const send = p => mf.dispatchFetch(`${base}/api/probes`, {method:'POST',headers:{Authorization:'Bearer testing', 'Content-Type':'application/json'},body:JSON.stringify(p)});
const get = async path => (await mf.dispatchFetch(`${base}${path}`)).json();
const tick = fail => mf.dispatchFetch(`https://example.com/__test/tick${fail ? '?fail=1' : ''}`);

before(async () => {
  const {outputFiles} = await build({stdin:{contents:`import worker, {tick} from './src/index.ts';
    export default {async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__test/tick') {
        try { await tick({...env, SUMMARY_MODE: new URL(request.url).searchParams.get('mode') || env.SUMMARY_MODE, PRINT_QUEUE: {async send(body) {
          if (new URL(request.url).searchParams.has('fail')) throw new Error('queue offline');
          await env.DB.prepare('INSERT INTO delivered(payload) VALUES (?)').bind(JSON.stringify(body)).run();
        }}}); return new Response('ok'); } catch { return new Response('failed', {status:503}); }
      } return worker.fetch(request, env, ctx);
    }};`, resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral'});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'test-db'},bindings:{INGEST_TOKEN:'testing',SUMMARY_MODE:'mock',OPENAI_MODEL:'gpt-6-luna',RETENTION_DAYS:'7'},serviceBindings:{ASSETS:()=>new Response('<html>test</html>')}}));
  db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  for (const sql of migration.replace(/--[^\n]*/g,'').split(';').filter(s=>s.trim())) await db.prepare(sql).run();
  await db.exec('CREATE TABLE delivered(id INTEGER PRIMARY KEY, payload TEXT)');
});
after(async () => mf?.dispose());

test('authentication, strict validation, bounded bodies and deduplication', async () => {
  const unauthorized = await mf.dispatchFetch(`${base}/api/probes`, {method:'POST'});
  assert.equal(unauthorized.status,401);
  assert.equal((await send(probe({source_port:-1}))).status,400);
  assert.equal((await send(probe({details:{secret:'a'.repeat(262145)}}))).status,413);
  const p=probe();
  assert.equal((await send(p)).status,201);
  assert.equal((await send(p)).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM events').first()).n,1);
  assert.equal((await mf.dispatchFetch(`${base}/api/events?after=-1`)).status,400);
  assert.equal((await mf.dispatchFetch(`${base}/api/events?after=1%20OR%201=1`)).status,400);
});

test('cursor pagination survives identical times, masks IPs and excludes payload metadata', async () => {
  for(let i=0;i<105;i++) assert.equal((await send(probe({observed_at_ms:1700000000000}))).status,201);
  let first=await get('/api/events?after=0');
  assert.equal(first.items.length,100); assert.equal(first.has_more,true);
  assert.equal(first.items[0].source,'203.0.113.×');
  assert.equal(first.items[0].details,undefined);
  const second=await get(`/api/events?after=${first.cursor}`);
  assert.equal(second.items.length,6); assert.equal(second.has_more,false);
  assert.ok(second.items[0].id>first.cursor);
  assert.equal((await get('/api/events')).items.length,100);
});

test('queue failure retains a committed receipt; concurrent ticks never duplicate the summary', async () => {
  assert.equal((await tick(true)).status,503);
  const pending=await db.prepare('SELECT * FROM receipts').first();
  assert.equal(pending.probe_count,106); assert.equal(pending.enqueued_at_ms,null);
  const receipt=JSON.parse(pending.payload);
  assert.equal(receipt.counts.probes,106); assert.equal(receipt.counts.samples.length,8);
  assert.equal(receipt.counts.services[0].count,106);
  await Promise.all([tick(),tick(),tick()]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM receipts').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM delivered').first()).n,1);
  assert.notEqual((await db.prepare('SELECT enqueued_at_ms FROM receipts').first()).enqueued_at_ms,null);
  await send(probe()); await tick();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM receipts').first()).n,1, 'enforce minute limit');
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0');
  await Promise.all([tick(),tick()]);
  const last = (await get('/api/receipts')).items.at(-1);
  assert.equal(last.counts.probes,1);
});

test('empty ticks do not create receipts and retention preserves unsummarized events', async () => {
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0');
  const before=(await db.prepare('SELECT COUNT(*) AS n FROM receipts').first()).n;
  await tick();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM receipts').first()).n,before);
  await db.exec('UPDATE events SET received_at_ms = 0');
  await tick();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM events').first()).n,0);
  assert.equal((await send(probe())).status,201);
  const feed=await get('/api/events?after=0');
  assert.ok(feed.cursor > 106, 'autoincrement cursor is not reused after cleanup');
});

test('assets are served beneath the route and carry a restrictive CSP', async () => {
  const response=await mf.dispatchFetch(`${base}/`);
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/);
  assert.equal((await mf.dispatchFetch(`${base}-other`)).status,404);
});

test('summary failure releases the lease without advancing or losing events', async () => {
  const before=await db.prepare('SELECT last_event_id FROM summary_state').first();
  const failed=await mf.dispatchFetch('https://example.com/__test/tick?mode=openai');
  assert.equal(failed.status,503);
  const state=await db.prepare('SELECT * FROM summary_state').first();
  assert.equal(state.last_event_id,before.last_event_id);
  assert.equal(state.lease_token,null);
  assert.equal((await tick()).status,200);
  assert.equal((await get('/api/receipts')).items.at(-1).counts.probes,1);
});

test('batch ingestion validates atomically and deduplicates individual UUIDs', async () => {
  const batch = events => ({schema_version:1,type:'probe_batch',events});
  const events = Array.from({length:300}, () => probe());
  const first = await send(batch(events));
  assert.equal(first.status,201);
  assert.deepEqual(await first.json(),{accepted:300,duplicates:0});
  const replay = await send(batch(events));
  assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),{accepted:0,duplicates:300});
  const same=probe();
  assert.deepEqual(await (await send(batch([same,same]))).json(),{accepted:1,duplicates:1});
  const before = await db.prepare('SELECT COUNT(*) AS n FROM events').first();
  assert.equal((await send(batch([probe(),probe({source_port:-1})]))).status,400);
  assert.equal((await send(batch([]))).status,400);
  assert.equal((await send(batch(Array.from({length:1001},()=>({}))))).status,400);
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM events').first(),before);
  const last = await db.prepare('SELECT payload FROM events ORDER BY id DESC LIMIT 1').first();
  assert.equal(JSON.parse(last.payload).event_id,same.event_id);
});
