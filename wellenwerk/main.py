"""Wellenwerk - Webserver: Rig Control, Logbuch, DX-Cluster, WSJT-X, Karte."""
import asyncio
import collections
import itertools
import json
import re
import subprocess
import time
import logging
import os
import shutil
import struct
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import adif, awards, extras, geo, sats, services
import contextvars
from .bands import BANDS, band_for, default_rst
from .cluster import Cluster
from .cty import Cty
from .logbook import Logbook, FIELDS as QSO_FIELDS, INT_FIELDS as QSO_INTS
from .rig import POLL, Rig, RigError
from .rotor import Rotor, RotorError
from . import radios as radmod
from . import winkey as wkmod
from . import links
from . import programs
from . import wsjtx
from .winlink.client import Winlink
from .catemu import CatEmu
from .chat import Chat
from .access import Access, AccessMiddleware, COOKIE, LOGIN_HTML
from .plugins import PluginHost, PluginError
from .winlink.message import Message as WlMessage

VERSION = "1.2.1"
BASE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("WW_DATA", BASE / "data"))
DATA.mkdir(parents=True, exist_ok=True)
CFG_PATH = DATA / "config.json"
DEFAULTS = dict(callsign="", locator="", operator="", tx_pwr="100", lang="",
                cluster_host="dxc.ve7cc.net", cluster_port=23, cluster_cmds="",
                wsjtx_port=2237,
                rot_enabled=False, rot_host="127.0.0.1", rot_port=4533, rot_park=0,
                rot_model=0, rot_device="", rot_speed="", rot_offset=0, rot_stop="north", rot_min_az="", rot_max_az="", rot_log=False,
                rig_poll_ms=250, rig_dualvfo=False, mode_rst="",
                cw_out="rig", winkey_device="", winkey_wpm=22,
                fwd_targets="", fwd_format="adif", wsjtx_forward="", n1mm_port=0, adif_udp_port=0, backup_dir="", backup_keep=30,
                # Online-Dienste
                hamqth_user="", hamqth_pass="", qrz_user="", qrz_pass="", qrz_logbook_key="",
                eqsl_user="", eqsl_pass="", lotw_user="", lotw_pass="", lotw_location="Wellenwerk", lotw_cert_pass="",
                clublog_email="", clublog_pass="", clublog_api="",
                wl_call="", wl_password="", wl_telnet_host="server.winlink.org", wl_telnet_port=8772, wl_ptt="rig",
                ardop_host="127.0.0.1", ardop_port=8515, ardop_bw="2000MAX", vara_host="127.0.0.1", vara_port=8300, vara_bw="2300",
                agw_host="127.0.0.1", agw_port=8000, agw_radio_port=0, rtc_stun="",
                sync_on=False, sync_master="", sync_slave="", sync_offset=0, sync_mode=True,
                access_password="", api_token="", mcp_allow_tx=False, plugins={},
                catemu_on=False, catemu_kind="pty" if os.name != "nt" else "serial", catemu_port=4590, catemu_device="",
                callbook_auto=True, auto_qrz=False, auto_clublog=False, auto_eqsl=False, eqsl_counts=False)
SECRETS = ("access_password", "api_token", "wl_password", "hamqth_pass", "qrz_pass", "qrz_logbook_key", "eqsl_pass", "lotw_pass", "lotw_cert_pass", "clublog_pass", "clublog_api")
BOOLS = ("mcp_allow_tx", "catemu_on", "sync_on", "sync_mode", "rot_log", "callbook_auto", "auto_qrz", "auto_clublog", "auto_eqsl", "eqsl_counts", "rot_enabled", "rig_dualvfo")
MASK = "••••••"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("ww")


def load_cfg() -> dict:
    try:
        return {**DEFAULTS, **json.loads(CFG_PATH.read_text())}
    except Exception:
        return dict(DEFAULTS)


cfg = load_cfg()


def apply_links():
    wsjtx.FORWARD["spec"] = cfg.get("wsjtx_forward") or ""


def apply_poll():
    POLL["interval"] = min(max(int(cfg.get("rig_poll_ms") or 250), 100), 2000) / 1000
    POLL["dual"] = bool(cfg.get("rig_dualvfo"))


apply_poll()
apply_links()
cty = Cty(DATA)
logbooks = extras.Logbooks(DATA)
_LOG_CTX = contextvars.ContextVar("logbook", default="")


def current_logbook() -> str:
    names = logbooks.names()
    n = cfg.get("logbook") or ""
    return n if n in names else names[0]


class _BookProxy:
    """Logbuch der Anfrage (?log=Name) oder das aktuelle - mehrere Logbuecher als Register."""
    def __getattr__(self, name):
        n = _LOG_CTX.get() or current_logbook()
        try:
            return getattr(logbooks.get(n), name)
        except KeyError:
            raise HTTPException(404, f"Logbuch {n} nicht gefunden")


book = _BookProxy()
clients: set[WebSocket] = set()
wsjtx_state: dict = {}


async def broadcast(msg: dict):
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)
    host = globals().get("plugin_host")
    if host and host.hooks:
        await host.dispatch(msg)


def home() -> tuple[float, float] | None:
    return geo.grid_to_latlon(station_identity()["locator"])


def station_identity() -> dict:
    """Zentrale Stationsdaten fuer alle Programmteile, API, MCP und Plugins:
    Programmoptionen, ueberschrieben vom aktiven Stationsprofil (z. B. Portabelbetrieb)."""
    st = active_station() or {}
    call = (st.get("callsign") or cfg.get("callsign") or "").upper().strip()
    loc = (st.get("locator") or cfg.get("locator") or "").strip()
    ll = geo.grid_to_latlon(loc) if loc and geo.valid_grid(loc) else None
    return dict(callsign=call, home_callsign=(cfg.get("callsign") or "").upper(), operator=(st.get("operator") or cfg.get("operator") or "").upper(),
                locator=loc, lat=ll[0] if ll else None, lon=ll[1] if ll else None, tx_pwr=st.get("tx_pwr") or cfg.get("tx_pwr") or "",
                profile=st.get("name", ""), profile_id=st.get("id", ""), my_pota_ref=st.get("my_pota_ref", ""), my_sota_ref=st.get("my_sota_ref", ""),
                my_wwff_ref=st.get("my_wwff_ref", ""), winlink_call=(cfg.get("wl_call") or call).upper(),
                lang=cfg.get("lang") or "de")


async def identity_changed():
    await broadcast({"type": "station_identity", "station": station_identity()})


def describe(call: str, grid: str = "") -> dict:
    """Land, Zonen, Position, Entfernung/Richtung fuer ein Rufzeichen."""
    e = cty.lookup(call) or {}
    pos = geo.grid_to_latlon(grid) if geo.valid_grid(grid) else ((e["lat"], e["lon"]) if e else None)
    d = dict(country=e.get("country", ""), dxcc=e.get("dxcc"), cont=e.get("cont", ""), cqz=e.get("cqz"),
             ituz=e.get("ituz"), lat=pos[0] if pos else None, lon=pos[1] if pos else None,
             pos_from="grid" if geo.valid_grid(grid) else ("dxcc" if e else ""))
    h = home()
    if h and pos:
        d["km"], d["bearing"] = geo.distance_bearing(h, pos)
    return d


def _mg(mode: str) -> str:
    from .logbook import _mgroup
    return _mgroup(mode)


def enrich_spot(sp: dict, sets=None) -> dict:
    S = book.abm()
    info = describe(sp["call"])
    band = band_for(sp["freq"])
    mode = guess_mode(sp["freq"], sp.get("comment", ""))
    mg = _mg(mode)
    dx, cq, itu = info.get("dxcc"), info.get("cqz"), info.get("ituz")
    grid = (sp.get("spotted_grid") or "")[:4].upper()
    def abm(key, val):          # [gearbeitet ueberhaupt, auf dem Band, in der Modegruppe]
        if not val:
            return None
        return [val in S[key], (val, band) in S[key + "b"], (val, mg) in S[key + "m"]]
    status = ""
    if dx and dx not in S["dx"]:
        status = "new_dxcc"
    elif dx and band and (dx, band) not in S["dxb"]:
        status = "new_band"
    elif sp["call"] in S["call"]:
        status = "worked"
    return {**sp, **info, "band": band, "mode": mode, "mgroup": mg, "status": status,
            "logged": (sp["call"], band) in S["callb"], "b4": sp["call"] in S["call"],
            "abm": dict(country=abm("dx", dx), cqz=abm("cq", cq), ituz=abm("itu", itu), grid=abm("gr", grid))}


def guess_mode(hz: int, comment: str) -> str:
    c, khz = (comment or "").upper(), hz / 1000
    if "FT8" in c or "FT4" in c or any(abs(khz - f) <= 3 for f in (1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313)):
        return "FT8"
    if "RTTY" in c:
        return "RTTY"
    cw_end = {"160m": 1838, "80m": 3570, "40m": 7040, "30m": 10150, "20m": 14070, "17m": 18095, "15m": 21070, "12m": 24915, "10m": 28070, "6m": 50100}
    if " CW" in " " + c or "WPM" in c or khz < cw_end.get(band_for(hz), 0):
        return "CW"
    return "SSB"


def complete_qso(rec: dict) -> dict:
    """Fehlende Felder aus Rufzeichen, Frequenz und Einstellungen ergaenzen."""
    rec = {k.lower(): v for k, v in rec.items() if v not in (None, "")}
    if rec.get("freq") and not rec.get("band"):
        try:
            rec["band"] = band_for(float(rec["freq"]) * 1e6)
        except ValueError:
            pass
    info = describe(rec.get("call", ""), rec.get("gridsquare", ""))
    for k in ("country", "dxcc", "cont", "cqz", "ituz"):
        if not rec.get(k) and info.get(k):
            rec[k] = info[k]
    # POTA/WWFF/SOTA aus den allgemeinen SIG-Feldern uebernehmen (Import aus anderen Programmen) und umgekehrt
    for pre in ("", "my_"):
        sig, info = (rec.get(f"{pre}sig") or "").lower(), rec.get(f"{pre}sig_info")
        if sig in programs.PROGS and info and not rec.get(f"{pre}{sig}_ref"):
            rec[f"{pre}{sig}_ref"] = info.upper()
    # aktives Stationsprofil (Standort, Park/Gipfel), sonst Programmoptionen
    st = active_station()
    for key, src in (("station_callsign", "callsign"), ("operator", "operator"), ("my_gridsquare", "locator"),
                     ("my_pota_ref", "my_pota_ref"), ("my_sota_ref", "my_sota_ref"), ("my_wwff_ref", "my_wwff_ref"), ("tx_pwr", "tx_pwr")):
        v = (st.get(src) if st else None) or (cfg.get(src) if src in ("callsign", "operator", "locator") else None)
        if v and not rec.get(key):
            rec[key] = v.upper() if key in ("station_callsign", "operator") or key.startswith("my_") and key.endswith("_ref") else v
    return rec


# ---------- Stationsprofile (Standorte, Portabelbetrieb) ----------
STATIONS_PATH = DATA / "stations.json"


def load_stations() -> dict:
    try:
        return json.loads(STATIONS_PATH.read_text())
    except Exception:
        return {"active": "", "list": []}


def active_station() -> dict | None:
    s = load_stations()
    return next((x for x in s["list"] if x.get("id") == s.get("active")), None)


# ---------- Hintergrunddienste ----------
SYNC = {"last": None, "busy": False}


async def on_rig(radio_id, state):
    state["band"] = band_for(state.get("freq"))
    await broadcast({"type": "rig", "radio": radio_id, "current": radio_id == radios.current, "rig": state})
    if cfg.get("sync_on") and radio_id == cfg.get("sync_master") and state.get("connected") and state.get("freq"):
        want = (int(state["freq"]) + int(cfg.get("sync_offset") or 0), state.get("mode") if cfg.get("sync_mode") else None)
        if want != SYNC["last"] and not SYNC["busy"]:
            asyncio.create_task(_sync_slave(want))


async def _sync_slave(want):
    """Synchronisierung: zweites Geraet folgt Frequenz (+Versatz) und ggf. Betriebsart des ersten."""
    slave = radios.rig(cfg.get("sync_slave")) if cfg.get("sync_slave") != cfg.get("sync_master") else None
    if not slave or not slave.state.get("connected"):
        return
    SYNC["busy"] = True
    try:
        hz, mode = want
        if slave.state.get("freq") != hz:
            await slave.set_freq(hz)
        if mode and slave.state.get("mode") != mode:
            await slave.set_mode(mode)
        SYNC["last"] = want
    except Exception as e:
        log.warning("Synchronisierung: %s", e)
    finally:
        SYNC["busy"] = False


async def on_spot(sp):
    await broadcast({"type": "spot", "spot": enrich_spot(sp)})


async def on_cluster_status(st):
    await broadcast({"type": "cluster", "cluster": st})


async def enrich_callbook(r: dict) -> dict:
    """Leere Felder (Name, QTH, Bundesstaat ...) aus dem Callbook fuellen, falls eingerichtet."""
    if not cfg.get("callbook_auto"):
        return r
    try:
        cb = await asyncio.to_thread(callbook.lookup, cfg, r.get("call", ""))
    except Exception as e:
        log.info("Callbook %s: %s", r.get("call"), e)
        return r
    for k in ("name", "qth", "gridsquare", "state", "cnty", "iota", "email", "qsl_via"):
        if cb and cb.get(k) and not r.get(k):
            r[k] = cb[k]
    return r


async def on_wsjtx_adif(text: str, ident: str):
    for r in adif.parse(text):
        r = complete_qso(await enrich_callbook(r))
        if book.exists(r.get("call", ""), r.get("qso_date", ""), r.get("time_on", ""), r.get("band", "")):
            log.info("WSJT-X: %s schon im Log", r.get("call"))
            continue
        q = book.add(r)
        log.info("WSJT-X (%s): %s %s %s geloggt", ident, q["call"], q.get("band"), q.get("mode"))
        await broadcast({"type": "qso", "qso": q, "source": ident})
        auto_upload(q["id"])


async def on_wsjtx_status(ident: str, data: dict):
    wsjtx_state.update(ident=ident, last=datetime.now(timezone.utc).isoformat(), **data)
    await broadcast({"type": "wsjtx", "wsjtx": dict(wsjtx_state)})


class _NoRig:
    """Platzhalter, solange kein Funkgeraet verbunden ist."""
    state = dict(connected=False, freq=0, mode="", passband=0, ptt=False, error="Kein Funkgerät verbunden",
                 vfo="VFOA", vfob_freq=0, vfob_mode="", split=False, rit=0, xit=0, levels={}, funcs={}, meters={})
    caps: dict = {}

    def __getattr__(self, name):
        async def fail(*a, **k):
            raise RigError("Kein Funkgerät verbunden – Datei → Verbinden")
        return fail


class _RigProxy:
    """Leitet alle Funkgeraete-Befehle an das gerade gewaehlte Geraet weiter."""
    def __getattr__(self, name):
        return getattr(radios.rig() or _NO_RIG, name)


_NO_RIG = _NoRig()
async def on_spectrum(radio_id, line):
    await broadcast({"type": "spectrum", "radio": radio_id, **line})


AUDIO_SUBS: dict = {}          # Empfaenger-Ton: Radio-ID -> {websocket: Warteschlange}


def on_sdr_audio(radio_id, pcm: bytes, rate: int):
    """Jeder Block geht vollstaendig und in Reihenfolge an jede Verbindung (Empfaenger senden stossweise;
    Luecken wuerden Dekoder wie RTTY/CW aus dem Takt bringen). Nur bei echtem Rueckstau (> ~5 s) faellt Altes weg."""
    subs = AUDIO_SUBS.get(radio_id)
    if not subs:
        return
    frame = struct.pack("<I", rate) + pcm
    for q in list(subs.values()):
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(frame)


radios = radmod.RadioManager(DATA, on_rig, on_spectrum=on_spectrum, on_audio=on_sdr_audio)
if not radios.profiles:          # erster Start: Demo-Geraet zum Ausprobieren
    radios.upsert(dict(name="Demo-Funkgerät", model=1, mfg="Hamlib", model_name="Dummy", autoconnect=True))
rig = _RigProxy()


async def on_rotor(st):
    await broadcast({"type": "rotor", "rotor": st})


rotor = Rotor(cfg["rot_host"], int(cfg["rot_port"]), bool(cfg["rot_enabled"]), on_rotor)
ROTLOG = DATA / "rotor.log"


def apply_rotor_opts():
    rotor.configure(cfg.get("rot_offset") or 0, cfg.get("rot_stop") or "north", cfg.get("rot_min_az"), cfg.get("rot_max_az"),
                    ROTLOG if cfg.get("rot_log") else None)


apply_rotor_opts()
async def on_cluster_line(line, key):
    await broadcast({"type": "cluster_line", "line": line, "key": key})


cluster = Cluster(cfg["cluster_host"], int(cfg["cluster_port"]), cfg["callsign"], on_spot, on_cluster_status,
                  cfg.get("cluster_cmds", ""), on_cluster_line)
DECODES = collections.deque(maxlen=500)


async def on_wsjtx_decode(ident: str, d: dict):
    """FT8/FT4-Decodes: Rufzeichen herausziehen und mit Land/gearbeitet-Status anreichern."""
    words = d["message"].split()
    call = ""
    if words and words[0] == "CQ":
        rest = [w for w in words[1:] if not re.fullmatch(r"[A-Z]{2,4}|DX", w)]
        call = rest[0] if rest else ""
    elif len(words) >= 2:
        call = words[1]
    call = call.strip("<>")
    info = describe(call, words[-1] if words and geo.valid_grid(words[-1]) and len(words[-1]) == 4 else "") if call else {}
    dial = wsjtx_state.get("dial") or 0
    band = band_for(dial + d.get("df", 0))
    sets = book.worked_sets()
    dx = info.get("dxcc")
    status = "new_dxcc" if dx and dx not in sets[0] else "new_band" if dx and band and (dx, band) not in sets[1] else \
             "worked" if call in sets[2] else ""
    rec = dict(d, ident=ident, call=call, cq=bool(words and words[0] == "CQ"), band=band, freq=dial + d.get("df", 0),
               country=info.get("country", ""), cont=info.get("cont", ""), km=info.get("km"), status=status,
               utc=f"{d['time'] // 3600000:02d}{d['time'] // 60000 % 60:02d}{d['time'] // 1000 % 60:02d}")
    rec["id"] = next(_DEC_ID)
    rec.pop("raw", None)
    DECODES.appendleft(rec)
    _DEC_RAW[rec["id"]] = (ident, d.get("raw"))
    while len(_DEC_RAW) > 600:
        _DEC_RAW.pop(next(iter(_DEC_RAW)))
    await broadcast({"type": "decode", "decode": rec})


_DEC_ID = itertools.count(1)
_DEC_RAW: dict[int, tuple] = {}




@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(cty.load)
    await rotor_spawn()
    await radios.autoconnect()
    if cfg.get("cw_out") == "winkey" and cfg.get("winkey_device"):
        try:
            await winkey.connect(cfg["winkey_device"], int(cfg.get("winkey_wpm") or 22))
        except ConnectionError as e:
            log.warning("WinKeyer: %s", e)
    tasks = [asyncio.create_task(cluster.run_forever()), asyncio.create_task(rotor.run_forever()), asyncio.create_task(auto_backup_loop())]
    await restart_n1mm()
    await apply_catemu()
    plugin_host.load_backends(app)
    transport = None
    try:
        transport = await wsjtx.listen(int(cfg["wsjtx_port"]), on_wsjtx_adif, on_wsjtx_status, on_wsjtx_decode)
    except OSError as e:
        log.warning("WSJT-X UDP-Port nicht verfuegbar: %s", e)
    yield
    for t in tasks:
        t.cancel()
    await radios.stop_all()
    if ROTCTLD["proc"] and ROTCTLD["proc"].poll() is None:
        ROTCTLD["proc"].terminate()
    if transport:
        transport.close()


app = FastAPI(title="Wellenwerk", version=VERSION, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None,
              description="Schnittstelle von Wellenwerk – dieselbe, die auch die Oberfläche nutzt. Stationsdaten: `GET /api/station`, "
                          "Ereignisse in Echtzeit: WebSocket `/ws`. Von anderen Rechnern mit `Authorization: Bearer <API-Schlüssel>`.")
access = Access(DATA, cfg)


@app.post("/api/wsjtx/reply")
async def wsjtx_reply(body: dict):
    """Doppelklick auf einen Decode -> WSJT-X ruft diese Station (wie Doppelklick in WSJT-X)."""
    ident, raw = _DEC_RAW.get(int(body.get("id", 0)), (None, None))
    if not raw:
        raise HTTPException(404, "Decode nicht mehr vorhanden")
    try:
        wsjtx.send(ident, wsjtx.reply_packet(ident, raw, 0x02 if body.get("shift") else 0))
    except ConnectionError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.post("/api/wsjtx/halt")
async def wsjtx_halt(body: dict | None = None):
    try:
        wsjtx.send(wsjtx_state.get("ident", ""), wsjtx.halt_packet(wsjtx_state.get("ident", ""), bool((body or {}).get("auto_only"))))
    except ConnectionError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.post("/api/wsjtx/text")
async def wsjtx_text(body: dict):
    try:
        wsjtx.send(wsjtx_state.get("ident", ""), wsjtx.free_text_packet(wsjtx_state.get("ident", ""), str(body.get("text", ""))[:37], bool(body.get("send"))))
    except ConnectionError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


class _LogbookParam:
    """Reine ASGI-Zwischenschicht: ?log=Name gilt fuer die ganze Anfrage (gleicher Task, Kontext bleibt erhalten)."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        from urllib.parse import parse_qs
        name = parse_qs(scope.get("query_string", b"").decode()).get("log", [""])[0]
        tok = _LOG_CTX.set(name)
        try:
            await self.app(scope, receive, send)
        finally:
            _LOG_CTX.reset(tok)


app.add_middleware(_LogbookParam)
app.add_middleware(AccessMiddleware, access=access)


@app.get("/login", include_in_schema=False)
async def login_page():
    return Response(LOGIN_HTML, media_type="text/html; charset=utf-8")


@app.post("/api/login", tags=["Zugang"])
async def login(body: dict):
    if not access.check_password(str(body.get("password") or "")):
        await asyncio.sleep(1.0)          # Ausprobieren bremsen
        raise HTTPException(401, "Passwort falsch")
    r = Response(json.dumps({"ok": True}), media_type="application/json")
    r.set_cookie(COOKIE, access.session_value(), max_age=30 * 86400, httponly=True, samesite="lax")
    return r


@app.post("/api/logout", tags=["Zugang"])
async def logout():
    r = Response(json.dumps({"ok": True}), media_type="application/json")
    r.delete_cookie(COOKIE)
    return r


@app.get("/api/access/mcp_config", tags=["Zugang"])
async def mcp_config(request: Request):
    """Fertiger Eintrag fuer KI-Programme mit MCP (z. B. Claude Desktop: claude_desktop_config.json)."""
    url = f"http://127.0.0.1:{request.url.port or 8090}"
    if getattr(sys, "frozen", False):
        cmd, args = sys.executable, ["--mcp", "--url", url]
    else:
        cmd, args = sys.executable, ["-m", "wellenwerk", "--mcp", "--url", url]
    entry = {"command": cmd, "args": args}
    if cfg.get("api_token"):
        entry["env"] = {"WW_TOKEN": cfg["api_token"]}
    return {"mcpServers": {"wellenwerk": entry}}


@app.post("/api/access/new_token", tags=["Zugang"])
async def new_api_token():
    """Erzeugt einen neuen API-Schluessel (der alte wird ungueltig) und zeigt ihn einmal an."""
    import secrets as _s
    cfg["api_token"] = _s.token_urlsafe(24)
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    return {"api_token": cfg["api_token"]}


# ---------- API ----------
@app.get("/api/state")
async def state():
    return dict(version=VERSION, station=station_identity(), rig={**rig.state, "band": band_for(rig.state.get("freq"))},
                cluster=cluster.status, wsjtx=wsjtx_state, settings=public_cfg(), home=home(), rotor=rotor.state, winkey=winkey.state,
                bands=[dict(name=n, lo=lo, hi=hi, start=s) for n, lo, hi, s in BANDS])


def public_cfg() -> dict:
    return {k: (MASK if k in SECRETS and v else v) for k, v in cfg.items() if k != "plugins"}


@app.get("/api/settings")
async def get_settings():
    return public_cfg()


@app.get("/api/station")
async def get_station():
    """Stationsdaten (Rufzeichen, Locator, Position, Operator, Leistung, aktives Profil) – fuer alle Programmteile und Erweiterungen."""
    return station_identity()


@app.put("/api/settings")
async def put_settings(new: dict):
    unknown = set(new) - set(DEFAULTS)
    if unknown:
        raise HTTPException(400, f"unbekannte Einstellungen: {', '.join(sorted(unknown))}")
    if new.get("locator") and not geo.valid_grid(new["locator"]):
        raise HTTPException(400, "Locator ungueltig (z. B. JO31ab)")
    for k in ("cluster_port", "wsjtx_port", "rot_port", "rot_model", "rig_poll_ms", "winkey_wpm", "n1mm_port", "backup_keep",
              "wl_telnet_port", "ardop_port", "vara_port", "agw_port", "agw_radio_port", "sync_offset", "catemu_port", "adif_udp_port"):
        if k in new:
            new[k] = int(new[k])
    for k in BOOLS:
        if k in new:
            new[k] = new[k] in (True, "true", "1", 1, "on")
    for k in SECRETS:
        if new.get(k) == MASK:          # unveraendert
            new.pop(k)
    cfg.update(new)
    cfg["callsign"] = cfg["callsign"].upper().strip()
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    apply_poll()
    apply_links()
    apply_rotor_opts()
    await restart_n1mm()
    if any(k.startswith("catemu_") for k in new):
        await apply_catemu()
    if "backup_dir" in new:
        BACKUP_WAKE.set()
    await rotor_spawn()
    rotor.reconfigure(cfg["rot_host"], int(cfg["rot_port"]), bool(cfg["rot_enabled"]))
    cluster.reconfigure(cfg["cluster_host"], int(cfg["cluster_port"]), cfg["callsign"], cfg.get("cluster_cmds", ""))
    await identity_changed()
    return public_cfg()


async def _rig(coro):
    try:
        await coro
    except RigError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Funkgerät nicht erreichbar: {e}")
    return {"ok": True}


# ---------- Funkgeraete verbinden ----------
_MODELS = {}


@app.get("/api/hamlib/models")
async def hamlib_models(kind: str = "rig"):
    if kind not in _MODELS:
        _MODELS[kind] = await asyncio.to_thread(radmod.model_list, "rotctl" if kind == "rot" else "rigctl")
    return _MODELS[kind]


@app.get("/api/hamlib/ports")
async def hamlib_ports():
    return await asyncio.to_thread(radmod.serial_ports)


@app.get("/api/radios")
async def radios_list():
    return dict(current=radios.current, radios=radios.status())


@app.post("/api/radios")
async def radios_save(body: dict):
    keep = ("id", "name", "model", "mfg", "model_name", "device", "speed", "civaddr", "handshake", "dtr_state", "rts_state",
            "ptt_type", "ptt_device", "host", "conf", "autoconnect", "share", "scope", "kind", "sdr_type", "url", "params", "role")
    prof = {k: body[k] for k in keep if k in body}
    if prof.get("kind") == "sdr":
        from .sdr import registry
        t = next((x for x in registry.kinds() if x["kind"] == prof.get("sdr_type")), None)
        if not t:
            raise HTTPException(400, "Empfänger-Art fehlt")
        if t["needs"] == "url" and not (prof.get("url") or "").strip():
            raise HTTPException(400, "Adresse des Empfängers fehlt")
        prof.update(mfg=prof.get("mfg") or "SDR", model_name=t["label"], model=0)
        prof["name"] = prof.get("name") or f"{t['label']} {prof.get('url', '')}".strip()
        if prof.get("id") in radios.active:
            await radios.disconnect(prof["id"])
        p = radios.upsert(prof)
        await broadcast({"type": "radios"})
        return p
    try:
        int(prof.get("model", 0))
    except ValueError:
        raise HTTPException(400, "Modell fehlt")
    if not prof.get("model"):
        raise HTTPException(400, "Modell fehlt")
    if not prof.get("name"):
        prof["name"] = f"{prof.get('mfg', '')} {prof.get('model_name', '')}".strip() or f"Modell {prof['model']}"
    if prof.get("id") in radios.active:
        await radios.disconnect(prof["id"])
    p = radios.upsert(prof)
    await broadcast({"type": "radios"})
    return p


@app.delete("/api/radios/{pid}")
async def radios_delete(pid: str):
    await radios.disconnect(pid)
    radios.delete(pid)
    await broadcast({"type": "radios"})
    return {"ok": True}


@app.post("/api/radios/{pid}/connect")
async def radios_connect(pid: str):
    try:
        await radios.connect(pid)
    except Exception as e:
        raise HTTPException(502, str(e))
    await broadcast({"type": "radios"})
    return {"ok": True}


@app.post("/api/radios/{pid}/disconnect")
async def radios_disconnect(pid: str):
    await radios.disconnect(pid)
    await broadcast({"type": "radios"})
    return {"ok": True}


@app.post("/api/radios/{pid}/select")
async def radios_select(pid: str):
    if pid not in radios.active:
        raise HTTPException(400, "Funkgerät ist nicht verbunden")
    radios.current = pid
    await broadcast({"type": "radios"})
    r = radios.rig()
    await on_rig(pid, dict(r.state))
    return {"ok": True}


@app.get("/api/radios/{pid}/log")
async def radios_log(pid: str):
    rp = radios.active.get(pid)
    return {"log": list(rp.log) if rp else []}


@app.post("/api/radios/detect")
async def radios_detect(body: dict):
    """Baudrate automatisch suchen: rigctld mit jeder Rate starten und Frequenz abfragen."""
    prof = dict(body, id="detect", name="detect")
    for speed in (115200, 57600, 38400, 19200, 9600, 4800):
        rp = radmod.RadioProc(dict(prof, speed=speed), 4690, lambda *a: asyncio.sleep(0))
        try:
            await rp.start()
            r = rp.rig
            kv, _ = await asyncio.wait_for(r._cmd("f"), 4)
            f = int(float(kv.get("frequency", 0)))
            if f > 0:
                return dict(ok=True, speed=speed, freq=f, log=list(rp.log)[-5:])
        except Exception:
            pass
        finally:
            await rp.stop()
    return dict(ok=False, log=["Keine Antwort bei 115200…4800 Baud – Port, CI-V-Adresse und Kabel prüfen."])


# ---------- Rotor-Prozess ----------
ROTCTLD = {"proc": None, "sig": None}


async def rotor_spawn():
    """rotctld fuer das eingestellte Rotor-Modell selbst starten (wie beim Funkgeraet)."""
    model = int(cfg.get("rot_model") or 0)
    sig = (model, cfg.get("rot_device"), cfg.get("rot_speed")) if cfg.get("rot_enabled") and model else None
    if sig == ROTCTLD["sig"]:
        return
    if ROTCTLD["proc"] and ROTCTLD["proc"].poll() is None:
        ROTCTLD["proc"].terminate()
        await asyncio.sleep(0.5)
    ROTCTLD.update(proc=None, sig=sig)
    if not sig:
        return
    exe = radmod.hamlib_exe("rotctld")
    if not exe:
        log.warning("rotctld nicht gefunden"); return
    rport = next((p for p in range(4650, 4700) if radmod.port_free(p)), 4650)
    cmd = [exe, "-m", str(model), "-T", "127.0.0.1", "-t", str(rport)]
    if model not in (1,) and cfg.get("rot_device"):
        cmd += ["-r", cfg["rot_device"]]
    if cfg.get("rot_speed"):
        cmd += ["-s", str(cfg["rot_speed"])]
    ROTCTLD["proc"] = await asyncio.to_thread(subprocess.Popen, cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=radmod.hamlib_env())
    cfg["rot_host"], cfg["rot_port"] = "127.0.0.1", rport
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    await asyncio.sleep(0.8)
    rotor.reconfigure(cfg["rot_host"], int(cfg["rot_port"]), bool(cfg["rot_enabled"]))


@app.get("/api/rig/caps")
async def rig_caps():
    c = {k: v for k, v in rig.caps.items() if k not in ("slow", "ranges")}
    return c


@app.post("/api/rig/freq")
async def rig_freq(body: dict):
    return await _rig(rig.set_freq(int(body["hz"])))


@app.post("/api/rig/mode")
async def rig_mode(body: dict):
    return await _rig(rig.set_mode(str(body["mode"]).upper(), int(body.get("passband", 0))))


@app.post("/api/rig/ptt")
async def rig_ptt(body: dict):
    return await _rig(rig.set_ptt(bool(body["on"])))


@app.post("/api/rig/level")
async def rig_level(body: dict):
    return await _rig(rig.set_level(str(body["name"]).upper(), float(body["value"])))


@app.post("/api/rig/func")
async def rig_func(body: dict):
    return await _rig(rig.set_func(str(body["name"]).upper(), bool(body["on"])))


@app.post("/api/rig/op")
async def rig_op(body: dict):
    return await _rig(rig.vfo_op(str(body["op"]).upper()))


@app.post("/api/rig/vfo")
async def rig_vfo(body: dict):
    v = str(body["vfo"]).upper()
    if v not in ("VFOA", "VFOB"):
        raise HTTPException(400, "VFO muss VFOA oder VFOB sein")
    return await _rig(rig.set_vfo(v))


@app.post("/api/rig/split")
async def rig_split(body: dict):
    return await _rig(rig.set_split(bool(body["on"])))


@app.post("/api/rig/repeater")
async def rig_repeater(body: dict):
    shift = {"+": "+", "-": "-"}.get(str(body.get("shift")), "None")
    return await _rig(rig.set_repeater(shift, int(body.get("offset") or 0)))


@app.post("/api/rig/ctcss")
async def rig_ctcss(body: dict):
    return await _rig(rig.set_ctcss(float(body["tone"])))


@app.post("/api/rig/rit")
async def rig_rit(body: dict):
    return await _rig(rig.set_rit(int(body["hz"])))


@app.post("/api/rig/xit")
async def rig_xit(body: dict):
    return await _rig(rig.set_xit(int(body["hz"])))


@app.get("/api/rig/memories")
async def rig_memories(lo: int | None = None, hi: int | None = None):
    """Speicherkanaele lesen (Bereich aus den Geraetefaehigkeiten, hoechstens 200 auf einmal)."""
    r = radios.rig()
    if not r or not r.state.get("connected"):
        raise HTTPException(409, "Kein Funkgerät verbunden")
    ranges = [m for m in r.caps.get("memories", []) if m["type"] == "MEM"]
    if lo is None:
        if not ranges:
            return {"ranges": [], "channels": []}
        lo, hi = ranges[0]["lo"], ranges[0]["hi"]
    hi = min(hi if hi is not None else lo, lo + 199)
    out = []
    for ch in range(lo, hi + 1):
        try:
            out.append(await r.get_channel(ch))
        except (RigError, asyncio.TimeoutError) as e:
            out.append(dict(ch=ch, error=str(e)))
    return {"ranges": r.caps.get("memories", []), "channels": out}


@app.post("/api/rig/memory")
async def rig_memory(body: dict):
    return await _rig(rig.memory_op(int(body["ch"]), str(body.get("action", "recall"))))


@app.post("/api/rig/morse")
async def rig_morse(body: dict):
    text = "".join(ch for ch in str(body.get("text", "")).upper() if ch.isalnum() or ch in " /?.,=+-")[:200]
    if cfg.get("cw_out") == "winkey":               # CW ueber den WinKeyer statt ueber CAT
        try:
            if body.get("stop"):
                await winkey.stop()
            elif text:
                await winkey.send(text)
        except ConnectionError as e:
            raise HTTPException(409, str(e))
        return {"ok": True, "via": "winkey"}
    if body.get("stop"):
        return await _rig(rig.stop_morse())
    if not text:
        raise HTTPException(400, "kein Text")
    return await _rig(rig.send_morse(text))


# ---------- WinKeyer ----------
async def on_winkey(st):
    await broadcast({"type": "winkey", "winkey": st})


winkey = wkmod.WinKeyer(on_winkey)


@app.get("/api/winkey")
async def winkey_state():
    return winkey.state


@app.post("/api/winkey/connect")
async def winkey_connect(body: dict | None = None):
    body = body or {}
    dev = body.get("device") or cfg.get("winkey_device")
    if not dev:
        raise HTTPException(400, "Kein Port für den WinKeyer gewählt")
    try:
        await winkey.connect(dev, int(body.get("wpm") or cfg.get("winkey_wpm") or 22))
    except ConnectionError as e:
        raise HTTPException(409, str(e))
    return winkey.state


@app.post("/api/winkey/disconnect")
async def winkey_disconnect():
    await winkey.disconnect()
    await on_winkey(winkey.state)
    return winkey.state


@app.post("/api/winkey/speed")
async def winkey_speed(body: dict):
    try:
        await winkey.speed(int(body["wpm"]))
    except ConnectionError as e:
        raise HTTPException(409, str(e))
    return winkey.state


# ---------- Rotor ----------
async def _rot(coro):
    try:
        await coro
    except RotorError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Rotor nicht erreichbar: {e}")
    return {"ok": True}


@app.post("/api/rotor/set")
async def rotor_set(body: dict):
    try:
        az = float(body["az"])
    except (KeyError, ValueError):
        raise HTTPException(400, "Azimut fehlt")
    el = body.get("el")
    return await _rot(rotor.set_pos(az, float(el) if el not in (None, "") else None))


@app.post("/api/rotor/stop")
async def rotor_stop():
    return await _rot(rotor.stop())


@app.post("/api/rotor/park")
async def rotor_park():
    return await _rot(rotor.park())


@app.get("/api/countries")
async def countries():
    seen = {}
    for e in cty.prefix.values():
        if not e.get("wae_only") and e["dxcc"] not in seen:
            seen[e["dxcc"]] = dict(name=e["country"], dxcc=e["dxcc"], lat=e["lat"], lon=e["lon"], prefix=e["prefix"])
    return sorted(seen.values(), key=lambda c: c["name"])


@app.get("/docs/{name}")
async def docs(name: str):
    p = BASE / "docs" / Path(name).name
    if Path(name).name in ("LIZENZEN.md", "LICENSE"):
        p = BASE / Path(name).name
    if not p.exists():
        raise HTTPException(404, "nicht gefunden")
    return Response(p.read_text(), media_type="text/plain; charset=utf-8")


@app.get("/docs/bilder/{name}")
async def docs_image(name: str):
    p = BASE / "docs" / "bilder" / Path(name).name
    if p.suffix != ".png" or not p.exists():
        raise HTTPException(404, "nicht gefunden")
    return FileResponse(p, media_type="image/png")


@app.get("/api/sat/catalog")
async def sat_catalog():
    cat = await asyncio.to_thread(sats.catalog, DATA)
    if not cat:
        raise HTTPException(502, "Satellitendaten nicht verfügbar (CelesTrak nicht erreichbar und kein Zwischenspeicher)")
    return dict(home=home(), sats=cat)


@app.post("/api/rig/split_freq")
async def rig_split_freq(body: dict):
    return await _rig(rig.set_split_freq(int(body["hz"])))


@app.get("/api/bearing/{call:path}")
async def bearing(call: str, grid: str = ""):
    d = describe(call, grid)
    if d.get("bearing") is None:
        raise HTTPException(400, "Richtung unbekannt (eigener Locator oder Land fehlt)")
    return dict(call=call.upper(), short=d["bearing"], long=(d["bearing"] + 180) % 360, km=d["km"],
                km_long=round(40030 - d["km"]), lat=d["lat"], lon=d["lon"], country=d["country"])


# ---------- Favoriten (Speicherplaetze) ----------
FAV_PATH = DATA / "favorites.json"


def _favs() -> list:
    try:
        return json.loads(FAV_PATH.read_text())
    except Exception:
        return []


@app.get("/api/favorites")
async def fav_list():
    return _favs()


@app.post("/api/favorites")
async def fav_add(body: dict):
    favs = _favs()
    try:
        hz = int(body["freq"])
    except (KeyError, ValueError):
        raise HTTPException(400, "Frequenz fehlt")
    fav = dict(id=max([f["id"] for f in favs] + [0]) + 1, name=str(body.get("name") or "").strip()[:40] or f"{hz/1e6:.4f} MHz",
               group=str(body.get("group") or band_for(hz) or "Sonstige").strip()[:30], freq=hz,
               mode=str(body.get("mode") or "").upper(), passband=int(body.get("passband") or 0))
    favs.append(fav)
    FAV_PATH.write_text(json.dumps(favs, indent=1))
    await broadcast({"type": "favorites"})
    return fav


@app.put("/api/favorites/{fid}")
async def fav_update(fid: int, body: dict):
    favs = _favs()
    fav = next((f for f in favs if f["id"] == fid), None)
    if not fav:
        raise HTTPException(404, "Favorit nicht gefunden")
    for k in ("name", "group", "freq", "mode"):
        if k in body:
            fav[k] = int(body[k]) if k == "freq" else str(body[k]).strip()
    FAV_PATH.write_text(json.dumps(favs, indent=1))
    await broadcast({"type": "favorites"})
    return fav


@app.delete("/api/favorites/{fid}")
async def fav_del(fid: int):
    favs = [f for f in _favs() if f["id"] != fid]
    FAV_PATH.write_text(json.dumps(favs, indent=1))
    await broadcast({"type": "favorites"})
    return {"ok": True}


def _mode_rst(mode: str) -> str:
    """RST-Vorgabe aus der Betriebsarten-Liste der Programmoptionen, sonst Standard."""
    for line in (cfg.get("mode_rst") or "").splitlines():
        p = line.split()
        if len(p) >= 2 and p[0].upper() == (mode or "").upper():
            return p[1]
    return default_rst(mode)


@app.get("/api/lookup/{call:path}")
async def lookup(call: str, band: str = "", mode: str = "", grid: str = ""):
    info = describe(call, grid)
    c = call.upper()
    return dict(call=c, **info, worked=book.worked(call, info.get("dxcc"), band, mode), rst=_mode_rst(mode),
                matrix_call=book.matrix("call=?", [c]),
                matrix_dxcc=book.matrix("dxcc=?", [info["dxcc"]]) if info.get("dxcc") else {})


@app.get("/api/qso")
async def qso_list(q: str = "", limit: int = 500, offset: int = 0, band: str = "", mode: str = "", qsl: str = "",
                   date_from: str = "", date_to: str = "", cond: str = ""):
    w, a = _filter(q, band, mode, qsl, date_from, date_to, cond)
    rows, total = book.query(" AND ".join(w), a, limit=min(limit, 5000), offset=offset)
    return dict(total=total, qsos=rows)


CONF = "(UPPER(IFNULL(qsl_rcvd,'')) IN ('Y','V') OR UPPER(IFNULL(lotw_qsl_rcvd,'')) IN ('Y','V') OR UPPER(IFNULL(eqsl_qsl_rcvd,'')) IN ('Y','V'))"
QSL_FILTERS = {
    "confirmed": CONF, "unconfirmed": "NOT " + CONF,
    "lotw": "UPPER(IFNULL(lotw_qsl_rcvd,'')) IN ('Y','V')", "eqsl": "UPPER(IFNULL(eqsl_qsl_rcvd,'')) IN ('Y','V')",
    "paper": "UPPER(IFNULL(qsl_rcvd,'')) IN ('Y','V')",
    "queued": "UPPER(IFNULL(qsl_sent,'')) IN ('Q','R')", "to_send": "UPPER(IFNULL(qsl_sent,'')) NOT IN ('Y','I')",
    "no_qrz": "IFNULL(qrzcom_qso_upload_status,'') <> 'Y'", "no_lotw": "UPPER(IFNULL(lotw_qsl_sent,'')) <> 'Y'",
    "no_eqsl": "UPPER(IFNULL(eqsl_qsl_sent,'')) <> 'Y'", "no_clublog": "IFNULL(clublog_qso_upload_status,'') <> 'Y'",
}


COND_RE = re.compile(r"^\s*([a-z_]+)\s*(!=|<>|>=|<=|=|~|!~|<|>|\s+(?:leer|nicht leer|empty|not empty))\s*(.*?)\s*$", re.I)


def _cond(text: str) -> tuple[list, list]:
    """Feld-Bedingungen fuer gespeicherte Ansichten, mit ';' getrennt: call~DL, cqz=14, band!=20m,
    qso_date>=20260101, iota nicht leer, comment leer (englisch: not empty / empty). Nur bekannte Logbuch-Felder."""
    w, a = [], []
    for part in filter(None, (p.strip() for p in (text or "").split(";"))):
        m = COND_RE.match(part)
        if not m or m.group(1).lower() not in QSO_FIELDS:
            raise HTTPException(400, f"Bedingung nicht verstanden: {part} (Beispiel: cqz=14; country~Japan; iota nicht leer)")
        f, op, v = m.group(1).lower(), m.group(2).strip().lower(), m.group(3)
        if op in ("leer", "nicht leer", "empty", "not empty"):
            w.append(f"IFNULL({f},'') {'=' if op in ('leer', 'empty') else '<>'} ''"); continue
        if f == "call":
            v = v.upper()
        elif f in ("band",):
            v = v.lower()
        elif f == "qso_date":
            v = v.replace("-", "")
        if op in ("~", "!~"):
            w.append(f"IFNULL({f},'') {'NOT ' if op == '!~' else ''}LIKE ?"); a.append(f"%{v}%")
        elif f in QSO_INTS and re.fullmatch(r"-?\d+", v):
            w.append(f"{f} {'<>' if op == '!=' else op} ?"); a.append(int(v))
        elif op in ("=", "!=", "<>"):
            w.append(f"UPPER(IFNULL({f},'')) {'=' if op == '=' else '<>'} ?"); a.append(v.upper())
        else:
            w.append(f"{f} {op} ?"); a.append(v)
    return w, a


def _filter(q="", band="", mode="", qsl="", date_from="", date_to="", cond=""):
    w, a = _cond(cond)
    if q:
        w.append("(call LIKE ? OR country LIKE ? OR name LIKE ? OR gridsquare LIKE ? OR comment LIKE ? OR qth LIKE ? "
                 "OR darc_dok LIKE ? OR iota LIKE ?)")
        a += [f"%{q.upper()}%"] + [f"%{q}%"] * 7
    if band:
        w.append("band=?"); a.append(band.lower())
    if mode:
        w.append("mode=?"); a.append(mode.upper())
    if qsl in QSL_FILTERS:
        w.append(QSL_FILTERS[qsl])
    if date_from:
        w.append("qso_date>=?"); a.append(date_from.replace("-", ""))
    if date_to:
        w.append("qso_date<=?"); a.append(date_to.replace("-", ""))
    return w, a


def _today():
    return datetime.now(timezone.utc).strftime("%Y%m%d")


@app.post("/api/qso/bulk")
async def qso_bulk(body: dict):
    ids = [int(i) for i in body.get("ids", [])]
    act = body.get("action")
    if not ids:
        raise HTTPException(400, "keine QSOs ausgewählt")
    if act == "delete":
        n = sum(book.delete(i) for i in ids)
    elif act == "qsl_sent":
        n = book.set_fields(ids, {"qsl_sent": "Y", "qsl_sdate": _today()})
    elif act == "qsl_queue":
        n = book.set_fields(ids, {"qsl_sent": "Q"})
    elif act == "qsl_rcvd":
        n = book.set_fields(ids, {"qsl_rcvd": "Y", "qsl_rdate": _today()})
    elif act == "qsl_reset":
        n = book.set_fields(ids, {"qsl_sent": "N", "qsl_sdate": "", "qsl_rcvd": "N", "qsl_rdate": ""})
    elif act == "callbook":       # leere Felder aus dem Callbook fuellen (hoechstens 300 auf einmal, mit Pause)
        if not (cfg.get("hamqth_user") or cfg.get("qrz_user")):
            raise HTTPException(400, "Kein Callbook eingerichtet (Optionen → Online-Dienste)")
        n = 0
        for qid in ids[:300]:
            q = book.get(qid)
            if not q:
                continue
            try:
                cb = await asyncio.to_thread(callbook.lookup, cfg, q["call"])
            except Exception as e:
                log.info("Callbook %s: %s", q["call"], e)
                cb = None
            upd = {k: cb[k] for k in ("name", "qth", "gridsquare", "state", "cnty", "iota", "email", "qsl_via", "address") if cb and cb.get(k) and not q.get(k)}
            if upd:
                n += book.set_fields([qid], upd)
            await asyncio.sleep(0.3)
    else:
        raise HTTPException(400, f"unbekannte Aktion {act}")
    await broadcast({"type": "reload"})
    return {"changed": n}


# ---------- Online-Dienste ----------
callbook = services.Callbook()
SYNC_PATH = DATA / "sync.json"


def _sync_state() -> dict:
    try:
        return json.loads(SYNC_PATH.read_text())
    except Exception:
        return {}


def _sync_save(**kw):
    st = _sync_state(); st.update(kw); SYNC_PATH.write_text(json.dumps(st, indent=1))


@app.get("/api/callbook/{call:path}")
async def callbook_lookup(call: str):
    try:
        r = await asyncio.to_thread(callbook.lookup, cfg, call)
    except services.ServiceError as e:
        raise HTTPException(502, str(e))
    if not r:
        raise HTTPException(404, "kein Callbook eingerichtet (HamQTH oder QRZ.com in den Einstellungen)")
    return r


def _upload_one(service: str, q: dict) -> str:
    if service == "qrz":
        res = services.qrz_upload(cfg, q)
        book.set_fields([q["id"]], {"qrzcom_qso_upload_status": "Y", "qrzcom_qso_upload_date": _today()})
    elif service == "clublog":
        res = services.clublog_upload(cfg, q)
        book.set_fields([q["id"]], {"clublog_qso_upload_status": "Y", "clublog_qso_upload_date": _today()})
    else:
        raise services.ServiceError(f"unbekannter Dienst {service}")
    return res


async def _upload(service: str, ids: list[int]) -> dict:
    qsos = book.by_ids(ids)
    ok, errors = 0, []
    if service in ("eqsl", "lotw"):
        if qsos:
            fn = services.eqsl_upload if service == "eqsl" else services.lotw_upload
            try:
                res = await asyncio.to_thread(fn, cfg, qsos)
                fld = {"eqsl_qsl_sent": "Y", "eqsl_qslsdate": _today()} if service == "eqsl" else \
                      {"lotw_qsl_sent": "Y", "lotw_qslsdate": _today()}
                book.set_fields([q["id"] for q in qsos], fld)
                ok = res.get("added", len(qsos)) if isinstance(res, dict) else len(qsos)
            except services.ServiceError as e:
                errors.append(str(e))
    else:
        for q in qsos:
            try:
                await asyncio.to_thread(_upload_one, service, q)
                ok += 1
            except services.ServiceError as e:
                errors.append(f"{q['call']}: {e}")
                if "nötig" in str(e) or "fehlen" in str(e) or "kein API" in str(e):
                    break
    if ok:
        await broadcast({"type": "reload"})
    return dict(service=service, uploaded=ok, total=len(qsos), errors=errors[:20])


PENDING = {"qrz": "no_qrz", "clublog": "no_clublog", "eqsl": "no_eqsl", "lotw": "no_lotw"}


@app.post("/api/upload")
async def upload(body: dict):
    service = body.get("service")
    if service not in PENDING:
        raise HTTPException(400, "Dienst muss qrz, clublog, eqsl oder lotw sein")
    ids = body.get("ids")
    if not ids:          # alle noch nicht hochgeladenen
        rows, _ = book.query(QSL_FILTERS[PENDING[service]], [], limit=5000)
        ids = [r["id"] for r in rows]
    return await _upload(service, [int(i) for i in ids])


def auto_upload(qid: int):
    if cfg.get("fwd_targets"):
        q = book.get(qid)
        if q:
            links.forward_qso(q, cfg["fwd_targets"], cfg.get("fwd_format") or "adif")
    for svc, flag in (("qrz", "auto_qrz"), ("clublog", "auto_clublog"), ("eqsl", "auto_eqsl")):
        if cfg.get(flag):
            async def run(svc=svc):
                r = await _upload(svc, [qid])
                if r["errors"]:
                    log.warning("Auto-Upload %s: %s", svc, r["errors"])
                    await broadcast({"type": "notice", "bad": True, "text": f"Upload {svc}: {r['errors'][0]}"})
            asyncio.create_task(run())


@app.post("/api/sync/confirmations")
async def sync_confirmations(body: dict):
    service = body.get("service")
    if service not in ("lotw", "eqsl"):
        raise HTTPException(400, "Dienst muss lotw oder eqsl sein")
    since = body.get("since") or _sync_state().get(f"{service}_since") or "1990-01-01"
    fn = services.lotw_confirmations if service == "lotw" else services.eqsl_confirmations
    try:
        recs = await asyncio.to_thread(fn, cfg, since)
    except services.ServiceError as e:
        raise HTTPException(502, str(e))
    matched, unmatched = 0, []
    for r in recs:
        q = book.find_match(r.get("call", ""), r.get("qso_date", ""), r.get("time_on", ""), (r.get("band") or "").lower(),
                            (r.get("mode") or "").upper())
        if not q:
            unmatched.append(f"{r.get('call')} {r.get('qso_date')} {r.get('band')}")
            continue
        if service == "lotw":
            upd = {"lotw_qsl_rcvd": "Y", "lotw_qslrdate": r.get("qslrdate") or _today()}
            for k in ("cqz", "ituz", "state", "cnty", "iota", "gridsquare", "dxcc"):
                if r.get(k) and not q.get(k):
                    upd[k] = r[k]
        else:
            upd = {"eqsl_qsl_rcvd": "Y", "eqsl_qslrdate": r.get("qslrdate") or _today()}
        book.set_fields([q["id"]], upd)
        matched += 1
    _sync_save(**{f"{service}_since": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                  f"{service}_last": datetime.now(timezone.utc).isoformat(timespec="minutes")})
    if matched:
        await broadcast({"type": "reload"})
    return dict(service=service, received=len(recs), matched=matched, unmatched=unmatched[:30])


@app.post("/api/lotw/cert")
async def lotw_cert(file: UploadFile, password: str = ""):
    data = await file.read()
    if len(data) > 200_000 or not data:
        raise HTTPException(400, "keine gültige Zertifikatsdatei (.p12)")
    try:
        out = await asyncio.to_thread(services.tqsl_import_cert, data, password)
    except services.ServiceError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "message": out, "has_cert": services.tqsl_has_cert()}


@app.post("/api/lotw/location")
async def lotw_location():
    e = cty.lookup(cfg.get("callsign", "")) or {}
    if not cfg.get("callsign") or not e:
        raise HTTPException(400, "Rufzeichen fehlt oder Land unbekannt")
    name = cfg.get("lotw_location") or "Wellenwerk"
    await asyncio.to_thread(services.tqsl_ensure_location, name, cfg["callsign"], e["dxcc"], cfg.get("locator", ""),
                            e.get("cqz"), e.get("ituz"))
    if not cfg.get("lotw_location"):
        cfg["lotw_location"] = name; CFG_PATH.write_text(json.dumps(cfg, indent=2))
    return {"ok": True, "location": name, "locations": services.tqsl_locations()}


@app.get("/api/services/status")
async def services_status():
    rows = {k: book.query(QSL_FILTERS[v], [], limit=1)[1] for k, v in PENDING.items()}
    return dict(pending=rows, tqsl=bool(services.tqsl_path()), tqsl_cert=services.tqsl_has_cert(),
                tqsl_locations=services.tqsl_locations(), sync=_sync_state(),
                configured=dict(callbook=bool((cfg["hamqth_user"] and cfg["hamqth_pass"]) or (cfg["qrz_user"] and cfg["qrz_pass"])),
                                qrz=bool(cfg["qrz_logbook_key"]), eqsl=bool(cfg["eqsl_user"] and cfg["eqsl_pass"]),
                                lotw=bool(cfg["lotw_user"] and cfg["lotw_pass"]),
                                clublog=bool(cfg["clublog_email"] and cfg["clublog_pass"] and cfg["clublog_api"])))


@app.get("/api/awards")
async def get_awards():
    names = {}
    for e in list(cty.prefix.values()) + list(cty.exact.values()):
        if not e.get("wae_only"):
            names.setdefault(e["dxcc"], e["country"])
    return awards.compute(book.all(), names, bool(cfg.get("eqsl_counts")))


# ---------- Druck und Contest ----------
def _print_page(title: str, body: str, css: str = "") -> Response:
    html = f"""<!doctype html><html lang="de"><head><meta charset="utf-8"><title>{title}</title><script src="/static/js/i18n.js"></script><style>
    body{{font:11pt system-ui,sans-serif;margin:12mm;color:#000}} table{{border-collapse:collapse;width:100%;font-size:9pt}}
    th,td{{border:1px solid #999;padding:2px 4px;text-align:left}} th{{background:#e5e8ec}} h1{{font-size:14pt;margin:0 0 6px}}
    .noprint{{margin-bottom:10px}} @media print{{.noprint{{display:none}} body{{margin:0}}}} {css}</style></head>
    <body><div class="noprint"><button onclick="print()">Drucken</button></div>{body}</body></html>"""
    return Response(html, media_type="text/html; charset=utf-8")


def _esc(v) -> str:
    return str(v if v is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _sel_qsos(ids: str, q="", band="", mode="", qsl="", date_from="", date_to="", cond="") -> list[dict]:
    if ids:
        return book.by_ids([int(i) for i in ids.split(",") if i.strip().isdigit()])
    w, a = _filter(q, band, mode, qsl, date_from, date_to, cond)
    rows, _ = book.query(" AND ".join(w), a, order="qso_date, time_on, id", limit=20000)
    return rows


@app.get("/print/log")
async def print_log(ids: str = "", q: str = "", band: str = "", mode: str = "", qsl: str = "", date_from: str = "", date_to: str = "", cond: str = ""):
    rows = _sel_qsos(ids, q, band, mode, qsl, date_from, date_to, cond)
    cols = [("qso_date", "Datum"), ("time_on", "UTC"), ("call", "Rufzeichen"), ("freq", "MHz"), ("band", "Band"), ("mode", "Mode"),
            ("rst_sent", "S"), ("rst_rcvd", "R"), ("name", "Name"), ("qth", "QTH"), ("gridsquare", "Loc"), ("country", "Land"),
            ("qsl_sent", "QSL s"), ("qsl_rcvd", "QSL r"), ("comment", "Bemerkung")]
    fmt = lambda k, v: (f"{v[6:8]}.{v[4:6]}.{v[:4]}" if k == "qso_date" and v else f"{v[:2]}:{v[2:4]}" if k == "time_on" and v else v)
    body = (f"<h1>Logbuch {_esc(cfg.get('callsign'))} – {len(rows)} QSOs</h1><table><tr>" + "".join(f"<th>{h}</th>" for _, h in cols) + "</tr>"
            + "".join("<tr translate='no'>" + "".join(f"<td>{_esc(fmt(k, r.get(k)))}</td>" for k, _ in cols) + "</tr>" for r in rows) + "</table>")
    return _print_page("Logbuch", body)


@app.get("/print/labels")
async def print_labels(ids: str = "", skip: int = 0, q: str = "", qsl: str = "to_send"):
    """QSL-Etiketten, Bogen 2x7 (z. B. Avery L7163, 99,1 x 38,1 mm). Bis zu 3 QSOs je Station auf einem Etikett."""
    rows = _sel_qsos(ids, q, qsl=qsl)
    groups = {}
    for r in rows:
        groups.setdefault(r.get("qsl_via") or r["call"], []).append(r)
    labels = []
    for via, qs in groups.items():
        for i in range(0, len(qs), 3):
            chunk = qs[i:i + 3]
            to = chunk[0]["call"] + (f" via {via}" if via != chunk[0]["call"] else "")
            trs = "".join(f"<tr><td>{q['qso_date'][6:8]}.{q['qso_date'][4:6]}.{q['qso_date'][:4]}</td><td>{q['time_on'][:2]}:{q['time_on'][2:4]}</td>"
                          f"<td>{_esc(q.get('band'))}</td><td>{_esc(q.get('mode'))}</td><td>{_esc(q.get('rst_sent'))}</td></tr>" for q in chunk)
            labels.append(f"<div class='lab'><div class='to'>To Radio {_esc(to)}</div><table><tr><th>Datum</th><th>UTC</th><th>Band</th>"
                          f"<th>Mode</th><th>RST</th></tr>{trs}</table><div class='fr'>{_esc(cfg.get('callsign'))} · {_esc(cfg.get('locator'))} · PSE/TNX QSL</div></div>")
    cells = ["<div class='lab'></div>"] * max(0, skip) + labels
    css = """@page{size:A4;margin:15.15mm 4.65mm} body{margin:0} .sheet{display:grid;grid-template-columns:99.1mm 99.1mm;column-gap:2.5mm;
      grid-auto-rows:38.1mm} .lab{padding:3mm 4mm;overflow:hidden;font-size:8.5pt} .lab table{font-size:8pt;margin:1mm 0}
      .lab th,.lab td{border:none;border-bottom:1px solid #ccc;padding:0 3px} .to{font-weight:700;font-size:11pt} .fr{font-size:7.5pt;color:#444}
      @media screen{.lab{outline:1px dashed #bbb}}"""
    body = f"<p class='noprint'>{len(labels)} Etiketten für {len(rows)} QSOs. Bogen 2×7 (z. B. Avery L7163).</p><div class='sheet'>{''.join(cells)}</div>"
    return _print_page("QSL-Etiketten", body, css)


@app.get("/print/address")
async def print_address(ids: str = "", skip: int = 0):
    """Adressetiketten (Bogen 3x8, z. B. Avery L7160, 63,5 x 38,1 mm) aus Name und Anschrift (Callbook)."""
    rows = _sel_qsos(ids)
    seen, labels, missing = set(), [], []
    for r in rows:
        if r["call"] in seen:
            continue
        seen.add(r["call"])
        adr = [p.strip() for p in (r.get("address") or "").split(",") if p.strip()]
        if not adr:
            missing.append(r["call"])
            continue
        lines = [f"<b>{_esc(r.get('name') or '')} {_esc(r['call'])}</b>"] + [_esc(a) for a in adr]
        labels.append(f"<div class='lab'>{'<br>'.join(lines)}</div>")
    cells = ["<div class='lab'></div>"] * max(0, skip) + labels
    css = """@page{size:A4;margin:15.15mm 7.2mm} body{margin:0} .sheet{display:grid;grid-template-columns:repeat(3,63.5mm);column-gap:2.5mm;
      grid-auto-rows:38.1mm} .lab{padding:5mm 5mm;overflow:hidden;font-size:10pt;line-height:1.35} @media screen{.lab{outline:1px dashed #bbb}}"""
    hint = f" Ohne Anschrift (erst „Callbook für Auswahl“): {', '.join(missing[:30])}" if missing else ""
    body = f"<p class='noprint'>{len(labels)} Adressetiketten. Bogen 3×8 (z. B. Avery L7160).{_esc(hint)}</p><div class='sheet'>{''.join(cells)}</div>"
    return _print_page("Adressetiketten", body, css)


@app.get("/api/cabrillo")
async def cabrillo(contest: str = "", date_from: str = "", date_to: str = "", category: str = "SINGLE-OP ALL HIGH",
                   ids: str = ""):
    rows = _sel_qsos(ids, date_from=date_from, date_to=date_to)
    mode_map = {"SSB": "PH", "USB": "PH", "LSB": "PH", "AM": "PH", "FM": "FM", "CW": "CW", "RTTY": "RY"}
    lines = ["START-OF-LOG: 3.0", f"CONTEST: {contest or 'UNKNOWN'}", f"CALLSIGN: {cfg.get('callsign', '')}",
             f"GRID-LOCATOR: {cfg.get('locator', '')}", f"CATEGORY-OPERATOR: {category.split()[0] if category else 'SINGLE-OP'}",
             f"CREATED-BY: Wellenwerk {VERSION}"]
    for r in rows:
        try:
            khz = int(round(float(r.get("freq") or 0) * 1000))
        except ValueError:
            khz = 0
        mo = mode_map.get((r.get("mode") or "").upper(), "DG")
        d = r["qso_date"]; t = (r.get("time_on") or "0000")[:4]
        sent = (r.get("stx_string") or r.get("stx") or "").strip()
        rcvd = (r.get("srx_string") or r.get("srx") or "").strip()
        lines.append(f"QSO: {khz:>5} {mo} {d[:4]}-{d[4:6]}-{d[6:8]} {t} {cfg.get('callsign', ''):<13} {r.get('rst_sent') or '59':>3} {sent:<6} "
                     f"{r['call']:<13} {r.get('rst_rcvd') or '59':>3} {rcvd:<6}")
    lines.append("END-OF-LOG:")
    name = f"{(cfg.get('callsign') or 'log').replace('/', '_')}_{(contest or 'contest').replace(' ', '_')}.log"
    return Response("\r\n".join(lines) + "\r\n", media_type="text/plain; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/qso")
async def qso_add(rec: dict):
    try:
        q = book.add(complete_qso(rec))
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast({"type": "qso", "qso": q, "source": "manual"})
    auto_upload(q["id"])
    return q


@app.get("/api/qso/{qid}")
async def qso_get(qid: int):
    q = book.get(qid)
    if not q:
        raise HTTPException(404, "QSO nicht gefunden")
    return q


@app.put("/api/qso/{qid}")
async def qso_update(qid: int, rec: dict):
    q = book.update(qid, rec)
    if not q:
        raise HTTPException(404, "QSO nicht gefunden")
    await broadcast({"type": "qso_changed", "qso": q})
    return q


@app.delete("/api/qso/{qid}")
async def qso_delete(qid: int):
    if not book.delete(qid):
        raise HTTPException(404, "QSO nicht gefunden")
    await broadcast({"type": "qso_deleted", "id": qid})
    return {"ok": True}


@app.get("/api/adif")
async def adif_export():
    text = adif.export([{k: v for k, v in r.items() if k not in ("id", "created") and v not in (None, "")}
                        for r in book.all()], version=VERSION)
    name = f"{(cfg.get('callsign') or 'log').replace('/', '_')}_{datetime.now():%Y%m%d}.adi"
    return Response(text, media_type="text/plain; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/adif")
async def adif_import(file: UploadFile):
    text = (await file.read()).decode("utf-8", "replace")
    added = dupes = errors = 0
    for r in adif.parse(text):
        try:
            r = complete_qso(r)
            if book.exists(r.get("call", ""), r.get("qso_date", ""), r.get("time_on", ""), r.get("band", "")):
                dupes += 1
                continue
            book.add(r)
            added += 1
        except Exception:
            errors += 1
    await broadcast({"type": "reload"})
    return dict(added=added, duplicates=dupes, errors=errors)


@app.get("/api/spots")
async def spots():
    sets = book.worked_sets()
    return [enrich_spot(s, sets) for s in list(cluster.spots)]


@app.post("/api/cluster/send")
async def cluster_send(body: dict):
    try:
        await cluster.send(body["cmd"])
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True}


@app.get("/api/map")
async def map_points():
    pts = []
    for r in book.all():
        info = describe(r["call"], r.get("gridsquare") or "")
        if info.get("lat") is not None:
            pts.append(dict(call=r["call"], lat=info["lat"], lon=info["lon"], band=r.get("band"), mode=r.get("mode"),
                            date=r.get("qso_date"), country=info.get("country"), exact=info["pos_from"] == "grid"))
    return dict(home=home(), points=pts)


# ---------- Logbuecher ----------
@app.get("/api/logbooks")
async def logbooks_list():
    return dict(current=current_logbook(), logbooks=[dict(name=n, qsos=logbooks.get(n).query("", [], limit=1)[1]) for n in logbooks.names()])


@app.post("/api/logbooks")
async def logbooks_create(body: dict):
    try:
        n = logbooks.create(str(body.get("name", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast({"type": "logbooks"})
    return {"name": n}


@app.post("/api/logbooks/select")
async def logbooks_select(body: dict):
    n = body.get("name")
    if n not in logbooks.names():
        raise HTTPException(404, "Logbuch nicht gefunden")
    cfg["logbook"] = n; CFG_PATH.write_text(json.dumps(cfg, indent=2))
    await broadcast({"type": "logbooks"}); await broadcast({"type": "reload"})
    return {"current": n}


@app.post("/api/logbooks/rename")
async def logbooks_rename(body: dict):
    try:
        n = logbooks.rename(body["old"], body["new"])
    except (ValueError, KeyError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    if cfg.get("logbook") == body["old"]:
        cfg["logbook"] = n; CFG_PATH.write_text(json.dumps(cfg, indent=2))
    await broadcast({"type": "logbooks"})
    return {"name": n}


@app.delete("/api/logbooks/{name}")
async def logbooks_delete(name: str):
    if len(logbooks.names()) <= 1:
        raise HTTPException(400, "Das letzte Logbuch kann nicht gelöscht werden")
    logbooks.delete(name)
    await broadcast({"type": "logbooks"})
    return {"ok": True}


@app.post("/api/logbooks/backup")
async def logbooks_backup(body: dict):
    return {"file": await asyncio.to_thread(logbooks.backup, body.get("name") or current_logbook())}


@app.get("/api/backups")
async def backups_list():
    return logbooks.backups()


@app.get("/api/backups/{file}")
async def backups_get(file: str):
    p = logbooks.bak / Path(file).name
    if not p.exists():
        raise HTTPException(404, "nicht gefunden")
    return Response(p.read_bytes(), media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{p.name}"'})


@app.post("/api/backups/restore")
async def backups_restore(body: dict):
    try:
        n = logbooks.restore(body["file"], body.get("name", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast({"type": "logbooks"})
    return {"name": n}


@app.post("/api/qso/transfer")
async def qso_transfer(body: dict):
    """Kopieren/Verschieben in ein anderes Logbuch."""
    target = body.get("target")
    if target not in logbooks.names():
        raise HTTPException(404, "Ziel-Logbuch nicht gefunden")
    src_name = body.get("source") or current_logbook()
    src, dst = logbooks.get(src_name), logbooks.get(target)
    n = 0
    for q in src.by_ids([int(i) for i in body.get("ids", [])]):
        if not dst.exists(q["call"], q.get("qso_date", ""), q.get("time_on", ""), q.get("band", "")):
            dst.add({k: v for k, v in q.items() if k not in ("id", "created")}); n += 1
        if body.get("move"):
            src.delete(q["id"])
    await broadcast({"type": "reload"})
    return {"copied": n}


# ---------- Zusatzbereiche ----------
@app.get("/api/solar")
async def solar_data():
    return await asyncio.to_thread(extras.solar, DATA)


# ---------- SSTV-Bilder (empfangene Bilder des Digitalbetrieb) ----------
SSTV_DIR = DATA / "sstv"


@app.post("/api/sstv")
async def sstv_save(body: dict):
    import base64
    png = str(body.get("png", ""))
    if not png.startswith("data:image/png;base64,"):
        raise HTTPException(400, "PNG erwartet")
    raw = base64.b64decode(png.split(",", 1)[1])
    if len(raw) > 8_000_000 or raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(400, "ungueltiges Bild")
    SSTV_DIR.mkdir(exist_ok=True)
    mode = re.sub(r"[^A-Za-z0-9]", "", str(body.get("mode", "")))[:20] or "SSTV"
    name = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + f"_{mode}.png"
    (SSTV_DIR / name).write_bytes(raw)
    files = sorted(SSTV_DIR.glob("*.png"))
    for old in files[:-500]:          # hoechstens 500 Bilder behalten
        old.unlink()
    return {"name": name}


@app.get("/api/sstv")
async def sstv_list():
    out = []
    for f in sorted(SSTV_DIR.glob("*.png"), reverse=True) if SSTV_DIR.exists() else []:
        d, t, mode = (f.stem.split("_") + ["", "", ""])[:3]
        out.append(dict(name=f.name, mode=mode, time=f"{d[6:8]}.{d[4:6]}.{d[:4]} {t[:2]}:{t[2:4]} UTC"))
    return {"images": out}


def _sstv_file(name: str) -> Path:
    p = SSTV_DIR / Path(name).name
    if p.suffix != ".png" or not p.exists():
        raise HTTPException(404, "Bild nicht gefunden")
    return p


@app.get("/api/sstv/{name}")
async def sstv_get(name: str):
    return FileResponse(_sstv_file(name), media_type="image/png")


@app.delete("/api/sstv/{name}")
async def sstv_delete(name: str):
    _sstv_file(name).unlink()
    return {"ok": True}


@app.post("/api/shutdown")
async def shutdown(request: Request):
    """Nur fuer das Desktop-Programm auf diesem Rechner: Dienst sauber beenden (Funkgeraete/Rotor-Prozesse werden gestoppt)."""
    if os.environ.get("WW_DESKTOP") != "1" or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "nicht erlaubt")
    srv = getattr(app.state, "server", None)
    if srv:
        srv.should_exit = True
    return {"ok": True}


# ---------- Stationsprofile ----------
@app.get("/api/stations")
async def stations_get():
    return load_stations()


@app.put("/api/stations")
async def stations_put(body: dict):
    keep = ("id", "name", "callsign", "operator", "locator", "tx_pwr", "my_pota_ref", "my_sota_ref", "my_wwff_ref", "rig", "antenna", "notes")
    lst = []
    for i, x in enumerate(body.get("list") or []):
        x = {k: str(x.get(k) or "").strip() for k in keep}
        x["id"] = x["id"] or f"s{int(time.time() * 1000) % 10**9}{i}"
        if x["locator"] and not geo.valid_grid(x["locator"]):
            raise HTTPException(400, f"Locator ungültig: {x['locator']}")
        lst.append(x)
    active = body.get("active") or ""
    if active and not any(x["id"] == active for x in lst):
        active = ""
    data = {"active": active, "list": lst}
    STATIONS_PATH.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    await broadcast({"type": "stations", "stations": data})
    await identity_changed()
    return data


# ---------- POTA / SOTA / WWFF ----------
@app.get("/api/programs/spots")
async def program_spots(prog: str = "pota,sota,wwff"):
    want = [p for p in prog.lower().split(",") if p in programs.PROGS]
    sp = await asyncio.to_thread(programs.spots, want)
    got = programs.hunted(book.query("pota_ref IS NOT NULL OR sota_ref IS NOT NULL OR wwff_ref IS NOT NULL", limit=1000000)[0])
    calls = {c.split("/")[0] for c in book.worked_sets()[2]}
    for s in sp:
        refs = programs.refs_of(s["ref"])
        s["worked_ref"] = bool(refs) and all(r in got[s["prog"]]["refs"] for r in refs)
        s["worked_call"] = s["call"].split("/")[0] in calls
        s["band"] = band_for(s["freq"])
    return {"spots": sp}


@app.get("/api/programs/refs")
async def program_refs(prog: str, q: str = ""):
    if prog not in programs.PROGS:
        raise HTTPException(400, "unbekanntes Programm")
    return {"refs": await asyncio.to_thread(programs.find_refs, prog, q, DATA)}


@app.get("/api/programs/ref/{prog}/{ref}")
async def program_ref(prog: str, ref: str):
    if prog not in programs.PROGS:
        raise HTTPException(400, "unbekanntes Programm")
    r = await asyncio.to_thread(programs.ref_info, prog, ref, DATA)
    if not r:
        raise HTTPException(404, "Referenz nicht gefunden")
    return r


@app.get("/api/programs/stats")
async def program_stats():
    rows, _ = book.query("pota_ref IS NOT NULL OR sota_ref IS NOT NULL OR wwff_ref IS NOT NULL OR my_pota_ref IS NOT NULL OR my_sota_ref IS NOT NULL OR my_wwff_ref IS NOT NULL", limit=1000000)
    h = programs.hunted(rows)
    return {p: dict(hunted=len(h[p]["refs"]), qsos=sum(h[p]["refs"].values()), p2p=h[p]["p2p"], activations=h[p]["activated"][:200],
                    refs=sorted(h[p]["refs"].items())[:5000]) for p in programs.PROGS}


@app.get("/api/programs/activation")
async def program_activation(prog: str, ref: str, date: str = ""):
    """Aktivierung: QSOs eines Tages (UTC) mit eigener Referenz; Zaehler fuer die Mindestanzahl."""
    if prog not in programs.PROGS:
        raise HTTPException(400, "unbekanntes Programm")
    date = date or datetime.now(timezone.utc).strftime("%Y%m%d")
    rows, _ = book.query(f"qso_date = ? AND my_{prog}_ref LIKE ?", [date, f"%{ref.upper()}%"], limit=100000)
    uniq = {(r.get("call"), r.get("band"), r.get("mode")) for r in rows}
    need = {"pota": 10, "sota": 4, "wwff": 44}[prog]
    dupes = len(rows) - len(uniq)
    return {"date": date, "ref": ref.upper(), "qsos": len(rows), "unique": len(uniq), "need": need, "valid": len(uniq) >= need, "dupes": dupes,
            "p2p": sum(1 for r in rows if r.get(f"{prog}_ref"))}


@app.get("/api/programs/export")
async def program_export(prog: str, ref: str, date: str = ""):
    if prog not in programs.PROGS:
        raise HTTPException(400, "unbekanntes Programm")
    where, args = f"my_{prog}_ref LIKE ?", [f"%{ref.upper()}%"]
    if date:
        where += " AND qso_date = ?"
        args.append(date)
    rows, _ = book.query(where, args, order="qso_date, time_on", limit=100000)
    if not rows:
        raise HTTPException(404, "Keine QSOs für diese Aktivierung")
    call = (rows[0].get("station_callsign") or cfg.get("callsign") or "CALL").replace("/", "-")
    day = date or rows[0].get("qso_date", "")
    if prog == "sota":
        return Response(programs.sota_csv(rows, ref.upper()), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{call}_{ref.upper().replace("/", "-")}_{day}.csv"'})
    sep = "@" if prog == "pota" else "_"
    return Response(programs.activation_adif(rows, prog, ref.upper()), media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{call}{sep}{ref.upper()}-{day}.adi"'})


@app.post("/api/programs/selfspot")
async def program_selfspot(body: dict):
    """Eigenen POTA-Spot setzen (wie auf pota.app). Erfordert Rufzeichen, Park, Frequenz und Mode."""
    ref, freq, mode = str(body.get("ref", "")).strip(), int(body.get("freq") or 0), str(body.get("mode", "")).strip()
    call = (body.get("call") or (active_station() or {}).get("callsign") or cfg.get("callsign") or "").strip()
    if not (ref and freq and mode and call):
        raise HTTPException(400, "Rufzeichen, Park, Frequenz und Mode werden gebraucht")
    try:
        return await asyncio.to_thread(programs.post_pota_spot, call, call, freq, ref, mode, str(body.get("comment", ""))[:100])
    except Exception as e:
        raise HTTPException(502, f"POTA-Spot nicht gesendet: {e}")


# ---------- N1MM Logger+ ----------
N1MM = {"tr": None}


async def on_n1mm(tag: str, rec: dict):
    # ADIF-konform: USB/LSB sind Submodes von SSB; Band aus der Frequenz
    if rec.get("mode") in ("USB", "LSB"):
        rec["submode"], rec["mode"] = rec["mode"], "SSB"
    if rec.get("freq") and not rec.get("band"):
        rec["band"] = band_for(float(rec["freq"]) * 1e6)
    m = book.find_match(rec.get("call", ""), rec.get("qso_date", ""), rec.get("time_on", ""), rec.get("band", ""), rec.get("mode", ""))
    if tag == "contactdelete":
        if m:
            book.delete(m["id"])
            await broadcast({"type": "reload"})
        return
    if tag == "contactreplace" and m:
        q = book.update(m["id"], complete_qso({**m, **rec}))
        await broadcast({"type": "qso_changed", "qso": q})
        return
    if m:
        return
    q = book.add(complete_qso(await enrich_callbook(rec)))
    log.info("N1MM: %s %s %s geloggt", q["call"], q.get("band"), q.get("mode"))
    await broadcast({"type": "qso", "qso": q, "source": "N1MM"})
    auto_upload(q["id"])


async def on_adif_udp(rec: dict):
    if rec.get("freq") and not rec.get("band"):
        try:
            rec["band"] = band_for(float(rec["freq"]) * 1e6)
        except ValueError:
            pass
    if rec.get("mode") in ("USB", "LSB"):
        rec["submode"], rec["mode"] = rec["mode"], "SSB"
    if book.find_match(rec.get("call", ""), rec.get("qso_date", ""), rec.get("time_on", ""), rec.get("band", ""), rec.get("mode", "")):
        return
    q = book.add(complete_qso(await enrich_callbook(rec)))
    log.info("ADIF-UDP: %s %s %s geloggt", q["call"], q.get("band"), q.get("mode"))
    await broadcast({"type": "qso", "qso": q, "source": "UDP-ADIF"})
    auto_upload(q["id"])


async def restart_n1mm():
    for key, port, fn, cb in (("tr", int(cfg.get("n1mm_port") or 0), links.listen_n1mm, on_n1mm),
                              ("adif", int(cfg.get("adif_udp_port") or 0), links.listen_adif_udp, on_adif_udp)):
        if N1MM.get(key):
            N1MM[key].close()
            N1MM[key] = None
        if port:
            try:
                N1MM[key] = await fn(port, cb)
            except OSError as e:
                log.warning("UDP-Port %d nicht verfügbar: %s", port, e)


# ---------- Google-Earth-Export (KML) ----------
@app.get("/api/kml")
async def kml_export(ids: str = "", q: str = ""):
    rows = _sel_qsos(ids, q) if ids or q else book.all()
    marks = []
    for r in rows:
        ll = geo.grid_to_latlon(r.get("gridsquare", "")) if r.get("gridsquare") else None
        if not ll:
            info = describe(r.get("call", ""))
            ll = (info.get("lat"), info.get("lon")) if info.get("lat") is not None else None
        if not ll:
            continue
        d = r.get("qso_date", "")
        desc = f"{d[6:8]}.{d[4:6]}.{d[:4]} {(r.get('time_on') or '')[:4]} UTC · {r.get('band', '')} {r.get('mode', '')} · {r.get('name', '')} {r.get('qth', '')} · {r.get('country', '')}"
        marks.append(f"<Placemark><name>{_esc(r.get('call'))}</name><description>{_esc(desc)}</description>"
                     f"<Point><coordinates>{ll[1]:.5f},{ll[0]:.5f},0</coordinates></Point></Placemark>")
    home = geo.grid_to_latlon(cfg.get("locator", "")) if cfg.get("locator") else None
    if home:
        marks.insert(0, f"<Placemark><name>{_esc(cfg.get('callsign') or 'Station')}</name><Point><coordinates>{home[1]:.5f},{home[0]:.5f},0</coordinates></Point></Placemark>")
    doc = ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Wellenwerk-Logbuch</name>'
           + "".join(marks) + "</Document></kml>")
    return Response(doc, media_type="application/vnd.google-earth.kml+xml", headers={"Content-Disposition": 'attachment; filename="wellenwerk.kml"'})


# ---------- Datenbank pruefen, automatische Sicherung ----------
@app.post("/api/logbooks/check")
async def logbook_check(body: dict | None = None):
    name = (body or {}).get("name") or current_logbook()
    db = logbooks.get(name).db
    def run():
        res = db.execute("PRAGMA integrity_check").fetchall()
        db.execute("VACUUM")
        return [r[0] for r in res]
    res = await asyncio.to_thread(run)
    return {"ok": res == ["ok"], "result": res[:20]}


BACKUP_WAKE = asyncio.Event()


async def auto_backup_loop():
    """Taeglich alle Logbuecher in den gewaehlten Ordner sichern (z. B. Dropbox-, OneDrive- oder Google-Drive-Ordner)."""
    while True:
        BACKUP_WAKE.clear()
        target = (cfg.get("backup_dir") or "").strip()
        if target:
            try:
                d = Path(target).expanduser()
                d.mkdir(parents=True, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d")
                for name in logbooks.names():
                    dst = d / f"Wellenwerk_{name}_{stamp}.sqlite"
                    if not dst.exists():
                        await asyncio.to_thread(_backup_to, name, dst)
                keep = int(cfg.get("backup_keep") or 30)
                files = sorted(d.glob("Wellenwerk_*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
                for old in files[keep * max(1, len(logbooks.names())):]:
                    old.unlink()
            except Exception as e:
                log.warning("Automatische Sicherung: %s", e)
        try:
            await asyncio.wait_for(BACKUP_WAKE.wait(), 3600)
        except asyncio.TimeoutError:
            pass


def _backup_to(name: str, dst: Path):
    import sqlite3
    out = sqlite3.connect(dst)
    with out:
        logbooks.get(name).db.backup(out)
    out.close()


# ---------- Erweiterungen (Plugins) ----------
async def _plugin_log_qso(rec: dict, source: str) -> dict:
    q = book.add(complete_qso(await enrich_callbook(dict(rec))))
    await broadcast({"type": "qso", "qso": q, "source": source})
    auto_upload(q["id"])
    return q


plugin_host = PluginHost(DATA / "plugins", cfg, dict(station=lambda: station_identity(), public_cfg=lambda: public_cfg(),
                                                      broadcast=lambda m: broadcast(m), rig=rig, radios=radios, log_qso=_plugin_log_qso))


@app.get("/api/plugins", tags=["Erweiterungen"])
async def plugins_list():
    """Installierte Erweiterungen mit Zustand und (maskierten) Einstellungen."""
    return plugin_host.listing()


@app.put("/api/plugins/{pid}", tags=["Erweiterungen"])
async def plugins_put(pid: str, body: dict):
    try:
        plugin_host.set_state(pid, body.get("enabled"), body.get("settings"))
    except PluginError as e:
        raise HTTPException(400, str(e))
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    restart = False
    if body.get("enabled") is True:
        plugin_host.load_backends(app)
        app.openapi_schema = None
    elif body.get("enabled") is False:
        plugin_host.unload(pid, app)
    await broadcast({"type": "plugins"})
    return dict(ok=True, restart=restart, plugins=plugin_host.listing())


@app.post("/api/plugins/install", tags=["Erweiterungen"])
async def plugins_install(file: UploadFile):
    try:
        pid = plugin_host.install_zip(await file.read())
    except (PluginError, ValueError) as e:
        raise HTTPException(400, f"Installation nicht möglich: {e}")
    await broadcast({"type": "plugins"})
    return dict(ok=True, id=pid)


@app.get("/api/plugins/examples", tags=["Erweiterungen"])
async def plugins_examples():
    """Mitgelieferte Beispiel-Erweiterungen (zum Ausprobieren und als Vorlage)."""
    ex = BASE / "beispiele" / "plugins"
    return [json.loads((d / "manifest.json").read_text(encoding="utf-8")) | {"id": d.name} for d in sorted(ex.iterdir())
            if (d / "manifest.json").is_file()] if ex.is_dir() else []


@app.post("/api/plugins/examples/{pid}", tags=["Erweiterungen"])
async def plugins_install_example(pid: str):
    src = (BASE / "beispiele" / "plugins" / pid)
    if not src.is_dir() or "/" in pid or ".." in pid:
        raise HTTPException(404, "Beispiel nicht gefunden")
    dst = plugin_host.root / pid
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    await broadcast({"type": "plugins"})
    return {"ok": True, "id": pid}


@app.delete("/api/plugins/{pid}", tags=["Erweiterungen"])
async def plugins_delete(pid: str):
    try:
        plugin_host.unload(pid, app)
        plugin_host.remove(pid)
    except PluginError as e:
        raise HTTPException(400, str(e))
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    await broadcast({"type": "plugins"})
    return {"ok": True}


@app.get("/plugins/{pid}/{path:path}", include_in_schema=False)
async def plugin_file(pid: str, path: str):
    base = (plugin_host.root / pid).resolve()
    f = (base / path).resolve()
    if not str(f).startswith(str(base) + os.sep) or not f.is_file() or "daten" in f.relative_to(base).parts[:1]:
        raise HTTPException(404, "nicht gefunden")
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


# ---------- CAT-Emulation (TS-2000) fuer Fremdprogramme ----------
def _catemu_notify(st):
    try:
        asyncio.get_event_loop().create_task(broadcast(dict(type="catemu", catemu=st)))
    except RuntimeError:
        pass


catemu = CatEmu(rig, _catemu_notify)


async def apply_catemu():
    if cfg.get("catemu_on"):
        await catemu.start(cfg.get("catemu_kind") or "pty", int(cfg.get("catemu_port") or 4590), cfg.get("catemu_device") or "")
    else:
        await catemu.stop()


@app.get("/api/catemu")
async def catemu_status():
    return catemu.status


# ---------- Schnappschuesse (kompletter Geraetezustand) ----------
SNAP_PATH = DATA / "snapshots.json"
# nie in Schnappschuesse: Einmal-Aktionen (wuerden senden, abstimmen oder scannen) und Werte, die die Frequenz verstellen
SNAP_SKIP_LEVELS = {"BAND_SELECT", "METER"}
SNAP_SKIP_FUNCS = {"TUNER", "TBURST", "SEND_MORSE", "SEND_VOICE_MEM", "RESUME", "SYNC", "OVF_STATUS", "SCOPE", "TRANSCEIVE"}


def _snaps() -> list:
    try:
        return json.loads(SNAP_PATH.read_text())
    except (OSError, ValueError):
        return []


@app.get("/api/snapshots")
async def snapshots_list():
    return _snaps()


@app.post("/api/snapshots")
async def snapshot_take(body: dict):
    r = radios.rig()
    if not r or not r.state.get("connected"):
        raise HTTPException(400, "Kein Funkgerät verbunden")
    st, caps = r.state, r.caps
    keep_l = set(caps.get("levels_set", [])) - SNAP_SKIP_LEVELS
    snap = dict(id=os.urandom(4).hex(), name=(body.get("name") or "").strip()[:60] or datetime.now().strftime("%d.%m. %H:%M"),
                created=datetime.now(timezone.utc).isoformat(timespec="seconds"), model=f"{caps.get('mfg', '')} {caps.get('model', '')}".strip(),
                state=dict(freq=st.get("freq"), mode=st.get("mode"), passband=st.get("passband"), split=st.get("split"),
                           vfob_freq=st.get("vfob_freq"), vfob_mode=st.get("vfob_mode"), rit=st.get("rit"), xit=st.get("xit"),
                           levels={k: v for k, v in (st.get("levels") or {}).items() if k in keep_l},
                           funcs={k: v for k, v in (st.get("funcs") or {}).items() if k in set(caps.get("funcs_set", [])) - SNAP_SKIP_FUNCS}))
    lst = _snaps() + [snap]
    SNAP_PATH.write_text(json.dumps(lst, indent=1))
    return snap


@app.post("/api/snapshots/{sid}/apply")
async def snapshot_apply(sid: str):
    snap = next((x for x in _snaps() if x["id"] == sid), None)
    if not snap:
        raise HTTPException(404, "Schnappschuss nicht gefunden")
    r = radios.rig()
    if not r or not r.state.get("connected"):
        raise HTTPException(400, "Kein Funkgerät verbunden")
    st, done, skipped = snap["state"], [], []

    async def step(label, coro):
        try:
            await coro
            done.append(label)
        except Exception as e:
            skipped.append(f"{label} ({e})")
    # Reihenfolge: Regler und Schalter, dann Betriebsart/Frequenz (damit nichts sie wieder verstellt), Sperre zuletzt
    for k, v in (st.get("levels") or {}).items():
        if k not in SNAP_SKIP_LEVELS:
            await step(k, r.set_level(k, float(v)))
    funcs = {k: v for k, v in (st.get("funcs") or {}).items() if k not in SNAP_SKIP_FUNCS}
    lock = funcs.pop("LOCK", None)
    for k, v in funcs.items():
        await step(k, r.set_func(k, bool(v)))
    if st.get("mode"):
        await step("Betriebsart", r.set_mode(st["mode"], int(st.get("passband") or 0)))
    if st.get("freq"):
        await step("Frequenz", r.set_freq(int(st["freq"])))
    if st.get("split") is not None:
        await step("Split", r.set_split(bool(st["split"])))
        if st.get("split") and st.get("vfob_freq"):
            await step("Sendefrequenz", r.set_split_freq(int(st["vfob_freq"])))
    if st.get("rit"):
        await step("RIT", r.set_rit(int(st["rit"])))
    if lock is not None:
        await step("Sperre", r.set_func("LOCK", bool(lock)))
    return dict(done=done, skipped=skipped)


@app.delete("/api/snapshots/{sid}")
async def snapshot_delete(sid: str):
    SNAP_PATH.write_text(json.dumps([x for x in _snaps() if x["id"] != sid], indent=1))
    return {"ok": True}


# ---------- Winlink ----------
def _wl_notify(msg: dict):
    asyncio.get_event_loop().create_task(broadcast(msg))


winlink = Winlink(DATA / "winlink", cfg, lambda on: rig.set_ptt(on), _wl_notify, lambda hz: rig.set_freq(hz), VERSION, identity=station_identity)


chat = Chat(cfg, station_identity, lambda on: rig.set_ptt(on), _wl_notify, lambda hz: rig.set_freq(hz),
            lambda: bool(winlink.state.get("busy")))


@app.get("/api/chat/state", tags=["Chat"])
async def chat_state():
    return chat.snapshot()


@app.post("/api/chat/connect", tags=["Chat"])
async def chat_connect(body: dict):
    """Chat starten: method ardop|vara|packet|telnet, target (Rufzeichen bzw. host:port), listen (auf Anrufe warten), freq (kHz)."""
    try:
        chat.start(body.get("method", "ardop"), body.get("target", ""), bool(body.get("listen")), str(body.get("freq") or ""))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return chat.snapshot()


@app.post("/api/chat/send", tags=["Chat"])
async def chat_send(body: dict):
    try:
        await chat.send(str(body.get("text", ""))[:2000])
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/chat/stop", tags=["Chat"])
async def chat_stop():
    await chat.stop()
    return chat.snapshot()


@app.get("/api/winlink/state")
async def wl_state():
    return winlink.snapshot()


@app.get("/api/winlink/folder/{folder}")
async def wl_folder(folder: str):
    if folder not in ("in", "out", "sent", "archive"):
        raise HTTPException(404, "Ordner unbekannt")
    return winlink.box.list(folder)


@app.get("/api/winlink/msg/{folder}/{mid}")
async def wl_msg(folder: str, mid: str):
    try:
        m = winlink.box.get(folder, mid)
    except (ValueError, OSError):
        raise HTTPException(404, "Nachricht nicht gefunden")
    return dict(m.summary(), text=m.text(), headers=m.headers)


@app.get("/api/winlink/att/{folder}/{mid}/{idx}")
async def wl_att(folder: str, mid: str, idx: int):
    try:
        name, data = winlink.box.get(folder, mid, mark_read=False).files[idx]
    except (ValueError, OSError, IndexError):
        raise HTTPException(404, "Anhang nicht gefunden")
    from urllib.parse import quote
    return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


@app.post("/api/winlink/compose")
async def wl_compose(body: dict):
    import base64
    mycall = station_identity()["winlink_call"]
    if not mycall:
        raise HTTPException(400, "Rufzeichen fehlt (Programmoptionen)")
    split = lambda v: [a for a in re.split(r"[,;\s]+", v or "") if a]
    files = []
    for f in body.get("files") or []:
        try:
            files.append((str(f["name"])[:200], base64.b64decode(f["data"])))
        except (KeyError, ValueError):
            raise HTTPException(400, "Anhang unlesbar")
    if sum(len(d) for _, d in files) > 2_000_000:
        raise HTTPException(400, "Anhänge zu groß (Funkbetrieb: möglichst unter 100 kB)")
    m = WlMessage.compose(mycall, split(body.get("to")), split(body.get("cc")), (body.get("subject") or "").strip(),
                          body.get("text") or "", files)
    err = m.validate()
    if err:
        raise HTTPException(400, err)
    winlink.box.store("out", m)
    await broadcast(dict(type="winlink", state=winlink.state, counts=winlink.box.counts()))
    return m.summary()


@app.post("/api/winlink/move")
async def wl_move(body: dict):
    try:
        winlink.box.move(body["src"], body["dst"], body["mid"])
    except (KeyError, ValueError, OSError) as e:
        raise HTTPException(400, f"Verschieben nicht möglich: {e}")
    await broadcast(dict(type="winlink", state=winlink.state, counts=winlink.box.counts()))
    return {"ok": True}


@app.delete("/api/winlink/msg/{folder}/{mid}")
async def wl_delete(folder: str, mid: str):
    try:
        winlink.box.delete(folder, mid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast(dict(type="winlink", state=winlink.state, counts=winlink.box.counts()))
    return {"ok": True}


@app.post("/api/winlink/connect")
async def wl_connect(body: dict):
    if chat.state.get("phase"):
        raise HTTPException(400, "Das Modem wird gerade vom Chat benutzt")
    try:
        winlink.start(body.get("method", "telnet"), body.get("target", ""), body)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return winlink.snapshot()


@app.post("/api/winlink/abort")
async def wl_abort():
    await winlink.abort()
    return winlink.snapshot()


@app.get("/api/rotor/log")
async def rotor_log():
    return Response(ROTLOG.read_text(encoding="utf-8")[-200000:] if ROTLOG.exists() else "", media_type="text/plain; charset=utf-8")


@app.get("/api/calendar")
async def contest_calendar():
    r = await asyncio.to_thread(extras.calendar, DATA)
    sets = book.worked_sets()
    for x in r["dx"]:
        info = describe(x["call"].split("/")[0].split(",")[0].strip(), "")
        x["dxcc"] = info.get("dxcc")
        x["needed"] = bool(x["dxcc"]) and x["dxcc"] not in sets[0]
    return r


@app.get("/api/swdb")
async def sw_database(khz: float | None = None, span: float = 5, now: bool = False, q: str = ""):
    return await asyncio.to_thread(extras.swdb_query, DATA, khz, span, now, q)


@app.get("/api/decodes")
async def decodes():
    return list(DECODES)


@app.get("/api/cluster/info")
async def cluster_info():
    return dict(info=cluster.info, lines=list(cluster.lines)[-100:])


@app.post("/api/recordings")
async def recording_upload(file: UploadFile, call: str = ""):
    data = await file.read()
    if len(data) > 50_000_000:
        raise HTTPException(400, "Aufnahme zu groß")
    return {"file": extras.save_recording(DATA, data, call)}


@app.get("/api/recordings")
async def recording_list():
    return extras.recordings(DATA)


@app.get("/api/recordings/{file}")
async def recording_get(file: str):
    p = DATA / "recordings" / Path(file).name
    if not p.exists():
        raise HTTPException(404, "nicht gefunden")
    return Response(p.read_bytes(), media_type="audio/webm")


@app.get("/api/store/{key}")
async def store_get(key: str):
    p = extras.store_path(DATA, key)
    return json.loads(p.read_text()) if p.exists() else None


@app.put("/api/store/{key}")
async def store_put(key: str, request: Request):
    body = await request.json()
    extras.store_path(DATA, key).write_text(json.dumps(body))
    return {"ok": True}


@app.post("/api/rig/raw")
async def rig_raw(body: dict):
    """Freier CAT-Befehl fuer eigene Tasten. Hamlib 'send_cmd'."""
    cmd = str(body.get("cmd", "")).strip()
    if not cmd:
        raise HTTPException(400, "Befehl fehlt")
    try:
        kv, vals = await rig._cmd("w " + cmd)
    except RigError as e:
        raise HTTPException(400, str(e) or "Funkgerät nimmt keine freien CAT-Befehle an")
    except Exception as e:
        raise HTTPException(502, str(e) or "Funkgerät nimmt keine freien CAT-Befehle an")
    return {"ok": True, "reply": vals or list(kv.values())}


@app.get("/api/stats")
async def stats():
    return book.stats()


@app.get("/api/freedv", tags=["Digitalbetrieb"])
async def freedv_info():
    from . import freedv
    return dict(available=freedv.available(), modes=["700D", "700E", "1600"])


@app.websocket("/ws/freedv")
async def ws_freedv(websocket: WebSocket, mode: str = "700D"):
    """FreeDV-Kanal: Binaerbloecke [Art 1 Byte][PCM int16 LE, 8 kHz]. Vom Browser: 1 = Funkgeraete-Ton (Empfang),
    2 = Mikrofon (Senden). Zum Browser: 1 = dekodierte Sprache, 2 = Modemton zum Funkgeraet; dazu Text {sync, snr}."""
    from . import freedv
    await websocket.accept()
    try:
        rx, tx = freedv.FreeDV(mode), freedv.FreeDV(mode)
    except (RuntimeError, ValueError) as e:
        await websocket.send_json(dict(type="error", text=str(e)))
        await websocket.close()
        return
    await websocket.send_json(dict(type="info", mode=mode, speech_rate=rx.speech_rate, modem_rate=rx.modem_rate))
    loop = asyncio.get_running_loop()
    last = 0.0
    try:
        while True:
            msg = await websocket.receive_bytes()
            if not msg:
                continue
            kind, pcm = msg[0], np.frombuffer(msg[1:], "<i2")
            if kind == 1:
                sp = await loop.run_in_executor(None, rx.rx, pcm)
                if len(sp):
                    await websocket.send_bytes(b"\x01" + sp.astype("<i2").tobytes())
                if time.monotonic() - last > 0.25:
                    last = time.monotonic()
                    await websocket.send_json(dict(type="stats", **rx.stats()))
            elif kind == 2:
                mod = await loop.run_in_executor(None, tx.tx, pcm)
                if len(mod):
                    await websocket.send_bytes(b"\x02" + mod.astype("<i2").tobytes())
    except WebSocketDisconnect:
        pass
    finally:
        rx.close()
        tx.close()


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket, radio: str = ""):
    """Ton eines Empfaengers (KiwiSDR, OpenWebRX, SDR): Binaerbloecke [Abtastrate uint32 LE][PCM int16 LE mono]."""
    await websocket.accept()
    rid = radio or radios.current or ""
    q: asyncio.Queue = asyncio.Queue(maxsize=250)
    AUDIO_SUBS.setdefault(rid, {})[websocket] = q

    async def sender():
        while True:
            await websocket.send_bytes(await q.get())
    task = asyncio.create_task(sender())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        AUDIO_SUBS.get(rid, {}).pop(websocket, None)


@app.get("/api/sdr/receivers", tags=["Empfänger (SDR)"])
async def sdr_receivers(type: str = "", q: str = "", khz: float = 0, limit: int = 400, free: bool = False):
    """Oeffentliche Empfaenger (receiverbook.de, KiwiSDR-Liste), nach Entfernung zur eigenen Station sortiert."""
    from .sdr import lists
    rows = await asyncio.to_thread(lists.receivers, DATA, home())
    ql = q.lower().strip()
    out = []
    for r in rows:
        if type and r["type"] != type:
            continue
        if ql and ql not in (r.get("name", "") + " " + r.get("place", "") + " " + r.get("grid", "") + " " + r.get("antenna", "")).lower():
            continue
        hi = r.get("hi") or (32e6 if r["type"] == "kiwisdr" else 0)     # KiwiSDR ohne Angabe: Kurzwelle 0–32 MHz
        if khz and hi and not (r.get("lo", 0) <= khz * 1000 <= hi):
            continue
        if free and r.get("users_max") and r.get("users", 0) >= r["users_max"]:
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return dict(total=len(rows), receivers=out)


@app.post("/api/radios/{pid}/rig/{what}", tags=["Funkgerät"])
async def radio_rig_cmd(pid: str, what: str, body: dict):
    """Ein bestimmtes verbundenes Geraet steuern (auch wenn es nicht das aktuelle ist, z. B. zweiter Empfaenger):
    what = freq {hz} | mode {mode, passband} | level {name, value} | func {name, on}."""
    r = radios.rig(pid)
    if not r:
        raise HTTPException(400, "Gerät ist nicht verbunden")
    if what == "freq":
        return await _rig(r.set_freq(int(body["hz"])))
    if what == "mode":
        return await _rig(r.set_mode(str(body["mode"]).upper(), int(body.get("passband", 0))))
    if what == "level":
        return await _rig(r.set_level(str(body["name"]), float(body["value"])))
    if what == "func":
        return await _rig(r.set_func(str(body["name"]), bool(body["on"])))
    raise HTTPException(404, "unbekannter Befehl")


@app.get("/api/sdr/kinds", tags=["Empfänger (SDR)"])
async def sdr_kinds():
    from .sdr import registry
    return registry.kinds()


# Fernbetrieb-Audio: Vermittlung von WebRTC-Angeboten zwischen dem Stationsfenster (Soundkarte am Funkgeraet)
# und entfernten Fenstern. Das Audio selbst fliesst direkt zwischen den Browsern.
WS_IDS: dict = {}
AUDIO_STATION: dict = {}


async def _audio_station_changed():
    await broadcast(dict(type="audio_station", available=bool(AUDIO_STATION), name=AUDIO_STATION.get("name", ""),
                         id=AUDIO_STATION.get("id", "")))


async def _ws_message(websocket: WebSocket, text: str):
    try:
        m = json.loads(text)
    except ValueError:
        return
    me = WS_IDS.get(websocket)
    if m.get("type") == "station":
        if m.get("on"):
            AUDIO_STATION.clear()
            AUDIO_STATION.update(id=me, ws=websocket, name=str(m.get("name") or "Station")[:60])
        elif AUDIO_STATION.get("ws") is websocket:
            AUDIO_STATION.clear()
        await _audio_station_changed()
    elif m.get("type") == "rtc":
        to = m.get("to")
        target = AUDIO_STATION.get("ws") if to == "station" else next((w for w, i in WS_IDS.items() if i == to), None)
        if target is None:
            await websocket.send_json(dict(type="rtc", kind="error", text="Keine Station hat ihr Audio freigegeben"))
            return
        m["from"] = me
        try:
            await target.send_json(m)
        except Exception:
            pass


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    WS_IDS[websocket] = os.urandom(6).hex()
    try:
        await websocket.send_json(dict(type="hello", id=WS_IDS[websocket], audio_station=bool(AUDIO_STATION),
                                       audio_station_name=AUDIO_STATION.get("name", "")))
        while True:
            await _ws_message(websocket, await websocket.receive_text())
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
        gone = WS_IDS.pop(websocket, None)
        if AUDIO_STATION.get("ws") is websocket:
            AUDIO_STATION.clear()
            await _audio_station_changed()
        if gone:
            await broadcast(dict(type="rtc_gone", id=gone))


STATIC = BASE / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    # Versionsnummer an CSS/JS haengen, damit Browser nach Updates nicht alte Dateien nutzen
    stamp = int(max(p.stat().st_mtime for p in [STATIC / "style.css", *(STATIC / "js").glob("*.js")]))
    html = (STATIC / "index.html").read_text().replace("__V__", f"{VERSION}-{stamp}")
    return Response(html, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})


# Gruppen fuer die API-Beschreibung (/api/docs)
_TAGS = {"rig": "Funkgerät", "radios": "Funkgerät", "snapshots": "Funkgerät", "catemu": "Funkgerät", "qso": "Logbuch", "logbooks": "Logbuch",
         "adif": "Logbuch", "lookup": "Logbuch", "callbook": "Logbuch", "awards": "Logbuch", "upload": "Online-Dienste", "sync": "Online-Dienste",
         "spots": "DX-Cluster", "cluster": "DX-Cluster", "wsjtx": "WSJT-X", "rotor": "Rotor", "winlink": "Winlink", "sat": "Satelliten",
         "settings": "Einstellungen", "station": "Einstellungen", "stations": "Einstellungen", "programs": "POTA/SOTA/WWFF", "winkey": "CW", "sdr": "Empfänger (SDR)",
         "backups": "Logbuch", "cabrillo": "Logbuch", "kml": "Logbuch", "stats": "Logbuch", "countries": "Logbuch", "lotw": "Online-Dienste",
         "services": "Online-Dienste", "decodes": "WSJT-X", "favorites": "Funkgerät", "hamlib": "Funkgerät", "swdb": "Funkgerät",
         "recordings": "Digitalbetrieb", "sstv": "Digitalbetrieb", "bearing": "Karten & Ausbreitung", "map": "Karten & Ausbreitung",
         "solar": "Karten & Ausbreitung", "calendar": "Karten & Ausbreitung", "state": "Programm", "shutdown": "Programm", "store": "Programm",
         "access": "Zugang", "login": "Zugang", "logout": "Zugang", "plugins": "Erweiterungen", "chat": "Chat"}
for _r in app.routes:
    _p = getattr(_r, "path", "")
    if _p.startswith("/api/") and not getattr(_r, "tags", None):
        _seg = _p.split("/")[2]
        _r.tags = [_TAGS.get(_seg, "Sonstiges")]
