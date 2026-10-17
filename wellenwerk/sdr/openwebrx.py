"""OpenWebRX als Empfaenger (WebSocket /ws/). Ton und Wasserfall kommen IMA-ADPCM-komprimiert;
abgestimmt wird innerhalb des aktuellen Profils (Bandausschnitt des Betreibers), ausserhalb wird ein passendes
Profil gewaehlt. Protokoll nach dem quelloffenen OpenWebRX (J. Ketterl u. a.), eigene Umsetzung.

Parameter: profile (Profil-ID oder Teil des Namens), freq/mode (Start), smeter_offset (dB, S-Meter-Abgleich)."""
import asyncio
import json
import logging
import math
import re
import time
from urllib.parse import urlparse

import websockets

from ..rig import RigError
from .base import SdrBusy, SdrRefused, SdrRig

log = logging.getLogger("ww.sdr")

OWRX_MODES = {"USB": "usb", "PKTUSB": "usb", "RTTY": "usb", "LSB": "lsb", "PKTLSB": "lsb", "CW": "cw", "CWR": "cw",
              "AM": "am", "SAM": "sam", "FM": "nfm"}
# Dekoder des OpenWebRX, die Wellenwerk anbietet: digitale Sprache (Kennungen, Talker Alias, Textnachrichten) und
# Datendienste (APRS, Funk-Sensoren/Wetterstationen ueber rtl_433, Wettersonden). Name -> Anzeige
# Dekoder der OpenWebRX(+)-Server, die Wellenwerk anbietet: Amateurfunk, Rundfunk und Aussendungen fuer die Allgemeinheit
# (Positionen von Schiffen/Flugzeugen, Seewetter, Notrufe). Bewusst NICHT: Pager (page), Selektivruf/ZVEI (BOS), Firmendaten
# der Luftfahrt (ACARS, VDL2, HFDL), Verbrauchszaehler (wmbus), LoRaWAN – deren Empfang ist in Deutschland nicht erlaubt (§ 5 TDDDG).
OWRX_DECODERS = {"dmr": "DMR", "dstar": "D-STAR", "ysf": "YSF (C4FM)", "nxdn": "NXDN", "p25": "P25", "m17": "M17",
                 "packet": "APRS / Packet", "ism": "Funksensoren 433/868 MHz", "sonde": "Wettersonden",
                 "ft8": "FT8", "ft4": "FT4", "wspr": "WSPR", "jt65": "JT65", "jt9": "JT9", "fst4": "FST4", "fst4w": "FST4W", "q65": "Q65",
                 "msk144": "MSK144", "js8": "JS8Call", "bpsk31": "PSK31", "bpsk63": "PSK63", "rtty170": "RTTY 45 Bd / 170 Hz",
                 "rtty450": "RTTY 50 Bd / 450 Hz (Wetterdienst)", "rtty85": "RTTY 50 Bd / 85 Hz", "cwdecoder": "CW",
                 "navtex": "NAVTEX (Seewetter)", "sitorb": "SITOR-B", "dsc": "DSC (Seenot-/Anrufkanal)", "ais": "AIS (Schiffe)",
                 "adsb": "ADS-B / Mode S (Flugzeuge)", "lora-aprs": "LoRa-APRS", "meshtastic": "Meshtastic", "meshcom": "MeshCom",
                 "meshcore": "MeshCore", "lora-fanet": "FANET (Gleitschirme)"}
# Dekoder, die Text zeichenweise liefern: zu Zeilen sammeln
OWRX_TEXT = {"bpsk31", "bpsk63", "rtty170", "rtty450", "rtty85", "cwdecoder", "sitorb", "navtex"}
IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
        130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
        1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
        7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]


class Adpcm:
    """IMA-ADPCM wie bei OpenWebRX; Ton mit eingestreuten Synchronisationsmarken 'SYNC' + Zustand."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.index = self.pred = self.step = 0
        self.phase = self.sync = self.count = 0
        self.sbuf = bytearray()

    def _nib(self, n):
        self.index = min(max(self.index + IDX[n], 0), 88)
        d = self.step >> 3
        if n & 1:
            d += self.step >> 2
        if n & 2:
            d += self.step >> 1
        if n & 4:
            d += self.step
        if n & 8:
            d = -d
        self.pred = min(max(self.pred + d, -32768), 32767)
        self.step = STEP[self.index]
        return self.pred

    def decode(self, data: bytes) -> list:
        out = []
        for b in data:
            out.append(self._nib(b & 15))
            out.append(self._nib(b >> 4))
        return out

    def decode_sync(self, data: bytes) -> list:
        out = []
        for b in data:
            if self.phase == 0:
                if b != b"SYNC"[self.sync]:
                    self.sync = 0
                    if b == ord("S"):
                        self.sync = 1
                else:
                    self.sync += 1
                if self.sync == 4:
                    self.sbuf, self.phase = bytearray(), 1
            elif self.phase == 1:
                self.sbuf.append(b)
                if len(self.sbuf) == 4:
                    self.index = int.from_bytes(self.sbuf[0:2], "little", signed=True)
                    self.pred = int.from_bytes(self.sbuf[2:4], "little", signed=True)
                    self.count, self.phase = 1000, 2
            else:
                out.append(self._nib(b & 15))
                out.append(self._nib(b >> 4))
                self.count -= 1
                if self.count < 0:
                    self.sync, self.phase = 0, 0
        return out


def name_spans(name: str, exact: bool = False) -> list:
    """Frequenzbereiche (Hz) aus einem Profilnamen: „144-146 MHz“, „431-433“, „7 MHz“ und Bandnamen wie „40m“.
    exact=True: nur ausdrueckliche Bereiche (ohne Bandzuordnung von Einzelzahlen)."""
    from ..bands import BANDS
    out = []
    num = r"(\d+(?:[.,]\d+)?)"
    for a, b in re.findall(rf"(?<![\w.]){num}\s*[-–]\s*{num}(?:\s*MHz)?(?![\w.])", name, re.I):
        lo, hi = float(a.replace(",", ".")), float(b.replace(",", "."))
        if 0 <= lo < hi <= 6000 and hi - lo <= 100:
            out.append([lo * 1e6, hi * 1e6])
    if exact:
        return out
    # Sammelbegriffe: VHF = 2 m (und Umgebung), UHF = 70 cm, „2m“/„70cm“ ueber die Bandliste
    if re.search(r"(?<![\w-])VHF\b", name, re.I):
        out.append([136e6, 174e6])
    if re.search(r"(?<![\w-])UHF\b", name, re.I):
        out.append([420e6, 450e6])
    for b, lo, hi, _ in BANDS:
        if re.search(rf"(?<![\d.]){re.escape(b)}\b", name, re.I) or any(lo <= float(x.replace(",", ".")) * 1e6 <= hi
                                                                          for x in re.findall(rf"{num}\s*MHz", name, re.I)):
            m = min(500e3, max(50e3, (hi - lo) * 0.5))      # Profil ist meist breiter als das Band (Rundfunk/Wetter knapp daneben)
            out.append([lo - m, hi + m])
    return out


class OpenWebRXRig(SdrRig):
    kind = "openwebrx"
    MODES = ["USB", "LSB", "CW", "AM", "SAM", "FM", "PKTUSB", "PKTLSB", "RTTY"]
    LEVELS_SET = ["AF", "SQL"]
    FUNCS_SET = []

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.ws = None
        self.center = self.rate = 0
        self.fft_comp, self.audio_comp = "adpcm", "adpcm"
        self.profiles, self.profile = [], ""
        self.seen = {}                                   # Profil-ID -> (Mitte, Breite) der schon besuchten Profile
        self._want_prof, self._foreign = None, False      # eigener Profilwunsch / Wechsel durch den Server bzw. andere Nutzer
        self._prof_t = 0.0                               # Zeit des letzten Profilwechsels (bzw. des Verbindens)
        self._prof_lock = asyncio.Lock()
        self._blind = True                               # unbekannte Profile durchprobieren erlaubt (nicht beim ersten Abstimmen)
        self.adpcm, self.fftc = Adpcm(), Adpcm()
        self.out_rate = 12000
        self.cfg_event = asyncio.Event()
        self.owrx_modes, self.decoder, self._last_dec = {}, "", ("", 0.0)
        self._rate, self._tbuf, self._tflush, self._seen_types = {}, "", None, set()
        self.prof_event = asyncio.Event()
        self.state["levels"].update(SQL=0.0)
        self.state["sdr"]["url"] = self.p.get("url", "")

    def _uri(self):
        u = urlparse(self.p.get("url", "") if "://" in self.p.get("url", "") else "http://" + self.p.get("url", ""))
        if not u.hostname:
            raise RigError("Adresse des OpenWebRX fehlt")
        path = (u.path or "/").rstrip("/") + "/ws/"
        return f"{'wss' if u.scheme == 'https' else 'ws'}://{u.netloc}{path}"

    async def _send(self, obj):
        if self.ws is not None:
            await self.ws.send(obj if isinstance(obj, str) else json.dumps(obj))

    async def run(self):
        self.say(f"verbinde mit {self.p.get('url')}")
        self.center = self.rate = 0                      # bei Neuverbindung: Ausschnitt kommt neu vom Server
        self.profile = ""
        self.adpcm.reset()
        self.prof_event.clear()
        try:
            self.ws = await websockets.connect(self._uri(), max_size=None, ping_interval=None, open_timeout=12, user_agent_header="Wellenwerk")
            self._prof_t = asyncio.get_running_loop().time()
        except Exception as e:
            raise RigError(f"OpenWebRX nicht erreichbar: {e}")
        await self._send("SERVER DE CLIENT client=wellenwerk type=receiver")
        await self._send({"type": "connectionproperties", "params": {"output_rate": self.out_rate, "hd_output_rate": 48000}})
        await self._send({"type": "dspcontrol", "action": "start"})
        async for msg in self.ws:
            if isinstance(msg, str):
                if msg.startswith("CLIENT DE SERVER"):
                    continue
                try:
                    await self._json(json.loads(msg))
                except ValueError:
                    continue
            else:
                await self._binary(msg)
        raise RigError("OpenWebRX hat die Verbindung beendet")

    async def _json(self, j):
        t, v = j.get("type"), j.get("value")
        if t not in self._seen_types:                    # neue Nachrichtenarten einmal ins Protokoll (Fehlersuche bei Dekodern)
            self._seen_types.add(t)
            log.log(int(__import__("os").environ.get("WW_OWRX_TRACE", 10)), "OpenWebRX-Nachricht %s: %s", t, str(v)[:160])
        if t == "config":
            # beim Profilwechsel kommt die Konfiguration in Bruchstuecken (Felder fehlen oder sind null)
            self.center = v.get("center_freq") or self.center
            self.rate = v.get("samp_rate") or self.rate
            self.fft_comp = v.get("fft_compression") or self.fft_comp
            self.audio_comp = v.get("audio_compression") or self.audio_comp
            if v.get("profile_id") and v.get("sdr_id"):
                prof = f"{v['sdr_id']}|{v['profile_id']}"
                if self.profile and prof != self.profile and self.state["connected"]:
                    # nach einem Profilwechsel (v. a. auf ein anderes SDR-Geraet) haelt der Server die Tonaufbereitung an
                    await self._send({"type": "dspcontrol", "action": "start"})
                    if prof != self._want_prof:          # nicht von uns: anderer Nutzer am selben SDR oder Zeitplan des Servers
                        self._foreign = True
                if prof == self._want_prof:
                    self._want_prof = None
                self.profile = prof
            if self.profile and self.center and self.rate and (v.get("center_freq") or v.get("samp_rate")):
                self.seen[self.profile] = (self.center, self.rate)
            if self.center and self.rate:
                self._ranges()
                if not self.state["connected"]:
                    self.state.update(connected=True, error="")
                    self.say(f"verbunden, Ausschnitt {(self.center - self.rate / 2) / 1e6:.3f}–{(self.center + self.rate / 2) / 1e6:.3f} MHz")
                    await self._send({"type": "dspcontrol", "params": {"squelch_level": -150}})
                    asyncio.ensure_future(self._first_tune(int(self.center + (v.get("start_offset_freq") or 0))))
                if self._foreign and (v.get("center_freq") or v.get("samp_rate")) and self.state["connected"]:
                    self._foreign = False
                    f = self.state.get("freq") or 0
                    if not self._covers(f):              # wie die OpenWebRX-Oberflaeche: dem Server folgen, nicht zurueckschalten
                        nf = int(self.center + (v.get("start_offset_freq") or 0))
                        name = next((p.get("name", "") for p in self.profiles if p["id"] == self.profile), "")
                        self.say(f"Der Server hat auf „{name}“ umgeschaltet (anderer Nutzer oder Zeitplan) – "
                                 f"{f / 1e6:.4f} MHz liegt nicht mehr im Ausschnitt, jetzt {nf / 1e6:.4f} MHz")
                        self.state["freq"] = nf
                        self.state["sdr"]["foreign"] = dict(name=name, at=round(time.time(), 1))
                        asyncio.ensure_future(self.tune())
                self.cfg_event.set()
                await self.changed(True)
        elif t == "profiles":
            self.profiles = v or []
            self.prof_event.set()
            self._ranges()
            await self.changed(True)
            want = self.params.get("profile")
            if want:
                p = next((x for x in self.profiles if x["id"] == want or want.lower() in x.get("name", "").lower()), None)
                if p:
                    asyncio.ensure_future(self._select_profile(p["id"], name=p.get("name", "")))
        elif t == "modes" and isinstance(v, list):
            self.owrx_modes = {m.get("modulation"): m for m in v if isinstance(m, dict)}
            self.state["sdr"]["decoders"] = [dict(id=k, label=n) for k, n in OWRX_DECODERS.items() if k in self.owrx_modes]
            await self.changed(True)
        elif t == "secondary_demod" and self.decoder in OWRX_TEXT and isinstance(v, str):
            self._text(v)
        elif t in ("metadata", "secondary_demod") and self.decoder:
            txt = json.dumps(v, sort_keys=True)
            now = asyncio.get_running_loop().time()
            if isinstance(v, dict) and self.decoder in ("adsb", "ais"):   # je Flugzeug/Schiff hoechstens alle 10 s
                key = str(v.get("icao") or v.get("hex") or v.get("mmsi") or v.get("source") or "")
                if key and now - self._rate.get(key, 0) < 10:
                    return
                self._rate[key] = now
                if len(self._rate) > 5000:
                    self._rate.clear()
            if txt == self._last_dec[0] and now - self._last_dec[1] < 2:   # digitale Sprache meldet je Rahmen
                return
            self._last_dec = (txt, now)
            self.emit_decode(dict(decoder=self.decoder, kind=t, freq=self.state.get("freq"), value=v))
        elif t == "smeter":
            try:
                db = 10 * math.log10(max(float(v), 1e-20))
                self.state["meters"]["STRENGTH"] = round(db + 73 + float(self.params.get("smeter_offset", -30)), 1)   # unkalibriert
            except (TypeError, ValueError):
                pass
            await self.changed()
        elif t in ("sdr_error", "demodulator_error"):
            self.state["error"] = str(v)
            self.say(f"Fehler: {v}")
            await self.changed(True)
        elif t == "backoff":
            why = str(j.get("reason") or v or "")
            if "ban" in why.lower():      # vom Betreiber gesperrt: Neuversuche wuerden nur stoeren
                raise SdrRefused("OpenWebRX: der Betreiber hat diese Internet-Adresse gesperrt (Client address banned) – kein automatischer Neuversuch")
            raise SdrBusy(f"OpenWebRX: {'zu viele Nutzer' if not why or 'many' in why.lower() else why}")
        elif t == "receiver_details" and isinstance(v, dict):
            self.state["sdr"]["info"] = re.sub(r"<[^>]+>", "", str(v.get("receiver_name", "")))[:100]
            g = v.get("receiver_gps")                          # Standort des Empfaengers (Relais in seiner Naehe)
            if isinstance(g, dict) and g.get("lat") is not None:
                try:
                    self.state["sdr"]["gps"] = [round(float(g["lat"]), 4), round(float(g["lon"]), 4)]
                except (TypeError, ValueError):
                    pass

    async def _binary(self, b: bytes):
        if not b:
            return
        kind, data = b[0], b[1:]
        if kind == 2 and self.on_audio:
            if self.audio_comp == "adpcm":
                s = self.adpcm.decode_sync(data)
                pcm = b"".join(int(x).to_bytes(2, "little", signed=True) for x in s)
            else:
                pcm = bytes(data)
            if pcm:
                self.on_audio(pcm, self.out_rate)
                if self.state.get("mode") == "FM":
                    import numpy as np
                    self.dv_feed(np.frombuffer(pcm, "<i2"), self.out_rate)
        elif kind == 1 and self.on_spectrum and self.rate:
            if self.fft_comp == "adpcm":
                self.fftc.reset()
                vals = [x / 100 for x in self.fftc.decode(data)[10:]]
            else:
                import struct
                vals = list(struct.unpack(f"<{len(data) // 4}f", data[: len(data) // 4 * 4]))
            if not vals:
                return
            # auf hoechstens 1024 Punkte verdichten, dB-Werte -> 0..255 wie bei den anderen Quellen
            n = len(vals)
            if n > 1024:
                f = n / 1024
                vals = [max(vals[int(i * f): int((i + 1) * f)] or [vals[int(i * f)]]) for i in range(1024)]
            data8 = [int(min(255, max(0, (v + 150) * 255 / 130))) for v in vals]
            self.on_spectrum(dict(name="OpenWebRX", low=self.center - self.rate / 2, high=self.center + self.rate / 2,
                                  center=self.center, span=self.rate, min=60, max=230, data=data8))

    async def _first_tune(self, fallback: int):
        """Nach dem Verbinden (auch Neuverbinden) die gewuenschte Frequenz einstellen. Liegt sie nicht im aktuellen
        Ausschnitt, erst die Profilliste des Servers abwarten (kommt nach der Konfiguration) und dann umschalten."""
        try:
            if self.state.get("freq") and not self._covers(self.state["freq"]):
                try:
                    await asyncio.wait_for(self.prof_event.wait(), 8)
                except asyncio.TimeoutError:
                    pass
            if not self.state.get("freq"):
                self.state["freq"] = fallback
            try:
                self._blind = False            # gespeicherte Frequenz passt evtl. gar nicht zu diesem Server: nicht blind suchen
                try:
                    await self.tune()
                finally:
                    self._blind = True
            except RigError as e:              # Wunschfrequenz hier nicht empfangbar: auf den Ausschnitt des Betreibers gehen
                self.say(str(e))
                self.state["freq"] = int(self.center + (fallback - self.center if self._covers(fallback) else 0))
                await self.tune()
            await self.changed(True)
        except Exception as e:
            self.say(f"Abstimmen: {e}")

    def _ranges(self):
        """Empfangbare Bereiche: aktueller Ausschnitt, schon besuchte Profile und Angaben in Profilnamen
        (Band „40m“, „7 MHz“, Bereich „144-146 MHz“ bzw. „431-433“)."""
        rng = [[self.center - self.rate / 2, self.center + self.rate / 2]] if self.rate else []
        rng += [[c - r / 2, c + r / 2] for c, r in self.seen.values()]
        for p in self.profiles:
            rng += name_spans(p.get("name", ""))
        self.state["sdr"]["ranges"] = rng

    def _covers(self, f) -> bool:
        return bool(self.rate) and abs(f - self.center) < self.rate / 2 * 0.98

    async def _select_profile(self, pid, f=None, name=""):
        """Profil wechseln, hoechstens alle 10,5 s: OpenWebRX+ wertet Wechsel in kuerzerem Abstand (auch kurz nach dem
        Verbinden) als Roboter und sperrt die Internet-Adresse fuer 12 Stunden (bot_ban_enabled).
        f: Frequenz, fuer die gewechselt wird – ist inzwischen eine andere gewuenscht (neuer Klick), entfaellt der Wechsel.
        Rueckgabe False, wenn verworfen."""
        loop = asyncio.get_running_loop()
        async with self._prof_lock:                     # nacheinander, auch wenn mehrere Abstimmungen gleichzeitig kommen
            if f is not None and self.state.get("freq") != f:
                return False
            wait = self._prof_t + 10.5 - loop.time()
            if wait > 0:
                self.say(f"Profilwechsel in {wait:.0f} s (Schutz vor der Bot-Sperre des Servers)")
                self.state["sdr"]["switching"] = dict(to=name, at=round(time.time() + wait, 1))
                await self.changed(True)
                try:
                    while loop.time() < self._prof_t + 10.5:
                        await asyncio.sleep(0.25)
                        if f is not None and self.state.get("freq") != f:   # inzwischen anders abgestimmt: der letzte Wunsch gilt
                            self.say("Profilwechsel verworfen – inzwischen andere Frequenz gewählt")
                            return False
                finally:
                    self.state["sdr"].pop("switching", None)
                    await self.changed(True)
            self._prof_t = loop.time()
            self._want_prof = pid
            await self._send({"type": "selectprofile", "params": {"profile": pid}})
            return True

    async def _switch_profile(self, f):
        def hit(p):     # 0 = schon besucht und passt, 1 = Bereich im Namen passt, 2 = nur Band/MHz-Zahl im Namen
            c = self.seen.get(p["id"])
            if c and abs(f - c[0]) < c[1] / 2 * 0.98:
                return 0
            spans = name_spans(p.get("name", ""), exact=True)
            if any(lo <= f <= hi for lo, hi in spans):
                return 1
            return 2 if any(lo <= f <= hi for lo, hi in name_spans(p.get("name", ""))) else 9
        if not self.profiles:                            # direkt nach dem Verbinden: Profilliste abwarten
            try:
                await asyncio.wait_for(self.prof_event.wait(), 8)
            except asyncio.TimeoutError:
                pass
        cands = sorted((p for p in self.profiles if hit(p) < 9), key=hit)
        if not cands and self._blind:                    # Namen sagen nichts: noch nicht besuchte Profile durchprobieren
            cands = [p for p in self.profiles if p["id"] not in self.seen and p["id"] != self.profile]
        loop = asyncio.get_running_loop()
        stop = loop.time() + 50                          # insgesamt nicht ewig suchen (je Wechsel mind. 10,5 s Abstand)
        for p in cands[:4]:
            if loop.time() > stop:
                break
            # der Server geht oft erst auf das Profil, das auf dem Geraet gerade laeuft, und einige Sekunden spaeter auf das gewuenschte
            if not await self._select_profile(p["id"], f, p.get("name", "")):
                return                                   # verworfen: eine neuere Abstimmung kuemmert sich
            end, settled = min(stop, loop.time() + 15), None
            while loop.time() < end:
                if self.profile == p["id"] and self._covers(f):
                    self.say(f"Profil „{p.get('name')}“ gewählt")
                    return
                if self.profile == p["id"]:
                    settled = settled or loop.time()
                    if loop.time() - settled > 2:       # Profil steht, deckt die Frequenz aber nicht ab
                        break
                self.cfg_event.clear()
                try:
                    await asyncio.wait_for(self.cfg_event.wait(), 0.5)
                except asyncio.TimeoutError:
                    pass
        names = ", ".join(p.get("name", "") for p in self.profiles[:12])
        raise RigError(f"{f / 1e6:.3f} MHz liegt außerhalb der Empfangsbereiche dieses OpenWebRX ({names})")

    async def tune(self):
        if self.ws is None or not self.rate:
            return
        f = self.state["freq"]
        if not self._covers(f):
            await self._switch_profile(f)
            if self.state.get("freq") != f or not self._covers(f):
                return                                   # verworfen bzw. noch nicht da: die neuere Abstimmung uebernimmt
        lo, hi = self.passband()
        sql = self.state["levels"].get("SQL", 0)
        par = {"low_cut": lo, "high_cut": hi, "offset_freq": int(f - self.center), "mod": OWRX_MODES.get(self.state["mode"], "usb"),
               "secondary_mod": False, "squelch_level": -150 if not sql else -130 + sql * 100}
        if self.decoder in OWRX_TEXT:
            par["secondary_offset_freq"] = 1500          # Textdekoder auf 1500 Hz im Ton (wie die Signalerkennung abstimmt)
        m = self.owrx_modes.get(self.decoder) if self.decoder else None
        if m:                                            # Dekoder: eigene Modulation bzw. Grundmodulation + Zweitdemodulator
            if m.get("type") == "digimode":
                und = m.get("underlying") or ["nfm"]
                cur = OWRX_MODES.get(self.state["mode"], "")
                par.update(mod=cur if cur in und else und[0], secondary_mod=self.decoder, squelch_level=-150)   # z. B. RTTY in LSB = umgekehrte Lage
            else:
                par.update(mod=self.decoder, squelch_level=-150)
            bp = m.get("bandpass") or {}
            if bp.get("low_cut") is not None:
                par.update(low_cut=bp["low_cut"], high_cut=bp["high_cut"])
        await self._send({"type": "dspcontrol", "params": par})
        if self.decoder in OWRX_TEXT:                    # wie die OpenWebRX-Oberflaeche: Versatz des Textdekoders getrennt nach dem Wechsel
            await self._send({"type": "dspcontrol", "params": {"secondary_offset_freq": 1500}})

    async def set_mode(self, mode: str, passband: int = 0):
        if self.decoder:                                 # Betriebsart von Hand gewaehlt: Dekoder aus
            self.decoder = ""
            self.state["sdr"]["decoder"] = ""
        await super().set_mode(mode, passband)

    def _text(self, chunk: str):
        """Zeichen eines Textdekoders sammeln; Zeile ausgeben bei Zeilenende, 72 Zeichen oder 2 s Pause."""
        self._tbuf += chunk.replace("\r\n", "\n").replace("\r", "\n")
        while "\n" in self._tbuf or len(self._tbuf) >= 72:
            i = self._tbuf.find("\n")
            i = i if 0 <= i < 72 else 72
            line, self._tbuf = self._tbuf[:i], self._tbuf[i + 1 if self._tbuf[i:i + 1] == "\n" else i:]
            if line.strip():
                self.emit_decode(dict(decoder=self.decoder, kind="text", freq=self.state.get("freq"), value=line.strip()))
        if self._tflush:
            self._tflush.cancel()
        async def flush():
            await asyncio.sleep(2)
            line, self._tbuf = self._tbuf.strip(), ""
            if line:
                self.emit_decode(dict(decoder=self.decoder, kind="text", freq=self.state.get("freq"), value=line))
        self._tflush = asyncio.ensure_future(flush())

    async def set_decoder(self, mode: str) -> str:
        mode = (mode or "").lower()
        if mode and mode not in self.owrx_modes:
            raise RigError(f"Dieser OpenWebRX bietet den Dekoder „{OWRX_DECODERS.get(mode, mode)}“ nicht an")
        self.decoder = mode
        self.state["sdr"]["decoder"] = mode
        self._last_dec, self._tbuf, self._rate = ("", 0.0), "", {}
        await self.tune()
        await self.changed(True)
        return mode

    async def apply_level(self, name, value):
        if name == "SQL":
            await self.tune()

    async def close(self):
        try:
            self.ws and await self.ws.close()
        except Exception:
            pass
        self.ws = None
