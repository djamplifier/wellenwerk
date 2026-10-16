"""Gemeinsame Grundlage fuer Empfaenger: Zustand und Faehigkeiten wie bei rig.Rig, nicht vorhandene
Funktionen melden sich mit verstaendlichem Fehler, Senden ist grundsaetzlich gesperrt."""
import asyncio
import logging
import time
from collections import deque
from urllib.parse import parse_qsl

from ..rig import RigError, LEVELS, FUNCS


class SdrRefused(RigError):
    """Der Server lehnt dauerhaft ab (Passwort, ausser Betrieb, Umleitung) – kein automatischer neuer Versuch."""

log = logging.getLogger("ww.sdr")

AGC_NAMES = {0: "AUS", 2: "FAST", 6: "MITTEL", 3: "SLOW"}


def parse_params(text: str) -> dict:
    """Freie Zusatzparameter eines Empfaengers: 'key=wert; key2=wert2' oder 'key=wert&key2=wert2'."""
    out = {}
    for part in (text or "").replace(";", "&").replace("\n", "&").split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


class SdrRig:
    kind = "sdr"
    MODES = ["USB", "LSB", "CW", "CWR", "AM", "SAM", "FM", "PKTUSB", "PKTLSB", "RTTY"]
    LEVELS_SET = ["AF", "RF", "AGC"]
    FUNCS_SET = ["NB"]

    def __init__(self, profile: dict, on_change, on_spectrum=None, on_audio=None):
        self.p = profile
        self.params = parse_params(profile.get("params", ""))
        self.on_change, self.on_spectrum, self.on_audio = on_change, on_spectrum, on_audio
        self.state = dict(connected=False, freq=int(float(self.params.get("freq", 0) or 0) * 1000) or 7074000,
                          mode=(self.params.get("mode") or "USB").upper(), passband=0, ptt=False, error="",
                          vfo="VFOA", vfob_freq=0, vfob_mode="", split=False, tx_vfo="", rit=0, xit=0,
                          levels={"AF": 0.8, "RF": 0.5, "AGC": 6}, funcs={"NB": False}, meters={"STRENGTH": -54.0},
                          receiver=True, sdr=dict(kind=self.kind, name=profile.get("name", ""), users="", info=""))
        self.caps = self._caps()
        self.log = deque(maxlen=200)
        self._last_push = 0.0

    # ---------- Faehigkeiten (gleiche Form wie rig.Rig._caps) ----------
    def _caps(self) -> dict:
        ui_levels = []
        for name in self.LEVELS_SET:
            if name in LEVELS and name != "AGC":
                label, typ, lo, hi, step, unit = LEVELS[name]
                ui_levels.append(dict(name=name, label=label, type=typ, min=lo, max=hi, step=step, unit=unit))
        return dict(model=self.p.get("model_name") or "Empfänger", mfg=self.p.get("mfg") or "SDR",
                    levels_get=list(self.LEVELS_SET) + ["STRENGTH"], levels_set=list(self.LEVELS_SET),
                    funcs_get=list(self.FUNCS_SET), funcs_set=list(self.FUNCS_SET), vfo_ops=[], modes=list(self.MODES),
                    preamp=[], att=[], agc=[0, 2, 6, 3], ranges={}, max_rit=0, max_xit=0, memories=[],
                    ui_levels=ui_levels, ui_funcs=[dict(name=n, label=FUNCS.get(n, n)) for n in self.FUNCS_SET],
                    ui_ops=[], ui_choices=[dict(name="AGC", label="AGC", options=[dict(value=a, label=AGC_NAMES[a]) for a in (0, 2, 6, 3)])],
                    meters=["STRENGTH"], receiver=True)

    def say(self, text: str):
        self.log.append(time.strftime("%H:%M:%S ") + text)
        log.info("%s: %s", self.p.get("name"), text)

    async def changed(self, force: bool = False):
        now = time.monotonic()
        if not force and now - self._last_push < 0.2:       # Messwerte hoechstens 5x/s melden
            return
        self._last_push = now
        await self.on_change(dict(self.state))

    # ---------- gleiche Schnittstelle wie rig.Rig ----------
    async def set_freq(self, hz: int):
        old = self.state.get("freq")
        self.state["freq"] = int(hz)
        try:
            await self.tune()
        except RigError:                 # nicht empfangbar: Anzeige bleibt auf der alten Frequenz
            self.state["freq"] = old
            await self.changed(True)
            raise
        await self.changed(True)

    async def set_mode(self, mode: str, passband: int = 0):
        mode = mode.upper()
        if mode not in self.MODES:
            raise RigError(f"Betriebsart {mode} kann dieser Empfänger nicht")
        self.state["mode"], self.state["passband"] = mode, int(passband or 0)
        await self.tune()
        await self.changed(True)

    async def set_level(self, name: str, value: float):
        if name not in self.LEVELS_SET:
            raise RigError(f"Regler {name} gibt es bei diesem Empfänger nicht")
        self.state["levels"][name] = float(value)
        await self.apply_level(name, float(value))
        await self.changed(True)

    async def set_func(self, name: str, on: bool):
        if name not in self.FUNCS_SET:
            raise RigError(f"Funktion {name} gibt es bei diesem Empfänger nicht")
        self.state["funcs"][name] = bool(on)
        await self.apply_func(name, bool(on))
        await self.changed(True)

    async def set_ptt(self, on: bool):
        if on:
            raise RigError("Dies ist ein Empfänger – Senden ist nicht möglich")

    async def _no(self, *a, **k):
        raise RigError("Diese Funktion gibt es bei einem Empfänger nicht")

    vfo_op = set_vfo = set_split = set_split_freq = set_repeater = set_ctcss = set_rit = set_xit = _no
    send_morse = stop_morse = memory_op = get_channel = _no

    async def stop_morse(self):
        return None

    # ---------- von den Empfaenger-Arten umzusetzen ----------
    async def run(self):
        raise NotImplementedError

    async def tune(self):
        pass

    async def apply_level(self, name, value):
        pass

    async def apply_func(self, name, on):
        pass

    async def close(self):
        pass

    def passband(self) -> tuple[int, int]:
        """Durchlassbereich (low, high) in Hz relativ zur Traegerfrequenz fuer die aktuelle Betriebsart."""
        m, pb = self.state["mode"], int(self.state.get("passband") or 0)
        if m in ("USB", "RTTY"):
            return (300, pb + 300 if pb else 2700)
        if m == "PKTUSB":
            return (100, pb + 100 if pb else 3000)
        if m == "LSB":
            return (-(pb + 300 if pb else 2700), -300)
        if m == "PKTLSB":
            return (-(pb + 100 if pb else 3000), -100)
        if m in ("CW", "CWR"):
            w = pb or 500
            return (500 - w // 2, 500 + w // 2) if m == "CW" else (-500 - w // 2, -500 + w // 2)
        if m in ("AM", "SAM"):
            w = (pb or 9800) // 2
            return (-w, w)
        if m == "FM":
            w = (pb or 12000) // 2
            return (-w, w)
        return (300, 2700)


class _Alive:
    def __init__(self):
        self.code = None

    def poll(self):
        return self.code


class SdrProc:
    """Gleiche Schnittstelle wie radios.RadioProc, nur ohne Hamlib-Prozess."""

    def __init__(self, profile: dict, rig_cls, on_change, on_spectrum=None, on_audio=None):
        self.p = profile
        self.port = None
        self.scope = True
        self.proc = _Alive()
        self.on_change, self.on_spectrum, self.on_audio = on_change, on_spectrum, on_audio
        self.rig = rig_cls(profile, self._changed, self._spectrum, self._audio)
        self.log = self.rig.log
        self.task = None

    async def _changed(self, state):
        await self.on_change(self.p["id"], state)

    def _spectrum(self, line):
        if self.on_spectrum:
            r = self.on_spectrum(self.p["id"], line)
            if asyncio.iscoroutine(r):
                asyncio.ensure_future(r)

    def _audio(self, pcm: bytes, rate: int):
        if self.on_audio:
            self.on_audio(self.p["id"], pcm, rate)

    async def start(self):
        async def runner():
            # Bricht eine bestehende Verbindung ab (Netz, Server-Neustart, Zeitueberschreitung), wird sie mit wachsender
            # Pause neu aufgebaut. Scheitert schon die erste Verbindung, bleibt es beim Fehler (Meldung an den Nutzer).
            ever, delay = False, 3
            try:
                while True:
                    t0 = asyncio.get_running_loop().time()
                    try:
                        await self.rig.run()
                        raise ConnectionError("Verbindung beendet")
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        refused = isinstance(e, SdrRefused)
                        ever = ever or bool(self.rig.state.get("connected"))
                        self.rig.state.update(connected=False, error=str(e) or type(e).__name__)
                        self.rig.say(f"getrennt: {e}")
                        await self.rig.changed(True)
                    if not ever or refused:
                        break
                    if asyncio.get_running_loop().time() - t0 > 120:
                        delay = 3
                    self.rig.say(f"neuer Verbindungsversuch in {delay} s")
                    try:
                        await self.rig.close()
                    except Exception:
                        pass
                    await asyncio.sleep(delay)
                    delay = min(60, delay * 2)
            finally:
                self.proc.code = 1
        self.task = asyncio.create_task(runner())

    async def stop(self):
        if self.task:
            self.task.cancel()
        try:
            await self.rig.close()
        except Exception:
            pass
        self.proc.code = 0
