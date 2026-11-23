# Rust listener

A small Rust binary exposes deliberately shallow TCP protocol decoys and records
structured probe events. It runs no real shells, databases, mailboxes, forward
proxies, or message brokers. Commands below run from the repository root.

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

## Event and queue behavior

One `probe` event is finalized when a connection finishes, fails, or times out.
It contains a UUID, Unix timestamp in milliseconds, source IP/port, actual bound
destination port, configured service, TLS status, observed stage, outcome,
duration, application byte counts, and bounded protocol metadata.

`service` is a listener label, **not proof that the client spoke that protocol**.
`stage` is `connected`, `tls`, or `application`; `application` means application
bytes were read, even if parsing failed. TLS errors still produce events. Byte
counts exclude TLS framing and may omit bytes buffered beyond the read budget.

Queue implementation: [`src/queue.rs`](../src/queue.rs). The channel defaults to
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
`/etc/honeyprinter.env` containing `HONEYPRINTER_INGEST_TOKEN`. Terraform deployment and a TypeScript CDK comparison are in [`infra/`](../infra/README.md). The dedicated EC2 workflow builds a static Rust binary, applies Terraform through GitHub OIDC, and verifies the running service. It then enables Cloudflare delivery with a root-only credential file and checks that real public probes appear in the live feed. Run it explicitly with `gh workflow run deploy-ec2.yml --repo ostrowr/honeyprinter --ref main`.

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

[Supported services](../README.md#services) · [Cloud delivery](website.md) · [Back to Honeyprinter](../README.md)
