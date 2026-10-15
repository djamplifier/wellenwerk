"""Anbindung anderer Programme: QSO-Weiterleitung per UDP, Weiterleitung der WSJT-X-Pakete, Empfang von N1MM Logger+.

- QSO-Weiterleitung: jedes neue QSO als ADIF-Text, als WSJT-X-Nachricht 12 ("Logged ADIF") oder als N1MM-<contactinfo> an Ziele host:port.
- WSJT-X-Weiterleitung: eingehende WSJT-X/JTDX-UDP-Pakete unveraendert an weitere Programme (z. B. GridTracker, JTAlert).
- N1MM Logger+: empfaengt <contactinfo>/<contactreplace>/<contactdelete> (Standard-Port 12060) und uebernimmt QSOs ins Logbuch."""
import asyncio
import logging
import socket
import struct
import xml.etree.ElementTree as ET

log = logging.getLogger("ww.links")
_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def targets(spec: str) -> list[tuple[str, int]]:
    out = []
    for part in (spec or "").replace(";", ",").split(","):
        part = part.strip()
        if ":" in part:
            h, p = part.rsplit(":", 1)
            try:
                out.append((h.strip() or "127.0.0.1", int(p)))
            except ValueError:
                pass
    return out


def send_raw(data: bytes, spec: str):
    for t in targets(spec):
        try:
            _sock.sendto(data, t)
        except OSError as e:
            log.warning("Weiterleitung an %s:%s: %s", t[0], t[1], e)


def adif_record(q: dict) -> str:
    skip = {"id", "extra", "created"}
    return " ".join(f"<{k.upper()}:{len(str(v))}>{v}" for k, v in q.items() if k not in skip and v not in (None, "")) + " <EOR>"


def wsjtx_logged_adif(q: dict, ident: str = "Wellenwerk") -> bytes:
    def s(x: str) -> bytes:
        b = x.encode()
        return struct.pack(">I", len(b)) + b
    text = "<adif_ver:5>3.1.4<programid:10>Wellenwerk<EOH>\n" + adif_record(q)
    return struct.pack(">III", 0xADBCCBDA, 2, 12) + s(ident) + s(text)


def n1mm_contactinfo(q: dict) -> bytes:
    def mhz10(v):      # N1MM: Frequenz in 10-Hz-Schritten
        try:
            return str(int(round(float(v) * 1e5)))
        except (TypeError, ValueError):
            return ""
    d, t = q.get("qso_date", ""), (q.get("time_on") or "000000").ljust(6, "0")
    root = ET.Element("contactinfo")
    for k, v in (("app", "Wellenwerk"), ("contestname", q.get("contest_id") or "DXLOG"), ("timestamp", f"{d[:4]}-{d[4:6]}-{d[6:8]} {t[:2]}:{t[2:4]}:{t[4:6]}"),
                 ("mycall", q.get("station_callsign", "")), ("band", (q.get("band") or "").replace("m", "")), ("rxfreq", mhz10(q.get("freq"))),
                 ("txfreq", mhz10(q.get("freq"))), ("operator", q.get("operator", "")), ("mode", q.get("mode", "")), ("call", q.get("call", "")),
                 ("snt", q.get("rst_sent", "")), ("rcv", q.get("rst_rcvd", "")), ("gridsquare", q.get("gridsquare", "")), ("name", q.get("name", "")),
                 ("comment", q.get("comment", "")), ("power", q.get("tx_pwr", ""))):
        ET.SubElement(root, k).text = str(v or "")
    return b'<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root)


def forward_qso(q: dict, spec: str, fmt: str):
    if not targets(spec):
        return
    data = wsjtx_logged_adif(q) if fmt == "wsjtx" else n1mm_contactinfo(q) if fmt == "n1mm" else adif_record(q).encode()
    send_raw(data, spec)


# ---------- N1MM Logger+ empfangen ----------
def parse_n1mm(data: bytes) -> tuple[str, dict] | None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None
    if root.tag not in ("contactinfo", "contactreplace", "contactdelete"):
        return None
    g = lambda k: (root.findtext(k) or "").strip()
    ts = g("timestamp")      # 2026-10-15 12:34:56
    try:
        f = int(g("rxfreq") or g("txfreq") or 0) / 1e5   # 10-Hz-Schritte -> MHz
    except ValueError:
        f = 0
    band = g("band")
    rec = {"call": g("call").upper(), "qso_date": ts[:10].replace("-", ""), "time_on": ts[11:19].replace(":", ""), "mode": g("mode").upper(),
           "freq": f"{f:.5f}".rstrip("0").rstrip(".") if f else "", "rst_sent": g("snt"), "rst_rcvd": g("rcv"), "gridsquare": g("gridsquare"),
           "name": g("name"), "comment": g("comment"), "station_callsign": g("mycall").upper(), "operator": g("operator").upper(),
           "contest_id": g("contestname"), "stx_string": g("sntnr"), "srx_string": g("rcvnr"), "tx_pwr": g("power")}
    if band and not f:
        rec["band"] = band if band.endswith("m") or band.endswith("cm") else f"{band}m"
    rec = {k: v for k, v in rec.items() if v}
    return root.tag, rec


class _N1mmProto(asyncio.DatagramProtocol):
    def __init__(self, cb):
        self.cb = cb

    def datagram_received(self, data, addr):
        r = parse_n1mm(data)
        if r and r[1].get("call"):
            asyncio.ensure_future(self.cb(*r))


async def listen_n1mm(port: int, cb):
    tr, _ = await asyncio.get_running_loop().create_datagram_endpoint(lambda: _N1mmProto(cb), local_addr=("0.0.0.0", port))
    log.info("N1MM-Empfang auf UDP %d", port)
    return tr
