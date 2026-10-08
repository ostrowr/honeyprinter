import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Deployments run in GitHub Actions only. Push to main or use workflow_dispatch.');
for (const name of ['CLOUDFLARE_API_TOKEN', 'HONEYPRINTER_INGEST_TOKEN']) {
  if (!process.env[name]) throw new Error(`Missing GitHub Actions secret: ${name}`);
}
const directory = mkdtempSync(join(tmpdir(), 'honeyprinter-secrets-'));
try {
  const secrets: Record<string, string> = {INGEST_TOKEN: process.env.HONEYPRINTER_INGEST_TOKEN!};
  if (process.env.OPENAI_API_KEY) secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const file = join(directory, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), {mode: 0o600});
  const run = (...args: string[]) => execFileSync('npx', ['--no-install', 'wrangler', ...args], {stdio: 'inherit'});
  run('d1', 'migrations', 'apply', 'honeyprinter', '--remote');
  // Upload secrets with the version so the first public deployment is authenticated.
  run('deploy', '--secrets-file', file);
} finally {
  rmSync(directory, {recursive: true, force: true});
}
