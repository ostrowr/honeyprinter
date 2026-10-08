#!/usr/bin/env python3
"""Real-socket protocol and lifecycle checks. Uses only Python's standard library."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import struct
import subprocess
import tempfile
import time


def exact(sock, length):
    data = b""
    while len(data) < length:
        part = sock.recv(length - len(data))
        assert part, ("unexpected EOF", length, data)
        data += part
    return data


def until(sock, suffix=b"\r\n"):
    data = b""
    while not data.endswith(suffix):
        data += exact(sock, 1)
        assert len(data) < 32768
    return data


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def mysql_packet(sock):
    header = exact(sock, 4)
    return header[3], exact(sock, int.from_bytes(header[:3], "little"))


def mongo_packet(sock):
    header = exact(sock, 16)
    length, request, response, opcode = struct.unpack("<iiii", header)
    return response, opcode, exact(sock, length - 16)


def bson_command(name):
    body = b"\x10" + name.encode() + b"\0" + struct.pack("<i", 1) + b"\0"
    return struct.pack("<i", len(body) + 4) + body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/debug/honeyprinter")
    parser.add_argument("--check-minute", action="store_true", help="also wait for a real 60-second summary")
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    catalog = subprocess.check_output([binary, "--list"], text=True).splitlines()
    names = [line.split()[0] for line in catalog]
    ports = {}
    for name in names:
        port = free_port()
        while port in ports.values():
            port = free_port()
        ports[name] = port
    context = ssl._create_unverified_context()
    exercised = set()

    def connect(name, tls=False):
        sock = socket.create_connection(("127.0.0.1", ports[name]), timeout=3)
        if tls:
            sock = context.wrap_socket(sock, server_hostname="localhost")
        exercised.add(name)
        return sock

    with tempfile.TemporaryDirectory(prefix="honeyprinter-test-") as directory:
        directory = Path(directory)
        events = directory / "events.jsonl"
        stdout = directory / "stdout.jsonl"
        stderr = directory / "stderr.txt"
        with stdout.open("w") as out, stderr.open("w") as err:
            process = subprocess.Popen([binary, "--port-offset", "0", "--services", ",".join(f"{n}:{p}" for n, p in ports.items()),
                                        "--events", str(events), "--timeout-secs", "1"], stdout=out, stderr=err)
        started = time.monotonic()
        try:
            for _ in range(200):
                assert process.poll() is None, stderr.read_text()
                if stderr.read_text().count("listening ") == len(names) and events.exists():
                    break
                time.sleep(0.02)
            else:
                raise AssertionError("server did not become ready")

            for name in ["http", "http-alt", "docker", "elasticsearch", "https", "https-alt"]:
                with connect(name, name.startswith("https")) as sock:
                    # Fragmented request, credentials deliberately excluded from metadata.
                    for piece in [b"GET /.env?token=DO_NOT_LOG_QUERY HTTP/1.1\r", b"\nHost: example.test\r\n", b"Authorization: DO_NOT_LOG_HEADER\r\nCookie: DO_NOT_LOG_COOKIE\r\nUser-Agent: smoke\r\n\r\n"]:
                        sock.sendall(piece)
                    headers = until(sock, b"\r\n\r\n")
                    assert headers.startswith(b"HTTP/1.1 404"), headers
                    assert exact(sock, 10) == b"Not found\n"
            with connect("http") as sock:
                sock.sendall(b"HEAD / HTTP/1.1\r\n\r\n")
                assert b"Content-Length: 10" in until(sock, b"\r\n\r\n")
                assert sock.recv(1) == b""
            with connect("http-proxy") as sock:
                sock.sendall(b"CONNECT example.test:443 HTTP/1.1\r\n\r\n")
                assert until(sock).startswith(b"HTTP/1.1 407")
            with connect("rtsp") as sock:
                sock.sendall(b"OPTIONS rtsp://example.test/ RTSP/1.0\r\nCSeq: 12\r\n\r\n")
                assert b"CSeq: 12\r\n" in until(sock, b"\r\n\r\n")
            with connect("sip") as sock:
                sock.sendall(b"OPTIONS sip:example.test SIP/2.0\r\nVia: SIP/2.0/TCP localhost;branch=z9hG4bK-test\r\nFrom: <sip:a@example.test>;tag=1\r\nTo: <sip:b@example.test>\r\nCall-ID: test\r\nCSeq: 1 OPTIONS\r\n\r\n")
                response = until(sock, b"\r\n\r\n")
                assert response.startswith(b"SIP/2.0 501") and b"call-id: test" in response
            with connect("ssh") as sock:
                assert until(sock).startswith(b"SSH-2.0-")
                sock.sendall(b"SSH-2.0-smoke_client\r\n")
                assert sock.recv(1) == b""
            with connect("telnet") as sock:
                until(sock, b"login: ")
                sock.sendall(b"DO_NOT_LOG_TELNET\r\n")
                assert b"Login incorrect" in until(sock, b"incorrect\r\n")
            with connect("ftp") as sock:
                assert until(sock).startswith(b"220")
                sock.sendall(b"USER DO_NOT_LOG_FTP_USER\r\nPASS DO_NOT_LOG_FTP_PASSWORD\r\n")
                assert until(sock).startswith(b"331")
                assert until(sock).startswith(b"530")
            for name in ["smtp", "submission", "smtps"]:
                with connect(name, name == "smtps") as sock:
                    assert until(sock).startswith(b"220")
                    sock.sendall(b"EHLO test\r\n")
                    assert until(sock, b"250 SIZE 0\r\n").startswith(b"250-")
                    sock.sendall(b"AUTH DO_NOT_LOG_SMTP\r\n")
                    assert until(sock).startswith(b"530")
            for name in ["pop3", "pop3s"]:
                with connect(name, name == "pop3s") as sock:
                    assert until(sock).startswith(b"+OK")
                    sock.sendall(b"USER DO_NOT_LOG_POP_USER\r\nPASS DO_NOT_LOG_POP_PASSWORD\r\n")
                    assert until(sock).startswith(b"+OK")
                    assert until(sock).startswith(b"-ERR")
            for name in ["imap", "imaps"]:
                with connect(name, name == "imaps") as sock:
                    assert until(sock).startswith(b"* OK")
                    sock.sendall(b"a1 CAPABILITY\r\na2 LOGIN user DO_NOT_LOG_IMAP\r\n")
                    assert b"IMAP4rev1" in until(sock, b"a1 OK CAPABILITY completed\r\n")
                    assert until(sock).startswith(b"a2 NO")
            with connect("redis") as sock:
                sock.sendall(b"*1\r\n$4\r\nPING\r\n")
                assert until(sock) == b"+PONG\r\n"
                sock.sendall(b"AUTH DO_NOT_LOG_REDIS\r\n")
                assert until(sock).startswith(b"-NOAUTH")
            with connect("memcached") as sock:
                sock.sendall(b"version\r\nstats\r\nquit\r\n")
                assert until(sock).startswith(b"VERSION")
                assert until(sock) == b"END\r\n"
            with connect("irc") as sock:
                assert until(sock).startswith(b":irc.local NOTICE")
                sock.sendall(b"NICK test\r\n")
                assert until(sock).startswith(b"ERROR")
            with connect("mysql") as sock:
                seq, hello = mysql_packet(sock)
                assert seq == 0 and hello.startswith(b"\x0a8.0.36\0") and hello.endswith(b"mysql_native_password\0")
                body = struct.pack("<II", 0x88200, 8192) + bytes([45]) + bytes(23) + b"DO_NOT_LOG_MYSQL_USER\0\x00"
                packet = len(body).to_bytes(3, "little") + b"\x01" + body
                for piece in [packet[:2], packet[2:10], packet[10:]]:
                    sock.sendall(piece)
                seq, error = mysql_packet(sock)
                assert seq == 2 and error.startswith(b"\xff\x15\x04#28000")
            with connect("postgres") as sock:
                sock.sendall(struct.pack("!II", 8, 80877103))
                assert exact(sock, 1) == b"N"
                body = struct.pack("!I", 196608) + b"user\0DO_NOT_LOG_PG_USER\0database\0test\0\0"
                sock.sendall(struct.pack("!I", len(body) + 4) + body)
                assert exact(sock, 1) == b"E"
                length = struct.unpack("!I", exact(sock, 4))[0]
                assert b"C28000\0" in exact(sock, length - 4)
            for name, version in [("mqtt", 4), ("mqtts", 5)]:
                with connect(name, name == "mqtts") as sock:
                    body = b"\0\x04MQTT" + bytes([version, 2, 0, 60]) + (b"\0" if version == 5 else b"") + b"\0\x04test"
                    sock.sendall(bytes([0x10, len(body)]) + body)
                    assert exact(sock, 5 if version == 5 else 4) == (b"\x20\x03\0\x87\0" if version == 5 else b"\x20\x02\0\x05")
            for name in ["ldap", "ldaps"]:
                with connect(name, name == "ldaps") as sock:
                    sock.sendall(bytes.fromhex("300c020107600702010304008000"))
                    assert exact(sock, 14) == bytes.fromhex("300c02010761070a013104000400")
            with connect("socks5") as sock:
                sock.sendall(b"\x05\x02\x00\x02")
                assert exact(sock, 2) == b"\x05\xff"
            with connect("vnc") as sock:
                assert exact(sock, 12) == b"RFB 003.008\n"
                sock.sendall(b"RFB 003.008\n")
                assert exact(sock, 1) == b"\0"
                length = struct.unpack("!I", exact(sock, 4))[0]
                assert exact(sock, length) == b"Authentication failed"
            with connect("rdp") as sock:
                sock.sendall(bytes.fromhex("030000130ee000000000000100080003000000"))
                response = exact(sock, 19)
                assert response[5] == 0xd0 and response[11:] == bytes.fromhex("0300080005000000")
            with connect("mssql") as sock:
                sock.sendall(bytes.fromhex("1201001a0000010000000b00060100110001ff0f0007d0000002"))
                assert exact(sock, 8) == bytes.fromhex("0401001a00000100")
                assert exact(sock, 18)[-1] == 2
            with connect("smb") as sock:
                body = bytearray(64)
                body[:4] = b"\xfeSMB"
                body[4] = 64
                body[24:32] = struct.pack("<Q", 12345)
                sock.sendall(struct.pack("!I", len(body)) + body)
                length = struct.unpack("!I", exact(sock, 4))[0]
                response = exact(sock, length)
                assert response[:4] == b"\xfeSMB" and response[8:12] == struct.pack("<I", 0xc00000bb)
                assert struct.unpack("<Q", response[24:32])[0] == 12345
            with connect("amqp") as sock:
                sock.sendall(b"AMQP\0\0\x09\x01")
                header = exact(sock, 7)
                frame = exact(sock, struct.unpack("!I", header[3:])[0] + 1)
                assert frame.startswith(b"\0\x0a\0\x0a\0\x09") and frame.endswith(b"\xce") and b"PLAIN" in frame
                start_ok = b"\0\x0a\0\x0b" + bytes(4) + b"\x05PLAIN" + struct.pack("!I", 24) + b"DO_NOT_LOG_AMQP_PASSWORD!" + b"\x05en_US"
                sock.sendall(b"\x01\0\0" + struct.pack("!I", len(start_ok)) + start_ok + b"\xce")
                header = exact(sock, 7)
                frame = exact(sock, struct.unpack("!I", header[3:])[0] + 1)
                assert frame.startswith(b"\0\x0a\0\x32\x01\x93")
            for opcode in [2013, 2004]:
                with connect("mongodb") as sock:
                    doc = bson_command("hello" if opcode == 2013 else "isMaster")
                    body = bytes(5) + doc if opcode == 2013 else bytes(4) + b"admin.$cmd\0" + struct.pack("<ii", 0, -1) + doc
                    sock.sendall(struct.pack("<iiii", len(body) + 16, 42, 0, opcode) + body)
                    response, returned_opcode, body = mongo_packet(sock)
                    assert response == 42 and returned_opcode == (2013 if opcode == 2013 else 1)
                    assert b"maxWireVersion\0" in body and b"helloOk\0" in body
                    if opcode == 2013:
                        body = bytes(5) + bson_command("find")
                        sock.sendall(struct.pack("<iiii", len(body) + 16, 43, 0, 2013) + body)
                        assert b"Unauthorized\0" in mongo_packet(sock)[2]

            # Length fields must never trigger attacker-sized allocations or hang forever.
            malformed = {
                "mysql": b"\xff\xff\xff\x01",
                "postgres": b"\xff\xff\xff\xff",
                "mqtt": b"\x10\xff\xff\xff\xff",
                "mongodb": struct.pack("<iiii", 2**31 - 1, 1, 0, 2013),
                "ldap": b"\x30\x84\xff\xff\xff\xff",
                "http": b"G" * 3000 + b"\r\n",
                "redis": b"*1\r\n$999999999\r\n",
                "smb": b"\0\xff\xff\xff",
            }
            for name, payload in malformed.items():
                with connect(name) as sock:
                    if name == "mysql":
                        mysql_packet(sock)
                    sock.sendall(payload)
                    try:
                        assert sock.recv(1) == b"", name
                    except ConnectionResetError:
                        pass
            with connect("http") as sock:
                sock.sendall(b"GET /slow")
                assert sock.recv(1) == b""  # Deadline, even when the request is incomplete.
            with connect("http"):
                pass  # Completed TCP connection with no application bytes still creates an event.
            with connect("https") as sock:
                sock.sendall(b"definitely not TLS\r\n")
                try:
                    sock.recv(32)
                except ConnectionResetError:
                    pass

            assert exercised == set(names), (set(names) - exercised)
            if args.check_minute:
                print("All protocol checks passed; waiting for the real minute boundary...", flush=True)
                while time.monotonic() - started < 62:
                    assert process.poll() is None, stderr.read_text()
                    time.sleep(0.25)
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=10)
            assert process.returncode == 0, stderr.read_text()
            records = [json.loads(line) for line in events.read_text().splitlines()]
            raw = events.read_text() + stdout.read_text()
            assert "DO_NOT_LOG" not in raw, "credential leaked into mock queue"
            assert len({r["event_id"] for r in records}) == len(records)
            assert {r["service"] for r in records} == set(names)
            assert any(r["outcome"] == "timeout" for r in records)
            assert any(r["stage"] == "connected" and r["service"] == "http" for r in records)
            assert any(r["outcome"] == "tls_error" for r in records)
            assert sum(r["outcome"] == "invalid_input" for r in records) >= len(malformed)
            summaries = [json.loads(line) for line in stdout.read_text().splitlines()]
            assert sum(s["probes"] for s in summaries) == len(records)
            assert all(len(s["samples"]) <= 8 for s in summaries)
            if args.check_minute:
                assert sum(s["type"] == "minute_summary" for s in summaries) == 1
            assert not any(s["queue_dropped"] or s["connections_rejected"] for s in summaries)
            print(f"PASS: {len(names)} service endpoints, {len(records)} probe events, framing, TLS, deadlines, redaction, and queue totals")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

    # Fail startup when any requested port is unavailable.
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        good = free_port()
        result = subprocess.run([binary, "--port-offset", "0", "--services", f"http:{good},ssh:{occupied.getsockname()[1]}"], capture_output=True, timeout=5)
        assert result.returncode != 0 and b"cannot bind ssh" in result.stderr
        with socket.socket() as sock:
            assert sock.connect_ex(("127.0.0.1", good)) != 0
    print("PASS: atomic startup failure on occupied port")


if __name__ == "__main__":
    main()
