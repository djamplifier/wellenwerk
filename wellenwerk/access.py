"""Zugangsschutz: Zugriffe von diesem Rechner sind immer frei. Von anderen Rechnern (auch ueber einen
vorgeschalteten Webserver wie nginx) wird – sobald ein Passwort gesetzt ist – eine Anmeldung (Cookie) oder
der API-Schluessel (Authorization: Bearer … bzw. ?token=…) verlangt. Zusaetzlich: Programme, die sich als
MCP-Client ausweisen, duerfen nur senden (PTT, CW, Funkverbindungen), wenn das ausdruecklich erlaubt ist."""
import hashlib
import hmac
import json
import secrets
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

COOKIE = "ww_session"
OPEN_PATHS = ("/login", "/api/login", "/static/logo.svg", "/static/style.css", "/favicon.ico")
# Wege, die den Sender einschalten koennen – fuer MCP-Clients nur mit Erlaubnis
TX_PATHS = ("/api/rig/ptt", "/api/rig/morse", "/api/rig/raw", "/api/rig/op", "/api/winkey/send", "/api/winkey/text",
            "/api/winlink/connect", "/api/wsjtx/reply", "/api/wsjtx/text", "/api/programs/selfspot")


class Access:
    def __init__(self, data: Path, cfg: dict):
        self.cfg = cfg
        kf = data / "secret.key"
        if not kf.exists():
            kf.write_text(secrets.token_hex(32))
            try:
                kf.chmod(0o600)
            except OSError:
                pass
        self.key = kf.read_text().strip().encode()

    def session_value(self) -> str:
        pw = self.cfg.get("access_password") or ""
        return hmac.new(self.key, ("pw:" + pw).encode(), hashlib.sha256).hexdigest()

    def check_password(self, pw: str) -> bool:
        want = self.cfg.get("access_password") or ""
        return bool(want) and hmac.compare_digest(pw.encode(), want.encode())

    @staticmethod
    def is_local(scope) -> bool:
        client = (scope.get("client") or ("", 0))[0]
        if client not in ("127.0.0.1", "::1", "localhost"):
            return False
        for k, v in scope.get("headers", []):
            if k in (b"x-forwarded-for", b"x-real-ip", b"forwarded") and v.split(b",")[0].strip() not in (b"127.0.0.1", b"::1"):
                return False
        return True

    def authorized(self, scope) -> bool:
        pw, tok = self.cfg.get("access_password") or "", self.cfg.get("api_token") or ""
        if self.is_local(scope) or not (pw or tok):
            return True
        hdr = {k: v for k, v in scope.get("headers", [])}
        auth = hdr.get(b"authorization", b"").decode("latin-1")
        q = parse_qs(scope.get("query_string", b"").decode()).get("token", [""])[0]
        if tok and (hmac.compare_digest(auth, "Bearer " + tok) or (q and hmac.compare_digest(q, tok))):
            return True
        if pw:
            c = SimpleCookie()
            try:
                c.load(hdr.get(b"cookie", b"").decode("latin-1"))
            except Exception:
                return False
            v = c.get(COOKIE)
            return bool(v and hmac.compare_digest(v.value, self.session_value()))
        return False


class AccessMiddleware:
    def __init__(self, app, access: Access):
        self.app, self.access = app, access

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if scope["type"] == "http" and path in TX_PATHS and not self.access.cfg.get("mcp_allow_tx"):
            hdr = {k: v for k, v in scope.get("headers", [])}
            if hdr.get(b"x-ww-client", b"").lower() == b"mcp":
                return await _json(send, 403, "Senden ist für KI-Assistenten (MCP) nicht freigegeben – Programmoptionen → Zugang & API")
        if path in OPEN_PATHS or self.access.authorized(scope):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        if path.startswith("/api/") or path.startswith("/ws"):
            return await _json(send, 401, "Anmeldung erforderlich (Passwort oder API-Schlüssel)")
        await send({"type": "http.response.start", "status": 303, "headers": [(b"location", b"/login")]})
        await send({"type": "http.response.body", "body": b""})


async def _json(send, status: int, text: str):
    body = json.dumps({"detail": text}).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


LOGIN_HTML = """<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wellenwerk – Anmelden</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9eff7;font:15px system-ui,sans-serif;color:#1d2733}
form{background:#fff;padding:28px 30px;border-radius:10px;box-shadow:0 6px 30px #0002;display:flex;flex-direction:column;gap:12px;width:min(320px,86vw)}
img{width:56px;align-self:center} h1{margin:0;font-size:19px;text-align:center} input{font:inherit;padding:9px 10px;border:1px solid #b8c4d2;border-radius:6px}
button{font:inherit;padding:9px;border:0;border-radius:6px;background:#2f6fc4;color:#fff;font-weight:600;cursor:pointer} .e{color:#c62828;min-height:1.2em;font-size:13px}
@media (prefers-color-scheme:dark){body{background:#151a20;color:#e2e8ef}form{background:#1f262f}input{background:#151a20;color:#e2e8ef;border-color:#3a4552}}
</style></head><body><form id="f"><img src="/static/logo.svg" alt=""><h1>Wellenwerk</h1>
<input type="password" id="p" placeholder="Passwort" autofocus autocomplete="current-password"><button>Anmelden</button><div class="e" id="e"></div></form>
<script>document.getElementById("f").onsubmit=async e=>{e.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});
if(r.ok)location.href="/";else document.getElementById("e").textContent=(await r.json()).detail||"Anmeldung fehlgeschlagen";};</script></body></html>"""
