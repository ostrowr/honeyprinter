# Physical printer

The current hardware is a MUNBYN ITPP098P thermal receipt printer, connected by
USB to a Mac and driven through CUPS. Commands below run from the repository root.
The Raspberry Pi queue consumer currently emits text to stdout; its physical
printer adapter is still to be implemented.

## Preview or print one physical receipt

The MUNBYN ITPP098P connected to this Mac is the CUPS printer `Printer_POS_80`.
Use Node 24+ from the repository root:

```sh
# Preview the most recent traffic report, without touching the queue or printer:
node cloud/scripts/print-receipt.ts --latest
node cloud/scripts/print-receipt.ts --latest --output /tmp/honeyprinter-receipt.txt

# Submit exactly one physical receipt when ready:
node cloud/scripts/print-receipt.ts --latest --printer Printer_POS_80
```

`--file receipt.json` renders a saved receipt instead of fetching the public feed.
`--timezone` defaults to `America/Los_Angeles`. The layout uses the printer's native
48-column Font A, a larger masthead, exact port counts, summary text, and up to four
distinct sampled probes including full IPs, paths, banners, and exchange metrics.
Older receipts without port totals fall back to service counts. The preview can
enrich older samples from retained events in that same receipt's event range;
it only reconstructs port totals when every event in the range is available.
All dynamic text is converted to printable ASCII before encoding ESC/POS.

Preview is the default; `--printer` is required for physical output. A successful
command means CUPS accepted one job, not proof that paper emerged. This command
does not poll, install a background service, acknowledge queue messages, or enable
minutely printing. See [the cloud service setup](website.md#deploy-through-ci) for Luna summaries.

## Live printing on this Mac

`cloud/scripts/print-live.ts` polls the newest public receipt, including quiet-minute
reports, and submits at most one job per 60 seconds to CUPS. Run it as a single
launchd job, not alongside another physical printer consumer. It saves the last
attempt before submitting, skips receipts older than two minutes, and waits while
this printer has any pending jobs. Restarting or reconnecting prints fresh reports
without replaying old ones. Failed or interrupted submissions can drop a receipt.
This temporary Mac setup reads the public feed and does not consume the Pi queue
or require Cloudflare credentials.

The installed job is `ws.honeyprinter.print`, with a ten-second polling interval;
the persisted cooldown enforces the printing interval. It runs while this Mac is
awake and the user is logged in, and starts again at login. State and logs are in
`~/Library/Application Support/Honeyprinter/`.

```sh
# Pause automatic printing, including after the next login:
launchctl disable "gui/$(id -u)/ws.honeyprinter.print"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ws.honeyprinter.print.plist"
# Resume printing:
launchctl enable "gui/$(id -u)/ws.honeyprinter.print"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ws.honeyprinter.print.plist"
# Inspect its status:
launchctl print "gui/$(id -u)/ws.honeyprinter.print"
```

The LaunchAgent uses the installed Node 24 executable and the current checkout.
Update its paths if Node or the checkout moves. Running `print-live.ts --help`
shows the equivalent one-poll command.

## Read the queue to stdout

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

[Back to Honeyprinter](../README.md)
