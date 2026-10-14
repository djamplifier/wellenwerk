"""Zusatzdaten: Sonnendaten (NOAA), Kurzwellen-Sendeplan (EiBi,  'SW Data'),
Logbuch-Verwaltung (mehrere Logbuecher, Sicherungen), Audioaufnahmen und ein einfacher Layout-Speicher."""
import csv
import io
import json
import logging
import re
import shutil
import sqlite3
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .logbook import Logbook

log = logging.getLogger("ww.extras")
UA = {"User-Agent": "Wellenwerk/0.7 (Amateurfunk)"}
SAFE = re.compile(r"[^A-Za-z0-9 _\-äöüÄÖÜß.]")


def _fetch(url: str, path: Path, max_age: float) -> bytes | None:
    if path.exists() and time.time() - path.stat().st_mtime < max_age:
        return path.read_bytes()
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()
        if data:
            path.write_bytes(data)
            return data
    except Exception as e:
        log.warning("%s: %s", url, e)
    return path.read_bytes() if path.exists() else None


# ---------- Sonnendaten ----------
NOAA = "https://services.swpc.noaa.gov"


def solar(data_dir: Path) -> dict:
    d = Path(data_dir) / "cache"; d.mkdir(exist_ok=True)
    flux = json.loads(_fetch(f"{NOAA}/products/10cm-flux-30-day.json", d / "flux30.json", 3 * 3600) or b"[]")
    kp = json.loads(_fetch(f"{NOAA}/products/noaa-planetary-k-index.json", d / "kp.json", 3 * 3600) or b"[]")
    obs = json.loads(_fetch(f"{NOAA}/json/solar-cycle/observed-solar-cycle-indices.json", d / "cycle_obs.json", 7 * 86400) or b"[]")
    pred = json.loads(_fetch(f"{NOAA}/json/solar-cycle/predicted-solar-cycle.json", d / "cycle_pred.json", 7 * 86400) or b"[]")
    if kp and isinstance(kp[0], list):           # aeltere Form: Kopfzeile + Zeilen
        head = kp[0]; kp = [dict(zip(head, r)) for r in kp[1:]]
    return dict(
        flux=[dict(t=x.get("time_tag", "")[:10], v=x.get("flux")) for x in flux if isinstance(x, dict)],
        kp=[dict(t=x.get("time_tag", "")[:16], v=float(x.get("Kp", x.get("kp_index", 0)) or 0), a=x.get("a_running")) for x in kp],
        cycle=[dict(t=x["time-tag"], ssn=x.get("ssn"), smooth=x.get("smoothed_ssn"), f107=x.get("f10.7")) for x in obs if x.get("time-tag", "") >= "1899"],
        pred=[dict(t=x["time-tag"], ssn=x.get("predicted_ssn"), hi=x.get("high_ssn"), lo=x.get("low_ssn")) for x in pred],
    )


# ---------- Kurzwellen-Sendeplan (EiBi) ----------
_EIBI = {"rows": [], "t": 0, "file": ""}


def _season(now: datetime) -> list[str]:
    y = now.year % 100
    # A = letzter Sonntag Maerz bis letzter Sonntag Oktober, sonst B (B des Vorjahres bis Maerz)
    a = f"a{y:02d}"; b = f"b{y:02d}"; bp = f"b{(y - 1) % 100:02d}"
    if now.month < 3:
        return [bp, f"a{(y - 1) % 100:02d}"]
    if now.month < 11:
        return [a, bp, b] if now.month < 10 else [b, a]
    return [b, a]


def swdb(data_dir: Path) -> list[dict]:
    if _EIBI["rows"] and time.time() - _EIBI["t"] < 86400:
        return _EIBI["rows"]
    d = Path(data_dir) / "cache"; d.mkdir(exist_ok=True)
    raw = None
    for s in _season(datetime.now(timezone.utc)):
        raw = _fetch(f"http://www.eibispace.de/dx/sked-{s}.csv", d / f"eibi-{s}.csv", 7 * 86400)
        if raw and raw.startswith(b"kHz"):
            _EIBI["file"] = s; break
        raw = None
    rows = []
    if raw:
        for r in csv.reader(io.StringIO(raw.decode("latin-1")), delimiter=";"):
            if len(r) < 7 or not r[0][:1].isdigit():
                continue
            try:
                khz = float(r[0])
            except ValueError:
                continue
            t = r[1].split("-")
            rows.append(dict(khz=khz, start=t[0], stop=t[1] if len(t) > 1 else "", days=r[2], itu=r[3], station=r[4],
                             lang=r[5], target=r[6], remarks=r[7] if len(r) > 7 else ""))
    _EIBI.update(rows=rows, t=time.time())
    log.info("EiBi %s: %d Eintraege", _EIBI["file"], len(rows))
    return rows


def swdb_query(data_dir: Path, khz: float | None = None, span: float = 5, now_only: bool = False, q: str = "") -> dict:
    rows = swdb(data_dir)
    hhmm = datetime.now(timezone.utc).strftime("%H%M")

    def on_air(r):
        a, b = r["start"], r["stop"]
        if not (a and b):
            return True
        return a <= hhmm < b if a <= b else (hhmm >= a or hhmm < b)
    out = []
    ql = q.lower()
    for r in rows:
        if khz is not None and abs(r["khz"] - khz) > span:
            continue
        if ql and ql not in r["station"].lower() and ql not in r["target"].lower():
            continue
        live = on_air(r)
        if now_only and not live:
            continue
        out.append(dict(r, live=live))
        if len(out) >= 500:
            break
    return dict(season=_EIBI["file"], rows=out)


# ---------- Logbuecher ----------
class Logbooks:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir) / "logbooks"; self.dir.mkdir(exist_ok=True)
        self.bak = Path(data_dir) / "backups"; self.bak.mkdir(exist_ok=True)
        old = Path(data_dir) / "logbook.sqlite"
        if old.exists() and not any(self.dir.glob("*.sqlite")):
            shutil.move(str(old), self.dir / "Mein Logbuch.sqlite")
        if not any(self.dir.glob("*.sqlite")):
            Logbook(self.dir / "Mein Logbuch.sqlite")
        self.open: dict[str, Logbook] = {}

    def names(self) -> list[str]:
        return sorted(p.stem for p in self.dir.glob("*.sqlite"))

    def get(self, name: str) -> Logbook:
        if name not in self.open:
            p = self.dir / f"{name}.sqlite"
            if not p.exists():
                raise KeyError(name)
            self.open[name] = Logbook(p)
        return self.open[name]

    def create(self, name: str) -> str:
        name = SAFE.sub("", name).strip()[:40]
        if not name:
            raise ValueError("Name fehlt")
        if (self.dir / f"{name}.sqlite").exists():
            raise ValueError("Logbuch gibt es schon")
        self.open[name] = Logbook(self.dir / f"{name}.sqlite")
        return name

    def rename(self, old: str, new: str) -> str:
        new = SAFE.sub("", new).strip()[:40]
        if not new or (self.dir / f"{new}.sqlite").exists():
            raise ValueError("Name ungültig oder schon vergeben")
        lb = self.open.pop(old, None)
        if lb:
            lb.db.close()
        (self.dir / f"{old}.sqlite").rename(self.dir / f"{new}.sqlite")
        return new

    def delete(self, name: str):
        self.backup(name)                       # vorher immer sichern
        lb = self.open.pop(name, None)
        if lb:
            lb.db.close()
        (self.dir / f"{name}.sqlite").unlink()

    def backup(self, name: str) -> str:
        src = self.get(name).db
        fn = f"{name}_{datetime.now():%Y%m%d_%H%M%S}.sqlite"
        dst = sqlite3.connect(self.bak / fn)
        with dst:
            src.backup(dst)
        dst.close()
        return fn

    def backups(self) -> list[dict]:
        return [dict(file=p.name, size=p.stat().st_size, time=datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="minutes"))
                for p in sorted(self.bak.glob("*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)]

    def restore(self, file: str, as_name: str) -> str:
        src = self.bak / Path(file).name
        if not src.exists():
            raise ValueError("Sicherung nicht gefunden")
        name = SAFE.sub("", as_name).strip()[:40] or src.stem
        if (self.dir / f"{name}.sqlite").exists():
            raise ValueError("Logbuch mit diesem Namen gibt es schon")
        shutil.copy(src, self.dir / f"{name}.sqlite")
        return name


# ---------- Audioaufnahmen ----------
def save_recording(data_dir: Path, data: bytes, call: str, ext: str = "webm") -> str:
    d = Path(data_dir) / "recordings"; d.mkdir(exist_ok=True)
    fn = f"{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{re.sub(r'[^A-Z0-9]', '_', (call or 'QSO').upper())}.{ext}"
    (d / fn).write_bytes(data)
    return fn


def recordings(data_dir: Path) -> list[dict]:
    d = Path(data_dir) / "recordings"
    if not d.exists():
        return []
    return [dict(file=p.name, size=p.stat().st_size) for p in sorted(d.iterdir(), reverse=True) if p.is_file()]


# ---------- Layout-Speicher ----------
def store_path(data_dir: Path, key: str) -> Path:
    d = Path(data_dir) / "store"; d.mkdir(exist_ok=True)
    return d / (re.sub(r"[^A-Za-z0-9_.\-]", "_", key)[:80] + ".json")


# ---------- Kalender: Contests (WA7BNM) und DXpeditionen (NG3K ADXO) ----------
_MON = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def _rss_items(data: bytes | None) -> list[dict]:
    import xml.etree.ElementTree as ET
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    return [{k: (it.findtext(k) or "").strip() for k in ("title", "description", "link")} for it in root.iter("item")]


def _contest_times(desc: str, now: datetime) -> tuple[str, str]:
    """'0030Z-0230Z, Oct 14' oder '1200Z, Oct 17 to 1200Z, Oct 18' -> ISO-Zeiten (UTC)."""
    def mk(hhmm: str, mon: str, day: str) -> datetime:
        y = now.year + (1 if _MON[mon] < now.month - 6 else 0)
        return datetime(y, _MON[mon], int(day), int(hhmm[:2]) % 24, int(hhmm[2:]), tzinfo=timezone.utc)
    m = re.match(r"(\d{4})Z-(\d{4})Z, (\w{3}) (\d+)", desc)
    if m:
        a, b = mk(m[1], m[3], m[4]), mk(m[2], m[3], m[4])
        if b <= a:
            b += timedelta(days=1)
        return a.isoformat(), b.isoformat()
    m = re.match(r"(\d{4})Z, (\w{3}) (\d+) to (\d{4})Z, (\w{3}) (\d+)", desc)
    if m:
        return mk(m[1], m[2], m[3]).isoformat(), mk(m[4], m[5], m[6]).isoformat()
    return "", ""


def _dx_dates(s: str) -> tuple[str, str]:
    """'Sep 26-Oct 17, 2026' / 'Oct 3-20, 2026' / 'Dec 28, 2026-Jan 5, 2027' -> ISO-Daten."""
    m = re.match(r"(\w{3}) (\d+)(?:, (\d{4}))?-(?:(\w{3}) )?(\d+), (\d{4})", s)
    if not m or m[1] not in _MON:
        return "", ""
    y2 = int(m[6]); y1 = int(m[3]) if m[3] else y2
    m2 = m[4] or m[1]
    if m2 not in _MON:
        return "", ""
    return f"{y1:04d}-{_MON[m[1]]:02d}-{int(m[2]):02d}", f"{y2:04d}-{_MON[m2]:02d}-{int(m[5]):02d}"


def calendar(data_dir: Path) -> dict:
    d = Path(data_dir) / "cache"; d.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    contests = []
    for it in _rss_items(_fetch("https://www.contestcalendar.com/calendar.rss", d / "contests.rss", 6 * 3600)):
        start, end = _contest_times(it["description"], now)
        contests.append(dict(name=it["title"], when=it["description"], start=start, end=end, link=it["link"]))
    dx = []
    for it in _rss_items(_fetch("https://www.ng3k.com/adxo.xml", d / "adxo.xml", 12 * 3600)):
        parts = [p.strip() for p in it["description"].split("--")]
        if len(parts) < 3:
            continue
        start, end = _dx_dates(parts[0])
        dx.append(dict(dates=parts[0], entity=parts[1], call=parts[2], qsl=parts[3].removeprefix("QSL:").strip() if len(parts) > 3 else "",
                       info=parts[-1] if len(parts) > 5 else "", start=start, end=end, link=it["link"]))
    return dict(contests=contests, dx=dx, now=now.isoformat())
