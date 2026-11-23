import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {decodeReceipt} from './read-queue.ts';
import {layoutReceipt, receiptEscpos, receiptPreview} from '../shared/print.ts';
import type {Feed, ProbeEvent, Receipt, ReceiptRecord} from '../shared/api.ts';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.honeyprinter.com${path}`, {signal:AbortSignal.timeout(15_000), redirect:'error'});
  if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
  return await response.json() as T;
}

// Public feed only. Never pulls, acknowledges, or drains the printer queue.
export async function latestReceipt(): Promise<Receipt> {
  const feed = await get<Feed<ReceiptRecord>>('/receipts');
  const receipt = [...feed.items].reverse().find(item => item.counts.probes > 0) ?? feed.items.at(-1);
  if (!receipt) throw new Error('No receipt available');
  decodeReceipt(receipt);
  if (!receipt.counts.probes || receipt.counts.samples.every(s => s.details)) return receipt;
  // Enrich retained older mock receipts for layout previews. All counts and sample IDs
  // remain tied to this receipt's original event range, never the current minute.
  const events = await get<Feed<ProbeEvent>>(`/events?after=${Math.max(0, receipt.first_event_id - 1)}`);
  const window = events.items.filter(e => e.id >= receipt.first_event_id && e.id <= receipt.last_event_id);
  receipt.counts.samples = receipt.counts.samples.map(sample => window.find(e => e.id === sample.id) ?? sample);
  if (!receipt.counts.ports && window.length === receipt.counts.probes) {
    const ports = new Map<string, {port:number; service:string; count:number}>();
    for (const event of window) {
      const key = `${event.destination_port}/${event.service}`;
      const row = ports.get(key) ?? {port:event.destination_port, service:event.service, count:0};
      row.count++; ports.set(key, row);
    }
    receipt.counts.ports = [...ports.values()].sort((a,b) => b.count-a.count || a.port-b.port);
  }
  return receipt;
}

async function main() {
  const {values} = parseArgs({options: {
    latest: {type:'boolean'}, file:{type:'string'}, printer:{type:'string'}, output:{type:'string'},
    timezone:{type:'string', default:'America/Los_Angeles'}, help:{type:'boolean'},
  }});
  if (values.help) {
    console.log(`Preview one Honeyprinter receipt; physically print only with --printer.

node cloud/scripts/print-receipt.ts --latest
node cloud/scripts/print-receipt.ts --latest --output /tmp/receipt.txt
node cloud/scripts/print-receipt.ts --file receipt.json --printer Printer_POS_80

--latest uses the newest traffic report among the last 100 receipts (otherwise the latest quiet report).
--file uses a saved receipt JSON. --output saves the text preview.
--timezone defaults to America/Los_Angeles.
No polling, scheduling, or queue acknowledgments. Exactly one job with --printer.`);
    return;
  }
  if (Boolean(values.latest) === Boolean(values.file)) throw new Error('Choose exactly one of --latest or --file');
  if (values.printer && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(values.printer)) throw new Error('Invalid CUPS printer name');
  const receipt = values.latest ? await latestReceipt() : decodeReceipt(await readFile(values.file!, 'utf8'));
  const lines = layoutReceipt(receipt, values.timezone);
  const preview = receiptPreview(lines);
  if (values.output) await writeFile(values.output, preview, {mode:0o600});
  else process.stdout.write(preview);
  if (values.printer) {
    const result = execFileSync('lp', ['-d',values.printer,'-t','Honeyprinter - one receipt','-o','raw'],
      {input:receiptEscpos(lines), encoding:'utf8', timeout:15_000});
    console.error(result.trim());
    console.error('One job submitted to CUPS. Automatic printing remains off.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error instanceof Error ? error.message : 'Receipt failed'); process.exitCode=1;});
}
