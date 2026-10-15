"""Winlink-Nachrichtenformat (B2): Kopfzeilen, Text, Anhaenge; Nachrichten-ID; Q-Kodierung fuer Betreff/Dateinamen."""
import base64
import email.header
import hashlib
import re
from datetime import datetime, timezone

DATE_FMT = "%Y/%m/%d %H:%M"


def new_mid(call: str) -> str:
    h = hashlib.md5(f"{datetime.now(timezone.utc).isoformat()}-{call}".encode()).digest()
    return base64.b32encode(h).decode()[:12]


def _qenc(text: str) -> str:
    """Kopfzeilen muessen ASCII sein: Nicht-ASCII als Q-kodiertes Wort (RFC 2047)."""
    if all(32 <= ord(c) < 127 for c in text):
        return text
    cs = "ISO-8859-1" if all(ord(c) < 256 for c in text) else "UTF-8"
    return email.header.Header(text, cs).encode(maxlinelen=10000).replace("\n", "").replace("\r", "")


def _qdec(text: str) -> str:
    if "=?" not in text:
        try:
            return text.encode("latin-1").decode("utf-8")
        except UnicodeError:
            return text
    try:
        return str(email.header.make_header(email.header.decode_header(text)))
    except Exception:
        return text


def norm_addr(a: str) -> str:
    a = a.strip()
    if "@" in a and a.lower().endswith("@winlink.org"):
        a = a.split("@")[0]
    if ":" in a or "@" in a:
        return a if a.upper().startswith("SMTP:") else "SMTP:" + a
    return a.upper()


class Message:
    def __init__(self, headers: list[tuple[str, str]] | None = None, body: bytes = b"", files: list[tuple[str, bytes]] | None = None):
        self.headers = headers or []
        self.body = body
        self.files = files or []

    # ---------- Kopfzeilen ----------
    def get(self, key: str, default: str = "") -> str:
        for k, v in self.headers:
            if k.lower() == key.lower():
                return v
        return default

    def get_all(self, key: str) -> list[str]:
        return [v for k, v in self.headers if k.lower() == key.lower()]

    def set(self, key: str, value: str):
        self.headers = [(k, v) for k, v in self.headers if k.lower() != key.lower()] + [(key, value)]

    @property
    def mid(self) -> str:
        return self.get("Mid")

    @property
    def subject(self) -> str:
        return _qdec(self.get("Subject"))

    def charset(self) -> str:
        m = re.search(r"charset=\"?([\w\-]+)", self.get("Content-Type"), re.I)
        return m.group(1) if m else "ISO-8859-1"

    def text(self) -> str:
        try:
            return self.body.decode(self.charset(), errors="replace")
        except LookupError:
            return self.body.decode("latin-1")

    # ---------- erstellen ----------
    @classmethod
    def compose(cls, mycall: str, to: list[str], cc: list[str], subject: str, text: str,
                files: list[tuple[str, bytes]] | None = None, mtype: str = "Private") -> "Message":
        m = cls()
        m.set("Mid", new_mid(mycall))
        m.set("Date", datetime.now(timezone.utc).strftime(DATE_FMT))
        m.set("Type", mtype)
        m.set("From", mycall.upper())
        for a in to:
            m.headers.append(("To", norm_addr(a)))
        for a in cc:
            m.headers.append(("Cc", norm_addr(a)))
        m.set("Subject", _qenc(subject))
        m.set("Mbo", mycall.upper())
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
        try:
            body, cs = text.encode("ISO-8859-1"), "ISO-8859-1"
        except UnicodeEncodeError:
            body, cs = text.encode("utf-8"), "UTF-8"
        m.body = body
        m.set("Body", str(len(body)))
        m.set("Content-Type", f"text/plain; charset={cs}")
        m.set("Content-Transfer-Encoding", "8bit")
        for name, data in files or []:
            m.files.append((name, data))
            m.headers.append(("File", f"{len(data)} {_qenc(name)}"))
        return m

    def validate(self) -> str:
        if not self.mid or len(self.mid) > 12:
            return "Nachrichten-ID fehlt oder zu lang"
        if not (self.get_all("To") or self.get_all("Cc")):
            return "kein Empfänger"
        if not self.get("From"):
            return "Absender fehlt"
        if not self.get("Subject"):
            return "Betreff fehlt"
        if len(self.get("Subject")) > 128:
            return "Betreff zu lang"
        if not self.body:
            return "Text fehlt"
        return ""

    # ---------- Byte-Format ----------
    def to_bytes(self) -> bytes:
        keys = sorted({k for k, _ in self.headers if k.lower() != "mid"}, key=lambda k: k)
        out = [f"Mid: {self.mid}\r\n"]
        for key in keys:
            for v in self.get_all(key):
                out.append(f"{key}: {v.strip()}\r\n")
        b = "".join(out).encode("latin-1", "replace") + b"\r\n" + self.body
        if self.files:
            b += b"\r\n"
        for _, data in self.files:
            b += data + b"\r\n"
        return b

    @classmethod
    def from_bytes(cls, raw: bytes) -> "Message":
        raw = raw.lstrip(b"\r\n\t ")
        sep = raw.find(b"\r\n\r\n")
        if sep < 0:
            sep2 = raw.find(b"\n\n")
            if sep2 < 0:
                raise ValueError("Nachricht ohne Kopfzeilen-Ende")
            head, rest = raw[:sep2], raw[sep2 + 2:]
        else:
            head, rest = raw[:sep], raw[sep + 4:]
        m = cls()
        for line in head.decode("latin-1").replace("\r\n", "\n").split("\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                m.headers.append((_canon(k.strip()), v.strip()))
        n = int(m.get("Body", "0") or 0)
        m.body, rest = rest[:n], rest[n:]
        for fh in m.get_all("File"):
            if rest.startswith(b"\r\n"):
                rest = rest[2:]
            size, _, name = fh.partition(" ")
            size = int(size or 0)
            m.files.append((_qdec(name), rest[:size]))
            rest = rest[size:]
        return m

    def summary(self) -> dict:
        return dict(mid=self.mid, date=self.get("Date"), sender=self.get("From"), to=self.get_all("To"), cc=self.get_all("Cc"),
                    subject=self.subject, type=self.get("Type"), size=len(self.to_bytes()),
                    files=[dict(name=n, size=len(d)) for n, d in self.files])


def _canon(k: str) -> str:
    return "-".join(p[:1].upper() + p[1:].lower() for p in k.split("-"))
