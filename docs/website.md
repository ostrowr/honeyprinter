# Website and cloud service

The live site is [honeyprinter.com](https://honeyprinter.com/). The TypeScript
Cloudflare Worker receives probes, stores them in D1, and creates receipts for the
website and physical printer. Commands below run from the repository root unless
otherwise noted. Worker deployments happen only through GitHub Actions.

## Whole system locally

Use Node 24+, Python 3.10+, and current stable Rust. In one terminal:

```sh
cd cloud
npm ci
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run dev
```

In another terminal, at the project root:

```sh
cargo build --locked
export HONEYPRINTER_INGEST_TOKEN=local-development-token-change-me
./target/debug/honeyprinter \
  --ingest-url http://localhost:8787/honeyprinter/api/probes
```

Open `http://localhost:8787/honeyprinter/` and probe the decoy as shown below.
Wrangler's local cron can be triggered with:

```sh
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json'
```

This endpoint exists only in Wrangler development mode. It still enforces the
one-report-per-scheduled-minute limit; append `&time=<unix-milliseconds>` to test a
specific minute. Local tests never call OpenAI or publish real jobs.

## Browser scene

The printer is a Three.js scene with a constrained paper mesh. The scene and page
controls are TypeScript in `cloud/client/`; HTML and CSS live in `cloud/public/`.
Wrangler builds `client/app.ts` into a small `public/build/app.js` entry point and
a separate, dynamically loaded scene bundle. Data requests and page controls start
before Three.js initializes; the scene then restores the current receipt selection.
Generated bundles are ignored by Git. All browser assets are served by the Worker.

`npm run check` strictly type-checks the Worker, browser, scripts, and tests using
separate runtime configurations, then builds the browser bundle. API types live in
`cloud/shared/`. Node 24 runs the TypeScript scripts and tests directly; use
`npm test` for the test suite.

Use the history arrows to retract to an older receipt or feed forward to a newer
one, or drag the loose paper. **Last 24h** opens port counts, hourly activity, and
exchange outcomes. Existing receipts appear fully printed on first load; new
reports animate as they arrive. A recessed LCD shows the printer state and a
subtle progress bar based on the latest report’s creation time. The bar holds
at full if a report is late; there is no numeric countdown or preparing state.
The status light glows steadily between reports
and flickers gently while the paper moves. The receipt and connection feeds load
and retry independently. Connection log entries expand to show source ports,
precise observation times, duration, bytes in both directions, connection stage,
and recognized protocol metadata (such as request paths, user agents, and SSH
banners). New probes preserve expanded rows while the log updates. Protocol
values are bounded text; arbitrary metadata and request query strings are not
published. These details reuse existing event payloads, with no extra D1 query
or schema migration. Receipt samples stay compact.
On phones, the printer sits above compact history and log controls, with the real
printer photo visible below them. The card uses a 17 KB WebP preview; opening it
loads the original photo. Mobile rendering uses a lower pixel ratio, smaller
lighting maps, and a 30 Hz frame cap while paper physics continues at 60 Hz.
Reduced-motion preferences and **Pause motion** stop the animation while keeping the feed live.

## Domains and public website

`honeyprinter.com` serves the printer at `/`; `api.honeyprinter.com` serves
`/events`, `/receipts`, `/activity`, `/status`, and authenticated `POST /probes`.
The same Worker handles both domains and shares the existing D1 database, queue,
and minute schedule. `www.honeyprinter.com` redirects to the main domain.
The old `ostro.ws/honeyprinter/` website permanently redirects to the new domain,
preserving paths and query strings. Its `/honeyprinter/api/*` endpoints remain
available, so the EC2 uploader does not need a simultaneous update. Local development
continues to serve the page at `/honeyprinter/`.

The website and its static assets are public without a Cloudflare Access login.
The Cloudflare Access application `4387c25c-adf4-406a-8902-d93952ee6f17` has a
`Honeyprinter public website` policy (Bypass / Everyone) scoped to the apex and
`www` hostnames. The shared `Only me` policy still protects the separate Pages previews.
API reads are also public; browser CORS allows only the main site and
`https://ostro.ws`. Ingestion still requires its bearer token.

Deployment verification checks unauthenticated pages and assets, the `www` and
old website redirects, both API addresses, and ingestion authentication.
Cloudflare manages the domains' DNS and certificates.

## Deploy through CI

The production cloud resources are:

| Resource | ID |
| --- | --- |
| Account | `2a4721a7e3192e5ad893a8684bb2d2e3` |
| D1 `honeyprinter` | `0e787731-dc8c-48c9-bf83-107f1e564529` |
| Queue `honeyprinter-print` (HTTP pull enabled) | `3c46c5b8e43643fabfbf54c02f17e02e` |

1. Add `CLOUDFLARE_API_TOKEN` in the repository's Actions secrets. Scope it to this
   account and the `ostro.ws` and `honeyprinter.com` zones: Account / Workers Scripts Edit, D1 Edit, Queues Edit,
   Account Settings Read; Zone / Workers Routes Edit and Zone Read.
2. Set `HONEYPRINTER_INGEST_TOKEN` to 32 random bytes encoded as 64 hexadecimal
   characters in Actions secrets. The EC2 workflow installs the same credential
   on the honeypot automatically. Do not commit a real `.env` file.
3. To enable Luna, add `OPENAI_API_KEY` in Actions secrets with access to `gpt-6-luna`.
   Without this key, CI deploys mock summaries.
4. Set repository Actions variable `CLOUDFLARE_DEPLOY_ENABLED` to `true`.
5. Push to `main` or run **Test and deploy** with `workflow_dispatch`.

CI tests Rust, all 35 endpoints, batch pacing and overflow, the Worker/D1 flow
and the Pi stub. It
also builds a Linux x86-64 binary artifact. The deploy job applies D1 migrations,
then publishes the Worker, assets, secrets, minute cron and
`ostro.ws/honeyprinter*` route. Other website paths keep their existing routing.
`cloud/scripts/deploy.ts` refuses to deploy outside GitHub Actions.

CI selects `SUMMARY_MODE=openai` when `OPENAI_API_KEY` is present, and `mock`
otherwise. In OpenAI mode it tests a real Luna response before applying migrations
or publishing. This check creates no stored receipt or queue message. The deployment
check also verifies the live mode and model. `npm run dev` explicitly overrides
the mode to `mock`, so local development needs no API key.
The Responses API uses `gpt-6-luna`, no reasoning tokens, a 400-token output cap,
and a strict receipt schema. API errors, refusals, incomplete responses, and invalid
receipts fail the attempt; the next cron retries the unsummarized events. Counts
cover all events since the last successful summary; only eight sanitized examples
are sent. Full source IPs and bounded, recognized paths, client banners, commands,
and user agents are included in summary samples. Request query strings, bodies,
and arbitrary metadata are excluded. Port totals cover every recorded connection;
Luna is instructed not to extrapolate sample frequencies or equate a completed
decoy exchange with a compromise. A failed API call does not advance the
event cursor. No API key means no OpenAI calls in mock mode.

## Storage, delivery and the page

Connections are collected into one authenticated `POST /honeyprinter/api/probes`
per second at most, per process. Each request carries a `probe_batch` envelope
with an `events` array. The Worker validates the whole batch and inserts its
individual events with one atomic SQL statement. UUIDs deduplicate repeated
events while retained in D1. Single-probe requests remain supported. The public page reads
`GET /honeyprinter/api/events?after=<id>` and `/api/receipts?after=<id>` every five
seconds; these are independent reads and never consume queue messages. Omitting
the cursor starts with the latest 100 records. Cursors are monotonic database
IDs, so equal event timestamps cannot skip rows. Public responses omit raw
protocol metadata and include full source IP addresses. Each upload is bounded to 256 KiB and
1,000 events. Batching reduces HTTP requests and SQL calls; D1 still stores and
charges for individual event rows.

The minute cron takes a D1 lease, summarizes all new stored events, and atomically
saves the receipt and advances its cursor. Receipt rows double as a durable
queue outbox: a failed send retries later. A crash after sending can duplicate a
queue message, so the Pi deduplicates by `receipt_id`. A delayed cron summarizes
the accumulated backlog together; there is no promise of a clock-exact minute.
The cron uses the scheduled UTC minute to avoid skipped reports when invocations
arrive slightly early. Repeated or older triggers cannot create another report
for the same minute. The Pi enforces at least 60 seconds between physical prints.
Quiet minutes produce a stored, deterministic report for the webpage without an
OpenAI call or queue message. Their event bounds both equal the last consumed
event cursor, and they do not advance that cursor.

The daily activity snapshot uses compact per-minute port/outcome totals, refreshed
by cron. Page requests read one saved snapshot rather than scanning raw events.
It covers the 24 hours ending at the latest completed minute, based on arrival
time; existing consumed events are backfilled by the first cron after deployment. The totals
expire after their 24-hour window.

Default retention is seven days for summarized events, quiet reports, and enqueued receipts.
Cleanup checks the oldest row and removes bounded chunks, avoiding full-table
scans every minute. Unsummarized events and traffic receipts waiting to enqueue are preserved even
past retention. The public API serves at most 100 rows per request. Queue
retention is separately controlled by Cloudflare; delivery after that expiry is
not guaranteed. Retained D1 receipts are available for manual replay. UUID
deduplication likewise lasts only as long as the retained event.

The Rust uploader defaults to **256 events per batch**, **1,024 waiting events**,
and **at least one second between requests**, including after slow responses.
There are no catch-up bursts or automatic HTTP retries. Empty buffers send
nothing. Tune these limits with `--upload-batch-size` (1–1,000),
`--upload-capacity`, and `--upload-interval-secs` (1–60). The byte limit also
bounds large batches; an event that would overflow the batch is dropped.

If the buffer is full, newly arriving events are dropped. A timeout or any
non-2xx response drops the batch, including authentication and rate-limit
errors. Drops increment `upload_dropped` in local diagnostic summaries; failed
requests also log a warning. Listeners and local diagnostics continue during an
outage. Shutdown allows five seconds to flush pending uploads before discarding
them; a restart has no events to replay. The cloud summaries count only events
that actually reached D1, so they may undercount heavy traffic. The uploader
requires HTTPS except on localhost and never follows redirects with its token.

## Checks

```sh
cd cloud
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

[Back to Honeyprinter](../README.md)
