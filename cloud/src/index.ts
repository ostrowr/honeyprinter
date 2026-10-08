import {summarize, type Counts} from './model';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PRINT_QUEUE: Queue;
  INGEST_TOKEN: string;
  SUMMARY_MODE: string;
  OPENAI_MODEL: string;
  OPENAI_API_KEY?: string;
  RETENTION_DAYS: string;
}
interface Probe {
  schema_version: number; type: string; event_id: string; observed_at_ms: number;
  source_ip: string; source_port: number; destination_port: number;
  service: string; tls: boolean; stage: string; outcome: string;
  duration_ms: number; bytes_in: number; bytes_out: number; details: Record<string, string | number | boolean>;
}
interface EventRow {id: number; received_at_ms: number; payload: string}
const BASE = '/honeyprinter';
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
      /^[a-zA-Z0-9_]{1,40}$/.test(k) && ((typeof v === 'string' && v.length <= 320) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))));
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

function publicEvent(row: EventRow) {
  const p = JSON.parse(row.payload) as Probe;
  // Public visitors get neither raw protocol metadata nor complete source addresses.
  const source = p.source_ip.includes(':') ? `${p.source_ip.split(':').slice(0, 2).join(':')}:…` : p.source_ip.replace(/\.[^.]+$/, '.×');
  return {id: row.id, received_at_ms: row.received_at_ms, observed_at_ms: p.observed_at_ms, source,
    service: p.service, destination_port: p.destination_port, tls: p.tls, stage: p.stage, outcome: p.outcome, bytes_in: p.bytes_in};
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
  const items = receipts ? rows.map(r => ({...JSON.parse(r.payload), id: r.id})) : rows.map(publicEvent);
  return json({items, cursor: rows.at(-1)?.id ?? after ?? 0, has_more: rows.length === 100, mode: env.SUMMARY_MODE});
}

async function flushPrints(env: Env) {
  const rows = (await env.DB.prepare('SELECT id, payload FROM receipts WHERE enqueued_at_ms IS NULL ORDER BY id LIMIT 50').all<{id: number; payload: string}>()).results;
  for (const row of rows) {
    // Send before marking: a crash may redeliver, but never silently lose a job.
    await env.PRINT_QUEUE.send(JSON.parse(row.payload));
    await env.DB.prepare('UPDATE receipts SET enqueued_at_ms = ? WHERE id = ?').bind(Date.now(), row.id).run();
  }
}

export async function tick(env: Env) {
  const now = Date.now();
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare('UPDATE summary_state SET lease_token = ?, lease_until_ms = ? WHERE id = 1 AND lease_until_ms < ? RETURNING last_event_id, last_receipt_ms')
    .bind(token, now + 300_000, now).first<{last_event_id: number; last_receipt_ms: number}>();
  if (!lock) return;
  try {
    await flushPrints(env);
    if (now - lock.last_receipt_ms < 60_000) return;
    const end = await env.DB.prepare('SELECT MAX(id) AS id FROM events').first<{id: number | null}>();
    if (end?.id && end.id > lock.last_event_id) {
      const from = lock.last_event_id, to = end.id;
      const range = 'id > ? AND id <= ?';
      const [total, services, outcomes, examples] = await env.DB.batch([
        env.DB.prepare(`SELECT COUNT(*) AS probes, COUNT(DISTINCT source_ip) AS sources, MIN(observed_at_ms) AS first_ms, MAX(observed_at_ms) AS last_ms FROM events WHERE ${range}`).bind(from, to),
        env.DB.prepare(`SELECT service, COUNT(*) AS count FROM events WHERE ${range} GROUP BY service ORDER BY count DESC`).bind(from, to),
        env.DB.prepare(`SELECT outcome, COUNT(*) AS count FROM events WHERE ${range} GROUP BY outcome ORDER BY count DESC`).bind(from, to),
        env.DB.prepare(`SELECT id, received_at_ms, payload FROM events WHERE ${range} ORDER BY id LIMIT 8`).bind(from, to),
      ]);
      const counts = {...total.results[0] as Record<string, unknown>, services: services.results, outcomes: outcomes.results,
        samples: (examples.results as unknown as EventRow[]).map(publicEvent)} as Counts;
      const summary = await summarize(counts, env);
      const receipt = {schema_version: 1, type: 'receipt', receipt_id: `receipt-${to}`, created_at_ms: now,
        first_event_id: from + 1, last_event_id: to, counts, summary,
        summarizer: env.SUMMARY_MODE === 'mock' ? 'mock' : env.OPENAI_MODEL};
      // Both statements commit together. The lease token fences off an expired invocation.
      await env.DB.batch([
        env.DB.prepare('INSERT INTO receipts (receipt_id, created_at_ms, first_event_id, last_event_id, probe_count, payload) SELECT ?, ?, ?, ?, ?, ? FROM summary_state WHERE id = 1 AND lease_token = ?')
          .bind(receipt.receipt_id, now, from + 1, to, counts.probes, JSON.stringify(receipt), token),
        env.DB.prepare('UPDATE summary_state SET last_event_id = ?, last_receipt_ms = ? WHERE id = 1 AND lease_token = ?').bind(to, now, token),
      ]);
      await flushPrints(env);
    }
    // Bound each cleanup pass. Never delete events waiting to be summarized or receipts waiting to enqueue.
    const cutoff = now - Math.max(1, Number(env.RETENTION_DAYS) || 7) * 86_400_000;
    const oldest = await env.DB.prepare('SELECT received_at_ms FROM events ORDER BY id LIMIT 1').first<{received_at_ms: number}>();
    if (oldest && oldest.received_at_ms < cutoff) {
      await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id, received_at_ms FROM events WHERE id <= (SELECT last_event_id FROM summary_state WHERE id = 1) ORDER BY id LIMIT 2000) WHERE received_at_ms < ?)').bind(cutoff).run();
    }
    const oldestReceipt = await env.DB.prepare('SELECT created_at_ms FROM receipts ORDER BY id LIMIT 1').first<{created_at_ms: number}>();
    if (oldestReceipt && oldestReceipt.created_at_ms < cutoff) {
      await env.DB.prepare('DELETE FROM receipts WHERE id IN (SELECT id FROM (SELECT id, created_at_ms, enqueued_at_ms FROM receipts ORDER BY id LIMIT 100) WHERE created_at_ms < ? AND enqueued_at_ms IS NOT NULL)').bind(cutoff).run();
    }
  } finally {
    await env.DB.prepare('UPDATE summary_state SET lease_token = NULL, lease_until_ms = 0 WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === `${BASE}/api/probes` && request.method === 'POST') return await ingest(request, env);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({error: 'Method not allowed'}, 405);
      if (path === `${BASE}/api/events`) return await feed(url, env);
      if (path === `${BASE}/api/receipts`) return await feed(url, env, true);
      if (path === `${BASE}/api/status`) return json({mode: env.SUMMARY_MODE, cadence_seconds: 60, retention_days: Number(env.RETENTION_DAYS)});
      if (path === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
      if (!path.startsWith(`${BASE}/`) || path.startsWith(`${BASE}/api/`)) return json({error: 'Not found'}, 404);
      url.pathname = path.slice(BASE.length);
      const asset = await env.ASSETS.fetch(new Request(url, request));
      const headers = new Headers(asset.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      return new Response(asset.body, {status: asset.status, headers});
    } catch (error) {
      console.error('Honeyprinter request failed', error instanceof Error ? error.message : 'Unknown error');
      return json({error: 'Temporarily unavailable'}, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await tick(env); },
} satisfies ExportedHandler<Env>;
