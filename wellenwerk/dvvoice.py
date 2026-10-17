"""Optionales Sprachmodul fuer DMR, D-STAR und YSF (AMBE/AMBE+2).

Wellenwerk enthaelt dafuer keinen Code und laedt auch keinen nach. Wer die Sprache hoeren will, besorgt sich selbst
mbelib (freier Quelltext, ISC-Lizenz, github.com/szechyjs/mbelib), uebersetzt es und legt die Bibliothek in den Ordner
<Datenordner>/module/ (oder installiert sie systemweit). Wellenwerk sucht sie nur und bindet sie ein, wenn vorhanden.
Ob die Nutzung der AMBE-Verfahren am eigenen Ort Patent- oder Lizenzrechte beruehrt, verantwortet der Nutzer.

Die Verschachtelungstabellen fuer DMR und D-STAR stammen aus DSD (ISC-Lizenz, Copyright (C) 2010 DSD Author).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("ww.voice")

LIBNAMES = ("libmbe.dylib", "libmbe.so", "libmbe.so.1", "mbe.dll", "libmbe.dll")
NEEDED = ("mbe_initMbeParms", "mbe_processAmbe3600x2400Framef", "mbe_processAmbe3600x2450Framef", "mbe_processAmbe2450Dataf")

# DMR: 36 Dibits je AMBE+2-Rahmen -> ambe_fr[4][24] (Bit 1 nach W/X, Bit 0 nach Y/Z)
DMR_W = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2]
DMR_X = [23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4]
DMR_Y = [0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3]
DMR_Z = [5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0]
# D-STAR: 72 Bit je AMBE-Rahmen -> ambe_fr[4][24]
DS_W = [0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
        3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 3, 2, 1, 0, 0, 3, 3]
DS_X = [10, 22, 11, 9, 10, 22, 11, 23, 8, 20, 9, 21, 10, 8, 9, 21, 8, 6, 7, 19, 8, 20, 9, 7, 6, 18, 7, 5, 6, 18, 7, 19, 4, 16, 5, 17,
        6, 4, 5, 17, 4, 2, 3, 15, 4, 16, 5, 3, 2, 14, 3, 1, 2, 14, 3, 15, 0, 12, 1, 13, 2, 0, 1, 13, 0, 12, 10, 11, 0, 12, 1, 13]

DATA: Path | None = None                                  # Datenordner (setzt main.py)
_lib = None
_err = ""


def folder(data: Path | None = None) -> Path:
    return Path(data or DATA or ".") / "module"


def _find(data: Path | None) -> str:
    for n in LIBNAMES:
        p = folder(data) / n
        if p.exists():
            return str(p)
    return ctypes.util.find_library("mbe") or ""          # systemweit installiert (z. B. „make install“)


def _load(data: Path | None = None):
    global _lib, _err
    if _lib is None:
        p = _find(data)
        if not p:
            return None
        try:
            lib = ctypes.CDLL(p)
            for fn in NEEDED:
                getattr(lib, fn).restype = None
        except (OSError, AttributeError) as e:
            _err = f"{p}: {e}"
            log.warning("Sprachmodul nicht ladbar: %s", _err)
            return None
        _lib, _err = lib, ""
        lib._ww_path = p
        log.info("Sprachmodul eingebunden: %s", p)
    return _lib


def available(data: Path | None = None) -> bool:
    return _load(data) is not None


def status(data: Path | None = None) -> dict:
    lib = _load(data)
    return dict(state="ready" if lib else "error" if _err else "missing", path=getattr(lib, "_ww_path", "") if lib else "",
                folder=str(folder(data)), msg=_err)


class Vocoder:
    """Ein Sprachstrom (Zustand zwischen den Rahmen). kind: "dstar" (AMBE 3600x2400), "dmr" (AMBE+2 3600x2450, mit FEC),
    "ysf" (AMBE+2, 49 Nutzbits nach Wiederholungscode). Ausgabe je Rahmen 160 Werte bei 8 kHz, float (-1..1)."""

    def __init__(self, data: Path | None, kind: str):
        self.lib, self.kind = _load(data or DATA), kind
        if self.lib is None:
            raise RuntimeError("Sprachmodul nicht vorhanden")
        self.cur, self.prev, self.enh = (ctypes.create_string_buffer(4096) for _ in range(3))
        self.lib.mbe_initMbeParms(self.cur, self.prev, self.enh)
        self.gain = 1.0
        self.errs = 0

    def frame(self, bits) -> np.ndarray:
        out = (ctypes.c_float * 160)()
        e1, e2, es = ctypes.c_int(0), ctypes.c_int(0), ctypes.create_string_buffer(64)
        ad = (ctypes.c_char * 49)()
        if self.kind == "ysf":
            self.lib.mbe_processAmbe2450Dataf(out, ctypes.byref(e1), ctypes.byref(e2), es, (ctypes.c_char * 49)(*bits[:49]),
                                              self.cur, self.prev, self.enh, 3)
        else:
            fr = (ctypes.c_char * 24 * 4)()
            if self.kind == "dstar":
                for i in range(72):
                    fr[DS_W[i]][DS_X[i]] = bits[i]
                self.lib.mbe_processAmbe3600x2400Framef(out, ctypes.byref(e1), ctypes.byref(e2), es, fr, ad, self.cur, self.prev, self.enh, 3)
            else:                                         # dmr: 36 Dibits (0..3)
                for i, v in enumerate(bits[:36]):
                    fr[DMR_W[i]][DMR_X[i]] = (v >> 1) & 1
                    fr[DMR_Y[i]][DMR_Z[i]] = v & 1
                self.lib.mbe_processAmbe3600x2450Framef(out, ctypes.byref(e1), ctypes.byref(e2), es, fr, ad, self.cur, self.prev, self.enh, 3)
        self.errs = e2.value
        a = np.frombuffer(out, np.float32).astype(np.float64) * (7 / 32768)
        rms = float(np.sqrt(np.mean(a * a)))                # langsame Pegelregelung auf ca. -16 dBFS, Spitzen begrenzt
        if rms > 0.01:
            self.gain += (min(8.0, 0.16 / rms) - self.gain) * 0.05
        return np.clip(a * self.gain, -0.95, 0.95).astype(np.float32)


def to_pcm12k(a8: np.ndarray) -> bytes:
    """8 kHz float -> 12 kHz int16 (Wellenwerk-Tonweg)."""
    if not len(a8):
        return b""
    n = len(a8) * 3 // 2
    y = np.interp(np.arange(n) * (2 / 3), np.arange(len(a8)), a8)
    return (y * 32767).astype("<i2").tobytes()
