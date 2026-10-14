"""Satelliten-Katalog: Bahndaten (CelesTrak, Gruppe 'amateur') + Sender/Frequenzen (SatNOGS DB), zwischengespeichert."""
import json
import logging
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("ww.sats")
TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle"
TX_URL = "https://db.satnogs.org/api/transmitters/?format=json"
UA = {"User-Agent": "Wellenwerk/0.5 (Amateurfunk)"}


def _get(url: str, path: Path, max_age: float) -> bytes | None:
    if path.exists() and time.time() - path.stat().st_mtime < max_age:
        return path.read_bytes()
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()
        if data:
            path.write_bytes(data)
            log.info("%s aktualisiert (%d Bytes)", path.name, len(data))
            return data
    except Exception as e:
        log.warning("%s nicht abrufbar: %s", url, e)
    return path.read_bytes() if path.exists() else None


def catalog(data_dir: Path) -> list[dict]:
    tle = _get(TLE_URL, data_dir / "sat_tle.txt", 12 * 3600)
    if not tle:
        return []
    lines = [l.rstrip() for l in tle.decode("utf-8", "replace").splitlines() if l.strip()]
    sats = {}
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i].strip(), lines[i + 1], lines[i + 2]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        norad = int(l1[2:7])
        sats[norad] = dict(name=name, norad=norad, tle1=l1, tle2=l2, transmitters=[])
    txd = _get(TX_URL, data_dir / "sat_tx.json", 7 * 86400)
    if txd:
        try:
            for t in json.loads(txd):
                s = sats.get(t.get("norad_cat_id"))
                if not s or t.get("status") != "active" or not t.get("alive", True):
                    continue
                if not (t.get("downlink_low") or t.get("uplink_low")):
                    continue
                s["transmitters"].append(dict(
                    desc=t.get("description") or "", mode=t.get("mode") or "", invert=bool(t.get("invert")),
                    up_low=t.get("uplink_low"), up_high=t.get("uplink_high"),
                    down_low=t.get("downlink_low"), down_high=t.get("downlink_high"), baud=t.get("baud"),
                    type=t.get("type") or ""))
        except (ValueError, TypeError) as e:
            log.warning("SatNOGS-Daten unlesbar: %s", e)
    for s in sats.values():
        # Sprechfunk/Transponder zuerst, dann Baken/Telemetrie
        s["transmitters"].sort(key=lambda t: (t["type"] != "Transceiver" and t["type"] != "Transponder", t["desc"]))
    return sorted(sats.values(), key=lambda s: s["name"])
