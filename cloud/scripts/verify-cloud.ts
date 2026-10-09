import {setTimeout as delay} from 'node:timers/promises';
import {API_ORIGIN, SITE_ORIGIN, WWW_HOST, ACCESS_ISSUER, LEGACY_BASE} from '../shared/urls.ts';

const legacy = `https://ostro.ws${LEGACY_BASE}`;
export async function verifyCloud(token: string, expected: {SUMMARY_MODE: string; OPENAI_MODEL: string}): Promise<void> {
  const request = (url: string, init: RequestInit = {}) => fetch(url,
    {...init, signal:AbortSignal.timeout(15_000),redirect:'manual'});
  const deadline = Date.now() + 180_000;
  let lastError = '';
  do {
    try {
      // Check the edge protection rather than giving CI a browser login bypass.
      for (const url of [SITE_ORIGIN + '/',SITE_ORIGIN + '/build/app.js',`https://${WWW_HOST}/`]) {
        const response = await request(url);
        const location = new URL(response.headers.get('Location') ?? '/',url);
        if (response.status !== 302 || location.origin !== ACCESS_ISSUER || !location.pathname.startsWith('/cdn-cgi/access/login/')) throw new Error(`Access login missing at ${url}`);
      }
      const page = await request(legacy + '/');
      if (!page.ok || !(await page.text()).includes('Honeyprinter')) throw new Error('Legacy page unavailable');
      for (const base of [legacy + '/api',API_ORIGIN]) {
        const status = await request(base + '/status');
        const body = await status.json() as {cadence_seconds?:number;mode?:string;model?:string|null};
        if (!status.ok || body.cadence_seconds !== 60) throw new Error(`Status API unavailable at ${base}`);
        if (body.mode !== expected.SUMMARY_MODE || (body.mode === 'openai' && body.model !== expected.OPENAI_MODEL)) throw new Error('Deployed summarizer configuration does not match');
        for (const path of ['/events','/receipts']) {
          const response = await request(base + path,{headers:{Origin:SITE_ORIGIN}});
          const feed = await response.json() as {items?:unknown[];cursor?:number};
          if (!response.ok || !Array.isArray(feed.items) || typeof feed.cursor !== 'number') throw new Error(`${base}${path} unavailable`);
          if (response.headers.get('Access-Control-Allow-Origin') !== SITE_ORIGIN) throw new Error('Website cannot read the API');
        }
        const activityResponse = await request(base + '/activity');
        const activity = await activityResponse.json() as {ports?:unknown[];hours?:unknown[];probes?:number};
        if (!activityResponse.ok || !Array.isArray(activity.ports) || activity.hours?.length !== 24 || typeof activity.probes !== 'number') throw new Error('Activity snapshot unavailable');
        const denied = await request(base + '/probes',{method:'POST'});
        if (denied.status !== 401) throw new Error('Ingest authentication check failed');
        // An authorized but invalid body exercises validation without storing an event.
        const allowed = await request(base + '/probes',{method:'POST',
          headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
        if (allowed.status !== 400) throw new Error('Ingest token check failed');
      }
      console.log('Verified private custom domains, both APIs, CORS, and ingest authentication.');
      return;
    } catch (error) { lastError = error instanceof Error ? error.message : 'Verification failed'; }
    await delay(5000);
  } while (Date.now() < deadline);
  throw new Error(`Cloudflare production check failed: ${lastError}`);
}
