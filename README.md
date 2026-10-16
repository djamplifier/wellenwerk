# Wellenwerk

Stationssteuerung, Logbuch und Digitalbetrieb für Funkamateure – ein Desktop-Programm für Windows, macOS und Linux.
Code, Logo und Icons sind eigenständig.

## Download (Version 1.3.4)
| System | Datei |
|---|---|
| Windows 10/11 | [Wellenwerk-1.3.4-Windows-Setup.exe](https://github.com/djamplifier/wellenwerk/releases/download/v1.3.4/Wellenwerk-1.3.4-Windows-Setup.exe) |
| Mac mit Apple-Chip (M1–M4) | [Wellenwerk-1.3.4-Mac-AppleSilicon.dmg](https://github.com/djamplifier/wellenwerk/releases/download/v1.3.4/Wellenwerk-1.3.4-Mac-AppleSilicon.dmg) |
| Mac mit Intel-Chip | [Wellenwerk-1.3.4-Mac-Intel.dmg](https://github.com/djamplifier/wellenwerk/releases/download/v1.3.4/Wellenwerk-1.3.4-Mac-Intel.dmg) |
| Linux (alle Distributionen) | [Wellenwerk-1.3.4-Linux.AppImage](https://github.com/djamplifier/wellenwerk/releases/download/v1.3.4/Wellenwerk-1.3.4-Linux.AppImage) |
| Debian/Ubuntu | [wellenwerk_1.3.4_amd64.deb](https://github.com/djamplifier/wellenwerk/releases/download/v1.3.4/wellenwerk_1.3.4_amd64.deb) |

Alle Versionen und Neuerungen: [Releases](https://github.com/djamplifier/wellenwerk/releases). Installierte Programme melden neue Versionen selbst.

## Funktionen
- **Gerätesteuerung** (Hamlib, über 300 Funkgeräte, mehrere gleichzeitig): große Frequenzanzeige, VFO A/B, Split, RIT/XIT,
  alle Regler und Schalter des Geräts, Abstimmleisten je Band, Feinabstimmung, Schnellspeicher, Favoriten, Speicherkanäle,
  Scanner, Makros, Sprachspeicher, Bandübersicht, Panadapter (Geräte-Scope oder IQ-Soundkarte), WinKeyer,
  Freigabe des Geräts für andere Programme (Hamlib NET rigctl oder CAT-Emulation Kenwood TS-2000), Schnappschüsse,
  Synchronisierung zweier Geräte, Fernbetrieb-Audio (WebRTC) mit PTT, Layout frei anpassbar
- **Logbuch**: mehrere Logbücher, Rufzeichen-Info mit Callbook (HamQTH/QRZ.com) und gearbeitet-Matrix, DX-Cluster mit
  Alarmen, FT8-Alert und Antworten über WSJT-X, Bandkarte, Graulinie, Sonnendaten, Kalender (Contests, DXpeditionen),
  QSL (Papier, LoTW, eQSL), Uploads zu QRZ.com/eQSL/LoTW/Club Log, Diplome, Etiketten, Cabrillo, ADIF,
  POTA/SOTA/WWFF mit Stationsprofilen, Filter-Bedingungen und gespeicherte Ansichten, QSO-Austausch mit N1MM, VarAC, JTAlert, GridTracker
- **Digitalbetrieb**: Wasserfall, PSK/QPSK, RTTY, CW, MFSK, DominoEX, THOR, Olivia, Contestia, Throb, MT63, Hellschreiben,
  SSTV (18 Bildmodi mit Vorlagen und Galerie), FreeDV (700D/700E/1600), Makros, WWK Sweeper (bis 16 Signale gleichzeitig),
  Chat (Tastatur-QSO) über ARDOP, VARA, Packet und Telnet
- **Signalerkennung per Klick**: Klick auf ein Signal im Wasserfall zeigt die Betriebsart (z. B. RTTY mit Baud/Shift, FT8, PSK31,
  SSTV mit Bildmodus, CW mit Tempo, Olivia, Sprache, AM) und öffnet auf Wunsch gleich den passenden Dekoder
- **Empfänger ohne Funkgerät**: KiwiSDR, OpenWebRX, RTL-SDR, Hermes Lite 2 (Empfang), öffentliche Empfängerlisten, Wasserfall 2D/3D
- **Winlink**: E-Mail über Funk – Postfach, Verfassen mit Anhängen, Austausch über Telnet, ARDOP, VARA (TCP-Schnittstelle) und Packet (AGW/Direwolf)
- **Satelliten** (Doppler- und Rotor-Nachführung, Zeitplan, gemeinsame Sichtbarkeit), **Rotor** (Anschlag, Versatz, Überlauf), **Karten**
- **Erweiterungen** (Plugins), Oberfläche Deutsch/Englisch, automatische Aktualisierung, Rückmeldung an die Entwickler aus dem Programm
- Andockbare Fenster (lösen, auf zweiten Bildschirm, Layouts speichern), Rechtsklick-Menüs überall

## Aufbau
- `wellenwerk/`: Dienst (Python/FastAPI), startet Hamlib `rigctld`/`rotctld`
- `static/`: Oberfläche (HTML/JS), Signalverarbeitung der Digitalmodi in `static/js/dsp*.js`, `sstv.js`
- `desktop/`: Desktop-Programm (Electron), startet den Dienst und zeigt die Oberfläche
- `packaging/`: Paketbau des Dienstes (PyInstaller); `.github/workflows/build.yml` baut die Installationsprogramme

**[➜ Ausführliche Anleitung mit Bildern](docs/Anleitung.md)**

## Installation (eigenes Programm, kein Browser)
Wellenwerk ist ein Desktop-Programm mit eigenem Fenster; der Dienst und Hamlib (Funkgeräte-/Rotorsteuerung) sind eingebaut.
- **Windows:** `Wellenwerk-x.y.z-Windows-Setup.exe` ausführen. Beim ersten Start meldet Windows evtl. „Unbekannter Herausgeber“ → „Weitere Informationen“ → „Trotzdem ausführen“. USB-Treiber des Funkgeräts (z. B. Silicon Labs CP210x) installieren.
- **macOS:** `Wellenwerk-x.y.z-Mac-AppleSilicon.dmg` (Apple-Chip) bzw. `-Mac-Intel.dmg` öffnen, Wellenwerk in „Programme“ ziehen. Beim ersten Start Rechtsklick → „Öffnen“ (nicht notarisiert). Mikrofon-Zugriff erlauben (für Digitalbetrieb/SSTV).
- **Linux:** `.deb` installieren oder die `.AppImage` ausführbar machen und starten; Benutzer in die Gruppe `dialout` aufnehmen.

Danach: Gerätesteuerung → Verbinden → Hersteller/Modell, COM-Port, Baudrate (oder „Baudrate suchen“), bei Icom die CI-V-Adresse.
Daten liegen im Benutzerordner (Windows `%APPDATA%\Wellenwerk`, macOS `~/Library/Application Support/Wellenwerk`).
Ohne Installation (Entwicklung): `pip install -r requirements.txt` und `python -m wellenwerk` (öffnet den Browser).

Pakete bauen: `python packaging/build.py` (Dienst, Ordner `dist/Wellenwerk`), dann in `desktop/` `npm install && npx electron-builder`.
Für Windows, macOS (Apple Silicon und Intel) und Linux automatisch über `.github/workflows/build.yml` (GitHub Actions, Hamlib jeweils eingebaut).

## Lizenz

Wellenwerk ist freie Software unter der [GNU General Public License 3](LICENSE) (oder später) und wird **ohne jede Gewährleistung** bereitgestellt;
die Nutzung, insbesondere die Steuerung von Sendern und Rotoren, erfolgt auf eigene Verantwortung.
Mitgelieferte Fremdkomponenten (u. a. Hamlib, LGPL 2.1) und ihre Lizenzen: [LIZENZEN.md](LIZENZEN.md).
Wellenwerk ist ein eigenständiges Programm und steht in keiner Verbindung zu Herstellern anderer Funk-Software oder von Funkgeräten.

