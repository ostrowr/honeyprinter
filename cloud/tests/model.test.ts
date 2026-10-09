import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mockSummary, summarize} from '../src/model.ts';
import {verifySummary} from '../scripts/verify-summary.ts';
import type {Counts, Summary} from '../shared/api.ts';

const counts: Counts = {probes: 3, sources: 2, first_ms: 1, last_ms: 60_000,
  services: [{service: 'ssh', count: 2}, {service: 'http', count: 1}],
  outcomes: [{outcome: 'completed', count: 3}], samples: []};
const env = {SUMMARY_MODE: 'openai', OPENAI_MODEL: 'gpt-6-luna', OPENAI_API_KEY: 'test-key'};
const summary: Summary = {title: 'Three knocks', body: 'Three connections across SSH and HTTP.', highlights: ['Two source addresses']};
const completed = (value: unknown) => ({status: 'completed', output: [
  {type: 'reasoning', summary: []},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]},
]});

test('Luna receives bounded structured output settings and separate untrusted telemetry', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-key');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const request = JSON.parse(String(init.body));
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.store, false);
    assert.deepEqual(request.reasoning, {effort: 'none'});
    assert.equal(request.max_output_tokens, 400);
    assert.equal(request.tools, undefined);
    assert.deepEqual(JSON.parse(request.input), counts);
    assert.match(request.instructions, /untrusted telemetry/);
    assert.match(request.instructions, /Never infer/);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.deepEqual(request.text.format.schema.required, ['title', 'body', 'highlights']);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.equal(request.text.format.schema.properties.title.maxLength, 60);
    assert.equal(request.text.format.schema.properties.body.maxLength, 600);
    assert.equal(request.text.format.schema.properties.highlights.maxItems, 3);
    return Response.json(completed(summary));
  });
  assert.deepEqual(await summarize(counts, env), summary);
  assert.equal(fetch.mock.callCount(), 1);
});

test('mock mode needs no key or network; invalid configuration fails before a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  assert.deepEqual(await summarize(counts, {...env, SUMMARY_MODE: 'mock', OPENAI_API_KEY: undefined}), mockSummary(counts));
  await verifySummary({...env, SUMMARY_MODE: 'mock', OPENAI_API_KEY: undefined});
  await assert.rejects(summarize(counts, {...env, OPENAI_API_KEY: undefined}), /mode\/key is not configured/);
  await assert.rejects(summarize(counts, {...env, SUMMARY_MODE: 'invalid'}), /mode\/key is not configured/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('API failures expose only status and do not retry within the minute attempt', async t => {
  for (const status of [401, 403, 404, 429, 500]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('sensitive upstream body', {status}));
    await assert.rejects(summarize(counts, env), {message: `OpenAI returned ${status}`});
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test('refusals, incomplete responses, malformed JSON, and invalid receipt shapes fail', async t => {
  const cases: [unknown, RegExp][] = [
    [{status: 'incomplete', output: completed(summary).output}, /incomplete/],
    [{status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'No'}]}]}, /refused/],
    [{status: 'completed', output: []}, /Invalid summary/],
    [completed(null), /Invalid summary/],
    [completed({...summary, highlights: [3]}), /Invalid summary/],
    [completed({...summary, body: 3}), /Invalid summary/],
    [completed({...summary, title: '\u001b\u202e'}), /Empty summary/],
  ];
  for (const [result, expected] of cases) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(result));
    await assert.rejects(summarize(counts, env), expected);
    fetch.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(summarize(counts, env), {message: 'Invalid OpenAI response'});
});

test('receipt text removes printer and Unicode controls and stays within print limits', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(completed({
    title: '\u001b\u202e' + 'x'.repeat(80), body: 'a\u0000\u0085\u2066\n' + 'y'.repeat(700),
    highlights: ['first\nline', 'z'.repeat(150), 'third', 'fourth'],
  })));
  const result = await summarize(counts, env);
  assert.equal(result.title.length, 60);
  assert.equal(result.body.length, 600);
  assert.deepEqual(result.highlights, ['first line', 'z'.repeat(120), 'third']);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(result.title + result.body + result.highlights.join('')));
});

test('CI preflight calls the summarizer and propagates errors before deployment', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(completed(summary)));
  await verifySummary(env);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 403}));
  await assert.rejects(verifySummary(env), /OpenAI returned 403/);
});

test('deployment with no OpenAI key fails before invoking Wrangler', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/deploy.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, GITHUB_ACTIONS: 'true', CLOUDFLARE_API_TOKEN: 'test-only',
      HONEYPRINTER_INGEST_TOKEN: 'test-only', OPENAI_API_KEY: '', SUMMARY_MODE: 'openai', PATH: ''},
    stdio: 'pipe', timeout: 5000,
  }), (error: unknown) => {
    assert.match(String((error as {stderr: Buffer}).stderr), /Missing GitHub Actions secret: OPENAI_API_KEY/);
    return true;
  });
});
