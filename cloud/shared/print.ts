import type {Receipt, ReceiptSample} from './api.ts';

export interface PrintLine {text: string; bold?: boolean; center?: boolean; large?: boolean}
export const PRINT_COLUMNS = 48;

// Native ESC/POS Font A is intentionally ASCII. Telemetry can never become a command.
export function printerText(value: unknown, limit = 600): string {
  return String(value ?? '').slice(0, 2400).replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '?')
    .trim().slice(0, limit);
}

export function wrapPrintText(value: unknown, width = PRINT_COLUMNS): string[] {
  let remaining = printerText(value);
  const lines: string[] = [];
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(' ', width);
    const end = space > 0 ? space : width;
    lines.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function pair(label: string, value: number | string): string {
  const right = printerText(value, 16);
  return printerText(label, PRINT_COLUMNS - right.length - 1).padEnd(PRINT_COLUMNS - right.length) + right;
}

function sampleLines(sample: ReceiptSample): PrintLine[] {
  const result: PrintLine[] = [];
  const add = (text: string, bold = false) => {
    for (const line of wrapPrintText(text)) result.push({text: line, bold});
  };
  add(`${sample.service.toUpperCase()} :${sample.destination_port} | ${sample.outcome.replaceAll('_', ' ')}`, true);
  add(`From ${sample.source}`);
  const d = sample.details ?? {};
  if (d.path) add(`${d.method ?? 'Request'} ${d.path.split(/[?#]/, 1)[0]}`);
  if (d.client_banner) add(`Banner: ${d.client_banner}`);
  if (d['user-agent']) add(`Agent: ${d['user-agent']}`);
  if (d.commands || d.command) add(`Command: ${d.commands ?? d.command}`);
  if (d.operation || d.action) add(`Operation: ${d.operation ?? d.action}`);
  if (d.sni) add(`TLS name: ${d.sni}`);
  add(`${sample.bytes_in} bytes in${sample.bytes_out === undefined ? '' : ` / ${sample.bytes_out} out`}${sample.duration_ms === undefined ? '' : ` / ${sample.duration_ms} ms`}`);
  return result;
}

export function layoutReceipt(receipt: Receipt, timeZone = 'America/Los_Angeles'): PrintLine[] {
  const lines: PrintLine[] = [];
  const add = (value: unknown, style: Omit<PrintLine, 'text'> = {}) => {
    for (const text of wrapPrintText(value, style.large ? 24 : PRINT_COLUMNS)) lines.push({text, ...style});
  };
  const blank = () => lines.push({text: ''});
  const rule = () => lines.push({text: '-'.repeat(PRINT_COLUMNS)});
  const date = (ms: number) => new Intl.DateTimeFormat('en-US', {timeZone, month:'short', day:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZoneName:'short'}).format(new Date(ms));
  add('HONEYPRINTER', {large:true, bold:true, center:true});
  add('INTERNET OBSERVATORY', {center:true});
  blank();
  add(`Report ${printerText(receipt.receipt_id, 100)}`);
  add(`From ${date(receipt.counts.first_ms)}`);
  add(`To   ${date(receipt.counts.last_ms)}`);
  rule();
  add(`${receipt.counts.probes} CONNECTIONS / ${receipt.counts.sources} SOURCE IPS`, {bold:true});
  blank();
  const ports = receipt.counts.ports;
  const rows = ports?.length ? ports.map(p => ({label:`${p.port} / ${p.service.toUpperCase()}`, count:p.count}))
    : receipt.counts.services.map(s => ({label:s.service.toUpperCase(), count:s.count}));
  add(pair(ports?.length ? 'PORT / SERVICE' : 'SERVICE', 'COUNT'), {bold:true});
  for (const row of rows.slice(0, 12)) add(pair(row.label, row.count));
  if (rows.length > 12) add(pair(`Other (${rows.length - 12})`, rows.slice(12).reduce((sum, row) => sum + row.count, 0)));
  rule();
  add(receipt.summary.title, {bold:true});
  add(receipt.summary.body);
  if (receipt.summarizer === 'mock') add('[Mock summary - Luna not enabled]');
  else if (receipt.summarizer !== 'quiet') add(`[Summary: ${receipt.summarizer}]`);
  const unique = new Map<string, ReceiptSample>();
  for (const sample of receipt.counts.samples.slice(0, 8)) {
    const key = JSON.stringify([sample.source, sample.destination_port, sample.outcome, sample.details]);
    if (!unique.has(key)) unique.set(key, sample);
  }
  const samples = [...unique.values()].slice(0, 4);
  if (samples.length) {
    rule();
    add(`SAMPLED PROBES (${samples.length} OF ${receipt.counts.probes})`, {bold:true});
    add('Examples only; counts above cover the window.');
    for (const sample of samples) { blank(); lines.push(...sampleLines(sample)); }
  }
  rule();
  add('honeyprinter.com', {center:true});
  return lines;
}

export function receiptPreview(lines: PrintLine[]): string {
  return lines.map(line => line.center ? line.text.padStart(Math.floor((PRINT_COLUMNS + line.text.length) / 2)) : line.text).join('\n') + '\n';
}

export function receiptEscpos(lines: PrintLine[]): Uint8Array {
  const bytes: number[] = [0x1b, 0x40, 0x1b, 0x4d, 0, 0x1b, 0x33, 32];
  for (const line of lines) {
    bytes.push(0x1b, 0x61, line.center ? 1 : 0, 0x1b, 0x45, line.bold ? 1 : 0, 0x1d, 0x21, line.large ? 0x11 : 0);
    // Sanitize again at the device boundary, including callers supplying their own lines.
    bytes.push(...new TextEncoder().encode(printerText(line.text, line.large ? 24 : PRINT_COLUMNS)), 10);
  }
  bytes.push(0x1b, 0x45, 0, 0x1d, 0x21, 0, 0x1b, 0x64, 4, 0x1d, 0x56, 1);
  return new Uint8Array(bytes);
}
