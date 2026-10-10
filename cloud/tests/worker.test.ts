import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {randomUUID} from 'node:crypto';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {ACCESS_ISSUER, SITE_ORIGIN, API_ORIGIN} from '../shared/urls.ts';
import type {Activity, Feed, FeedItems, Probe, Receipt} from '../shared/api.ts';

const accessKey = await generateKeyPair('RS256');
const publicKey = {...await exportJWK(accessKey.publicKey),kid:'test',alg:'RS256'};
const accessToken = (changes: {email?:string;issuer?:string;audience?:string;expires?:string} = {}) => new SignJWT({email:changes.email ?? 'ostrowr@gmail.com'})
  .setProtectedHeader({alg:'RS256',kid:'test'}).setIssuedAt().setExpirationTime(changes.expires ?? '1h')
  .setIssuer(changes.issuer ?? ACCESS_ISSUER).setAudience(changes.audience ?? 'test-aud').sign(accessKey.privateKey);
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
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'test-db'},bindings:{INGEST_TOKEN:'testing',SUMMARY_MODE:'mock',OPENAI_MODEL:'gpt-6-luna',RETENTION_DAYS:'7',ACCESS_AUD:'test-aud',ACCESS_EMAIL:'ostrowr@gmail.com'},serviceBindings:{ASSETS:request=>new Response('<html>test</html>',{headers:{'X-Test-Asset-Path':new URL(request.url).pathname}})},outboundService:request=>{ if(request.url !== `${ACCESS_ISSUER}/cdn-cgi/access/certs`) throw new Error('Unexpected outbound request'); return Response.json({keys:[publicKey]}); }}));
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


test('24-hour activity counts all probes by port, expires old minutes and avoids recounting retries', async () => {
  await db.exec('DELETE FROM events');
  await db.exec('DELETE FROM activity_minutes');
  await db.exec('UPDATE summary_state SET last_receipt_ms = 0, last_event_id = 0, activity_last_event_id = 0, activity_json = NULL');
  const read = async (): Promise<Activity> => (await mf.dispatchFetch(`${base}/api/activity`)).json() as Promise<Activity>;
  assert.equal((await read()).generated_at_ms, 0);
  const minute = Math.floor(Date.now() / 60_000) * 60_000, from = minute - 86_400_000;
  const insertAt = async (received: number, events: Probe[]) => {
    const before = (await first<{id: number | null}>('SELECT MAX(id) AS id FROM events')).id ?? 0;
    const batch = {schema_version:1,type:'probe_batch',events};
    await send(batch); await send(batch); // Repeated uploads must not affect totals.
    await db.prepare('UPDATE events SET received_at_ms = ? WHERE id > ?').bind(received, before).run();
  };
  await insertAt(from - 1, [probe({destination_port:23,service:'telnet'})]);
  await insertAt(from, [probe({destination_port:80,service:'http'})]);
  await insertAt(minute - 120_000, Array.from({length:125}, () => probe({destination_port:22,service:'ssh'})));
  await insertAt(minute - 60_000, [probe({destination_port:443,service:'https',outcome:'timeout'}),probe({destination_port:8443,service:'https'})]);
  await insertAt(minute, [probe({destination_port:6379,service:'redis'})]);
  // Simulate upgrading an existing installation: the old Worker has consumed
  // most events, including some after the migration, but totals start at zero.
  await db.exec('UPDATE summary_state SET last_event_id = (SELECT MAX(id) - 2 FROM events)');
  assert.equal((await tick(false, minute)).status, 200);
  const activity = await read();
  assert.equal(activity.probes, 128, 'includes rows beyond the 100-event browser log');
  assert.equal(activity.from_ms, from); assert.equal(activity.to_ms, minute);
  assert.deepEqual(activity.ports, [
    {port:22,service:'ssh',probes:125}, {port:80,service:'http',probes:1},
    {port:443,service:'https',probes:1}, {port:8443,service:'https',probes:1},
  ]);
  assert.equal(activity.hours.length, 24);
  assert.equal(activity.hours[0].probes, 1);
  assert.equal(activity.hours[23].probes, 127);
  assert.equal(activity.hours.reduce((total,hour) => total + hour.probes,0), 128);
  assert.deepEqual(activity.outcomes, [{outcome:'completed',probes:127},{outcome:'timeout',probes:1}]);
  await Promise.all([tick(false, minute), tick(false, minute)]);
  assert.deepEqual(await read(), activity);
  await insertAt(minute - 60_000, [probe({destination_port:22,service:'ssh'})]);
  assert.equal((await tick(false, minute + 60_000)).status, 200);
  assert.equal((await read()).probes, 129, 'later arrivals add once to the existing totals');
  const updatedPorts = (await read()).ports;
  assert.equal(updatedPorts[0].probes, 126);
  // Retention can remove raw records without changing the already aggregated day.
  await db.exec('DELETE FROM events');
  const state = await first<{last_event_id:number}>('SELECT last_event_id FROM summary_state');
  await db.prepare("INSERT INTO activity_minutes VALUES (?,25,'smtp','completed',50)").bind(from-60_000).run();
  assert.equal((await tick(false, minute + 120_000)).status, 200);
  assert.deepEqual((await read()).ports, updatedPorts);
  assert.equal((await read()).probes, 129);
  assert.equal((await first<{n:number}>(`SELECT COUNT(*) AS n FROM activity_minutes WHERE minute_ms < ${from}`)).n, 0);
  assert.equal((await first<{last_event_id:number}>('SELECT last_event_id FROM summary_state')).last_event_id, state.last_event_id);
});


test('custom website hosts require a valid owner Access session for pages and assets', async () => {
  for (const host of ['honeyprinter.com','www.honeyprinter.com']) for (const path of ['/','/build/app.js']) {
    assert.equal((await mf.dispatchFetch(`https://${host}${path}`)).status,403);
    assert.equal((await mf.dispatchFetch(`https://${host}${path}`, {headers:{'Cf-Access-Jwt-Assertion':'forged','Cf-Access-Authenticated-User-Email':'ostrowr@gmail.com'}})).status,403);
  }
  for (const changes of [{email:'someone@example.com'},{issuer:'https://other.cloudflareaccess.com'},{audience:'other-app'},{expires:'-1h'}]) {
    assert.equal((await mf.dispatchFetch(SITE_ORIGIN, {headers:{'Cf-Access-Jwt-Assertion':await accessToken(changes)}})).status,403);
  }
  const valid = await accessToken();
  const parts = valid.split('.'); parts[1] = btoa(JSON.stringify({email:'ostrowr@gmail.com',aud:'test-aud',iss:ACCESS_ISSUER,exp:9999999999,iat:1})).replace(/=/g,'').replaceAll('+','-').replaceAll('/','_');
  assert.equal((await mf.dispatchFetch(SITE_ORIGIN,{headers:{'Cf-Access-Jwt-Assertion':parts.join('.')}})).status,403);
  const headers = {'Cf-Access-Jwt-Assertion':valid};
  for (const path of ['/','/style.css','/build/app.js']) {
    const response = await mf.dispatchFetch(SITE_ORIGIN + path,{headers});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('X-Test-Asset-Path'),path);
    assert.match(response.headers.get('Content-Security-Policy') ?? '',/connect-src 'self' https:\/\/api\.honeyprinter\.com/);
    assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  }
  const www = await mf.dispatchFetch('https://www.honeyprinter.com/?receipt=12',{headers,redirect:'manual'});
  assert.equal(www.status,308); assert.equal(www.headers.get('Location'),`${SITE_ORIGIN}/?receipt=12`);
  assert.equal((await mf.dispatchFetch(`${SITE_ORIGIN}/api/events`,{headers})).status,404);
  assert.equal((await mf.dispatchFetch(`${base}/`)).status,200,'development URLs still serve the page locally');
});

test('old website redirects to the private domain while its API stays in place', async () => {
  const legacy = 'https://ostro.ws/honeyprinter';
  for (const method of ['GET','HEAD']) {
    for (const [path, destination] of [['','/'],['/','/'],['?receipt=12','/?receipt=12'],['/build/app.js?v=1','/build/app.js?v=1']]) {
      const response = await mf.dispatchFetch(legacy + path,{method,redirect:'manual'});
      assert.equal(response.status,308);
      assert.equal(response.headers.get('Location'),SITE_ORIGIN + destination);
    }
  }
  const status = await mf.dispatchFetch(legacy + '/api/status',{redirect:'manual'});
  assert.equal(status.status,200);
  assert.equal(status.headers.get('Location'),null);
  const ingest = await mf.dispatchFetch(legacy + '/api/probes',{method:'POST',redirect:'manual',
    headers:{Authorization:'Bearer testing','Content-Type':'application/json'},body:'{}'});
  assert.equal(ingest.status,400,'existing uploaders reach validation without following a redirect');
  assert.equal(ingest.headers.get('Location'),null);
  assert.equal((await mf.dispatchFetch('https://ostro.ws/honeyprinter-other',{redirect:'manual'})).status,404);
});

test('API hostname serves the same data with restricted CORS and authenticated ingestion', async () => {
  for (const path of ['/events','/receipts','/activity','/status']) {
    const response = await mf.dispatchFetch(API_ORIGIN + path,{headers:{Origin:SITE_ORIGIN}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),SITE_ORIGIN);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);
    assert.equal(response.headers.get('Vary'),'Origin');
    const old = await mf.dispatchFetch(`${base}/api${path}`);
    const current = await response.json() as Record<string,unknown>, previous = await old.json() as Record<string,unknown>;
    delete current.server_time_ms; delete previous.server_time_ms;
    assert.deepEqual(current,previous);
  }
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/events',{headers:{Origin:'https://evil.example'}})).headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/events',{headers:{Origin:'https://ostro.ws'}})).headers.get('Access-Control-Allow-Origin'),'https://ostro.ws');
  const preflight = await mf.dispatchFetch(API_ORIGIN + '/events',{method:'OPTIONS',headers:{Origin:SITE_ORIGIN,'Access-Control-Request-Method':'GET'}});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),SITE_ORIGIN);
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/events',{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Method':'GET'}})).status,403);
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/probes',{method:'OPTIONS',headers:{Origin:SITE_ORIGIN,'Access-Control-Request-Method':'POST'}})).status,403);
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/probes',{method:'POST'})).status,401);
  assert.equal((await mf.dispatchFetch(API_ORIGIN + '/probes',{method:'POST',headers:{Authorization:'Bearer testing','Content-Type':'application/json'},body:'{}'})).status,400);
  for (const path of ['/','/build/app.js','/honeyprinter/','/api/events']) assert.equal((await mf.dispatchFetch(API_ORIGIN + path)).status,404);
});
