"""OpenWebRX als Empfaenger (WebSocket /ws/). Ton und Wasserfall kommen IMA-ADPCM-komprimiert;
abgestimmt wird innerhalb des aktuellen Profils (Bandausschnitt des Betreibers), ausserhalb wird ein passendes
Profil gewaehlt. Protokoll nach dem quelloffenen OpenWebRX (J. Ketterl u. a.), eigene Umsetzung.

Parameter: profile (Profil-ID oder Teil des Namens), freq/mode (Start), smeter_offset (dB, S-Meter-Abgleich)."""
import asyncio
import json
import math
import re
from urllib.parse import urlparse

import websockets

from ..rig import RigError
from ..bands import band_for
from .base import SdrRig

OWRX_MODES = {"USB": "usb", "PKTUSB": "usb", "RTTY": "usb", "LSB": "lsb", "PKTLSB": "lsb", "CW": "cw", "CWR": "cw",
              "AM": "am", "SAM": "sam", "FM": "nfm"}
IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
        130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
        1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
        7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]


class Adpcm:
    """IMA-ADPCM wie bei OpenWebRX; Ton mit eingestreuten Synchronisationsmarken 'SYNC' + Zustand."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.index = self.pred = self.step = 0
        self.phase = self.sync = self.count = 0
        self.sbuf = bytearray()

    def _nib(self, n):
        self.index = min(max(self.index + IDX[n], 0), 88)
        d = self.step >> 3
        if n & 1:
            d += self.step >> 2
        if n & 2:
            d += self.step >> 1
        if n & 4:
            d += self.step
        if n & 8:
            d = -d
        self.pred = min(max(self.pred + d, -32768), 32767)
        self.step = STEP[self.index]
        return self.pred

    def decode(self, data: bytes) -> list:
        out = []
        for b in data:
            out.append(self._nib(b & 15))
            out.append(self._nib(b >> 4))
        return out

    def decode_sync(self, data: bytes) -> list:
        out = []
        for b in data:
            if self.phase == 0:
                if b != b"SYNC"[self.sync]:
                    self.sync = 0
                    if b == ord("S"):
                        self.sync = 1
                else:
                    self.sync += 1
                if self.sync == 4:
                    self.sbuf, self.phase = bytearray(), 1
            elif self.phase == 1:
                self.sbuf.append(b)
                if len(self.sbuf) == 4:
                    self.index = int.from_bytes(self.sbuf[0:2], "little", signed=True)
                    self.pred = int.from_bytes(self.sbuf[2:4], "little", signed=True)
                    self.count, self.phase = 1000, 2
            else:
                out.append(self._nib(b & 15))
                out.append(self._nib(b >> 4))
                self.count -= 1
                if self.count < 0:
                    self.sync, self.phase = 0, 0
        return out


class OpenWebRXRig(SdrRig):
    kind = "openwebrx"
    MODES = ["USB", "LSB", "CW", "AM", "SAM", "FM", "PKTUSB", "PKTLSB", "RTTY"]
    LEVELS_SET = ["AF", "SQL"]
    FUNCS_SET = []

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.ws = None
        self.center = self.rate = 0
        self.fft_comp, self.audio_comp = "adpcm", "adpcm"
        self.profiles, self.profile = [], ""
        self.adpcm, self.fftc = Adpcm(), Adpcm()
        self.out_rate = 12000
        self.cfg_event = asyncio.Event()
        self.prof_event = asyncio.Event()
        self.state["levels"].update(SQL=0.0)
        self.state["sdr"]["url"] = self.p.get("url", "")

    def _uri(self):
        u = urlparse(self.p.get("url", "") if "://" in self.p.get("url", "") else "http://" + self.p.get("url", ""))
        if not u.hostname:
            raise RigError("Adresse des OpenWebRX fehlt")
        path = (u.path or "/").rstrip("/") + "/ws/"
        return f"{'wss' if u.scheme == 'https' else 'ws'}://{u.netloc}{path}"

    async def _send(self, obj):
        if self.ws is not None:
            await self.ws.send(obj if isinstance(obj, str) else json.dumps(obj))

    async def run(self):
        self.say(f"verbinde mit {self.p.get('url')}")
        self.center = self.rate = 0                      # bei Neuverbindung: Ausschnitt kommt neu vom Server
        self.adpcm.reset()
        self.prof_event.clear()
        try:
            self.ws = await websockets.connect(self._uri(), max_size=None, ping_interval=None, open_timeout=12, user_agent_header="Wellenwerk")
        except Exception as e:
            raise RigError(f"OpenWebRX nicht erreichbar: {e}")
        await self._send("SERVER DE CLIENT client=wellenwerk type=receiver")
        await self._send({"type": "connectionproperties", "params": {"output_rate": self.out_rate, "hd_output_rate": 48000}})
        await self._send({"type": "dspcontrol", "action": "start"})
        async for msg in self.ws:
            if isinstance(msg, str):
                if msg.startswith("CLIENT DE SERVER"):
                    continue
                try:
                    await self._json(json.loads(msg))
                except ValueError:
                    continue
            else:
                await self._binary(msg)
        raise RigError("OpenWebRX hat die Verbindung beendet")

    async def _json(self, j):
        t, v = j.get("type"), j.get("value")
        if t == "config":
            self.center = v.get("center_freq", self.center)
            self.rate = v.get("samp_rate", self.rate)
            self.fft_comp = v.get("fft_compression", self.fft_comp)
            self.audio_comp = v.get("audio_compression", self.audio_comp)
            if v.get("profile_id") and v.get("sdr_id"):
                self.profile = f"{v['sdr_id']}|{v['profile_id']}"
            if self.center and self.rate:
                self._ranges()
                if not self.state["connected"]:
                    self.state.update(connected=True, error="")
                    self.say(f"verbunden, Ausschnitt {(self.center - self.rate / 2) / 1e6:.3f}–{(self.center + self.rate / 2) / 1e6:.3f} MHz")
                    await self._send({"type": "dspcontrol", "params": {"squelch_level": -150}})
                    asyncio.ensure_future(self._first_tune(int(self.center + (v.get("start_offset_freq") or 0))))
                self.cfg_event.set()
                await self.changed(True)
        elif t == "profiles":
            self.profiles = v or []
            self.prof_event.set()
            self._ranges()
            await self.changed(True)
            want = self.params.get("profile")
            if want:
                p = next((x for x in self.profiles if x["id"] == want or want.lower() in x.get("name", "").lower()), None)
                if p:
                    await self._send({"type": "selectprofile", "params": {"profile": p["id"]}})
        elif t == "smeter":
            try:
                db = 10 * math.log10(max(float(v), 1e-20))
                self.state["meters"]["STRENGTH"] = round(db + 73 + float(self.params.get("smeter_offset", -30)), 1)   # unkalibriert
            except (TypeError, ValueError):
                pass
            await self.changed()
        elif t in ("sdr_error", "demodulator_error"):
            self.state["error"] = str(v)
            self.say(f"Fehler: {v}")
            await self.changed(True)
        elif t == "backoff":
            raise RigError(f"OpenWebRX: {v or 'zu viele Nutzer'}")
        elif t == "receiver_details" and isinstance(v, dict):
            self.state["sdr"]["info"] = re.sub(r"<[^>]+>", "", str(v.get("receiver_name", "")))[:100]

    async def _binary(self, b: bytes):
        if not b:
            return
        kind, data = b[0], b[1:]
        if kind == 2 and self.on_audio:
            if self.audio_comp == "adpcm":
                s = self.adpcm.decode_sync(data)
                pcm = b"".join(int(x).to_bytes(2, "little", signed=True) for x in s)
            else:
                pcm = bytes(data)
            if pcm:
                self.on_audio(pcm, self.out_rate)
        elif kind == 1 and self.on_spectrum and self.rate:
            if self.fft_comp == "adpcm":
                self.fftc.reset()
                vals = [x / 100 for x in self.fftc.decode(data)[10:]]
            else:
                import struct
                vals = list(struct.unpack(f"<{len(data) // 4}f", data[: len(data) // 4 * 4]))
            if not vals:
                return
            # auf hoechstens 1024 Punkte verdichten, dB-Werte -> 0..255 wie bei den anderen Quellen
            n = len(vals)
            if n > 1024:
                f = n / 1024
                vals = [max(vals[int(i * f): int((i + 1) * f)] or [vals[int(i * f)]]) for i in range(1024)]
            data8 = [int(min(255, max(0, (v + 150) * 255 / 130))) for v in vals]
            self.on_spectrum(dict(name="OpenWebRX", low=self.center - self.rate / 2, high=self.center + self.rate / 2,
                                  center=self.center, span=self.rate, min=60, max=230, data=data8))

    async def _first_tune(self, fallback: int):
        """Nach dem Verbinden (auch Neuverbinden) die gewuenschte Frequenz einstellen. Liegt sie nicht im aktuellen
        Ausschnitt, erst die Profilliste des Servers abwarten (kommt nach der Konfiguration) und dann umschalten."""
        try:
            if self.state.get("freq") and not self._covers(self.state["freq"]):
                try:
                    await asyncio.wait_for(self.prof_event.wait(), 8)
                except asyncio.TimeoutError:
                    pass
            if not self.state.get("freq"):
                self.state["freq"] = fallback
            try:
                await self.tune()
            except RigError as e:              # Wunschfrequenz hier nicht empfangbar: auf den Ausschnitt des Betreibers gehen
                self.say(str(e))
                self.state["freq"] = int(self.center + (fallback - self.center if self._covers(fallback) else 0))
                await self.tune()
            await self.changed(True)
        except Exception as e:
            self.say(f"Abstimmen: {e}")

    def _ranges(self):
        """Empfangbare Bereiche: aktueller Ausschnitt plus Baender, die in Profilnamen vorkommen (z. B. „40m“, „7 MHz“)."""
        from ..bands import BANDS
        rng = [[self.center - self.rate / 2, self.center + self.rate / 2]] if self.rate else []
        for p in self.profiles:
            name = p.get("name", "")
            for b, lo, hi, _ in BANDS:
                if re.search(rf"(?<![\d.]){re.escape(b)}\b", name, re.I) or any(lo <= float(x.replace(",", ".")) * 1e6 <= hi
                                                                                    for x in re.findall(r"(\d+(?:[.,]\d+)?)\s*MHz", name, re.I)):
                    rng.append([lo, hi])
        self.state["sdr"]["ranges"] = rng

    def _covers(self, f) -> bool:
        return bool(self.rate) and abs(f - self.center) < self.rate / 2 * 0.98

    async def _switch_profile(self, f):
        band = band_for(f) or ""
        mhz = f / 1e6
        cands = [p for p in self.profiles if band and re.search(rf"\b{re.escape(band)}\b", p.get("name", ""), re.I)]
        cands += [p for p in self.profiles if p not in cands and re.search(rf"\b{int(mhz)}([.,]\d+)?\s*MHz", p.get("name", ""), re.I)]
        for p in cands[:4]:
            self.cfg_event.clear()
            await self._send({"type": "selectprofile", "params": {"profile": p["id"]}})
            try:
                await asyncio.wait_for(self.cfg_event.wait(), 6)
            except asyncio.TimeoutError:
                continue
            if self._covers(f):
                self.say(f"Profil „{p.get('name')}“ gewählt")
                return
        names = ", ".join(p.get("name", "") for p in self.profiles[:12])
        raise RigError(f"{f / 1e6:.3f} MHz liegt außerhalb der Empfangsbereiche dieses OpenWebRX ({names})")

    async def tune(self):
        if self.ws is None or not self.rate:
            return
        f = self.state["freq"]
        if not self._covers(f):
            await self._switch_profile(f)
        lo, hi = self.passband()
        sql = self.state["levels"].get("SQL", 0)
        await self._send({"type": "dspcontrol", "params": {"low_cut": lo, "high_cut": hi, "offset_freq": int(f - self.center),
                                                            "mod": OWRX_MODES.get(self.state["mode"], "usb"),
                                                            "squelch_level": -150 if not sql else -130 + sql * 100}})

    async def apply_level(self, name, value):
        if name == "SQL":
            await self.tune()

    async def close(self):
        try:
            self.ws and await self.ws.close()
        except Exception:
            pass
        self.ws = None
