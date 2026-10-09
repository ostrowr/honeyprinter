import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyCloud} from './verify-cloud.ts';
import {verifySummary} from './verify-summary.ts';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Deployments run in GitHub Actions only. Push to main or use workflow_dispatch.');
for (const name of ['CLOUDFLARE_API_TOKEN', 'HONEYPRINTER_INGEST_TOKEN']) {
  if (!process.env[name]) throw new Error(`Missing GitHub Actions secret: ${name}`);
}
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as {vars: {SUMMARY_MODE: string; OPENAI_MODEL: string; ACCESS_AUD?: string; ACCESS_EMAIL?: string}};
const summaryEnv = {...config.vars, SUMMARY_MODE: process.env.SUMMARY_MODE ?? config.vars.SUMMARY_MODE, OPENAI_API_KEY: process.env.OPENAI_API_KEY};
if (summaryEnv.SUMMARY_MODE === 'openai' && !summaryEnv.OPENAI_API_KEY) throw new Error('Missing GitHub Actions secret: OPENAI_API_KEY');
if (!config.vars.ACCESS_AUD || !config.vars.ACCESS_EMAIL) throw new Error('Configure the Cloudflare Access application audience and owner email before attaching the private domains.');
// Fail before migrations or deployment if the key, model access, or request is invalid.
await verifySummary(summaryEnv);
const directory = mkdtempSync(join(tmpdir(), 'honeyprinter-secrets-'));
try {
  const secrets: Record<string, string> = {INGEST_TOKEN: process.env.HONEYPRINTER_INGEST_TOKEN!};
  if (process.env.OPENAI_API_KEY) secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const file = join(directory, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), {mode: 0o600});
  const run = (...args: string[]) => execFileSync('npx', ['--no-install', 'wrangler', ...args], {stdio: 'inherit'});
  run('d1', 'migrations', 'apply', 'honeyprinter', '--remote');
  // Upload secrets with the version so the first public deployment is authenticated.
  run('deploy', '--secrets-file', file, '--var', `SUMMARY_MODE:${summaryEnv.SUMMARY_MODE}`);
  await verifyCloud(process.env.HONEYPRINTER_INGEST_TOKEN!, summaryEnv);
} finally {
  rmSync(directory, {recursive: true, force: true});
}
