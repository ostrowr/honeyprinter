#!/usr/bin/env python3
"""Actual sockets + SQLite: retry, restart, quarantine and stable event UUIDs."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
def wait_for(check, seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=check()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('timed out')

class Handler(http.server.BaseHTTPRequestHandler):
    status=503
    events=[]
    def do_POST(self):
        assert self.headers['Authorization']=='Bearer testing'
        event=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.events.append(event)
        self.send_response(self.status); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self,*args):
        pass

with tempfile.TemporaryDirectory() as directory:
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
    outbox=Path(directory)/'outbox.sqlite'
    env={**os.environ,'HONEYPRINTER_INGEST_TOKEN':'testing'}
    args=[str(ROOT/'target/debug/honeyprinter'),'--services',f'http:{port}','--port-offset','0',
          '--ingest-url',f'http://127.0.0.1:{server.server_port}/honeyprinter/api/probes','--outbox',str(outbox)]
    def start():
        log=open(Path(directory)/'server.log','a')
        process=subprocess.Popen(args,env=env,stdout=subprocess.DEVNULL,stderr=log)
        log.close()
        wait_for(lambda:'listening http' in (Path(directory)/'server.log').read_text())
        time.sleep(.15)
        return process
    def stop(process):
        process.send_signal(signal.SIGTERM); assert process.wait(timeout=10)==0
    def probe():
        with socket.create_connection(('127.0.0.1',port),timeout=3) as client:
            client.sendall(b'GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n'); client.recv(2048)
    def rows():
        with sqlite3.connect(outbox) as db:
            return db.execute('SELECT event_id,rejected_status FROM outbox').fetchall()
    process=start()
    try:
        probe(); wait_for(lambda:len(Handler.events)>=2)
        assert Handler.events[0]['event_id']==Handler.events[1]['event_id']
        assert len(rows())==1
        stop(process)
        Handler.status=201
        process=start(); wait_for(lambda:len(rows())==0)
        assert len({e['event_id'] for e in Handler.events})==1
        Handler.status=400
        probe(); wait_for(lambda:rows() and rows()[0][1]==400)
        Handler.status=201
        probe(); wait_for(lambda:len(Handler.events)>=5 and len(rows())==1)
        assert rows()[0][1]==400, 'bad event remains quarantined, later events upload'
        stop(process)
    finally:
        if process.poll() is None: process.kill(); process.wait()
        server.shutdown()
print('Upload retry, restart recovery, stable UUID and quarantine tests passed')
