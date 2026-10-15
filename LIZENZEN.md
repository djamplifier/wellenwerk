# Lizenzen

## Wellenwerk

Copyright (C) 2026 die Wellenwerk-Autoren

Wellenwerk ist freie Software: Sie können es unter den Bedingungen der **GNU General Public License Version 3**
(oder nach Ihrer Wahl jeder späteren Version), wie von der Free Software Foundation veröffentlicht, weitergeben und/oder ändern.
Der vollständige Lizenztext steht in der Datei [`LICENSE`](LICENSE).

**Haftungsausschluss:** Wellenwerk wird ohne jede Gewährleistung bereitgestellt, auch ohne die stillschweigende Gewährleistung
der Marktgängigkeit oder Eignung für einen bestimmten Zweck (siehe GPL, Abschnitte 15 und 16). Die Nutzung erfolgt auf eigene Verantwortung –
das gilt insbesondere für die Steuerung von Funkgeräten, Sendern und Rotoren. Für die Einhaltung der Amateurfunk-Vorschriften
(Frequenzen, Leistung, Betriebsarten) ist die bedienende Funkamateurin bzw. der bedienende Funkamateur verantwortlich.

Wellenwerk ist ein eigenständiges Programm und steht in keiner Verbindung zu Herstellern anderer Funk-Software oder von Funkgeräten.
Genannte Produkt- und Firmennamen (z. B. von Funkgeräten oder Online-Diensten) dienen nur der Beschreibung der Kompatibilität
und sind Marken der jeweiligen Inhaber.

## Mitgelieferte und verwendete Fremdkomponenten

| Komponente | Verwendung | Lizenz |
|---|---|---|
| [Hamlib](https://github.com/Hamlib/Hamlib) (`rigctld`, `rotctld`, `rigctl`, `rotctl` und Bibliotheken) | Funkgeräte- und Rotorsteuerung, unverändert als eigene Programme mitgeliefert | GNU LGPL 2.1 (Programme: GPL 2) – Text in [`licenses/LGPL-2.1.txt`](licenses/LGPL-2.1.txt). Quelltext der mitgelieferten Versionen: <https://github.com/Hamlib/Hamlib/releases> (Windows-Paket: Version 4.6.5; macOS: Homebrew-Version zum Zeitpunkt des Baus; Linux: Ubuntu-22.04-Paket `libhamlib-utils`, Quelltext über `apt-get source hamlib`). Auf Anfrage stellen wir den Quelltext der jeweils mitgelieferten Version bereit. |
| Zeichentabellen und MT63-Symbolform aus [fldigi](https://sourceforge.net/projects/fldigi/) | `static/js/dsp2-tables.js`: MFSK-Varicode (IZ8BLY), DominoEX- und THOR-Varicode (ZL1BPU), MT63-Symbolform (Pawel Jalocha, SP9VRC) – für die Kompatibilität mit anderen Programmen | GNU GPL 3 oder später – © Dave Freese W1HKJ, Pawel Jalocha SP9VRC und weitere fldigi-Autoren |
| LZHUF-Kompression (Haruhiko Okumura, Haruyasu Yoshizaki, Kenji Rikitake) | `wellenwerk/winlink/lzhuf.py`: eigene Python-Umsetzung des Verfahrens für das Winlink-B2-Format | „Use, distribute, and modify this program freely“ (Freigabe der Autoren, siehe Kopf der Datei) |
| [wl2k-go](https://github.com/la5nta/wl2k-go) (Martin Hebnes Pedersen, LA5NTA) | Referenz für das B2F-Protokoll, die Winlink-Passwortabfrage (Salzwert aus paclink-unix) und die Modem-Schnittstellen; Prüfdaten für die LZHUF-Umsetzung. Kein Code übernommen, eigene Umsetzung in Python | MIT |
| [Electron](https://www.electronjs.org/) | Programmfenster | MIT; Chromium-Lizenzen liegen dem Installationspaket bei (`LICENSES.chromium.html`) |
| [Python](https://www.python.org/) mit [PyInstaller](https://pyinstaller.org/) | Laufzeit des Dienstes | PSF-Lizenz; PyInstaller-Bootloader: GPL 2 mit Ausnahme für gebündelte Programme |
| [FastAPI](https://fastapi.tiangolo.com/), Starlette, Pydantic, AnyIO, h11 | Webdienst | MIT bzw. BSD-3-Clause |
| [Uvicorn](https://www.uvicorn.org/), websockets, httptools, uvloop, watchfiles | Webserver | BSD-3-Clause bzw. MIT/Apache-2.0 |
| [python-multipart](https://github.com/Kludex/python-multipart) | Datei-Uploads | Apache-2.0 |
| [pySerial](https://github.com/pyserial/pyserial) | serielle Schnittstellen | BSD-3-Clause |
| [dockview](https://github.com/mathuo/dockview) 8.4.1 | andockbare Fenster | MIT |
| [Leaflet](https://leafletjs.com/) 1.9.4 | Karten | BSD-2-Clause |
| [D3](https://d3js.org/) 7.9.0 | Peilkarte | ISC |
| [satellite.js](https://github.com/shashwatak/satellite-js) 5.0.0 | Satellitenbahnen | MIT |
| [topojson-client](https://github.com/topojson/topojson-client) 3.1.0, [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 | Ländergrenzen (Natural Earth, gemeinfrei) | ISC |
| [marked](https://github.com/markedjs/marked) 12.0.2 | Anzeige der Anleitung | MIT |
| Schrift [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono) | Frequenz- und Uhranzeigen | SIL Open Font License 1.1 – Copyright (c) 2012, Carrois Type Design, Ralph du Carrois, with Reserved Font Name „Share“. Text in [`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt) |

## Daten und Dienste zur Laufzeit

Wellenwerk lädt bei Bedarf Daten von öffentlichen Quellen; es gelten deren Bedingungen:
Kartenkacheln © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende (ODbL),
Länderdatei [AD1C / country-files.com](https://www.country-files.com/),
Sonnendaten [NOAA SWPC](https://www.swpc.noaa.gov/),
Kurzwellen-Sendeplan [EiBi](http://www.eibispace.de/),
Satellitenbahnen [CelesTrak](https://celestrak.org/), Sender [SatNOGS](https://db.satnogs.org/),
Contest-Kalender [WA7BNM](https://www.contestcalendar.com/), DXpeditionen [NG3K ADXO](https://www.ng3k.com/Misc/adxo.html),
sowie die vom Nutzer eingerichteten Dienste (HamQTH, QRZ.com, eQSL, LoTW, Club Log, DX-Cluster).
