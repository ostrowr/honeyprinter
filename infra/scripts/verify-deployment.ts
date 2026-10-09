import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

type Invocation = { Status: string; StandardOutputContent?: string; StandardErrorContent?: string };

function aws<T>(args: string[]): T {
  return JSON.parse(execFileSync('aws', [...args, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  })) as T;
}

async function poll<T>(label: string, timeout: number, check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(5_000);
  }
  throw new Error(`${label} timed out`, { cause: lastError });
}

async function probe(host: string, port: number, request: string, expected: string, tls = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // The HTTPS decoy deliberately uses a self-signed certificate.
    const socket = tls ? connectTls({ host, port, rejectUnauthorized: false }) : createConnection({ host, port });
    let response = '';
    const deadline = setTimeout(() => socket.destroy(new Error(`Port ${port} timed out`)), 8_000);
    socket.once(tls ? 'secureConnect' : 'connect', () => { if (request) socket.write(request); });
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.includes(expected)) {
        clearTimeout(deadline);
        socket.destroy();
        resolve();
      } else if (response.length > 8192) {
        socket.destroy(new Error(`Unexpected response on port ${port}`));
      }
    });
    socket.once('error', error => { clearTimeout(deadline); reject(error); });
    socket.once('end', () => {
      if (!response.includes(expected)) reject(new Error(`Missing expected response on port ${port}`));
    });
    socket.once('close', () => clearTimeout(deadline));
  });
  console.log(`Public probe passed: ${port}/tcp`);
}

const output = JSON.parse(execFileSync('terraform', ['-chdir=infra/terraform', 'output', '-json'], {
  encoding: 'utf8', timeout: 30_000,
})) as { instance_id: { value: string }; public_ip: { value: string } };
const instanceId = output.instance_id.value;
const ip = output.public_ip.value;
const digest = process.env.TF_VAR_artifact_sha256 ?? '';
const ports = JSON.parse(readFileSync(new URL('../shared/ports.json', import.meta.url), 'utf8')) as number[];
if (!/^i-[a-f0-9]+$/.test(instanceId) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !/^[a-f0-9]{64}$/.test(digest)
    || !ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
  throw new Error('Invalid deployment outputs');
}

console.log(`Waiting for Systems Manager on ${instanceId} (${ip})`);
await poll('SSM registration', 10 * 60_000, () => {
  const info = aws<{ InstanceInformationList: { PingStatus: string }[] }>([
    'ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${instanceId}`,
  ]);
  return info.InstanceInformationList.some(node => node.PingStatus === 'Online') ? true : undefined;
});

const commands = [
  'set -eu',
  'cloud-init status --wait',
  'systemctl is-active --quiet honeyprinter',
  `printf '%s  %s\\n' '${digest}' /usr/local/bin/honeyprinter | sha256sum --check`,
  'test "$(systemctl is-enabled sshd.service)" = masked',
  'if systemctl is-active --quiet sshd.service; then exit 1; fi',
  'pid=$(systemctl show honeyprinter --property=MainPID --value)',
  'test "$pid" -gt 1',
  `for port in ${ports.join(' ')}; do ss -H -ltnp "sport = :$port" | grep -Fq "pid=$pid," || { echo "Missing listener: $port"; exit 1; }; done`,
  'test "$(stat -c %a /etc/honeyprinter.env)" = 600',
  'test "$(stat -c %U /etc/honeyprinter.env)" = root',
  'tr "\\0" " " < /proc/"$pid"/cmdline | grep -Fq -- "--ingest-url https://ostro.ws/honeyprinter/api/probes"',
  'systemctl show honeyprinter --property=ActiveState,SubState,NRestarts,MemoryCurrent',
  `echo 'Verified checksum and ${ports.length} Honeyprinter listeners'`,
];
const sent = aws<{ Command: { CommandId: string } }>(['ssm', 'send-command',
  '--instance-ids', instanceId, '--document-name', 'AWS-RunShellScript',
  '--comment', 'Verify Honeyprinter deployment', '--timeout-seconds', '600',
  '--parameters', JSON.stringify({ commands, executionTimeout: ['600'] }),
]);
const invocation = await poll<Invocation>('SSM health check', 11 * 60_000, () => {
  const result = aws<Invocation>(['ssm', 'get-command-invocation',
    '--command-id', sent.Command.CommandId, '--instance-id', instanceId]);
  return ['Pending', 'InProgress', 'Delayed'].includes(result.Status) ? undefined : result;
});
console.log(invocation.StandardOutputContent ?? '');
if (invocation.Status !== 'Success') {
  console.error(invocation.StandardErrorContent ?? '');
  throw new Error(`SSM health check failed: ${invocation.Status}`);
}

const feedUrl = 'https://ostro.ws/honeyprinter/api/events';
type Feed = {items: {id: number; destination_port: number; bytes_in: number; observed_at_ms: number}[]; cursor: number; has_more: boolean};
async function readFeed(after?: number): Promise<Feed> {
  const response = await fetch(feedUrl + (after === undefined ? '' : `?after=${after}`), {signal: AbortSignal.timeout(10_000), redirect: 'error'});
  if (!response.ok) throw new Error(`Live feed returned HTTP ${response.status}`);
  return response.json() as Promise<Feed>;
}
let cursor = (await readFeed()).cursor;
const observedAfter = Date.now() - 2000;
const smokeRequest = `GET / HTTP/1.1\r\nHost: honeyprinter\r\nX-Honeyprinter-Smoke: ${process.env.GITHUB_RUN_ID}-${'v'.repeat(997)}\r\nConnection: close\r\n\r\n`;
await Promise.all([
  probe(ip, 22, '', 'SSH-2.0-'),
  probe(ip, 80, smokeRequest, 'HTTP/1.1'),
  probe(ip, 443, 'GET / HTTP/1.1\r\nHost: honeyprinter\r\nConnection: close\r\n\r\n', 'HTTP/1.1', true),
  probe(ip, 6379, '*1\r\n$4\r\nPING\r\n', '+PONG'),
]);
const feedDeadline = Date.now() + 45_000;
let delivered = false;
while (Date.now() < feedDeadline) {
  const feed = await readFeed(cursor);
  delivered = feed.items.some(event => event.destination_port === 80
    && event.bytes_in === Buffer.byteLength(smokeRequest) && event.observed_at_ms >= observedAfter);
  if (delivered) break;
  cursor = feed.cursor;
  if (!feed.has_more) await delay(2000);
}
if (!delivered) throw new Error('Public HTTP probe did not reach the Cloudflare live feed');
console.log('Verified public probe -> Rust batch uploader -> Cloudflare Worker -> D1 -> live feed');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Deployed commit \`${process.env.GITHUB_SHA}\` to \`${instanceId}\` in Oregon.\n\n`
    + `Public IP: **${ip}**\n\nSHA-256: \`${digest}\`\n\n`
    + `Verified service, binary checksum, ${ports.length} listeners, and public SSH/HTTP/HTTPS/Redis decoys. Cloudflare delivery enabled.\n`);
}
