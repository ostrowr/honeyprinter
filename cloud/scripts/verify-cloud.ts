import {setTimeout as delay} from 'node:timers/promises';
import {API_ORIGIN, SITE_ORIGIN, WWW_HOST, LEGACY_BASE} from '../shared/urls.ts';

const legacy = `https://ostro.ws${LEGACY_BASE}`;
export async function verifyCloud(token: string, expected: {SUMMARY_MODE: string; OPENAI_MODEL: string}): Promise<void> {
  const request = (url: string, init: RequestInit = {}) => fetch(url,
    {...init, signal:AbortSignal.timeout(15_000),redirect:'manual'});
  const deadline = Date.now() + 180_000;
  let lastError = '';
  do {
    try {
      for (const [path, contentType] of [['/','text/html'],['/style.css','text/css'],['/build/app.js','javascript'],['/real-honeyprinter-thumb.webp','image/webp'],['/real-honeyprinter.jpg','image/jpeg']]) {
        const response = await request(SITE_ORIGIN + path);
        if (response.status !== 200 || !response.headers.get('Content-Type')?.includes(contentType)) throw new Error(`Public website unavailable at ${path}`);
        if (response.headers.get('X-Robots-Tag')?.includes('noindex')) throw new Error('Website still marked private');
        if (path === '/') {
          if (!(await response.text()).includes('for a full data dump')) throw new Error('Footer contact missing');
        } else await response.body?.cancel();
      }
      const www = await request(`https://${WWW_HOST}/?receipt=12`);
      if (www.status !== 308 || www.headers.get('Location') !== `${SITE_ORIGIN}/?receipt=12`) throw new Error('WWW redirect missing');
      for (const [path, destination] of [['','/'],['/?receipt=12','/?receipt=12'],['/build/app.js','/build/app.js']]) {
        const page = await request(legacy + path);
        if (page.status !== 308 || page.headers.get('Location') !== SITE_ORIGIN + destination) throw new Error('Legacy website redirect missing');
      }
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
      console.log('Verified public pages and assets, legacy website redirects, both APIs, CORS, and ingest authentication.');
      return;
    } catch (error) { lastError = error instanceof Error ? error.message : 'Verification failed'; }
    await delay(5000);
  } while (Date.now() < deadline);
  throw new Error(`Cloudflare production check failed: ${lastError}`);
}
