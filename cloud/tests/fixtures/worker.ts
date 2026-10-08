import worker, {tick, type Env} from '../../src/index.ts';

// Run scheduled work through a test-only route and record deliveries in local D1.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/__test/tick') return worker.fetch(request, env);
    try {
      await tick({
        ...env,
        SUMMARY_MODE: url.searchParams.get('mode') || env.SUMMARY_MODE,
        PRINT_QUEUE: {
          async send(body) {
            if (url.searchParams.has('fail')) throw new Error('queue offline');
            await env.DB.prepare('INSERT INTO delivered(payload) VALUES (?)').bind(JSON.stringify(body)).run();
            return {metadata: {metrics: {backlogCount: 0, backlogBytes: 0}}};
          },
        },
      });
      return new Response('ok');
    } catch {
      return new Response('failed', {status: 503});
    }
  },
} satisfies ExportedHandler<Env>;
