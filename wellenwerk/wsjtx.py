"""WSJT-X / JTDX UDP-Schnittstelle: geloggte QSOs (12) uebernehmen, Status (1) und Decodes (2) lesen,
Antworten (4), Senden stoppen (8) und Freitext (9) an WSJT-X schicken."""
import asyncio
import logging
import struct

log = logging.getLogger("ww.wsjtx")
MAGIC = 0xADBCCBDA


def _utf8(buf: bytes, i: int) -> tuple[str | None, int]:
    (n,) = struct.unpack_from(">I", buf, i)
    i += 4
    if n == 0xFFFFFFFF:
        return None, i
    return buf[i:i + n].decode("utf-8", "replace"), i + n


def parse(buf: bytes) -> tuple[int, str, dict]:
    magic, schema, mtype = struct.unpack_from(">III", buf, 0)
    if magic != MAGIC:
        raise ValueError("kein WSJT-X-Paket")
    ident, i = _utf8(buf, 12)
    data = {}
    if mtype == 12:
        data["adif"], _ = _utf8(buf, i)
    elif mtype == 1:  # Status
        (dial,) = struct.unpack_from(">Q", buf, i)
        mode, i2 = _utf8(buf, i + 8)
        dxcall, i3 = _utf8(buf, i2)
        data.update(dial=dial, mode=mode, dxcall=dxcall or "")
    elif mtype == 2:  # Decode: new, time(ms), snr, dt, df, mode, message
        new = buf[i] != 0
        t_ms, snr = struct.unpack_from(">Ii", buf, i + 1)
        (dt,) = struct.unpack_from(">d", buf, i + 9)
        (df,) = struct.unpack_from(">I", buf, i + 17)
        mode, j = _utf8(buf, i + 21)
        msg, j = _utf8(buf, j)
        low = len(buf) > j and buf[j] != 0
        data.update(new=new, time=t_ms, snr=snr, dt=round(dt, 1), df=df, mode=mode, message=(msg or "").strip(),
                    raw=dict(time=t_ms, snr=snr, dt=dt, df=df, mode=mode or "", message=msg or "", low=low))
    return mtype, ident or "", data


def _s(x: str) -> bytes:
    b = x.encode("utf-8")
    return struct.pack(">I", len(b)) + b


def _head(mtype: int, ident: str) -> bytes:
    return struct.pack(">III", MAGIC, 2, mtype) + _s(ident)


def reply_packet(ident: str, d: dict, modifiers: int = 0) -> bytes:
    """Nachricht 4 'Reply': wie Doppelklick auf eine Decode-Zeile in WSJT-X."""
    return (_head(4, ident) + struct.pack(">Ii", d["time"], d["snr"]) + struct.pack(">d", d["dt"])
            + struct.pack(">I", d["df"]) + _s(d["mode"]) + _s(d["message"]) + bytes([1 if d.get("low") else 0, modifiers]))


def halt_packet(ident: str, auto_only: bool = False) -> bytes:
    return _head(8, ident) + bytes([1 if auto_only else 0])


def free_text_packet(ident: str, text: str, send: bool = False) -> bytes:
    return _head(9, ident) + _s(text) + bytes([1 if send else 0])


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, on_adif, on_status, on_decode=None):
        self.on_adif, self.on_status, self.on_decode = on_adif, on_status, on_decode
        self.peers: dict[str, tuple] = {}      # ident -> Absenderadresse (dorthin gehen Antworten)
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def send(self, ident: str, packet: bytes):
        addr = self.peers.get(ident) or (next(iter(self.peers.values())) if self.peers else None)
        if not addr:
            raise ConnectionError("WSJT-X hat noch nichts gesendet (UDP-Server in WSJT-X auf diesen Rechner stellen)")
        self.transport.sendto(packet, addr)

    def datagram_received(self, buf, addr):
        if FORWARD["spec"]:          # unveraendert an weitere Programme weiterreichen
            from . import links
            links.send_raw(buf, FORWARD["spec"])
        try:
            mtype, ident, data = parse(buf)
        except Exception:
            return
        self.peers[ident] = addr
        if mtype == 12 and data.get("adif"):
            asyncio.ensure_future(self.on_adif(data["adif"], ident))
        elif mtype == 1:
            asyncio.ensure_future(self.on_status(ident, data))
        elif mtype == 2 and self.on_decode and data.get("message"):
            asyncio.ensure_future(self.on_decode(ident, data))


async def listen(port: int, on_adif, on_status, on_decode=None):
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(lambda: _Proto(on_adif, on_status, on_decode),
                                                           local_addr=("0.0.0.0", port))
    log.info("WSJT-X UDP auf Port %d", port)
    global PROTO
    PROTO = proto
    return transport


PROTO: _Proto | None = None
FORWARD = {"spec": ""}


def send(ident: str, packet: bytes):
    if not PROTO:
        raise ConnectionError("WSJT-X-Schnittstelle nicht aktiv (UDP-Port belegt?)")
    PROTO.send(ident, packet)
