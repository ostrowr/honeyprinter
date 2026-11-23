import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {decodeReceipt} from './read-queue.ts';
import {layoutReceipt, receiptEscpos} from '../shared/print.ts';
import type {Feed, ReceiptRecord} from '../shared/api.ts';

export interface PrintState {receiptId: string; attemptedAtMs: number}
export const PRINT_INTERVAL_MS = 60_000;
const MAX_RECEIPT_AGE_MS = 120_000;

interface Printer {
  busy(): Promise<boolean>;
  reserve(state: PrintState): Promise<void>;
  submit(receipt: ReceiptRecord): Promise<void>;
}

// launchd runs only one instance of this job. Persist the attempt before submitting
// to CUPS: after an ambiguous crash, skipping one receipt is better than duplicates.
export async function printFresh(feed: Feed<ReceiptRecord>, state: PrintState | undefined, printer: Printer, now = Date.now()): Promise<boolean> {
  if (state && now - state.attemptedAtMs < PRINT_INTERVAL_MS) return false;
  const receipt = feed.items.at(-1);
  if (!receipt || receipt.receipt_id === state?.receiptId) return false;
  const age = feed.server_time_ms - receipt.created_at_ms;
  if (!Number.isFinite(age) || age < 0 || age > MAX_RECEIPT_AGE_MS) return false;
  decodeReceipt(receipt);
  if (await printer.busy()) return false;
  await printer.reserve({receiptId: receipt.receipt_id, attemptedAtMs: now});
  await printer.submit(receipt);
  return true;
}

async function loadState(path: string): Promise<PrintState | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const state = JSON.parse(text) as PrintState;
  if (typeof state.receiptId !== 'string' || !Number.isSafeInteger(state.attemptedAtMs) || state.attemptedAtMs < 0) {
    throw new Error('Invalid printer state; refusing to reset the print cooldown');
  }
  return state;
}

async function main() {
  const {values} = parseArgs({options: {printer:{type:'string'}, state:{type:'string'}, help:{type:'boolean'}}});
  if (values.help) {
    console.log(`Poll the latest Honeyprinter report and submit at most one receipt.

node cloud/scripts/print-live.ts --printer Printer_POS_80 --state /absolute/path/print-state.json

Run as one launchd job every 10 seconds. A persisted 60-second cooldown limits
printing across restarts. Quiet reports are included. Old reports are skipped;
pending CUPS jobs block new submissions. This reads the public feed, not the queue.
Failed or interrupted submissions may drop a receipt. No credentials required.`);
    return;
  }
  if (!values.printer || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(values.printer)) throw new Error('Specify a valid --printer');
  if (!values.state) throw new Error('Specify --state');
  const printer = values.printer, path = resolve(values.state);
  const state = await loadState(path);
  if (state && Date.now() - state.attemptedAtMs < PRINT_INTERVAL_MS) return;
  const response = await fetch('https://api.honeyprinter.com/receipts', {signal:AbortSignal.timeout(15_000), redirect:'error', cache:'no-store'});
  if (!response.ok) throw new Error(`Receipt feed returned HTTP ${response.status}`);
  const feed = await response.json() as Feed<ReceiptRecord>;
  if (!Array.isArray(feed.items) || !Number.isSafeInteger(feed.server_time_ms)) throw new Error('Invalid receipt feed');
  await printFresh(feed, state, {
    async busy() {
      return execFileSync('/usr/bin/lpstat', ['-W','not-completed','-o',printer], {encoding:'utf8',timeout:5000}).trim().length > 0;
    },
    async reserve(next) {
      await mkdir(dirname(path), {recursive:true,mode:0o700});
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(next)+'\n', {mode:0o600});
      await rename(temporary, path);
    },
    async submit(receipt) {
      const result = execFileSync('/usr/bin/lp', ['-d',printer,'-t','Honeyprinter - live receipt','-o','raw'],
        {input:receiptEscpos(layoutReceipt(receipt)),encoding:'utf8',timeout:15_000});
      console.log(`${new Date().toISOString()} ${result.trim()}`);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(new Date().toISOString(), error instanceof Error ? error.message : 'Live printing failed'); process.exitCode = 1; });
}
