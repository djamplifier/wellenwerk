"""Logbuch in SQLite. Feldnamen = ADIF-Namen, unbekannte ADIF-Felder bleiben in 'extra' erhalten."""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

FIELDS = ["call", "qso_date", "time_on", "time_off", "freq", "band", "mode", "submode", "rst_sent", "rst_rcvd",
          "name", "qth", "gridsquare", "country", "dxcc", "cont", "cqz", "ituz", "comment", "tx_pwr",
          "station_callsign", "operator", "my_gridsquare", "qsl_sent", "qsl_rcvd", "lotw_qsl_sent",
          "lotw_qsl_rcvd", "eqsl_qsl_sent", "eqsl_qsl_rcvd", "contest_id", "srx_string", "stx_string",
          "prop_mode", "sat_name",
          # QSL-Verwaltung und Online-Dienste (ADIF 3.1)
          "qsl_sdate", "qsl_rdate", "qsl_via", "qsl_sent_via", "lotw_qslsdate", "lotw_qslrdate",
          "eqsl_qslsdate", "eqsl_qslrdate", "qrzcom_qso_upload_status", "qrzcom_qso_upload_date",
          "clublog_qso_upload_status", "clublog_qso_upload_date",
          # Diplom-Felder
          "state", "cnty", "iota", "darc_dok", "pfx", "email", "address", "srx", "stx"]
INT_FIELDS = {"dxcc", "cqz", "ituz"}


class Logbook:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.version = 0          # steigt bei jeder Aenderung (fuer zwischengespeicherte Auswertungen)
        cols = ", ".join(f"{f} {'INTEGER' if f in INT_FIELDS else 'TEXT'}" for f in FIELDS)
        with self.lock, self.db:
            self.db.execute(f"CREATE TABLE IF NOT EXISTS qso (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols}, "
                            "extra TEXT, created TEXT)")
            # Migration: neue Felder in bestehender Datenbank ergaenzen; Werte aus 'extra' uebernehmen
            have = {r[1] for r in self.db.execute("PRAGMA table_info(qso)")}
            for f in FIELDS:
                if f not in have:
                    self.db.execute(f"ALTER TABLE qso ADD COLUMN {f} {'INTEGER' if f in INT_FIELDS else 'TEXT'}")
            for qid, extra in self.db.execute("SELECT id, extra FROM qso WHERE extra IS NOT NULL").fetchall():
                ex = json.loads(extra)
                move = {k: v for k, v in ex.items() if k in FIELDS}
                if move:
                    rest = {k: v for k, v in ex.items() if k not in FIELDS}
                    self.db.execute(f"UPDATE qso SET {', '.join(f'{k}=?' for k in move)}, extra=? WHERE id=?",
                                    list(move.values()) + [json.dumps(rest) if rest else None, qid])
            self.db.execute("CREATE INDEX IF NOT EXISTS qso_call ON qso(call)")
            self.db.execute("CREATE INDEX IF NOT EXISTS qso_dxcc ON qso(dxcc, band, mode)")
            self.db.execute("CREATE INDEX IF NOT EXISTS qso_date ON qso(qso_date DESC, time_on DESC)")

    @staticmethod
    def _norm(rec: dict) -> tuple[dict, dict]:
        known, extra = {}, {}
        for k, v in rec.items():
            k = k.lower()
            if k in ("id", "extra", "created"):
                continue
            if k in FIELDS:
                if v in ("", None):
                    known[k] = None
                elif k in INT_FIELDS:
                    try:
                        known[k] = int(v)
                    except (TypeError, ValueError):
                        known[k] = None
                else:
                    known[k] = str(v).strip()
            elif v not in ("", None):
                extra[k] = str(v)
        if known.get("call"):
            known["call"] = known["call"].upper()
        if known.get("band"):
            known["band"] = known["band"].lower()
        for k in ("mode", "submode", "state", "iota", "darc_dok", "cont"):
            if known.get(k):
                known[k] = known[k].upper()
        if known.get("gridsquare"):
            g = known["gridsquare"]
            known["gridsquare"] = g[:4].upper() + g[4:].lower()
        for k in ("qso_date",):
            if known.get(k):
                known[k] = known[k].replace("-", "")
        for k in ("time_on", "time_off"):
            if known.get(k):
                t = known[k].replace(":", "")
                known[k] = (t + "00")[:6] if len(t) == 4 else t[:6]
        return known, extra

    def _row(self, r: sqlite3.Row) -> dict:
        d = {k: r[k] for k in r.keys() if k != "extra"}
        if r["extra"]:
            d.update(json.loads(r["extra"]))
        return d

    def add(self, rec: dict) -> dict:
        self.version += 1
        known, extra = self._norm(rec)
        if not known.get("call"):
            raise ValueError("Rufzeichen fehlt")
        now = datetime.now(timezone.utc)
        known.setdefault("qso_date", now.strftime("%Y%m%d"))
        known.setdefault("time_on", now.strftime("%H%M%S"))
        cols = list(known) + ["extra", "created"]
        vals = list(known.values()) + [json.dumps(extra) if extra else None, now.isoformat()]
        with self.lock, self.db:
            cur = self.db.execute(f"INSERT INTO qso ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals)
            return self.get(cur.lastrowid, locked=True)

    def get(self, qid: int, locked=False) -> dict | None:
        r = self.db.execute("SELECT * FROM qso WHERE id=?", (qid,)).fetchone()
        return self._row(r) if r else None

    def update(self, qid: int, rec: dict) -> dict | None:
        self.version += 1
        known, extra = self._norm(rec)
        if not known:
            return self.get(qid)
        with self.lock, self.db:
            self.db.execute(f"UPDATE qso SET {', '.join(f'{k}=?' for k in known)} WHERE id=?",
                            list(known.values()) + [qid])
        return self.get(qid)

    def delete(self, qid: int) -> bool:
        self.version += 1
        with self.lock, self.db:
            return self.db.execute("DELETE FROM qso WHERE id=?", (qid,)).rowcount > 0

    def search(self, q: str = "", limit: int = 200, offset: int = 0) -> tuple[list[dict], int]:
        where, args = "", []
        if q:
            where = "WHERE call LIKE ? OR country LIKE ? OR name LIKE ? OR gridsquare LIKE ? OR comment LIKE ?"
            args = [f"%{q.upper()}%"] + [f"%{q}%"] * 4
        total = self.db.execute(f"SELECT COUNT(*) FROM qso {where}", args).fetchone()[0]
        rows = self.db.execute(f"SELECT * FROM qso {where} ORDER BY qso_date DESC, time_on DESC, id DESC "
                               "LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        return [self._row(r) for r in rows], total

    def query(self, where: str = "", args: list | None = None, order: str = "qso_date DESC, time_on DESC, id DESC",
              limit: int = 500, offset: int = 0) -> tuple[list[dict], int]:
        w = f"WHERE {where}" if where else ""
        total = self.db.execute(f"SELECT COUNT(*) FROM qso {w}", args or []).fetchone()[0]
        rows = self.db.execute(f"SELECT * FROM qso {w} ORDER BY {order} LIMIT ? OFFSET ?",
                               (args or []) + [limit, offset]).fetchall()
        return [self._row(r) for r in rows], total

    def by_ids(self, ids: list[int]) -> list[dict]:
        if not ids:
            return []
        rows = self.db.execute(f"SELECT * FROM qso WHERE id IN ({','.join('?' * len(ids))}) ORDER BY qso_date, time_on",
                               ids).fetchall()
        return [self._row(r) for r in rows]

    def set_fields(self, ids: list[int], fields: dict) -> int:
        self.version += 1
        known, _ = self._norm(fields)
        if not ids or not known:
            return 0
        with self.lock, self.db:
            return self.db.execute(f"UPDATE qso SET {', '.join(f'{k}=?' for k in known)} WHERE id IN "
                                   f"({','.join('?' * len(ids))})", list(known.values()) + ids).rowcount

    def find_match(self, call: str, qso_date: str, time_on: str, band: str, mode: str = "") -> dict | None:
        """QSO fuer eine Bestaetigung finden: Rufzeichen, Band, Datum, Zeit +-30 min (Mode nur als Vorzug)."""
        t = int((time_on or "0").ljust(6, "0")[:4]); tm = t // 100 * 60 + t % 100
        best = None
        for r in self.db.execute("SELECT * FROM qso WHERE call=? AND qso_date=? AND IFNULL(band,'')=?",
                                 (call.upper(), qso_date, (band or "").lower())):
            u = int((r["time_on"] or "0").ljust(6, "0")[:4]); um = u // 100 * 60 + u % 100
            d = abs(tm - um)
            if d <= 30 and (best is None or d < best[0] or (d == best[0] and r["mode"] == mode)):
                best = (d, r)
        return self._row(best[1]) if best else None

    def all(self) -> list[dict]:
        return [self._row(r) for r in self.db.execute("SELECT * FROM qso ORDER BY qso_date, time_on, id")]

    def exists(self, call: str, qso_date: str, time_on: str, band: str) -> bool:
        """Dublette = gleiches Rufzeichen, Band, Tag und Uhrzeit auf +-2 Minuten."""
        t = int((time_on or "0").ljust(6, "0")[:4])
        rows = self.db.execute("SELECT time_on FROM qso WHERE call=? AND qso_date=? AND IFNULL(band,'')=?",
                               (call.upper(), qso_date, band or "")).fetchall()
        for (ton,) in rows:
            u = int((ton or "0").ljust(6, "0")[:4])
            if abs((t // 100 * 60 + t % 100) - (u // 100 * 60 + u % 100)) <= 2:
                return True
        return False

    def worked(self, call: str, dxcc: int | None, band: str = "", mode: str = "") -> dict:
        prev = [self._row(r) for r in self.db.execute(
            "SELECT * FROM qso WHERE call=? ORDER BY qso_date DESC, time_on DESC LIMIT 10", (call.upper(),))]
        res = dict(call_count=self.db.execute("SELECT COUNT(*) FROM qso WHERE call=?", (call.upper(),)).fetchone()[0],
                   previous=prev, dxcc_worked=False, dxcc_band=False, dxcc_mode=False, call_band=False)
        if dxcc:
            res["dxcc_worked"] = self.db.execute("SELECT 1 FROM qso WHERE dxcc=? LIMIT 1", (dxcc,)).fetchone() is not None
            if band:
                res["dxcc_band"] = self.db.execute("SELECT 1 FROM qso WHERE dxcc=? AND band=? LIMIT 1",
                                                   (dxcc, band)).fetchone() is not None
            if mode:
                res["dxcc_mode"] = self.db.execute("SELECT 1 FROM qso WHERE dxcc=? AND mode=? LIMIT 1",
                                                   (dxcc, mode)).fetchone() is not None
        if band:
            res["call_band"] = self.db.execute("SELECT 1 FROM qso WHERE call=? AND band=? LIMIT 1",
                                               (call.upper(), band)).fetchone() is not None
        return res

    def matrix(self, where: str, args: list) -> dict:
        """Gearbeitet/bestaetigt je Band und Modegruppe: {band: {CW|Phone|Digital: 'W'|'C'}}."""
        out = {}
        conf = "(UPPER(IFNULL(qsl_rcvd,'')) IN ('Y','V') OR UPPER(IFNULL(lotw_qsl_rcvd,'')) IN ('Y','V'))"
        for band, mode, c in self.db.execute(f"SELECT band, mode, MAX({conf}) FROM qso WHERE {where} GROUP BY band, mode", args):
            mg = _mgroup(mode)
            if not band or not mg:
                continue
            cell = out.setdefault(band, {})
            if c or cell.get(mg) != "C":
                cell[mg] = "C" if c else cell.get(mg) or "W"
        return out

    def abm(self) -> dict:
        """Mengen fuer die A:B:M-Spalten im DX-Cluster (Any / Band / Mode) - zwischengespeichert bis zur naechsten Aenderung."""
        if getattr(self, "_abm_v", -1) == self.version:
            return self._abm
        S = {k: set() for k in ("dx", "dxb", "dxm", "cq", "cqb", "cqm", "itu", "itub", "itum", "gr", "grb", "grm", "call", "callb")}
        for call, dx, band, mode, cq, itu, grid in self.db.execute("SELECT call, dxcc, band, mode, cqz, ituz, gridsquare FROM qso"):
            mg = _mgroup(mode); g4 = (grid or "")[:4].upper()
            S["call"].add(call); S["callb"].add((call, band))
            for key, val in (("dx", dx), ("cq", cq), ("itu", itu), ("gr", g4)):
                if val:
                    S[key].add(val); S[key + "b"].add((val, band)); S[key + "m"].add((val, mg))
        self._abm, self._abm_v = S, self.version
        return S

    def worked_sets(self) -> tuple[set, set, set]:
        """Fuer schnelle Spot-Markierung: gearbeitete DXCC, (DXCC, Band), Rufzeichen."""
        d, db, c = set(), set(), set()
        for dx, band, call in self.db.execute("SELECT dxcc, band, call FROM qso"):
            if dx:
                d.add(dx); db.add((dx, band))
            c.add(call)
        return d, db, c

    def stats(self) -> dict:
        q = lambda s: self.db.execute(s).fetchall()
        return dict(
            total=q("SELECT COUNT(*) FROM qso")[0][0],
            dxcc=q("SELECT COUNT(DISTINCT dxcc) FROM qso WHERE dxcc IS NOT NULL")[0][0],
            calls=q("SELECT COUNT(DISTINCT call) FROM qso")[0][0],
            by_band=[dict(band=b or "?", n=n, dxcc=x) for b, n, x in
                     q("SELECT band, COUNT(*), COUNT(DISTINCT dxcc) FROM qso GROUP BY band ORDER BY COUNT(*) DESC")],
            by_mode=[dict(mode=m or "?", n=n) for m, n in
                     q("SELECT mode, COUNT(*) FROM qso GROUP BY mode ORDER BY COUNT(*) DESC")],
            by_cont=[dict(cont=c or "?", n=n) for c, n in
                     q("SELECT cont, COUNT(*) FROM qso GROUP BY cont ORDER BY COUNT(*) DESC")],
        )


def _mgroup(mode: str) -> str:
    m = (mode or "").upper()
    if m == "CW":
        return "CW"
    if m in ("SSB", "USB", "LSB", "AM", "FM", "DIGITALVOICE"):
        return "Phone"
    return "Digital" if m else ""
