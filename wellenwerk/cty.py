"""DXCC-Zuordnung aus der freien Laenderdatei cty.csv (country-files.com, AD1C)."""
import logging
import re
import time
import urllib.request
from pathlib import Path

URL = "https://www.country-files.com/cty/cty.csv"
log = logging.getLogger("ww.cty")
_OVR = re.compile(r"\((\d+)\)|\[(\d+)\]|<[^>]*>|\{[^}]*\}|~[^~]*~")
_SUFFIX = {"P", "M", "MM", "AM", "QRP", "A", "B", "LH", "J", "R"}


class Cty:
    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "cty.csv"
        self.prefix: dict[str, dict] = {}
        self.exact: dict[str, dict] = {}
        self.maxlen = 1

    def load(self, refresh_days: int = 14):
        if not self.path.exists() or time.time() - self.path.stat().st_mtime > refresh_days * 86400:
            try:
                req = urllib.request.Request(URL, headers={"User-Agent": "Wellenwerk/0.1"})
                data = urllib.request.urlopen(req, timeout=20).read()
                if b"Germany" in data:
                    self.path.write_bytes(data)
                    log.info("cty.csv aktualisiert (%d Bytes)", len(data))
            except Exception as e:
                log.warning("cty.csv Download fehlgeschlagen: %s", e)
        if not self.path.exists():
            log.error("keine cty.csv vorhanden - DXCC-Zuordnung aus")
            return
        self.prefix.clear(); self.exact.clear()
        for line in self.path.read_text(encoding="latin-1").splitlines():
            parts = line.strip().rstrip(";").split(",")
            if len(parts) < 10:
                continue
            ent = dict(prefix=parts[0].lstrip("*"), country=parts[1], dxcc=int(parts[2]), cont=parts[3],
                       cqz=int(parts[4]), ituz=int(parts[5]), lat=float(parts[6]), lon=-float(parts[7]),
                       wae_only=parts[0].startswith("*"))
            for tok in ",".join(parts[9:]).split():
                cq = it = None
                for m in _OVR.finditer(tok):
                    if m.group(1): cq = int(m.group(1))
                    if m.group(2): it = int(m.group(2))
                key = _OVR.sub("", tok)
                e = ent if cq is None and it is None else {**ent, "cqz": cq or ent["cqz"], "ituz": it or ent["ituz"]}
                if key.startswith("="):
                    self.exact[key[1:].upper()] = e
                elif key:
                    # WAE-Eintraege (*) ueberschreiben nicht die eigentliche DXCC-Zuordnung
                    if ent["wae_only"] and key.upper() in self.prefix:
                        continue
                    self.prefix[key.upper()] = e
                    self.maxlen = max(self.maxlen, len(key))
        log.info("cty: %d Praefixe, %d Einzelrufzeichen", len(self.prefix), len(self.exact))

    @staticmethod
    def base_call(call: str) -> str:
        """Teil des Rufzeichens, der das Land bestimmt (EA8/DL1ABC/P -> EA8)."""
        parts = [p for p in call.upper().strip().split("/") if p and p not in _SUFFIX]
        if not parts:
            return call.upper()
        if len(parts) == 1:
            return parts[0]
        # bei A/B das kuerzere nehmen (meist der Landespraefix); Ziffer allein (DL1ABC/3) -> Hauptteil
        parts = [p for p in parts if not p.isdigit()] or parts
        return min(parts, key=len) if len(parts) > 1 else parts[0]

    def lookup(self, call: str) -> dict | None:
        if not call:
            return None
        c = call.upper().strip()
        if c in self.exact:
            return self.exact[c]
        b = self.base_call(c)
        if b in self.exact:
            return self.exact[b]
        for n in range(min(len(b), self.maxlen), 0, -1):
            e = self.prefix.get(b[:n])
            if e:
                return e
        return None
