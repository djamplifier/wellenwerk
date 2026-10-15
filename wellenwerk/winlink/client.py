"""Steuerung einer Winlink-Sitzung: Verbindung aufbauen, B2F austauschen, Postfach pflegen, Fortschritt melden."""
import asyncio
import logging
import time

from .b2f import B2FError, Session
from .mailbox import Mailbox
from .transports import AgwLink, ArdopLink, LinkError, TelnetLink, VaraLink

log = logging.getLogger("ww.winlink")
CMS_HOST, CMS_PORT = "server.winlink.org", 8772


class Winlink:
    def __init__(self, root, cfg, ptt, notify, set_freq=None, version="1.1", identity=None):
        self.box = Mailbox(root)
        self.identity = identity or (lambda: dict(winlink_call=(cfg.get("wl_call") or cfg.get("callsign") or "").upper(), locator=cfg.get("locator", "")))
        self.cfg, self.ptt, self.notify, self.set_freq, self.version = cfg, ptt, notify, set_freq, version
        self.task: asyncio.Task | None = None
        self.link = None
        self.lines: list[dict] = []
        self.state = dict(busy=False, method="", target="", phase="", started=0)

    def snapshot(self) -> dict:
        return dict(self.state, log=self.lines[-300:], counts=self.box.counts())

    def _say(self, text: str, kind: str = "info"):
        self.lines.append(dict(t=time.strftime("%H:%M:%S"), text=text, kind=kind))
        self.lines = self.lines[-500:]
        log.info("Winlink: %s", text)
        self.notify(dict(type="winlink", line=self.lines[-1], state=self.state, counts=self.box.counts()))

    def start(self, method: str, target: str, opts: dict):
        if self.task and not self.task.done():
            raise RuntimeError("Es läuft schon eine Winlink-Verbindung")
        mycall = self.identity()["winlink_call"].strip()
        if not mycall:
            raise RuntimeError("Rufzeichen fehlt (Programmoptionen → Station oder Winlink)")
        if method != "telnet" and not target:
            raise RuntimeError("Gegenstation (RMS oder Rufzeichen) fehlt")
        self.state = dict(busy=True, method=method, target=(target or "CMS").upper(), phase="verbinden", started=time.time())
        self.task = asyncio.create_task(self._run(method, target.upper().strip(), mycall, opts))

    async def abort(self):
        if self.link and hasattr(self.link, "abort"):
            await self.link.abort()
        if self.task and not self.task.done():
            self.task.cancel()
        self._say("Verbindung abgebrochen", "warn")

    async def _ptt(self, on: bool):
        if self.cfg.get("wl_ptt", "rig") == "rig":
            try:
                await self.ptt(on)
            except Exception as e:
                self._say(f"PTT über das Funkgerät nicht möglich: {e}", "err")

    async def _run(self, method, target, mycall, opts):
        c = self.cfg
        password = c.get("wl_password", "")
        st = lambda s: self._say(s)
        try:
            if opts.get("freq") and self.set_freq and method != "telnet":
                try:
                    await self.set_freq(int(float(opts["freq"]) * 1000))
                    self._say(f"Funkgerät auf {float(opts['freq']):.1f} kHz gestellt")
                except Exception as e:
                    self._say(f"Frequenz nicht gesetzt: {e}", "warn")
            if method == "telnet":
                p2p = bool(opts.get("host"))
                host = opts.get("host") or c.get("wl_telnet_host") or CMS_HOST
                port = int(opts.get("port") or c.get("wl_telnet_port") or CMS_PORT)
                self._say(f"Telnet zu {host}:{port} …")
                self.link = await TelnetLink.open(host, port, mycall, "" if p2p else "CMSTelnet")
                tcall = target or ("WL2K" if not p2p else "")
            elif method == "ardop":
                self._say(f"ARDOP-Anruf an {target} ({c.get('ardop_bw') or '2000MAX'}) …")
                self.link = await ArdopLink.open(c.get("ardop_host") or "127.0.0.1", int(c.get("ardop_port") or 8515), mycall, target,
                                                 c.get("ardop_bw") or "2000MAX", self.identity()["locator"], self._ptt, st)
                tcall = target
            elif method == "vara":
                self._say(f"VARA-Anruf an {target} …")
                self.link = await VaraLink.open(c.get("vara_host") or "127.0.0.1", int(c.get("vara_port") or 8300), mycall, target,
                                                str(c.get("vara_bw") or "2300"), self._ptt, st)
                tcall = target
            elif method == "packet":
                via = opts.get("via", "")
                self._say(f"Packet-Verbindung zu {target}{' via ' + via if via else ''} …")
                self.link = await AgwLink.open(c.get("agw_host") or "127.0.0.1", int(c.get("agw_port") or 8000),
                                               int(c.get("agw_radio_port") or 0), mycall, target, via, st)
                tcall = target
            else:
                raise LinkError(f"unbekannter Verbindungsweg {method}")
            self.state["phase"] = "austausch"
            self._say(f"verbunden mit {self.link.remote or tcall}{' (' + self.link.bw + ' Hz)' if self.link.bw else ''}", "ok")
            outbox = self.box.outbox()
            if opts.get("receive_only"):
                outbox = []
            sess = Session(self.link.reader, self.link.write, mycall, tcall or target, password, self.identity()["locator"], outbox,
                           on_received=self._received, on_sent=self._sent, status=st, ua=("Wellenwerk", self.version))
            res = await sess.run()
            self._say(f"fertig: {len(res['received'])} empfangen, {len(res['sent'])} gesendet", "ok")
            self.state["phase"] = "trennen"
            await self.link.close()
        except asyncio.CancelledError:
            raise
        except (LinkError, B2FError) as e:
            self._say(str(e), "err")
            await self._close_quiet()
        except asyncio.TimeoutError:
            self._say("Zeitüberschreitung – Gegenstelle antwortet nicht mehr", "err")
            await self._close_quiet()
        except asyncio.IncompleteReadError:
            self._say("Verbindung unterbrochen", "err")
            await self._close_quiet()
        except Exception as e:
            log.exception("Winlink")
            self._say(f"Fehler: {e}", "err")
            await self._close_quiet()
        finally:
            self.link = None
            self.state = dict(self.state, busy=False, phase="")
            self.notify(dict(type="winlink", state=self.state, counts=self.box.counts()))

    async def _close_quiet(self):
        if self.link:
            try:
                await (self.link.abort() if hasattr(self.link, "abort") else self.link.close())
            except Exception:
                pass

    def _received(self, msg):
        self.box.store("in", msg, unread=True)
        self._say(f"Nachricht von {msg.get('From')}: {msg.subject}", "ok")

    def _sent(self, mid: str, accepted: bool):
        try:
            self.box.move("out", "sent", mid)
        except OSError:
            pass
        self._say(f"{mid} {'übertragen' if accepted else 'war bei der Gegenstelle schon vorhanden'}", "ok")
