"""Optionales Sprachmodul fuer DMR, D-STAR und YSF (AMBE/AMBE+2).

Wellenwerk liefert dafuer keinen Code mit. Auf Knopfdruck (und nur mit ausdruecklicher Zustimmung des Nutzers) wird
mbelib (ISC-Lizenz, github.com/szechyjs/mbelib) in einer festen Fassung aus dem Originalquelltext geladen, jede Datei
per SHA-256 geprueft und mit dem C-Compiler des Rechners zu einer Bibliothek im Datenordner uebersetzt. Ob die Nutzung
der AMBE-Verfahren am eigenen Ort Patent- oder Lizenzrechte beruehrt, verantwortet der Nutzer.

Die Verschachtelungstabellen fuer DMR und D-STAR stammen aus DSD (ISC-Lizenz, Copyright (C) 2010 DSD Author).
"""
from __future__ import annotations

import ctypes
import hashlib
import io
import logging
import shutil
import subprocess
import sys
import tarfile
import threading
import urllib.request
from pathlib import Path

import numpy as np

log = logging.getLogger("ww.voice")

MBELIB_REV = "9a04ed5c78176a9965f3d43f7aa1b1f5330e771f"
MBELIB_URL = f"https://codeload.github.com/szechyjs/mbelib/tar.gz/{MBELIB_REV}"
MBELIB_SHA256 = {
    "ambe3600x2400.c": "30fc8c891bd0e2971115381d85bda874a5fdf549b295db66dec6f43efcb70ca1",
    "ambe3600x2400_const.h": "27dd645e468c3ba1f0d2e420cc784ea5f8850cc973ce4a4f8519c4055c1511a1",
    "ambe3600x2450.c": "677f1542021011d91e79b5ee7dfe2579e6f02fd173dbbfb4e69c6eba859465e0",
    "ambe3600x2450_const.h": "cb02e200baa88e7cda37b9dc57085fd942a9f2911e9707e5c5f998de57f2361a",
    "ecc.c": "ea2dfd7d7b2f00ac640e2b0b215ddcf97425c4a822b74811120c7ae7a7fef88a",
    "ecc_const.h": "8bd6b61dce5684e92dfbe3f5e4ddfce522dc5be3e3387a99361e645f9e60f153",
    "imbe7100x4400.c": "3309d18dccee7e9893f84ac38ae954bb0673eed2edd2f56de8b5addefef74a42",
    "imbe7200x4400.c": "da185a5cdcaf2dd2d03a6ea2524bdeea339f97a9d5985efc0fc3a0ad41f172b9",
    "imbe7200x4400_const.h": "62982451d7c23d3d6d255bf1dff34c4bdcf9c40e0aa04b7f5f40393705924737",
    "mbelib.c": "f51242d7d23693870af503c7614a886ed6f119c5f215a1841fa81714b7f425ed",
    "mbelib.h": "be480617bb4750d2a6ed493b24a80c9e958c60ff3dd58c928fc348b5a46d312e",
    "mbelib_const.h": "656718c330e5170b2fa5979d9b28bfb96f970f5af7211f29b450481afbe4d07d",
    "config.h": "d77dadc82cf65808b908a268ec4757b0fc55a2d326dd9dd79607ad38cbf3655d",
    "COPYRIGHT": "59df7c481fca54d6ccab5ef36fe1ae6a8217b7f5e13ee4d18f63684a29871b8b",
}
LIBNAME = {"darwin": "libmbe.dylib", "win32": "mbe.dll"}.get(sys.platform, "libmbe.so")

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
_state = {"state": "missing", "msg": "", "compiler": ""}
_lib = None
_lock = threading.Lock()


def _dir(data: Path) -> Path:
    return data / "module" / "mbelib"


def compiler() -> str:
    for c in ("cc", "gcc", "clang"):
        p = shutil.which(c)
        if p:
            return p
    return ""


def status(data: Path) -> dict:
    if _state["state"] != "building":
        if _lib is not None or (_dir(data) / LIBNAME).exists():
            _state.update(state="ready")
        elif _state["state"] == "ready":
            _state.update(state="missing")
    hint = ""
    if not compiler():
        hint = {"darwin": "Kein C-Compiler gefunden – im Terminal „xcode-select --install“ ausführen.",
                "win32": "Kein C-Compiler gefunden – z. B. w64devkit oder MSYS2 (gcc) installieren und in den PATH aufnehmen."}.get(
            sys.platform, "Kein C-Compiler gefunden – z. B. „sudo apt install build-essential“.")
    return dict(_state, compiler=compiler(), hint=hint, version=MBELIB_REV[:10], license="ISC")


def build(data: Path) -> None:
    """Quelltext laden, pruefen, uebersetzen (im Hintergrund aufrufen)."""
    with _lock:
        if _state["state"] == "building":
            return
        _state.update(state="building", msg="Quelltext wird geladen …")
    try:
        cc = compiler()
        if not cc:
            raise RuntimeError(status(data)["hint"])
        raw = urllib.request.urlopen(urllib.request.Request(MBELIB_URL, headers={"User-Agent": "Wellenwerk"}), timeout=60).read()
        src = _dir(data) / "src"
        shutil.rmtree(src, ignore_errors=True)
        src.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
            for m in tf.getmembers():
                name = m.name.split("/", 1)[-1]
                if name in MBELIB_SHA256 and m.isfile():
                    (src / name).write_bytes(tf.extractfile(m).read())
        for name, sha in MBELIB_SHA256.items():
            f = src / name
            if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != sha:
                raise RuntimeError(f"Prüfsumme stimmt nicht: {name} – Abbruch, nichts übersetzt")
        _state["msg"] = "wird übersetzt …"
        out = _dir(data) / LIBNAME
        cfiles = [str(src / n) for n in MBELIB_SHA256 if n.endswith(".c")]
        cmd = [cc, "-O2", "-shared", "-o", str(out), *cfiles, "-I", str(src)]
        if sys.platform != "win32":
            cmd[3:3] = ["-fPIC"]
            cmd.append("-lm")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0 or not out.exists():
            raise RuntimeError("Übersetzen fehlgeschlagen: " + (r.stderr or r.stdout)[-400:])
        _load(data)
        _state.update(state="ready", msg="")
        log.info("Sprachmodul (mbelib %s) gebaut: %s", MBELIB_REV[:10], out)
    except Exception as e:
        log.warning("Sprachmodul: %s", e)
        _state.update(state="error", msg=str(e))


def remove(data: Path) -> None:
    global _lib
    _lib = None                                           # bereits geladene Bibliothek bleibt bis zum Neustart im Speicher
    shutil.rmtree(_dir(data), ignore_errors=True)
    _state.update(state="missing", msg="")


def _load(data: Path):
    global _lib
    if _lib is None:
        p = _dir(data) / LIBNAME
        if not p.exists():
            return None
        lib = ctypes.CDLL(str(p))
        for fn in ("mbe_processAmbe3600x2400Framef", "mbe_processAmbe3600x2450Framef", "mbe_processAmbe2450Dataf"):
            getattr(lib, fn).restype = None
        _lib = lib
    return _lib


def available(data: Path) -> bool:
    try:
        return _load(data) is not None
    except OSError as e:
        _state.update(state="error", msg=str(e))
        return False


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
