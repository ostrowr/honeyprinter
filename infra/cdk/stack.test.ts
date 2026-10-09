import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import ports from '../shared/ports.json' with { type: 'json' };
import { HoneyprinterStack } from './stack.ts';

function template(sha256 = '0'.repeat(64)): Template {
  return Template.fromStack(new HoneyprinterStack(new App(), 'Test', {
    bucket: 'honeyprinter-artifacts-example', key: 'releases/example/honeyprinter', sha256,
  }, { env: { region: 'us-west-2' } }));
}

test('network admits exactly the Rust decoy catalog and only HTTPS egress', () => {
  const catalog = readFileSync(new URL('../../src/catalog.rs', import.meta.url), 'utf8');
  const rustPorts = [...catalog.matchAll(/\("[\w-]+", (\d+),/g)]
    .map(match => Number(match[1])).sort((a, b) => a - b);
  assert.deepEqual(ports, rustPorts);
  const t = template();
  t.resourceCountIs('AWS::EC2::VPC', 1);
  t.resourceCountIs('AWS::EC2::Subnet', 1);
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  t.resourceCountIs('AWS::EC2::EIP', 0);
  t.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  t.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.exact(ports.map(port => ({
      CidrIp: '0.0.0.0/0', Description: 'from 0.0.0.0/0:' + port,
      FromPort: port, ToPort: port, IpProtocol: 'tcp',
    }))),
    SecurityGroupEgress: Match.exact([{
      CidrIp: '0.0.0.0/0', Description: 'HTTPS for S3, SSM, and future Cloudflare delivery',
      FromPort: 443, ToPort: 443, IpProtocol: 'tcp',
    }]),
  });
});

test('one small hardened instance; role can download only the selected artifact', () => {
  const t = template();
  t.resourceCountIs('AWS::EC2::Instance', 1);
  t.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 't3.nano',
    KeyName: Match.absent(),
    CreditSpecification: { CPUCredits: 'standard' },
    MetadataOptions: Match.objectLike({ HttpTokens: 'required', HttpPutResponseHopLimit: 1 }),
    NetworkInterfaces: Match.arrayWith([Match.objectLike({ AssociatePublicIpAddress: true })]),
    BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: {
      Encrypted: true, VolumeSize: 8, VolumeType: 'gp3', DeleteOnTermination: true,
    } }],
  });
  t.hasResourceProperties('AWS::IAM::Role', {
    Policies: [{ PolicyName: 'Artifact', PolicyDocument: {
      Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject',
        Resource: 'arn:aws:s3:::honeyprinter-artifacts-example/releases/example/honeyprinter' }],
    } }],
  });
});

test('a changed artifact replaces the instance so first-boot installation runs again', () => {
  const before = Object.keys(template().findResources('AWS::EC2::Instance'));
  const after = Object.keys(template('1'.repeat(64)).findResources('AWS::EC2::Instance'));
  assert.notDeepEqual(before, after);
  const serialized = JSON.stringify(template().toJSON());
  assert.ok(!serialized.includes('@ARTIFACT_'));
  assert.ok(serialized.includes('sha256sum --check'));
  assert.ok(serialized.includes('systemctl disable --now sshd.service'));
  assert.ok(!serialized.includes('--ingest-url'));
});
