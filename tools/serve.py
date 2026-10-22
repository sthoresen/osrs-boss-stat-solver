#!/usr/bin/env python3
"""Local dev server that disables browser caching, so a normal reload always picks up edits.

Usage: python3 tools/serve.py [port]   (default 8000), then open http://localhost:8000
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
handler = functools.partial(NoCacheHandler, directory=str(ROOT))
print(f'Serving {ROOT} at http://localhost:{port} (no caching)')
http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
