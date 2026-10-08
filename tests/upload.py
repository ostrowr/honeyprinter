#!/usr/bin/env python3
"""Real sockets: bounded batches, strict pacing, overload drops and no persistence."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def wait_for(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.02)
    raise AssertionError('timed out')


class Handler(http.server.BaseHTTPRequestHandler):
    status = 201
    records = []
    gate = threading.Event()

    def do_POST(self):
        assert self.headers['Authorization'] == 'Bearer testing'
        body = self.rfile.read(int(self.headers['Content-Length']))
        assert len(body) <= 256 * 1024
        batch = json.loads(body)
        assert batch['schema_version'] == 1 and batch['type'] == 'probe_batch'
        assert 1 <= len(batch['events']) <= 2
        status = self.status
        self.records.append((time.monotonic(), status, batch['events']))
        self.gate.wait(10)
        if any(p['details'].get('path') == '/slow' for p in batch['events']):
            time.sleep(1.2)
        self.send_response(status)
        self.end_headers()
        try:
            self.wfile.write(b'{}')
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


def has_path(path):
    return any(p['details'].get('path') == path for _, _, batch in Handler.records for p in batch)


with tempfile.TemporaryDirectory() as directory:
    directory = Path(directory)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    env = {**os.environ, 'HONEYPRINTER_INGEST_TOKEN': 'testing'}
    log_path, output_path, events_path = (directory / name for name in ('server.log', 'summaries.jsonl', 'events.jsonl'))
    args = [str(ROOT / 'target/debug/honeyprinter'), '--services', f'http:{port}', '--port-offset', '0',
            '--ingest-url', f'http://127.0.0.1:{server.server_port}/honeyprinter/api/probes',
            '--upload-capacity', '3', '--upload-batch-size', '2', '--events', str(events_path)]

    def start():
        with log_path.open('w') as log, output_path.open('w') as output:
            process = subprocess.Popen(args, cwd=directory, env=env, stdout=output, stderr=log)
        wait_for(lambda: 'listening http' in log_path.read_text())
        return process

    def stop(process):
        start = time.monotonic()
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=8) == 0
        assert time.monotonic() - start < 7, 'outages must not hang shutdown'

    def probe(path):
        with socket.create_connection(('127.0.0.1', port), timeout=3) as client:
            client.sendall(f'GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
            client.recv(2048)

    process = start()
    try:
        # Hold a request in flight: only three further events fit the upload buffer.
        probe('/first')
        wait_for(lambda: len(Handler.records) == 1)
        for i in range(6):
            probe(f'/burst-{i}')
        wait_for(lambda: len(events_path.read_text().splitlines()) == 7)
        time.sleep(.05)
        Handler.gate.set()
        wait_for(lambda: len(Handler.records) == 3)
        assert [len(batch) for _, _, batch in Handler.records] == [1, 2, 1]

        # Fail a batch, then recover: the failed event is never resent.
        Handler.status = 503
        probe('/failed')
        wait_for(lambda: has_path('/failed'))
        time.sleep(.1)
        Handler.status = 201
        probe('/recovered')
        wait_for(lambda: has_path('/recovered'))

        # Slow responses must not cause catch-up requests to bunch together.
        probe('/slow')
        wait_for(lambda: has_path('/slow'))
        probe('/after-slow')
        wait_for(lambda: has_path('/after-slow'))
        times = [t for t, _, _ in Handler.records]
        assert all(b - a >= .98 for a, b in zip(times, times[1:])), times
        ids = [p['event_id'] for _, _, batch in Handler.records for p in batch]
        assert len(ids) == len(set(ids)), 'failed batches must not retry'

        # Block again and leave pending events when shutting down.
        Handler.gate.clear()
        probe('/blocked')
        wait_for(lambda: has_path('/blocked'))
        probe('/lost-on-stop')
        stop(process)
        summary = json.loads(output_path.read_text().splitlines()[-1])
        assert summary['upload_dropped'] >= 4, summary
        assert 'discarding unsent in-memory probes' in log_path.read_text()
        before_restart = len(Handler.records)
        Handler.gate.set()
        process = start()
        time.sleep(1.2)
        assert len(Handler.records) == before_restart, 'no old events survive restart'
        probe('/new-process')
        wait_for(lambda: has_path('/new-process'))
        stop(process)
        assert not list(directory.glob('*.sqlite*'))
    finally:
        Handler.gate.set()
        if process.poll() is None:
            process.kill()
            process.wait()
        server.shutdown()

print('PASS: bounded batches, >=1s request gaps, overflow/failure drops, bounded shutdown and no persistence')
