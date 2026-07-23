#!/usr/bin/env python3
"""Static file server for local dev — identical to `python3 -m http.server`
except every response gets Cache-Control: no-store, so edited source files
are never served stale from the browser's disk/module cache."""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = lambda *args, **kwargs: NoCacheHandler(*args, directory=directory, **kwargs)
    HTTPServer(('', port), handler).serve_forever()
