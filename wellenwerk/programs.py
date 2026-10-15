"""Portabel-Programme: POTA (Parks on the Air), SOTA (Summits on the Air), WWFF (World Wide Flora & Fauna).

Spots und Referenzlisten kommen von den offiziellen Quellen der Programme; im Logbuch stehen die ADIF-Felder
POTA_REF/MY_POTA_REF, SOTA_REF/MY_SOTA_REF, WWFF_REF/MY_WWFF_REF. Beim Export fuer die Programm-Portale werden
zusaetzlich die von dort erwarteten Felder SIG/SIG_INFO bzw. MY_SIG/MY_SIG_INFO gesetzt."""
import csv
import io
import json
import logging
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("ww.programs")
UA = {"User-Agent": "Wellenwerk (Amateurfunk-Logbuch)"}
PROGS = ("pota", "sota", "wwff")
SPOT_URL = {"pota": "https://api.pota.app/spot/activator",
            "sota": "https://api-db2.sota.org.uk/api/spots/20/all/all",
            "wwff": "https://spots.wwff.co/static/spots.json"}
REF_URL = {"pota": "https://pota.app/all_parks_ext.csv",
           "sota": "https://storage.sota.org.uk/summitslist.csv",
           "wwff": "https://wwff.co/wwff-data/wwff_directory.csv"}
POTA_SPOT_POST = "https://api.pota.app/spot/"
_spot_cache: dict = {}
_refs: dict = {}


def _http(url: str, timeout: float = 30, data: bytes | None = None, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ---------- Spots ----------
def _norm(prog: str, s: dict) -> dict | None:
    if prog == "pota":
        f = _num(s.get("frequency"))
        return dict(prog="pota", id=f"pota{s.get('spotId')}", call=(s.get("activator") or "").upper(), ref=s.get("reference") or "",
                    name=s.get("name") or s.get("parkName") or "", loc=s.get("locationDesc") or "", freq=int(f * 1000) if f else 0,
                    mode=(s.get("mode") or "").upper(), time=(s.get("spotTime") or "") + "Z", spotter=s.get("spotter") or "",
                    comment=s.get("comments") or "", lat=_num(s.get("latitude")), lon=_num(s.get("longitude")), grid=s.get("grid6") or s.get("grid4") or "")
    if prog == "sota":
        f = _num(s.get("frequency"))
        return dict(prog="sota", id=f"sota{s.get('id')}", call=(s.get("activatorCallsign") or "").upper(), ref=s.get("summitCode") or "",
                    name=s.get("summitName") or "", loc=s.get("associationCode") or "", freq=int(f * 1e6) if f else 0,
                    mode=(s.get("mode") or "").upper(), time=s.get("timeStamp") or "", spotter=s.get("callsign") or "",
                    comment=s.get("comments") or "", lat=_num(s.get("latitude")), lon=_num(s.get("longitude")), grid="")
    if prog == "wwff":
        f = _num(s.get("frequency_khz"))
        t = s.get("spot_time")
        ts = datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(t, (int, float)) else str(t or "")
        return dict(prog="wwff", id=f"wwff{s.get('id')}", call=(s.get("activator") or "").upper(), ref=s.get("reference") or "",
                    name=s.get("reference_name") or "", loc="", freq=int(f * 1000) if f else 0, mode=(s.get("mode") or "").upper(),
                    time=ts, spotter=s.get("spotter") or "", comment=s.get("remarks") or "",
                    lat=_num(s.get("latitude")), lon=_num(s.get("longitude")), grid="")
    return None


def spots(progs=PROGS, max_age: float = 45) -> list[dict]:
    out = []
    for p in progs:
        c = _spot_cache.get(p)
        if not c or time.time() - c[0] > max_age:
            try:
                raw = json.loads(_http(SPOT_URL[p], 20))
                items = [x for x in (_norm(p, s) for s in raw if isinstance(s, dict)) if x and x["call"] and x["freq"]]
                _spot_cache[p] = (time.time(), items)
            except Exception as e:
                log.warning("%s-Spots nicht abrufbar: %s", p.upper(), e)
                _spot_cache.setdefault(p, (time.time(), []))
        out += _spot_cache[p][1]
    out.sort(key=lambda s: s["time"], reverse=True)
    return out


# ---------- Referenzlisten ----------
def _load_refs(prog: str, data_dir: Path) -> list[dict]:
    if prog in _refs:
        return _refs[prog]
    d = Path(data_dir) / "cache"
    d.mkdir(exist_ok=True)
    path = d / f"refs_{prog}.csv"
    if not path.exists() or time.time() - path.stat().st_mtime > 7 * 86400:
        try:
            path.write_bytes(_http(REF_URL[prog], 180))
        except Exception as e:
            log.warning("%s-Referenzliste nicht abrufbar: %s", prog.upper(), e)
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    if prog == "sota":
        text = text.split("\n", 1)[1]          # erste Zeile: Titel der Liste
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        if prog == "pota":
            rows.append(dict(ref=r.get("reference", ""), name=r.get("name", ""), loc=r.get("locationDesc", ""), active=r.get("active") == "1",
                             lat=_num(r.get("latitude")), lon=_num(r.get("longitude")), grid=r.get("grid", "")))
        elif prog == "sota":
            valid = (r.get("ValidTo") or "").strip()
            rows.append(dict(ref=r.get("SummitCode", ""), name=r.get("SummitName", ""), loc=f'{r.get("AssociationName", "")}, {r.get("RegionName", "")}',
                             active=not valid or valid[-4:] >= str(datetime.now().year), lat=_num(r.get("Latitude")), lon=_num(r.get("Longitude")),
                             grid="", points=r.get("Points", ""), alt=r.get("AltM", "")))
        else:
            rows.append(dict(ref=r.get("reference", ""), name=r.get("name", ""), loc=r.get("country", "") or r.get("program", ""),
                             active=r.get("status") == "active", lat=_num(r.get("latitude")), lon=_num(r.get("longitude")), grid=r.get("iaruLocator", "")))
    rows = [x for x in rows if x["ref"]]
    _refs[prog] = rows
    log.info("%s: %d Referenzen", prog.upper(), len(rows))
    return rows


def find_refs(prog: str, q: str, data_dir: Path, limit: int = 30) -> list[dict]:
    q = (q or "").strip().lower()
    if not q:
        return []
    rows = _load_refs(prog, data_dir)
    exact = [r for r in rows if r["ref"].lower() == q]
    pre = [r for r in rows if r["ref"].lower().startswith(q) and r not in exact]
    words = q.split()
    rest = [r for r in rows if r not in exact and r not in pre and all(w in (r["name"] + " " + r["loc"]).lower() for w in words)]
    return (exact + pre + rest)[:limit]


def ref_info(prog: str, ref: str, data_dir: Path) -> dict | None:
    ref = (ref or "").strip().upper()
    return next((r for r in _load_refs(prog, data_dir) if r["ref"].upper() == ref), None)


# ---------- Selbst-Spot (POTA) ----------
def post_pota_spot(activator: str, spotter: str, freq_hz: int, ref: str, mode: str, comment: str) -> dict:
    body = dict(activator=activator.upper(), spotter=spotter.upper(), frequency=f"{freq_hz / 1000:.1f}", reference=ref.upper(),
                mode=mode.upper(), source="Wellenwerk", comments=comment)
    r = _http(POTA_SPOT_POST, 20, json.dumps(body).encode(), {"Content-Type": "application/json"})
    _spot_cache.pop("pota", None)
    try:
        return json.loads(r)
    except ValueError:
        return {"ok": True}


# ---------- Logbuch-Auswertung ----------
def refs_of(v: str) -> list[str]:
    """'DE-0001, DE-0002' (N-fer) -> ['DE-0001', 'DE-0002']"""
    return [x.strip().upper() for x in re.split(r"[,;\s]+", v or "") if x.strip()]


def hunted(qsos: list[dict]) -> dict:
    """Je Programm: gearbeitete Referenzen (Jaeger) und eigene Aktivierungen."""
    out = {p: dict(refs={}, p2p=0, activated={}) for p in PROGS}
    for q in qsos:
        for p in PROGS:
            theirs, mine = refs_of(q.get(f"{p}_ref")), refs_of(q.get(f"my_{p}_ref"))
            for r in theirs:
                out[p]["refs"].setdefault(r, 0)
                out[p]["refs"][r] += 1
            if theirs and mine:
                out[p]["p2p"] += 1
            for r in mine:
                key = f"{r}|{q.get('qso_date', '')}"
                out[p]["activated"].setdefault(key, set()).add((q.get("call"), q.get("band"), q.get("mode")))
    for p in PROGS:
        acts = out[p]["activated"]
        out[p]["activated"] = [dict(ref=k.split("|")[0], date=k.split("|")[1], qsos=len(v), valid=len(v) >= (4 if p == "sota" else 10 if p == "pota" else 44))
                               for k, v in sorted(acts.items(), reverse=True)]
    return out


def activation_adif(qsos: list[dict], prog: str, ref: str) -> str:
    """ADIF fuer das Portal: MY_SIG/MY_SIG_INFO und bei Park-zu-Park SIG/SIG_INFO (so erwartet es pota.app/WWFF-Logsearch)."""
    sig = prog.upper()
    head = f"Wellenwerk {sig}-Export {ref}\n<ADIF_VER:5>3.1.4 <PROGRAMID:10>Wellenwerk <EOH>\n"
    lines = []
    for q in qsos:
        f = {"call": q.get("call"), "qso_date": q.get("qso_date"), "time_on": (q.get("time_on") or "")[:6], "band": q.get("band"),
             "mode": q.get("mode"), "submode": q.get("submode"), "freq": q.get("freq"), "rst_sent": q.get("rst_sent"), "rst_rcvd": q.get("rst_rcvd"),
             "station_callsign": q.get("station_callsign"), "operator": q.get("operator"), "my_gridsquare": q.get("my_gridsquare"),
             "my_sig": sig, "my_sig_info": ref, f"my_{prog}_ref": ref}
        theirs = q.get(f"{prog}_ref")
        if theirs:
            f.update(sig=sig, sig_info=refs_of(theirs)[0], **{f"{prog}_ref": theirs})
        lines.append(" ".join(f"<{k.upper()}:{len(str(v))}>{v}" for k, v in f.items() if v not in (None, "")) + " <EOR>")
    return head + "\n".join(lines) + "\n"


def sota_csv(qsos: list[dict], summit: str) -> str:
    """SOTA-Datenbank-Format V2: V2,Rufzeichen,Gipfel,Datum,Zeit,Band,Mode,Gegenstation,Gipfel der Gegenstation,Notiz"""
    rows = []
    for q in qsos:
        d, t = q.get("qso_date", ""), (q.get("time_on") or "")[:4]
        freq = q.get("freq") or ""
        rows.append(",".join(["V2", q.get("station_callsign") or "", summit, f"{d[6:8]}/{d[4:6]}/{d[2:4]}", t,
                              f"{float(freq):.3f}MHz" if freq else (q.get("band") or ""), q.get("mode") or "", q.get("call") or "",
                              refs_of(q.get("sota_ref"))[0] if q.get("sota_ref") else "", (q.get("comment") or "").replace(",", " ")]))
    return "\n".join(rows) + "\n"
