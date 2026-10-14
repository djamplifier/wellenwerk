"""Rotorsteuerung ueber Hamlib rotctld (Netzprotokoll, erweiterte '+'-Antworten)."""
import asyncio
import logging
import re

log = logging.getLogger("ww.rotor")


class RotorError(RuntimeError):
    pass


class Rotor:
    def __init__(self, host: str, port: int, enabled: bool, on_change):
        self.host, self.port, self.enabled = host, port, enabled
        self.on_change = on_change
        self.reader = self.writer = None
        self.lock = asyncio.Lock()
        self.caps: dict = {}
        self.target = None
        self.state = dict(enabled=enabled, connected=False, az=None, el=None, target=None, moving=False, error="",
                          model="", min_az=0, max_az=360, min_el=0, max_el=90, el_capable=False)
        self._wake = asyncio.Event()

    def reconfigure(self, host: str, port: int, enabled: bool):
        if (host, port, enabled) != (self.host, self.port, self.enabled):
            self.host, self.port, self.enabled = host, port, enabled
            self._close()
            self._wake.set()

    def _close(self):
        if self.writer:
            try:
                self.writer.close()
            except Exception:
                pass
        self.reader = self.writer = None
        self.caps = {}

    async def _cmd(self, cmd: str, timeout: float = 5) -> tuple[dict, list]:
        async with self.lock:
            if not self.writer:
                self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), 3)
            self.writer.write(("+" + cmd + "\n").encode())
            await self.writer.drain()
            kv, vals, first = {}, [], True
            while True:
                raw = await asyncio.wait_for(self.reader.readline(), timeout)
                if not raw:
                    raise ConnectionError("rotctld hat die Verbindung geschlossen")
                line = raw.decode(errors="replace").rstrip("\r\n")
                if line.startswith("RPRT"):
                    code = int(line.split()[1])
                    if code != 0:
                        raise RotorError(f"Rotor lehnt '{cmd}' ab (Hamlib-Fehler {code})")
                    return kv, vals
                if first:
                    first = False
                    continue
                if ":" in line:
                    k, v = line.split(":", 1)
                    kv[k.strip().lower()] = v.strip()
                elif line.strip():
                    vals.append(line.strip())

    async def _load_caps(self):
        kv, _ = await self._cmd("\\dump_caps")
        f = lambda k, d: float(re.sub(r"[^\d.\-]", "", kv.get(k, "")) or d)
        self.caps = dict(model=f"{kv.get('mfg name', '')} {kv.get('model name', '')}".strip(),
                         min_az=f("min azimuth", 0), max_az=f("max azimuth", 360),
                         min_el=f("min elevation", 0), max_el=f("max elevation", 0),
                         el_capable="el" in kv.get("rot type", "").lower())
        log.info("Rotor: %s (Az %s..%s, El %s..%s)", self.caps["model"], self.caps["min_az"], self.caps["max_az"],
                 self.caps["min_el"], self.caps["max_el"])

    async def run_forever(self):
        last_az = None
        while True:
            if not self.enabled:
                new = dict(self.state, enabled=False, connected=False, error="")
                if new != self.state:
                    self.state = new
                    await self.on_change(dict(new))
                self._wake.clear()
                await self._wake.wait()
                continue
            try:
                if not self.caps:
                    await self._load_caps()
                kv, _ = await self._cmd("p")
                az, el = float(kv.get("azimuth", 0)), float(kv.get("elevation", 0))
                moving = last_az is not None and abs(az - last_az) > 0.05
                if self.target is not None and abs(((az - self.target) + 180) % 360 - 180) < 1.0 and not moving:
                    self.target = None
                last_az = az
                new = dict(self.state, enabled=True, connected=True, az=round(az, 1), el=round(el, 1), moving=moving,
                           target=self.target, error="", **self.caps)
                delay = 0.5 if (moving or self.target is not None) else 2.0
            except Exception as e:
                self._close()
                new = dict(self.state, enabled=True, connected=False, moving=False, error=str(e) or type(e).__name__)
                delay = 5
            if new != self.state:
                self.state = new
                await self.on_change(dict(new))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), delay)
            except asyncio.TimeoutError:
                pass

    async def set_pos(self, az: float, el: float | None = None):
        if not self.enabled:
            raise RotorError("Rotor ist in den Einstellungen nicht aktiviert")
        az = az % 360
        lo, hi = self.caps.get("min_az", 0), self.caps.get("max_az", 360)
        if az < lo:
            az += 360
        if az > hi:
            az -= 360
        el = 0.0 if el is None else max(self.caps.get("min_el", 0), min(self.caps.get("max_el", 90) or 0, el))
        await self._cmd(f"P {az:.1f} {el:.1f}")
        self.target = az % 360
        self._wake.set()

    async def stop(self):
        await self._cmd("S")
        self.target = None
        self._wake.set()

    async def park(self):
        await self._cmd("K")
        self.target = None
        self._wake.set()
