"""Funkgeraetesteuerung ueber Hamlib rigctld (Netzprotokoll, erweiterte '+'-Antworten).

Beim Verbinden werden die Faehigkeiten des Geraets gelesen (dump_caps, l/L/u/U/G ?), daraus baut die
Oberflaeche nur die Regler und Schalter, die das Geraet wirklich hat."""
import asyncio
import logging
import re
import time

log = logging.getLogger("ww.rig")

# Regler, die die Oberflaeche anbietet: Name -> (Beschriftung, Typ, min, max, Schritt, Einheit)
LEVELS = {
    "AF": ("NF-Lautstärke", "f", 0, 1, 0.01, "%"),
    "RF": ("HF-Verstärkung", "f", 0, 1, 0.01, "%"),
    "SQL": ("Squelch", "f", 0, 1, 0.01, "%"),
    "RFPOWER": ("Sendeleistung", "f", 0, 1, 0.01, "%"),
    "MICGAIN": ("Mikrofon", "f", 0, 1, 0.01, "%"),
    "COMP": ("Kompressor", "f", 0, 1, 0.01, "%"),
    "NR": ("Rauschminderung", "f", 0, 1, 0.01, "%"),
    "NB": ("Störaustaster", "f", 0, 1, 0.01, "%"),
    "MONITOR_GAIN": ("Monitor", "f", 0, 1, 0.01, "%"),
    "VOXGAIN": ("VOX-Pegel", "f", 0, 1, 0.01, "%"),
    "ANTIVOX": ("Anti-VOX", "f", 0, 1, 0.01, "%"),
    "VOXDELAY": ("VOX-Haltezeit", "i", 0, 30, 1, "×0,1 s"),
    "BAL": ("Balance", "f", 0, 1, 0.01, "%"),
    "IF": ("ZF-Shift", "i", -1200, 1200, 10, "Hz"),
    "PBT_IN": ("PBT innen", "i", -1200, 1200, 25, "Hz"),
    "PBT_OUT": ("PBT außen", "i", -1200, 1200, 25, "Hz"),
    "NOTCHF": ("Notch-Frequenz", "i", 0, 3200, 10, "Hz"),
    "APF": ("Audio-Peak-Filter", "f", 0, 1, 0.01, "%"),
    "CWPITCH": ("CW-Tonhöhe", "i", 300, 1000, 10, "Hz"),
    "KEYSPD": ("Keyer-Tempo", "i", 5, 60, 1, "WpM"),
}
CHOICE_LEVELS = ("AGC", "PREAMP", "ATT")
METERS = ("STRENGTH", "RFPOWER_METER", "RFPOWER_METER_WATTS", "SWR", "ALC", "COMP_METER", "VD_METER", "ID_METER")
FUNCS = {
    "NB": "NB", "NB2": "NB2", "NR": "NR", "ANF": "ANF", "MN": "Notch", "APF": "APF", "AIP": "IP+",
    "VOX": "VOX", "COMP": "COMP", "MON": "MON", "TONE": "TONE", "TSQL": "TSQL", "FBKIN": "QSK",
    "SBKIN": "Semi-BK", "LOCK": "LOCK", "MUTE": "MUTE", "TUNER": "ATU", "DUAL_WATCH": "DW", "AFC": "AFC",
    "ANL": "ANL", "RF": "RF/SQL", "SATMODE": "SAT",
}
VFO_OPS = {"CPY": "A=B", "XCHG": "A/B", "TUNE": "TUNE", "BAND_UP": "Band ▲", "BAND_DOWN": "Band ▼",
           "UP": "Schritt ▲", "DOWN": "Schritt ▼", "TOGGLE": "VFO ⇄"}
# Programmoptionen „Kommunikation“: Abfrageintervall und beide VFOs in jedem Durchlauf lesen
POLL = {"interval": 0.25, "dual": False}
OPTIONAL = {"c", "r", "o", "e", "\\get_dcd"}
AGC_NAMES = {0: "AUS", 1: "Superschnell", 2: "Schnell", 3: "Langsam", 4: "Benutzer", 5: "Mittel", 6: "Auto"}
_RANGE = re.compile(r"([A-Z_0-9]+)\(([-\d.]+)\.\.([-\d.]+)/([-\d.]+)\)")


class RigError(RuntimeError):
    pass


class Rig:
    def __init__(self, host: str, port: int, on_change, rx_offset: int = 0, tx_offset: int | None = None):
        self.host, self.port = host, port
        self.on_change = on_change
        # Frequenzversatz (Transverter, LNB, QO-100): angezeigt = Geraet + Versatz; TX-Versatz gilt fuer VFO B / Split
        self.rx_off = int(rx_offset or 0)
        self.tx_off = self.rx_off if tx_offset in (None, "") else int(tx_offset)
        self.reader = self.writer = None
        self.lock = asyncio.Lock()
        self.caps: dict = {}
        self.state = dict(connected=False, freq=0, mode="", passband=0, ptt=False, error="",
                          vfo="VFOA", vfob_freq=0, vfob_mode="", split=False, tx_vfo="", rit=0, xit=0,
                          levels={}, funcs={}, meters={})
        self._slow_queue: list = []
        self._quiet_until = 0.0
        # gerade per Bedienung gesetzte Werte: haben kurz Vorrang vor laufenden Abfragen,
        # sonst ueberschreibt ein schon begonnener Abfragezyklus den neuen Wert mit dem alten
        self._ovr: dict = {}
        self._unsupported: set = set()

    OVR_SEC = 2.0

    def _mark(self, path: tuple, value):
        self._ovr[path] = (value, time.time())
        self._put(self.state, path, value)

    @staticmethod
    def _put(st: dict, path: tuple, value):
        if len(path) == 2:
            st[path[0]] = {**st.get(path[0], {}), path[1]: value}
        else:
            st[path[0]] = value

    def _fresh(self, path: tuple) -> bool:
        o = self._ovr.get(path)
        if o and time.time() - o[1] < self.OVR_SEC:
            return True
        self._ovr.pop(path, None)
        return False

    def reconfigure(self, host: str, port: int):
        if (host, port) != (self.host, self.port):
            self.host, self.port = host, port
            self._close()

    def _close(self):
        if self.writer:
            try:
                self.writer.close()
            except Exception:
                pass
        self.reader = self.writer = None
        self.caps = {}

    async def _cmd(self, cmd: str, timeout: float = 3) -> tuple[dict, list]:
        """Kommando senden. Rueckgabe: ('Schluessel: Wert'-Paare, reine Wertzeilen)."""
        async with self.lock:
            if not self.writer:
                self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), 3)
            self.writer.write(("+" + cmd + "\n").encode())
            await self.writer.drain()
            kv, vals, first = {}, [], True
            while True:
                raw = await asyncio.wait_for(self.reader.readline(), timeout)
                if not raw:
                    raise ConnectionError("rigctld hat die Verbindung geschlossen")
                line = raw.decode(errors="replace").rstrip("\r\n")
                if line.startswith("RPRT"):
                    code = int(line.split()[1])
                    if code != 0:
                        raise RigError(f"Funkgerät lehnt '{cmd}' ab (Hamlib-Fehler {code})")
                    return kv, vals
                if first:          # Echo-Zeile, z. B. 'get_level: AF'
                    first = False
                    continue
                if ":" in line and not line.lstrip().startswith("-"):
                    k, v = line.split(":", 1)
                    kv[k.strip().lower()] = v.strip()
                elif line.strip():
                    vals.append(line.strip())

    async def _caps(self):
        caps = dict(model="", mfg="", levels_get=[], levels_set=[], funcs_get=[], funcs_set=[], vfo_ops=[],
                    modes=[], preamp=[], att=[], agc=[], ranges={}, max_rit=0, max_xit=0)
        try:
            async with self.lock:
                if not self.writer:
                    self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), 3)
                self.writer.write(b"+\\dump_caps\n")
                await self.writer.drain()
                text = []
                while True:
                    line = (await asyncio.wait_for(self.reader.readline(), 5)).decode(errors="replace")
                    if not line or line.startswith("RPRT"):
                        break
                    text.append(line.rstrip())
            # Speicherkanaele: Zeilen wie '0..18:   MEM' unter 'Memories:'
            caps["memories"] = []
            for line in text:
                mm = re.match(r"\s*(\d+)\.\.(\d+):\s*(\w+)", line)
                if mm and mm.group(3) in ("MEM", "CALL", "EDGE", "MEMOPAD"):
                    caps["memories"].append(dict(lo=int(mm.group(1)), hi=int(mm.group(2)), type=mm.group(3)))
            for line in text:
                k, _, v = line.strip().partition(":")
                v = v.strip()
                if k == "Model name": caps["model"] = v
                elif k == "Mfg name": caps["mfg"] = v
                elif k == "Preamp": caps["preamp"] = [int(x[:-2]) for x in v.split() if x.endswith("dB")]
                elif k == "Attenuator": caps["att"] = [int(x[:-2]) for x in v.split() if x.endswith("dB")]
                elif k == "AGC levels":
                    caps["agc"] = sorted({int(a.split("=")[0]) for a in v.split() if "=" in a})
                elif k == "Mode list" and not caps["modes"]: caps["modes"] = v.split()
                elif k in ("Get level", "Set level"):
                    for name, lo, hi, step in _RANGE.findall(v):
                        if float(hi) > float(lo):
                            caps["ranges"][name] = (float(lo), float(hi), float(step))
                elif k == "Max RIT": caps["max_rit"] = _khz(v)
                elif k == "Max XIT": caps["max_xit"] = _khz(v)
        except (RigError, asyncio.TimeoutError) as e:
            log.warning("dump_caps nicht lesbar: %s", e)
        for key, cmd in (("levels_get", "l ?"), ("levels_set", "L ?"), ("funcs_get", "u ?"),
                         ("funcs_set", "U ?"), ("vfo_ops", "G ?")):
            try:
                _, vals = await self._cmd(cmd)
                caps[key] = " ".join(vals).split()
            except Exception:
                caps[key] = []
        # Oberflaechen-Beschreibung
        caps["ui_levels"] = []
        for name, (label, typ, lo, hi, step, unit) in LEVELS.items():
            if name in caps["levels_set"]:
                r = caps["ranges"].get(name)
                if r and typ == "i":
                    lo, hi, step = int(r[0]), int(r[1]), max(1, int(r[2] or 1))
                caps["ui_levels"].append(dict(name=name, label=label, type=typ, min=lo, max=hi, step=step, unit=unit))
        caps["ui_funcs"] = [dict(name=n, label=l) for n, l in FUNCS.items() if n in caps["funcs_set"]]
        caps["ui_ops"] = [dict(name=n, label=l) for n, l in VFO_OPS.items() if n in caps["vfo_ops"]]
        caps["ui_choices"] = []
        if "AGC" in caps["levels_set"]:
            caps["ui_choices"].append(dict(name="AGC", label="AGC", options=[
                dict(value=a, label=AGC_NAMES.get(a, str(a))) for a in (caps["agc"] or [0, 2, 3, 6])]))
        if "PREAMP" in caps["levels_set"]:
            caps["ui_choices"].append(dict(name="PREAMP", label="Vorverstärker", options=[dict(value=0, label="AUS")] + [
                dict(value=p, label=f"{p} dB") for p in caps["preamp"]]))
        if "ATT" in caps["levels_set"]:
            caps["ui_choices"].append(dict(name="ATT", label="Abschwächer", options=[dict(value=0, label="AUS")] + [
                dict(value=a, label=f"{a} dB") for a in caps["att"]]))
        caps["meters"] = [m for m in METERS if m in caps["levels_get"]]
        caps["has_morse"] = True
        # langsame Abfragen reihum (Regler, Schalter, VFO B, RIT/XIT)
        q = ["\\get_rig_info", "j", "z", "v", "c", "r", "o", "e", "\\get_dcd"]
        q += [f"l {d['name']}" for d in caps["ui_levels"] if d["name"] in caps["levels_get"]]
        q += [f"l {c['name']}" for c in caps["ui_choices"] if c["name"] in caps["levels_get"]]
        q += [f"u {f['name']}" for f in caps["ui_funcs"] if f["name"] in caps["funcs_get"]]
        caps["slow"] = q
        self.caps = caps
        log.info("Funkgerät: %s %s, %d Regler, %d Schalter", caps["mfg"], caps["model"], len(caps["ui_levels"]),
                 len(caps["ui_funcs"]))

    async def _read_vfob(self, st: dict):
        try:
            _, vals = await self._cmd("\\get_rig_info")
        except RigError:
            return
        for line in vals:
            f = dict(p.split("=", 1) for p in line.split() if "=" in p)
            if f.get("VFO") == "VFOB":
                st["vfob_freq"] = int(float(f.get("Freq", 0))) + self.tx_off
                st["vfob_mode"] = f.get("Mode", "")

    # ---------- Speicherkanaele ----------
    async def get_channel(self, ch: int) -> dict:
        kv, vals = await self._cmd(f"h {int(ch)} 1", timeout=5)
        text = " ".join([f"{k}: {v}" for k, v in kv.items()] + vals)
        mult = {"hz": 1, "khz": 1e3, "mhz": 1e6, "ghz": 1e9}

        def hz(key):     # 'Freq:   7.0740000 MHz' -> 7074000
            m = re.search(rf"(?<![a-z]){key}:\s*(-?[\d.]+)\s*(hz|khz|mhz|ghz)", text, re.I)
            return int(round(float(m.group(1)) * mult[m.group(2).lower()])) if m else 0

        def word(key):
            m = re.search(rf"(?<![a-z]){key}:\s*([^\s,\t]*)", text, re.I)
            v = m.group(1).strip("'") if m else ""
            return "" if v.endswith(":") else v
        m = re.search(r"name:\s*'([^']*)'", text, re.I)
        ct = re.search(r"(?<![a-z])ctcss:\s*([\d.]+)", text, re.I)
        return dict(ch=int(ch), name=m.group(1) if m else "", freq=hz("freq"), mode=word("mode"), width=hz("width"),
                    split=word("split").upper() == "ON", txfreq=hz("txfreq"), shift=word("shift"), offset=hz("offset"),
                    ctcss=float(ct.group(1)) if ct else 0.0)

    async def memory_op(self, ch: int, action: str):
        """recall: Speicher -> VFO, store: VFO -> Speicher, clear: Speicher loeschen."""
        op = {"recall": "TO_VFO", "store": "FROM_VFO", "clear": "MCL"}[action]
        if action == "recall":      # universell: Kanal lesen und auf dem VFO einstellen (klappt bei jedem Geraet mit lesbaren Kanaelen)
            try:
                c = await self.get_channel(ch)
            except RigError:
                c = {}
            if c.get("freq"):
                await self.set_freq(c["freq"])
                if c.get("mode"):
                    await self.set_mode(c["mode"], c.get("width") or 0)
                return
        await self._cmd(f"E {int(ch)}")
        if op in self.caps.get("vfo_ops", []):
            await self._cmd(f"G {op}")
        elif action == "recall":
            await self._cmd("V MEM")          # Geraet ohne TO_VFO: auf Speicherbetrieb schalten
        else:
            raise RigError(f"Das Funkgerät unterstützt '{op}' nicht")

    async def _slow_step(self, st: dict, n: int = 3):
        for _ in range(n):
            if not self._slow_queue:
                self._slow_queue = list(self.caps.get("slow", []))
                if not self._slow_queue:
                    return
            cmd = self._slow_queue.pop(0)
            if cmd in self._unsupported:
                continue
            try:
                kv, vals = await self._cmd(cmd)
            except RigError:
                if cmd in OPTIONAL:          # Geraet kann das nicht -> nicht mehr fragen
                    self._unsupported.add(cmd)
                continue
            if cmd == "\\get_rig_info":
                for line in vals:
                    f = dict(p.split("=", 1) for p in line.split() if "=" in p)
                    if f.get("VFO") == "VFOB":
                        st["vfob_freq"] = int(float(f.get("Freq", 0))) + self.tx_off
                        st["vfob_mode"] = f.get("Mode", "")
                    if "Split" in f and not self._fresh(("split",)):
                        st["split"] = f["Split"] == "1"
            elif cmd == "j" and not self._fresh(("rit",)):
                st["rit"] = int(kv.get("rit", 0) or 0)
            elif cmd == "z" and not self._fresh(("xit",)):
                st["xit"] = int(kv.get("xit", 0) or 0)
            elif cmd == "v" and not self._fresh(("vfo",)):
                st["vfo"] = kv.get("vfo", st["vfo"])
            elif cmd == "c":
                st["ctcss"] = float(kv.get("ctcss tone", 0) or 0) / 10
            elif cmd == "r":
                st["rptr_shift"] = kv.get("rptr shift", "")
            elif cmd == "o":
                st["rptr_offs"] = int(float(kv.get("rptr offset", 0) or 0))
            elif cmd == "e":
                st["mem"] = int(kv.get("memory#", kv.get("channel", -1)) or -1)
            elif cmd == "\\get_dcd":
                st["busy"] = (kv.get("dcd", "0") or "0") not in ("0", "")
            elif cmd.startswith("l ") and vals and not self._fresh(("levels", cmd[2:])):
                st["levels"] = {**st["levels"], cmd[2:]: float(vals[0])}
            elif cmd.startswith("u ") and vals and not self._fresh(("funcs", cmd[2:])):
                st["funcs"] = {**st["funcs"], cmd[2:]: vals[0] == "1"}

    async def poll_forever(self, interval: float | None = None):
        while True:
            try:
                if not self.caps:
                    await self._caps()
                    self._slow_queue = []
                st = {k: (dict(v) if isinstance(v, dict) else v) for k, v in self.state.items()}
                kv, _ = await self._cmd("f")
                st["freq"] = int(float(kv.get("frequency", 0))) + self.rx_off
                kv, _ = await self._cmd("m")
                st["mode"], st["passband"] = kv.get("mode", ""), int(kv.get("passband", 0) or 0)
                try:
                    kv, _ = await self._cmd("t")
                    st["ptt"] = kv.get("ptt", "0") not in ("0", "")
                except RigError:
                    pass          # Abfrage nicht moeglich (manche Geraete beim Senden): zuletzt gesetzten Zustand behalten
                meters = {}
                for m in (("RFPOWER_METER", "SWR", "ALC") if st["ptt"] else ("STRENGTH",)):
                    if m in self.caps.get("meters", []):
                        try:
                            _, vals = await self._cmd(f"l {m}")
                            meters[m] = float(vals[0]) if vals else None
                        except RigError:
                            pass
                st["meters"] = meters
                if POLL["dual"] and "\\get_rig_info" not in self._unsupported:
                    await self._read_vfob(st)
                if time.time() >= self._quiet_until:
                    await self._slow_step(st)
                st.update(connected=True, error="", model=f"{self.caps.get('mfg', '')} {self.caps.get('model', '')}".strip())
                for path in list(self._ovr):
                    if self._fresh(path):
                        self._put(st, path, self._ovr[path][0])
                await asyncio.sleep(interval or POLL["interval"])
            except Exception as e:
                self._close()
                st = dict(self.state, connected=False, ptt=False, error=str(e) or type(e).__name__, meters={})
                await asyncio.sleep(3)
            if st != self.state:
                self.state = st
                await self.on_change(dict(st))

    def _hold_slow(self, sec: float = 1.0):
        """Nach einer Bedienung kurz keine langsamen Abfragen, damit Regler nicht zurueckspringen."""
        self._quiet_until = time.time() + sec

    async def set_freq(self, hz: int):
        await self._cmd(f"F {int(hz) - self.rx_off}")
        self.state["freq"] = int(hz)

    async def set_mode(self, mode: str, passband: int = 0):
        await self._cmd(f"M {mode} {int(passband)}")
        self._mark(("mode",), mode)          # sofort sichtbar, nicht erst nach der naechsten Abfrage

    async def set_ptt(self, on: bool):
        await self._cmd(f"T {1 if on else 0}")
        self.state["ptt"] = bool(on)

    async def set_level(self, name: str, value: float):
        if name not in self.caps.get("levels_set", []):
            raise RigError(f"Regler {name} wird vom Funkgerät nicht unterstützt")
        self._hold_slow()
        v = int(round(value)) if (LEVELS.get(name, ("", "i"))[1] == "i" or name in CHOICE_LEVELS) else round(float(value), 3)
        await self._cmd(f"L {name} {v}")
        self._mark(("levels", name), float(v))

    async def set_func(self, name: str, on: bool):
        if name not in self.caps.get("funcs_set", []):
            raise RigError(f"Funktion {name} wird vom Funkgerät nicht unterstützt")
        self._hold_slow()
        await self._cmd(f"U {name} {1 if on else 0}")
        self._mark(("funcs", name), bool(on))

    async def vfo_op(self, op: str):
        if op not in self.caps.get("vfo_ops", []):
            raise RigError(f"VFO-Funktion {op} wird nicht unterstützt")
        await self._cmd(f"G {op}")
        self._slow_queue = ["\\get_rig_info", "v"] + self._slow_queue

    async def set_vfo(self, vfo: str):
        await self._cmd(f"V {vfo}")
        self._mark(("vfo",), vfo)

    async def set_split(self, on: bool):
        await self._cmd(f"S {1 if on else 0} VFOB")
        self._mark(("split",), bool(on))

    async def set_split_freq(self, hz: int):
        """Sendefrequenz im Split-Betrieb (z. B. Satelliten-Uplink mit Doppler-Korrektur)."""
        await self._cmd(f"I {int(hz) - self.tx_off}")

    async def set_repeater(self, shift: str, offset: int):
        await self._cmd(f"R {shift}")
        if offset:
            await self._cmd(f"O {int(offset)}")

    async def set_ctcss(self, tone: float):
        await self._cmd(f"C {int(round(tone * 10))}")
        try:
            await self._cmd("U TONE 1")
        except RigError:
            pass

    async def set_rit(self, hz: int):
        await self._cmd(f"J {int(hz)}")
        self._mark(("rit",), int(hz))

    async def set_xit(self, hz: int):
        await self._cmd(f"Z {int(hz)}")
        self._mark(("xit",), int(hz))

    async def send_morse(self, text: str):
        await self._cmd(f"b {text}", timeout=30)

    async def stop_morse(self):
        await self._cmd("\\stop_morse")


def _khz(v: str) -> int:
    m = re.search(r"([\d.]+)\s*kHz", v)
    return int(float(m.group(1)) * 1000) if m else 0
