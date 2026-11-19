"""Local test server for the web pane spike (issue #2690).

Serves the test pages on 127.0.0.1 and runs canary listeners that record any
connection at all: an HTTP server on every address of this machine, a raw TCP
listener and a UDP listener. Every hit is one JSON line on stdout. Nothing here
contacts any other host.

Run with: python -I testserver.py --pages <dir> --port 8765 --bind 0.0.0.0
"""
import argparse
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time


def log(event, **fields):
    fields.update(event=event, t=round(time.time(), 3))
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


class Handler(http.server.SimpleHTTPRequestHandler):
    pages = "."

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.pages, **kwargs)

    def log_message(self, fmt, *args):  # quiet the default stderr log
        pass

    def _record(self):
        log("http", method=self.command, path=self.path, peer=self.client_address[0], ua=(self.headers.get("User-Agent") or "")[:60] if self.path.startswith("/canary/ua") else None,
            local=self.connection.getsockname()[0], canary=self.path.startswith("/canary"))

    def do_GET(self):
        self._record()
        if self.path.startswith("/canary"):
            body = b"canary"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/redirect-to-canary"):
            self.send_response(302)
            self.send_header("Location", "/canary/redirect-followed")
            self.end_headers()
            return
        if self.path.startswith("/missing"):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        self._record()
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class ThreadingHTTP(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def tcp_canary(bind, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((bind, port))
    s.listen(64)
    while True:
        conn, peer = s.accept()
        try:
            conn.settimeout(1)
            first = conn.recv(200)
        except OSError:
            first = b""
        log("tcp", port=port, peer=peer[0], first=first[:60].decode("latin-1"), canary=True)
        conn.close()


def udp_canary(bind, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((bind, port))
    while True:
        data, peer = s.recvfrom(4096)
        log("udp", port=port, peer=peer[0], size=len(data), canary=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pages", required=True)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--tcp-canary", type=int, default=8766)
    p.add_argument("--udp-canary", type=int, default=8767)
    a = p.parse_args()
    Handler.pages = os.path.abspath(a.pages)
    threading.Thread(target=tcp_canary, args=(a.bind, a.tcp_canary), daemon=True).start()
    threading.Thread(target=udp_canary, args=(a.bind, a.udp_canary), daemon=True).start()
    server = ThreadingHTTP((a.bind, a.port), Handler)
    log("listening", http=a.port, tcp=a.tcp_canary, udp=a.udp_canary, bind=a.bind)
    server.serve_forever()


if __name__ == "__main__":
    main()
