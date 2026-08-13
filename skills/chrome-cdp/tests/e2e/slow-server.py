#!/usr/bin/env python3
"""Slow-resource server for chrome-cdp e2e tests.

Endpoints:
  /slowimg   HTML with <img src="/img3">  (img delayed 3s -> page stays loading)
  /neverimg  HTML with <img src="/img8">  (img delayed 8s -> long loading)

Rationale: a slow HTML response does NOT keep readyState 'loading' for long —
the URL commits when the response header arrives and a tiny document is
'complete' almost immediately. A delayed subresource is the reliable way to
hold readyState at 'interactive' and exercise wait --load / --network-idle.
"""
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GIF = (b'\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00'
       b'\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00'
       b'\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b')


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        delay = 0
        body = b''
        ctype = 'text/html'
        if self.path == '/slowimg':
            body = b'<html><head><title>slowimg</title></head><body><img src="/img3"></body></html>'
        elif self.path == '/neverimg':
            body = b'<html><head><title>neverimg</title></head><body><img src="/img8"></body></html>'
        elif self.path == '/img3':
            delay, body, ctype = 3, GIF, 'image/gif'
        elif self.path == '/img8':
            delay, body, ctype = 8, GIF, 'image/gif'
        else:
            self.send_response(404)
            self.end_headers()
            return
        if delay:
            time.sleep(delay)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9124
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
