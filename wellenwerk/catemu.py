"""CAT-Emulation: Wellenwerk antwortet wie ein Kenwood TS-2000, damit Programme ohne Hamlib-Netzanbindung
(nur „serielles Funkgeraet“) das gerade gewaehlte Funkgeraet steuern koennen.

Wege: TCP-Port, Pseudo-Terminal (macOS/Linux, Pfad wird angezeigt) oder serielle Schnittstelle
(Windows: ein Ende eines virtuellen Port-Paars, z. B. com0com; das Fremdprogramm nimmt das andere Ende)."""
import asyncio
import logging
import os
import sys

log = logging.getLogger("ww.catemu")

MODES = {"LSB": "1", "USB": "2", "CW": "3", "FM": "4", "AM": "5", "RTTY": "6", "CWR": "7", "RTTYR": "9",
         "PKTLSB": "1", "PKTUSB": "2", "PKTFM": "4", "WFM": "4"}
MODES_BACK = {"1": "LSB", "2": "USB", "3": "CW", "4": "FM", "5": "AM", "6": "RTTY", "7": "CWR", "9": "RTTYR"}


class CatEmu:
    def __init__(self, rig, notify=None):
        self.rig, self.notify = rig, notify or (lambda s: None)
        self.server = None
        self.pty_fd = None
        self.pty_name = ""
        self.serial = None
        self.kind = ""
        self.status = dict(on=False, kind="", where="", error="", clients=0)
        self._tasks = []

    # ---------- Protokoll ----------
    async def handle(self, cmd: str) -> str:
        """Ein Befehl ohne ';' -> Antwort mit ';' (leer bei reinen Setzbefehlen)."""
        r, st = self.rig, self.rig.state
        c, arg = cmd[:2].upper(), cmd[2:]
        try:
            if c == "ID":
                return "ID019;"
            if c == "PS":
                return "PS1;" if not arg else ""
            if c == "AI":
                return "AI0;" if not arg else ""
            if c == "FA":
                if arg:
                    await r.set_freq(int(arg))
                    return ""
                return f"FA{int(st.get('freq') or 0):011d};"
            if c == "FB":
                if arg:
                    await r.set_split_freq(int(arg))
                    return ""
                return f"FB{int(st.get('vfob_freq') or st.get('freq') or 0):011d};"
            if c == "MD":
                if arg:
                    m = MODES_BACK.get(arg[:1])
                    if m:
                        cur = st.get("mode", "")
                        if cur.startswith("PKT") and m in ("USB", "LSB", "FM"):
                            m = "PKT" + m          # Datenbetrieb beibehalten
                        await r.set_mode(m)
                    return ""
                return f"MD{MODES.get(st.get('mode', ''), '2')};"
            if c == "IF":
                rit = int(st.get("rit") or st.get("xit") or 0)
                return (f"IF{int(st.get('freq') or 0):011d}0000{'+' if rit >= 0 else '-'}{abs(rit):05d}"
                        f"{1 if st.get('rit') else 0}{1 if st.get('xit') else 0}000{1 if st.get('ptt') else 0}"
                        f"{MODES.get(st.get('mode', ''), '2')}0{'0'}{1 if st.get('split') else 0}0000;")
            if c == "TX":
                await r.set_ptt(True)
                return ""
            if c == "RX":
                await r.set_ptt(False)
                return ""
            if c in ("FR", "FT"):
                if arg:
                    if c == "FT":
                        await r.set_split(arg[:1] == "1")
                    return ""
                return f"{c}{1 if (c == 'FT' and st.get('split')) else 0};"
            if c == "SM":
                s = float((st.get("meters") or {}).get("STRENGTH", -54))          # dB ueber S9
                return f"SM0{max(0, min(30, round((s + 54) / 54 * 15 if s < 0 else 15 + s / 4))):04d};"
            if c == "PC":
                if arg:
                    await r.set_level("RFPOWER", int(arg) / 100)
                    return ""
                return f"PC{round(float((st.get('levels') or {}).get('RFPOWER', 1)) * 100):03d};"
            if c in ("AG", "RG"):
                name = "AF" if c == "AG" else "RF"
                if len(arg) > 1:
                    await r.set_level(name, int(arg[1:]) / 255)
                    return ""
                return f"{c}0{round(float((st.get('levels') or {}).get(name, 0.5)) * 255):03d};"
            if c == "RT":
                if arg:
                    await r.set_func("RIT", arg == "1")
                    return ""
                return f"RT{1 if st.get('rit') else 0};"
            if c == "XT":
                if arg:
                    await r.set_func("XIT", arg == "1")
                    return ""
                return f"XT{1 if st.get('xit') else 0};"
            if c == "FV":
                return "FV1.00;"
            if c in ("KS",):
                return "KS020;" if not arg else ""
            if c == "KY" and arg:
                await r.send_morse(arg[1:].strip()) if hasattr(r, "send_morse") else None
                return ""
            if c in ("EX", "SH", "SL", "NB", "NR", "PA", "RA", "GT", "BC", "AN", "MF", "LK", "TO", "CT", "TN"):
                return "" if arg else f"{c}0;" if c not in ("SH", "SL") else f"{c}00;"
        except Exception as e:
            log.debug("CAT %s: %s", cmd, e)
            return "?;"
        return "?;"

    async def _serve(self, read, write):
        buf = ""
        self.status["clients"] += 1
        self.notify(self.status)
        try:
            while True:
                data = await read()
                if not data:
                    break
                buf += data.decode("ascii", "ignore")
                while ";" in buf:
                    cmd, buf = buf.split(";", 1)
                    cmd = cmd.strip()
                    if cmd:
                        ans = await self.handle(cmd)
                        if ans:
                            await write(ans.encode())
        finally:
            self.status["clients"] -= 1
            self.notify(self.status)

    # ---------- Wege ----------
    async def start(self, kind: str, port: int = 0, device: str = ""):
        await self.stop()
        self.kind = kind
        self.status = dict(on=True, kind=kind, where="", error="", clients=0)
        try:
            if kind == "tcp":
                async def cli(r, w):
                    async def wr(b):
                        w.write(b)
                        await w.drain()
                    await self._serve(lambda: r.read(256), wr)
                    w.close()
                self.server = await asyncio.start_server(cli, "0.0.0.0", port)
                self.status["where"] = f"TCP-Port {port}"
            elif kind == "pty":
                if sys.platform == "win32":
                    raise RuntimeError("Unter Windows bitte ein virtuelles Port-Paar (com0com) und „Serielle Schnittstelle“ wählen")
                import termios
                import tty
                master, slave = os.openpty()
                tty.setraw(slave)
                attrs = termios.tcgetattr(slave)
                attrs[3] &= ~termios.ECHO
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                self.pty_fd, self._slave = master, slave
                os.set_blocking(master, False)
                self.pty_name = os.ttyname(slave)
                link = os.path.expanduser("~/.wellenwerk-cat")
                try:
                    if os.path.islink(link) or os.path.exists(link):
                        os.unlink(link)
                    os.symlink(self.pty_name, link)
                    self.status["link"] = link
                except OSError:
                    pass
                self.status["where"] = self.pty_name
                self._tasks.append(asyncio.create_task(self._pty_loop()))
            elif kind == "serial":
                import serial
                self.serial = serial.Serial(device, 9600, timeout=0.05)
                self.status["where"] = device
                self._tasks.append(asyncio.create_task(self._serial_loop()))
            else:
                raise RuntimeError("unbekannter Weg")
            log.info("CAT-Emulation (TS-2000) aktiv: %s", self.status["where"])
        except Exception as e:
            self.status = dict(on=False, kind=kind, where="", error=str(e), clients=0)
            log.warning("CAT-Emulation: %s", e)
        self.notify(self.status)

    async def _pty_loop(self):
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        loop.add_reader(self.pty_fd, lambda: q.put_nowait(self._pty_read()))

        async def rd():
            return await q.get() or b" "

        async def wr(b):
            try:
                os.write(self.pty_fd, b)
            except OSError:
                pass
        await self._serve(rd, wr)

    def _pty_read(self) -> bytes:
        try:
            return os.read(self.pty_fd, 256)
        except OSError:
            return b""

    async def _serial_loop(self):
        async def rd():
            while True:
                b = await asyncio.to_thread(self.serial.read, 256)
                if b:
                    return b

        async def wr(b):
            await asyncio.to_thread(self.serial.write, b)
        await self._serve(rd, wr)

    async def stop(self):
        if self.pty_fd is not None:      # erst bei der Ereignisschleife abmelden, dann schliessen (sonst erbt ein neuer Socket den Beobachter)
            try:
                asyncio.get_running_loop().remove_reader(self.pty_fd)
            except (ValueError, OSError):
                pass
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []
        if self.server:
            self.server.close()
            self.server = None
        if self.pty_fd is not None:
            for fd in (self.pty_fd, getattr(self, "_slave", None)):
                try:
                    fd is not None and os.close(fd)
                except OSError:
                    pass
            self.pty_fd = None
        if self.serial:
            try:
                self.serial.close()
            except Exception:
                pass
            self.serial = None
        self.status = dict(on=False, kind="", where="", error="", clients=0)
