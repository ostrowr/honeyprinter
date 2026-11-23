import {probeDetailLabels, type ProbeDetails} from '../shared/probe.ts';
import type {ProbeEvent} from '../shared/api.ts';
import {summarize} from './model.ts';
import {SITE_HOST, WWW_HOST, API_HOST, SITE_ORIGIN, API_ORIGIN, LEGACY_BASE} from '../shared/urls.ts';
import {readActivity, refreshActivity} from './activity.ts';
import type {Counts, Feed, Probe, PublicEvent, Receipt, ReceiptRecord, ReceiptSample} from '../shared/api.ts';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PRINT_QUEUE: Pick<Queue<Receipt>, 'send'>;
  INGEST_TOKEN: string;
  SUMMARY_MODE: string;
  OPENAI_MODEL: string;
  OPENAI_API_KEY?: string;
  RETENTION_DAYS: string;
}
interface EventRow {id: number; received_at_ms: number; payload: string}
const BASE = LEGACY_BASE;
const json = (value: unknown, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const label = (v: unknown) => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v);

export function validateProbe(v: unknown): v is Probe {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Probe;
  return p.schema_version === 1 && p.type === 'probe' && typeof p.event_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.event_id)
    && integer(p.observed_at_ms, 8_640_000_000_000_000)
    && typeof p.source_ip === 'string' && p.source_ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(p.source_ip)
    && integer(p.source_port, 65535) && integer(p.destination_port, 65535)
    && label(p.service) && label(p.stage) && label(p.outcome) && typeof p.tls === 'boolean'
    && integer(p.duration_ms, 120_000) && integer(p.bytes_in, 1_000_000) && integer(p.bytes_out, 1_000_000)
    && !!p.details && typeof p.details === 'object' && !Array.isArray(p.details)
    && Object.keys(p.details).length <= 24 && Object.entries(p.details).every(([k, v]) =>
      /^[a-zA-Z0-9_-]{1,40}$/.test(k) && ((typeof v === 'string' && v.length <= 320) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))));
}

async function authorized(request: Request, secret?: string): Promise<boolean> {
  if (!secret) return false;
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([digest(request.headers.get('Authorization') ?? ''), digest(`Bearer ${secret}`)]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (!await authorized(request, env.INGEST_TOKEN)) return json({error: 'Unauthorized'}, 401);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({error: 'Expected application/json'}, 415);
  // Bound streamed requests as well as requests with a Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) return json({error: 'Missing body'}, 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 262_144) { await reader.cancel(); return json({error: 'Upload too large'}, 413); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(await new Blob(chunks).text()); } catch { return json({error: 'Invalid JSON'}, 400); }
  const batch = body as {schema_version?: unknown; type?: unknown; events?: unknown} | null;
  const isBatch = batch?.schema_version === 1 && batch?.type === 'probe_batch';
  const events: unknown[] = isBatch && Array.isArray(batch.events) ? batch.events : [body];
  if (events.length === 0 || events.length > 1000 || !events.every(validateProbe)) return json({error: 'Invalid probe batch'}, 400);
  const probes = events as Probe[];
  // Only retain the documented schema; discard extra top-level input.
  const cleaned: Probe[] = probes.map(probe => ({
    schema_version: 1, type: 'probe', event_id: probe.event_id, observed_at_ms: probe.observed_at_ms,
    source_ip: probe.source_ip, source_port: probe.source_port, destination_port: probe.destination_port,
    service: probe.service, tls: probe.tls, stage: probe.stage, outcome: probe.outcome,
    duration_ms: probe.duration_ms, bytes_in: probe.bytes_in, bytes_out: probe.bytes_out, details: probe.details,
  }));
  // One atomic statement and two bound parameters regardless of batch size.
  const result = await env.DB.prepare(`INSERT INTO events (event_id, received_at_ms, observed_at_ms, source_ip, service, outcome, payload)
    SELECT json_extract(value, '$.event_id'), ?, json_extract(value, '$.observed_at_ms'),
      json_extract(value, '$.source_ip'), json_extract(value, '$.service'), json_extract(value, '$.outcome'), value
    FROM json_each(?) WHERE true ON CONFLICT(event_id) DO NOTHING`)
    .bind(Date.now(), JSON.stringify(cleaned)).run();
  return json(isBatch ? {accepted: result.meta.changes, duplicates: probes.length - result.meta.changes}
    : {event_id: probes[0].event_id, duplicate: result.meta.changes === 0}, result.meta.changes ? 201 : 200);
}

function publicEvent(row: EventRow, p = JSON.parse(row.payload) as Probe): PublicEvent {
  const source = p.source_ip;
  return {id: row.id, received_at_ms: row.received_at_ms, observed_at_ms: p.observed_at_ms, source,
    service: p.service, destination_port: p.destination_port, tls: p.tls, stage: p.stage, outcome: p.outcome, bytes_in: p.bytes_in};
}

function receiptSample(row: EventRow): ReceiptSample {
  const event = probeEvent(row);
  const details: ProbeDetails = {};
  // Small, useful protocol observations; never request bodies or arbitrary metadata.
  for (const key of ['method', 'path', 'client_banner', 'user-agent', 'commands', 'command', 'operation', 'action', 'sni', 'tls_version'] as const) {
    if (event.details[key]) details[key] = event.details[key]!.slice(0, 160);
    if (Object.keys(details).length === 6) break;
  }
  return {...event, details};
}

function probeEvent(row: EventRow): ProbeEvent {
  const p = JSON.parse(row.payload) as Probe;
  const details: ProbeDetails = {};
  for (const key of Object.keys(probeDetailLabels) as (keyof ProbeDetails)[]) {
    const raw = p.details[key];
    if (raw === undefined) continue;
    // Treat scanner-provided values as bounded text, never markup or links.
    let value = String(raw).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0,320);
    if (key === 'path') value = value.split(/[?#]/,1)[0];
    if (value) details[key] = value;
  }
  return {...publicEvent(row,p), source_port:p.source_port, duration_ms:p.duration_ms,
    bytes_out:p.bytes_out, details};
}

function cursor(url: URL): number | undefined | null {
  const value = url.searchParams.get('after');
  if (value === null) return undefined;
  if (!/^\d{1,16}$/.test(value) || !integer(Number(value))) return null;
  return Number(value);
}

async function feed(url: URL, env: Env, receipts = false) {
  const after = cursor(url);
  if (after === null) return json({error: 'Invalid cursor'}, 400);
  const table = receipts ? 'receipts' : 'events';
  const columns = receipts ? 'id, payload' : 'id, received_at_ms, payload';
  const rows = after === undefined
    ? (await env.DB.prepare(`SELECT ${columns} FROM ${table} ORDER BY id DESC LIMIT 100`).all<EventRow>()).results.reverse()
    : (await env.DB.prepare(`SELECT ${columns} FROM ${table} WHERE id > ? ORDER BY id LIMIT 100`).bind(after).all<EventRow>()).results;
  const items = receipts ? rows.map(r => ({...JSON.parse(r.payload) as Receipt, id: r.id})) : rows.map(probeEvent);
  return json({server_time_ms: Date.now(), items, cursor: rows.at(-1)?.id ?? after ?? 0, has_more: rows.length === 100, mode: env.SUMMARY_MODE} satisfies Feed<PublicEvent | ReceiptRecord>);
}

async function flushPrints(env: Env) {
  const rows = (await env.DB.prepare('SELECT id, payload FROM receipts WHERE enqueued_at_ms IS NULL AND probe_count > 0 ORDER BY id LIMIT 50').all<{id: number; payload: string}>()).results;
  for (const row of rows) {
    // Send before marking: a crash may redeliver, but never silently lose a job.
    await env.PRINT_QUEUE.send(JSON.parse(row.payload), {contentType: 'json'});
    await env.DB.prepare('UPDATE receipts SET enqueued_at_ms = ? WHERE id = ?').bind(Date.now(), row.id).run();
  }
}

export async function tick(env: Env, scheduledTime = Date.now()) {
  const now = Date.now();
  const minute = Math.floor(scheduledTime / 60_000) * 60_000;
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare('UPDATE summary_state SET lease_token = ?, lease_until_ms = ? WHERE id = 1 AND lease_until_ms < ? RETURNING last_event_id, last_receipt_ms')
    .bind(token, now + 300_000, now).first<{last_event_id: number; last_receipt_ms: number}>();
  if (!lock) return;
  try {
    await flushPrints(env);
    // Cron delivery can jitter. Compare scheduled minutes so a slightly early
    // invocation does not skip a whole minute, and retries cannot print twice.
    if (minute <= Math.floor(lock.last_receipt_ms / 60_000) * 60_000) return;
    const end = await env.DB.prepare('SELECT MAX(id) AS id FROM events').first<{id: number | null}>();
    const from = lock.last_event_id, to = Math.max(from, end?.id ?? 0);
    let counts: Counts = {probes: 0, sources: 0, first_ms: minute - 60_000, last_ms: minute, services: [], ports: [], outcomes: [], samples: []};
    if (to > from) {
      const range = 'id > ? AND id <= ?';
      const [total, ports, outcomes, examples] = await env.DB.batch([
        env.DB.prepare(`SELECT COUNT(*) AS probes, COUNT(DISTINCT source_ip) AS sources, MIN(observed_at_ms) AS first_ms, MAX(observed_at_ms) AS last_ms FROM events WHERE ${range}`).bind(from, to),
        env.DB.prepare(`SELECT json_extract(payload, '$.destination_port') AS port, service, COUNT(*) AS count FROM events WHERE ${range} GROUP BY port, service ORDER BY count DESC, port, service`).bind(from, to),
        env.DB.prepare(`SELECT outcome, COUNT(*) AS count FROM events WHERE ${range} GROUP BY outcome ORDER BY count DESC`).bind(from, to),
        env.DB.prepare(`SELECT id, received_at_ms, payload FROM events WHERE ${range} ORDER BY id LIMIT 8`).bind(from, to),
      ]);
      const portCounts = ports.results as unknown as NonNullable<Counts['ports']>;
      const byService = new Map<string, number>();
      for (const row of portCounts) byService.set(row.service, (byService.get(row.service) ?? 0) + row.count);
      const serviceCounts = [...byService].map(([service, count]) => ({service, count})).sort((a,b) => b.count-a.count || a.service.localeCompare(b.service));
      counts = {...total.results[0] as Record<string, unknown>, services: serviceCounts, ports: portCounts, outcomes: outcomes.results,
        samples: (examples.results as unknown as EventRow[]).map(receiptSample)} as Counts;
    }
    const quiet = counts.probes === 0;
    const summary = quiet ? {title: 'All quiet', body: 'No new connections recorded. Another quiet minute on the internet.', highlights: []} : await summarize(counts, env);
    const receipt: Receipt = {schema_version: 1, type: 'receipt', receipt_id: quiet ? `quiet-${minute}` : `receipt-${to}`, created_at_ms: now, scheduled_at_ms: minute,
      first_event_id: quiet ? from : from + 1, last_event_id: to, counts, summary,
      summarizer: quiet ? 'quiet' : env.SUMMARY_MODE === 'mock' ? 'mock' : env.OPENAI_MODEL};
    // Receipt, minute totals, and cursor commit together. The lease token fences off an expired invocation.
    await env.DB.batch([
      // The independent totals cursor also covers receipts made by the old Worker during deployment.
      env.DB.prepare(`INSERT INTO activity_minutes (minute_ms, port, service, outcome, probes)
        SELECT (received_at_ms / 60000) * 60000, json_extract(payload, '$.destination_port'), service, outcome, COUNT(*) FROM events
        WHERE id > (SELECT activity_last_event_id FROM summary_state WHERE id = 1) AND id <= ? AND received_at_ms >= ?
          AND EXISTS (SELECT 1 FROM summary_state WHERE id = 1 AND lease_token = ?)
        GROUP BY 1, 2, 3, 4
        ON CONFLICT(minute_ms, port, service, outcome) DO UPDATE SET probes = probes + excluded.probes`)
        .bind(to, Math.floor(now / 60_000) * 60_000 - 86_400_000, token),
      env.DB.prepare('INSERT INTO receipts (receipt_id, created_at_ms, first_event_id, last_event_id, probe_count, payload) SELECT ?, ?, ?, ?, ?, ? FROM summary_state WHERE id = 1 AND lease_token = ?')
        .bind(receipt.receipt_id, now, receipt.first_event_id, to, counts.probes, JSON.stringify(receipt), token),
      env.DB.prepare('UPDATE summary_state SET last_event_id = ?, activity_last_event_id = ?, last_receipt_ms = ? WHERE id = 1 AND lease_token = ?').bind(to, to, minute, token),
    ]);
    await refreshActivity(env.DB, now, token);
    await flushPrints(env);
    // Bound each cleanup pass. Never delete events waiting to be summarized or receipts waiting to enqueue.
    const cutoff = now - Math.max(1, Number(env.RETENTION_DAYS) || 7) * 86_400_000;
    const oldest = await env.DB.prepare('SELECT received_at_ms FROM events ORDER BY id LIMIT 1').first<{received_at_ms: number}>();
    if (oldest && oldest.received_at_ms < cutoff) {
      await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id, received_at_ms FROM events WHERE id <= (SELECT last_event_id FROM summary_state WHERE id = 1) ORDER BY id LIMIT 2000) WHERE received_at_ms < ?)').bind(cutoff).run();
    }
    const oldestReceipt = await env.DB.prepare('SELECT created_at_ms FROM receipts ORDER BY id LIMIT 1').first<{created_at_ms: number}>();
    if (oldestReceipt && oldestReceipt.created_at_ms < cutoff) {
      await env.DB.prepare('DELETE FROM receipts WHERE id IN (SELECT id FROM (SELECT id, created_at_ms, enqueued_at_ms, probe_count FROM receipts ORDER BY id LIMIT 100) WHERE created_at_ms < ? AND (enqueued_at_ms IS NOT NULL OR probe_count = 0))').bind(cutoff).run();
    }
  } finally {
    await env.DB.prepare('UPDATE summary_state SET lease_token = NULL, lease_until_ms = 0 WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}

const readPaths = new Set(['/events', '/receipts', '/activity', '/status']);
const browserOrigins = new Set([SITE_ORIGIN, 'https://ostro.ws']);

function cors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (origin && browserOrigins.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, {status: response.status, headers});
}

async function api(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  if (path === '/probes' && request.method === 'POST') return ingest(request, env);
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin');
    const method = request.headers.get('Access-Control-Request-Method');
    if (!readPaths.has(path) || !origin || !browserOrigins.has(origin) || !['GET','HEAD'].includes(method ?? '') || request.headers.has('Access-Control-Request-Headers')) return json({error:'Preflight not allowed'},403);
    return cors(new Response(null, {status:204, headers:{'Access-Control-Allow-Methods':'GET, HEAD', 'Access-Control-Max-Age':'600'}}),origin);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({error:'Method not allowed'},405);
  let response: Response;
  if (path === '/events') response = await feed(url,env);
  else if (path === '/receipts') response = await feed(url,env,true);
  else if (path === '/activity') response = json(await readActivity(env.DB));
  else if (path === '/status') response = json({mode:env.SUMMARY_MODE,model:env.SUMMARY_MODE === 'openai' ? env.OPENAI_MODEL : null,cadence_seconds:60,retention_days:Number(env.RETENTION_DAYS)});
  else response = json({error:'Not found'},404);
  return cors(response,request.headers.get('Origin'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const siteHost = url.hostname === SITE_HOST || url.hostname === WWW_HOST;
    try {
      if (url.hostname === WWW_HOST) return Response.redirect(`${SITE_ORIGIN}${path}${url.search}`,308);
      if (url.hostname === API_HOST) return await api(request,env,url,path);
      if (!siteHost && path.startsWith(`${BASE}/api/`)) return await api(request,env,url,path.slice(`${BASE}/api`.length));
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({error:'Method not allowed'},405);
      if (!siteHost) {
        if (url.hostname === 'ostro.ws' && (path === BASE || path.startsWith(`${BASE}/`))) {
          return Response.redirect(`${SITE_ORIGIN}${path.slice(BASE.length) || '/'}${url.search}`,308);
        }
        if (path === BASE) return Response.redirect(`${url.origin}${BASE}/`,308);
        if (!path.startsWith(`${BASE}/`)) return json({error:'Not found'},404);
        url.pathname = path.slice(BASE.length);
      } else if (path === '/api' || path.startsWith('/api/')) return json({error:'Use api.honeyprinter.com'},404);
      const asset = await env.ASSETS.fetch(new Request(url,request));
      const headers = new Headers(asset.headers);
      headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${API_ORIGIN}; base-uri 'none'; frame-ancestors 'none'`);
      headers.set('X-Content-Type-Options','nosniff');
      headers.set('Referrer-Policy','no-referrer');
      return new Response(asset.body,{status:asset.status,headers});
    } catch (error) {
      console.error('Honeyprinter request failed',error instanceof Error ? error.message : 'Unknown error');
      const response = json({error:'Temporarily unavailable'},503);
      return url.hostname === API_HOST ? cors(response,request.headers.get('Origin')) : response;
    }
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> { await tick(env,event.scheduledTime); },
} satisfies ExportedHandler<Env>;
