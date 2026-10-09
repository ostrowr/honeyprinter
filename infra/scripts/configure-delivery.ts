import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Run only in CI. Secrets travel through the existing private, encrypted release
// bucket; only the object path enters Terraform or Systems Manager command logs.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Configure delivery through GitHub Actions only');
const token = process.env.HONEYPRINTER_INGEST_TOKEN;
if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('HONEYPRINTER_INGEST_TOKEN must contain 32 random bytes encoded as hex');
const bucket = process.env.TF_VAR_artifact_bucket;
const artifact = process.env.TF_VAR_artifact_key;
if (bucket !== 'honeyprinter-artifacts-316658062409-us-west-2' || !artifact || !/^releases\/[a-f0-9]{40}\/[0-9]+-[0-9]+\/honeyprinter$/.test(artifact)) throw new Error('Invalid release location');
const key = `${artifact}.env`;
const url = 'https://ostro.ws/honeyprinter/api/probes';

function aws<T>(args: string[]): T {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--region', 'us-west-2', '--output', 'json', '--no-cli-pager'],
      {encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe']})) as T;
  } catch { throw new Error(`AWS ${args[0]} ${args[1]} failed`); }
}
const outputs = JSON.parse(execFileSync('terraform', ['-chdir=infra/terraform', 'output', '-json'], {encoding: 'utf8'})) as {instance_id: {value: string}};
const instance = outputs.instance_id.value;
if (!/^i-[a-f0-9]+$/.test(instance)) throw new Error('Invalid instance ID');
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  const status = aws<{InstanceInformationList: {PingStatus: string}[]}>(['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${instance}`]);
  if (status.InstanceInformationList.some(node => node.PingStatus === 'Online')) break;
  if (Date.now() > deadline) throw new Error('SSM registration timed out');
  await delay(5000);
}

const directory = mkdtempSync(join(tmpdir(), 'honeyprinter-delivery-'));
try {
  const file = join(directory, 'honeyprinter.env');
  writeFileSync(file, `HONEYPRINTER_INGEST_TOKEN=${token}\n`, {mode: 0o600});
  aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file,
    '--server-side-encryption', 'AES256', '--if-none-match', '*']);
} finally { rmSync(directory, {recursive: true, force: true}); }

const commands = [
  'set -eu', 'umask 077', 'cloud-init status --wait',
  `aws s3 cp 's3://${bucket}/${key}' /etc/honeyprinter.env.new --region us-west-2 --only-show-errors`,
  'chmod 600 /etc/honeyprinter.env.new', 'chown root:root /etc/honeyprinter.env.new',
  'mv /etc/honeyprinter.env.new /etc/honeyprinter.env',
  'mkdir -p /etc/systemd/system/honeyprinter.service.d',
  `cat > /etc/systemd/system/honeyprinter.service.d/delivery.conf <<'UNIT'\n[Service]\nEnvironmentFile=/etc/honeyprinter.env\nExecStart=\nExecStart=/usr/local/bin/honeyprinter --bind 0.0.0.0 --port-offset 0 --ingest-url ${url}\nUNIT`,
  'systemctl daemon-reload', 'systemctl restart honeyprinter',
  'systemctl is-active --quiet honeyprinter', "echo 'Cloudflare delivery configured'",
];
const sent = aws<{Command: {CommandId: string}}>(['ssm', 'send-command', '--instance-ids', instance,
  '--document-name', 'AWS-RunShellScript', '--comment', 'Configure Honeyprinter Cloudflare delivery',
  '--timeout-seconds', '600', '--parameters', JSON.stringify({commands, executionTimeout: ['600']})]);
const done = Date.now() + 11 * 60_000;
for (;;) {
  let result: {Status: string} | undefined;
  try { result = aws(['ssm', 'get-command-invocation', '--command-id', sent.Command.CommandId, '--instance-id', instance]); }
  catch { /* A new command can briefly be absent from the invocation API. */ }
  if (result?.Status === 'Success') break;
  if (result && !['Pending', 'InProgress', 'Delayed'].includes(result.Status)) throw new Error(`Delivery setup failed: ${result.Status}; inspect SSM command ${sent.Command.CommandId}`);
  if (Date.now() > done) throw new Error('Delivery setup timed out');
  await delay(5000);
}
console.log(`Cloudflare delivery enabled on ${instance}; credentials kept out of Terraform state and command output.`);
