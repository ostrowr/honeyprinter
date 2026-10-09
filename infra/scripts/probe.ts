import { createConnection } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

interface Protocol {
  port: number;
  tls?: boolean;
  request: (index: number) => Buffer | string;
  expected: Buffer | string;
}

const paths = ['/', '/.env', '/wp-login.php', '/.git/config', '/admin', '/robots.txt', '/actuator/health'];
const http = (index: number) => `GET ${paths[index % paths.length]} HTTP/1.1\r\nHost: honeyprinter.test\r\nUser-Agent: honeyprinter-probe/1\r\nConnection: close\r\n\r\n`;
const mqtt = Buffer.from('101100044d5154540402003c000570726f6265', 'hex');

function postgres(): Buffer {
  const body = Buffer.from('user\0probe\0database\0postgres\0\0');
  const packet = Buffer.alloc(8 + body.length);
  packet.writeInt32BE(packet.length);
  packet.writeInt32BE(196608, 4);
  body.copy(packet, 8);
  return packet;
}

function mongodb(index: number): Buffer {
  const hello = Buffer.from('100000001068656c6c6f000100000000', 'hex');
  const packet = Buffer.alloc(21 + hello.length);
  packet.writeInt32LE(packet.length);
  packet.writeInt32LE(index + 1, 4);
  packet.writeInt32LE(2013, 12); // OP_MSG; zero flags and a kind-0 BSON section.
  hello.copy(packet, 21);
  return packet;
}

const protocols: Record<string, Protocol> = {
  http: { port: 80, request: http, expected: 'HTTP/1.1' },
  https: { port: 443, tls: true, request: http, expected: 'HTTP/1.1' },
  ssh: { port: 22, request: () => 'SSH-2.0-honeyprinter_probe\r\n', expected: 'SSH-2.0-' },
  redis: { port: 6379, request: () => '*1\r\n$4\r\nPING\r\n', expected: '+PONG\r\n' },
  memcached: { port: 11211, request: () => 'version\r\n', expected: 'VERSION ' },
  mysql: { port: 3306, request: () => '', expected: 'mysql_native_password' },
  postgres: { port: 5432, request: postgres, expected: 'C28000\0' },
  mongodb: { port: 27017, request: mongodb, expected: 'maxWireVersion\0' },
  mqtt: { port: 1883, request: () => mqtt, expected: Buffer.from('20020005', 'hex') },
  mqtts: { port: 8883, tls: true, request: () => mqtt, expected: Buffer.from('20020005', 'hex') },
  amqp: { port: 5672, request: () => Buffer.from('414d515000000901', 'hex'), expected: 'PLAIN' },
  socks5: { port: 1080, request: () => Buffer.from('050100', 'hex'), expected: Buffer.from('05ff', 'hex') },
};

const help = `Usage: node infra/scripts/probe.ts HOST [options]

  --count N          Total TCP connections (default: 200)
  --rate N           Maximum new connections per second (default: 10)
  --concurrency N    Maximum in-flight connections (default: 8)
  --timeout-ms N     Deadline per probe, including TLS (default: 4000)
  --services LIST    Comma-separated names (default: all listed below)
  --port-offset N    Add to standard ports, e.g. 10000 for local development
  --help             Show this help

Services: ${Object.keys(protocols).join(', ')}

Cycles through services, accepts the decoys' expected rejection responses, and
prints a final per-service summary. HTTP paths vary between common scan targets.
TLS certificates are not verified because these decoys use self-signed certs.
Ctrl-C stops scheduling and lets in-flight probes finish. Any failures exit 1.

Examples:
  node infra/scripts/probe.ts 203.0.113.10 --count 200 --rate 10
  node infra/scripts/probe.ts 127.0.0.1 --port-offset 10000 --count 24
  node infra/scripts/probe.ts 203.0.113.10 --services http,ssh,redis --count 60
`;

function positive(value: string, name: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function probe(host: string, protocol: Protocol, port: number, index: number, timeout: number): Promise<string | undefined> {
  return new Promise(resolve => {
    // Only these diagnostic decoy connections skip certificate validation.
    const socket = protocol.tls
      ? connectTls({ host, port, rejectUnauthorized: false })
      : createConnection({ host, port });
    let received = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(error);
    };
    const deadline = setTimeout(() => finish('timeout'), timeout);
    socket.once(protocol.tls ? 'secureConnect' : 'connect', () => {
      const request = protocol.request(index);
      if (request.length) socket.write(request);
    });
    socket.on('data', chunk => {
      if (received.length + chunk.length > 16_384) return finish('response exceeded 16 KiB');
      received = Buffer.concat([received, chunk]);
      if (received.includes(protocol.expected)) finish();
    });
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
    socket.once('close', () => finish('connection closed before expected response'));
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      count: { type: 'string', default: '200' },
      rate: { type: 'string', default: '10' },
      concurrency: { type: 'string', default: '8' },
      'timeout-ms': { type: 'string', default: '4000' },
      'port-offset': { type: 'string', default: '0' },
      services: { type: 'string', default: Object.keys(protocols).join(',') },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(help); return; }
  if (positionals.length !== 1 || !positionals[0].trim() || positionals[0].includes('://')) {
    throw new Error('Supply one hostname or IP address, without a URL. Use --help for examples.');
  }
  const host = positionals[0];
  const count = positive(values.count, '--count', 1_000_000);
  const rate = positive(values.rate, '--rate', 1000);
  const concurrency = positive(values.concurrency, '--concurrency', 128);
  const timeout = positive(values['timeout-ms'], '--timeout-ms', 60_000);
  const offset = Number(values['port-offset']);
  const names = [...new Set(values.services.split(',').map(name => name.trim()))];
  if (!names.length || names.some(name => !Object.hasOwn(protocols, name))) {
    throw new Error(`Unknown service; choose from: ${Object.keys(protocols).join(', ')}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || names.some(name => protocols[name].port + offset > 65535)) {
    throw new Error('--port-offset must keep every selected port between 1 and 65535');
  }

  const stop = new AbortController();
  process.once('SIGINT', () => { console.log('\nStopping after in-flight probes finish…'); stop.abort(); });
  const stats = new Map(names.map(name => [name, { responses: 0, failed: 0, errors: new Map<string, number>() }]));
  const active = new Set<Promise<void>>();
  const start = performance.now();
  let nextStart = start;
  let started = 0;
  let completed = 0;
  console.log(`Probing ${host}: ${count} connections, at most ${rate}/s, concurrency ${concurrency}.`);
  console.log(`Services: ${names.join(', ')}\n`);
  const progress = setInterval(() => console.log(`${completed}/${started} completed; ${active.size} in flight`), 5000);
  try {
    for (let index = 0; index < count && !stop.signal.aborted; index++) {
      if (active.size >= concurrency) await Promise.race(active);
      try {
        const wait = nextStart - performance.now();
        if (wait > 0) await delay(Math.ceil(wait), undefined, { signal: stop.signal });
      } catch (error) {
        if (stop.signal.aborted) break;
        throw error;
      }
      if (stop.signal.aborted) break;
      nextStart = performance.now() + 1000 / rate; // Never catch up with a burst after a stall.
      const name = names[index % names.length];
      const protocol = protocols[name];
      const stat = stats.get(name)!;
      started++;
      const task = probe(host, protocol, protocol.port + offset, Math.floor(index / names.length), timeout).then(error => {
        completed++;
        if (error) {
          stat.failed++;
          stat.errors.set(error, (stat.errors.get(error) ?? 0) + 1);
        } else {
          stat.responses++;
        }
      }).finally(() => active.delete(task));
      active.add(task);
    }
    await Promise.all(active);
  } finally {
    clearInterval(progress);
  }
  console.table([...stats].map(([service, stat]) => ({
    service, port: protocols[service].port + offset,
    responses: stat.responses, failed: stat.failed,
    errors: [...stat.errors].map(([message, n]) => `${message} (${n})`).join(', '),
  })));
  const failed = [...stats.values()].reduce((sum, stat) => sum + stat.failed, 0);
  console.log(`${completed} probes in ${((performance.now() - start) / 1000).toFixed(1)}s: ${completed - failed} expected responses, ${failed} failed.`);
  process.exitCode = stop.signal.aborted ? 130 : failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
