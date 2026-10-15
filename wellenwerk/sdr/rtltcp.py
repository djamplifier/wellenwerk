"""RTL-SDR ueber rtl_tcp (Standardprogramm der rtl-sdr-Werkzeuge; laeuft auf diesem oder einem anderen Rechner).

Adresse: host:port (Standard 127.0.0.1:1234). Parameter (mit ; getrennt):
  rate=1536000        Abtastrate (Vielfaches von 12 kHz: 1536000, 1152000, 960000, 288000 …)
  gain=auto | 0..50   Verstaerkung in dB
  ppm=0               Frequenzkorrektur
  direct=0|1|2        Direktabtastung (Kurzwelle ohne Konverter; 2 = Q-Zweig, z. B. RTL-SDR Blog V3)
  offset=0            Konverter-Versatz in Hz (z. B. 125000000 bei Ham It Up)
  start=1             rtl_tcp selbst starten (nur auf diesem Rechner, Geraet: device=0)
"""
import asyncio
import shutil
import struct
import subprocess

import numpy as np

from ..rig import RigError
from .iq import IqRig


class RtlTcpRig(IqRig):
    kind = "rtltcp"
    RATE = 1536000

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.r = self.w = None
        self.proc = None
        self.offset = int(float(self.params.get("offset", 0)))

    def _addr(self):
        a = (self.p.get("url") or "127.0.0.1:1234").replace("rtl_tcp://", "").replace("tcp://", "").strip("/")
        host, _, port = a.partition(":")
        return host or "127.0.0.1", int(port or 1234)

    async def _cmd(self, code: int, val: int):
        self.w.write(struct.pack(">BI", code, val & 0xFFFFFFFF))
        await self.w.drain()

    async def set_center(self, hz: int):
        self.center = hz
        if self.w:
            await self._cmd(0x01, hz + self.offset)

    async def apply_level(self, name, value):
        if not self.w:
            return
        if name == "RF" and self.params.get("gain", "auto") != "auto":
            return
        if name == "RF":
            await self._cmd(0x03, 1)                         # manuelle Verstaerkung
            await self._cmd(0x04, int(value * 500))          # Zehntel dB, 0..50 dB

    async def run(self):
        host, port = self._addr()
        if self.params.get("start") in ("1", "ja", "true") and host in ("127.0.0.1", "localhost"):
            exe = shutil.which("rtl_tcp")
            if not exe:
                raise RigError("rtl_tcp ist nicht installiert (Paket rtl-sdr)")
            self.proc = subprocess.Popen([exe, "-a", host, "-p", str(port), "-d", self.params.get("device", "0")],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            await asyncio.sleep(1.5)
        self.say(f"verbinde mit rtl_tcp {host}:{port}")
        try:
            self.r, self.w = await asyncio.wait_for(asyncio.open_connection(host, port), 6)
            hdr = await asyncio.wait_for(self.r.readexactly(12), 6)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError) as e:
            raise RigError(f"rtl_tcp auf {host}:{port} nicht erreichbar – läuft rtl_tcp? ({e or 'Zeitüberschreitung'})")
        if hdr[:4] != b"RTL0":
            raise RigError("Gegenstelle ist kein rtl_tcp")
        tuner = {1: "E4000", 2: "FC0012", 3: "FC0013", 4: "FC2580", 5: "R820T", 6: "R828D"}.get(struct.unpack(">I", hdr[4:8])[0], "?")
        await self._cmd(0x02, self.rate)
        await self._cmd(0x05, int(float(self.params.get("ppm", 0))))
        if self.params.get("direct"):
            await self._cmd(0x09, int(self.params["direct"]))
        g = self.params.get("gain", "auto")
        if g == "auto":
            await self._cmd(0x03, 0)
            await self._cmd(0x08, 1)
        else:
            await self._cmd(0x03, 1)
            await self._cmd(0x04, int(float(g) * 10))
        self.center = 0
        await self.tune()
        self.state.update(connected=True, error="")
        self.state["sdr"]["info"] = f"RTL-SDR, Tuner {tuner}, {self.rate / 1e6:.3f} MS/s"
        self.say(f"verbunden: Tuner {tuner}, {self.rate} S/s")
        await self.changed(True)
        chunk = self.rate // 20 * 2                          # 50 ms
        while True:
            try:
                raw = await self.r.readexactly(chunk)
            except asyncio.IncompleteReadError:
                raise RigError("rtl_tcp hat die Verbindung beendet")
            u = np.frombuffer(raw, np.uint8).astype(np.float32)
            iq = ((u[0::2] - 127.5) + 1j * (u[1::2] - 127.5)).astype(np.complex64) / 127.5
            await self.feed(iq)

    async def close(self):
        try:
            self.w and self.w.close()
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
