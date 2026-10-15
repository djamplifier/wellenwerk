"""Oeffentliche Empfaengerlisten, zwischengespeichert:
- receiverbook.de: KiwiSDR, OpenWebRX und WebSDR-Standorte mit Koordinaten
- KiwiSDR-Liste (rx.linkfanel.net, aus kiwisdr.com/public): Locator, Baender, freie Plaetze, Antenne
Die Liste von websdr.org wird bewusst NICHT automatisch verwendet (Betreiber untersagt automatische Nutzung)."""
import json
import logging
import math
import re
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("ww.sdr")
UA = {"User-Agent": "Wellenwerk (Amateurfunk-Programm; Empfaengerliste)"}
SOURCES = {"receiverbook": "https://www.receiverbook.de/map", "kiwi": "http://rx.linkfanel.net/kiwisdr_com.js"}


def _get(url: str, path: Path, max_age: float) -> str:
    if path.exists() and time.time() - path.stat().st_mtime < max_age:
        return path.read_text(encoding="utf-8", errors="replace")
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")
        if len(data) > 1000:
            path.write_text(data, encoding="utf-8")
            return data
    except Exception as e:
        log.warning("Empfängerliste %s nicht abrufbar: %s", url, e)
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def _dist(lat1, lon1, lat2, lon2):
    if None in (lat1, lon1, lat2, lon2):
        return None
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return round(12742 * math.asin(math.sqrt(a)))


def _norm_url(u: str) -> str:
    """Gleiche Empfaenger trotz unterschiedlicher Schreibweise erkennen (http/https, Standardports 80/8073, Schraegstrich)."""
    from urllib.parse import urlparse
    p = urlparse((u or "").strip() if "://" in (u or "") else "http://" + (u or "").strip())
    port = "" if p.port in (None, 80, 443, 8073) else f":{p.port}"
    return f"{(p.hostname or '').lower()}{port}{p.path.rstrip('/')}"


def receivers(data_dir: Path, home=None) -> list[dict]:
    out: dict[str, dict] = {}
    rb = _get(SOURCES["receiverbook"], data_dir / "sdr_receiverbook.html", 12 * 3600)
    m = re.search(r"var receivers = (\[.*?\]);\s*\n", rb, re.S)
    if m:
        try:
            for site in json.loads(m.group(1)):
                lon, lat = (site.get("location") or {}).get("coordinates", [None, None])
                for r in site.get("receivers") or []:
                    t = {"KiwiSDR": "kiwisdr", "OpenWebRX": "openwebrx", "WebSDR": "websdr"}.get(r.get("type"))
                    if not t or not r.get("url"):
                        continue
                    out[_norm_url(r["url"])] = dict(type=t, name=re.sub(r"<[^>]+>", " ", r.get("label") or site.get("label") or "").strip()[:160],
                                                    url=r["url"], lat=lat, lon=lon, place=(site.get("label") or "").strip(),
                                                    grid="", bands="", users=None, users_max=None, antenna="", source="receiverbook.de")
        except (ValueError, TypeError) as e:
            log.warning("receiverbook-Liste unlesbar: %s", e)
    kj = _get(SOURCES["kiwi"], data_dir / "sdr_kiwi.js", 3 * 3600)
    m = re.search(r"=\s*(\[.*\])", kj, re.S)
    if m:
        try:
            for k in json.loads(re.sub(r",\s*([\]}])", r"\1", m.group(1))):
                if k.get("offline") == "yes" or k.get("status") not in ("active", None) or not k.get("url"):
                    continue
                g = re.match(r"\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)", k.get("gps", ""))
                lat, lon = (float(g.group(1)), float(g.group(2))) if g else (None, None)
                key = _norm_url(k["url"])
                rec = out.get(key, {})
                try:
                    lo, hi = (float(x) for x in (k.get("bands") or "0-30000000").split("-")[:2])
                except ValueError:
                    lo, hi = 0, 30e6
                rec.update(type="kiwisdr", name=k.get("name", "")[:160], url=k["url"], lat=lat if lat is not None else rec.get("lat"),
                           lon=lon if lon is not None else rec.get("lon"), place=k.get("loc", ""), grid=k.get("grid", ""),
                           lo=lo, hi=hi, users=int(k.get("users") or 0), users_max=int(k.get("users_max") or 0),
                           antenna=k.get("antenna", "")[:120], snr=k.get("snr", ""), source="kiwisdr.com")
                out[key] = rec
        except (ValueError, TypeError) as e:
            log.warning("KiwiSDR-Liste unlesbar: %s", e)
    res = list(out.values())
    for r in res:
        r["key"] = _norm_url(r["url"])
    for r in res:
        r["km"] = _dist(home[0], home[1], r.get("lat"), r.get("lon")) if home else None
    res.sort(key=lambda r: (r["km"] is None, r["km"] or 0))
    return res
