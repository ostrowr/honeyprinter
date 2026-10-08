#!/usr/bin/env python3
"""Pull Cloudflare print jobs into SQLite and render to stdout, at most once/minute.

No printer driver yet. Acknowledgment means durably saved locally, not printed.
The printing marker is committed BEFORE output: after a crash an uncertain job
stays held for manual review, instead of automatically printing a duplicate.
"""
import argparse
import base64
import fcntl
import json
import os
import sqlite3
import sys
import textwrap
import time
import urllib.request


def open_db(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS jobs (
        receipt_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, last_attempt REAL NOT NULL);
      INSERT OR IGNORE INTO state VALUES (1, 0);
    ''')
    return db


def decode(message):
    body = message['body']
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            body = json.loads(base64.b64decode(body, validate=True))
    if (not isinstance(body, dict) or body.get('type') != 'receipt'
            or not isinstance(body.get('receipt_id'), str)
            or len(body['receipt_id']) > 100
            or not isinstance(body.get('created_at_ms'), int)
            or not isinstance(body.get('summary'), dict)):
        raise ValueError('invalid receipt envelope')
    summary = body['summary']
    if (not isinstance(summary.get('title'), str) or not isinstance(summary.get('body'), str)
            or not isinstance(summary.get('highlights'), list)
            or any(not isinstance(h, str) for h in summary['highlights'])):
        raise ValueError('invalid receipt summary')
    if len(json.dumps(body)) > 32000:
        raise ValueError('receipt too large')
    return body


def accept(db, messages):
    acks = []
    with db:
        for message in messages:
            try:
                receipt = decode(message)
                db.execute('INSERT OR IGNORE INTO jobs(receipt_id, created_ms, payload) VALUES (?, ?, ?)',
                           (receipt['receipt_id'], receipt['created_at_ms'], json.dumps(receipt)))
                acks.append({'lease_id': message['lease_id']})
            except (ValueError, KeyError, TypeError):
                print('Invalid queue message; leaving unacknowledged', file=sys.stderr)
    return acks  # caller must send acks only AFTER the transaction commits


def render(receipt):
    def clean(value):
        return ''.join(c for c in str(value) if c.isprintable())
    summary = receipt['summary']
    lines = ['HONEYPRINTER'.center(32), '-' * 32, clean(receipt['receipt_id']), '']
    for value in [summary['title'], summary['body'], *summary['highlights'][:3]]:
        lines.extend(textwrap.wrap(clean(value)[:600], 32))
        lines.append('')
    lines.extend(['-' * 32, 'THANK YOU FOR CONNECTING'.center(32), ''])
    return '\n'.join(lines)


def print_one(db, now=None, output=None):
    now = time.time() if now is None else now
    output = sys.stdout if output is None else output
    with db:
        last = db.execute('SELECT last_attempt FROM state WHERE id = 1').fetchone()[0]
        if now - last < 60:
            return False
        job = db.execute("SELECT receipt_id, payload FROM jobs WHERE status = 'pending' ORDER BY created_ms, receipt_id LIMIT 1").fetchone()
        if not job:
            return False
        db.execute("UPDATE jobs SET status = 'printing' WHERE receipt_id = ?", (job[0],))
        db.execute('UPDATE state SET last_attempt = ? WHERE id = 1', (now,))
    output.write(render(json.loads(job[1])) + '\n')
    output.flush()
    with db:
        db.execute("UPDATE jobs SET status = 'printed' WHERE receipt_id = ?", (job[0],))
    return True


def request(base, action, token, payload):
    req = urllib.request.Request(f'{base}/{action}', data=json.dumps(payload).encode(),
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError('Cloudflare queue request failed')
    return result.get('result', {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', default='honeyprinter-pi.sqlite')
    parser.add_argument('--account-id', default=os.getenv('CLOUDFLARE_ACCOUNT_ID'))
    parser.add_argument('--queue-id', default=os.getenv('HONEYPRINTER_QUEUE_ID'))
    parser.add_argument('--once', action='store_true', help='Pull once and render at most one receipt')
    args = parser.parse_args()
    token = os.getenv('CLOUDFLARE_QUEUE_TOKEN')
    if not token or not args.account_id or not args.queue_id:
        parser.error('Set CLOUDFLARE_QUEUE_TOKEN, CLOUDFLARE_ACCOUNT_ID and HONEYPRINTER_QUEUE_ID')
    # Prevent two local processes from racing the physical printer.
    with open(args.db + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = open_db(args.db)
        uncertain = db.execute("SELECT COUNT(*) FROM jobs WHERE status = 'printing'").fetchone()[0]
        if uncertain:
            print(f'{uncertain} interrupted print(s) held for manual review', file=sys.stderr)
        base = f'https://api.cloudflare.com/client/v4/accounts/{args.account_id}/queues/{args.queue_id}/messages'
        while True:
            try:
                result = request(base, 'pull', token, {'batch_size': 10, 'visibility_timeout_ms': 60000})
                acks = accept(db, result.get('messages', []))
                if acks:
                    request(base, 'ack', token, {'acks': acks, 'retries': []})
            except Exception as error:
                # Never echo HTTP headers or credentials into logs.
                print(f'Queue poll failed ({type(error).__name__}); will retry', file=sys.stderr)
            print_one(db)
            if args.once:
                break
            time.sleep(5)


if __name__ == '__main__':
    main()
