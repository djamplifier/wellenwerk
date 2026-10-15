"""FreeDV (digitale Sprache) ueber die freie Bibliothek codec2 (LGPL 2.1, David Rowe VK5DGR u. a.).
Die Bibliothek wird zur Laufzeit gesucht: mitgeliefert (Paket), Homebrew, System (z. B. Paket libcodec2-1.2)."""
import ctypes
import ctypes.util
import os
import sys
from pathlib import Path

import numpy as np

MODES = {"700D": 7, "700E": 13, "1600": 0, "700C": 6, "2400A": 3, "2400B": 4, "800XA": 5}
_lib = None


def _candidates():
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    names = {"darwin": ["libcodec2.dylib", "libcodec2.1.2.dylib"], "win32": ["libcodec2.dll", "codec2.dll"]}.get(sys.platform,
                                                                                                                ["libcodec2.so.1.2", "libcodec2.so"])
    for d in (here / "codec2", here, Path("/opt/homebrew/opt/codec2/lib"), Path("/usr/local/opt/codec2/lib"),
              Path("/usr/lib/x86_64-linux-gnu"), Path("/usr/lib/aarch64-linux-gnu"), Path("/usr/lib"), Path("/usr/local/lib")):
        for n in names:
            yield d / n
    found = ctypes.util.find_library("codec2")
    if found:
        yield Path(found)


def lib():
    global _lib
    if _lib is None:
        for p in _candidates():
            try:
                if p.is_absolute() and not p.exists():
                    continue
                L = ctypes.CDLL(str(p))
                break
            except OSError:
                continue
        else:
            raise RuntimeError("FreeDV braucht die Bibliothek codec2 (macOS: brew install codec2, Linux: Paket libcodec2-1.2)")
        L.freedv_open.restype = ctypes.c_void_p
        L.freedv_open.argtypes = [ctypes.c_int]
        for f in ("freedv_close", "freedv_nin", "freedv_get_n_speech_samples", "freedv_get_n_max_speech_samples",
                  "freedv_get_n_nom_modem_samples", "freedv_get_n_max_modem_samples", "freedv_get_speech_sample_rate",
                  "freedv_get_modem_sample_rate", "freedv_get_sync", "freedv_get_n_tx_modem_samples"):
            getattr(L, f).argtypes = [ctypes.c_void_p]
        L.freedv_close.restype = None
        L.freedv_tx.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_short), ctypes.POINTER(ctypes.c_short)]
        L.freedv_tx.restype = None
        L.freedv_rx.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_short), ctypes.POINTER(ctypes.c_short)]
        L.freedv_rx.restype = ctypes.c_int
        L.freedv_get_modem_stats.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_float)]
        L.freedv_get_modem_stats.restype = None
        L.freedv_set_squelch_en.argtypes = [ctypes.c_void_p, ctypes.c_bool]
        L.freedv_set_squelch_en.restype = None
        _lib = L
    return _lib


def available() -> bool:
    try:
        lib()
        return True
    except RuntimeError:
        return False


class FreeDV:
    """Ein Modem-Kanal: tx(Sprache 8 kHz) -> Modemton; rx(Modemton) -> Sprache. Puffer werden intern gesammelt."""

    def __init__(self, mode: str = "700D"):
        L = lib()
        if mode not in MODES:
            raise ValueError(f"FreeDV-Modus {mode} unbekannt")
        self.L, self.mode = L, mode
        self.h = L.freedv_open(MODES[mode])
        if not self.h:
            raise RuntimeError(f"FreeDV {mode} kann nicht geöffnet werden")
        L.freedv_set_squelch_en(self.h, False)
        self.n_speech = L.freedv_get_n_speech_samples(self.h)
        self.n_max_speech = L.freedv_get_n_max_speech_samples(self.h)
        self.n_modem_tx = L.freedv_get_n_tx_modem_samples(self.h)
        self.n_max_modem = L.freedv_get_n_max_modem_samples(self.h)
        self.speech_rate = L.freedv_get_speech_sample_rate(self.h)
        self.modem_rate = L.freedv_get_modem_sample_rate(self.h)
        self._rxbuf = np.zeros(0, np.int16)
        self._txbuf = np.zeros(0, np.int16)
        self._out_speech = (ctypes.c_short * self.n_max_speech)()
        self._out_modem = (ctypes.c_short * self.n_modem_tx)()

    def rx(self, modem: np.ndarray) -> np.ndarray:
        """Modemton (int16, modem_rate) -> Sprache (int16, speech_rate)."""
        self._rxbuf = np.concatenate([self._rxbuf, modem.astype(np.int16)])
        out = []
        while True:
            nin = self.L.freedv_nin(self.h)
            if len(self._rxbuf) < nin:
                break
            blk = np.ascontiguousarray(self._rxbuf[:nin])
            self._rxbuf = self._rxbuf[nin:]
            n = self.L.freedv_rx(self.h, self._out_speech, blk.ctypes.data_as(ctypes.POINTER(ctypes.c_short)))
            if n > 0:
                out.append(np.frombuffer(self._out_speech, np.int16, n).copy())
        return np.concatenate(out) if out else np.zeros(0, np.int16)

    def tx(self, speech: np.ndarray) -> np.ndarray:
        """Sprache (int16, speech_rate) -> Modemton (int16, modem_rate)."""
        self._txbuf = np.concatenate([self._txbuf, speech.astype(np.int16)])
        out = []
        while len(self._txbuf) >= self.n_speech:
            blk = np.ascontiguousarray(self._txbuf[: self.n_speech])
            self._txbuf = self._txbuf[self.n_speech:]
            self.L.freedv_tx(self.h, self._out_modem, blk.ctypes.data_as(ctypes.POINTER(ctypes.c_short)))
            out.append(np.frombuffer(self._out_modem, np.int16, self.n_modem_tx).copy())
        return np.concatenate(out) if out else np.zeros(0, np.int16)

    def stats(self) -> dict:
        sync, snr = ctypes.c_int(0), ctypes.c_float(0)
        self.L.freedv_get_modem_stats(self.h, ctypes.byref(sync), ctypes.byref(snr))
        return dict(sync=bool(sync.value), snr=round(float(snr.value), 1))

    def close(self):
        if self.h:
            self.L.freedv_close(self.h)
            self.h = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
