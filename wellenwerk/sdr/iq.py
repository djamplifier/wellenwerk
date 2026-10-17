"""Gemeinsame Grundlage fuer SDR-Hardware, die einen IQ-Datenstrom liefert: Mittenfrequenz der Hardware
nachfuehren, Spektrum und Ton aus dem IQ-Strom berechnen (in einem Hilfsthread, damit die Oberflaeche fluessig bleibt)."""
import asyncio
import time

import numpy as np

from .base import SdrRig
from .dsp import AUDIO_RATE, Receiver, Spectrum, ZoomSpectrum


class IqRig(SdrRig):
    MODES = ["USB", "LSB", "CW", "CWR", "AM", "FM", "PKTUSB", "PKTLSB", "RTTY"]
    LEVELS_SET = ["AF", "RF", "AGC"]
    FUNCS_SET = ["NB"]                       # Stoerimpulsaustaster auf den IQ-Daten
    RATE = 1536000

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.rate = int(float(self.params.get("rate", self.RATE)))
        self.center = 0
        self.rx = Receiver(self.rate)
        self.spec = Spectrum(2048)
        self.zspec, self.zoom_span, self.zoom_cf, self._hist = ZoomSpectrum(), 0, 0, []
        self._buf, self._next_spec = [], 0.0
        self.state["sdr"]["hw"] = True

    async def apply_func(self, name, on):
        if name == "NB":
            self.rx.nb = bool(on)

    # Hardware stellt die Mittenfrequenz; Empfangsfrequenz liegt bevorzugt etwas neben der Mitte (DC-Spitze)
    async def set_center(self, hz: int):
        raise NotImplementedError

    async def tune(self):
        f, half = self.state["freq"], self.rate / 2
        if not self.center or abs(f - self.center) > half * 0.8:
            await self.set_center(int(f - self.rate / 4))
        self.rx.set(f - self.center, self.state["mode"] if self.state["mode"] != "CWR" else "CW", self.passband())

    async def set_span(self, hz: int) -> int:
        self.zoom_span = hz if 0 < hz < self.rate * 0.8 else 0
        self.zoom_cf = 0
        return int(self.zoom_span or self.rate)

    def _zoom_view(self):
        """Mitte des Ausschnitts: bleibt stehen, bis die Empfangsfrequenz das mittlere Drittel verlaesst."""
        span, f, half = self.zoom_span, self.state["freq"], self.rate / 2
        if not self.zoom_cf or abs(f - self.zoom_cf) > span * 0.35:
            self.zoom_cf = f
        self.zoom_cf = min(max(self.zoom_cf, self.center - half + span / 2), self.center + half - span / 2)
        return self.zoom_cf

    async def feed(self, iq: np.ndarray):
        """IQ-Block (complex64) verarbeiten: Ton an die Oberflaeche, Spektrum 20x pro Sekunde."""
        loop = asyncio.get_running_loop()
        pcm = await loop.run_in_executor(None, self.rx.process, iq)
        if len(pcm) and self.on_audio:
            if getattr(self, "_dvvoice", False) and getattr(self, "_dvdec", "") in self.DV_VOICE:
                pcm = self.voice_take(len(pcm))             # eigener Digitalfunk-Dekoder mit Sprachmodul: Sprache statt Rauschen
            self.on_audio(pcm.tobytes(), AUDIO_RATE)
        if self.state["mode"] == "FM" and self.rx.disc is not None:
            self.dv_feed(self.rx.disc, AUDIO_RATE)
            self.rx.disc = None
        if self.zoom_span:                                   # lange FFT braucht die letzten Bloecke
            self._hist.append(iq)
            while len(self._hist) > 1 and sum(len(b) for b in self._hist[1:]) >= (1 << 18):
                self._hist.pop(0)
        else:
            self._hist = []
        now = time.monotonic()
        if now >= self._next_spec and self.on_spectrum:
            self._next_spec = now + 0.05                       # 20 Zeilen/s
            if self.zoom_span:
                cf, span = self._zoom_view(), self.zoom_span
                buf = np.concatenate(self._hist) if len(self._hist) > 1 else iq
                line = await loop.run_in_executor(None, self.zspec.line, buf, self.rate, cf - self.center, span)
                lo, hi = cf - span / 2, cf + span / 2
            else:
                line = await loop.run_in_executor(None, self.spec.line, iq[-8192:])
                lo, hi = self.center - self.rate / 2, self.center + self.rate / 2
            if line is not None:
                self.on_spectrum(dict(name=self.p.get("model_name") or "SDR", low=lo, high=hi,
                                      center=(lo + hi) / 2, span=hi - lo, min=0, max=255, data=line.tolist()))
                # S-Meter: staerkster Wert im Durchlassbereich (unkalibriert, Abgleich ueber smeter_offset)
                plo, phi = self.passband()
                bin_ = lambda f: int((f - lo) / (hi - lo) * len(line))
                i0, i1 = sorted((bin_(self.state["freq"] + plo), bin_(self.state["freq"] + phi)))
                if 0 <= i0 < len(line):
                    dbfs = float(line[i0: max(i1, i0) + 1].max()) / 2.0 - 125
                    self.state["meters"]["STRENGTH"] = round(dbfs + 40 + float(self.params.get("smeter_offset", 0)), 1)
        await self.changed()
