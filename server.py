#!/usr/bin/env python3
"""Photo2pdf — sert l'app statique, reçoit les PDF scannés, expose l'historique. Stdlib uniquement."""
import hmac, json, os, re, secrets, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCAN_DIR = Path(os.environ.get("SCAN_DIR", str(ROOT / "scans")))
TOKEN = os.environ.get("SCAN_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 8 * 1024 * 1024
NO_CACHE = (".html", ".js", ".webmanifest")
NAME_RE = re.compile(r"scan-\d{8}-\d{6}-[0-9a-f]{4}\.pdf")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/scans"):
            # le dossier n'est jamais servi en statique : l'historique passe par l'API et le jeton
            return self._json(403, {"ok": False, "error": "interdit"})
        if path == "/api/scans":
            if not self._token_ok():
                return self._json(403, {"ok": False, "error": "jeton invalide"})
            files = []
            for f in sorted(SCAN_DIR.glob("*.pdf"), key=lambda p: p.name, reverse=True):
                st = f.stat()
                files.append({"file": f.name, "size": st.st_size, "mtime": int(st.st_mtime)})
            return self._json(200, {"ok": True, "files": files})
        if path.startswith("/api/scans/"):
            if not self._token_ok():
                return self._json(403, {"ok": False, "error": "jeton invalide"})
            f = self._scan_path()
            if not f or not f.is_file():
                return self._json(404, {"ok": False, "error": "introuvable"})
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'inline; filename="{f.name}"')
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.split("?")[0].startswith("/scans"):
            self.send_error(403)
            return
        super().do_HEAD()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/upload":
            return self._json(404, {"ok": False, "error": "introuvable"})
        if not self._token_ok():
            return self._json(403, {"ok": False, "error": "jeton invalide"})

        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0:
            return self._json(411, {"ok": False, "error": "Content-Length requis"})
        if n > MAX_BODY:
            return self._json(413, {"ok": False, "error": "trop volumineux"})

        body = self.rfile.read(n)
        if not body.startswith(b"%PDF"):
            return self._json(400, {"ok": False, "error": "ce n'est pas un PDF"})

        # nom imposé par le serveur : jamais celui du client
        name = f"scan-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}.pdf"
        (SCAN_DIR / name).write_bytes(body)
        return self._json(200, {"ok": True, "file": name})

    def do_DELETE(self):
        if not self.path.split("?")[0].startswith("/api/scans/"):
            return self._json(404, {"ok": False, "error": "introuvable"})
        if not self._token_ok():
            return self._json(403, {"ok": False, "error": "jeton invalide"})
        f = self._scan_path()
        if not f or not f.is_file():
            return self._json(404, {"ok": False, "error": "introuvable"})
        f.unlink()
        return self._json(200, {"ok": True})

    def _token_ok(self):
        if not TOKEN:
            return True
        return hmac.compare_digest(self.headers.get("X-Scan-Token", ""), TOKEN)

    def _scan_path(self):
        name = self.path.split("?")[0][len("/api/scans/"):]
        return SCAN_DIR / name if NAME_RE.fullmatch(name) else None

    def end_headers(self):
        path = self.path.split("?")[0]
        if path.endswith(NO_CACHE) or path in ("/", ""):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    SCAN_DIR.mkdir(parents=True, exist_ok=True)
    print(f"http://0.0.0.0:{PORT}  ·  PDF dans {SCAN_DIR}")
    if not TOKEN:
        print("SCAN_TOKEN non défini : quiconque atteint le serveur peut déposer, lire et supprimer un PDF")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
