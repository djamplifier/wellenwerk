"""Namen zu Kennungen im Digitalfunk, im Datenordner zwischengespeichert (hoechstens woechentlich neu geladen):

- RadioID.net: DMR-IDs (user.csv) und NXDN-IDs (nxdn.csv) -> Rufzeichen, Vorname, Ort, Land.
  Daraus auch Rufzeichen -> Name (fuer D-STAR, YSF, M17, P25, die Rufzeichen senden).
- BrandMeister: Talkgroup-Nummer -> Name.
Die Daten bleiben auf dem Rechner; abgefragt wird nur die Gesamtliste, nie einzelne Kennungen."""
from __future__ import annotations

import csv
import io
import json
import logging
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("ww.ids")
UA = {"User-Agent": "Wellenwerk (Amateurfunk-Programm; github.com/djamplifier/wellenwerk)"}
WEEK = 7 * 86400
SRC = {
    "dmr": "https://radioid.net/static/user.csv",
    "nxdn": "https://radioid.net/static/nxdn.csv",
    "tg": "https://api.brandmeister.network/v2/talkgroup",
}
_db: dict = {}
_state = {"loading": False, "error": ""}
_lock = threading.Lock()


def _get(data: Path, key: str, name: str) -> bytes:
    path = data / "ids" / name
    if path.exists() and time.time() - path.stat().st_mtime < WEEK:
        return path.read_bytes()
    try:
        raw = urllib.request.urlopen(urllib.request.Request(SRC[key], headers=UA), timeout=180).read()
        if len(raw) > 1000:
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(raw)
            return raw
    except Exception as e:
        log.warning("Kennungsliste %s nicht abrufbar: %s", key, e)
        _state["error"] = str(e)
    return path.read_bytes() if path.exists() else b""


def _users(raw: bytes) -> dict[int, tuple]:
    out = {}
    for row in csv.reader(io.StringIO(raw.decode("utf-8", "replace"))):
        if len(row) < 7 or not row[0].isdigit():
            continue
        out[int(row[0])] = (row[1].strip().upper(), " ".join(x for x in (row[2].strip(), row[3].strip()) if x)[:30], row[4].strip()[:30], row[6].strip()[:24])
    return out


def _load(data: Path):
    try:
        dmr = _users(_get(data, "dmr", "radioid-user.csv"))
        nxdn = _users(_get(data, "nxdn", "radioid-nxdn.csv"))
        try:
            tg = {int(k): str(v) for k, v in json.loads(_get(data, "tg", "bm-talkgroups.json") or b"{}").items() if str(k).isdigit()}
        except ValueError:
            tg = {}
        calls = {}
        for u in list(dmr.values()) + list(nxdn.values()):
            calls.setdefault(u[0], u)
        with _lock:
            _db.update(dmr=dmr, nxdn=nxdn, tg=tg, calls=calls, t=time.time())
        log.info("Kennungen: %d DMR, %d NXDN, %d Talkgroups", len(dmr), len(nxdn), len(tg))
    finally:
        _state["loading"] = False


def ready(data: Path) -> bool:
    if _db and time.time() - _db.get("t", 0) < WEEK:
        return True
    if not _state["loading"]:
        _state["loading"] = True
        threading.Thread(target=_load, args=(data,), daemon=True, name="kennungen").start()
    return bool(_db)


def _u(t: tuple | None) -> dict | None:
    return dict(c=t[0], n=t[1], city=t[2], country=t[3]) if t else None


def lookup(data: Path, dmr=(), nxdn=(), tg=(), call=()) -> dict:
    """Namen zu den angefragten Kennungen; unbekannte fehlen in der Antwort."""
    ok = ready(data)
    out: dict = {"loading": not ok, "dmr": {}, "nxdn": {}, "tg": {}, "call": {}}
    if not ok:
        return out
    for i in dmr:
        u = _db["dmr"].get(int(i))
        if u:
            out["dmr"][str(i)] = _u(u)
    for i in nxdn:
        u = _db["nxdn"].get(int(i))
        if u:
            out["nxdn"][str(i)] = _u(u)
    for i in tg:
        n = _db["tg"].get(int(i))
        if n:
            out["tg"][str(i)] = n
    for c in call:
        base = str(c).upper().split("/")[0].split("-")[0].strip()
        u = _db["calls"].get(base)
        if u:
            out["call"][str(c)] = _u(u)
    return out
