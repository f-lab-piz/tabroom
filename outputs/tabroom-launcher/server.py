"""Tabroom's loopback-only web portal, including seekable demo movies."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import json
import mimetypes
import re
import shutil
import signal
import subprocess
from deeplink_search import DIRECTORY, IMAGE_NAMES, search

ROOT = Path(__file__).resolve().parent
PORT = 18840
ASSETS = {'portal.html', 'mac-bridge.js', 'app.js', 'monitor.js', 'native-cpu.js', 'streams.js', 'agent-ui.js', 'composer.js', 'styles.css', 'site-picker.js'}
ASSETS.update('interactive-ui/' + name for name in ('protocol.js', 'markdown.js', 'references.js', 'chart.js', 'render.js', 'styles.css'))
DEMOS = {name + ext for name in ('motion', 'orbit', 'lines') for ext in ('.html', '.mp4')}
EXTENSION_DOWNLOAD = '/downloads/tabroom-extension.zip'


class Portal(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.serve(False)

    def do_GET(self):
        self.serve(True)

    def do_POST(self):
        if self.headers.get('Host') != f'127.0.0.1:{PORT}':
            return self.send_error(403)
        if self.path != '/api/deeplinks':
            return self.send_error(404)
        size = self.headers.get('Content-Length', '')
        if not size.isascii() or not size.isdecimal() or len(size) > 4 or int(size) > 4096:
            return self.send_error(400)
        try:
            payload = json.loads(self.rfile.read(int(size)))
            query = payload.get('query') if isinstance(payload, dict) else None
        except (ValueError, UnicodeError):
            return self.send_error(400)
        if not isinstance(query, str) or len(query) > 200:
            return self.send_error(400)
        data = json.dumps(search(query), ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve(self, body):
        if self.headers.get('Host') != f'127.0.0.1:{PORT}':
            return self.send_error(403)
        url = urlsplit(self.path)
        route = url.path
        name = route.lstrip('/')
        if route == '/health':
            self.send_response(200)
            self.end_headers()
            if body:
                self.wfile.write(b'tabroom-portal-5')
            return
        if route == '/portal.html' and url.query == 'mac-bridge=1':
            path = ROOT.parent / 'tabroom/mac-bridge.html'
        elif route in ('/', '/index.html'):
            path = ROOT.parent / 'tabroom/portal.html'
        elif route == EXTENSION_DOWNLOAD:
            path = ROOT.parent / 'tabroom-extension.zip'
        elif name in ASSETS:
            path = ROOT.parent / 'tabroom' / name
        elif route.startswith('/demo/') and route[6:] in DEMOS:
            path = ROOT / 'samples' / route[6:]
        elif route.startswith('/deeplinks/') and route[11:] in IMAGE_NAMES:
            path = DIRECTORY / route[11:]
        else:
            return self.send_error(404)
        if not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        start, end = 0, size - 1
        requested = self.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', requested)
            if not match:
                return self.send_error(416)
            start = int(match[1])
            end = min(int(match[2]), end) if match[2] else end
            if start > end:
                return self.send_error(416)
        self.send_response(206 if requested else 200)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        if route == EXTENSION_DOWNLOAD:
            self.send_header('Content-Disposition', 'attachment; filename="tabroom-extension.zip"')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'no-cache')
        if requested:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        if body:
            with path.open('rb') as src:
                src.seek(start)
                remaining = end - start + 1
                try:
                    while remaining:
                        block = src.read(min(256 * 1024, remaining))
                        if not block:
                            break
                        self.wfile.write(block)
                        remaining -= len(block)
                except (BrokenPipeError, ConnectionResetError):
                    pass


def run():
    with ThreadingHTTPServer(('127.0.0.1', PORT), Portal) as server:
        node = shutil.which('node') or next((str(p) for p in (
            Path('/opt/homebrew/bin/node'), Path('/usr/local/bin/node')
        ) if p.is_file()), None)
        agent = subprocess.Popen([node, str(ROOT / 'agent-server.mjs')]) if node else None

        def stop(_signum, _frame):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        try:
            server.serve_forever()
        finally:
            if agent and agent.poll() is None:
                agent.terminate()
                try:
                    agent.wait(4)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()


if __name__ == '__main__':
    run()
