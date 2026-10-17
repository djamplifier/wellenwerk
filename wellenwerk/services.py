"""Online-Dienste: Callbook (HamQTH, QRZ.com), Uploads (QRZ-Logbuch, eQSL, Club Log, LoTW) und
Bestaetigungen abholen (LoTW, eQSL). Alle Aufrufe blockierend -> aus asyncio per to_thread verwenden."""
import logging
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from . import adif

log = logging.getLogger("ww.services")
UA = "Wellenwerk/0.3 (Amateurfunk-Logbuch)"


class ServiceError(RuntimeError):
    pass


def _http(url: str, data: dict | None = None, timeout: int = 30) -> str:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise ServiceError(f"{urllib.parse.urlparse(url).hostname}: HTTP {e.code}")
    except urllib.error.URLError as e:
        raise ServiceError(f"{urllib.parse.urlparse(url).hostname} nicht erreichbar: {e.reason}")


def _html_text(page: str) -> str:
    page = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", page)
    return " ".join(re.sub(r"<[^>]+>", " ", page).replace("&nbsp;", " ").split())


def _strip_ns(xml_text: str) -> ET.Element:
    root = ET.fromstring(xml_text)
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _adif_one(rec: dict) -> str:
    keep = {k: v for k, v in rec.items() if k not in ("id", "created") and v not in (None, "")}
    return "".join(f"<{k.upper()}:{len(str(v))}>{v} " for k, v in keep.items()) + "<EOR>"


# ---------- Callbook ----------
class Callbook:
    def __init__(self):
        self._sess = {}          # dienst -> (schluessel, zeit)

    def lookup(self, cfg: dict, call: str) -> dict | None:
        call = call.upper().strip()
        errors = []
        if cfg.get("hamqth_user") and cfg.get("hamqth_pass"):
            try:
                return self._hamqth(cfg, call)
            except ServiceError as e:
                errors.append(str(e))
        if cfg.get("qrz_user") and cfg.get("qrz_pass"):
            try:
                return self._qrz(cfg, call)
            except ServiceError as e:
                errors.append(str(e))
        if errors:
            raise ServiceError("; ".join(errors))
        return None

    def _hamqth(self, cfg, call, retry=True):
        s = self._sess.get("hamqth")
        if not s or time.time() - s[1] > 3000:
            x = _strip_ns(_http("https://www.hamqth.com/xml.php?" + urllib.parse.urlencode(
                {"u": cfg["hamqth_user"], "p": cfg["hamqth_pass"]})))
            sid = x.findtext(".//session_id")
            if not sid:
                raise ServiceError("HamQTH: " + (x.findtext(".//error") or "Anmeldung fehlgeschlagen"))
            s = self._sess["hamqth"] = (sid, time.time())
        x = _strip_ns(_http("https://www.hamqth.com/xml.php?" + urllib.parse.urlencode(
            {"id": s[0], "callsign": call, "prg": "Wellenwerk"})))
        err = x.findtext(".//error")
        if err:
            if "session" in err.lower() and retry:
                self._sess.pop("hamqth", None)
                return self._hamqth(cfg, call, False)
            raise ServiceError("HamQTH: " + err)
        sea = x.find(".//search")
        g = lambda t: (sea.findtext(t) or "").strip() if sea is not None else ""
        return dict(source="HamQTH", call=g("callsign").upper() or call, name=g("nick") or g("adr_name"),
                    qth=g("qth") or g("adr_city"), gridsquare=g("grid"), country=g("country"), state=g("us_state"),
                    cnty=g("us_county"), iota=g("iota"), email=g("email"), qsl_via=g("qsl_via"),
                    lotw=g("lotw") == "Y", eqsl=g("eqsl") == "Y", photo=g("picture"), web=g("web"),
                    lat=g("latitude"), lon=g("longitude"),
                    address=", ".join(p for p in (g("adr_street1"), g("adr_zip") + " " + g("adr_city"), g("adr_country")) if p.strip()))

    def _qrz(self, cfg, call, retry=True):
        s = self._sess.get("qrz")
        if not s or time.time() - s[1] > 3000:
            x = _strip_ns(_http("https://xmldata.qrz.com/xml/current/?" + urllib.parse.urlencode(
                {"username": cfg["qrz_user"], "password": cfg["qrz_pass"], "agent": "Wellenwerk"})))
            key = x.findtext(".//Session/Key")
            if not key:
                raise ServiceError("QRZ.com: " + (x.findtext(".//Session/Error") or "Anmeldung fehlgeschlagen"))
            s = self._sess["qrz"] = (key, time.time())
        x = _strip_ns(_http("https://xmldata.qrz.com/xml/current/?" + urllib.parse.urlencode({"s": s[0], "callsign": call})))
        err = x.findtext(".//Session/Error")
        if err and x.find(".//Callsign") is None:
            if "session" in err.lower() and retry:
                self._sess.pop("qrz", None)
                return self._qrz(cfg, call, False)
            raise ServiceError("QRZ.com: " + err)
        c = x.find(".//Callsign")
        g = lambda t: (c.findtext(t) or "").strip() if c is not None else ""
        name = " ".join(p for p in (g("fname"), g("name")) if p)
        return dict(source="QRZ.com", call=g("call").upper() or call, name=g("fname").split()[0] if g("fname") else name,
                    fullname=name, qth=g("addr2"), gridsquare=g("grid"), country=g("country"), state=g("state"),
                    cnty=g("county"), iota=g("iota"), email=g("email"), qsl_via=g("qslmgr"),
                    lotw=g("lotw") == "1", eqsl=g("eqsl") == "1", photo=g("image"), web=g("url"),
                    lat=g("lat"), lon=g("lon"),
                    address=", ".join(p for p in (g("addr1"), g("zip") + " " + g("addr2"), g("country")) if p.strip()))


# ---------- Uploads ----------
def qrz_upload(cfg: dict, rec: dict) -> str:
    if not cfg.get("qrz_logbook_key"):
        raise ServiceError("QRZ-Logbuch: kein API-Schlüssel eingetragen")
    resp = _http("https://logbook.qrz.com/api", {"KEY": cfg["qrz_logbook_key"], "ACTION": "INSERT", "ADIF": _adif_one(rec)})
    d = dict(urllib.parse.parse_qsl(resp.strip(), keep_blank_values=True))
    if d.get("RESULT") in ("OK", "REPLACE"):
        return d.get("LOGID", "")
    reason = d.get("REASON", resp[:200])
    if "duplicate" in reason.lower():
        return "duplicate"
    raise ServiceError("QRZ-Logbuch: " + reason)


def eqsl_upload(cfg: dict, recs: list[dict]) -> dict:
    if not (cfg.get("eqsl_user") and cfg.get("eqsl_pass")):
        raise ServiceError("eQSL: Benutzer/Passwort fehlen")
    text = adif.export([{k: v for k, v in r.items() if k not in ("id", "created") and v not in (None, "")} for r in recs])
    resp = _http("https://www.eQSL.cc/qslcard/ImportADIF.cfm",
                 {"EQSL_USER": cfg["eqsl_user"], "EQSL_PSWD": cfg["eqsl_pass"], "ADIFData": text}, timeout=60)
    plain = _html_text(resp)
    m = re.search(r"Result:\s*(\d+)\s+out of\s+(\d+)\s+records added", plain, re.I)
    dupes = len(re.findall(r"Duplicate", plain, re.I))
    if m:
        return dict(added=int(m.group(1)), total=int(m.group(2)), duplicates=dupes)
    err = re.search(r"Error:\s*([^\n]+)", plain)
    raise ServiceError("eQSL: " + (err.group(1).strip()[:200] if err else "unerwartete Antwort"))


def clublog_upload(cfg: dict, rec: dict) -> str:
    need = ("clublog_email", "clublog_pass", "clublog_api")
    if not all(cfg.get(k) for k in need):
        raise ServiceError("Club Log: E-Mail, Passwort und API-Schlüssel nötig")
    req = urllib.request.Request("https://clublog.org/realtime.php", data=urllib.parse.urlencode({
        "email": cfg["clublog_email"], "password": cfg["clublog_pass"], "callsign": cfg.get("callsign", ""),
        "adif": _adif_one(rec), "api": cfg["clublog_api"]}).encode(), headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace").strip()[:100] or "OK"
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace").strip()[:200]
        if "dupe" in msg.lower() or "duplicate" in msg.lower():
            return "duplicate"
        raise ServiceError(f"Club Log: HTTP {e.code} {msg}")
    except urllib.error.URLError as e:
        raise ServiceError(f"Club Log nicht erreichbar: {e.reason}")


def tqsl_path() -> str | None:
    return shutil.which("tqsl")


def _tqsl_cmd() -> list[str]:
    """TQSL ist ein GUI-Programm; ohne Bildschirm (Server) ueber einen virtuellen X-Server starten."""
    import os
    exe = tqsl_path()
    if not exe:
        raise ServiceError("LoTW: TQSL ist nicht installiert (Debian-Paket 'trustedqsl')")
    if not os.environ.get("DISPLAY") and shutil.which("xvfb-run"):
        return ["xvfb-run", "-a", exe]
    return [exe]


TQSL_DIR = Path.home() / ".tqsl"


def tqsl_has_cert() -> bool:
    d = TQSL_DIR / "certs"
    return d.exists() and any(f.stat().st_size > 0 for f in d.glob("*") if f.is_file())


def tqsl_locations() -> list[str]:
    f = TQSL_DIR / "station_data"
    if not f.exists():
        return []
    try:
        return [e.get("name") for e in ET.parse(f).getroot().iter("StationData")]
    except ET.ParseError:
        return []


def tqsl_ensure_location(name: str, call: str, dxcc: int, grid: str, cqz: int, ituz: int):
    """Stationsort in ~/.tqsl/station_data anlegen bzw. aktualisieren (gleiches Format wie die TQSL-Oberflaeche)."""
    TQSL_DIR.mkdir(exist_ok=True)
    f = TQSL_DIR / "station_data"
    root = ET.parse(f).getroot() if f.exists() else ET.Element("StationDataFile")
    for e in list(root.iter("StationData")):
        if e.get("name") == name:
            root.remove(e)
    sd = ET.SubElement(root, "StationData", name=name)
    for tag, val in (("CALL", call.upper()), ("DXCC", dxcc), ("GRIDSQUARE", grid.upper()), ("ITUZ", ituz), ("CQZ", cqz)):
        if val:
            ET.SubElement(sd, tag).text = str(val)
    if f.exists():
        f.with_name("station_data.bak").write_bytes(f.read_bytes())
    ET.ElementTree(root).write(f, encoding="UTF-8", xml_declaration=True)


def _run_tqsl(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    """TQSL in eigener Prozessgruppe starten, damit bei Zeitueberschreitung auch Xvfb und TQSL beendet werden
    (TQSL wartet bei manchen Fehlern auf einen Dialog, der auf dem Server niemand bestaetigt)."""
    import os
    import signal
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.communicate()
        raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def tqsl_import_cert(data: bytes, password: str) -> str:
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "cert.p12"
        f.write_bytes(data)
        cmd = _tqsl_cmd() + ["-x", "-q", "-i", str(f)] + (["-p", password] if password else [])
        try:
            p = _run_tqsl(cmd, 60)
        except subprocess.TimeoutExpired:
            raise ServiceError("TQSL hat die Datei nicht angenommen (kein gültiges LoTW-Zertifikat oder Passwort falsch)")
    out = (p.stdout + p.stderr).strip()
    if p.returncode != 0 or "error" in out.lower():
        raise ServiceError(f"TQSL-Import fehlgeschlagen (Code {p.returncode}): {out[-300:]}")
    return out[-300:] or "importiert"


def lotw_upload(cfg: dict, recs: list[dict]) -> str:
    """Signieren + Hochladen mit dem offiziellen ARRL-Programm TQSL (Zertifikat + Stationsort muessen dort eingerichtet sein)."""
    cmd = _tqsl_cmd()
    if not tqsl_has_cert():
        raise ServiceError("LoTW: kein Zertifikat in TQSL – .p12-Datei unter 'QSL & Online' importieren")
    if not cfg.get("lotw_location"):
        raise ServiceError("LoTW: Stationsort (TQSL 'Station Location') nicht eingetragen")
    text = adif.export([{k: v for k, v in r.items() if k not in ("id", "created") and v not in (None, "")} for r in recs])
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "upload.adi"
        f.write_text(text, encoding="utf-8")
        extra = ["-p", cfg["lotw_cert_pass"]] if cfg.get("lotw_cert_pass") else []
        try:
            p = _run_tqsl(cmd + ["-x", "-d", "-q", "-u", "-a", "compliant", "-l", cfg["lotw_location"]] + extra + [str(f)], 300)
        except subprocess.TimeoutExpired:
            raise ServiceError("LoTW/TQSL reagiert nicht (Signierpasswort oder Stationsort prüfen)")
    out = (p.stdout + p.stderr).strip()
    # TQSL-Rueckgabecodes: 0 ok, 9 nur Duplikate/teilweise
    if p.returncode in (0, 9):
        return out[-300:] or "hochgeladen"
    raise ServiceError(f"LoTW/TQSL (Code {p.returncode}): {out[-300:]}")


# ---------- Bestaetigungen abholen ----------
def lotw_confirmations(cfg: dict, since: str) -> list[dict]:
    if not (cfg.get("lotw_user") and cfg.get("lotw_pass")):
        raise ServiceError("LoTW: Benutzer/Passwort fehlen")
    text = _http("https://lotw.arrl.org/lotwuser/lotwreport.adi?" + urllib.parse.urlencode({
        "login": cfg["lotw_user"], "password": cfg["lotw_pass"], "qso_query": 1, "qso_qsl": "yes",
        "qso_qslsince": since, "qso_qsldetail": "yes", "qso_owncall": cfg.get("callsign", "")}), timeout=120)
    if "<eoh>" not in text.lower():
        plain = _html_text(text)
        if "password incorrect" in plain.lower() or "log on" in plain.lower():
            raise ServiceError("LoTW: Benutzername oder Passwort falsch")
        raise ServiceError("LoTW: keine ADIF-Antwort – " + plain[:150])
    return adif.parse(text)


def eqsl_confirmations(cfg: dict, since: str) -> list[dict]:
    if not (cfg.get("eqsl_user") and cfg.get("eqsl_pass")):
        raise ServiceError("eQSL: Benutzer/Passwort fehlen")
    page = _http("https://www.eQSL.cc/qslcard/DownloadInBox.cfm?" + urllib.parse.urlencode({
        "UserName": cfg["eqsl_user"], "Password": cfg["eqsl_pass"], "RcvdSince": since.replace("-", "")}), timeout=120)
    m = re.search(r'href="([^"]+\.adi)"', page, re.I)
    if not m:
        plain = _html_text(page)
        if "no records" in plain.lower() or "you have no log entries" in plain.lower():
            return []
        err = re.search(r"Error:\s*(.{0,150})", plain)
        raise ServiceError("eQSL: " + (err.group(1).strip() if err else plain[-150:] or "keine Datei gefunden"))
    url = urllib.parse.urljoin("https://www.eQSL.cc/qslcard/", m.group(1))
    return adif.parse(_http(url, timeout=120))
