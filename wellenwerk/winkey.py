"""K1EL WinKeyer (WK2/WK3, auch kompatible Nachbauten): CW ueber den seriellen Keyer statt ueber CAT.

Protokoll laut K1EL-Datenblatt: 1200 Baud, 8N2. Host Open (00 02) liefert die Firmwareversion,
02 nn setzt das Tempo, ASCII-Zeichen werden gesendet, 0A leert den Puffer, 00 03 schliesst.
Statusbytes vom Keyer: 0xC0|Bits (0x04 = sendet), Tempo-Poti: 0x80|Wert."""
import asyncio
import logging
import threading

log = logging.getLogger("ww.winkey")
ALLOWED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /?.,=+-")


class WinKeyer:
    def __init__(self, on_change=None):
        self.ser = None
        self.on_change = on_change
        self.state = dict(connected=False, device="", version=None, wpm=22, busy=False, pot=None, error="")
        self._lock = threading.Lock()
        self._reader = None
        self._loop = None

    def _emit(self):
        if self.on_change and self._loop:
            asyncio.run_coroutine_threadsafe(self.on_change(dict(self.state)), self._loop)

    def _write(self, data: bytes):
        with self._lock:
            if not self.ser:
                raise ConnectionError("WinKeyer nicht verbunden")
            self.ser.write(data)

    def _open(self, device: str, wpm: int) -> int:
        import serial
        ser = serial.Serial(device, 1200, bytesize=8, parity="N", stopbits=2, timeout=1.0)
        try:
            ser.dtr, ser.rts = True, False      # Versorgung bei Nachbauten ueber DTR
        except OSError:
            pass                                # Schnittstelle ohne Steuerleitungen (virtuell/Netz)
        ser.reset_input_buffer()
        ser.write(b"\x00\x02")                  # Host Open
        ver = ser.read(1)
        if not ver:
            ser.close()
            raise ConnectionError(f"Kein WinKeyer an {device} (keine Antwort auf Host Open)")
        ser.write(bytes([0x02, max(5, min(99, wpm))]))
        ser.timeout = 0.2
        self.ser = ser
        return ver[0]

    async def connect(self, device: str, wpm: int = 22):
        await self.disconnect()
        self._loop = asyncio.get_running_loop()
        try:
            ver = await asyncio.to_thread(self._open, device, int(wpm))
        except Exception as e:
            self.state.update(connected=False, device=device, error=str(e))
            raise ConnectionError(str(e)) from e
        self.state.update(connected=True, device=device, version=ver, wpm=int(wpm), error="")
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        log.info("WinKeyer an %s, Version %s", device, ver)
        self._emit()

    def _read_loop(self):
        while self.ser:
            try:
                b = self.ser.read(1)
            except Exception as e:
                self.state.update(connected=False, error=str(e))
                self.ser = None
                self._emit()
                return
            if not b:
                continue
            v = b[0]
            if v & 0xC0 == 0xC0:
                busy = bool(v & 0x04)
                if busy != self.state["busy"]:
                    self.state["busy"] = busy
                    self._emit()
            elif v & 0xC0 == 0x80:
                self.state["pot"] = v & 0x3F
                self._emit()

    async def disconnect(self):
        ser, self.ser = self.ser, None
        if ser:
            try:
                ser.write(b"\x00\x03")
                ser.close()
            except Exception:
                pass
        self.state.update(connected=False, busy=False)

    async def send(self, text: str):
        data = "".join(c for c in text.upper() if c in ALLOWED)
        if data:
            await asyncio.to_thread(self._write, data.encode("ascii"))

    async def stop(self):
        await asyncio.to_thread(self._write, b"\x0A")

    async def speed(self, wpm: int):
        wpm = max(5, min(99, int(wpm)))
        await asyncio.to_thread(self._write, bytes([0x02, wpm]))
        self.state["wpm"] = wpm
        self._emit()
