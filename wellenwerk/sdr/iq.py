"""Gemeinsame Grundlage fuer SDR-Hardware, die einen IQ-Datenstrom liefert: Mittenfrequenz der Hardware
nachfuehren, Spektrum und Ton aus dem IQ-Strom berechnen (in einem Hilfsthread, damit die Oberflaeche fluessig bleibt)."""
import asyncio
import time

import numpy as np

from .base import SdrRig
from .dsp import AUDIO_RATE, Receiver, Spectrum


class IqRig(SdrRig):
    MODES = ["USB", "LSB", "CW", "CWR", "AM", "FM", "PKTUSB", "PKTLSB", "RTTY"]
    LEVELS_SET = ["AF", "RF", "AGC"]
    FUNCS_SET = []
    RATE = 1536000

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.rate = int(float(self.params.get("rate", self.RATE)))
        self.center = 0
        self.rx = Receiver(self.rate)
        self.spec = Spectrum(2048)
        self._buf, self._next_spec = [], 0.0
        self.state["sdr"]["hw"] = True

    # Hardware stellt die Mittenfrequenz; Empfangsfrequenz liegt bevorzugt etwas neben der Mitte (DC-Spitze)
    async def set_center(self, hz: int):
        raise NotImplementedError

    async def tune(self):
        f, half = self.state["freq"], self.rate / 2
        if not self.center or abs(f - self.center) > half * 0.8:
            await self.set_center(int(f - self.rate / 4))
        self.rx.set(f - self.center, self.state["mode"] if self.state["mode"] != "CWR" else "CW", self.passband())

    async def feed(self, iq: np.ndarray):
        """IQ-Block (complex64) verarbeiten: Ton an die Oberflaeche, Spektrum ~10x pro Sekunde."""
        loop = asyncio.get_running_loop()
        pcm = await loop.run_in_executor(None, self.rx.process, iq)
        if len(pcm) and self.on_audio:
            self.on_audio(pcm.tobytes(), AUDIO_RATE)
        now = time.monotonic()
        if now >= self._next_spec and self.on_spectrum:
            self._next_spec = now + 0.1
            line = await loop.run_in_executor(None, self.spec.line, iq[-8192:])
            if line is not None:
                self.on_spectrum(dict(name=self.p.get("model_name") or "SDR", low=self.center - self.rate / 2, high=self.center + self.rate / 2,
                                      center=self.center, span=self.rate, min=0, max=255, data=line.tolist()))
                # S-Meter: staerkster Wert im Durchlassbereich (unkalibriert, Abgleich ueber smeter_offset)
                lo, hi = self.passband()
                bin_ = lambda f: int((f - (self.center - self.rate / 2)) / self.rate * len(line))
                i0, i1 = sorted((bin_(self.state["freq"] + lo), bin_(self.state["freq"] + hi)))
                if 0 <= i0 < len(line):
                    dbfs = float(line[i0: max(i1, i0) + 1].max()) / 2.0 - 125
                    self.state["meters"]["STRENGTH"] = round(dbfs + 40 + float(self.params.get("smeter_offset", 0)), 1)
        await self.changed()
