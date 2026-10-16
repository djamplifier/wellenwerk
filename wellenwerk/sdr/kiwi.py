"""KiwiSDR als Empfaenger. Zwei WebSocket-Verbindungen: SND (Ton + S-Meter) und W/F (Wasserfall).
Protokoll nach dem quelloffenen kiwiclient (GPL-3, J. Kirchner u. a.).

Parameter (Feld „Parameter“, z. B. 'password=…; span=200; user=DL1ABC'):
  password   Kanal-Passwort, falls der Betreiber eines verlangt
  user       angezeigter Name (Standard: Rufzeichen bzw. „Wellenwerk“)
  span       Breite des Wasserfalls in kHz (Standard 100)
  agc        1/0, thresh, decay, gain (manuelle Verstaerkung 0–120)
  freq, mode Startfrequenz in kHz und Betriebsart
"""
import asyncio
import math
import struct
import time
from urllib.parse import urlparse

import websockets

from ..rig import RigError
from .base import SdrRefused, SdrRig

KIWI_MODES = {"USB": "usb", "PKTUSB": "usb", "RTTY": "usb", "LSB": "lsb", "PKTLSB": "lsb", "CW": "cw", "CWR": "cw",
              "AM": "am", "SAM": "sam", "FM": "nbfm"}


def kiwi_base(url: str) -> tuple[str, int, bool]:
    u = urlparse(url if "://" in url else "http://" + url)
    return u.hostname or "", u.port or (443 if u.scheme == "https" else 8073), u.scheme == "https"


class KiwiRig(SdrRig):
    kind = "kiwisdr"

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.snd = self.wf = None
        self.bandwidth = 30_000_000
        self.audio_rate = 12000
        self.wf_cf = None
        self.zoom = 8
        self.wf_lines = 0
        self.state["sdr"]["url"] = self.p.get("url", "")
        self.state["sdr"]["ranges"] = [[0, 30_000_000]]

    def _uri(self, which: str, prefix: str = "") -> str:
        host, port, tls = kiwi_base(self.p.get("url", ""))
        if not host:
            raise RigError("Adresse des KiwiSDR fehlt")
        return f"{'wss' if tls else 'ws'}://{host}:{port}{prefix}/{int(time.time())}/{which}"

    async def _open(self, which: str):
        last = None
        for prefix in ("", "/kiwi"):
            try:
                return await websockets.connect(self._uri(which, prefix), max_size=None, ping_interval=None, open_timeout=12,
                                                user_agent_header="Wellenwerk")
            except Exception as e:      # aeltere/neuere Versionen nutzen unterschiedliche Pfade
                last = e
        raise RigError(f"KiwiSDR nicht erreichbar: {last}")

    async def _send(self, ws, text: str):
        if ws is not None:
            await ws.send(text)

    def _user(self) -> str:
        return (self.params.get("user") or self.p.get("user") or "Wellenwerk").replace(" ", "%20")[:30]

    async def run(self):
        self.say(f"verbinde mit {self.p.get('url')}")
        self.snd = await self._open("SND")
        pw = self.params.get("password", "")
        await self._send(self.snd, f"SET auth t=kiwi p={pw}")
        self.wf = await self._open("W/F")
        await self._send(self.wf, f"SET auth t=kiwi p={pw}")
        tasks = [asyncio.create_task(self._reader(self.snd, "SND")), asyncio.create_task(self._reader(self.wf, "W/F")),
                 asyncio.create_task(self._keepalive())]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for t in done:
                if t.exception():
                    raise t.exception()
        finally:
            for t in tasks:
                t.cancel()

    async def _keepalive(self):
        n, seen = 0, -1
        while True:
            await asyncio.sleep(5)
            n += 1
            await self._send(self.snd, "SET keepalive")
            await self._send(self.wf, "SET keepalive")
            if self.wf_lines == seen and self.state["connected"]:      # Wasserfall steht: Einrichtung erneut senden
                self.say("Wasserfall bleibt aus – Einrichtung erneut gesendet")
                await self._setup_wf()
                self.state["sdr"]["info"] = "Wasserfall bleibt aus (Wasserfall-Kanäle des Empfängers belegt?)" if n > 3 else ""
            seen = self.wf_lines

    async def _reader(self, ws, which: str):
        async for msg in ws:
            if isinstance(msg, str):
                msg = msg.encode()
            tag, body = msg[:3].decode("latin-1"), msg[3:]
            if tag == "MSG":
                await self._msg(ws, which, body[1:].decode("latin-1", "replace"))
            elif tag == "SND":
                await self._snd(body)
            elif tag == "W/F":
                self._wf(body[1:])
        raise RigError("KiwiSDR hat die Verbindung beendet" + (f" ({self.state['error']})" if self.state.get("error") else ""))

    async def _msg(self, ws, which: str, text: str):
        for part in text.split(" "):
            name, _, value = part.partition("=")
            if name == "too_busy":
                self.state["error"] = f"alle {value} Plätze belegt"
                raise RigError(f"KiwiSDR: alle {value} Empfangsplätze belegt – später erneut oder anderen Empfänger wählen")
            if name == "badp" and value not in ("0", ""):
                raise SdrRefused("KiwiSDR: Passwort falsch oder freie Plätze nur mit Passwort")
            if name == "down":
                raise SdrRefused("KiwiSDR ist gerade außer Betrieb")
            if name in ("inactivity_timeout", "inactivity_timeout_msg"):
                self.state["error"] = "Zeitlimit bei Inaktivität erreicht"
            if name == "redirect":
                raise SdrRefused("KiwiSDR leitet auf einen anderen Empfänger um")
            if name == "bandwidth":
                self.bandwidth = int(float(value))
                self.state["sdr"]["ranges"] = [[0, self.bandwidth]]
            elif name == "audio_rate" and which == "SND":
                self.audio_rate = int(float(value))
                await self._send(ws, f"SET AR OK in={self.audio_rate} out=48000")
            elif name == "sample_rate" and which == "SND":
                await self._setup_snd()
            elif name == "wf_setup" and which == "W/F":
                await self._setup_wf()

    async def _setup_snd(self):
        s = self.snd
        await self._send(s, "SET squelch=0 max=0")
        await self._send(s, "SET genattn=0")
        await self._send(s, "SET gen=0 mix=-1")
        await self._send(s, "SET compression=0")
        await self._send(s, f"SET ident_user={self._user()}")
        if not (0 <= self.state["freq"] <= self.bandwidth):   # Wunschfrequenz (z. B. 2 m vom Funkgeraet) hier nicht empfangbar
            self.say(f"{self.state['freq'] / 1e6:.3f} MHz nicht empfangbar (0–{self.bandwidth / 1e6:.0f} MHz) – stelle 7,074 MHz ein")
            self.state.update(freq=7074000, mode="USB")
        await self.tune()
        await self.apply_level("AGC", self.state["levels"]["AGC"])
        self.state.update(connected=True, error="")
        self.say(f"verbunden, Ton {self.audio_rate} Hz")
        await self.changed(True)

    async def _setup_wf(self):
        await self._send(self.wf, "SET maxdb=-10 mindb=-110")
        await self._send(self.wf, "SET wf_speed=4")
        await self._send(self.wf, "SET wf_comp=0")
        await self._send(self.wf, "SET interp=13")
        self.wf_cf = None
        await self._wf_center(force=True)

    def _span_hz(self) -> float:
        return self.bandwidth / (2 ** self.zoom)

    async def _wf_center(self, force=False):
        if self.wf is None:
            return
        want = float(self.params.get("span", 100)) * 1000
        self.zoom = max(0, min(14, round(math.log2(self.bandwidth / max(want, 1000)))))
        span, f = self._span_hz(), self.state["freq"]
        if force or self.wf_cf is None or abs(f - self.wf_cf) > span * 0.35:
            cf = min(max(f, span / 2), self.bandwidth - span / 2)
            self.wf_cf = cf
            await self._send(self.wf, f"SET zoom={self.zoom} cf={cf / 1000:.3f}")

    async def set_span(self, hz: int) -> int:
        self.params["span"] = (hz or self.bandwidth) / 1000
        await self._wf_center(force=True)
        return int(self._span_hz())

    async def tune(self):
        if self.snd is None:
            return
        f = self.state["freq"]
        if not (0 <= f <= self.bandwidth):
            raise RigError(f"Frequenz außerhalb des Empfangsbereichs (0–{self.bandwidth / 1e6:.0f} MHz)")
        lo, hi = self.passband()
        mod = KIWI_MODES.get(self.state["mode"], "usb")
        await self._send(self.snd, f"SET mod={mod} low_cut={lo} high_cut={hi} freq={f / 1000:.3f}")
        await self._wf_center()

    async def apply_level(self, name, value):
        if name in ("AGC", "RF"):
            agc = int(self.state["levels"].get("AGC", 6))
            decay = {2: 300, 6: 1000, 3: 3000}.get(agc, 1000)
            gain = int(round(float(self.params.get("gain", self.state["levels"].get("RF", 0.5) * 120))))
            await self._send(self.snd, f"SET agc={0 if agc == 0 else 1} hang=0 thresh={int(self.params.get('thresh', -100))} slope=6 decay={decay} manGain={gain}")

    async def apply_func(self, name, on):
        if name == "NB":
            await self._send(self.snd, "SET nb algo=1")
            await self._send(self.snd, "SET nb type=0 param=0 pval=100")
            await self._send(self.snd, "SET nb type=0 param=1 pval=50")
            await self._send(self.snd, f"SET nb type=0 en={1 if on else 0}")

    async def _snd(self, body: bytes):
        if len(body) < 7:
            return
        flags, seq = struct.unpack("<BI", body[:5])
        sm, = struct.unpack(">H", body[5:7])
        rssi = 0.1 * sm - 127
        self.state["meters"]["STRENGTH"] = round(rssi + 73, 1)      # dB ueber S9 (S9 = -73 dBm)
        data = body[7:]
        if flags & 0x10:          # komprimiert – sollte bei compression=0 nicht vorkommen
            return
        if flags & 0x08:          # Stereo/IQ – hier nicht benutzt
            return
        n = len(data) // 2
        if n:
            pcm = struct.pack(f"<{n}h", *struct.unpack(f">{n}h", data[:n * 2]))     # Kiwi sendet big endian
            self.on_audio and self.on_audio(pcm, self.audio_rate)
        await self.changed()

    def _wf(self, body: bytes):
        if len(body) < 12 or not self.on_spectrum:
            return
        data = body[12:]
        self.wf_lines += 1
        span = self._span_hz()
        cf = self.wf_cf or self.state["freq"]
        self.on_spectrum(dict(name="KiwiSDR", low=cf - span / 2, high=cf + span / 2, center=cf, span=span,
                              min=255 - 125, max=255 - 25, data=list(data)))

    async def close(self):
        for ws in (self.snd, self.wf):
            try:
                ws and await ws.close()
            except Exception:
                pass
        self.snd = self.wf = None
