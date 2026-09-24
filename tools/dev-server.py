#!/usr/bin/env python3
"""Static file server for local dev — identical to `python3 -m http.server`
except every response gets Cache-Control: no-store, so edited source files
are never served stale from the browser's disk/module cache.

Threaded, with a deep listen backlog: the stock single-threaded HTTPServer
keeps a backlog of 5, so a few headless Chromes loading the ~40-module import
graph at once (parallel render-test shots) overflowed it and got
ERR_CONNECTION_RESET on random modules — the page then never booted and no
JS error was ever thrown."""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 256


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = lambda *args, **kwargs: NoCacheHandler(*args, directory=directory, **kwargs)
    Server(('', port), handler).serve_forever()
