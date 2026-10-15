"""B2F-Nachrichtenaustausch (FBB komprimiert, Version 2) als anrufende Station.

Ablauf: Anmeldung der Gegenstelle lesen (SID, ;PQ-Anfrage, Prompt '>'), eigene Anmeldung senden (;FW, SID, ;PR),
dann abwechselnd eigene Vorschlaege (FC ...) senden und fremde annehmen, bis beide Seiten nichts mehr haben (FF/FQ).
"""
import asyncio
import hashlib
import logging
import re

from . import lzhuf
from .message import Message

log = logging.getLogger("ww.winlink")

# Salz fuer die Winlink-Passwortabfrage (oeffentlich, u. a. paclink-unix, wl2k-go)
SALT = bytes([77, 197, 101, 206, 190, 249, 93, 200, 51, 243, 93, 237, 71, 94, 239, 138, 68, 108, 70, 185, 225, 137, 217, 16,
              51, 122, 193, 48, 194, 195, 198, 175, 172, 169, 70, 84, 61, 62, 104, 186, 114, 52, 61, 168, 66, 129, 192, 208,
              187, 249, 232, 193, 41, 113, 41, 45, 240, 16, 29, 228, 208, 228, 61, 20])
SOH, STX, EOT = 1, 2, 4
BLOCK = 125           # Nutzdaten je STX-Block
MAX_PROPS = 5


class B2FError(RuntimeError):
    pass


def secure_response(challenge: str, password: str) -> str:
    s = hashlib.md5(challenge.encode("latin-1") + password.encode("latin-1") + SALT).digest()
    pr = ((s[3] & 0x3F) << 24) | (s[2] << 16) | (s[1] << 8) | s[0]
    return f"{pr:08d}"[-8:]


class Proposal:
    def __init__(self, mid: str, title: str, size: int, csize: int, data: bytes = b"", code: str = "C"):
        self.mid, self.title, self.size, self.csize, self.data, self.code = mid, title, size, csize, data, code
        self.answer, self.offset = "", 0

    def line(self) -> str:
        return f"F{self.code} EM {self.mid} {self.size} {self.csize} 0"


def _cksum(lines: list[str]) -> int:
    return (-sum(sum(l.encode("latin-1")) + 13 for l in lines)) & 0xFF


class Session:
    """mycall/target: Rufzeichen; password: Winlink-Passwort (fuer ;PQ); outbox: Liste von Message;
    on_received(msg) wird je empfangener Nachricht aufgerufen; on_sent(mid) je gesendeter/abgelehnter."""

    def __init__(self, reader: asyncio.StreamReader, write, mycall: str, target: str, password: str = "", locator: str = "",
                 outbox: list[Message] | None = None, on_received=None, on_sent=None, status=None, ua=("Wellenwerk", "1.1"),
                 timeout: float = 120):
        self.rd, self._write = reader, write
        self.mycall, self.target, self.password, self.locator = mycall.upper(), target.upper(), password, locator
        self.outbox = list(outbox or [])
        self.on_received, self.on_sent = on_received, on_sent
        self.status = status or (lambda s: None)
        self.ua, self.timeout = ua, timeout
        self.remote_sid = ""
        self.remote_no_msgs = False
        self.received, self.sent = [], []

    async def _send(self, data: bytes | str):
        if isinstance(data, str):
            data = data.encode("latin-1")
        r = self._write(data)
        if asyncio.iscoroutine(r):
            await r

    async def _line(self) -> str:
        while True:
            raw = await asyncio.wait_for(self.rd.readuntil(b"\r"), self.timeout)
            line = raw.decode("latin-1").strip("\r\n ")
            if not line:
                continue
            log.debug("<< %s", line)
            if line.startswith("***"):
                msg = line.strip("* ")
                if re.search(r"error|fail|denied|invalid|not|unable", msg, re.I) and "MTD Stats" not in line:
                    raise B2FError(f"Gegenstelle: {msg}")
                self.status(msg)
                continue
            return line

    async def run(self) -> dict:
        await self._handshake()
        my_turn = True
        quit_ = False
        while not quit_:
            quit_ = await (self._outbound() if my_turn else self._inbound())
            my_turn = not my_turn
        return dict(received=self.received, sent=self.sent)

    async def _handshake(self):
        challenge = ""
        while True:
            line = await self._line()
            self.status(line)
            if line.startswith("[") and line.endswith("]"):
                m = re.match(r"\[.*-(.*)\]", line)
                self.remote_sid = (m.group(1) if m else "").upper()
                if "B2" not in self.remote_sid:
                    raise B2FError("Gegenstelle beherrscht das B2F-Protokoll nicht")
            elif line.startswith(";PQ"):
                challenge = line[5:].strip()
            elif line.endswith(">"):
                break
        if not self.remote_sid:
            raise B2FError("keine Protokollkennung (SID) von der Gegenstelle")
        out = f";FW: {self.mycall}\r[{self.ua[0]}-{self.ua[1]}-B2FHM$]\r"
        if challenge:
            if not self.password:
                raise B2FError("Gegenstelle verlangt das Winlink-Passwort")
            out += f";PR: {secure_response(challenge, self.password)}\r"
        out += f"; {self.target} DE {self.mycall} ({self.locator})\r"
        await self._send(out)

    def _proposals(self) -> list[Proposal]:
        props = []
        for m in self.outbox:
            if m.validate():
                continue
            raw = m.to_bytes()
            c = lzhuf.compress(raw)
            props.append(Proposal(m.mid, m.subject, len(raw), len(c), c))
        props.sort(key=lambda p: (p.csize, p.mid))
        return props[:MAX_PROPS]

    async def _outbound(self) -> bool:
        props = self._proposals()
        if not props:
            await self._send("FQ\r" if self.remote_no_msgs else "FF\r")
            return self.remote_no_msgs
        lines = [p.line() for p in props]
        await self._send("".join(l + "\r" for l in lines) + f"F> {_cksum(lines):02X}\r")
        while True:
            line = await self._line()
            if line.startswith("FS "):
                break
            if line.startswith(";"):
                continue
            raise B2FError(f"Antwort auf Vorschläge erwartet, erhalten: {line}")
        ans = line[3:].strip()
        i = 0
        for p in props:
            if not ans:
                raise B2FError("zu wenige Antworten auf Vorschläge")
            c, ans = ans[0], ans[1:]
            if c in "Yy+":
                p.answer = "Y"
            elif c in "NnRr-":
                p.answer = "N"
            elif c in "LlHh=":
                p.answer = "L"
            elif c in "Aa!":
                m = re.match(r"(\d+)", ans)
                p.answer, p.offset = "Y", int(m.group(1)) if m else 0
                ans = ans[len(m.group(1)) if m else 0:]
                if p.offset > 999999:
                    p.offset = 0
            else:
                raise B2FError(f"unbekannte Antwort '{c}' auf Vorschlag")
            i += 1
        for p in props:
            if p.answer == "Y":
                self.status(f"sende {p.mid} ({p.csize} Bytes)")
                await self._send_block(p)
                self.sent.append(p.mid)
                self.outbox = [m for m in self.outbox if m.mid != p.mid]
                if self.on_sent:
                    self.on_sent(p.mid, True)
            elif p.answer == "N":            # Gegenstelle hat sie schon
                self.outbox = [m for m in self.outbox if m.mid != p.mid]
                if self.on_sent:
                    self.on_sent(p.mid, False)
            else:                            # zurueckgestellt
                self.outbox = [m for m in self.outbox if m.mid != p.mid]
        return False

    async def _send_block(self, p: Proposal):
        title = p.title.encode("latin-1", "replace")[:80] or b"-"
        off = str(p.offset).encode()
        buf = bytearray([SOH, len(title) + len(off) + 2]) + title + b"\0" + off + b"\0"
        data = p.data[p.offset:]
        ck = 0
        for i in range(0, len(data), BLOCK):
            chunk = data[i:i + BLOCK]
            buf += bytes([STX, len(chunk)]) + chunk
            ck += sum(chunk)
        buf += bytes([EOT, (-ck) & 0xFF])
        await self._send(bytes(buf))

    async def _inbound(self) -> bool:
        props, ck = [], 0
        while True:
            line = await self._line()
            if line.startswith(";"):
                continue
            if line[:2] in ("FA", "FB", "FC", "FD"):
                ck += sum(line.encode("latin-1")) + 13
                parts = line.split()
                if len(parts) < 5:
                    raise B2FError(f"Vorschlag unlesbar: {line}")
                props.append(Proposal(parts[2], "", int(parts[3]), int(parts[4]), code=line[1]))
            elif line.startswith("FF"):
                self.remote_no_msgs = True
                return False
            elif line.startswith("FQ"):
                return True
            elif line.startswith("F>"):
                theirs = int(line[2:].strip() or "0", 16)
                if theirs != (-ck) & 0xFF:
                    raise B2FError("Prüfsumme der Vorschläge falsch")
                if not props:
                    self.remote_no_msgs = True
                    return False
                self.remote_no_msgs = False
                seen = set()
                for p in props:
                    p.answer = "+" if p.code == "C" and p.mid not in seen else "="
                    seen.add(p.mid)
                await self._send("FS " + "".join(p.answer for p in props) + "\r")
                break
            else:
                raise B2FError(f"unerwartete Protokollzeile: {line}")
        for p in props:
            if p.answer != "+":
                continue
            self.status(f"empfange {p.mid} ({p.csize} Bytes)")
            data = await self._recv_block(p)
            msg = Message.from_bytes(lzhuf.decompress(data))
            self.received.append(msg.mid or p.mid)
            if self.on_received:
                self.on_received(msg)
        return False

    async def _recv_block(self, p: Proposal) -> bytes:
        rd = self.rd
        b = await asyncio.wait_for(rd.readexactly(1), self.timeout)
        while b in (b"\r", b"\n"):
            b = await asyncio.wait_for(rd.readexactly(1), self.timeout)
        if b == b"*":
            raise B2FError("Gegenstelle: " + (await self._line()).strip("* "))
        if b[0] != SOH:
            raise B2FError(f"Blockanfang erwartet, erhalten Byte {b[0]}")
        hl = (await rd.readexactly(1))[0]
        hdr = await rd.readexactly(hl)
        title, _, rest = hdr.partition(b"\0")
        off = int(rest.split(b"\0")[0] or b"0")
        p.title = title.decode("latin-1")
        if off != 0:
            raise B2FError("Fortsetzung mit Versatz nicht angefordert")
        buf, ck = bytearray(), 0
        while True:
            t = (await asyncio.wait_for(rd.readexactly(1), self.timeout))[0]
            if t == STX:
                n = (await rd.readexactly(1))[0] or 256
                chunk = await asyncio.wait_for(rd.readexactly(n), self.timeout)
                buf += chunk
                ck += sum(chunk)
            elif t == EOT:
                ck += (await rd.readexactly(1))[0]
                if ck & 0xFF:
                    raise B2FError("Prüfsumme der Nachricht falsch")
                if len(buf) != p.csize:
                    raise B2FError("Länge der Nachricht stimmt nicht")
                return bytes(buf)
            else:
                raise B2FError(f"unerwartetes Byte {t} in Nachricht")
