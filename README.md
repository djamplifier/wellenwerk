# Wellenwerk

Stationssteuerung, Logbuch und Digitalbetrieb für Funkamateure – ein Desktop-Programm für Windows, macOS und Linux.
Code, Logo und Icons sind eigenständig.

## Funktionen
- **Gerätesteuerung** (Hamlib, über 300 Funkgeräte, mehrere gleichzeitig): große Frequenzanzeige, VFO A/B, Split, RIT/XIT,
  alle Regler und Schalter des Geräts, Abstimmleisten je Band, Feinabstimmung, Schnellspeicher, Favoriten, Speicherkanäle,
  Scanner, Makros, Sprachspeicher, Bandübersicht, Panadapter (Geräte-Scope oder IQ-Soundkarte), WinKeyer,
  Freigabe des Geräts für andere Programme (Hamlib NET rigctl), Layout frei anpassbar
- **Logbuch**: mehrere Logbücher, Rufzeichen-Info mit Callbook (HamQTH/QRZ.com) und gearbeitet-Matrix, DX-Cluster mit
  Alarmen, FT8-Alert und Antworten über WSJT-X, Bandkarte, Graulinie, Sonnendaten, Kalender (Contests, DXpeditionen),
  QSL (Papier, LoTW, eQSL), Uploads zu QRZ.com/eQSL/LoTW/Club Log, Diplome, Etiketten, Cabrillo, ADIF
- **Digitalbetrieb**: Wasserfall, PSK/QPSK, RTTY, CW, MFSK, DominoEX, THOR, Olivia, Contestia, Throb, MT63, Hellschreiben,
  SSTV (18 Bildmodi mit Vorlagen und Galerie), Makros, WWK Sweeper (bis 16 Signale gleichzeitig)
- **Satelliten** (Doppler- und Rotor-Nachführung), **Rotor**, **Karten**
- Andockbare Fenster (lösen, auf zweiten Bildschirm, Layouts speichern), Rechtsklick-Menüs überall

## Aufbau
- `wellenwerk/`: Dienst (Python/FastAPI), startet Hamlib `rigctld`/`rotctld`
- `static/`: Oberfläche (HTML/JS), Signalverarbeitung der Digitalmodi in `static/js/dsp*.js`, `sstv.js`
- `desktop/`: Desktop-Programm (Electron), startet den Dienst und zeigt die Oberfläche
- `packaging/`: Paketbau des Dienstes (PyInstaller); `.github/workflows/build.yml` baut die Installationsprogramme

**[➜ Ausführliche Anleitung mit Bildern](docs/Anleitung.md)**

## Installation (eigenes Programm, kein Browser)
Wellenwerk ist ein Desktop-Programm mit eigenem Fenster; der Dienst und Hamlib (Funkgeräte-/Rotorsteuerung) sind eingebaut.
- **Windows:** `Wellenwerk-Setup-x.y.z.exe` ausführen. Beim ersten Start meldet Windows evtl. „Unbekannter Herausgeber“ → „Weitere Informationen“ → „Trotzdem ausführen“. USB-Treiber des Funkgeräts (z. B. Silicon Labs CP210x) installieren.
- **macOS:** `Wellenwerk-x.y.z-arm64.dmg` (Apple Silicon) bzw. `-x64` (Intel) öffnen, Wellenwerk in „Programme“ ziehen. Beim ersten Start Rechtsklick → „Öffnen“ (nicht notarisiert). Mikrofon-Zugriff erlauben (für Digitalbetrieb/SSTV).
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

