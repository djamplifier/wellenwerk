"""Frequenz-Datenbanken fuer Wasserfall und Signalerkennung, im Datenordner zwischengespeichert:

- Relais: hearham.com (weltweit, alle Betriebsarten, offene Daten), BrandMeister (DMR-Relais mit Colorcode
  und letztem Kontakt) und die DARC-Relaisliste von DL3EL (relais.dl3el.de, Umkreissuche, FM-Relais mit CTCSS). Optional repeatermap.de (DK3ML) mit eigenem API-Token (beim Betreiber anfragen).
- Rundfunk: EiBi-Sendeplan (eibispace.de, Saison A/B), gefiltert auf die aktuelle Sendezeit.
- Typische Frequenzen der Betriebsarten: static/freqs.json im Programm, taeglich aus dem Projekt auf GitHub aktualisiert.
Alle Abrufe mit eigener Kennung, hoechstens einmal pro Woche (Relais, Rundfunk) bzw. Tag (typische Frequenzen)."""
from __future__ import annotations

import csv
import io
import json
import logging
import math
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("ww.freqdb")
UA = {"User-Agent": "Wellenwerk (Amateurfunk-Programm; github.com/djamplifier/wellenwerk)"}
WEEK, DAY = 7 * 86400, 86400
SRC = {
    "hearham": "https://hearham.com/api/repeaters/v1",
    "brandmeister": "https://api.brandmeister.network/v2/device",
    "freqs": "https://raw.githubusercontent.com/djamplifier/wellenwerk/main/static/freqs.json",
    "eibi": "http://www.eibispace.de/dx/sked-{season}.csv",
    "dl3el": "http://relais.dl3el.de/cgi-bin/relais.pl?sel=gridsq&gs={grid}&maxgateways=200&printas=csv&type_el=1&type_il=1&type_ds=1&type_ws=1&type_dm=1&type_fr=1&type_dl3el=1&kmmls=km",
}
_lock = threading.Lock()
_cache: dict = {}


def _fetch(url: str, timeout: float = 120) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def _dist(lat1, lon1, lat2, lon2) -> float:
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(min(1.0, a)))


# ---------- Relais ----------
def _mode(m: str) -> str:
    m = (m or "").upper().replace("DSTAR", "D-STAR")
    for k, v in (("DMR", "DMR"), ("D-STAR", "D-STAR"), ("YSF", "YSF"), ("C4FM", "YSF"), ("FUSION", "YSF"), ("M17", "M17"),
                 ("NXDN", "NXDN"), ("P25", "P25"), ("TETRA", "TETRA"), ("FM", "FM")):
        if k in m:
            return v
    return m or "FM"


def _load_repeaters(data: Path) -> list[dict]:
    """Kompakte Liste aller Relais (eigene Datei repeaters.json), hoechstens woechentlich neu aufgebaut."""
    path = data / "repeaters.json"
    if path.exists() and time.time() - path.stat().st_mtime < WEEK:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    out: list[dict] = []
    try:
        for r in json.loads(_fetch(SRC["hearham"])):
            try:
                if not r.get("operational", 1) or not r.get("frequency"):
                    continue
                f, off = int(r["frequency"]), int(r.get("offset") or 0)
                out.append(dict(c=(r.get("callsign") or "").upper(), f=f, rx=f + off, m=_mode(r.get("mode")), lat=round(float(r["latitude"]), 4),
                                lon=round(float(r["longitude"]), 4), tone=(r.get("encode") or "").strip(), city=(r.get("city") or "")[:60], s="hearham"))
            except (TypeError, ValueError, KeyError):
                continue
    except Exception as e:
        log.warning("Relaisliste hearham nicht abrufbar: %s", e)
    try:
        for r in json.loads(_fetch(SRC["brandmeister"], 240)):
            try:
                tx, rx = float(r.get("tx") or 0) * 1e6, float(r.get("rx") or 0) * 1e6
                if not tx or abs(tx - rx) < 1000 or not r.get("lat"):        # Hotspots (Simplex) weglassen, nur Relais
                    continue
                out.append(dict(c=(r.get("callsign") or "").split()[0].upper(), f=int(round(tx)), rx=int(round(rx)), m="DMR", cc=r.get("colorcode"),
                                lat=round(float(r["lat"]), 4), lon=round(float(r["lng"]), 4), city=(r.get("city") or "")[:60], seen=(r.get("last_seen") or "")[:10], s="brandmeister"))
            except (TypeError, ValueError, KeyError):
                continue
    except Exception as e:
        log.warning("Relaisliste BrandMeister nicht abrufbar: %s", e)
    if len(out) > 1000:
        path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        log.info("Relaisliste: %d Eintraege", len(out))
        return out
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else out


# DARC-Relaisliste von DL3EL (relais.dl3el.de): Umkreissuche, Ausgabe als CSV. Je Gebiet (0,25 Grad) eine Anfrage pro Woche.
def _dms(v: str) -> float:
    import re
    m = re.match(r"(\d+)\D+(\d+)'([NSEWO])", v.replace("&deg;", "°"))
    if not m:
        raise ValueError(v)
    x = int(m.group(1)) + int(m.group(2)) / 60
    return -x if m.group(3) in "SW" else x


def _unent(t: str) -> str:
    """HTML-Zeichen (auch ohne abschliessendes Semikolon, z. B. „Universit&#228t“)."""
    import html
    import re
    return html.unescape(re.sub(r"&#(\d+)(?!\d|;)", r"&#\1;", t))


def _dl3el_mode(ctcss: str, node: str, info: str) -> str:
    n, i = node.upper(), info.upper()
    if ctcss.upper().startswith("CC") or "BM#" in n or "DMR" in n or "DMR" in i:
        return "DMR"
    if "W-X" in n or "YSF" in n or "C4FM" in n or "FUSION" in i:
        return "YSF"
    if n in ("A", "B", "C", "D") or "D-STAR" in n or "DSTAR" in n or "XRF" in n or "REF" in n or "DCS" in n or "D-STAR" in i:
        return "D-STAR"
    return "FM"


def dl3el(data: Path, lat: float, lon: float) -> list[dict]:
    from .geo import latlon_to_grid
    cell = (round(lat * 4) / 4, round(lon * 4) / 4)
    path = data / "relais-dl3el" / f"{cell[0]:.2f}_{cell[1]:.2f}.json"
    if path.exists() and time.time() - path.stat().st_mtime < WEEK:
        return json.loads(path.read_text(encoding="utf-8"))
    out = []
    try:
        txt = _fetch(SRC["dl3el"].format(grid=latlon_to_grid(*cell)), 60).decode("latin-1").replace("<br>", "\n").replace("&deg;", "°")   # &deg; enthaelt ein Semikolon
        for row in csv.reader(io.StringIO(txt), delimiter=";"):
            if len(row) < 9 or not row[1][:1].isdigit():
                continue
            try:
                f = int(round(float(row[1].replace(",", ".")) * 1e6))
                if abs(f - round(f / 6250) * 6250) <= 100:      # auf 4 Stellen gerundet (439,4563): aufs Kanalraster
                    f = int(round(f / 6250) * 6250)
                rx = int(round(float(row[2].replace(",", ".").rstrip(".")) * 1e6)) if row[2].strip(" .") else f
                e = dict(c=row[0].strip().upper(), f=f, rx=rx, m=_dl3el_mode(row[7], row[8], row[4]), lat=round(_dms(row[5]), 4), lon=round(_dms(row[6]), 4),
                         city=_unent(row[4]).strip()[:60], s="dl3el")
                t = row[7].strip()
                if t.upper().startswith("CC"):
                    e["cc"] = int(t[2:] or 0)
                elif t:
                    e["tone"] = t.replace("Hz", "").replace(",", ".").strip()
                out.append(e)
            except (ValueError, IndexError):
                continue
    except Exception as e:
        log.warning("Relaisliste DL3EL nicht abrufbar: %s", e)
    if out:
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    elif path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return out


def repeaters_ready(data: Path) -> bool:
    """Relaisliste geladen? Sonst Laden im Hintergrund anstossen (erster Abruf dauert bis zu einer Minute)."""
    if "rep" in _cache:
        return True
    if not _cache.get("rep_loading"):
        _cache["rep_loading"] = True
        def run():
            try:
                rep = _load_repeaters(data)
                with _lock:
                    _cache["rep"] = rep
            finally:
                _cache["rep_loading"] = False
        threading.Thread(target=run, daemon=True, name="relaisliste").start()
    return False


def repeaters(data: Path, lat: float, lon: float, radius_km: float = 80, lo: float = 0, hi: float = 0) -> list[dict]:
    """Relais im Umkreis (Ausgabefrequenz zwischen lo und hi), naechste zuerst; doppelte (gleiches Rufzeichen und Frequenz)
    zusammengefasst – BrandMeister (mit Colorcode und letztem Kontakt) vor hearham."""
    if not repeaters_ready(data):
        return []
    cand = []
    extra = dl3el(data, lat, lon) if -60 < lat < 75 else []
    for r in extra + _cache["rep"]:
        if hi and not (lo <= r["f"] <= hi):
            continue
        if abs(r["lat"] - lat) > radius_km / 100 or abs(r["lon"] - lon) > radius_km / 60:
            continue
        d = _dist(lat, lon, r["lat"], r["lon"])
        if d <= radius_km:
            x = {**r, "km": round(d, 1)}
            if x.get("m") == "DMR" and not x.get("cc") and str(x.get("tone", "")).upper().startswith("CC"):
                x["cc"], x["tone"] = int(x["tone"][2:] or 0), ""
            cand.append(x)
    # Vorrang bei Doppelten: DMR aus BrandMeister (Colorcode, letzter Kontakt), sonst die DARC-Liste (CTCSS), dann hearham
    rank = lambda r: (0 if r["s"] == "brandmeister" and r["m"] == "DMR" else 1 if r["s"] == "dl3el" else 2)
    cand.sort(key=lambda r: (rank(r), not r.get("tone"), "-" in r["c"], r["km"]))
    seen, res = set(), []
    for r in cand:
        key = (r["c"].split("-")[0], round(r["f"] / 5000))                   # DB0DOS-R (Echolink-Zugang) = DB0DOS
        if key not in seen:
            seen.add(key)
            res.append(r)
    res.sort(key=lambda r: r["km"])
    return res


# ---------- Rundfunk (EiBi) ----------
def _season(now: datetime) -> str:
    """EiBi-Saison: A = letzter Sonntag im Maerz bis letzter Sonntag im Oktober, sonst B (Jahr des Saisonbeginns)."""
    def last_sunday(y, m):
        d = datetime(y, m, 31 if m in (3, 10) else 30, tzinfo=timezone.utc)
        return d.replace(day=d.day - (d.weekday() + 1) % 7)
    y = now.year
    if last_sunday(y, 3) <= now < last_sunday(y, 10):
        return f"a{y % 100:02d}"
    return f"b{(y if now >= last_sunday(y, 10) else y - 1) % 100:02d}"


def _load_eibi(data: Path) -> list[dict]:
    now = datetime.now(timezone.utc)
    path = data / "eibi.csv"
    txt = ""
    if path.exists() and time.time() - path.stat().st_mtime < WEEK:
        txt = path.read_text(encoding="latin-1")
    else:
        for s in (_season(now), _season(now.replace(year=now.year - 1)) if now.month < 4 else ""):
            if not s:
                continue
            try:
                txt = _fetch(SRC["eibi"].format(season=s), 60).decode("latin-1")
                if len(txt) > 10000:
                    path.write_text(txt, encoding="latin-1")
                    break
            except Exception as e:
                log.warning("EiBi-Sendeplan %s nicht abrufbar: %s", s, e)
        if not txt and path.exists():
            txt = path.read_text(encoding="latin-1")
    out = []
    for row in csv.reader(io.StringIO(txt), delimiter=";"):
        if len(row) < 7 or not row[0][:1].isdigit():
            continue
        try:
            t = row[1].split("-")
            out.append(dict(f=int(round(float(row[0]) * 1000)), t0=int(t[0]), t1=int(t[1]), days=row[2].strip(), itu=row[3].strip(),
                            n=row[4].strip()[:40], lang=row[5].strip(), tgt=row[6].strip()))
        except (ValueError, IndexError):
            continue
    return out


def _day_ok(d: str, wd: int, names: list[str]) -> bool:
    """EiBi-Tage: leer = taeglich, Ziffern (1 = Montag), Bereich „Mo-Fr“, einzelne Tage „Sa“/„SaSu“; Sonstiges (irr, alt) gilt."""
    if not d:
        return True
    if d.isdigit():
        return str(wd) in d
    if len(d) == 5 and d[2] == "-" and d[:2] in names and d[3:] in names:
        a, b = names.index(d[:2]) + 1, names.index(d[3:]) + 1
        return a <= wd <= b if a <= b else (wd >= a or wd <= b)
    days = [d[i:i + 2] for i in range(0, len(d), 2)]
    return names[wd - 1] in days if all(x in names for x in days) else True


def broadcast(data: Path, lo: float, hi: float, when: datetime | None = None) -> list[dict]:
    """Rundfunksender laut EiBi, die jetzt (UTC) zwischen lo und hi senden."""
    with _lock:
        if "eibi" not in _cache or time.time() - _cache["eibi"][0] > DAY:
            _cache["eibi"] = (time.time(), _load_eibi(data))
    now = when or datetime.now(timezone.utc)
    hm, wd = now.hour * 100 + now.minute, now.isoweekday()           # 1 = Montag
    names = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
    out = []
    for s in _cache["eibi"][1]:
        if not (lo <= s["f"] <= hi):
            continue
        on = s["t0"] <= hm < s["t1"] if s["t0"] <= s["t1"] else (hm >= s["t0"] or hm < s["t1"])
        if s["t0"] == s["t1"] == 0 or (s["t0"] == 0 and s["t1"] == 2400):
            on = True
        if on and not _day_ok(s["days"], wd, names):
            on = False
        if on:
            out.append(s)
    return out


# ---------- typische Frequenzen ----------
def typical(data: Path, static_dir: Path) -> dict:
    """static/freqs.json; eine neuere Fassung aus dem Projekt (GitHub) wird taeglich geholt und bevorzugt."""
    path = data / "freqs.json"
    with _lock:
        c = _cache.get("freqs")
        if c and time.time() - c[0] < DAY:
            return c[1]
        best = json.loads((static_dir / "freqs.json").read_text(encoding="utf-8"))
        try:
            if not path.exists() or time.time() - path.stat().st_mtime > DAY:
                raw = _fetch(SRC["freqs"], 20)
                j = json.loads(raw)
                if isinstance(j, dict) and j.get("freqs"):
                    path.write_bytes(raw)
            if path.exists():
                j = json.loads(path.read_text(encoding="utf-8"))
                if j.get("version", 0) > best.get("version", 0):
                    best = j
        except Exception as e:
            log.info("typische Frequenzen: Projektfassung nicht abrufbar (%s), nutze eingebaute", e)
        _cache["freqs"] = (time.time(), best)
        return best
