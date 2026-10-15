"""Winlink-Postfach: Ordner mit B2-Dateien (Eingang, Ausgang, Gesendet, Archiv) wie bei anderen Winlink-Programmen."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .message import Message

FOLDERS = ("in", "out", "sent", "archive")
_MID = re.compile(r"^[A-Z0-9_\-]{1,40}$", re.I)


class Mailbox:
    def __init__(self, root: Path):
        self.root = root
        for f in FOLDERS:
            (root / f).mkdir(parents=True, exist_ok=True)
        self._readf = root / "gelesen.json"

    def _path(self, folder: str, mid: str) -> Path:
        if folder not in FOLDERS or not _MID.match(mid):
            raise ValueError("ungültiger Ordner oder Nachrichten-ID")
        return self.root / folder / f"{mid}.b2f"

    def _unread(self) -> set:
        try:
            return set(json.loads(self._readf.read_text()))
        except (OSError, ValueError):
            return set()

    def _set_unread(self, s: set):
        self._readf.write_text(json.dumps(sorted(s)))

    def list(self, folder: str) -> list[dict]:
        out, unread = [], self._unread()
        for p in (self.root / folder).glob("*.b2f"):
            try:
                s = Message.from_bytes(p.read_bytes()).summary()
            except Exception as e:
                s = dict(mid=p.stem, subject=f"(unlesbar: {e})", date="", sender="", to=[], cc=[], files=[], size=p.stat().st_size)
            s["unread"] = s["mid"] in unread
            out.append(s)
        return sorted(out, key=lambda s: s.get("date") or "", reverse=True)

    def counts(self) -> dict:
        unread = self._unread()
        return {f: len(list((self.root / f).glob("*.b2f"))) for f in FOLDERS} | {"unread": len(unread)}

    def get(self, folder: str, mid: str, mark_read: bool = True) -> Message:
        m = Message.from_bytes(self._path(folder, mid).read_bytes())
        if mark_read:
            u = self._unread()
            if mid in u:
                u.discard(mid)
                self._set_unread(u)
        return m

    def store(self, folder: str, msg: Message, unread: bool = False):
        self._path(folder, msg.mid).write_bytes(msg.to_bytes())
        if unread:
            u = self._unread()
            u.add(msg.mid)
            self._set_unread(u)

    def move(self, src: str, dst: str, mid: str):
        self._path(src, mid).rename(self._path(dst, mid))

    def delete(self, folder: str, mid: str):
        self._path(folder, mid).unlink(missing_ok=True)

    def outbox(self) -> list[Message]:
        out = []
        for p in sorted((self.root / "out").glob("*.b2f")):
            try:
                out.append(Message.from_bytes(p.read_bytes()))
            except Exception:
                pass
        return out
