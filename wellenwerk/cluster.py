"""DX-Cluster per Telnet (DXSpider, CC Cluster, AR-Cluster)."""
import asyncio
import collections
import logging
import re
import time
from datetime import datetime, timezone

log = logging.getLogger("ww.cluster")
SPOT = re.compile(r"^DX de ([^:\s]+):?\s+(\d+\.\d+)\s+(\S+)\s+(.*?)\s*(\d{4})Z(?:\s+([A-R]{2}\d{2}))?", re.I)


def parse_spot(line: str) -> dict | None:
    m = SPOT.match(line.strip())
    if not m:
        return None
    khz = float(m.group(2))
    g = re.search(r"\b([A-R]{2}[0-9]{2})(?:[A-X]{2})?\b", m.group(4).upper())
    return dict(spotter=re.sub(r"-#$|-\d+-#$", "", m.group(1).upper()), freq=int(round(khz * 1000)), call=m.group(3).upper(),
                comment=m.group(4).strip(), time=m.group(5), spotter_grid=(m.group(6) or "").upper(), spotted_grid=g.group(1) if g else "",
                ts=time.time())


class Cluster:
    def __init__(self, host: str, port: int, login: str, on_spot, on_status, init_cmds: str = "", on_line=None):
        self.host, self.port, self.login, self.init_cmds = host, port, login, init_cmds
        self.on_spot, self.on_status, self.on_line = on_spot, on_status, on_line
        self.info = dict(ann="", wwv="", wcy="")       # letzte Ansage / WWV / WCY fuer die Statuszeile
        self.lines = collections.deque(maxlen=200)     # Rohzeilen fuer das Cluster-Terminal
        self.spots = collections.deque(maxlen=300)
        self.status = dict(connected=False, host=host, error="", since="")
        self.writer = None
        self._reconnect = asyncio.Event()

    def reconfigure(self, host, port, login, init_cmds=""):
        if (host, port, login, init_cmds) != (self.host, self.port, self.login, self.init_cmds):
            self.host, self.port, self.login, self.init_cmds = host, port, login, init_cmds
            self._reconnect.set()
            if self.writer:
                self.writer.close()

    async def send(self, cmd: str):
        if not self.writer:
            raise ConnectionError("Cluster nicht verbunden")
        self.writer.write((cmd.strip() + "\r\n").encode())
        await self.writer.drain()

    async def _set_status(self, **kw):
        self.status.update(kw)
        await self.on_status(dict(self.status))

    async def run_forever(self):
        backoff = 5
        while True:
            self._reconnect.clear()
            if not self.host or not self.login:
                await self._set_status(connected=False, error="kein Cluster oder Rufzeichen eingestellt")
                await self._reconnect.wait()
                continue
            try:
                reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), 10)
                # Login-Abfrage endet meist ohne Zeilenumbruch -> kurz sammeln, dann Rufzeichen senden
                buf = b""
                try:
                    while b"login" not in buf.lower() and b"call" not in buf.lower() and len(buf) < 8000:
                        buf += await asyncio.wait_for(reader.read(1024), 5)
                except asyncio.TimeoutError:
                    pass
                await self.send(self.login)
                for c in (self.init_cmds or "").split(";"):
                    if c.strip():
                        await asyncio.sleep(0.5)
                        await self.send(c)
                await self._set_status(connected=True, host=self.host, error="",
                                       since=datetime.now(timezone.utc).strftime("%H:%M"))
                log.info("Cluster %s:%s verbunden", self.host, self.port)
                backoff = 5
                while True:
                    raw = await asyncio.wait_for(reader.readline(), 600)
                    if not raw:
                        raise ConnectionError("Verbindung vom Cluster beendet")
                    line = raw.decode("latin-1").replace("\x07", "").strip()
                    sp = parse_spot(line)
                    if sp:
                        self.spots.appendleft(sp)
                        await self.on_spot(sp)
                    elif line:
                        self.lines.append(line)
                        u = line.upper()
                        key = "wwv" if u.startswith("WWV DE") else "wcy" if u.startswith("WCY DE") else \
                              "ann" if u.startswith("TO ALL") or u.startswith("TO LOCAL") else None
                        if key:
                            self.info[key] = line
                        if self.on_line:
                            await self.on_line(line, key)
            except Exception as e:
                log.warning("Cluster: %s", e)
                await self._set_status(connected=False, error=str(e) or type(e).__name__)
            self.writer = None
            try:
                await asyncio.wait_for(self._reconnect.wait(), backoff)
            except asyncio.TimeoutError:
                backoff = min(backoff * 2, 120)
