"""Hermes Lite 2 (und andere openHPSDR-Geraete, Protokoll 1) ueber UDP-Port 1024: Empfang und Senden.

Adresse: IP des Geraets oder leer (= automatisch im Netz suchen). Parameter:
  rate=192000   48000 | 96000 | 192000 | 384000
  gain=20       LNA-Verstaerkung in dB (-12 … +48)
  tx=1          Senden freigeben (nur mit Amateurfunkzulassung; gesendet wird nur in den Amateurfunkbaendern)
  power=4       Sendeleistung 0..15 (Treiberstufe; 15 = voll, beim HL2 rund 5 W mit Endstufe)
  pa=1          Endstufe des HL2 einschalten (sonst nur Treiberpegel, wenige mW)
"""
import asyncio
import socket
import struct

import numpy as np

from ..rig import RigError
from .dsp import Modulator
from .iq import IqRig

SPEED = {48000: 0, 96000: 1, 192000: 2, 384000: 3}


def discover(timeout: float = 1.5) -> list[dict]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    pkt = bytes([0xEF, 0xFE, 0x02]) + bytes(60)
    for _ in range(2):
        try:
            s.sendto(pkt, ("255.255.255.255", 1024))
        except OSError:
            pass
    import time
    found, t0 = [], time.time()
    while time.time() - t0 < timeout:
        try:
            d, a = s.recvfrom(1500)
        except socket.timeout:
            continue
        if d[:2] == b"\xef\xfe" and d[2] in (2, 3):
            found.append(dict(ip=a[0], busy=d[2] == 3, mac=d[3:9].hex(":"), version=d[9], board=d[10],
                              name={6: "Hermes Lite 2", 1: "Hermes", 0: "Metis", 2: "Griffin", 4: "Angelia", 5: "Orion"}.get(d[10], f"openHPSDR {d[10]}")))
    s.close()
    return found


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, rig):
        self.rig = rig

    def datagram_received(self, data, addr):
        if len(data) == 1032 and data[:4] == b"\xef\xfe\x01\x06":
            self.rig._ep6(data)


class Hl2Rig(IqRig):
    kind = "hl2"
    RATE = 192000
    LEVELS_SET = ["AF", "RF", "AGC"]
    TX_CAPABLE = True
    TX_RATE = 48000

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        if self.rate not in SPEED:
            self.rate = 192000
            from .dsp import Receiver
            self.rx = Receiver(self.rate)
        self.tr = None
        self.ip = ""
        self.seq = 0
        self.cc = 0
        self.rx_freq = 0
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._acc = []
        self.gain = int(float(self.params.get("gain", 20)))
        self.state["sdr"]["ranges"] = [[0, 38_400_000]]
        self.mox = False
        self.mod = Modulator(self.TX_RATE)
        self.txiq = np.zeros(0, np.complex64)
        self.power = max(0, min(15, int(float(self.params.get("power", 4)))))
        self.pa = str(self.params.get("pa", "1")).lower() in ("1", "ja", "true")
        self._pace, self._per, self._running = 0, 126 * self.rate / 48000, False

    async def set_center(self, hz: int):
        self.center = hz           # HL2: NCO direkt auf die Mittenfrequenz

    async def apply_level(self, name, value):
        if name == "RF":
            self.gain = int(round(-12 + float(value) * 60))

    def _cc(self) -> bytes:
        """Steuerbytes im Wechsel: 0x00 Grundeinstellung, 0x02 RX1-Frequenz, 0x01 TX-Frequenz, 0x0A LNA, 0x09 Sendeleistung/Endstufe.
        Bit 0 von C0 ist MOX (Senden) und steht in jedem Rahmen."""
        self.cc = (self.cc + 1) % 5
        mox = 1 if self.mox else 0
        if self.cc == 0:
            return bytes([0x00 | mox, SPEED[self.rate], 0x00, 0x00, 0x04])          # 1 Empfaenger, Duplex
        if self.cc == 1:
            return bytes([(0x02 << 1) | mox]) + struct.pack(">I", int(self.center))
        if self.cc == 2:                                                             # Sendefrequenz = angezeigte Frequenz (Traeger)
            return bytes([(0x01 << 1) | mox]) + struct.pack(">I", int(self.state.get("freq") or self.center))
        if self.cc == 3:
            return bytes([(0x0A << 1) | mox, 0, 0, 0, 0x40 | ((self.gain + 12) & 0x3F)])
        drive = (self.power & 0x0F) << 4 if self.mox else 0                           # 0x09: [31:28] Treiberpegel, [19] Endstufe
        return bytes([(0x09 << 1) | mox, drive, 0x08 if (self.pa and self.mox) else 0x00, 0, 0])

    def _tx_samples(self, n: int) -> np.ndarray:
        """n Sende-IQ-Werte (48 kHz) aus Ton der Warteschlange modulieren."""
        while len(self.txiq) < n:
            a = self.tx_take(480)                                                   # 40 ms Ton
            self.txiq = np.concatenate([self.txiq, self.mod.process(a, self.state["mode"], fm_dev=int(float(self.params.get("fm_dev", 2500))))])
        out, self.txiq = self.txiq[:n], self.txiq[n:]
        return out

    def _ep2(self) -> bytes:
        frames = []
        iq = self._tx_samples(126) if self.mox else None
        for f in range(2):
            if iq is None:
                body = bytes(504)
            else:                                                                    # je Wert: L, R (Ton, beim HL2 unbenutzt), I, Q – 16 Bit, Big Endian
                z = iq[f * 63:(f + 1) * 63]
                a = np.zeros((63, 4), ">i2")
                a[:, 2] = np.clip(z.real * 32767, -32767, 32767)
                a[:, 3] = np.clip(z.imag * 32767, -32767, 32767)
                body = a.tobytes()
            frames.append(b"\x7f\x7f\x7f" + self._cc() + body)
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        return b"\xef\xfe\x01\x02" + struct.pack(">I", self.seq) + b"".join(frames)

    async def tx_start(self):
        if not self.tr:
            raise RigError("Gerät nicht verbunden")
        for _ in range(6):                                                           # kurz Ton sammeln (Netz/Browser)
            if self.tx_pending() >= 1200:
                break
            await asyncio.sleep(0.025)
        self.txiq = np.zeros(0, np.complex64)
        self.mox = True

    async def tx_stop(self):
        self.mox = False
        self.txiq = np.zeros(0, np.complex64)

    def _ep6(self, data: bytes):
        if self._running and self.tr:                     # Sendepakete im Takt des Geraets: 126 TX-Werte (48 kHz) je 126*rate/48000 RX-Werte
            self._pace += 126
            while self._pace >= self._per:
                self._pace -= self._per
                self.tr.sendto(self._ep2(), (self.ip, 1024))
        for off in (8, 520):
            fr = data[off:off + 512]
            if fr[:3] != b"\x7f\x7f\x7f":
                continue
            raw = np.frombuffer(fr[8:8 + 63 * 8], np.uint8).reshape(63, 8)
            i = ((raw[:, 0].astype(np.int32) << 24) | (raw[:, 1].astype(np.int32) << 16) | (raw[:, 2].astype(np.int32) << 8)) >> 8
            q = ((raw[:, 3].astype(np.int32) << 24) | (raw[:, 4].astype(np.int32) << 16) | (raw[:, 5].astype(np.int32) << 8)) >> 8
            self._acc.append((i + 1j * q).astype(np.complex64) / 8388608)
        if sum(len(a) for a in self._acc) >= self.rate // 20:
            blk = np.concatenate(self._acc)
            self._acc = []
            try:
                self.queue.put_nowait(blk)
            except asyncio.QueueFull:
                pass

    async def run(self):
        ip = (self.p.get("url") or "").replace("udp://", "").strip("/")
        if not ip:
            found = await asyncio.to_thread(discover)
            if not found:
                raise RigError("Kein Hermes Lite 2 / openHPSDR-Gerät im Netz gefunden")
            ip = found[0]["ip"]
            self.say(f"gefunden: {found[0]['name']} {ip} ({found[0]['mac']})")
        self.ip = ip
        loop = asyncio.get_running_loop()
        self.tr, _ = await loop.create_datagram_endpoint(lambda: _Proto(self), local_addr=("0.0.0.0", 0))
        self.center = 0
        await self.tune()
        for _ in range(3):
            self.tr.sendto(self._ep2(), (ip, 1024))
        self.tr.sendto(bytes([0xEF, 0xFE, 0x04, 0x01]) + bytes(60), (ip, 1024))    # IQ-Strom starten
        sender = asyncio.create_task(self._send_loop())
        try:
            first = await asyncio.wait_for(self.queue.get(), 5)
        except asyncio.TimeoutError:
            sender.cancel()
            raise RigError(f"Gerät {ip} sendet keine Daten (belegt oder falsche Adresse?)")
        sender.cancel()                                   # ab jetzt Takt aus den Empfangspaketen
        self._running = True
        self.state.update(connected=True, error="")
        self.state["sdr"]["info"] = f"openHPSDR {ip}, {self.rate // 1000} kS/s"
        self.say(f"verbunden mit {ip}, {self.rate} S/s")
        await self.changed(True)
        try:
            await self.feed(first)
            while True:
                try:
                    blk = await asyncio.wait_for(self.queue.get(), 5)
                except asyncio.TimeoutError:
                    raise RigError("Gerät sendet keine Daten mehr")
                await self.feed(blk)
        finally:
            sender.cancel()
            self._running = False
            self.mox = False

    async def _send_loop(self):
        """Steuerdaten laufend senden (das Geraet erwartet einen staendigen Strom vom Rechner)."""
        per = 126 / 48000                           # ein Paket je 126 TX-Abtastwerte bei 48 kHz
        while True:
            self.tr.sendto(self._ep2(), (self.ip, 1024))
            await asyncio.sleep(per)

    async def close(self):
        self.mox = False
        if self.tr:
            try:
                self.tr.sendto(bytes([0xEF, 0xFE, 0x04, 0x00]) + bytes(60), (self.ip, 1024))
            except Exception:
                pass
            self.tr.close()
            self.tr = None
