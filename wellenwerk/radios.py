"""Funkgeraete-Verwaltung im Verbinden-Dialog: Hersteller/Modell aus der Hamlib-Liste, Port, Baudrate,
CI-V-Adresse, Handshake, PTT-Art. Wellenwerk startet je Geraet einen eigenen rigctld und verbindet sich damit.
Mehrere Geraete gleichzeitig moeglich (Register)."""
import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

from .rig import Rig

log = logging.getLogger("ww.radios")
BASE = Path(__file__).resolve().parent.parent


def hamlib_exe(name: str) -> str | None:
    """rigctld/rotctld finden: Umgebungsvariable, mitgeliefertes hamlib/bin, Systempfad."""
    env = os.environ.get(f"WW_{name.upper()}")
    if env and Path(env).exists():
        return env
    exe = name + (".exe" if sys.platform == "win32" else "")
    for d in (BASE / "hamlib" / "bin", BASE / "hamlib"):
        if (d / exe).exists():
            return str(d / exe)
    found = shutil.which(name)
    if found:
        return found
    # per Doppelklick gestartete Programme sehen unter macOS den Homebrew-Pfad nicht
    for d in ("/opt/homebrew/bin", "/usr/local/bin", r"C:\Program Files\hamlib\bin"):
        if (Path(d) / exe).exists():
            return str(Path(d) / exe)
    return None


def hamlib_env() -> dict:
    """Mitgelieferte Hamlib-Bibliotheken (Linux-Paket) fuer die Hamlib-Programme auffindbar machen."""
    env = dict(os.environ)
    lib = BASE / "hamlib" / "lib"
    if sys.platform.startswith("linux") and lib.is_dir():
        env["LD_LIBRARY_PATH"] = f"{lib}:{env.get('LD_LIBRARY_PATH', '')}".rstrip(":")
    return env


def model_list(tool: str = "rigctl") -> list[dict]:
    """Hamlib-Modelliste (rigctl -l / rotctl -l) als Liste {id, mfg, model, status}."""
    exe = hamlib_exe(tool)
    if not exe:
        return []
    out = subprocess.run([exe, "-l"], capture_output=True, text=True, timeout=20, env=hamlib_env()).stdout.splitlines()
    if not out:
        return []
    head = out[0]
    c_mfg, c_model, c_ver = head.index("Mfg"), head.index("Model"), head.index("Version")
    c_status = head.index("Status")
    res = []
    for line in out[1:]:
        if not line.strip():
            continue
        try:
            mid = int(line[:c_mfg].strip())
        except ValueError:
            continue
        res.append(dict(id=mid, mfg=line[c_mfg:c_model].strip() or "Sonstige", model=line[c_model:c_ver].strip() or line[c_mfg:c_model].strip(),
                        status=line[c_status:].split()[0] if line[c_status:].split() else ""))
    return res


def serial_ports() -> list[dict]:
    try:
        from serial.tools import list_ports
        ports = [dict(device=p.device, desc=" ".join(x for x in (p.description, p.manufacturer or "") if x and x != "n/a").strip(),
                      hwid=p.hwid) for p in list_ports.comports()]
    except Exception:
        ports = []
    by_id = Path("/dev/serial/by-id")
    if by_id.exists():
        for p in sorted(by_id.iterdir()):
            ports.append(dict(device=str(p), desc=p.name, hwid="by-id"))
    return ports


def parse_civ(v) -> int | None:
    """CI-V-Adresse als Hex ('94', '94h', '0x94') oder dezimal mit 'd' am Ende."""
    if v in (None, "", "auto"):
        return None
    s = str(v).strip().lower()
    if s.endswith("d"):
        return int(s[:-1])
    s = s.removesuffix("h").removeprefix("0x")
    return int(s, 16)


MCAST = "127.0.0.1"     # Hamlib sendet die "Multicast"-Daten direkt an diesen Rechner (Firewall-sicher)


class _SpectrumProto(asyncio.DatagramProtocol):
    """Hamlib-Multicast-Schnappschuesse; nur Pakete mit 'spectra' (Scope-Zeilen) werden weitergereicht."""
    def __init__(self, cb):
        self.cb = cb
        self.last = 0.0

    def datagram_received(self, data, addr):
        try:
            j = json.loads(data)
        except ValueError:
            return
        for sp in j.get("spectra") or []:
            now = time.monotonic()
            if now - self.last < 0.08:          # hoechstens ~12 Zeilen/s an die Oberflaeche
                return
            self.last = now
            try:
                vals = list(bytes.fromhex(sp.get("data", "")))
            except ValueError:
                return
            line = dict(name=sp.get("name", ""), low=sp.get("lowFreq"), high=sp.get("highFreq"), center=sp.get("centerFreq"),
                        span=sp.get("span"), min=sp.get("minLevel", 0), max=sp.get("maxLevel", 255), data=vals)
            res = self.cb(line)
            if asyncio.iscoroutine(res):
                asyncio.ensure_future(res)
            return


async def listen_spectrum(port: int, cb):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((MCAST, port))
    transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(lambda: _SpectrumProto(cb), sock=sock)
    return transport


class RadioProc:
    """Ein verbundenes Funkgeraet: eigener rigctld-Prozess + Rig-Client."""

    def __init__(self, profile: dict, port: int, on_change, on_spectrum=None):
        self.p = profile
        self.port = port
        self.on_spectrum = on_spectrum
        self.mc = None
        # Scope-Daten liefert Hamlib bisher fuer Icom-Geraete mit Spektrum (IC-7300, 705, 9700, 7610, 905 ...)
        self.scope = bool(profile.get("scope", (profile.get("mfg") or "").lower() == "icom"))
        self.proc: subprocess.Popen | None = None
        self.log = deque(maxlen=200)
        self.rig: Rig | None = None
        self.task: asyncio.Task | None = None
        self.on_change = on_change

    def cmdline(self) -> list[str]:
        p = self.p
        exe = hamlib_exe("rigctld")
        if not exe:
            raise RuntimeError("Hamlib (rigctld) ist nicht installiert")
        cmd = [exe, "-m", str(int(p["model"])), "-T", "0.0.0.0" if p.get("share") else "127.0.0.1", "-t", str(self.port)]
        if int(p["model"]) in (2, 4, 5) or p.get("network"):     # Netzwerk-Anbindung (rigctld, FLRig, TRXManager)
            if p.get("host"):
                cmd += ["-r", p["host"]]
        elif int(p["model"]) != 1:
            if not p.get("device"):
                raise RuntimeError("kein Port gewählt")
            cmd += ["-r", p["device"]]
            if p.get("speed") and str(p["speed"]) != "auto":
                cmd += ["-s", str(int(p["speed"]))]
        civ = parse_civ(p.get("civaddr"))
        if civ is not None:
            cmd += ["-c", str(civ)]
        conf = []
        hs = p.get("handshake") or "default"
        if hs != "default":
            conf.append(f"serial_handshake={ {'none': 'None', 'hardware': 'Hardware', 'software': 'XONXOFF'}[hs] }")
        for k in ("dtr_state", "rts_state"):
            if p.get(k) and p[k] != "default":
                conf.append(f"{k}={ {'on': 'ON', 'off': 'OFF'}[p[k]] }")
        if p.get("ptt_type") and p["ptt_type"] != "RIG":
            cmd += ["-P", p["ptt_type"]]
            if p.get("ptt_device"):
                cmd += ["-p", p["ptt_device"]]
        for extra in (p.get("conf") or "").split(","):
            if "=" in extra:
                conf.append(extra.strip())
        if self.scope:     # Panadapter: Hamlib veroeffentlicht die Scope-Daten (Icom) per Multicast
            conf += ["async=1", f"multicast_data_addr={MCAST}", f"multicast_data_port={self.port + 100}"]
        for c in conf:
            cmd += ["-C", c]
        return cmd

    async def start(self):
        cmd = self.cmdline()
        self.log.append("$ " + " ".join(cmd))
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=hamlib_env())
        asyncio.get_running_loop().run_in_executor(None, self._pump)
        await asyncio.sleep(1.2)
        if self.proc.poll() is not None:
            raise RuntimeError("rigctld beendet sich sofort: " + " | ".join(list(self.log)[-4:]))
        self.rig = Rig("127.0.0.1", self.port, self._changed)
        self.task = asyncio.create_task(self.rig.poll_forever())
        if self.scope and self.on_spectrum:
            try:
                self.mc = await listen_spectrum(self.port + 100, lambda line: self.on_spectrum(self.p["id"], line))
            except OSError as e:
                self.log.append(f"Panadapter-Empfang nicht moeglich: {e}")

    def _pump(self):
        try:
            for line in self.proc.stdout:
                self.log.append(line.rstrip())
        except Exception:
            pass

    async def _changed(self, state):
        await self.on_change(self.p["id"], state)

    async def stop(self):
        if self.mc:
            self.mc.close()
            self.mc = None
        if self.task:
            self.task.cancel()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class RadioManager:
    def __init__(self, data_dir: Path, on_change, base_port: int = 4600, on_spectrum=None):
        self.path = Path(data_dir) / "radios.json"
        self.on_change = on_change
        self.on_spectrum = on_spectrum
        self.base_port = base_port
        self.active: dict[str, RadioProc] = {}
        self.current: str | None = None
        self.profiles: list[dict] = self._load()

    def _load(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text())
        except Exception:
            return []

    def save(self):
        self.path.write_text(json.dumps(self.profiles, indent=1))

    def profile(self, pid: str) -> dict | None:
        return next((p for p in self.profiles if p["id"] == pid), None)

    def upsert(self, prof: dict) -> dict:
        if not prof.get("id"):
            n = 1
            while self.profile(f"r{n}"):
                n += 1
            prof["id"] = f"r{n}"
        old = self.profile(prof["id"])
        if old:
            old.update(prof)
            prof = old
        else:
            self.profiles.append(prof)
        self.save()
        return prof

    def delete(self, pid: str):
        self.profiles = [p for p in self.profiles if p["id"] != pid]
        self.save()

    def rig(self, pid: str | None = None) -> Rig | None:
        pid = pid or self.current
        rp = self.active.get(pid) if pid else None
        return rp.rig if rp else None

    async def connect(self, pid: str):
        if pid in self.active:
            return
        prof = self.profile(pid)
        if not prof:
            raise RuntimeError("Profil nicht gefunden")
        used = {rp.port for rp in self.active.values()}
        port = next(p for p in range(self.base_port, self.base_port + 50) if p not in used)
        rp = RadioProc(prof, port, self.on_change, self.on_spectrum)
        try:
            await rp.start()
            #: erst als verbunden melden, wenn das Geraet wirklich antwortet
            for _ in range(32):
                if rp.rig.state.get("connected"):
                    break
                if rp.proc.poll() is not None:
                    break
                await asyncio.sleep(0.25)
            if not rp.rig.state.get("connected"):
                tail = [l for l in list(rp.log)[1:] if l.strip()][-3:]
                raise RuntimeError("Funkgerät antwortet nicht" + (f" ({rp.rig.state.get('error')})" if rp.rig.state.get("error") else "")
                                   + (": " + " | ".join(tail) if tail else " – Port, Baudrate, CI-V-Adresse und Kabel prüfen"))
        except Exception:
            await rp.stop()
            raise
        self.active[pid] = rp
        self.current = pid
        log.info("Funkgerät %s verbunden (Modell %s, %s)", prof.get("name"), prof.get("model"), prof.get("device") or prof.get("host") or "-")

    async def disconnect(self, pid: str):
        rp = self.active.pop(pid, None)
        if rp:
            await rp.stop()
        if self.current == pid:
            self.current = next(iter(self.active), None)

    async def autoconnect(self):
        for p in self.profiles:
            if p.get("autoconnect"):
                try:
                    await self.connect(p["id"])
                except Exception as e:
                    log.warning("Auto-Connect %s fehlgeschlagen: %s", p.get("name"), e)

    async def stop_all(self):
        for pid in list(self.active):
            await self.disconnect(pid)

    def status(self) -> list[dict]:
        out = []
        for p in self.profiles:
            rp = self.active.get(p["id"])
            out.append(dict(p, connected=bool(rp), current=p["id"] == self.current, cat_port=rp.port if rp else None,
                            scope=bool(rp.scope) if rp else p.get("scope"),
                            state=rp.rig.state if rp and rp.rig else None))
        return out
