import {setTimeout as delay} from 'node:timers/promises';

const base = 'https://ostro.ws/honeyprinter';
export async function verifyCloud(token: string, expected: {SUMMARY_MODE: string; OPENAI_MODEL: string}): Promise<void> {
  const request = (path: string, init: RequestInit = {}) => fetch(base + path,
    {...init, signal: AbortSignal.timeout(15_000), redirect: 'error'});
  const deadline = Date.now() + 180_000;
  let lastError = '';
  do {
    try {
      const page = await request('/');
      if (!page.ok || !(await page.text()).includes('Honeyprinter')) throw new Error('Page unavailable');
      const status = await request('/api/status');
      const body = await status.json() as {cadence_seconds?: number; mode?: string; model?: string | null};
      if (!status.ok || body.cadence_seconds !== 60) throw new Error('Status API unavailable');
      if (body.mode !== expected.SUMMARY_MODE || (body.mode === 'openai' && body.model !== expected.OPENAI_MODEL)) throw new Error('Deployed summarizer configuration does not match');
      for (const path of ['/api/events', '/api/receipts']) {
        const response = await request(path);
        const feed = await response.json() as {items?: unknown[]; cursor?: number};
        if (!response.ok || !Array.isArray(feed.items) || typeof feed.cursor !== 'number') throw new Error(`${path} unavailable`);
      }
      const denied = await request('/api/probes', {method: 'POST'});
      if (denied.status !== 401) throw new Error('Ingest authentication check failed');
      // An authorized but invalid body must reach validation, without storing a fake event.
      const allowed = await request('/api/probes', {method: 'POST',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: '{}'});
      if (allowed.status !== 400) throw new Error('Ingest token check failed');
      console.log(`Verified ${base}/: page, D1 feeds, status, and ingest authentication (${body.mode} summaries).`);
      return;
    } catch (error) { lastError = error instanceof Error ? error.message : 'Verification failed'; }
    await delay(5000);
  } while (Date.now() < deadline);
  throw new Error(`Cloudflare production check failed: ${lastError}`);
}
