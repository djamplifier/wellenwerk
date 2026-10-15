"""Fehlerprotokoll: sammelt Fehler aus Dienst, Oberflaeche und Desktop-Programm und schickt sie auf Wunsch per E-Mail.

Erfasst werden unbehandelte Ausnahmen (auch in Threads und asyncio-Aufgaben), Protokolleintraege ab ERROR,
Skriptfehler und Fehlermeldungen der Oberflaeche (POST /api/errors) und Abstuerze des Desktop-Programms.
Gleiche Fehler werden zusammengefasst (Zaehler), Passwoerter und Schluessel vor dem Speichern unkenntlich gemacht.

Versand: ueber ein eingetragenes SMTP-Konto oder - ohne Konto - direkt an den Mailserver der Empfaengeradresse
(MX-Eintrag, bevorzugt IPv6; ueber IPv4 lehnen viele Mailserver Privatanschluesse ab).
"""
import asyncio
import hashlib
import json
import logging
import platform
import re
import smtplib
import socket
import ssl
import sys
import threading
import time
import traceback
import urllib.request
from collections import deque
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

log = logging.getLogger("ww.errors")
# Annahmestelle fuer Rueckmeldungen (relay/worker.js); daraus werden Issues auf GitHub
REPORT_URL = __import__("os").environ.get("WW_REPORT_URL", "https://wellenwerk-meldungen.maadclaw.workers.dev")
KEEP = 1000                     # Eintraege in errors.jsonl
_SECRET_RE = re.compile(r"(?i)((?:pass(?:word|wort)?|pwd|token|api[_-]?key|secret)[\"']?\s*[:=]\s*[\"']?|(?:bearer|basic)\s+)([^\s\"'&,;]{3,})")


class ErrorLog:
    def __init__(self, data: Path, cfg: dict, version: str, secrets=(), notify=None):
        self.path = data / "errors.jsonl"
        self.cfg, self.version, self.secret_keys, self.notify = cfg, version, secrets, notify
        self.entries: deque = deque(maxlen=KEEP)
        self.pending: list[dict] = []     # noch nicht gemeldete Eintraege
        self.last_mail = 0.0
        self.sent_today: tuple[str, int] = ("", 0)
        self.last_result = ""
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None
        self._busy = False                # waehrend des Versands keine Rueckkopplung (Fehler beim Senden)
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines()[-KEEP:]:
                self.entries.append(json.loads(line))
        except FileNotFoundError:
            pass
        except Exception as e:
            log.warning("Fehlerprotokoll nicht lesbar: %s", e)

    # ---------- Erfassen ----------
    def scrub(self, text: str) -> str:
        text = _SECRET_RE.sub(lambda m: m.group(1) + "••••••", str(text or ""))
        for k in self.secret_keys:
            v = self.cfg.get(k)
            if isinstance(v, str) and len(v) >= 4:
                text = text.replace(v, "••••••")
        return text

    def add(self, source: str, message: str, detail: str = "", where: str = "", level: str = "error") -> dict | None:
        message, detail, where = self.scrub(message)[:2000], self.scrub(detail)[:20000], self.scrub(where)[:500]
        if not message.strip():
            return None
        sig = hashlib.sha1(f"{source}|{level}|{message.splitlines()[0][:300]}|{where}".encode()).hexdigest()[:12]
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._lock:
            hit = next((e for e in reversed(self.entries) if e["sig"] == sig), None)
            if hit and hit.get("version") == self.version:
                hit["count"] += 1
                hit["last"] = now
                e = hit
            else:
                e = dict(sig=sig, first=now, last=now, count=1, source=source, level=level, message=message,
                         detail=detail, where=where, version=self.version)
                self.entries.append(e)
            if e not in self.pending:
                self.pending.append(e)
            self._save()
        if self._loop and self._wake and not self._busy:
            self._loop.call_soon_threadsafe(self._wake.set)
        return e

    def _save(self):
        try:
            self.path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in self.entries), encoding="utf-8")
        except OSError:
            pass

    def clear(self):
        with self._lock:
            self.entries.clear()
            self.pending.clear()
            self._save()

    def install(self):
        """Haken in logging, sys/threading.excepthook setzen. Einmal beim Start aufrufen."""
        el = self

        class Handler(logging.Handler):
            def emit(self, rec):
                if rec.name.startswith("ww.errors") or el._busy:
                    return
                try:
                    detail = "".join(traceback.format_exception(*rec.exc_info)) if rec.exc_info else ""
                    el.add("server", rec.getMessage(), detail, f"{rec.name} {rec.pathname.rsplit('/', 1)[-1]}:{rec.lineno}")
                except Exception:
                    pass

        h = Handler(level=logging.ERROR)
        logging.getLogger().addHandler(h)
        for name in ("uvicorn.error", "uvicorn"):      # uvicorn gibt Fehler nicht immer an die Wurzel weiter
            lg = logging.getLogger(name)
            if not lg.propagate:
                lg.addHandler(h)
        prev = sys.excepthook

        def hook(t, v, tb):
            el.add("server", f"{t.__name__}: {v}", "".join(traceback.format_exception(t, v, tb)), "unbehandelt")
            prev(t, v, tb)
        sys.excepthook = hook
        tprev = threading.excepthook

        def thook(a):
            if a.exc_type is not SystemExit:
                el.add("server", f"{a.exc_type.__name__}: {a.exc_value}",
                       "".join(traceback.format_exception(a.exc_type, a.exc_value, a.exc_traceback)), f"Thread {a.thread.name if a.thread else ''}")
            tprev(a)
        threading.excepthook = thook

    def attach_loop(self, loop: asyncio.AbstractEventLoop):
        prev = loop.get_exception_handler()

        def handler(lp, ctx):
            exc = ctx.get("exception")
            msg = f"{type(exc).__name__}: {exc}" if exc else ctx.get("message", "asyncio")
            detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)) if exc else str(ctx)
            self.add("server", msg, detail, "asyncio")
            if prev:
                prev(lp, ctx)
            else:
                lp.default_exception_handler(ctx)
        loop.set_exception_handler(handler)

    # ---------- Versand ----------
    def enabled(self) -> bool:
        return bool(self.cfg.get("err_mail_on") and (self.cfg.get("err_mail_to") or "").strip())

    async def run(self):
        """Laufende Aufgabe: neue Fehler sammeln (kurz warten, damit Folgefehler in dieselbe Mail kommen), dann senden."""
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        self.attach_loop(self._loop)
        if self.pending:
            self._wake.set()
        while True:
            await self._wake.wait()
            self._wake.clear()
            if not self.pending:
                continue
            await asyncio.sleep(60)                                     # Folgefehler einsammeln
            await self.report_auto()
            if not self.enabled():
                with self._lock:
                    self.pending = []
                continue
            gap = max(5, int(self.cfg.get("err_mail_interval") or 30)) * 60
            wait = self.last_mail + gap - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
            day = datetime.now().strftime("%Y-%m-%d")
            if self.sent_today[0] == day and self.sent_today[1] >= 20:   # Notbremse: hoechstens 20 Mails am Tag
                continue
            with self._lock:
                batch, self.pending = self.pending, []
            if not batch or not self.enabled():
                continue
            try:
                await self.send(batch)
                self.sent_today = (day, (self.sent_today[1] if self.sent_today[0] == day else 0) + 1)
            except Exception as e:
                with self._lock:            # beim naechsten Mal erneut versuchen
                    self.pending = batch + [x for x in self.pending if x not in batch]
                self.last_mail = time.time()
                log.warning("Fehlerbericht nicht gesendet: %s", e)

    def system_info(self) -> dict:
        import os
        return dict(version=self.version, system=f"{platform.system()} {platform.release()} ({platform.machine()})",
                    python=platform.python_version(), host=socket.gethostname(),
                    art="Desktop-Programm" if os.environ.get("WW_DESKTOP") == "1" else ("Programmpaket" if getattr(sys, "frozen", False) else "Server (Quellcode)"),
                    station=(self.cfg.get("callsign") or "").upper())

    def compose(self, batch: list[dict], test: bool = False) -> EmailMessage:
        si = self.system_info()
        to = self.cfg.get("err_mail_to", "").strip()
        sender = (self.cfg.get("smtp_from") or self.cfg.get("smtp_user") or "").strip() if self.cfg.get("smtp_host") else ""
        if not sender or "@" not in sender:
            sender = to                       # ohne eigenes Konto: Absender = Empfaenger (Filterregel moeglich)
        m = EmailMessage()
        who = si["station"] or si["host"]
        if test:
            m["Subject"] = f"[Wellenwerk] Testnachricht von {who}"
        else:
            n = sum(e["count"] for e in batch)
            m["Subject"] = f"[Wellenwerk {self.version}] {n} Fehler auf {who}: {batch[0]['message'].splitlines()[0][:80]}"
        m["From"] = f"Wellenwerk <{sender}>"
        m["To"] = to
        m["Date"] = formatdate(localtime=True)
        m["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
        m["X-Mailer"] = f"Wellenwerk {self.version}"
        lines = ["Wellenwerk-Fehlerbericht" if not test else "Testnachricht – der Fehlerbericht per E-Mail funktioniert.", ""]
        lines += [f"{k:9}: {v}" for k, v in si.items()] + [f"Zeit     : {datetime.now().astimezone().strftime('%d.%m.%Y %H:%M:%S %Z')}", ""]
        for i, e in enumerate(batch, 1):
            lines += ["=" * 72, f"{i}. [{e['source']}{'/' + e['level'] if e['level'] != 'error' else ''}] {e['message']}",
                      f"   {e['count']}× · zuerst {e['first']} · zuletzt {e['last']}" + (f" · {e['where']}" if e.get("where") else "")]
            if e.get("detail"):
                lines += ["", e["detail"].rstrip()]
            lines.append("")
        m.set_content("\n".join(lines))
        return m

    async def send(self, batch: list[dict], test: bool = False) -> str:
        msg = self.compose(batch, test)
        self._busy = True
        try:
            how = await asyncio.to_thread(self._deliver, msg)
        finally:
            self._busy = False
        self.last_mail = time.time()
        self.last_result = f"{datetime.now().strftime('%d.%m.%Y %H:%M')}: gesendet an {msg['To']} ({how})"
        return self.last_result

    def feedback_text(self, kind: str, text: str, contact: str, attach: bool, public: bool = False) -> tuple[str, str]:
        """Betreff und Text einer Rueckmeldung (fuer E-Mail und GitHub). public: ohne Rechnername/Rufzeichen,
        Pfade mit Benutzernamen gekuerzt – nur was der Nutzer selbst als Kontakt angibt, erscheint."""
        si = self.system_info()
        if public:
            si = {k: v for k, v in si.items() if k not in ("host", "station")}
        first = (text.strip().splitlines() or [""])[0][:80]
        subject = f"[Wellenwerk {self.version} {kind}] {first}"
        lines = ["", text.strip(), "", "-" * 40]
        lines += [f"{k:9}: {v}" for k, v in si.items()]
        if attach:
            recent = list(reversed(self.entries))[:15]
            lines += ["", f"Fehlerprotokoll (letzte {len(recent)}):"] if recent else ["", "Fehlerprotokoll: leer"]
            for e in recent:
                lines += [f"- [{e['source']}] {e['count']}× {e['last']} {e['message'].splitlines()[0][:200]}" + (f" ({e['where'][:80]})" if e.get("where") else "")]
                if e.get("detail"):
                    lines += ["    " + x for x in e["detail"].strip().splitlines()[-6:]]
        body = self.scrub("\n".join(lines))
        if public:                    # Text des Nutzers bleibt, Protokoll und Systemdaten werden anonymisiert
            cut = body.index("-" * 40)
            body = body[:cut] + self.anonymize(body[cut:])
            subject = f"{kind}: {first}"
        return subject, f"Art: {kind}\nKontakt: {contact or '–'}\n" + body

    async def send_feedback(self, kind: str, text: str, contact: str, attach: bool) -> str:
        subject, body = self.feedback_text(kind, text, contact, attach)
        to = (self.cfg.get("err_mail_to") or "").strip()
        sender = (self.cfg.get("smtp_from") or self.cfg.get("smtp_user") or "").strip() if self.cfg.get("smtp_host") else ""
        if not sender or "@" not in sender:
            sender = to
        m = EmailMessage()
        m["Subject"], m["From"], m["To"], m["Date"] = subject, f"Wellenwerk <{sender}>", to, formatdate(localtime=True)
        m["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
        if contact and "@" in contact and " " not in contact.strip():
            m["Reply-To"] = contact.strip()
        m.set_content(body)
        self._busy = True
        try:
            how = await asyncio.to_thread(self._deliver, m)
        finally:
            self._busy = False
        return f"gesendet an {to} ({how})"

    # ---------- an die Entwickler (GitHub ueber die Annahmestelle) ----------
    def report_url(self) -> str:
        return (self.cfg.get("report_url") or REPORT_URL or "").rstrip("/")

    def anonymize(self, text: str) -> str:
        text = self.scrub(text).replace(str(Path.home()), "~")
        for k in ("callsign", "locator", "operator"):
            v = (self.cfg.get(k) or "").strip()
            if len(v) >= 3:
                text = re.sub(re.escape(v), "…", text, flags=re.I)
        return re.sub(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b", "…@…", text)

    def post_report(self, payload: dict) -> dict:
        url = self.report_url()
        if not url:
            raise RuntimeError("Keine Annahmestelle eingetragen")
        data = json.dumps({"client": f"Wellenwerk {self.version}", "version": self.version, **payload}).encode()
        req = urllib.request.Request(url + "/report", data=data, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": f"Wellenwerk/{self.version}"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                msg = json.load(e).get("error")
            except Exception:
                msg = ""
            raise RuntimeError(msg or f"Annahmestelle antwortet {e.code}")

    async def report_auto(self):
        """Neue Programmfehler (keine Bedienmeldungen) anonym an die Entwickler – nur mit Zustimmung (err_github)."""
        if not (self.cfg.get("err_github") and self.report_url()):
            return
        si = self.system_info()
        todo = [e for e in list(self.entries) if e["level"] == "error" and not e.get("gh") and e.get("version") == self.version][:5]
        for e in todo:
            text = "\n".join([f"{e['message']}", "", f"Quelle: {e['source']} · Ort: {e.get('where', '')}", f"Anzahl: {e['count']} · zuerst {e['first']}",
                              f"System: {si['system']} · {si['art']} · Python {si['python']}", "", e.get("detail") or ""])
            try:
                await asyncio.to_thread(self.post_report, dict(kind="Fehlerbericht", auto=True, sig=f"{self.version}-{e['sig']}",
                                                               title=self.anonymize(e["message"].splitlines()[0])[:140], text=self.anonymize(text)))
                e["gh"] = True
            except Exception as ex:
                log.info("Fehlerbericht an Entwickler nicht gesendet: %s", ex)
                break
        if todo:
            with self._lock:
                self._save()

    def _deliver(self, msg: EmailMessage) -> str:
        c = self.cfg
        host = (c.get("smtp_host") or "").strip()
        if host:
            port = int(c.get("smtp_port") or 587)
            sec = c.get("smtp_security") or ("ssl" if port == 465 else "starttls")
            ctx = ssl.create_default_context()
            s = smtplib.SMTP_SSL(host, port, timeout=30, context=ctx, local_hostname=_helo_name()) if sec == "ssl" else smtplib.SMTP(host, port, timeout=30, local_hostname=_helo_name())
            try:
                s.ehlo()
                if sec == "starttls":
                    s.starttls(context=ctx)
                    s.ehlo()
                if c.get("smtp_user"):
                    s.login(c["smtp_user"], c.get("smtp_pass") or "")
                s.send_message(msg)
            finally:
                try:
                    s.quit()
                except Exception:
                    pass
            return f"über {host}"
        return self._direct(msg)

    def _direct(self, msg: EmailMessage) -> str:
        """Ohne Konto: direkt beim Mailserver der Empfaengerdomain abliefern."""
        domain = msg["To"].rsplit("@", 1)[-1].strip(" >")
        mxs = mx_lookup(domain) or [domain]
        errors = []
        for mx in mxs[:3]:
            addrs = []
            for fam in (socket.AF_INET6, socket.AF_INET):
                try:
                    addrs += [a[4][0] for a in socket.getaddrinfo(mx, 25, fam, socket.SOCK_STREAM)][:1]
                except OSError:
                    pass
            for ip in addrs:
                try:
                    s = smtplib.SMTP(timeout=30, local_hostname=_helo_name())
                    code, banner = s.connect(ip, 25)
                    if code != 220:
                        raise smtplib.SMTPConnectError(code, banner)
                    s._host = mx                     # Zertifikat gegen den Namen pruefen, nicht gegen die IP
                    s.ehlo()
                    if s.has_extn("starttls"):
                        try:
                            s.starttls(context=ssl.create_default_context())
                        except ssl.SSLError:           # Zertifikat ungueltig: unverschluesselt neu verbinden
                            s.close()
                            s = smtplib.SMTP(timeout=30, local_hostname=_helo_name())
                            s.connect(ip, 25)
                        s.ehlo()
                    s.send_message(msg, from_addr="")   # leerer Absender: sonst gilt Absender=Empfaenger als „lokale“ Mail
                    s.quit()
                    return f"direkt an {mx}"
                except (OSError, smtplib.SMTPException) as e:
                    errors.append(f"{mx} [{ip}]: {_short(e)}")
        raise RuntimeError("Direktversand abgelehnt – bitte ein SMTP-Konto eintragen. " + "; ".join(errors[-3:]))


def _short(e) -> str:
    if isinstance(e, smtplib.SMTPResponseException):
        return f"{e.smtp_code} {e.smtp_error.decode(errors='replace') if isinstance(e.smtp_error, bytes) else e.smtp_error}"[:160]
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        return "; ".join(f"{c} {m.decode(errors='replace')}" for c, m in e.recipients.values())[:160]
    return str(e)[:160]


def _helo_name() -> str:
    n = socket.gethostname()      # nicht getfqdn(): das wartet im Heimnetz oft 30 s auf eine Rueckwaertsaufloesung
    return n if "." in n and not n.endswith((".local", ".lan", ".fritz.box", ".home", ".localdomain")) else "wellenwerk.invalid"


def mx_lookup(domain: str) -> list[str]:
    """MX-Eintraege ueber DNS-over-HTTPS (kein zusaetzliches Paket noetig)."""
    for url in (f"https://dns.google/resolve?name={domain}&type=MX", f"https://cloudflare-dns.com/dns-query?name={domain}&type=MX"):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=8) as r:
                ans = json.load(r).get("Answer") or []
            mx = sorted((int(a["data"].split()[0]), a["data"].split()[1].rstrip(".")) for a in ans if a.get("type") == 15)
            if mx:
                return [h for _, h in mx]
        except Exception:
            continue
    return []
