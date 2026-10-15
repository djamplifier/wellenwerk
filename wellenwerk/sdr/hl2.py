"""Hermes Lite 2 (und andere openHPSDR-Geraete, Protokoll 1) als Empfaenger ueber UDP-Port 1024.
Senden ist in dieser Version gesperrt (nur Empfang).

Adresse: IP des Geraets oder leer (= automatisch im Netz suchen). Parameter:
  rate=192000   48000 | 96000 | 192000 | 384000
  gain=20       LNA-Verstaerkung in dB (-12 … +48)
"""
import asyncio
import socket
import struct

import numpy as np

from ..rig import RigError
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

    async def set_center(self, hz: int):
        self.center = hz           # HL2: NCO direkt auf die Mittenfrequenz

    async def apply_level(self, name, value):
        if name == "RF":
            self.gain = int(round(-12 + float(value) * 60))

    def _cc(self) -> bytes:
        """Steuerbytes im Wechsel: 0x00 Grundeinstellung, 0x02 RX1-Frequenz, 0x01 TX-Frequenz (= RX), 0x0A LNA."""
        self.cc = (self.cc + 1) % 4
        if self.cc == 0:
            return bytes([0x00, SPEED[self.rate], 0x00, 0x00, 0x04])          # 1 Empfaenger, Duplex
        if self.cc == 1:
            return bytes([0x02 << 1]) + struct.pack(">I", int(self.center))
        if self.cc == 2:
            return bytes([0x01 << 1]) + struct.pack(">I", int(self.center))
        return bytes([0x0A << 1, 0, 0, 0, 0x40 | ((self.gain + 12) & 0x3F)])

    def _ep2(self) -> bytes:
        frames = b"".join(b"\x7f\x7f\x7f" + self._cc() + bytes(504) for _ in range(2))
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        return b"\xef\xfe\x01\x02" + struct.pack(">I", self.seq) + frames

    def _ep6(self, data: bytes):
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

    async def _send_loop(self):
        """Steuerdaten laufend senden (das Geraet erwartet einen staendigen Strom vom Rechner)."""
        per = 126 / 48000                           # ein Paket je 126 TX-Abtastwerte bei 48 kHz
        while True:
            self.tr.sendto(self._ep2(), (self.ip, 1024))
            await asyncio.sleep(per)

    async def close(self):
        if self.tr:
            try:
                self.tr.sendto(bytes([0xEF, 0xFE, 0x04, 0x00]) + bytes(60), (self.ip, 1024))
            except Exception:
                pass
            self.tr.close()
            self.tr = None
