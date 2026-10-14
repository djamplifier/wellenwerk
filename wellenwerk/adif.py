"""ADIF lesen und schreiben (ADIF 3.1)."""
import re
from datetime import datetime, timezone

_TAG = re.compile(r"<([A-Za-z0-9_]+)(?::(\d+))?(?::[A-Za-z])?>")


def parse(text: str) -> list[dict]:
    """ADIF-Text -> Liste von Datensaetzen (Feldnamen klein)."""
    eoh = re.search(r"<eoh>", text, re.I)
    i = eoh.end() if eoh else 0
    records, cur = [], {}
    while True:
        m = _TAG.search(text, i)
        if not m:
            break
        name = m.group(1).lower()
        if name == "eor":
            if cur:
                records.append(cur)
            cur = {}
            i = m.end()
            continue
        if name == "eoh":
            cur = {}
            i = m.end()
            continue
        n = int(m.group(2) or 0)
        cur[name] = text[m.end():m.end() + n]
        i = m.end() + n
    if cur:
        records.append(cur)
    return records


def _field(name: str, value) -> str:
    v = "" if value is None else str(value)
    return f"<{name.upper()}:{len(v)}>{v} " if v != "" else ""


def export(records: list[dict], program: str = "Wellenwerk", version: str = "0.1") -> str:
    now = datetime.now(timezone.utc).strftime("%Y%m%d %H%M%S")
    out = [f"Wellenwerk ADIF Export\n<ADIF_VER:5>3.1.4 <PROGRAMID:{len(program)}>{program} "
           f"<PROGRAMVERSION:{len(version)}>{version} <CREATED_TIMESTAMP:15>{now} <EOH>\n"]
    for r in records:
        out.append("".join(_field(k, v) for k, v in r.items()) + "<EOR>\n")
    return "".join(out)
