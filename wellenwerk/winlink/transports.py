"""Verbindungswege fuer Winlink. Jede Verbindung liefert einen asyncio.StreamReader (empfangene Daten),
eine async write()-Funktion und close(). Funkmodems werden ueber ihre TCP-Schnittstellen angesprochen:
ARDOP (ardopcf u. a., Befehl+Daten), VARA (Programm des Nutzers, Befehl 8300/Daten 8301), AGW (z. B. Direwolf)."""
import asyncio
import logging
import struct

log = logging.getLogger("ww.winlink")


class LinkError(RuntimeError):
    pass


class Link:
    def __init__(self):
        self.reader = asyncio.StreamReader(limit=1 << 20)
        self.remote = ""
        self.bw = ""

    async def write(self, data: bytes):
        raise NotImplementedError

    async def close(self):
        pass


# ---------------- Telnet (Winlink-Server oder Peer) ----------------
class TelnetLink(Link):
    @classmethod
    async def open(cls, host: str, port: int, mycall: str, password: str = "CMSTelnet", timeout: float = 30):
        self = cls()
        try:
            self.r, self.w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        except (OSError, asyncio.TimeoutError) as e:
            raise LinkError(f"{host}:{port} nicht erreichbar ({e or 'Zeitüberschreitung'})")
        while True:
            try:
                raw = await asyncio.wait_for(self.r.readuntil(b"\r"), timeout)
            except (asyncio.IncompleteReadError, asyncio.TimeoutError):
                raise LinkError("Anmeldung am Server gescheitert")
            line = raw.decode("latin-1").strip().lower()
            if line.startswith("callsign"):
                self.w.write(mycall.upper().encode() + b"\r")
            elif line.startswith("password"):
                self.w.write(password.encode() + b"\r")
                break
        self.reader = self.r
        self.remote = host
        return self

    async def write(self, data: bytes):
        self.w.write(data)
        await self.w.drain()

    async def close(self):
        try:
            self.w.close()
        except Exception:
            pass


# ---------------- ARDOP (TCP-Hostschnittstelle) ----------------
class ArdopLink(Link):
    """Befehle zeilenweise (\\r) an Port p, Daten an Port p+1 als [Laenge 2 Byte BE][Daten];
    vom Modem: [Laenge][Typ 'ARQ'/'FEC'/'IDF'][Daten]. PTT-Wuensche des Modems ('PTT TRUE/FALSE') gehen an ptt()."""

    def __init__(self, ptt=None, status=None):
        super().__init__()
        self.ptt, self.status = ptt, status or (lambda s: None)
        self.lines: asyncio.Queue = asyncio.Queue()
        self.buffer = 0
        self.connected = False
        self.tasks = []

    async def _open(self, host, port):
        try:
            self.cr, self.cw = await asyncio.wait_for(asyncio.open_connection(host, port), 5)
            self.dr, self.dw = await asyncio.wait_for(asyncio.open_connection(host, port + 1), 5)
        except (OSError, asyncio.TimeoutError):
            raise LinkError(f"ARDOP-Modem auf {host}:{port} nicht erreichbar – läuft ardopcf/ARDOP?")
        self.tasks = [asyncio.create_task(self._ctrl()), asyncio.create_task(self._data())]

    async def _ctrl(self):
        try:
            while True:
                raw = await self.cr.readuntil(b"\r")
                line = raw.decode("latin-1").strip()
                if not line:
                    continue
                w = line.split()
                c = w[0].upper()
                if c == "PTT":
                    if self.ptt:
                        await _maybe(self.ptt(w[1].upper() in ("TRUE", "ON")))
                    continue
                if c == "BUFFER":
                    self.buffer = int(w[1]) if len(w) > 1 and w[1].isdigit() else 0
                elif c == "CONNECTED":
                    self.connected = True
                    self.remote = w[1] if len(w) > 1 else ""
                    self.bw = w[2] if len(w) > 2 else ""
                elif c in ("DISCONNECTED",) or (c == "NEWSTATE" and len(w) > 1 and w[1] == "DISC"):
                    if self.connected:
                        self.connected = False
                        self.reader.feed_eof()
                if c not in ("BUFFER", "INPUTPEAKS", "BUSY", "PING"):
                    self.status(f"ARDOP: {line}")
                await self.lines.put(line)
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            if not self.reader.at_eof():
                self.reader.feed_eof()

    async def _data(self):
        try:
            while True:
                n, = struct.unpack(">H", await self.dr.readexactly(2))
                blob = await self.dr.readexactly(n)
                if blob[:3] == b"ARQ":
                    self.reader.feed_data(blob[3:])
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            pass

    async def cmd(self, text: str, timeout: float = 10):
        name = text.split()[0].upper()
        while not self.lines.empty():
            self.lines.get_nowait()
        self.cw.write(text.encode() + b"\r")
        await self.cw.drain()
        end = asyncio.get_running_loop().time() + timeout
        while True:
            left = end - asyncio.get_running_loop().time()
            if left <= 0:
                raise LinkError(f"ARDOP antwortet nicht auf {name}")
            line = await asyncio.wait_for(self.lines.get(), left)
            if line.upper().startswith("FAULT"):
                raise LinkError(f"ARDOP: {line}")
            if line.upper().startswith(name):
                return line

    @classmethod
    async def open(cls, host, port, mycall, target, bw="2000MAX", locator="", ptt=None, status=None, repeat=10):
        self = cls(ptt, status)
        await self._open(host, port)
        try:
            await self.cmd("INITIALIZE")
            await self.cmd(f"MYCALL {mycall.upper()}")
            if locator:
                try:
                    await self.cmd(f"GRIDSQUARE {locator[:6].upper()}")
                except LinkError:
                    pass
            await self.cmd("PROTOCOLMODE ARQ")
            await self.cmd("ARQTIMEOUT 120")
            await self.cmd("LISTEN FALSE")
            await self.cmd(f"ARQBW {bw}")
            self.cw.write(f"ARQCALL {target.upper()} {repeat}\r".encode())
            await self.cw.drain()
            while True:   # bis verbunden oder gescheitert (Anrufe dauern bis zu einige Minuten)
                line = await asyncio.wait_for(self.lines.get(), 400)
                u = line.upper()
                if u.startswith("CONNECTED"):
                    return self
                if u.startswith("FAULT"):
                    raise LinkError(f"ARDOP: {line}")
                if u.startswith("DISCONNECTED") or u == "NEWSTATE DISC" or ("CONNECT" in u and "FAIL" in u):
                    raise LinkError(f"{target} antwortet nicht (ARDOP)")
        except BaseException:
            await self._shutdown()
            raise

    async def write(self, data: bytes):
        for i in range(0, len(data), 4096):
            chunk = data[i:i + 4096]
            self.dw.write(struct.pack(">H", len(chunk)) + chunk)
        await self.dw.drain()

    async def close(self, timeout: float = 300):
        if self.connected:
            end = asyncio.get_running_loop().time() + timeout
            await asyncio.sleep(1)
            while self.buffer > 0 and self.connected and asyncio.get_running_loop().time() < end:
                await asyncio.sleep(1)
            try:
                self.cw.write(b"DISCONNECT\r")
                for _ in range(60):
                    if not self.connected:
                        break
                    await asyncio.sleep(1)
                else:
                    self.cw.write(b"ABORT\r")
            except Exception:
                pass
        await self._shutdown()

    async def abort(self):
        try:
            self.cw.write(b"ABORT\r")
        except Exception:
            pass
        await self._shutdown()

    async def _shutdown(self):
        if self.ptt:
            try:
                await _maybe(self.ptt(False))
            except Exception:
                pass
        for t in self.tasks:
            t.cancel()
        for w in (getattr(self, "cw", None), getattr(self, "dw", None)):
            try:
                w and w.close()
            except Exception:
                pass


# ---------------- VARA (TCP-Schnittstelle des VARA-Modems) ----------------
class VaraLink(Link):
    """Nur die dokumentierte Host-Schnittstelle des Modems: Befehle (\\r) an Port p, Rohdaten an Port p+1.
    Das VARA-Programm selbst (und ggf. seine Lizenz) stellt der Nutzer."""

    def __init__(self, ptt=None, status=None):
        super().__init__()
        self.ptt, self.status = ptt, status or (lambda s: None)
        self.lines: asyncio.Queue = asyncio.Queue()
        self.buffer = 0
        self.connected = False
        self.tasks = []

    async def _ctrl(self):
        try:
            while True:
                line = (await self.cr.readuntil(b"\r")).decode("latin-1").strip()
                if not line:
                    continue
                w = line.split()
                c = w[0].upper()
                if c == "PTT":
                    if self.ptt:
                        await _maybe(self.ptt(len(w) > 1 and w[1].upper() == "ON"))
                    continue
                if c == "BUFFER":
                    self.buffer = int(w[1]) if len(w) > 1 and w[1].isdigit() else 0
                    continue
                if c == "CONNECTED":
                    self.connected = True
                    self.remote = w[2] if len(w) > 2 else ""
                    self.bw = w[3] if len(w) > 3 else ""
                elif c == "DISCONNECTED":
                    if self.connected:
                        self.connected = False
                        self.reader.feed_eof()
                if c not in ("BUSY", "SN", "IAMALIVE"):
                    self.status(f"VARA: {line}")
                await self.lines.put(line)
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            if not self.reader.at_eof():
                self.reader.feed_eof()

    async def _data(self):
        try:
            while True:
                b = await self.dr.read(4096)
                if not b:
                    break
                self.reader.feed_data(b)
        except (ConnectionError, asyncio.CancelledError):
            pass

    async def cmd(self, text: str, timeout: float = 10):
        while not self.lines.empty():
            self.lines.get_nowait()
        self.cw.write(text.encode() + b"\r")
        await self.cw.drain()
        line = await asyncio.wait_for(self.lines.get(), timeout)
        if line.upper().startswith("WRONG"):
            raise LinkError(f"VARA lehnt '{text}' ab")
        return line

    @classmethod
    async def open(cls, host, port, mycall, target, bw="2300", ptt=None, status=None):
        self = cls(ptt, status)
        try:
            self.cr, self.cw = await asyncio.wait_for(asyncio.open_connection(host, port), 5)
            self.dr, self.dw = await asyncio.wait_for(asyncio.open_connection(host, port + 1), 5)
        except (OSError, asyncio.TimeoutError):
            raise LinkError(f"VARA-Modem auf {host}:{port} nicht erreichbar – läuft VARA?")
        self.tasks = [asyncio.create_task(self._ctrl()), asyncio.create_task(self._data())]
        try:
            await self.cmd(f"MYCALL {mycall.upper()}")
            await self.cmd("LISTEN OFF")
            if bw:
                try:
                    await self.cmd(f"BW{bw}")
                except LinkError:
                    pass
            self.cw.write(f"CONNECT {mycall.upper()} {target.upper()}\r".encode())
            await self.cw.drain()
            while True:
                line = (await asyncio.wait_for(self.lines.get(), 400)).upper()
                if line.startswith("CONNECTED"):
                    return self
                if line.startswith("DISCONNECTED") or line.startswith("WRONG"):
                    raise LinkError(f"{target} antwortet nicht (VARA)")
        except BaseException:
            await self._shutdown()
            raise

    async def write(self, data: bytes):
        self.dw.write(data)
        await self.dw.drain()

    async def close(self, timeout: float = 300):
        if self.connected:
            end = asyncio.get_running_loop().time() + timeout
            await asyncio.sleep(1)
            while self.buffer > 0 and self.connected and asyncio.get_running_loop().time() < end:
                await asyncio.sleep(1)
            try:
                self.cw.write(b"DISCONNECT\r")
                for _ in range(60):
                    if not self.connected:
                        break
                    await asyncio.sleep(1)
                else:
                    self.cw.write(b"ABORT\r")
            except Exception:
                pass
        await self._shutdown()

    async def abort(self):
        try:
            self.cw.write(b"ABORT\r")
        except Exception:
            pass
        await self._shutdown()

    async def _shutdown(self):
        if self.ptt:
            try:
                await _maybe(self.ptt(False))
            except Exception:
                pass
        for t in self.tasks:
            t.cancel()
        for w in (getattr(self, "cw", None), getattr(self, "dw", None)):
            try:
                w and w.close()
            except Exception:
                pass


# ---------------- Packet ueber AGW-Schnittstelle (Direwolf, AGWPE, QtSoundModem u. a.) ----------------
AGW_HDR = struct.Struct("<B3xcxBx10s10sII")


def _agw(kind: bytes, port=0, pid=0, frm="", to="", data=b"") -> bytes:
    return AGW_HDR.pack(port, kind, pid, frm.encode()[:10], to.encode()[:10], len(data), 0) + data


class AgwLink(Link):
    PACLEN = 128

    def __init__(self, status=None):
        super().__init__()
        self.status = status or (lambda s: None)
        self.events: asyncio.Queue = asyncio.Queue()
        self.connected = False
        self.outstanding = 0
        self.tasks = []

    async def _rx(self):
        try:
            while True:
                port, kind, pid, frm, to, n, _ = AGW_HDR.unpack(await self.r.readexactly(AGW_HDR.size))
                data = await self.r.readexactly(n) if n else b""
                frm, to = frm.split(b"\0")[0].decode(), to.split(b"\0")[0].decode()
                if kind == b"D":
                    self.reader.feed_data(data)
                elif kind == b"C":
                    self.connected = True
                    self.status("Packet: " + data.decode("latin-1").strip())
                    await self.events.put(("C", data))
                elif kind == b"d":
                    self.status("Packet: " + (data.decode("latin-1").strip() or "getrennt"))
                    if self.connected:
                        self.connected = False
                        self.reader.feed_eof()
                    await self.events.put(("d", data))
                elif kind in (b"Y", b"y"):
                    self.outstanding = struct.unpack("<I", data[:4])[0] if len(data) >= 4 else 0
                elif kind == b"X":
                    await self.events.put(("X", data))
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            if not self.reader.at_eof():
                self.reader.feed_eof()

    @classmethod
    async def open(cls, host, port, radio_port, mycall, target, via="", status=None, timeout=180):
        self = cls(status)
        self.mycall, self.target, self.rport = mycall.upper(), target.upper(), int(radio_port)
        try:
            self.r, self.w = await asyncio.wait_for(asyncio.open_connection(host, port), 5)
        except (OSError, asyncio.TimeoutError):
            raise LinkError(f"AGW-Schnittstelle {host}:{port} nicht erreichbar – läuft Direwolf (AGWPORT)?")
        self.tasks = [asyncio.create_task(self._rx())]
        try:
            self.w.write(_agw(b"X", frm=self.mycall))
            await self.w.drain()
            ev = await asyncio.wait_for(self.events.get(), 5)
            if ev[0] == "X" and ev[1][:1] == b"\0":
                raise LinkError("Rufzeichen-Anmeldung am Packet-Modem abgelehnt")
            digis = [d.strip().upper() for d in via.replace(",", " ").split() if d.strip()]
            if digis:
                dv = bytes([len(digis)]) + b"".join(d.encode()[:10].ljust(10, b"\0") for d in digis)
                self.w.write(_agw(b"v", self.rport, 0xF0, self.mycall, self.target, dv))
            else:
                self.w.write(_agw(b"C", self.rport, 0xF0, self.mycall, self.target))
            await self.w.drain()
            while True:
                kind, data = await asyncio.wait_for(self.events.get(), timeout)
                if kind == "C":
                    self.remote = self.target
                    return self
                if kind == "d":
                    raise LinkError(f"{self.target} antwortet nicht (Packet)")
        except BaseException:
            await self._shutdown()
            raise

    async def write(self, data: bytes):
        for i in range(0, len(data), self.PACLEN):
            while self.outstanding > 8 and self.connected:
                await asyncio.sleep(0.5)
                await self._query()
            self.w.write(_agw(b"D", self.rport, 0xF0, self.mycall, self.target, data[i:i + self.PACLEN]))
            self.outstanding += 1
        await self.w.drain()

    async def _query(self):
        self.w.write(_agw(b"Y", self.rport, 0, self.mycall, self.target))
        await self.w.drain()
        await asyncio.sleep(0.2)

    async def close(self, timeout: float = 300):
        if self.connected:
            end = asyncio.get_running_loop().time() + timeout
            await self._query()
            while self.outstanding > 0 and self.connected and asyncio.get_running_loop().time() < end:
                await asyncio.sleep(1)
                await self._query()
            try:
                self.w.write(_agw(b"d", self.rport, 0, self.mycall, self.target))
                await self.w.drain()
                for _ in range(30):
                    if not self.connected:
                        break
                    await asyncio.sleep(1)
            except Exception:
                pass
        await self._shutdown()

    async def abort(self):
        try:
            self.w.write(_agw(b"d", self.rport, 0, self.mycall, self.target))
        except Exception:
            pass
        await self._shutdown()

    async def _shutdown(self):
        for t in self.tasks:
            t.cancel()
        try:
            self.w.close()
        except Exception:
            pass


async def _maybe(x):
    if asyncio.iscoroutine(x):
        await x
