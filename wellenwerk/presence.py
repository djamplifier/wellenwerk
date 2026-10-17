"""Anonyme Online-Zaehlung: alle 10 Minuten meldet Wellenwerk der Annahmestelle (relay/worker.js, POST /ping), dass es
laeuft. Uebertragen werden nur eine zufaellige Programm-ID und die Version; das Land bestimmt Cloudflare aus der
Verbindung, die IP-Adresse wird nicht gespeichert. Abschaltbar unter Optionen → Fehler & Updates (presence_on)."""
import asyncio
import json
import logging
import os
import secrets
import urllib.request
from pathlib import Path

log = logging.getLogger("ww.presence")
URL = os.environ.get("WW_PRESENCE_URL", os.environ.get("WW_REPORT_URL", "https://wellenwerk-meldungen.maadclaw.workers.dev"))
INTERVAL, FIRST = 600, 60                   # alle 10 min, erste Meldung nach 1 min (kurze Testlaeufe zaehlen nicht)


class Presence:
    def __init__(self, data: Path, cfg: dict, version: str):
        self.path, self.cfg, self.version = Path(data) / "instanz-id", cfg, version
        self.sent = False

    def ident(self) -> str:
        try:
            v = self.path.read_text(encoding="utf-8").strip()
            if len(v) == 32 and all(c in "0123456789abcdef" for c in v):
                return v
        except OSError:
            pass
        v = secrets.token_hex(16)
        try:
            self.path.write_text(v, encoding="utf-8")
        except OSError:
            pass
        return v

    def enabled(self) -> bool:
        return bool(URL) and self.cfg.get("presence_on", True) is not False

    def _post(self, path: str):
        body = json.dumps(dict(id=self.ident(), client=f"Wellenwerk {self.version}", version=self.version)).encode()
        req = urllib.request.Request(URL.rstrip("/") + path, data=body, method="POST",
                                     headers={"content-type": "application/json", "user-agent": f"Wellenwerk/{self.version}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()

    async def run(self):
        await asyncio.sleep(FIRST)
        while True:
            if self.enabled():
                try:
                    await asyncio.to_thread(self._post, "/ping")
                    self.sent = True
                except Exception as e:
                    log.debug("Online-Meldung: %s", e)
            elif self.sent:
                await self.bye()
            await asyncio.sleep(INTERVAL)

    async def bye(self):
        """Beim Beenden oder Abschalten sofort abmelden."""
        if not (URL and self.sent):
            return
        self.sent = False
        try:
            await asyncio.wait_for(asyncio.to_thread(self._post, "/bye"), 4)
        except Exception:
            pass
