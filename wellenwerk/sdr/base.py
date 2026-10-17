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

class SdrBusy(RigError):
    """Der Server ist voll – spaeter erneut versuchen, aber mit langer Pause (Betreiber nicht mit Anfragen ueberhaeufen)."""


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


# Ziel fuer dekodierte Meldungen (DMR, APRS, Funksensoren ...): main setzt DECODE["sink"] = fn(radio_id, meldung)
DECODE = {"sink": None}


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

    # ---------- Digitalfunk-Erkennung: FM-Diskriminator der letzten Sekunden (dvsync, alle Verfahren gleichzeitig) ----------
    def dv_feed(self, x, rate: int):
        """Diskriminator-Signal (bzw. unverfaelschter FM-Ton) anhaengen; nur in FM ohne laufenden Server-Dekoder."""
        if self.state.get("mode") != "FM" or getattr(self, "decoder", ""):
            self._dv = None
            return
        import numpy as np
        b = getattr(self, "_dv", None)
        if b is None or b["rate"] != rate:
            b = self._dv = dict(rate=rate, buf=deque(), n=0)
        a = np.asarray(x, np.float32)
        b["buf"].append((time.monotonic(), a))
        b["n"] += len(a)
        b["total"] = b.get("total", 0) + len(a)                 # fortlaufende Zahl der Abtastwerte (fuer das laufende Dekodieren)
        while len(b["buf"]) > 1 and b["n"] - len(b["buf"][0][1]) >= rate * 6:
            b["n"] -= len(b["buf"].popleft()[1])

    async def dv_detect(self, secs: float = 1.5, timeout: float = 8.0, dump: bool = False) -> dict:
        """Die naechsten secs Sekunden nach DMR, D-STAR, YSF, P25, NXDN, M17 durchsuchen (parallel, siehe dvsync)."""
        import numpy as np
        from . import dvsync
        if self.state.get("mode") != "FM":
            raise RigError("Digitalfunk-Erkennung braucht FM")
        t0 = time.monotonic()
        while True:
            b = getattr(self, "_dv", None)
            parts = [a for t, a in (b["buf"] if b else []) if t >= t0]
            if b and sum(len(a) for a in parts) >= secs * b["rate"]:
                break
            if time.monotonic() - t0 > secs + timeout:
                raise RigError("kein FM-Ton vom Empfänger")
            await asyncio.sleep(0.1)
        x = np.concatenate(parts)
        res = await asyncio.to_thread(dvsync.detect, x, b["rate"])
        out = dict(rate=b["rate"], secs=round(len(x) / b["rate"], 2), found=res, diag=dvsync.diag(x, b["rate"]))
        if dump:                                          # Rohdaten (float32, base64) fuer Fehlersuche und Tests
            import base64
            out["raw"] = base64.b64encode(x.astype("<f4").tobytes()).decode()
        return out

    # ---------- eigenes Dekodieren (dvdec): laufend aus dem Diskriminator-Puffer ----------
    DV_LOCAL = {"dmr", "dstar", "ysf", "m17"}

    DV_VOICE = {"dmr", "dstar", "ysf"}

    def dv_decode(self, proto: str, voice=None) -> str:
        """Eigenen Dekoder ein-/ausschalten (\"\" = aus). Nur sinnvoll mit sauberem Signal (eigene IQ-Empfaenger).
        voice: Sprache ueber das optionale Sprachmodul ausgeben (None = unveraendert)."""
        from .. import dvvoice
        proto = (proto or "").lower()
        if proto and proto not in self.DV_LOCAL:
            raise RigError(f"Eigener Dekoder für {proto} noch nicht vorhanden")
        if voice is not None:
            self._dvvoice = bool(voice) and dvvoice.DATA is not None and dvvoice.available(dvvoice.DATA)
        self._dvdec = proto
        self._vbuf, self._vplay = bytearray(), False
        self.state["sdr"]["dv_local"] = proto
        self.state["sdr"]["dv_voice"] = bool(proto and getattr(self, "_dvvoice", False) and proto in self.DV_VOICE)
        try:
            asyncio.ensure_future(self.changed(force=True))        # Oberflaeche sofort informieren
        except RuntimeError:
            pass
        if proto and not getattr(self, "_dvtask", None):
            self._dvtask = asyncio.ensure_future(self._dv_loop())
        return proto

    async def _dv_loop(self):
        import numpy as np
        from . import dvdec
        done, seen, ds_txt, ds_last, ysf_cur, m17_cur, hw, vs = None, {}, [], {}, {}, {}, {}, {}
        try:
            while getattr(self, "_dvdec", ""):
                await asyncio.sleep(1.0)
                b = getattr(self, "_dv", None)
                if not b:
                    continue
                rate, total = b["rate"], b.get("total", 0)
                if done is None:
                    done = max(0, total - rate)
                parts, n = [], 0                           # Abtastwerte ab (done - 0,5 s) bis jetzt (D-STAR: 21 Rahmen ab Sync)
                for _t, a in reversed(b["buf"]):
                    parts.append(a)
                    n += len(a)
                    if total - n <= done - int(rate * 0.5):
                        break
                x = np.concatenate(parts[::-1]).astype(np.float64)
                start = total - len(x)
                now = asyncio.get_running_loop().time()
                voice = getattr(self, "_dvvoice", False) and self._dvdec in self.DV_VOICE
                if voice and self._dvdec in ("dstar", "dmr"):
                    try:
                        await self._dv_voice(x, rate, start, vs)
                    except Exception as e:
                        log.warning("Sprachdekodierung: %s", e)
                if self._dvdec == "m17":                    # LSF direkt oder aus 6 LICH-Teilen (Spaeteinstieg)
                    for e in await asyncio.to_thread(dvdec.m17, x, rate):
                        pos = start + int(e["t"] * rate)
                        if pos < done - int(rate * 0.05) or pos <= hw.get("m17", -1) + rate * 0.01:   # schon im letzten Durchgang
                            continue
                        hw["m17"] = pos
                        if pos - m17_cur.get("_pos", pos) > rate * 1.0:
                            m17_cur.clear()
                        m17_cur["_pos"] = pos
                        lsf = None
                        if e["kind"] == "lsf":
                            lsf = e
                        else:
                            m17_cur.setdefault("lich", {})[e["cnt"]] = e["lich"]
                            lsf = dvdec.m17_lich_collect(m17_cur["lich"])
                        if lsf:
                            v = dict(protocol="M17", **{k: lsf[k] for k in ("source", "destination", "can", "meta_text", "encrypted") if k in lsf})
                            sent = m17_cur.get("_sent") or {}
                            if not all(sent.get(k) == w for k, w in v.items()):
                                m17_cur["_sent"] = dict(sent, **v)
                                self.emit_decode(dict(decoder="m17", kind="local", freq=self.state.get("freq"), value=v))
                        if e.get("last"):
                            m17_cur.clear()
                    done = total
                    continue
                if self._dvdec == "ysf":                    # Felder (Ziel/Quelle/Down/Up) sammeln, melden sobald Quelle bekannt
                    yres = await asyncio.to_thread(dvdec.ysf, x, rate)
                    if voice:
                        try:
                            await self._dv_voice(x, rate, start, vs, yres)
                        except Exception as e:
                            log.warning("Sprachdekodierung: %s", e)
                    for e in yres:
                        pos = start + int(e["t"] * rate)
                        if pos < done - int(rate * 0.05) or pos <= hw.get("ysf", -1) + rate * 0.01:   # schon im letzten Durchgang
                            continue
                        hw["ysf"] = pos
                        if e["fi"] == 0:
                            ysf_cur.clear()
                        if pos - ysf_cur.get("_pos", pos) > rate * 1.5:  # Pause: neue Aussendung
                            ysf_cur.clear()
                        ysf_cur["_pos"] = pos
                        ysf_cur["dgid"] = e.get("dgid")
                        for k in ("source", "target", "down", "up"):
                            if e.get(k):
                                ysf_cur[k] = e[k]
                        if not ysf_cur.get("source"):
                            continue
                        v = dict(protocol="YSF", **{k: ysf_cur[k] for k in ("source", "target", "down", "up", "dgid") if k in ysf_cur})
                        sent = ysf_cur.get("_sent") or {}
                        if all(sent.get(k) == v.get(k) for k in ("source", "target", "up")):   # nichts Neues in dieser Aussendung
                            continue
                        ysf_cur["_sent"] = dict(sent, **v)
                        self.emit_decode(dict(decoder="ysf", kind="local", freq=self.state.get("freq"), value=v))
                        if e["fi"] == 2:
                            ysf_cur.clear()
                    done = total
                    continue
                if self._dvdec == "dstar":
                    for e in await asyncio.to_thread(dvdec.dstar, x, rate):
                        pos = start + int(e["t"] * rate)
                        if pos < done - int(rate * 0.05):
                            continue
                        if e["kind"] == "text-raw":       # Textnachricht: ueber die Aussendung abstimmen, besser werdend melden
                            ds_txt.append(e["raw"])
                            msg = dvdec.ds_text_vote(ds_txt[-12:])
                            if msg and msg != ds_last.get("msg"):
                                ds_last["msg"] = msg
                                self.emit_decode(dict(decoder="dstar", kind="local", freq=self.state.get("freq"), value=dict(ds_last.get("hdr") or {}, protocol="DSTAR", message=msg)))
                            continue
                        v = {k: e[k] for k in ("protocol", "ourcall", "yourcall", "departure", "destination")}
                        if v != ds_last.get("hdr"):       # neuer Sprecher/neue Aussendung: Text neu sammeln
                            ds_txt.clear(); ds_last.pop("msg", None)
                        ds_last["hdr"] = v
                        key = tuple(v.values())
                        if now - seen.get(key, 0) < 5:
                            continue
                        seen[key] = now
                        self.emit_decode(dict(decoder="dstar", kind="local", freq=self.state.get("freq"), value=v))
                    done = total
                    continue
                bursts = await asyncio.to_thread(dvdec.dmr_bursts, x, rate)
                for e in bursts:
                    pos = start + int(e["t"] * rate)
                    if pos < done - int(rate * 0.05):           # schon im letzten Durchgang gemeldet
                        continue
                    if "src" not in e:
                        continue
                    v = dict(protocol="DMR", slot=e.get("slot"), source=e["src"], target=e["dst"],
                             type=e.get("type") or ("group" if e.get("csbk") == 0x3D else ""), sync="voice" if e.get("dt") in (1, 2) and e.get("flco") != 0x30 else "data",
                             cc=e.get("cc"), burst=e.get("dtn"))
                    key = (v["slot"], v["source"], v["target"], e.get("dt"))
                    if now - seen.get(key, 0) < 3:
                        continue
                    seen[key] = now
                    self.emit_decode(dict(decoder="dmr", kind="local", freq=self.state.get("freq"), value=v))
                done = total
        finally:
            self._dvtask = None

    def voice_take(self, n: int):
        """n Tonwerte (12 kHz, int16) aus der dekodierten Sprache; vorgepuffert, damit der Sekundentakt des Dekoders
        keine Luecken reisst. Ohne Sprache: Stille statt Digitalrauschen."""
        import numpy as np
        vb = getattr(self, "_vbuf", None)
        if vb is None:
            vb = self._vbuf = bytearray()
        if not getattr(self, "_vplay", False) and len(vb) >= 12000 * 2 * 1.3:
            self._vplay = True
        if not self._vplay or not vb:
            self._vplay = False
            return np.zeros(n, "<i2")
        k = min(len(vb), n * 2)
        a = np.frombuffer(bytes(vb[:k]), "<i2")
        del vb[:k]
        return np.concatenate([a, np.zeros(n - len(a), "<i2")]) if len(a) < n else a

    def voice_push(self, pcm: bytes):
        vb = getattr(self, "_vbuf", None)
        if vb is None:
            vb = self._vbuf = bytearray()
        vb.extend(pcm)
        if len(vb) > 12000 * 2 * 4:                       # Rueckstau begrenzen (max. ca. 2,5 s Verzoegerung)
            del vb[:len(vb) - 12000 * 2 * 2]

    async def _dv_voice(self, x, rate: int, start: int, vs: dict, ysf_res=None):
        """Sprachrahmen des laufenden Verfahrens dekodieren und in den Tonpuffer legen."""
        import numpy as np
        from .. import dvvoice
        from . import dvdec
        proto = self._dvdec
        if proto == "dstar":
            frames = [(t, None, [b]) for t, b in await asyncio.to_thread(dvdec.dstar_voice, x, rate)]
        elif proto == "dmr":
            frames = await asyncio.to_thread(dvdec.dmr_voice, x, rate)
        elif proto == "ysf":
            frames = [(e["t"], None, e["vch"]) for e in (ysf_res or []) if "vch" in e]
        else:
            return
        out = []
        for t, slot, fr in frames:
            pos = start + int(t * rate)
            if pos <= vs.get("hw", -1) + rate * 0.005:      # schon ausgegeben
                continue
            if proto == "dmr" and vs.get("slot") is not None and slot != vs["slot"] and pos - vs.get("last", 0) < rate:
                continue                                  # anderer Zeitschlitz, solange der erste spricht
            if vs.get("voc") is None or pos - vs.get("last", -(1 << 40)) > rate * 0.5:
                vs["voc"] = dvvoice.Vocoder(None, proto)  # neue Aussendung: Vocoder-Zustand neu
            vs["slot"], vs["hw"], vs["last"] = slot, pos, pos
            out.extend(vs["voc"].frame(b) for b in fr)
        if out:
            self.voice_push(dvvoice.to_pcm12k(np.concatenate(out)))

    def emit_decode(self, msg: dict):
        if DECODE["sink"]:
            try:
                DECODE["sink"](self.p["id"], msg)
            except Exception as e:
                log.debug("Dekoder-Meldung: %s", e)

    async def set_decoder(self, mode: str) -> str:
        """Dekoder des Empfaengers ein-/ausschalten (\"\" = aus). Rueckgabe: eingeschalteter Dekoder."""
        raise RigError("Dieser Empfänger hat keine eingebauten Dekoder")

    def say(self, text: str):
        self.log.append(time.strftime("%H:%M:%S ") + text)
        log.info("%s: %s", self.p.get("name"), text)

    async def changed(self, force: bool = False):
        now = time.monotonic()
        if not force and now - self._last_push < 0.2:       # Messwerte hoechstens 5x/s melden
            return
        self._last_push = now
        try:
            self.state["sdr"]["pb"] = list(self.passband())    # tatsaechlicher Durchlassbereich (Rahmen im Wasserfall)
        except Exception:
            pass
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

    async def set_span(self, hz: int) -> int:
        """Breite des Wasserfalls in Hz (0 = ganzer Bereich); Rueckgabe: tatsaechliche Breite, 0 = fest (Oberflaeche zoomt selbst)."""
        return 0

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
                        refused, busy = isinstance(e, SdrRefused), isinstance(e, SdrBusy)
                        ever = ever or bool(self.rig.state.get("connected"))
                        self.rig.state.update(connected=False, error=str(e) or type(e).__name__)
                        self.rig.say(f"getrennt: {e}")
                        await self.rig.changed(True)
                    if not ever or refused:
                        break
                    if asyncio.get_running_loop().time() - t0 > 120:
                        delay = 3
                    if busy:
                        delay = max(delay, 180)
                    self.rig.say(f"neuer Verbindungsversuch in {delay} s")
                    try:
                        await self.rig.close()
                    except Exception:
                        pass
                    await asyncio.sleep(delay)
                    delay = min(600 if busy else 60, delay * 2)
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
