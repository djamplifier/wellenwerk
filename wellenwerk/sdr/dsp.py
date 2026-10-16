"""Signalverarbeitung fuer SDR-Hardware (IQ-Datenstrom): Spektrum fuer Wasserfall/Panadapter und
Demodulation (USB, LSB, CW, AM, FM) auf 12 kHz Ton. Mit numpy, blockweise und zustandsbehaftet."""
import math

import numpy as np

AUDIO_RATE = 12000


def lowpass(cut: float, rate: float, taps: int) -> np.ndarray:
    """Gefensterter sinc-Tiefpass (Blackman)."""
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cut / rate * n) * np.blackman(taps)
    return (h / h.sum()).astype(np.float32)


class FirDecim:
    """FIR-Tiefpass mit Dezimierung, Zustand ueber Bloecke hinweg."""
    def __init__(self, decim: int, cut: float, rate: float, taps: int = 63):
        self.d, self.h = decim, lowpass(cut, rate, taps)
        self.hist = np.zeros(taps - 1, np.complex64)
        self.phase = 0

    def __call__(self, x: np.ndarray) -> np.ndarray:
        buf = np.concatenate([self.hist, x])
        y = np.convolve(buf, self.h, mode="valid")
        self.hist = buf[-(len(self.h) - 1):]
        out = y[self.phase::self.d]
        self.phase = (self.phase - len(y)) % self.d
        return out


class Fir:
    def __init__(self, h):
        self.h = h.astype(np.complex64 if np.iscomplexobj(h) else np.float32)
        self.hist = None

    def __call__(self, x):
        if self.hist is None:
            self.hist = np.zeros(len(self.h) - 1, x.dtype)
        buf = np.concatenate([self.hist, x])
        self.hist = buf[-(len(self.h) - 1):]
        return np.convolve(buf, self.h, mode="valid")


def decim_plan(rate: int) -> list[int]:
    """Dezimierstufen von der IQ-Rate auf 12 kHz (Rate muss ein ganzzahliges Vielfaches sein)."""
    total = rate // AUDIO_RATE
    if total * AUDIO_RATE != rate:
        raise ValueError(f"Abtastrate {rate} ist kein Vielfaches von 12 kHz")
    out = []
    for f in (8, 8, 5, 4, 4, 3, 2, 2, 2):
        while total % f == 0 and total > 1 and (len(out) < 4 or f <= 4):
            out.append(f)
            total //= f
    if total != 1:
        out.append(total)
    return out


class Receiver:
    """Mischen auf die Empfangsfrequenz, Dezimieren, Demodulieren, AGC."""
    def __init__(self, rate: int):
        self.rate = rate
        self.stages, r = [], rate
        for d in decim_plan(rate):
            nxt = r / d
            self.stages.append(FirDecim(d, min(0.42 * nxt, 0.45 * nxt), r, 63 if d <= 4 else 95))
            r = nxt
        self.nco_phase = 0.0
        self.offset = 0.0
        self.mode = "USB"
        self.pb = (300, 2700)
        self._mk_filter()
        self.agc = 1e-3
        self.fm_last = 0j
        self.dc = 0.0
        self.deemph = 0.0

    def set(self, offset: float, mode: str, pb: tuple[int, int]):
        if (mode, pb) != (self.mode, self.pb):
            self.mode, self.pb = mode, pb
            self._mk_filter()
        self.offset = offset

    def _mk_filter(self):
        lo, hi = self.pb
        if self.mode in ("AM", "SAM", "FM"):
            h = lowpass(max(abs(lo), abs(hi)), AUDIO_RATE, 129).astype(np.complex64)
        else:                                        # komplexer Bandpass: Tiefpass auf die Mitte des Durchlassbereichs verschoben
            bw, mid = (hi - lo) / 2, (hi + lo) / 2
            n = np.arange(129) - 64
            h = (lowpass(bw, AUDIO_RATE, 129) * np.exp(2j * np.pi * mid / AUDIO_RATE * n)).astype(np.complex64)
        self.filt = Fir(h)

    def process(self, iq: np.ndarray) -> np.ndarray:
        n = len(iq)
        ph = self.nco_phase + (-2 * np.pi * self.offset / self.rate) * np.arange(n)
        x = iq * np.exp(1j * ph).astype(np.complex64)
        self.nco_phase = float((ph[-1] - 2 * np.pi * self.offset / self.rate) % (2 * np.pi)) if n else self.nco_phase
        for st in self.stages:
            x = st(x)
        if not len(x):
            return np.zeros(0, np.int16)
        x = self.filt(x)
        if self.mode in ("AM", "SAM"):
            a = np.abs(x)
            self.dc = 0.999 * self.dc + 0.001 * float(a.mean())
            y = a - self.dc
        elif self.mode == "FM":
            prev = np.concatenate([[self.fm_last], x[:-1]])
            self.fm_last = x[-1]
            y = np.angle(x * np.conj(prev)).astype(np.float32)
            a = 1 - math.exp(-1 / (AUDIO_RATE * 75e-6))      # Deemphasis
            out = np.empty_like(y)
            s = self.deemph
            for i in range(len(y)):
                s += a * (y[i] - s)
                out[i] = s
            self.deemph = s
            y = out
        else:
            y = x.real * 2
        # einfache AGC: Spitzenwert mit schnellem Anstieg, langsamem Abfall
        peak = float(np.max(np.abs(y))) if len(y) else 0
        self.agc = peak if peak > self.agc else self.agc * 0.97 + peak * 0.03
        g = 0.3 / max(self.agc, 1e-6) if self.mode != "FM" else 0.19      # FM: 2,6 rad (5 kHz Hub) ~ halbe Aussteuerung
        return np.clip(y * g * 32767, -32767, 32767).astype("<i2")


class Spectrum:
    """FFT-Spektrum in dB, auf 1024 Punkte verdichtet und gemittelt; skaliert auf 0..255 (wie Scope-Zeilen)."""
    def __init__(self, size: int = 2048):
        self.n, self.win = size, np.blackman(size).astype(np.float32)
        self.avg = None

    def line(self, iq: np.ndarray):
        if len(iq) < self.n:
            return None
        k = len(iq) // self.n
        f = np.fft.fftshift(np.fft.fft(iq[: k * self.n].reshape(k, self.n) * self.win, axis=1), axes=1)
        p = 10 * np.log10(np.mean(np.abs(f) ** 2, axis=0) / float(self.win.sum()) ** 2 + 1e-15)      # dBFS
        p = p.reshape(1024, -1).max(axis=1) if self.n > 1024 else p
        self.avg = p if self.avg is None or len(self.avg) != len(p) else self.avg * 0.5 + p * 0.5
        return np.clip((self.avg + 125) * 2.0, 0, 255).astype(np.uint8)      # -125..+2 dBFS -> 0..255


class ZoomSpectrum:
    """Ausschnitt des Spektrums (Breite span um off Hz neben der Mitte) mit feiner Aufloesung: lange FFT, nur die
    benoetigten Bins. Fuer schmale Wasserfall-Breiten bei SDR-Hardware mit hoher Abtastrate."""
    def __init__(self):
        self.avg, self.win = None, None

    def line(self, iq: np.ndarray, rate: float, off: float, span: float):
        n = int(2 ** np.ceil(np.log2(max(2048, 1024 * rate / max(span, 500)))))
        n = min(n, 1 << 18)
        if len(iq) < n:
            n = 1 << int(np.log2(max(2048, len(iq))))
            if len(iq) < n:
                return None
        if self.win is None or len(self.win) != n:
            self.win, self.avg = np.blackman(n).astype(np.float32), None
        f = np.fft.fftshift(np.fft.fft(iq[-n:] * self.win))
        p = 10 * np.log10(np.abs(f) ** 2 / float(self.win.sum()) ** 2 + 1e-15)
        i0 = int(round((off - span / 2) / rate * n + n / 2))
        i1 = int(round((off + span / 2) / rate * n + n / 2))
        p = p[max(0, i0): min(n, i1)]
        if len(p) > 1024:
            k = len(p) // 1024
            p = p[: k * 1024].reshape(1024, k).max(axis=1)
        self.avg = p if self.avg is None or len(self.avg) != len(p) else self.avg * 0.5 + p * 0.5
        return np.clip((self.avg + 125) * 2.0, 0, 255).astype(np.uint8)
