"""Tastatur-QSO (Text-Chat) ueber die Modem-Verbindungen von Winlink: ARDOP, VARA (TCP-Schnittstelle), Packet (AGW)
und Telnet-Peer. Zeilenweise Klartext (\\r-getrennt), kompatibel zu einfachen Terminal-Programmen.
Anrufen oder auf Anrufe warten; Modem-Einstellungen wie bei Winlink (Programmoptionen → Winlink)."""
import asyncio
import logging
import time

from .winlink.transports import AgwLink, ArdopLink, LinkError, TelnetLink, VaraLink

log = logging.getLogger("ww.chat")


class Chat:
    def __init__(self, cfg, identity, ptt, notify, set_freq, busy_other):
        self.cfg, self.identity, self.ptt, self.notify, self.set_freq, self.busy_other = cfg, identity, ptt, notify, set_freq, busy_other
        self.link = None
        self.task = None
        self.stop_ev = asyncio.Event()
        self.lines: list[dict] = []
        self.state = dict(phase="", method="", peer="", since=0, listening=False)

    def snapshot(self):
        return dict(self.state, lines=self.lines[-400:])

    def _add(self, kind: str, text: str, notify=True):
        self.lines.append(dict(t=time.strftime("%H:%M:%S", time.gmtime()), kind=kind, text=text))
        self.lines = self.lines[-1000:]
        if notify:
            self.notify(dict(type="chat", line=self.lines[-1], state=self.state))

    def _set(self, **kw):
        self.state.update(kw)
        self.notify(dict(type="chat", state=self.state))

    async def _ptt(self, on):
        if self.cfg.get("wl_ptt", "rig") == "rig":
            try:
                await self.ptt(on)
            except Exception as e:
                self._add("err", f"PTT über das Funkgerät nicht möglich: {e}")

    def start(self, method: str, target: str = "", listen: bool = False, freq: str = ""):
        if self.task and not self.task.done():
            raise RuntimeError("Es läuft schon ein Chat – erst trennen")
        if self.busy_other():
            raise RuntimeError("Das Modem ist gerade mit Winlink beschäftigt")
        if not listen and not target:
            raise RuntimeError("Gegenstation fehlt")
        self.stop_ev = asyncio.Event()
        self._set(phase="warten" if listen else "verbinden", method=method, peer=target.upper(), since=time.time(), listening=listen)
        self.task = asyncio.create_task(self._run(method, target.upper().strip(), listen, freq))

    async def _open(self, method, target, listen):
        c, me = self.cfg, self.identity()
        mycall, loc = me["callsign"], me["locator"]
        st = lambda s: self._add("info", s)
        if method == "ardop":
            h, p, bw = c.get("ardop_host") or "127.0.0.1", int(c.get("ardop_port") or 8515), c.get("ardop_bw") or "2000MAX"
            return await (ArdopLink.listen(h, p, mycall, bw, loc, self._ptt, st, self.stop_ev) if listen else
                          ArdopLink.open(h, p, mycall, target, bw, loc, self._ptt, st))
        if method == "vara":
            h, p, bw = c.get("vara_host") or "127.0.0.1", int(c.get("vara_port") or 8300), str(c.get("vara_bw") or "2300")
            return await (VaraLink.listen(h, p, mycall, bw, self._ptt, st, self.stop_ev) if listen else
                          VaraLink.open(h, p, mycall, target, bw, self._ptt, st))
        if method == "packet":
            h, p, rp = c.get("agw_host") or "127.0.0.1", int(c.get("agw_port") or 8000), int(c.get("agw_radio_port") or 0)
            return await (AgwLink.listen(h, p, rp, mycall, st, self.stop_ev) if listen else AgwLink.open(h, p, rp, mycall, target, "", st))
        if method == "telnet":
            if listen:
                raise LinkError("Telnet: nur Anrufen möglich (Adresse host:port als Gegenstation)")
            host, _, port = target.partition(":")
            return await TelnetLink.open(host, int(port or 8774), mycall, "")
        raise LinkError(f"unbekannter Verbindungsweg {method}")

    async def _run(self, method, target, listen, freq):
        try:
            if freq and self.set_freq:
                try:
                    await self.set_freq(int(float(freq) * 1000))
                    self._add("info", f"Funkgerät auf {float(freq):.1f} kHz")
                except Exception as e:
                    self._add("err", f"Frequenz nicht gesetzt: {e}")
            while True:
                self._add("info", "warte auf Anrufe …" if listen else f"rufe {target} …")
                self.link = await self._open(method, target, listen)
                peer = (self.link.remote or target or "?").upper()
                self._set(phase="verbunden", peer=peer, since=time.time())
                self._add("ok", f"verbunden mit {peer}" + (f" ({self.link.bw} Hz)" if getattr(self.link, "bw", "") else ""))
                buf = b""
                while True:
                    data = await self.link.reader.read(4096)
                    if not data:
                        break
                    buf += data
                    while True:
                        i = min([x for x in (buf.find(b"\r"), buf.find(b"\n")) if x >= 0], default=-1)
                        if i < 0:
                            break
                        line, buf = buf[:i], buf[i + 1:]
                        if line.strip():
                            self._add("rx", line.decode("utf-8", "replace") if _utf8(line) else line.decode("latin-1"))
                    if buf and len(buf) > 300:
                        self._add("rx", buf.decode("utf-8", "replace"))
                        buf = b""
                if buf.strip():
                    self._add("rx", buf.decode("utf-8", "replace"))
                self._add("info", f"{peer} hat getrennt")
                await self._close_link()
                if not listen:
                    break
                self._set(phase="warten", peer="")
        except asyncio.CancelledError:
            raise
        except (LinkError, OSError, asyncio.IncompleteReadError) as e:
            if not self.stop_ev.is_set():
                self._add("err", str(e) or type(e).__name__)
        except Exception as e:
            log.exception("Chat")
            self._add("err", f"Fehler: {e}")
        finally:
            await self._close_link()
            self._set(phase="", listening=False, peer="")

    async def _close_link(self):
        if self.link:
            try:
                await self.link.close(timeout=60) if hasattr(self.link, "abort") else await self.link.close()
            except Exception:
                pass
            self.link = None

    async def send(self, text: str):
        if not self.link or self.state["phase"] != "verbunden":
            raise RuntimeError("keine Verbindung")
        data = text.replace("\n", "\r").rstrip("\r") + "\r"
        await self.link.write(data.encode("utf-8"))
        self._add("tx", text)

    async def stop(self):
        self.stop_ev.set()
        if self.link and hasattr(self.link, "close"):
            await self._close_link()
        if self.task and not self.task.done():
            self.task.cancel()
        self._set(phase="", listening=False, peer="")
        self._add("info", "Chat beendet")


def _utf8(b: bytes) -> bool:
    try:
        b.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False
