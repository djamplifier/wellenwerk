"""Aktualisierung: prueft beim Start (und taeglich) die neueste veroeffentlichte Version auf GitHub.

- Desktop-Programm: das Programm selbst laedt das passende Installationspaket und installiert es (desktop/main.js);
  der Dienst meldet hier nur, welche Version es gibt.
- Server aus dem Quellcode (z. B. systemd-Dienst auf einem Linux-Rechner): der Dienst laedt den Quellcode der neuen
  Version, tauscht seine Programmordner aus (Daten, venv und Einstellungen bleiben unberuehrt), installiert geaenderte
  Python-Pakete und startet sich neu. Vorher wird der alte Stand gesichert; schlaegt etwas fehl, bleibt er erhalten.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("ww.update")
REPO = "djamplifier/wellenwerk"
FEED = os.environ.get("WW_UPDATE_URL") or f"https://api.github.com/repos/{REPO}/releases/latest"
MANAGED = ("wellenwerk", "static", "docs", "beispiele", "packaging", "licenses", "requirements.txt",
           "README.md", "LICENSE", "LIZENZEN.md")
UA = {"User-Agent": "Wellenwerk-Updater", "Accept": "application/vnd.github+json"}


def parse_ver(v: str) -> tuple:
    """'v1.10.2' -> (1, 10, 2). Vorabversionen ('1.3.0-beta') zaehlen kleiner als die fertige Version."""
    m = re.match(r"v?(\d+(?:\.\d+)*)(.*)", (v or "").strip())
    if not m:
        return (0,)
    nums = tuple(int(x) for x in m.group(1).split("."))
    nums += (0,) * (3 - len(nums))
    return nums + ((0, m.group(2)) if m.group(2) else (1, ""))


def newer(latest: str, current: str) -> bool:
    return parse_ver(latest) > parse_ver(current)


def _get(url: str, timeout=20):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


class Updater:
    def __init__(self, base: Path, data: Path, version: str, cfg: dict):
        self.base, self.data, self.version, self.cfg = base, data, version, cfg
        self.dir = data / "update"
        self.state = dict(current=version, latest="", available=False, checked="", error="", notes="", url="",
                          busy=False, step="", mode=self.kind())

    # Wer installiert? "desktop" = Desktop-Programm, "source" = dieser Dienst selbst, "" = nur Hinweis
    def kind(self) -> str:
        if os.environ.get("WW_DESKTOP") == "1":
            return "desktop"
        if getattr(sys, "frozen", False):
            return ""
        if (self.base / ".git").exists():          # Entwickler-Arbeitskopie nie ueberschreiben
            return ""
        if not os.access(self.base / "wellenwerk", os.W_OK):
            return ""
        return "source"

    async def check(self) -> dict:
        try:
            info = await asyncio.to_thread(self._fetch)
        except Exception as e:
            self.state.update(error=f"Prüfung fehlgeschlagen: {e}", checked=time.strftime("%d.%m.%Y %H:%M"))
            return self.state
        tag = info.get("tag_name") or ""
        self.state.update(latest=tag.lstrip("v"), available=newer(tag, self.version), checked=time.strftime("%d.%m.%Y %H:%M"),
                          error="", notes=(info.get("body") or "")[:20000], url=info.get("html_url") or "",
                          tarball=info.get("tarball_url") or "", assets=[dict(name=a.get("name"), url=a.get("browser_download_url"),
                                                                              size=a.get("size"), digest=a.get("digest") or "")
                                                                         for a in info.get("assets") or []])
        return self.state

    def _fetch(self) -> dict:
        with _get(FEED) as r:
            return json.load(r)

    def notes_for(self, version: str) -> dict:
        """Neuerungen einer Version: gemerkt bei der Installation, sonst von GitHub (Release zum Tag v<version>)."""
        f = self.dir / f"neuerungen-{version}.json"
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if self.state.get("latest") == version and self.state.get("notes"):
            return dict(version=version, notes=self.state["notes"], url=self.state.get("url", ""))
        try:
            with _get(FEED.rsplit("/", 1)[0] + f"/tags/v{version}" if FEED.endswith("/latest") else FEED, timeout=10) as r:
                j = json.load(r)
        except Exception as e:
            return dict(version=version, notes="", url="", error=str(e))
        if (j.get("tag_name") or "").lstrip("v") != version:
            return dict(version=version, notes="", url="")
        out = dict(version=version, notes=j.get("body") or "", url=j.get("html_url") or "")
        self._keep_notes(out)
        return out

    def _keep_notes(self, n: dict):
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / f"neuerungen-{n['version']}.json").write_text(json.dumps(n, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def public(self) -> dict:
        return {k: v for k, v in self.state.items() if k not in ("tarball", "assets")} | dict(setting=self.cfg.get("update_mode") or "auto")

    # ---------- Quellcode-Installation ----------
    async def install_source(self, progress=None) -> str:
        if self.kind() != "source":
            raise RuntimeError("Dieser Wellenwerk kann sich nicht selbst aktualisieren (Desktop-Programm oder Arbeitskopie).")
        if not self.state.get("tarball"):
            await self.check()
        if not self.state.get("available"):
            raise RuntimeError("Keine neuere Version vorhanden.")
        if self.state["busy"]:
            raise RuntimeError("Aktualisierung läuft bereits.")
        self.state["busy"] = True
        try:
            return await asyncio.to_thread(self._install, self.state["latest"], self.state["tarball"], progress)
        finally:
            self.state["busy"] = False

    def _step(self, txt, progress):
        self.state["step"] = txt
        log.info("Aktualisierung: %s", txt)
        if progress:
            progress(txt)

    def _install(self, ver: str, url: str, progress) -> str:
        self.dir.mkdir(parents=True, exist_ok=True)
        arc = self.dir / f"wellenwerk-{ver}.tar.gz"
        self._step(f"Lade Version {ver} …", progress)
        with _get(url, timeout=60) as r, open(arc, "wb") as f:
            shutil.copyfileobj(r, f)
        stage = self.dir / f"neu-{ver}"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir()
        self._step("Entpacke …", progress)
        with tarfile.open(arc) as t:
            try:
                t.extractall(stage, filter="data")
            except TypeError:                               # Python < 3.12
                for m in t.getmembers():
                    if m.name.startswith("/") or ".." in Path(m.name).parts or m.issym() or m.islnk():
                        raise RuntimeError(f"unsicherer Eintrag im Archiv: {m.name}")
                t.extractall(stage)
        tops = [p for p in stage.iterdir() if p.is_dir()]
        root = tops[0] if len(tops) == 1 else stage
        main = root / "wellenwerk" / "main.py"
        if not main.exists() or f'VERSION = "{ver}"' not in main.read_text(encoding="utf-8"):
            raise RuntimeError("Heruntergeladenes Paket passt nicht zur Version – abgebrochen.")
        # Sicherung des bisherigen Stands (die letzten drei bleiben)
        self._step("Sichere bisherigen Stand …", progress)
        bak = self.dir / f"vorher-{self.version}.tgz"
        with tarfile.open(bak, "w:gz") as t:
            for p in MANAGED:
                if (self.base / p).exists():
                    t.add(self.base / p, arcname=p, filter=lambda ti: None if "__pycache__" in ti.name else ti)
        for old in sorted(self.dir.glob("vorher-*.tgz"), key=lambda p: p.stat().st_mtime)[:-3]:
            old.unlink(missing_ok=True)
        old_req = (self.base / "requirements.txt").read_text(encoding="utf-8") if (self.base / "requirements.txt").exists() else ""
        # Austauschen: alte Ordner beiseite, neue an ihren Platz – bei Fehler zurueck
        self._step("Tausche Programmdateien …", progress)
        aside = self.dir / f"alt-{self.version}"
        shutil.rmtree(aside, ignore_errors=True)
        aside.mkdir()
        try:
            for p in MANAGED:
                src = root / p
                if not src.exists():
                    continue
                if (self.base / p).exists():
                    shutil.move(str(self.base / p), str(aside / p))
                shutil.move(str(src), str(self.base / p))
            new_req = (self.base / "requirements.txt").read_text(encoding="utf-8") if (self.base / "requirements.txt").exists() else ""
            if new_req != old_req:
                self._step("Installiere Python-Pakete …", progress)
                r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(self.base / "requirements.txt")],
                                   capture_output=True, text=True, timeout=900)
                if r.returncode:
                    raise RuntimeError("Python-Pakete: " + (r.stderr or r.stdout)[-400:])
        except Exception:
            for p in MANAGED:                               # zurueckrollen
                if (aside / p).exists():
                    _rm(self.base / p)
                    shutil.move(str(aside / p), str(self.base / p))
            raise
        self._keep_notes(dict(version=ver, notes=self.state.get("notes", ""), url=self.state.get("url", "")))
        shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(aside, ignore_errors=True)
        arc.unlink(missing_ok=True)
        self._step(f"Version {ver} installiert – Neustart", progress)
        return ver


def _rm(p: Path):
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()


def restart_process():
    """Denselben Aufruf neu starten (systemd behaelt die Prozessnummer, python -m wellenwerk bleibt erhalten)."""
    argv = list(getattr(sys, "orig_argv", None) or [sys.executable, *sys.argv])
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(sys.executable, [sys.executable, *argv[1:]])
