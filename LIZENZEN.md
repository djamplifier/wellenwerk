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
| [codec2](https://github.com/drowe67/codec2) (David Rowe VK5DGR u. a.) | FreeDV (digitale Sprache): Bibliothek `libcodec2`, unverändert mitgeliefert und zur Laufzeit geladen | GNU LGPL 2.1 – Text in [`licenses/LGPL-2.1.txt`](licenses/LGPL-2.1.txt); Quelltext: <https://github.com/drowe67/codec2> (Windows: MSYS2-Paket, macOS: Homebrew, Linux: Ubuntu-Paket der jeweiligen Version) |
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
| [D3](https://d3js.org/) 7.9.0 | (Satelliten-Überflug, Hilfsfunktionen) | ISC |
| Erdbilder `static/vendor/earth/` | 3D-Erde (Graulinie, Karten, Peilkarte, Satelliten) | gemeinfrei – NASA Earth Observatory: „Blue Marble: Next Generation“ (Reto Stöckli, NASA GSFC, Dezember 2004, mit Relief und Meeresboden) und „Earth at Night 2016 / Black Marble“ (NASA Earth Observatory, Joshua Stevens, Suomi NPP VIIRS). Auf 4096×2048 bzw. 3600×1800 Pixel verkleinert. |
| [satellite.js](https://github.com/shashwatak/satellite-js) 5.0.0 | Satellitenbahnen | MIT |
| [RNNoise](https://github.com/xiph/rnnoise) (Xiph.Org, Jean-Marc Valin), als WebAssembly von [@shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm) 2025.1.5 (`static/vendor/rnnoise/`) | KI-Rauschminderung im Fenster „Rauschfilter“, wird nur bei Bedarf geladen | BSD-3-Clause (RNNoise), Apache-2.0 (WebAssembly-Fassung, Lizenztext in `static/vendor/rnnoise/LICENSE`) |
| [topojson-client](https://github.com/topojson/topojson-client) 3.1.0, [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 | Ländergrenzen (Natural Earth, gemeinfrei) | ISC |
| [marked](https://github.com/markedjs/marked) 12.0.2 | Anzeige der Anleitung | MIT |
| Schrift [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono) | Frequenz- und Uhranzeigen | SIL Open Font License 1.1 – Copyright (c) 2012, Carrois Type Design, Ralph du Carrois, with Reserved Font Name „Share“. Text in [`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt) |

## Daten und Dienste zur Laufzeit

Wellenwerk lädt bei Bedarf Daten von öffentlichen Quellen; es gelten deren Bedingungen:
Länderdatei [AD1C / country-files.com](https://www.country-files.com/),
Sonnendaten [NOAA SWPC](https://www.swpc.noaa.gov/),
Kurzwellen-Sendeplan [EiBi](http://www.eibispace.de/),
Satellitenbahnen [CelesTrak](https://celestrak.org/), Sender [SatNOGS](https://db.satnogs.org/),
Contest-Kalender [WA7BNM](https://www.contestcalendar.com/), DXpeditionen [NG3K ADXO](https://www.ng3k.com/Misc/adxo.html),
sowie die vom Nutzer eingerichteten Dienste (HamQTH, QRZ.com, eQSL, LoTW, Club Log, DX-Cluster).

## ft8_lib (native/ftx, static/vendor/ftx.js)

FT8/FT4-Dekoder von Karlis Goba, https://github.com/kgoba/ft8_lib – MIT-Lizenz (native/ftx/ft8_lib/LICENSE). In Wellenwerk als WebAssembly übersetzt (native/ftx/build.sh), unverändert bis auf die Lautstärke der Protokollmeldungen.

## Sprachmodul (optional, wird nicht mitgeliefert)

- **mbelib** (https://github.com/szechyjs/mbelib, Copyright (C) 2010 mbelib Author, ISC-Lizenz): weder enthalten noch von Wellenwerk geladen. Wer die Sprache hören will, übersetzt mbelib selbst und legt die Bibliothek in den Ordner `module` des Datenordners; Wellenwerk bindet sie dann ein (wellenwerk/dvvoice.py). AMBE ist patentrechtlich geschützt; die Nutzung verantwortet der Nutzer.
- **Verschachtelungstabellen für DMR- und D-STAR-Sprachrahmen** in wellenwerk/dvvoice.py aus DSD (https://github.com/szechyjs/dsd, Copyright (C) 2010 DSD Author, ISC-Lizenz):

  > Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

- M17 (Faltungscode, Punktierung, Verwürfelung, LICH, CRC) ist nach der offenen M17-Spezifikation selbst umgesetzt; libm17 (GPL-2) wurde nur zum Gegenprüfen verwendet, nicht übernommen.

## Frequenz- und Relaisdaten (zur Laufzeit abgerufen, nicht im Programm enthalten)

- Rundfunk-Sendeplan: EiBi (eibispace.de, Eike Bierwirth) – frei verwendbare Sendeliste, mit Quellenangabe.
- Relais: DARC-Relaisliste von DL3EL (relais.dl3el.de, Umkreissuche als CSV), EchoLink-Linkliste (echolink.org/links.jsp, Umkreissuche), BrandMeister-Geräteliste (api.brandmeister.network, DMR-Relais), hearham.com (offene Relais-Datenbank).
- Namen zu Digitalfunk-Kennungen: RadioID.net (DMR- und NXDN-IDs mit Rufzeichen, Vorname, Ort), BrandMeister-Talkgroupliste – nur lokal nachgeschlagen.
- Typische Frequenzen (static/freqs.json): zusammengestellt aus dem IARU-Region-1-Bandplan (Aktivitätszentren), den Standardfrequenzen von WSJT-X sowie öffentlich bekannten Wetter-, Zeit-, CB-, PMR446- und Freenet-Frequenzen.

## Signal-Datenbank (static/sigdb.json)

Auszug aus dem Signal Identification Wiki (https://www.sigidwiki.com): Signalnamen, Frequenzangaben, Betriebsart, Modulation, Bandbreite und ACF von rund 550 Signalseiten (Stand 2026-10-16). Übernommen wurden nur diese Sachangaben, keine Beschreibungstexte, Bilder oder Tonbeispiele; jeder Eintrag verlinkt auf die Originalseite.
