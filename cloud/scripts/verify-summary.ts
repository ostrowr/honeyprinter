import {summarize, type SummaryEnvironment} from '../src/model.ts';

// Exercise the real request before publishing; this receipt is never stored or queued.
export async function verifySummary(env: SummaryEnvironment): Promise<void> {
  if (env.SUMMARY_MODE === 'mock') return;
  const now = Date.now();
  await summarize({probes: 3, sources: 2, first_ms: now - 60_000, last_ms: now,
    services: [{service: 'ssh', count: 2}, {service: 'http', count: 1}],
    outcomes: [{outcome: 'completed', count: 3}], samples: []}, env);
  console.log(`Verified OpenAI summarizer: ${env.OPENAI_MODEL}`);
}
