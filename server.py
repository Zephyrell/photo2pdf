#!/usr/bin/env python3
"""Photo2pdf — sert l'app statique, reçoit les PDF scannés, expose l'historique. Stdlib uniquement."""
import getpass, hashlib, hmac, json, os, re, secrets, sys, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent
SCAN_DIR = Path(os.environ.get("SCAN_DIR", str(ROOT / "scans")))
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 8 * 1024 * 1024
NO_CACHE = (".html", ".js", ".webmanifest")
NAME_RE = re.compile(r"scan-\d{8}-\d{6}-[0-9a-f]{4}\.pdf")

COOKIE = "p2p_session"
MAX_AGE = 30 * 24 * 3600      # un mois : on se connecte une fois sur le téléphone
PBKDF2_ITER = 600_000
FAIL_WINDOW = 300             # 5 échecs par IP et par 5 minutes
FAIL_MAX = 5

SECRET = b""                  # clé de signature des cookies
USERS = {}                    # nom -> "pbkdf2_sha256$iter$sel$empreinte"
FAILS = {}                    # ip -> [échecs, début de fenêtre]

# types imposés : Alpine n'installe pas /etc/mime.types, le manifeste PWA partirait en
# application/octet-stream et Safari refuserait de l'installer
EXT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
}


# ---------- mots de passe ----------
def hash_password(pw, iterations=PBKDF2_ITER):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def check_password(entry, pw):
    try:
        algo, iterations, salt, expected = entry.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), expected)


def parse_users(raw):
    # "alice:pbkdf2_sha256$...;bob:pbkdf2_sha256$..." (les retours à la ligne marchent aussi)
    users = {}
    for chunk in raw.replace("\n", ";").split(";"):
        chunk = chunk.strip()
        if chunk and ":" in chunk:
            name, entry = chunk.split(":", 1)
            users[name.strip()] = entry.strip()
    return users


# ---------- sessions ----------
def load_secret():
    env = os.environ.get("SESSION_SECRET", "").strip()
    if env:
        return env.encode()
    path = SCAN_DIR / ".session-secret"
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        key = secrets.token_hex(32).encode()
        path.write_bytes(key + b"\n")
        os.chmod(path, 0o600)
        return key


def sign(user, expiry):
    return hmac.new(SECRET, f"{user}.{expiry}".encode(), hashlib.sha256).hexdigest()


def make_session(user):
    expiry = int(time.time()) + MAX_AGE
    return f"{user}.{expiry}.{sign(user, expiry)}"


def read_session(header):
    for part in (header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name != COOKIE:
            continue
        fields = value.split(".")
        if len(fields) != 3:
            return None
        user, expiry, signature = fields
        if user not in USERS:            # un compte retiré perd sa session
            return None
        try:
            expiry = int(expiry)
        except ValueError:
            return None
        if expiry < time.time():
            return None
        if not hmac.compare_digest(signature, sign(user, expiry)):
            return None
        return user
    return None


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **EXT_TYPES}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # ---------- routage ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/login":
            return self._login_page()
        if path.startswith("/scans"):
            # le dossier n'est jamais servi en statique : l'historique passe par l'API
            return self._json(403, {"ok": False, "error": "interdit"})
        if not self._authed():
            return self._deny(path)
        if path == "/api/scans":
            files = []
            for f in sorted(SCAN_DIR.glob("*.pdf"), key=lambda p: p.name, reverse=True):
                st = f.stat()
                files.append({"file": f.name, "size": st.st_size, "mtime": int(st.st_mtime)})
            return self._json(200, {"ok": True, "files": files})
        if path.startswith("/api/scans/"):
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
        path = self.path.split("?")[0]
        if path.startswith("/scans"):
            self.send_error(403)
            return
        if not self._authed():
            self.send_response(303)
            self.send_header("Location", "/login")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/login":
            return self._login()
        if path == "/logout":
            return self._logout()
        if not self._authed():
            return self._deny(path)
        if path != "/api/upload":
            return self._json(404, {"ok": False, "error": "introuvable"})

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
        if not self._authed():
            return self._deny(self.path)
        f = self._scan_path()
        if not f or not f.is_file():
            return self._json(404, {"ok": False, "error": "introuvable"})
        f.unlink()
        return self._json(200, {"ok": True})

    # ---------- authentification ----------
    def _authed(self):
        return not USERS or read_session(self.headers.get("Cookie")) is not None

    def _deny(self, path):
        if path.startswith("/api/"):
            return self._json(401, {"ok": False, "error": "authentification requise"})
        self.send_response(303)
        self.send_header("Location", "/login")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _login_page(self):
        try:
            page = (ROOT / "login.html").read_bytes()
        except OSError:
            return self._json(500, {"ok": False, "error": "login.html manquant"})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(page)

    def _login(self):
        ip = self.client_ip()
        now = time.time()
        fails, since = FAILS.get(ip, (0, now))
        if now - since > FAIL_WINDOW:
            fails, since = 0, now
        if fails >= FAIL_MAX:
            FAILS[ip] = (fails, since)
            return self._json(429, {"ok": False, "error": "trop de tentatives, réessaie dans 5 minutes"})

        try:
            n = min(int(self.headers.get("Content-Length", "0")), 4096)
        except ValueError:
            n = 0
        form = parse_qs(self.rfile.read(n).decode("utf-8", "replace"))
        user = form.get("user", [""])[0].strip()
        password = form.get("password", [""])[0]

        entry = USERS.get(user)
        if not entry or not check_password(entry, password):
            FAILS[ip] = (fails + 1, since)
            return self._redirect("/login?e=1")

        FAILS.pop(ip, None)
        cookie = f"{COOKIE}={make_session(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={MAX_AGE}"
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            cookie += "; Secure"
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _logout(self):
        self.send_response(303)
        self.send_header("Location", "/login")
        self.send_header("Set-Cookie", f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _redirect(self, location):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- divers ----------
    def client_ip(self):
        # nginx ajoute l'adresse réelle en fin de liste ; le début est fourni par le client
        forward = self.headers.get("X-Forwarded-For", "")
        return forward.split(",")[-1].strip() if forward else self.client_address[0]

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


def main():
    global SECRET, USERS

    if len(sys.argv) > 1 and sys.argv[1] == "hash":
        # le mot de passe arrive par stdin : il ne traîne ni dans argv ni dans ps
        pw = getpass.getpass("mot de passe : ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\n")
        if not pw:
            sys.exit("mot de passe vide")
        print(hash_password(pw))
        return

    USERS = parse_users(os.environ.get("AUTH_USERS", ""))
    SCAN_DIR.mkdir(parents=True, exist_ok=True)
    SECRET = load_secret()

    print(f"http://0.0.0.0:{PORT}  ·  PDF dans {SCAN_DIR}")
    if USERS:
        print(f"comptes : {', '.join(sorted(USERS))}")
    else:
        print("AUTH_USERS non défini : le service est ouvert à quiconque l'atteint")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
