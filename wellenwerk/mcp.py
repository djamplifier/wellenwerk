"""MCP-Server fuer Wellenwerk (Model Context Protocol, stdio): KI-Assistenten wie Claude koennen die Station
abfragen und – soweit erlaubt – bedienen. Spricht die REST-API eines laufenden Wellenwerk an.

Start:  Wellenwerk --mcp [--url http://127.0.0.1:8090] [--token API-SCHLUESSEL]
        (oder python -m wellenwerk --mcp). Umgebungsvariablen: WW_URL, WW_TOKEN.
Senden (PTT, CW, Winlink ueber Funk) geht nur, wenn in Wellenwerk unter Programmoptionen → Zugang & API erlaubt."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL = "2025-06-18"


class Api:
    def __init__(self, url: str, token: str = ""):
        self.url, self.token = url.rstrip("/"), token

    def call(self, method: str, path: str, body=None, query: dict | None = None):
        u = self.url + path + ("?" + urllib.parse.urlencode({k: v for k, v in query.items() if v not in (None, "")}) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(u, data=data, method=method, headers={"Content-Type": "application/json", "X-WW-Client": "mcp",
                                                                            **({"Authorization": "Bearer " + self.token} if self.token else {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("detail")
            except Exception:
                detail = e.reason
            raise RuntimeError(f"Wellenwerk: {detail} (HTTP {e.code})")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Wellenwerk nicht erreichbar unter {self.url} ({e.reason}) – läuft das Programm?")


def _s(props: dict, req: list | None = None) -> dict:
    return {"type": "object", "properties": props, "required": req or []}


STR, NUM, INT, BOOL = {"type": "string"}, {"type": "number"}, {"type": "integer"}, {"type": "boolean"}


def _rig_view(st):
    r = st.get("rig", {})
    return {k: r.get(k) for k in ("connected", "freq", "band", "mode", "passband", "ptt", "split", "vfob_freq", "rit", "xit", "meters", "error")}


TOOLS = [
    ("station_info", "Stationsdaten: Rufzeichen, Locator, Position, Operator, Leistung, aktives Stationsprofil.", _s({}),
     lambda a, x: a.call("GET", "/api/station")),
    ("rig_status", "Aktueller Zustand des gewählten Funkgeräts (Frequenz in Hz, Band, Betriebsart, PTT, Split, Messwerte).", _s({}),
     lambda a, x: _rig_view(a.call("GET", "/api/state"))),
    ("list_radios", "Eingerichtete Funkgeräte mit Verbindungsstatus.", _s({}),
     lambda a, x: [{k: r.get(k) for k in ("id", "name", "mfg", "model_name", "connected", "current")} for r in a.call("GET", "/api/radios")["radios"]]),
    ("select_radio", "Anderes (verbundenes) Funkgerät als aktuelles wählen.", _s({"id": STR}, ["id"]),
     lambda a, x: a.call("POST", f"/api/radios/{urllib.parse.quote(x['id'])}/select", {})),
    ("set_frequency", "Funkgerät abstimmen. Frequenz in kHz (z. B. 14074 oder 7030.5).", _s({"khz": NUM}, ["khz"]),
     lambda a, x: a.call("POST", "/api/rig/freq", {"hz": int(round(float(x["khz"]) * 1000))})),
    ("set_mode", "Betriebsart setzen (USB, LSB, CW, CWR, AM, FM, RTTY, PKTUSB, PKTLSB …), optional Bandbreite in Hz.",
     _s({"mode": STR, "passband_hz": INT}, ["mode"]),
     lambda a, x: a.call("POST", "/api/rig/mode", {"mode": x["mode"].upper(), "passband": int(x.get("passband_hz") or 0)})),
    ("transmit", "Sender ein- oder ausschalten (PTT). Nur wenn in Wellenwerk für Assistenten freigegeben.", _s({"on": BOOL}, ["on"]),
     lambda a, x: a.call("POST", "/api/rig/ptt", {"on": bool(x["on"])})),
    ("send_cw", "Text in CW senden (über das Funkgerät oder den WinKeyer). Nur wenn freigegeben.", _s({"text": STR}, ["text"]),
     lambda a, x: a.call("POST", "/api/rig/morse", {"text": x["text"]})),
    ("lookup_callsign", "Rufzeichen nachschlagen: Land, Zonen, Entfernung/Richtung, schon gearbeitet?", _s({"call": STR, "band": STR, "mode": STR}, ["call"]),
     lambda a, x: a.call("GET", "/api/lookup/" + urllib.parse.quote(x["call"].upper()), query={"band": x.get("band"), "mode": x.get("mode")})),
    ("search_log", "Logbuch durchsuchen. query = Text (Rufzeichen, Land, Name …); condition = Feldbedingungen wie 'band=20m; cqz=14; iota nicht leer'.",
     _s({"query": STR, "band": STR, "mode": STR, "condition": STR, "date_from": STR, "date_to": STR, "limit": INT}),
     lambda a, x: a.call("GET", "/api/qso", query={"q": x.get("query"), "band": x.get("band"), "mode": x.get("mode"), "cond": x.get("condition"),
                                                   "date_from": x.get("date_from"), "date_to": x.get("date_to"), "limit": x.get("limit") or 50})),
    ("log_qso", "QSO ins aktuelle Logbuch eintragen. Fehlende Angaben (Datum/Zeit = jetzt, Band aus Frequenz, Land) ergänzt Wellenwerk.",
     _s({"call": STR, "freq_mhz": NUM, "band": STR, "mode": STR, "rst_sent": STR, "rst_rcvd": STR, "name": STR, "qth": STR,
         "gridsquare": STR, "comment": STR, "qso_date": {"type": "string", "description": "JJJJMMTT"}, "time_on": {"type": "string", "description": "HHMM UTC"}}, ["call"]),
     lambda a, x: a.call("POST", "/api/qso", {**{k: v for k, v in x.items() if k != "freq_mhz" and v not in (None, "")},
                                              **({"freq": str(x["freq_mhz"])} if x.get("freq_mhz") else {})})),
    ("dx_spots", "Aktuelle DX-Cluster-Spots (neueste zuerst) mit Status neues Land/Band.", _s({"band": STR, "limit": INT}),
     lambda a, x: [s for s in a.call("GET", "/api/spots") if not x.get("band") or s.get("band") == x["band"]][: int(x.get("limit") or 30)]),
    ("rotor_status", "Zustand des Rotors (Azimut, Elevation, Ziel).", _s({}), lambda a, x: a.call("GET", "/api/state").get("rotor")),
    ("rotate_antenna", "Antenne auf Azimut drehen (Grad, 0 = Nord).", _s({"azimuth": NUM, "elevation": NUM}, ["azimuth"]),
     lambda a, x: a.call("POST", "/api/rotor/set", {"az": x["azimuth"], "el": x.get("elevation")})),
    ("winlink_messages", "Winlink-Nachrichten eines Ordners auflisten (in, out, sent, archive).", _s({"folder": STR}),
     lambda a, x: a.call("GET", "/api/winlink/folder/" + (x.get("folder") or "in"))),
    ("winlink_read", "Eine Winlink-Nachricht lesen.", _s({"folder": STR, "mid": STR}, ["mid"]),
     lambda a, x: a.call("GET", f"/api/winlink/msg/{x.get('folder') or 'in'}/{x['mid']}")),
    ("winlink_compose", "Winlink-Nachricht in den Ausgang legen (gesendet wird bei der nächsten Verbindung).",
     _s({"to": STR, "cc": STR, "subject": STR, "text": STR}, ["to", "subject", "text"]),
     lambda a, x: a.call("POST", "/api/winlink/compose", {k: x.get(k, "") for k in ("to", "cc", "subject", "text")})),
    ("winlink_connect", "Winlink-Verbindung starten: method telnet|ardop|vara|packet, target = Gegenstation, freq_khz optional. Über Funk nur wenn freigegeben.",
     _s({"method": STR, "target": STR, "freq_khz": NUM}, ["method"]),
     lambda a, x: a.call("POST", "/api/winlink/connect", {"method": x["method"], "target": x.get("target", ""), **({"freq": x["freq_khz"]} if x.get("freq_khz") else {})})),
]
TOOL_MAP = {t[0]: t for t in TOOLS}


def handle(api: Api, msg: dict):
    mid, method, p = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": p.get("protocolVersion") or PROTOCOL, "capabilities": {"tools": {}},
                "serverInfo": {"name": "wellenwerk", "version": _version(api)},
                "instructions": "Steuert eine Amateurfunkstation (Wellenwerk). Frequenzen in kHz angeben. Senden nur auf ausdrücklichen Wunsch "
                                "und nur, wenn die Station es erlaubt; Amateurfunkvorschriften beachten."}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{"name": n, "description": d, "inputSchema": s} for n, d, s, _ in TOOLS]}
    if method == "tools/call":
        t = TOOL_MAP.get(p.get("name"))
        if not t:
            raise LookupError(f"Unbekanntes Werkzeug {p.get('name')}")
        try:
            res = t[3](api, p.get("arguments") or {})
            return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=1)}]}
        except (RuntimeError, KeyError, ValueError) as e:
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    if mid is None:
        return None                          # Benachrichtigung (z. B. notifications/initialized)
    raise LookupError(f"Methode nicht unterstützt: {method}")


def _version(api: Api) -> str:
    try:
        return str(api.call("GET", "/api/state").get("version", "?"))
    except Exception:
        return "?"


def serve(url: str, token: str):
    api = Api(url, token)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            res = handle(api, msg)
            if msg.get("id") is None:
                continue
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": res}
        except LookupError as e:
            out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": str(e)}}
        except Exception as e:
            out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": str(e)}}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="wellenwerk --mcp")
    ap.add_argument("--url", default=os.environ.get("WW_URL", "http://127.0.0.1:8090"))
    ap.add_argument("--token", default=os.environ.get("WW_TOKEN", ""))
    a, _ = ap.parse_known_args(argv)
    serve(a.url, a.token)
