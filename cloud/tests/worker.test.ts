import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {randomUUID} from 'node:crypto';
import type {Feed, FeedItems, Probe, Receipt} from '../shared/api.ts';

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;

async function first<Row>(sql: string): Promise<Row> {
  const row = await db.prepare(sql).first<Row>();
  assert.ok(row, `Expected a row for: ${sql}`);
  return row;
}
const count = async (table: 'events' | 'receipts' | 'delivered') => (await first<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)).n;
const base = 'https://example.com/honeyprinter';
const probe = (changes: Partial<Probe> = {}): Probe => ({schema_version:1,type:'probe',event_id:randomUUID(),observed_at_ms:Date.now(),source_ip:'203.0.113.17',source_port:42133,destination_port:22,service:'ssh',tls:false,stage:'application',outcome:'completed',duration_ms:3,bytes_in:12,bytes_out:20,details:{client_banner:'SSH-2.0-example'},...changes});
const send = (p: unknown) => mf.dispatchFetch(`${base}/api/probes`, {method:'POST',headers:{Authorization:'Bearer testing', 'Content-Type':'application/json'},body:JSON.stringify(p)});
const get = async <K extends keyof FeedItems>(name: K, query = ''): Promise<Feed<FeedItems[K]>> =>
  (await mf.dispatchFetch(`${base}/api/${name}${query}`)).json() as Promise<Feed<FeedItems[K]>>;
const tick = (fail = false, time?: number) => mf.dispatchFetch(`https://example.com/__test/tick?fail=${fail ? 1 : 0}${time === undefined ? '' : `&time=${time}`}`);

before(async () => {
  const {outputFiles} = await build({entryPoints: ['tests/fixtures/worker.ts'], bundle:true, write:false, format:'esm', platform:'neutral'});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'test-db'},bindings:{INGEST_TOKEN:'testing',SUMMARY_MODE:'mock',OPENAI_MODEL:'gpt-6-luna',RETENTION_DAYS:'7'},serviceBindings:{ASSETS:()=>new Response('<html>test</html>')}}));
  db = await mf.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(file, directory), 'utf8');
    for (const sql of migration.replace(/--[^\n]*/g,'').split(';').filter(s=>s.trim())) await db.prepare(sql).run();
  }
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
  assert.equal(await count('events'),1);
  assert.equal((await mf.dispatchFetch(`${base}/api/events?after=-1`)).status,400);
  assert.equal((await mf.dispatchFetch(`${base}/api/events?after=1%20OR%201=1`)).status,400);
});

test('cursor pagination survives identical times, preserves IPv4/IPv6 addresses and excludes payload metadata', async () => {
  for(let i=0;i<105;i++) assert.equal((await send(probe({observed_at_ms:1700000000000,source_ip:i===0?'2001:db8:1234:5678:90ab:cdef:1234:5678':'203.0.113.17'}))).status,201);
  let first=await get('events', '?after=0');
  assert.equal(first.items.length,100); assert.equal(first.has_more,true);
  assert.equal(first.items[0].source,'203.0.113.17');
  assert.equal(first.items[1].source,'2001:db8:1234:5678:90ab:cdef:1234:5678');
  assert.equal('details' in first.items[0],false);
  const second=await get('events', `?after=${first.cursor}`);
  assert.equal(second.items.length,6); assert.equal(second.has_more,false);
  assert.ok(second.items[0].id>first.cursor);
  assert.equal((await get('events')).items.length,100);
});

test('queue failure retains a committed receipt; concurrent ticks never duplicate the summary', async () => {
  assert.equal((await tick(true)).status,503);
  const pending=await first<{probe_count: number; enqueued_at_ms: number | null; payload: string}>('SELECT * FROM receipts');
  assert.equal(pending.probe_count,106); assert.equal(pending.enqueued_at_ms,null);
  const receipt=JSON.parse(pending.payload) as Receipt;
  assert.equal(receipt.counts.probes,106); assert.equal(receipt.counts.samples.length,8);
  assert.equal(receipt.counts.services[0].count,106);
  assert.equal(receipt.counts.samples[0].source,'203.0.113.17');
  assert.equal(receipt.counts.samples[1].source,'2001:db8:1234:5678:90ab:cdef:1234:5678');
  await Promise.all([tick(),tick(),tick()]);
  assert.equal(await count('receipts'),1);
  assert.equal(await count('delivered'),1);
  assert.notEqual((await first<{enqueued_at_ms: number | null}>('SELECT enqueued_at_ms FROM receipts')).enqueued_at_ms,null);
  await send(probe()); await tick();
  assert.equal(await count('receipts'),1, 'enforce minute limit');
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0');
  await Promise.all([tick(),tick()]);
  const last = (await get('receipts')).items.at(-1);
  assert.ok(last);
  assert.equal(last.counts.probes,1);
});

test('quiet minutes create page reports without print jobs or cursor advancement', async () => {
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const before = await count('receipts'), delivered = await count('delivered');
  const cursor = (await first<{last_event_id: number}>('SELECT last_event_id FROM summary_state')).last_event_id;
  assert.equal((await tick(false, minute + 60_000)).status, 200);
  assert.equal(await count('receipts'), before + 1);
  const quiet = (await get('receipts')).items.at(-1)!;
  assert.equal(quiet.summarizer, 'quiet');
  assert.equal(quiet.counts.probes, 0);
  assert.equal(quiet.counts.sources, 0);
  assert.deepEqual(quiet.counts.services, []);
  assert.match(quiet.summary.body, /No new connections/);
  assert.equal(quiet.first_event_id, cursor);
  assert.equal(quiet.last_event_id, cursor);
  assert.equal((await first<{last_event_id: number}>('SELECT last_event_id FROM summary_state')).last_event_id, cursor);
  await Promise.all([tick(false, minute + 60_000), tick(false, minute + 60_001)]);
  assert.equal(await count('receipts'), before + 1);
  assert.equal(await count('delivered'), delivered);
  await db.exec('UPDATE events SET received_at_ms = 0');
  await tick(false, minute + 120_000);
  assert.equal(await count('events'), 0);
  assert.equal(await count('receipts'), before + 2);
  assert.equal(await count('delivered'), delivered);
  assert.notEqual((await get('receipts')).items.at(-1)?.receipt_id, quiet.receipt_id);
  assert.equal((await send(probe())).status, 201);
  const feed = await get('events', '?after=0');
  assert.ok(feed.cursor > 106, 'autoincrement cursor is not reused after cleanup');
  // Return the synthetic clock to the present for the remaining scenarios.
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0');
});

test('assets are served beneath the route and carry a restrictive CSP', async () => {
  const response=await mf.dispatchFetch(`${base}/`);
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Security-Policy') ?? '',/script-src 'self'/);
  assert.equal((await mf.dispatchFetch(`${base}-other`)).status,404);
});

test('summary failure releases the lease without advancing or losing events', async () => {
  const before=await first<{last_event_id: number}>('SELECT last_event_id FROM summary_state');
  const failed=await mf.dispatchFetch('https://example.com/__test/tick?mode=openai');
  assert.equal(failed.status,503);
  const state=await first<{last_event_id: number; lease_token: string | null}>('SELECT * FROM summary_state');
  assert.equal(state.last_event_id,before.last_event_id);
  assert.equal(state.lease_token,null);
  assert.equal((await tick()).status,200);
  assert.equal((await get('receipts')).items.at(-1)?.counts.probes,1);
});

test('batch ingestion validates atomically and deduplicates individual UUIDs', async () => {
  const batch = (events: unknown[]) => ({schema_version:1,type:'probe_batch',events});
  const events = Array.from({length:300}, () => probe());
  const response = await send(batch(events));
  assert.equal(response.status,201);
  assert.deepEqual(await response.json(),{accepted:300,duplicates:0});
  const replay = await send(batch(events));
  assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),{accepted:0,duplicates:300});
  const same=probe();
  assert.deepEqual(await (await send(batch([same,same]))).json(),{accepted:1,duplicates:1});
  const before = await count('events');
  assert.equal((await send(batch([probe(),probe({source_port:-1})]))).status,400);
  assert.equal((await send(batch([]))).status,400);
  assert.equal((await send(batch(Array.from({length:1001},()=>({}))))).status,400);
  assert.deepEqual(await count('events'),before);
  const last = await first<{payload: string}>('SELECT payload FROM events ORDER BY id DESC LIMIT 1');
  assert.equal(JSON.parse(last.payload).event_id,same.event_id);
});


test('Rust HTTP metadata survives ingestion in mixed protocol batches', async () => {
  const details = {method:'GET',path:'/.env',host:'honeyprinter.test','user-agent':'honeyprinter-probe/1'};
  const events = [
    probe({service:'http',destination_port:80,details}),
    probe({service:'https',destination_port:443,tls:true,details:{...details,tls_version:'TLSv1_3'}}),
    probe({service:'redis',destination_port:6379,details:{command:'PING'}}),
  ];
  const before = await count('events');
  const response = await send({schema_version:1,type:'probe_batch',events});
  assert.equal(response.status,201);
  assert.deepEqual(await response.json(),{accepted:3,duplicates:0});
  assert.equal(await count('events'),before+3);
  for (const event of events) {
    const stored = await db.prepare('SELECT payload FROM events WHERE event_id = ?').bind(event.event_id).first<{payload:string}>();
    assert.ok(stored);
    assert.deepEqual(JSON.parse(stored.payload).details,event.details);
  }
  assert.equal((await send(probe({details:{'invalid key':'value'}}))).status,400);
  assert.equal((await send(probe({details:{['x'.repeat(41)]:'value'}}))).status,400);
});

test('cron jitter does not skip an active minute; repeated and older triggers do not duplicate it', async () => {
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0');
  await tick();
  const before = await count('receipts');
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  // Match the old production state: a receipt generated late in the prior minute.
  await db.prepare('UPDATE summary_state SET last_receipt_ms = ?').bind(minute - 20_000).run();
  await send(probe());
  const scheduled = (time: number) => mf.dispatchFetch(`https://example.com/__test/tick?time=${time}`);
  assert.equal((await scheduled(minute + 39_999)).status, 200);
  assert.equal(await count('receipts'), before + 1, '59,999 ms apart still represents consecutive scheduled minutes');
  assert.equal((await get('receipts')).items.at(-1)?.counts.probes, 1);
  assert.equal((await first<{last_receipt_ms: number}>('SELECT last_receipt_ms FROM summary_state')).last_receipt_ms, minute);
  await send(probe());
  await Promise.all([scheduled(minute + 59_000), scheduled(minute), scheduled(minute - 60_000)]);
  assert.equal(await count('receipts'), before + 1, 'one receipt per scheduled minute');
  await scheduled(minute + 60_000);
  assert.equal(await count('receipts'), before + 2);
  assert.equal((await get('receipts')).items.at(-1)?.counts.probes, 1);
});

test('an empty installation prints quiet page reports without an API key and expires old quiet reports', async () => {
  await db.exec('DELETE FROM events');
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0, last_event_id = 0');
  const minute = (Math.floor(Date.now() / 60_000) + 5) * 60_000;
  const delivered = await count('delivered');
  const response = await mf.dispatchFetch(`https://example.com/__test/tick?mode=openai&time=${minute}`);
  assert.equal(response.status, 200, 'a quiet report needs no OpenAI key or call');
  const quiet = (await get('receipts')).items.at(-1)!;
  assert.equal(quiet.summarizer, 'quiet');
  assert.equal(quiet.first_event_id, 0);
  assert.equal(quiet.last_event_id, 0);
  assert.equal(quiet.counts.last_ms - quiet.counts.first_ms, 60_000);
  assert.equal(await count('delivered'), delivered);
  await db.exec('UPDATE receipts SET created_at_ms = 0');
  await tick(false, minute + 60_000);
  assert.equal((await first<{n: number}>('SELECT COUNT(*) AS n FROM receipts WHERE created_at_ms = 0 AND probe_count = 0')).n, 0);
  assert.equal(await count('delivered'), delivered);
});
