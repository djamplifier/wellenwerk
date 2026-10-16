# Wellenwerk – Manual

Wellenwerk is a program for the radio station: radio control, logbook, digital modes (PSK, RTTY, Olivia, MT63, SSTV and more), Winlink e-mail over radio, satellites, rotator and maps – all in one window.

*Deutsche Anleitung: [Anleitung.md](Anleitung.md)*

> **License and liability:** Wellenwerk is free software under the GNU General Public License 3 and is provided **without any warranty**. Use – especially controlling transmitters, radios and rotators – is at your own risk. The operator is responsible for complying with amateur radio regulations. Details and all third-party licenses: [LIZENZEN.md](../LIZENZEN.md) or in the program under **Help → Licenses and third-party components**.

**Language:** Wellenwerk shows its interface in German or English. Switch under **Options (F8) → Appearance → Sprache / Language**. A new browser follows the language of the station until a language is chosen there.

**Contents**
1. [Installation](#1-installation)
2. [First start](#2-first-start)
3. [Connecting a radio](#3-connecting-a-radio)
4. [Radio control](#4-radio-control)
5. [Arranging windows and layouts](#5-arranging-windows-and-layouts)
6. [Right-click menus](#6-right-click-menus)
7. [Logbook](#7-logbook)
8. [DX cluster, alerts and WSJT-X](#8-dx-cluster-alerts-and-wsjt-x)
9. [Online services (QRZ.com, LoTW, eQSL, Club Log)](#9-online-services)
10. [Digital modes](#10-digital-modes)
11. [SSTV (picture transmission)](#11-sstv-picture-transmission)
12. [Winlink (e-mail over radio)](#12-winlink-e-mail-over-radio)
13. [Satellites](#13-satellites)
14. [Rotator](#14-rotator)
15. [Maps](#15-maps)
16. [Keyboard shortcuts](#16-keyboard-shortcuts)
17. [Data, backup and moving](#17-data-backup-and-moving)
18. [Access, API and AI assistants](#18-access-api-and-ai-assistants)
19. [Error reports and updates](#19-error-reports-and-updates)
20. [Troubleshooting](#20-troubleshooting)

The screenshots show the German interface; the English one is laid out identically.

---

## 1. Installation

The installation files are available under **Releases** in this repository.

| System | File | Note |
|---|---|---|
| Windows 10/11 | `Wellenwerk-x.y.z-Windows-Setup.exe` | Windows warns on first start (“Unknown publisher”): **More info → Run anyway**. |
| Mac with Apple chip (M1–M4) | `Wellenwerk-x.y.z-Mac-AppleSilicon.dmg` | Open the DMG, drag Wellenwerk into “Applications”. First start: **right-click → Open**. |
| Mac with Intel chip | `Wellenwerk-x.y.z-Mac-Intel.dmg` | as above |
| Linux | `.AppImage` or `.deb` | Make the AppImage executable (`chmod +x`) and start it. Add the user to the `dialout` group (`sudo usermod -aG dialout $USER`, then log in again). |

Nothing else is needed for control – radio/rotator control (Hamlib) is built in. If necessary install the **USB driver of the radio** (e.g. Silicon Labs CP210x for Icom and Yaesu, FTDI for some Kenwood/Elecraft).

## 2. First start

On the first start the **program options** open. Enter at least your **callsign** and **locator** – they are needed for distances, directions, macros, the DX cluster and logbook uploads.

![Program options](bilder/01-optionen.png)

The options can be opened at any time with **F8** or via **Options** in the toolbar. Important tabs:

- **Station:** callsign, locator, name/QTH for macros
- **DX cluster:** server (e.g. `dxc.ve7cc.net`, port 23) and login commands
- **Online services:** credentials for callbook and uploads (see [chapter 9](#9-online-services))
- **WSJT-X:** UDP port (default 2237)
- **Communication:** how often the radio is polled
- **CW / WinKeyer:** CW via the radio or a K1EL WinKeyer
- **Appearance:** colour scheme (Classic, Light, Dark, Night vision) and language

A **demo radio** is preset for trying things out – everything can be operated without a radio attached.

## 3. Connecting a radio

**Radio control → Connect** (or the plug icon in the toolbar).

![Connect dialog](bilder/02-verbinden.png)

1. Choose **manufacturer** and **radio** (more than 300 models).
2. Choose the **COM port**. On Windows `COM3`, `COM4` …, on the Mac `/dev/cu.usbserial-…` or `/dev/cu.SLAB_USBtoUART`, on Linux `/dev/ttyUSB0`. The **Serial ports** tab shows which port belongs to which USB device.
3. **Speed** as in the radio's menu (CAT/CI-V baud rate). Unknown? **Search baud rate** tries them all.
4. **Icom:** enter the CI-V address (e.g. IC-7300 = 94, IC-705 = A4, IC-9700 = A2). In the radio “CI-V USB Echo Back” is usually off.
5. **PTT via:** normally “CAT command”. For interfaces without CAT PTT: DTR or RTS line.
6. **Connect**. If the radio does not answer, the reason is shown in the **Status** field.

More settings:
- **Always connect on start** – for the main radio.
- **Panadapter: scope data from the radio** – for Icom radios with built-in spectrum (IC-7300/705/9700/7610 …). In the radio set “CI-V USB Port” to **Unlinked** and 115200 baud.
- **Share with other computers** – see below.
- **Frequency offset (transverter, LNB, QO-100)** – see below.

**Frequency offset for transverters and QO-100:** the collapsible **Frequency offset** section (opens automatically when an offset is set) stores an RX and a TX offset in MHz in the radio profile. Wellenwerk then shows the real frequency everywhere (radio frequency + offset) and converts back when tuning. The **TX offset** applies to the transmit frequency in split operation (VFO B); empty means “same as RX”. The **QO-100** button enters RX 9750 MHz (LNB) and TX 1968 MHz (upconverter 432 → 2400 MHz), **Transverter 2 m** 116 MHz each (28 → 144 MHz). Example QO-100 with split: receive on 10489.550 MHz (radio 739.550 MHz), transmit on 2400.050 MHz (radio 432.050 MHz). Correct the LNB offset for your own LNB's drift if needed (e.g. 9749.982). Programs sharing the radio (WSJT-X …) still see the radio frequency.

![Frequency offset in the Connect dialog](bilder/25-frequenzversatz.png)

**Several radios** at once: simply connect one after the other. Each radio gets its own tab at the top of radio control.

**Sharing the radio with other programs** (WSJT-X, JTDX, N1MM, fldigi, Log4OM): on the **Saved** tab the column “For other programs” shows an address like `127.0.0.1:4600`. In the other program choose **Hamlib NET rigctl** as radio with this address. Both programs then control the same radio at the same time.

**Remote station via wfview, FLRig or another Wellenwerk station:** choose a **template** at the top of the Connect dialog. For **wfview** (Icom radios on the network/internet) switch on *Settings → External Control → Enable RigCtld* in wfview; wfview connects to the remote station, Wellenwerk controls it via port 4533. wfview provides the audio as a virtual sound card.

**Programs without a Hamlib network connection** (“serial radio” only): switch on **F8 → Communication → CAT emulation**. Wellenwerk then behaves like a **Kenwood TS-2000**. On macOS/Linux a port like `/dev/ttys003` appears (always also as `~/.wellenwerk-cat`); on Windows create a virtual port pair with **com0com**, enter one end (e.g. COM11) in Wellenwerk and the other (COM12) in the other program; alternatively a TCP port. In the other program choose “Kenwood TS-2000”, 9600 baud. Frequency, mode, PTT, S-meter, power and volume are passed to the currently selected radio.

## 4. Radio control

![Radio control](bilder/03-geraetesteuerung.png)

- **Frequency display:** the mouse wheel over a digit changes exactly that digit. Clicking a digit makes it “active” (bar); then **↑/↓** or **+/−** to change, **←/→** to move, number keys to type. **Enter** opens frequency entry.
- **Mode:** button above the frequency.
- **Left:** VFO A/B, TX A/B, A>B, A⇄B, Main/Sub, memory, channel ±. **Right:** function buttons (NB, NR, notch, ATU, tune …) and selection lists (filter, AGC, preamp, attenuator …). Which buttons appear depends on what the radio can do.
- **Fine tuning:** the bar below the display; drag or use the mouse wheel (Shift = double, Ctrl = five times).
- **Band buttons:** a click jumps to the last used frequency and mode of the band. **ALT** tunes the second VFO, **Spread** shows a band over several bars.
- **Tuning bars:** one bar per band across the whole band; click or drag to tune. Cluster spots appear as markers.
- **Controls** (bottom): up to six control layouts, e.g. one for SSB and one for CW.
- **Favourites** (toolbar **Selection**): store frequencies with mode in folders, a click tunes.
- **Quick memory:** remembers the current frequency as a marker on the tuning bar.

More windows via **View** or **Tools**: shortwave database (broadcast stations by frequency and time), band scope (sweeps a band and plots the S-meter), scanner, macros, voice keyer, **Panadapter**, **Memory channels**.

**Customize layout** (**Ctrl+F8**): move buttons between left and right, create your own buttons (mode, frequency, CAT command, macro), colours, size, control layouts and band plan (region 1/2/3). **Save layout as file / Load layout from file** transfers the layout to other computers.

![Customize layout](bilder/05-anpassen.png)

### Panadapter and memory channels

![Panadapter, memory channels and floating window](bilder/06-fenster.png)

- **Panadapter** (top of the picture): spectrum and waterfall; a click tunes. Source is either the **radio scope** (Icom) or an **IQ sound card** (SDR, e.g. via DAX IQ or an IQ output). For IQ: choose the input, **Start**; if needed **IF offset** and **Swap I/Q** (if the spectrum is mirrored).
- **Memory channels** (bottom of the picture): **Read** fetches the channels from the radio. Click a channel, then **Memory → VFO** (or double-click), **VFO → memory** or **Delete**. **CSV export** saves the list.

### Snapshots and synchronizing

![Snapshots](bilder/19-schnappschuesse.png)

**Radio → Snapshots …** saves the complete radio state under a name – frequency, mode and bandwidth, split with transmit frequency, RIT and all controls and switches the radio can set – and restores it with **Recall** (e.g. “40 m FT8”, “Contest SSB”). One-shot actions like starting the tuner or a tone burst are never triggered.

**Radio → Synchronize …**: a second connected radio follows the first – frequency plus an adjustable **offset** and optionally the mode (second receiver, SDR as panadapter, transverter IF).

### Receivers without a radio of your own (KiwiSDR, OpenWebRX, WebSDR)

Wellenwerk can use public internet receivers like a radio – for listening, for digital modes or as a second receiver next to your own radio. Also ideal for trying things out without a license and without a radio.

1. **File → Receivers (WebSDR/KiwiSDR) …** (or the **Receiver (SDR)** tab in the Connect dialog). The list shows more than 1800 public receivers from receiverbook.de and kiwisdr.com, sorted by distance from your station. Filters: type, search text (place, callsign, locator, antenna), **free slots**, **receives current frequency**.
2. **connect** makes the receiver the main radio; **2nd rx** connects it in addition, your own radio stays the main radio.
3. Audio, S-meter and waterfall arrive immediately; tuning, mode, volume, AGC and noise blanker work as with a radio. Transmitting is of course blocked for receivers.

When a receiver is the current radio, the display only shows the bands it can receive, and next to the radio tabs a **list with more receivers** appears (free slots, by distance) – one click switches the server; if that fails, Wellenwerk reconnects to the previous one.

**“Receivers” window** (*View*): all connected receivers with their own frequency, mode, volume, sound on/off, S-meter and a small waterfall. **follows the main radio** lets a second receiver follow the radio's frequency (e.g. to compare with a remote antenna).

**Own address and parameters:** enter a receiver directly at the bottom of the tab. Parameters separated by `;`, e.g. `password=…; span=200; freq=7074; mode=USB; user=Name` (KiwiSDR) or `profile=40m; smeter_offset=-30` (OpenWebRX).

**Digital modes:** choose **Receiver (WebSDR/KiwiSDR)** as input – PSK, RTTY, SSTV etc. then decode the receiver's audio.

**Your own SDR hardware** (bottom of the tab, “enter receiver directly”):
- **RTL-SDR stick:** start the program `rtl_tcp` (package *rtl-sdr*) and enter `127.0.0.1:1234` as address – or the parameter `start=1`, then Wellenwerk starts it itself. Shortwave without converter: `direct=2` (e.g. RTL-SDR Blog V3), with converter `offset=125000000`. With an LNB or transverter in front use `rx_offset=…` in Hz – for QO-100 with a 9750 MHz LNB `rx_offset=9750000000`, Wellenwerk then shows 10489.5 MHz. More parameters: `gain=30`, `ppm=…`, `rate=1536000`.
- **Hermes Lite 2** (and other openHPSDR devices): leave the address empty – Wellenwerk searches the network – or enter the IP. Parameters `rate=192000`, `gain=20`. Receive only in this version.

Wellenwerk computes spectrum, waterfall and audio (USB, LSB, CW, AM, FM) itself; the S-meter is not calibrated (`smeter_offset=…`).

**WebSDR.org receivers** (University of Twente and others) have no open interface: **in the browser** opens their page on the current frequency.

> The receivers are voluntary offers by radio amateurs with few slots – please disconnect after use.

### Waterfall and 3D waterfall

![3D waterfall](bilder/22-wasserfall-3d.png)

**View → Waterfall (2D/3D)** shows spectrum and waterfall of every source (receiver or radio scope; selectable at the top). **2D:** mouse wheel zooms, dragging pans, a click tunes, the passband is highlighted. **3D:** the latest lines as a landscape – dragging rotates, the mouse wheel changes the distance. In the **Receivers** window, too, a click into the small waterfall tunes that receiver to the clicked frequency.

In the toolbar above the waterfall:
- **Width** – displayed span from 3 kHz to 1.5 MHz or the **whole range** (⤢). The span is centred on the receive frequency and follows when you tune out of the picture. With SDR hardware (RTL-SDR, Hermes Lite 2) Wellenwerk recomputes narrow spans at finer resolution (about 12 Hz per point at 12 kHz instead of 750 Hz); with a KiwiSDR its zoom is set, with Icom radios with a scope the radio's span.
- **Contrast** (◐) and **brightness** (☀) as in SDR programs: contrast spreads the level range, brightness raises or lowers the noise floor. Double-click resets a slider. Automatic level adjustment keeps working underneath.

The waterfall scrolls at a constant speed even when a source sends its lines in bursts (KiwiSDR, OpenWebRX, internet): Wellenwerk shows the lines with a small delay and blends between them. Speed, colours, levels and 3D depth under **F8 → Waterfall**.

![Waterfall with an RTL-SDR as panadapter](bilder/23-wasserfall-panadapter.png)

### SDR as panadapter for a radio without a scope

Many radios have no spectrum display of their own. If an SDR is connected as well – e.g. an **RTL-SDR** on the same antenna (via an antenna relay/TX protection or on a separate receive wire) – it takes over as the panadapter:
1. Connect the radio as usual, then add the SDR via **Connect → Receivers (SDR)** as **2nd rx**.
2. The **Waterfall** (source “current radio”) and the **Panadapter** window now show the SDR's spectrum; the toolbar says “panadapter for …”.
3. The SDR follows the radio's frequency and mode. A click in the waterfall tunes the **radio**; the radio is operated completely as usual.

The SDR is still a full receiver: switch its audio on in the **Receivers** window, and **as main radio** makes it the current device – then a click tunes the SDR itself again. The waterfall's source list also offers “… as panadapter for …” explicitly. Under **F8 → Waterfall → SDR as panadapter** the automatic mode can be switched off or a particular SDR chosen; in automatic mode radios with their own scope (Icom) keep their scope. If the radio has a frequency offset (e.g. QO-100), the SDR needs the same receive offset (`rx_offset`) to be able to follow.

Receiver audio plays with about half a second of buffer; on a stuttering internet connection the buffer grows by itself (up to 2 s). If the connection to a receiver drops, Wellenwerk reconnects by itself. After a restart or an update, the radios and receivers connected before are connected again – with the last frequency and mode.

### Signal identification by click

![Signal identification: RTTY detected](bilder/24-signalerkennung.png)

Which mode is that? In **USB/LSB** a click on the signal in the waterfall (window **Waterfall**, **Receivers** or the waterfall in **Digital modes**) is enough. Wellenwerk tunes so that the signal lies at 1500 Hz audio, listens for up to 15 seconds and shows in a small card what it has identified – with confidence in percent, centre, width and distance from the noise:

- **Digital modes:** RTTY (with baud and shift), SITOR-B/NAVTEX, PSK31/63/125, QPSK, CW (with speed), Hellschreiber, MFSK, Olivia/Contestia, DominoEX/THOR, MT63, ALE
- **WSJT modes:** FT8, FT4 (by their sync patterns), WSPR, JT9, JT65
- **Image and voice:** SSTV (with mode, e.g. “Martin M1”), weather fax, FreeDV, voice (also “other sideband”), AM broadcast, unmodulated carrier

Where Wellenwerk can decode by itself, it decodes on trial to confirm; readable text appears in the card. Buttons lead straight on: **Decode in Digital modes** (mode, baud/shift and audio frequency are taken over), **Open SSTV receive**, **Open FreeDV**, **Tune as LSB**, **Set AM/CW** or for FT8 **Tune to the standard frequency**. Identified signals get a label in the waterfall for 30 seconds.

**Alt+click** only tunes, without identification. In AM, FM and CW a click tunes directly as before. Switch on/off and set the maximum duration under **F8 → Waterfall**. The identification is a well-founded estimate, not proof: with very weak or overlapping signals it prefers to report “unknown signal” with guesses.

### Remote audio

![Remote audio](bilder/18-fernbetrieb-audio.png)

For operating from another room or on the road: **View → Remote audio**.

1. **On the station computer** (where the sound card is attached to the radio): choose **Receive from radio** and **Transmit to radio**, **Share audio**.
2. **On the other computer/tablet** open Wellenwerk in the browser – because of the microphone via **https** (port 8443), on the home network e.g. `https://stationcomputer:8443` – and **Connect**. Reception is audible immediately.
3. Hold **PTT – transmit** (or choose “latches”): the radio transmits, the microphone goes to the station. Release = receive.

Audio runs directly between the computers (WebRTC, Opus); outside the home network enter a STUN server in the options (**Communication**).

## 5. Arranging windows and layouts

**Screen size:** Wellenwerk adapts to the resolution – from laptops (also 4:3, from about 1024 × 660 pixels in the browser) up to 4K:
- On low or narrow screens headers become more compact; toolbars that do not fit in one row show icons only (label on hover).
- The radio display shrinks when needed instead of showing scroll bars; clicks on scales and digits still hit exactly.
- When the **waterfall** is opened, the radio display moves to the left side as a narrow column – frequency, S-meter and buttons stacked, as in SDR-Console – and the waterfall gets the width. Closing the waterfall restores the previous arrangement. Can be switched off under **F8 → Waterfall**.
- On very large screens without system scaling (e.g. 4K at 100 %) Wellenwerk enlarges the interface automatically; the size can also be set under **F8 → Appearance → Interface size** (80–200 %).

Each area is its own window that can be arranged freely:

- **Move:** drag by the tab (title) and drop at an edge or in the middle of another window (then as a tab).
- **Size:** drag the dividers.
- **Detach:** button ⇱ on the right of the window header – the window floats freely (in the picture above: “Selection”).
- **To a second screen:** button ⧉ – the window becomes its own program window.
- **Maximize:** button □.
- **Window menu:** tile windows, dock all windows, restore default arrangement, save and load **Layout A/B**, full screen (**F11**).

The arrangement is saved automatically per area (radio control, logbook, digital modes …).

## 6. Right-click menus

Almost every element has a right-click menu with the matching commands – for example the frequency display:

![Right-click on the frequency display](bilder/04-rechtsklick.png)

A selection:

| Right-click on … | Commands |
|---|---|
| Frequency display | enter/copy/paste frequency, as favourite, quick memory, mode, tuning step, VFO commands, split |
| Function button | trigger, move, hide, customize layout |
| Band button | choose band, forget stored frequency, spread, band plan |
| Tuning bar | tune here, favourite, delete quick-memory markers; on a spot: all callsign commands |
| Control | minimum / centre / maximum, control layout |
| Favourite / folder | tune, rename, move, delete |
| Logbook row | edit, delete, copy, ADIF, QSL, upload, tune to QSO frequency, filter, turn antenna, send spot |
| Logbook column header | sort, show/hide columns |
| Cluster spot, FT8 decode, band map | tune, log entry, look up, turn antenna (short/long path), QRZ.com, send spot, alert |
| Map | locator and direction of the point, turn antenna there, copy locator |
| Rotator | turn to degrees, stop, park, compass points |
| Waterfall | receive here, copy frequency, mode, AFC |
| Word in the receive text | as callsign/name/QTH/locator/RST into the QSO, look up |
| Transmit field | transmit, insert macro or placeholder, cut/copy/paste |
| Window tab | detach, own window, maximize, close, arrange |
| Input fields | cut, copy, paste, select all |

![Right-click on a logbook row](bilder/09-logbuch-rechtsklick.png)

## 7. Logbook

![Logbook](bilder/07-logbuch.png)

- **Centre:** the logbook with toolbar (new, contest, delete, view, cut/copy/paste, refresh, columns, change selection, search, filter, QSL, LoTW, backup …). Widen columns by dragging the header, a click on the header sorts.
- **Left:** callsign info (callbook with photo, name, address; “worked/confirmed” matrix per band and mode for callsign and country), favourites, radio pane.
- **Right:** band map with spots, grey line, clock, rotator.
- **Bottom:** solar data, solar cycle, audio monitor, DX cluster, alert (FT8), DX histogram, calendar (contests and DXpeditions), audio recorder, network.

**Logging a QSO:** **New** (or **Entry** in the toolbar). Type the callsign – country, distance, direction, previous QSOs and callbook data appear immediately. Frequency, band and mode come from the radio. **Enter** saves, **Esc** clears.

![New entry](bilder/08-neuer-eintrag.png)

**Several logbooks:** **More … → Logbook management**: create, rename, back up, restore. QSOs can be moved between logbooks with cut/copy and paste.

**Import/export:** **More … → import/export ADIF**, Cabrillo export, print logbook, print QSL labels.

**Contest mode:** button **Contest** – serial numbers are assigned automatically.

**Awards:** **Awards** shows DXCC, DXCC Challenge, WAZ, WAS, WAC, WPX, ITU zones, Europe, DOK, IOTA, VUCC grid squares, US counties and the CQ DX Marathon – worked or confirmed.

**Search, filter and saved views:** **Search** shows the filter bar (text, band, mode, QSL status, period). The **Condition** field queries any field, several separated by `;`: `=`, `!=`, `<`, `>`, `<=`, `>=`, `~` (contains), `!~` (does not contain), `empty`, `not empty` – e.g. `cqz=14; iota not empty` or `band=20m; country~Japan; qso_date>=20260101`. **View … → Save current view** remembers filter, columns and sorting under a name.

![Condition in the logbook](bilder/21-logbuch-bedingung.png)

**Modes and RST:** **F8 → Modes** – one line per mode with RST default (e.g. `FT8 -10`, `CW 599`). The list appears in the entry's Mode field; when the mode changes, the RST fields are prefilled.

**POTA, SOTA and WWFF:** the **POTA / SOTA / WWFF** window in the logbook (menu **Tools**) shows current spots (a click tunes, a double-click opens the entry with the reference); the entry has a reference search. For your own activations create **station profiles** (callsign, locator, own park/summit reference) – the counter shows the day's QSOs, **Self-spot** announces the activation, **Export** creates the log file for the portal.

**Connecting other programs** (**F8 → Programs & backup**):
- **Forward QSOs** to other programs (UDP; ADIF, WSJT-X “Logged ADIF” for GridTracker/Log4OM or N1MM format).
- **Receive:** N1MM Logger+ (contacts), **ADIF via UDP** – e.g. from **VarAC**, **JTAlert** or **GridTracker** – as well as WSJT-X/JTDX. Duplicate QSOs are detected.
- **Pass WSJT-X packets on** to GridTracker or JTAlert.

**More tools** under **More …**: Google Earth file (KML), check and optimize database, query the callbook for the selection (fill empty fields), print address labels. **Automatic daily backup** into a folder, e.g. a cloud folder.

## 8. DX cluster, alerts and WSJT-X

- **DX cluster:** enter the server in the options. Spots are marked: **red = new country**, **orange = new band**, grey = already worked. A click tunes radio and mode. **Alerts** reports new countries/bands or particular callsigns (with sound). **Spot** sends your own spot.
- **WSJT-X / JTDX:** in WSJT-X under *Settings → Reporting* set “UDP Server” to `127.0.0.1` and port `2237`, tick “Accept UDP requests”. Logged QSOs go into the logbook automatically. The **Alert (FT8)** window shows all decodes with country and status; a **double-click** calls the station in WSJT-X, **TX stop** ends transmitting.

## 9. Online services

![Online services](bilder/16-online-dienste.png)

In the options under **Online services**:

- **Callbook:** HamQTH (free) and/or QRZ.com (XML subscription) – deliver name, QTH, locator, photo while typing the callsign.
- **QRZ.com logbook:** API key from the QRZ logbook.
- **eQSL:** user name and password.
- **LoTW:** credentials for syncing and the **.p12 certificate** (exported from TQSL) with password for uploading.
- **Club Log:** e-mail, password, callsign.

New QSOs can be uploaded automatically (ticks “New QSOs to … immediately”). Confirmations are fetched with **Fetch LoTW** (logbook toolbar) or in the **QSL & Online** area.

## 10. Digital modes

![Digital modes](bilder/10-digitalbetrieb.png)

**Setup:** connect the radio's audio to the computer (USB sound card in the radio or an interface). In the **waterfall** choose the **input** and switch on **Receive**; in the **Transmit** window choose the **output** and the **level** (set so that the radio's ALC does not move). Set the radio to USB or the data mode (USB-D/PKTUSB).

**Modes** (selection top left in the waterfall or menu **Mode**):

| Group | Variants |
|---|---|
| PSK | BPSK31/63/125, QPSK31/63/125 |
| RTTY | 45.45 baud / 170 Hz (amateur radio); adjustable 50, 75, 100 baud and 200, 425, 450, 850 Hz shift – e.g. German weather service DWD: 50 baud, 450 Hz, polarity “reversed” or “automatic”, USOS off |
| CW | via radio or WinKeyer |
| MFSK | MFSK8, MFSK16, MFSK32 |
| DominoEX, THOR | 4, 5, 8, 11, 16, 22 |
| Olivia, Contestia | 4/125 … 64/2000 |
| Throb | 1, 2, 4 |
| MT63 | 500, 1000, 2000 Hz, short and long interleave |
| Hellschreiber | Feld-Hell (picture display instead of text) |
| SSTV | see [chapter 11](#11-sstv-picture-transmission) |

**Operation:**
- **Clicking into the waterfall** sets the receive frequency on the signal (the centre is found automatically).
- The **receive text** runs in the **Receive** window. **Clicking a word** copies it as callsign, name, QTH, locator or RST into the QSO window.
- **Transmit:** type text, **Ctrl+Enter** or **TX transmit**. PTT is switched automatically. **RX stop** aborts, **Tune** sends a 4 s carrier.
- **Macros F1–F12** with placeholders like `<CALL>`, `<NAME>`, `<RST>`, `<MYCALL>`, `<MYQTH>`, `<MYLOC>`, `<TIME>` – **Edit …** to change them. Your own details are under **About me**.
- **QSO window:** collect callsign, name, RST … and **Log** – mode and frequency are filled in automatically.
- **WWK Sweeper:** decodes up to 16 signals at the same time (BPSK, RTTY or CW); a click moves a signal to the main decoder.
- **World map:** shows the stations heard.

### FreeDV (digital voice)

**View → FreeDV (digital voice)** in digital modes. Choose the mode (**700D**, **700E** or **1600** – on the FreeDV frequencies mostly 700D/700E), **Receive from** (the radio's sound card or a receiver/WebSDR), **Speaker**, **Microphone** and **Transmit to radio**, then **▶ Receive**. Green = synchronized, next to it the signal-to-noise ratio. To talk hold **PTT** (or choose “latches”). The radio is set to USB.

## 11. SSTV (picture transmission)

![SSTV receive](bilder/11-sstv-empfang.png)

**SSTV window** via the toolbar (**SSTV**) or the **SSTV** menu.

- Switch on **Receive**. The mode is detected automatically at the start of the picture (VIS code); slant from inaccurate sound cards is corrected. If a picture is already running, choose the mode and **Start now**.
- Received pictures are saved automatically in **SSTV pictures** (gallery).
- 18 modes: Martin M1/M2, Scottie S1/S2/DX, Robot 36/72, PD 50/90/120/160/180/240/290, Wraase SC2-180, Pasokon P3/P5/P7.

**Transmit:** **Send picture …**

![SSTV transmit](bilder/12-sstv-senden.png)

Choose the background (test picture, own image file, last received picture), up to three text lines with placeholders (`<CALL> de <MYCALL>`, `ur <RST>` …), text colour and position. With **insert the other station's received picture small** the other station sees how its picture arrived. The preview shows the result and the transmit duration.

## 12. Winlink (e-mail over radio)

![Winlink](bilder/17-winlink.png)

The **Winlink** tab is a complete Winlink mailbox: write messages, exchange them over radio or internet, read, answer. On the left the folders (**Inbox**, **Outbox**, **Sent**, **Archive**), in the centre the messages with the reading pane below, on the right the connection with its log.

**Setup** (**Settings** or **F8 → Winlink**): Winlink callsign (empty = station callsign) and the **Winlink password** of the account on winlink.org. For radio operation also the modem:

| Connection method | What is needed |
|---|---|
| **Telnet – Winlink server** | internet only (exchange directly with the Winlink server, e.g. for testing) |
| **Telnet – peer** | address and port of another station on the network (station-to-station without a server) |
| **ARDOP** (shortwave) | the free modem **ardopcf** runs on this computer, e.g. `ardopcf 8515 <soundcard> <soundcard>` |
| **VARA** | the program **VARA** (separate, own license) is running; Wellenwerk only uses its TCP interface (port 8300) |
| **Packet** (VHF/UHF) | **Direwolf** (or another modem with AGW interface) is running, AGW port 8000 |

With ARDOP and VARA Wellenwerk keys the radio as soon as the modem wants to transmit (or the modem does it itself or via VOX – setting **PTT**).

**Writing a message:** **New** – recipients (callsign or e-mail address, several separated by commas), subject, text, attachments. The message waits in the **Outbox** for the next connection. Keep attachments small over radio.

**Connecting:** choose the connection method; for radio enter the **station** (callsign of the RMS gateway or station) and optionally the **frequency** in kHz – the radio is set to it beforehand. **Connect** exchanges in both directions: the outbox is sent, new messages arrive in the inbox (bold = unread). **Receive only** leaves the outbox. The log shows each step.

**Reading and more:** a click on a message shows it below; buttons or right-click: **Reply**, **Reply all**, **Forward**, **Archive**, **Delete**, in the Sent folder **Send again**. Save attachments with a click.

**Chat (keyboard QSO):** open the **Chat** window in the Winlink tab. Choose the connection method (ARDOP, VARA, packet or telnet to `host:port`) and the station, **Call** – or **Wait for calls**, then Wellenwerk accepts incoming connections (and keeps waiting afterwards). Type text, Enter sends. **Log** puts the station into the logbook. Plain text is sent line by line; this suits simple terminal programs. Chat and Winlink share the modem – only one at a time.

> Messages are stored as files in the data folder under `winlink/` (one folder per mailbox folder) and are thus part of the backup.

## 13. Satellites

![Satellites](bilder/13-satelliten.png)

Orbital data and transmitters are loaded automatically. On the left the list with current elevation (green above the horizon), **Selection …** chooses up to 100 satellites. Next to it the pass polar diagram, the map with ground track and footprint, position and frequencies, and the next passes.

- Choose the satellite's **transmitter** – downlink/uplink are shown.
- **Track radio (Doppler):** keeps adjusting the receive frequency; **Uplink via split** also sets the transmit frequency.
- **Track with rotator (az/el):** turns the antenna along.
- **Schedule:** all selected satellites of the next hours sorted by start, with minimum elevation and the filter “only with voice/transponder”. A click selects the satellite.
- **Mutual visibility:** enter the other station's callsign or locator – the list shows when a satellite is above the horizon for **both** stations (for one or all selected satellites).

![Satellite schedule](bilder/20-satelliten-zeitplan.png)

## 14. Rotator

![Rotator](bilder/14-rotor.png)

**Connect rotator:** manufacturer/model, port and speed (as for the radio). Operation: a click into the dial turns there, enter degrees, stop, park. The map on the right shows the beam direction (Mercator or great circle around your location). Enter the target as **callsign, country or locator**, **Short/Long** for short or long path, then **Turn rotator**. From logbook, cluster and maps use right-click → **Turn antenna**.

Also in the Connect dialog: **end stop** in the north (0°…360°) or south (−180°…+180°), **azimuth offset** for calibration (if the rotator shows 10° too much, enter −10), your own **rotation range** for rotators with overlap (e.g. 0…450° – Wellenwerk then takes the shorter way) and a **movement log**.

## 15. Maps

![Maps](bilder/15-karten.png)

World map with grey line (day/night), your station and spots, plus the **bearing map** (azimuthal equidistant around your location – directions are exact there). Right-clicking a point shows locator, direction and distance and turns the antenna on request.

## 16. Keyboard shortcuts

| Key | Effect |
|---|---|
| F8 | Program options |
| Ctrl+F8 | Customize layout |
| F11 | Full screen |
| Mouse wheel over a digit | change this digit (on the bars: Shift ×2, Ctrl ×5) |
| ← / → | change active digit |
| ↑ / ↓, + / − | increase / decrease active digit |
| 0–9 | type digit |
| Enter | frequency entry (radio control) or save QSO (entry) |
| Esc | clear entry, close menu |
| F1–F12 | macros in digital modes |
| Ctrl+Enter | transmit text (digital modes) |

Your own shortcuts: **Options → Keyboard shortcuts**.

## 17. Data, backup and moving

All data (logbooks, settings, favourites, SSTV pictures) is stored in the user folder:

- Windows: `%APPDATA%\Wellenwerk`
- macOS: `~/Library/Application Support/Wellenwerk`
- Linux: `~/.local/share/wellenwerk`

**Backing up:** **Backup** (logbook toolbar) makes a copy of the current logbook; **More … → Backups** restores. To move to another computer copy the whole folder or export the logbook as ADIF and import it on the new computer. The radio-control layout is transferred with **Customize layout → Save layout as file / Load layout from file**.

## 18. Access, API and AI assistants

Settings under **F8 → Access & API**.

**Password:** on the computer running Wellenwerk no sign-in is ever needed. If a password is set, Wellenwerk asks for it once on access from other devices (tablet, phone, second PC – also via `https://…:8443`). **Always set it before any access from the internet.**

**Station data in one place:** callsign, locator, operator, power and language come from **Station** or the active **station profile** and apply to all parts of the program (logbook, Winlink, maps, rotator, satellites …), to the interface and to extensions. When the profile changes, everyone knows immediately.

**API:** everything the interface can do also works via the interface. The description of all functions to try out: **API documentation** (address `/api/docs`). Programs on other computers need an **API key** (**Generate new key**) and send it as `Authorization: Bearer <key>`. Events (frequency, spots, QSOs, station data …) arrive in real time via the WebSocket `/ws`.

**AI assistants (MCP):** Wellenwerk includes an MCP server. With it e.g. Claude Desktop or other AI programs can query and operate the station: frequency and mode, look up callsigns, search the logbook, log QSOs, DX spots, rotator, Winlink messages. The ready-made entry is shown in the **MCP entry** field – **Copy** and paste it into the AI program's configuration (Claude Desktop: *Settings → Developer → Edit config*). Wellenwerk must be running.

**Extensions:** under **F8 → Extensions** extensions (plugins) can be installed (ZIP), switched on and off and configured. An example is included. How to write your own is described in the [developer guide](Extensions.md) (in the program: link on the same tab). Extensions automatically receive the station data, the interface language and all events.

> AI assistants may only **transmit** (PTT, CW, Winlink over radio) if **“AI assistants (MCP) may transmit”** is switched on. The radio amateur remains responsible for everything that is transmitted.

## 19. Error reports and updates

**Wellenwerk is an experimental alpha version** – not everything works without errors yet. A notice says so when it opens (can be hidden until the next version, shown again via **Help → About the alpha version**). Every user helps to improve the program by testing it and reporting problems.

**Feedback / report a problem** (menu **Help** or the orange **Alpha** badge at the bottom right): choose the type, describe the problem in your own words, optionally attach the error log and system data (no passwords). **Submit** e-mails the report to the address entered under *Errors & updates*; **Report on GitHub** opens a pre-filled issue in the public project (GitHub account needed).

**F8 → Errors & updates.**

**Anonymous user count:** a running Wellenwerk reports to the developers' receiving service every 10 minutes. This produces the “Wellenwerk online” display (number of users and countries) on the developer's website. Only a random program number (file `instanz-id` in the data folder) and the version number are sent. The receiving service (Cloudflare) determines the country from the connection. Neither IP address nor callsign or location is stored; an entry disappears after 25 minutes without a report, immediately on exit. To switch off, untick *Be counted anonymously as “online”*.

**Error report by e-mail:** Wellenwerk collects program errors from the service, the interface and the desktop program in the **error log** (**Help → Error log**). With *Report errors automatically by e-mail*, a message goes to the entered address about a minute after an error – at most one per set period (default 30 minutes) and at most 20 a day. Identical errors are combined, passwords and keys are blanked out. Enter an e-mail account for sending (SMTP server, port, user name, password). Without an account Wellenwerk tries to deliver the message directly; many providers reject that. **Send test message** checks the settings.

**Updates:** at every start Wellenwerk checks whether there is a newer version on GitHub.

| Setting | Behaviour |
|---|---|
| install automatically at start (default) | Desktop program: downloads the matching package (checksum verified), installs it and restarts – a small window shows the progress, **Skip** starts the current version. Server (Linux, from source): replaces the program files, installs changed Python packages and restarts; the previous version is kept as a backup in `data/update/`. |
| only notify | Notice in the interface; install via **Help → Check for updates**. |
| do not check | no check |

What is new or fixed is shown in the progress window while downloading, and once more at the first start of the new version (any time again: **Help → What's new in this version**). A server that runs permanently also checks once a day. Wellenwerk does not install while transmitting. On macOS the program needs write access to the Applications folder; otherwise Wellenwerk opens the new disk image for dragging. On Linux a .deb package is installed with `pkexec` (password prompt), an AppImage is simply replaced.

## 20. Troubleshooting

| Problem | Solution |
|---|---|
| “Radio does not answer” | Check COM port and baud rate (**Search baud rate**), for Icom the CI-V address. No other program may use the same COM port – connect other programs via “For other programs” (Hamlib NET rigctl) instead. |
| No COM port in the list | Install the radio's USB driver, replug the cable, reopen the dialog. Linux: group `dialout`. |
| No audio in digital modes | Choose the right **input**; macOS: allow microphone access for Wellenwerk (*System Settings → Privacy → Microphone*). |
| Transmit signal distorted | Reduce the **level**, watch the radio's ALC, speech processor off. |
| PTT does not switch | Check **PTT via** in the Connect dialog (CAT, DTR or RTS). |
| Panadapter stays empty | Icom: switch on the scope in the radio, “CI-V USB Port” to Unlinked, 115200 baud, tick “Panadapter” in the Connect dialog. IQ: choose the right stereo input. |
| WSJT-X QSOs do not arrive | In WSJT-X UDP server `127.0.0.1`, port 2237; the status bar at the bottom shows “WSJT-X” in green as soon as data arrives. |
| Cluster does not connect | Enter your callsign in the options; try another server. |
| Something does not work as expected | Look at **Help → Error log**; **Download** saves it as a text file to pass on. |

The status bar at the bottom always shows radio, cluster, WSJT-X and rotator – a right-click on it opens the matching settings.
