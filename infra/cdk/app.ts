import { App } from 'aws-cdk-lib';
import { HoneyprinterStack } from './stack.ts';

const app = new App();
function input(name: string, pattern: RegExp): string {
  const value: unknown = app.node.tryGetContext(name);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Pass a valid -c ${name}=...; see infra/README.md.`);
  }
  return value;
}

new HoneyprinterStack(app, 'Honeyprinter', {
  bucket: input('artifactBucket', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  key: input('artifactKey', /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/),
  sha256: input('artifactSha256', /^[a-f0-9]{64}$/),
}, { env: { region: 'us-west-2' } });
