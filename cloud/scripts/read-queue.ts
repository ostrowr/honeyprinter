import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Receipt} from '../shared/api.ts';

interface Message {body: unknown; lease_id: string}
interface Pull {messages: Message[]; message_backlog_count?: number}
type RequestQueue = <T>(action: 'pull' | 'ack', body: unknown) => Promise<T>;

export function decodeReceipt(body: unknown): Receipt {
  if (typeof body === 'string') {
    if (body.length > 48_000) throw new Error('Receipt too large');
    try { body = JSON.parse(body); }
    catch { body = JSON.parse(Buffer.from(body as string, 'base64').toString('utf8')); }
  }
  const r = body as Partial<Receipt> | null;
  if (!r || r.schema_version !== 1 || r.type !== 'receipt'
    || typeof r.receipt_id !== 'string' || r.receipt_id.length > 100
    || !Number.isSafeInteger(r.created_at_ms) || !r.counts || !r.summary
    || !Number.isSafeInteger(r.counts.probes) || !Number.isSafeInteger(r.counts.sources)
    || typeof r.summary.title !== 'string' || typeof r.summary.body !== 'string'
    || !Array.isArray(r.summary.highlights) || !r.summary.highlights.every(h => typeof h === 'string')
    || JSON.stringify(r).length > 32_000) throw new Error('Invalid receipt');
  return r as Receipt;
}

// Probe data is untrusted. Never let it inject terminal escape sequences.
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1200);
export function renderReceipt(receipt: Receipt): string {
  const line = '-'.repeat(48);
  return [line, 'HONEYPRINTER', clean(receipt.receipt_id),
    new Date(receipt.created_at_ms).toISOString(),
    `${receipt.counts.probes} probes / ${receipt.counts.sources} sources`, '',
    clean(receipt.summary.title), clean(receipt.summary.body),
    ...receipt.summary.highlights.slice(0, 3).map(h => `  * ${clean(h)}`), line, ''].join('\n');
}

export async function readOne(request: RequestQueue, output: (receipt: Receipt) => Promise<void>, seen: Set<string>): Promise<boolean> {
  const result = await request<Pull>('pull', {batch_size: 1, visibility_timeout_ms: 60_000});
  if (!Array.isArray(result.messages) || result.messages.length > 1) throw new Error('Invalid queue response');
  const message = result.messages[0];
  if (!message) return false;
  if (typeof message.lease_id !== 'string' || !message.lease_id) throw new Error('Missing lease');
  const receipt = decodeReceipt(message.body);
  const duplicate = seen.has(receipt.receipt_id);
  if (!duplicate) {
    await output(receipt);
    seen.add(receipt.receipt_id);
    if (seen.size > 4096) seen.delete(seen.values().next().value!);
  }
  // Only remove the queue message after stdout accepts it. Failures can redeliver.
  await request('ack', {acks: [{lease_id: message.lease_id}], retries: []});
  return !duplicate;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(`Read Honeyprinter receipts from Cloudflare Queues (Node 24+).

Usage: node cloud/scripts/read-queue.ts [--wrangler] [--once] [--json]

  --wrangler  Use this Mac's existing Wrangler login; no token copying needed.
  --once      Pull at most one receipt, print it, acknowledge it, then exit.
  --json      Print the decoded receipt as JSON instead of a text receipt.

Otherwise set CLOUDFLARE_QUEUE_TOKEN to an account-scoped Queues Edit token.
Optional: CLOUDFLARE_ACCOUNT_ID and HONEYPRINTER_QUEUE_ID override this project.
Continuous mode prints at most once per minute; empty polls wait five seconds.
Acknowledged receipts leave the queue. Run this OR the Pi, not both.
Duplicates are remembered only for this process; this is a disposable Pi stand-in.`);
    return;
  }
  for (const arg of args) if (!['--wrangler', '--once', '--json'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '2a4721a7e3192e5ad893a8684bb2d2e3';
  const queue = process.env.HONEYPRINTER_QUEUE_ID ?? '3c46c5b8e43643fabfbf54c02f17e02e';
  if (![account, queue].every(id => /^[a-f0-9]{32}$/.test(id))) throw new Error('Invalid account or queue ID');
  const cloud = fileURLToPath(new URL('..', import.meta.url));
  let credentials: {token: string; expires: number} | undefined;
  function token(): string {
    if (!args.has('--wrangler')) {
      if (!process.env.CLOUDFLARE_QUEUE_TOKEN) throw new Error('Set CLOUDFLARE_QUEUE_TOKEN or use --wrangler');
      return process.env.CLOUDFLARE_QUEUE_TOKEN;
    }
    if (!credentials || credentials.expires < Date.now()) {
      try {
        const auth = JSON.parse(execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'],
          {cwd: cloud, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe']})) as {token?: string};
        if (!auth.token) throw new Error();
        credentials = {token: auth.token, expires: Date.now() + 300_000};
      } catch { throw new Error('Wrangler authentication failed; run npm ci and npx wrangler login in cloud/'); }
    }
    return credentials.token;
  }
  const request: RequestQueue = async <T>(action: 'pull' | 'ack', body: unknown): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues/${queue}/messages/${action}`, {
      method: 'POST', headers: {Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Queue ${action} returned HTTP ${response.status}`);
    const data = await response.json() as {success?: boolean; result: T};
    if (!data.success) throw new Error(`Queue ${action} failed`);
    return data.result;
  };
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const seen = new Set<string>();
  let lastPrint = -Infinity;
  const output = async (receipt: Receipt) => {
    await new Promise<void>((resolve, reject) => process.stdout.write(
      args.has('--json') ? JSON.stringify(receipt) + '\n' : renderReceipt(receipt),
      error => error ? reject(error) : resolve()));
    lastPrint = performance.now();
  };
  token(); // Fail immediately on missing credentials, before entering the poll loop.
  console.error(`Reading honeyprinter-print${args.has('--once') ? ' once' : '; Ctrl-C to stop'}. Printed receipts are acknowledged.`);
  do {
    try {
      const printed = await readOne(request, output, seen);
      if (args.has('--once')) { if (!printed) console.error('No new receipts.'); return; }
    } catch (error) {
      if (args.has('--once')) throw error;
      console.error(error instanceof Error ? error.message : 'Queue read failed');
    }
    const wait = Math.max(5000, 60_000 - (performance.now() - lastPrint));
    await delay(Math.ceil(wait), undefined, {signal: stop.signal}).catch(() => {});
  } while (!stop.signal.aborted);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Queue reader failed'); process.exitCode = 1; });
}
