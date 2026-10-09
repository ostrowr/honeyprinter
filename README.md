# Honeyprinter

A small Rust binary that exposes deliberately shallow TCP protocol decoys and turns
connections into structured probe events. No real shells, databases, mailboxes,
forward proxies, or message brokers run behind the ports.

The Rust listener sends bounded batches to a TypeScript Cloudflare Worker at most
once per second. Uploads use a small in-memory buffer; excess or failed batches
are dropped. No local database or retry backlog is needed on EC2. The Worker
stores individual probes in D1, serves a live page
at `/honeyprinter/`, and makes one receipt per scheduled minute, including quiet minutes. Receipts are saved in
D1; reports with traffic also go to a Cloudflare HTTP-pull queue for the Pi. Production summaries use
GPT-6 Luna when its API key is configured; otherwise they use deterministic mock text. The Pi currently
renders receipts to stdout; the physical printer driver comes later.

The private repository is [ostrowr/honeyprinter](https://github.com/ostrowr/honeyprinter).
**Worker deployments happen only in GitHub Actions**, after all checks pass. The
live page is [ostro.ws/honeyprinter](https://ostro.ws/honeyprinter/).

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
Wrangler bundles `client/app.ts` into `public/build/app.js` automatically for development
and CI. The bundle is generated and ignored by Git. All browser assets are served
locally by the Worker.

`npm run check` strictly type-checks the Worker, browser, scripts, and tests using
separate runtime configurations, then builds the browser bundle. API types live in
`cloud/shared/`. Node 24 runs the TypeScript scripts and tests directly; use
`npm test` for the test suite.

Use the history arrows to retract to an older receipt or feed forward to a newer
one. Drag the paper or click the orange button on the printer to replay a receipt.
The keyboard-accessible **Feed paper** control does the same thing. Replays only
animate the webpage; they do not enqueue physical print jobs. Reduced-motion
preferences and **Pause motion** stop the animation while keeping the feed live.

## Deploy through CI

The production cloud resources are:

| Resource | ID |
| --- | --- |
| Account | `2a4721a7e3192e5ad893a8684bb2d2e3` |
| D1 `honeyprinter` | `0e787731-dc8c-48c9-bf83-107f1e564529` |
| Queue `honeyprinter-print` (HTTP pull enabled) | `3c46c5b8e43643fabfbf54c02f17e02e` |

1. Add `CLOUDFLARE_API_TOKEN` in the repository's Actions secrets. Scope it to this
   account and `ostro.ws`: Account / Workers Scripts Edit, D1 Edit, Queues Edit,
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
are sent. Full source IPs are included in the public API and summary samples; raw
protocol metadata is excluded from both. A failed API call does not advance the
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

## Read the production receipt queue without a Pi

From the repository root, using Node 24 and your existing Wrangler login:

```sh
npm --prefix cloud ci
node cloud/scripts/read-queue.ts --wrangler
# Pull and acknowledge at most one receipt, then exit:
node cloud/scripts/read-queue.ts --wrangler --once
# Machine-readable receipt output:
node cloud/scripts/read-queue.ts --wrangler --once --json
```

Without `--wrangler`, load an account-scoped Queues Edit token into
`CLOUDFLARE_QUEUE_TOKEN`. The account and queue IDs default to this project.
Continuous mode polls every five seconds when empty and prints at most once per
minute. It decodes Cloudflare's base64 JSON and acknowledges only after stdout
accepts the receipt. Invalid messages remain unacknowledged. Recent receipt IDs
are deduplicated in memory; a restart or an acknowledgment failure may redeliver.
This is a disposable terminal reader. Run it **instead of** the Pi: concurrent
consumers divide jobs between them. The website reads D1 and never drains jobs.

## Pi software stub

Use a separate Cloudflare API token scoped to this account with Queues Edit
(read plus write, because acknowledging mutates the queue). Keep it off the
public webpage and the honeypot. On the Pi:

```sh
export CLOUDFLARE_ACCOUNT_ID=2a4721a7e3192e5ad893a8684bb2d2e3
export HONEYPRINTER_QUEUE_ID=3c46c5b8e43643fabfbf54c02f17e02e
# Load CLOUDFLARE_QUEUE_TOKEN from a private environment file.
python3 pi/agent.py --db /path/to/persistent/honeyprinter-pi.sqlite
```

The agent commits jobs locally before acknowledging them and emits at most one
plain-text receipt per minute. Run only one Pi consumer for one printer. Printed
job IDs are retained for deduplication. A crash during output leaves a `printing`
row held for manual review; exactly-once physical printing cannot be guaranteed
without printer support. Inspect that row before resetting its status to
`pending`. The physical USB/serial/network adapter remains intentionally deferred.

## Run locally

Install a recent stable Rust toolchain, then:

```sh
cargo build --release --locked
./target/release/honeyprinter --events probes.jsonl
```

Defaults: bind **127.0.0.1**, expose every service at its standard port **plus
10000**, allow 128 active connections, cap application reads at 8 KiB per
connection, and close connections after five seconds including TLS negotiation.
Diagnostics go to stderr; summaries go to stdout. No output is emitted for an
empty minute. `--events -` puts individual probe events on stdout as well; these
are queue diagnostics, not printable receipts.

In another terminal:

```sh
curl http://127.0.0.1:10080/.env
curl -k https://127.0.0.1:10443/
printf 'SSH-2.0-local-test\r\n' | nc 127.0.0.1 10022
printf 'PING\r\nQUIT\r\n' | nc 127.0.0.1 16379
```

The HTTP response is intentionally a 404. TLS uses a fresh self-signed certificate
at startup, so clients that require a trusted certificate may stop at TLS.

For repeated probes, Node 24 can run the dependency-free TypeScript script:

```sh
# Copy the stable Elastic IP from the EC2 deployment summary.
export HONEYPOT_IP=YOUR_ELASTIC_IP
# 200 connections across 12 protocols, at most 10 starts/second.
node infra/scripts/probe.ts "$HONEYPOT_IP" --count 200 --rate 10

# Local listener using its default port offset.
node infra/scripts/probe.ts 127.0.0.1 --port-offset 10000 --count 24

# Pick a mix or increase concurrency for a burst.
node infra/scripts/probe.ts "$HONEYPOT_IP" --services http,https,ssh,redis --count 500 --rate 50 --concurrency 16
node infra/scripts/probe.ts --help
```

Terraform retains the Elastic IP across instance replacements.
The script varies HTTP paths and reports expected responses and failures per
protocol. Protocol-level rejections are expected for these decoys. Each probe has
a deadline, active sockets and response sizes are bounded, and Ctrl-C stops new
probes while letting active ones finish. No credentials or dependencies are needed.
Production sends probes to Cloudflare in bounded batches; local minute diagnostics
also remain available through `journalctl -u honeyprinter -f -o cat`.

Select services or override ports:

```sh
./target/release/honeyprinter --list
./target/release/honeyprinter --services ssh,http,https,mysql,postgres,mongodb,redis
./target/release/honeyprinter --port-offset 0 --services http:18080,ssh:12222 --events -
./target/release/honeyprinter --help
```

Port overrides also receive `--port-offset`; use zero for exact custom ports.
All requested ports must bind successfully before the server accepts traffic.
A conflict or invalid configuration exits with an error.

## Services

35 endpoints share 24 minimal protocol handlers. The table lists standard ports,
before the development offset. Every endpoint uses TCP; no UDP sockets are opened.

| Service names | Standard ports | Implemented exchange |
| --- | --- | --- |
| `ftp` | 21 | Greeting, USER/PASS rejection, SYST/FEAT/QUIT |
| `ssh` | 22 | Identification banners only; no key exchange or login |
| `telnet` | 23 | Negotiation bytes, login prompt, rejection |
| `smtp`, `submission`, `smtps` | 25, 587, 465 | EHLO/HELO, NOOP/RSET/QUIT; rejects authentication and delivery |
| `http`, `http-alt`, `https`, `https-alt` | 80, 8080, 443, 8443 | One HTTP/1.x request, fixed 404; HEAD has no body |
| `docker`, `elasticsearch` | 2375, 9200 | Generic HTTP decoys on these ports, not Docker/Elasticsearch APIs |
| `pop3`, `pop3s` | 110, 995 | CAPA, USER/PASS rejection, QUIT |
| `imap`, `imaps` | 143, 993 | Tagged CAPABILITY/NOOP/LOGOUT, rejects login |
| `ldap`, `ldaps` | 389, 636 | BER framing and message IDs; bind/search/extended-operation errors |
| `smb` | 445 | SMB2 header recognition and correlated STATUS_NOT_SUPPORTED; no SMB1 |
| `rtsp` | 554 | Request parsing, 401 with CSeq |
| `socks5` | 1080 | Method negotiation, no acceptable authentication method |
| `mssql` | 1433 | Single-packet TDS PRELOGIN response only |
| `mqtt`, `mqtts` | 1883, 8883 | MQTT 3.1/3.1.1/5 CONNECT framing and rejected CONNACK |
| `http-proxy` | 3128 | 407; never opens an upstream connection |
| `mysql` | 3306 | Protocol 10 greeting and authentication error |
| `rdp` | 3389 | TPKT/X.224 connection request and RDP negotiation failure |
| `sip` | 5060 | Request headers and 501 response |
| `postgres` | 5432 | SSL/GSS refusal and protocol 3 startup error |
| `amqp` | 5672 | AMQP 0-9-1 connection.start, followed by connection.close |
| `vnc` | 5900 | RFB version exchange and rejected security negotiation |
| `redis` | 6379 | RESP/inline command parsing, PING/QUIT, NOAUTH |
| `irc` | 6667 | NOTICE greeting and connection rejection |
| `memcached` | 11211 | ASCII VERSION, empty STATS/GET, QUIT; no storage |
| `mongodb` | 27017 | OP_MSG and legacy OP_QUERY hello/isMaster/ping replies; rejects other commands |

TLS endpoints complete actual TLS using rustls, then share the plaintext handler.
STARTTLS upgrades and database TLS upgrades are not implemented. These decoys are
enough for initial protocol interactions; they are not full server emulators and
some clients or scanners will identify their limited behavior.

## Event and queue behavior

One `probe` event is finalized when a connection finishes, fails, or times out.
It contains a UUID, Unix timestamp in milliseconds, source IP/port, actual bound
destination port, configured service, TLS status, observed stage, outcome,
duration, application byte counts, and bounded protocol metadata.

`service` is a listener label, **not proof that the client spoke that protocol**.
`stage` is `connected`, `tls`, or `application`; `application` means application
bytes were read, even if parsing failed. TLS errors still produce events. Byte
counts exclude TLS framing and may omit bytes buffered beyond the read budget.

Queue implementation: [`src/queue.rs`](src/queue.rs). The channel defaults to
1024 events (`--queue-capacity`). When full, new events are dropped and counted;
listeners do not block on the queue. Connections beyond `--max-connections` are
closed and counted separately, without an individual event. A full or blocked
output sink causes an error and process exit rather than silently continuing.

Minute summaries contain exact counts of dequeued events by service and outcome,
the first eight example events, queue-drop/rejected-connection counts, and up to
1024 distinct source IPs. The source count is explicitly marked as a lower bound
if that set fills. Windows use dequeue time, so delayed or unfinished connections
can appear in the next window. `--summary-secs` may increase the interval, but
cannot reduce it below 60 seconds.

SIGINT/SIGTERM stops listeners, lets active connections finish within their
existing deadlines, drains the queue, and emits a `shutdown_summary` diagnostic.
Local `minute_summary` and `shutdown_summary` output are diagnostics only. The
cloud receipt stream is the only input to the Pi. Neither local diagnostic
summaries nor JSONL event logs invoke an LLM.

Without `--ingest-url`, the queue remains an in-memory mock. With cloud delivery,
events become durable only after reaching D1. An optional JSONL log
is diagnostic storage, with no replay, fsync, retention, or rotation; rotate or
remove it during longer experiments.

## Input limits and metadata

Connections have a total deadline, a bounded read budget, a 2 KiB line limit,
bounded command counts, and a 16 KiB response budget. Binary length fields are
checked before allocating their bodies. No payload is executed or forwarded.

Logs retain selected metadata rather than raw packets: HTTP method/path/host/user
agent, SSH banner, command names, protocol versions, etc. HTTP query strings,
cookies, authorization headers, login arguments, and database authentication
responses are not retained. Printable metadata is capped at 160 characters per
field with control characters removed. All client metadata remains untrusted;
do not interpolate it into shell commands or send it as raw printer instructions.
Clients can put sensitive text in arbitrary fields, so this is field selection,
not a general-purpose secret detector.

This version observes **completed TCP connections**, including ones carrying no
payload. SYN-only scans, blocked security-group traffic, and UDP probes do not
generate events. Packet capture is a separate follow-up component.

## EC2 / Linux

Build on the target Linux architecture. The locally built macOS executable is
not an EC2 binary. For standard privileged ports, grant only the bind capability
to the built executable and run as an ordinary dedicated user:

```sh
cargo build --release --locked
sudo setcap 'cap_net_bind_service=+ep' target/release/honeyprinter
./target/release/honeyprinter --bind 0.0.0.0 --port-offset 0 --events probes.jsonl
```

Replacing/rebuilding the executable requires reapplying the capability. Port 22
will conflict with a real SSH daemon; arrange a separate administrative route
before using it for the decoy. Configure the EC2 security group for the chosen
TCP ports. Binding `0.0.0.0` only exposes IPv4; use `--bind ::` for IPv6, with
dual-stack behavior depending on the operating system. A systemd unit template
is in `deploy/honeyprinter.service`; it uses a dedicated user and only the bind
capability. The listener needs no writable state directory. Install the Linux binary at
`/usr/local/bin/honeyprinter` and use a root-owned mode-600
`/etc/honeyprinter.env` containing `HONEYPRINTER_INGEST_TOKEN`. Terraform deployment and a TypeScript CDK comparison are in [`infra/`](infra/README.md). The dedicated EC2 workflow builds a static Rust binary, applies Terraform through GitHub OIDC, and verifies the running service. It then enables Cloudflare delivery with a root-only credential file and checks that real public probes appear in the live feed. Run it explicitly with `gh workflow run deploy-ec2.yml --repo ostrowr/honeyprinter --ref main`.

## Verification

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
python3 tests/smoke.py --check-minute
python3 tests/upload.py
python3 -m unittest discover -s pi -v
cd cloud
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

The Python test uses only the standard library and temporary loopback listeners.
It checks all 35 endpoints, real TLS, fragmented frames, oversized lengths,
deadlines, authentication-field redaction, event IDs, queue totals, a real
60-second summary, graceful shutdown, and atomic startup failure. Omit
`--check-minute` for a faster protocol-only run.

Wire references: [SSH](https://www.rfc-editor.org/rfc/rfc4253),
[MySQL](https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase.html),
[PostgreSQL](https://www.postgresql.org/docs/current/protocol-message-formats.html),
[MongoDB](https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/),
[MQTT 5](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html),
[LDAP](https://www.rfc-editor.org/rfc/rfc4511),
[AMQP](https://www.rabbitmq.com/amqp-0-9-1-protocol).
