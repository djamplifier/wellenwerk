"""SDR-Empfaenger direkt per USB, ohne Zusatzprogramm: RTL-SDR (librtlsdr, Fassung von RTL-SDR Blog – auch V4 auf
Kurzwelle) und HackRF One (libhackrf). Die Bibliotheken liegen dem Programm bei (packaging/sdrlibs) oder werden im System
gesucht (Homebrew, Linux-Pakete librtlsdr0/libhackrf0).

Windows: Das Geraet braucht einmalig den WinUSB-Treiber (Programm Zadig). Linux: udev-Regeln der Pakete rtl-sdr/hackrf
bzw. Benutzer in der Gruppe plugdev.

Parameter (mit ; getrennt):
  device=0 | serial=…   welches Geraet (Reihenfolge oder Seriennummer)
  rate=…                Abtastrate (RTL-SDR 1536000, HackRF 4800000; Vielfaches von 12 kHz)
  gain=auto | dB        Verstaerkung (HackRF: LNA+VGA zusammen, 0..102 dB)
  amp=0|1               HackRF: Vorverstaerker (+11 dB)
  ppm=0                 Frequenzkorrektur (RTL-SDR)
  direct=0|1|2          RTL-SDR: Direktabtastung fuer Kurzwelle bei Geraeten ohne V4-Konverter (2 = Q-Zweig, z. B. Blog V3)
  bias=0|1              Speisespannung fuer aktive Antennen/LNA
  rx_offset=0           Frequenzversatz LNB/Transverter: Anzeige = Hardware + Versatz
  HackRF senden (nur mit Amateurfunkzulassung, gesendet wird nur in den Amateurfunkbaendern):
  tx=1                  Senden freigeben
  power=20              Sendeverstaerkung 0..47 dB (HackRF gibt je nach Band nur wenige mW ab)
  tx_amp=0|1            HackRF-Endverstaerker beim Senden (+11 dB)
  Wichtig: Der HackRF hat kein Oberwellenfilter – am Ausgang gehoert ein Tiefpass fuer das jeweilige Band.
"""
import asyncio
import ctypes
import ctypes.util
import sys
import threading
from pathlib import Path

import numpy as np

from ..rig import RigError
from .iq import IqRig

_LIBS: dict = {}


def _find(base: str):
    """Bibliothek suchen: mitgeliefert, Homebrew, System."""
    if base in _LIBS:
        return _LIBS[base]
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent.parent))
    names = {"win32": [f"{base}.dll", f"lib{base}.dll"], "darwin": [f"lib{base}.dylib", f"lib{base}.0.dylib"]}.get(
        sys.platform, [f"lib{base}.so", f"lib{base}.so.0"])
    dirs = [here / "sdrlibs", here / "packaging" / "sdrlibs", Path("/opt/homebrew/lib"), Path("/usr/local/lib"),
            Path("/usr/lib/x86_64-linux-gnu"), Path("/usr/lib/aarch64-linux-gnu"), Path("/usr/lib")]
    err = ""
    if sys.platform == "win32":
        for d in dirs[:2]:
            if d.is_dir():
                try:
                    import os
                    os.add_dll_directory(str(d))                 # abhaengige DLLs (libusb, pthread) daneben finden
                except Exception:
                    pass
    for d in dirs:
        for n in names:
            p = d / n
            if p.exists():
                try:
                    _LIBS[base] = ctypes.CDLL(str(p))
                    return _LIBS[base]
                except OSError as e:
                    err = str(e)
    f = ctypes.util.find_library(base)
    if f:
        try:
            _LIBS[base] = ctypes.CDLL(f)
            return _LIBS[base]
        except OSError as e:
            err = str(e)
    _LIBS[base] = None
    if err:
        _LIBS[base + ":err"] = err
    return None


def _need(base: str, what: str):
    lib = _find(base)
    if not lib:
        raise RigError(f"{what}: Treiberbibliothek lib{base} nicht gefunden" + (f" ({_LIBS.get(base + ':err')})" if _LIBS.get(base + ":err") else "")
                       + " – im Desktop-Programm ist sie enthalten; sonst Paket installieren (macOS: brew install " + ("librtlsdr" if base == "rtlsdr" else "hackrf")
                       + ", Linux: lib" + base + "0)")
    return lib


# ---------- RTL-SDR ----------
def _rtl(lib):
    if getattr(lib, "_ww", False):
        return lib
    V, I, U, P, C = ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32, ctypes.POINTER, ctypes.c_char_p
    for n, res, args in [("rtlsdr_get_device_count", U, []), ("rtlsdr_get_device_name", C, [U]),
                         ("rtlsdr_get_device_usb_strings", I, [U, C, C, C]), ("rtlsdr_open", I, [P(V), U]), ("rtlsdr_close", I, [V]),
                         ("rtlsdr_set_center_freq", I, [V, U]), ("rtlsdr_set_freq_correction", I, [V, I]), ("rtlsdr_set_sample_rate", I, [V, U]),
                         ("rtlsdr_set_tuner_gain_mode", I, [V, I]), ("rtlsdr_set_tuner_gain", I, [V, I]), ("rtlsdr_get_tuner_gains", I, [V, P(I)]),
                         ("rtlsdr_set_agc_mode", I, [V, I]), ("rtlsdr_set_direct_sampling", I, [V, I]), ("rtlsdr_reset_buffer", I, [V]),
                         ("rtlsdr_read_sync", I, [V, V, I, P(I)]), ("rtlsdr_get_tuner_type", I, [V])]:
        f = getattr(lib, n)
        f.restype, f.argtypes = res, args
    try:
        lib.rtlsdr_set_bias_tee.restype, lib.rtlsdr_set_bias_tee.argtypes = I, [V, I]
    except AttributeError:
        pass
    lib._ww = True
    return lib


def rtl_devices() -> list[dict]:
    lib = _find("rtlsdr")
    if not lib:
        return []
    lib = _rtl(lib)
    out = []
    for i in range(lib.rtlsdr_get_device_count()):
        m, p, s = (ctypes.create_string_buffer(256) for _ in range(3))
        lib.rtlsdr_get_device_usb_strings(i, m, p, s)
        out.append(dict(kind="rtlusb", index=i, name=(lib.rtlsdr_get_device_name(i) or b"").decode(errors="replace"),
                        product=p.value.decode(errors="replace"), serial=s.value.decode(errors="replace")))
    return out


class RtlUsbRig(IqRig):
    kind = "rtlusb"
    RATE = 1536000
    TUNERS = {1: "E4000", 2: "FC0012", 3: "FC0013", 4: "FC2580", 5: "R820T", 6: "R828D"}

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.dev = None
        self.lock = threading.Lock()
        self.rx_off = int(float(self.p.get("rx_offset") or self.params.get("rx_offset") or 0))
        self.state["offsets"] = dict(rx=self.rx_off, tx=0)

    async def set_center(self, hz: int):
        self.center = hz
        if self.dev:
            with self.lock:
                self.lib.rtlsdr_set_center_freq(self.dev, max(0, int(hz - self.rx_off)))

    async def apply_level(self, name, value):
        if self.dev and name == "RF" and self.params.get("gain", "auto") == "auto":
            with self.lock:
                self.lib.rtlsdr_set_tuner_gain_mode(self.dev, 1)
                self.lib.rtlsdr_set_tuner_gain(self.dev, self._near_gain(value * 50))

    def _near_gain(self, db: float) -> int:
        n = self.lib.rtlsdr_get_tuner_gains(self.dev, None)
        if n <= 0:
            return int(db * 10)
        g = (ctypes.c_int * n)()
        self.lib.rtlsdr_get_tuner_gains(self.dev, g)
        return min(g, key=lambda x: abs(x - db * 10))

    def _index(self) -> int:
        ser = self.params.get("serial")
        if ser:
            for d in rtl_devices():
                if d["serial"] == ser:
                    return d["index"]
            raise RigError(f"RTL-SDR mit Seriennummer {ser} nicht gefunden")
        return int(self.params.get("device", 0))

    async def run(self):
        self.lib = _rtl(_need("rtlsdr", "RTL-SDR"))
        n = self.lib.rtlsdr_get_device_count()
        if not n:
            raise RigError("Kein RTL-SDR am USB gefunden" + (" – unter Windows einmalig den WinUSB-Treiber mit Zadig installieren" if sys.platform == "win32" else ""))
        idx = self._index()
        dev = ctypes.c_void_p()
        r = self.lib.rtlsdr_open(ctypes.byref(dev), idx)
        if r < 0 or not dev:
            raise RigError(f"RTL-SDR {idx} lässt sich nicht öffnen (Fehler {r}) – belegt von einem anderen Programm?"
                           + (" Treiber mit Zadig auf WinUSB umstellen." if sys.platform == "win32" else ""))
        self.dev = dev
        L = self.lib
        L.rtlsdr_set_sample_rate(dev, self.rate)
        if int(float(self.params.get("ppm", 0))):
            L.rtlsdr_set_freq_correction(dev, int(float(self.params["ppm"])))
        tuner = self.TUNERS.get(L.rtlsdr_get_tuner_type(dev), "?")
        direct = int(self.params.get("direct", 0) or 0)
        if direct:
            L.rtlsdr_set_direct_sampling(dev, direct)
        if hasattr(L, "rtlsdr_set_bias_tee") and self.params.get("bias") in ("1", "ja", "true"):
            L.rtlsdr_set_bias_tee(dev, 1)
        g = self.params.get("gain", "auto")
        if g == "auto":
            L.rtlsdr_set_tuner_gain_mode(dev, 0)
            L.rtlsdr_set_agc_mode(dev, 1)
        else:
            L.rtlsdr_set_tuner_gain_mode(dev, 1)
            L.rtlsdr_set_tuner_gain(dev, self._near_gain(float(g)))
        # Empfangsbereich: V4 (R828D mit eingebautem Konverter) ab Langwelle, Direktabtastung nur Kurzwelle, sonst ab 24 MHz
        lo = 500_000 if tuner == "R828D" else 24_000_000
        self.state["sdr"]["ranges"] = [[500_000 + self.rx_off, 28_800_000 + self.rx_off]] if direct else [[lo + self.rx_off, 1_766_000_000 + self.rx_off]]
        L.rtlsdr_reset_buffer(dev)
        self.center = 0
        await self.tune()
        self.state.update(connected=True, error="")
        self.state["sdr"]["info"] = f"RTL-SDR (USB), Tuner {tuner}, {self.rate / 1e6:.3f} MS/s"
        self.say(f"verbunden: RTL-SDR {idx}, Tuner {tuner}")
        await self.changed(True)
        chunk = self.rate // 20 * 2                          # 50 ms; Vielfaches von 512
        chunk -= chunk % 512
        buf = (ctypes.c_uint8 * chunk)()
        got = ctypes.c_int()
        loop = asyncio.get_running_loop()

        def read():
            with self.lock:
                r = L.rtlsdr_read_sync(dev, buf, chunk, ctypes.byref(got))
            if r < 0:
                raise RigError(f"RTL-SDR liefert keine Daten mehr (Fehler {r}) – USB getrennt?")
            return bytes(buf)[: got.value]

        while True:
            raw = await loop.run_in_executor(None, read)
            if not raw:
                continue
            u = np.frombuffer(raw, np.uint8).astype(np.float32)
            iq = ((u[0::2] - 127.5) + 1j * (u[1::2] - 127.5)).astype(np.complex64) / 127.5
            await self.feed(iq)

    async def close(self):
        if self.dev:
            dev, self.dev = self.dev, None
            with self.lock:
                try:
                    self.lib.rtlsdr_close(dev)
                except Exception:
                    pass


# ---------- HackRF One ----------
class _HTransfer(ctypes.Structure):
    _fields_ = [("device", ctypes.c_void_p), ("buffer", ctypes.POINTER(ctypes.c_uint8)), ("buffer_length", ctypes.c_int),
                ("valid_length", ctypes.c_int), ("rx_ctx", ctypes.c_void_p), ("tx_ctx", ctypes.c_void_p)]


class _HList(ctypes.Structure):
    _fields_ = [("serial_numbers", ctypes.POINTER(ctypes.c_char_p)), ("usb_board_ids", ctypes.POINTER(ctypes.c_int)),
                ("usb_device_index", ctypes.POINTER(ctypes.c_int)), ("devicecount", ctypes.c_int),
                ("usb_devices", ctypes.POINTER(ctypes.c_void_p)), ("usb_devicecount", ctypes.c_int)]


HCB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_HTransfer))


def _hrf(lib):
    if getattr(lib, "_ww", False):
        return lib
    V, I, U, P, C, D, U8, U64 = ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32, ctypes.POINTER, ctypes.c_char_p, ctypes.c_double, ctypes.c_uint8, ctypes.c_uint64
    for n, res, args in [("hackrf_init", I, []), ("hackrf_exit", I, []), ("hackrf_device_list", P(_HList), []), ("hackrf_device_list_free", None, [P(_HList)]),
                         ("hackrf_open_by_serial", I, [C, P(V)]), ("hackrf_close", I, [V]), ("hackrf_set_sample_rate", I, [V, D]),
                         ("hackrf_compute_baseband_filter_bw", U, [U]), ("hackrf_set_baseband_filter_bandwidth", I, [V, U]),
                         ("hackrf_set_freq", I, [V, U64]), ("hackrf_set_lna_gain", I, [V, U]), ("hackrf_set_vga_gain", I, [V, U]),
                         ("hackrf_set_txvga_gain", I, [V, U]), ("hackrf_set_amp_enable", I, [V, U8]), ("hackrf_set_antenna_enable", I, [V, U8]),
                         ("hackrf_start_rx", I, [V, HCB, V]), ("hackrf_stop_rx", I, [V]), ("hackrf_start_tx", I, [V, HCB, V]), ("hackrf_stop_tx", I, [V]),
                         ("hackrf_is_streaming", I, [V]), ("hackrf_error_name", C, [I])]:
        f = getattr(lib, n)
        f.restype, f.argtypes = res, args
    lib.hackrf_init()
    lib._ww = True
    return lib


def hackrf_devices() -> list[dict]:
    lib = _find("hackrf")
    if not lib:
        return []
    lib = _hrf(lib)
    lst = lib.hackrf_device_list()
    if not lst:
        return []
    try:
        L = lst.contents
        return [dict(kind="hackrf", index=i, name="HackRF", serial=(L.serial_numbers[i] or b"").decode(errors="replace")) for i in range(L.devicecount)]
    finally:
        lib.hackrf_device_list_free(lst)


class HackRfRig(IqRig):
    kind = "hackrf"
    RATE = 4800000
    TX_CAPABLE = True
    TX_RATE = 2400000
    TX_LO_OFF = 300000                                   # Sende-LO neben der Sendefrequenz: Traegerrest (DC) faellt nicht aufs Signal

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.dev = None
        self.q: asyncio.Queue | None = None
        self.rx_off = int(float(self.p.get("rx_offset") or self.params.get("rx_offset") or 0))
        self.state["offsets"] = dict(rx=self.rx_off, tx=0)
        self.state["sdr"]["ranges"] = [[1_000_000 + self.rx_off, 6_000_000_000 + self.rx_off]]
        self._cb = None
        self._txcb = None
        self.mox = False
        self._ring = bytearray()
        self._rl = threading.Lock()

    def _err(self, r, what):
        if r != 0:
            raise RigError(f"HackRF: {what} fehlgeschlagen ({(self.lib.hackrf_error_name(r) or b'').decode()})")

    async def set_center(self, hz: int):
        self.center = hz
        if self.dev:
            self.lib.hackrf_set_freq(self.dev, max(1_000_000, int(hz - self.rx_off)))

    def _gain(self, db: float):
        """Gesamtverstaerkung auf LNA (0..40, 8er-Schritte) und VGA (0..62, 2er-Schritte) verteilen."""
        db = max(0.0, min(102.0, db))
        lna = min(40, int(db * 0.45) // 8 * 8)
        vga = min(62, int(db - lna) // 2 * 2)
        self.lib.hackrf_set_lna_gain(self.dev, lna)
        self.lib.hackrf_set_vga_gain(self.dev, vga)

    async def apply_level(self, name, value):
        if self.dev and name == "RF" and self.params.get("gain", "auto") == "auto":
            self._gain(value * 90)

    async def run(self):
        self.lib = _hrf(_need("hackrf", "HackRF"))
        devs = hackrf_devices()
        if not devs:
            raise RigError("Kein HackRF am USB gefunden" + (" – unter Windows einmalig den WinUSB-Treiber mit Zadig installieren" if sys.platform == "win32" else ""))
        ser = self.params.get("serial") or devs[int(self.params.get("device", 0)) % len(devs)]["serial"]
        dev = ctypes.c_void_p()
        self._err(self.lib.hackrf_open_by_serial(ser.encode(), ctypes.byref(dev)), "Öffnen (belegt von einem anderen Programm?)")
        self.dev = dev
        L = self.lib
        self._err(L.hackrf_set_sample_rate(dev, float(self.rate)), "Abtastrate")
        L.hackrf_set_baseband_filter_bandwidth(dev, L.hackrf_compute_baseband_filter_bw(int(self.rate * 0.75)))
        L.hackrf_set_amp_enable(dev, 1 if self.params.get("amp") in ("1", "ja", "true") else 0)
        L.hackrf_set_antenna_enable(dev, 1 if self.params.get("bias") in ("1", "ja", "true") else 0)
        g = self.params.get("gain", "auto")
        self._gain(40 if g == "auto" else float(g))
        self.center = 0
        await self.tune()
        loop = asyncio.get_running_loop()
        self.q = asyncio.Queue(maxsize=40)

        def put(b):
            if self.q.full():
                try:
                    self.q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            self.q.put_nowait(b)

        def cb(t):                                           # laeuft im USB-Thread der Bibliothek
            tr = t.contents
            if tr.valid_length > 0 and self.dev:
                loop.call_soon_threadsafe(put, ctypes.string_at(tr.buffer, tr.valid_length))
            return 0

        self._cb = HCB(cb)
        self._err(L.hackrf_start_rx(dev, self._cb, None), "Empfang starten")
        self.state.update(connected=True, error="")
        self.state["sdr"]["info"] = f"HackRF One {ser[-8:]}, {self.rate / 1e6:.1f} MS/s"
        self.say(f"verbunden: HackRF {ser}")
        await self.changed(True)
        while True:
            try:
                raw = await asyncio.wait_for(self.q.get(), 3)
            except asyncio.TimeoutError:
                if self.mox:                                 # beim Senden ruht der Empfang
                    continue
                raise RigError("HackRF liefert keine Daten mehr – USB getrennt?")
            s = np.frombuffer(raw, np.int8).astype(np.float32)
            iq = (s[0::2] + 1j * s[1::2]).astype(np.complex64) / 128.0
            await self.feed(iq)

    # ---------- Senden (HackRF ist halbduplex: Empfang ruht) ----------
    def _rx_start(self):
        L, dev = self.lib, self.dev
        L.hackrf_set_sample_rate(dev, float(self.rate))
        L.hackrf_set_baseband_filter_bandwidth(dev, L.hackrf_compute_baseband_filter_bw(int(self.rate * 0.75)))
        L.hackrf_set_amp_enable(dev, 1 if self.params.get("amp") in ("1", "ja", "true") else 0)
        L.hackrf_set_freq(dev, max(1_000_000, int(self.center - self.rx_off)))
        self._err(L.hackrf_start_rx(dev, self._cb, None), "Empfang starten")

    async def tx_start(self):
        from .dsp import Modulator
        if not self.dev:
            raise RigError("HackRF nicht verbunden")
        L, dev = self.lib, self.dev
        for _ in range(6):                                   # kurz Ton sammeln
            if self.tx_pending() >= 1200:
                break
            await asyncio.sleep(0.025)
        self.mod = Modulator(self.TX_RATE)
        self._ph = 0.0
        with self._rl:
            self._ring = bytearray()
        L.hackrf_stop_rx(dev)
        f = int(self.state["freq"] - self.rx_off)
        L.hackrf_set_sample_rate(dev, float(self.TX_RATE))
        L.hackrf_set_baseband_filter_bandwidth(dev, L.hackrf_compute_baseband_filter_bw(int(self.TX_RATE * 0.75)))
        L.hackrf_set_freq(dev, f + self.TX_LO_OFF)
        L.hackrf_set_amp_enable(dev, 1 if self.params.get("tx_amp") in ("1", "ja", "true") else 0)
        L.hackrf_set_txvga_gain(dev, max(0, min(47, int(float(self.params.get("power", 20))))))
        self.mox = True
        self._fill(0.25)

        def cb(t):                                           # USB-Thread: Puffer aus dem Ring fuellen, sonst Stille
            tr = t.contents
            n = tr.buffer_length
            with self._rl:
                k = min(n, len(self._ring))
                if k:
                    ctypes.memmove(tr.buffer, bytes(self._ring[:k]), k)
                    del self._ring[:k]
            if k < n:
                ctypes.memset(ctypes.addressof(tr.buffer.contents) + k, 0, n - k)
            tr.valid_length = n
            return 0

        self._txcb = HCB(cb)
        self._err(L.hackrf_start_tx(dev, self._txcb, None), "Senden starten")
        self._txtask = asyncio.ensure_future(self._tx_loop())

    def _fill(self, seconds: float):
        """Ring bis auf seconds Vorrat mit moduliertem, um den LO-Versatz verschobenem Signal (Int8) fuellen."""
        want = int(self.TX_RATE * seconds) * 2
        while len(self._ring) < want and self.mox:
            a = self.tx_take(480)                            # 40 ms Ton
            z = self.mod.process(a, self.state["mode"], fm_dev=int(float(self.params.get("fm_dev", 2500))))
            ph = self._ph + (-2 * np.pi * self.TX_LO_OFF / self.TX_RATE) * np.arange(len(z))
            z = z * np.exp(1j * ph).astype(np.complex64)
            self._ph = float((ph[-1] - 2 * np.pi * self.TX_LO_OFF / self.TX_RATE) % (2 * np.pi))
            b = np.empty(len(z) * 2, np.int8)
            b[0::2] = np.clip(z.real * 120, -127, 127)
            b[1::2] = np.clip(z.imag * 120, -127, 127)
            with self._rl:
                self._ring += b.tobytes()

    async def _tx_loop(self):
        loop = asyncio.get_running_loop()
        while self.mox:
            await loop.run_in_executor(None, self._fill, 0.25)
            await asyncio.sleep(0.02)

    async def tx_stop(self):
        if not self.mox:
            return
        self.mox = False
        if self.dev:
            try:
                self.lib.hackrf_stop_tx(self.dev)
            except Exception:
                pass
            self._rx_start()

    async def close(self):
        self.mox = False
        if self.dev:
            dev, self.dev = self.dev, None
            try:
                self.lib.hackrf_stop_tx(dev)
            except Exception:
                pass
            try:
                self.lib.hackrf_stop_rx(dev)
                self.lib.hackrf_close(dev)
            except Exception:
                pass


def devices() -> list[dict]:
    """Alle per USB angeschlossenen SDRs (fuer den Verbinden-Dialog)."""
    out = []
    for f in (rtl_devices, hackrf_devices):
        try:
            out += f()
        except Exception:
            pass
    return out


def selftest() -> dict:
    """Fuer den Build: lassen sich die Bibliotheken laden und die Funktionen binden?"""
    res = {}
    for base, bind in (("rtlsdr", _rtl), ("hackrf", _hrf)):
        lib = _find(base)
        if not lib:
            raise SystemExit(f"lib{base} nicht ladbar: {_LIBS.get(base + ':err', 'nicht gefunden')}")
        bind(lib)
        res[base] = "ok"
    res["geraete"] = devices()
    return res
