# Erweiterungen für Wellenwerk entwickeln

Wellenwerk lässt sich mit **Erweiterungen** (Plugins) ausbauen – mit eigenen Fenstern, Registern und Menüpunkten in der Oberfläche und eigenen Funktionen im Server. Wer lieber von außen steuert, nutzt die **API** (`/api/docs` im laufenden Programm) oder den **MCP-Server** für KI-Assistenten (siehe Anleitung, Kapitel „Zugang, API und KI-Assistenten“).

Ein vollständiges Beispiel liegt bei: **F8 → Erweiterungen → Beispiel „Stationsanzeige“ installieren**, dann einschalten. Den Quelltext findest du im Datenordner unter `plugins/beispiel/` (bzw. im Repository unter `beispiele/plugins/beispiel/`).

## Aufbau

Eine Erweiterung ist ein Ordner im Datenordner unter `plugins/<id>/` (Datenordner: Windows `%APPDATA%\Wellenwerk`, macOS `~/Library/Application Support/Wellenwerk`, Linux `~/.local/share/wellenwerk`). Zum Weitergeben den Ordner als ZIP packen; installiert wird über **F8 → Erweiterungen → ZIP installieren**.

```
plugins/meine-erweiterung/
  manifest.json     Pflicht
  plugin.js         optional: Oberflächen-Teil
  plugin.py         optional: Server-Teil
  daten/            wird angelegt: Ablage für den Server-Teil (nicht über das Netz abrufbar)
```

### manifest.json

```json
{
  "id": "meine-erweiterung",
  "name": "Meine Erweiterung",
  "version": "1.0",
  "author": "DL0ABC",
  "description": "Was sie tut – erscheint in den Programmoptionen.",
  "frontend": "plugin.js",
  "backend": "plugin.py",
  "settings": [
    { "key": "server", "label": "Server-Adresse", "type": "text", "default": "" },
    { "key": "kennwort", "label": "Kennwort", "type": "password" },
    { "key": "intervall", "label": "Intervall (s)", "type": "number", "default": 30 },
    { "key": "aktiv", "label": "automatisch senden", "type": "bool", "default": false },
    { "key": "band", "label": "Band", "type": "select", "options": ["20m", "40m"], "default": "20m" }
  ]
}
```

`id`: Kleinbuchstaben, Ziffern, `-` und `_`. Die **Einstellungen** erzeugt Wellenwerk selbst als Formular in den Programmoptionen; Werte vom Typ `password` werden nie wieder an die Oberfläche geschickt.

## Oberflächen-Teil (JavaScript)

```js
Wellenwerk.register("meine-erweiterung", {
  start(ctx) {
    ctx.addPanel("log", "liste", {               // Fenster im Register Logbuch
      title: "Meine Liste",
      create(root) {
        const draw = () => root.textContent = `${ctx.station().callsign} – ${ctx.settings.band}`;
        ctx.on("station", draw);                  // Stationsdaten geändert (Profil, Rufzeichen, Locator …)
        ctx.on("plugin-settings", draw);          // eigene Einstellungen geändert
        draw();
      },
    });
    ctx.addMenuItem("Meine Aktion", () => ctx.toast("Hallo"));
  },
  stop() { /* aufräumen */ },
});
```

| `ctx.…` | Bedeutung |
|---|---|
| `station()` | Stationsdaten: `callsign`, `home_callsign`, `operator`, `locator`, `lat`, `lon`, `tx_pwr`, `profile`, `my_pota_ref`, `my_sota_ref`, `my_wwff_ref`, `winlink_call` |
| `settings` | eigene Einstellungen (aktuelle Werte) |
| `rig()` | Zustand des aktuellen Funkgeräts (`freq` in Hz, `mode`, `ptt`, `meters` …) |
| `on(ereignis, fn)` | Ereignisse: `rig`, `station`, `spot`, `qso`, `decode`, `cluster`, `rotor`, `winlink`, `radios`, `spectrum`, `settings`, `plugin-settings` sowie eigene Meldungen des Server-Teils (über ihren `type`). Wird beim Ausschalten automatisch abgemeldet. |
| `api(pfad, optionen)` / `post(pfad, daten)` | REST-API. Pfad ohne führenden `/` = eigene Routen des Server-Teils (`/api/plugins/<id>/…`) |
| `setFrequency(hz)`, `setMode(mode)` | Funkgerät abstimmen |
| `logQso({call, band, mode, …})` | QSO eintragen (ADIF-Feldnamen) |
| `addPanel(register, schlüssel, {title, create})` | Fenster in einem Register: `rig`, `log`, `dm`, `wl`, `sat`, `rot`, `map` |
| `addApp(schlüssel, {title, icon, panels})` | eigenes Hauptregister (wird beim nächsten Laden angezeigt) |
| `addMenuItem(text, fn, register?)` | Punkt im Menü „Erweiterungen“ |
| `storage.get/set` | kleine Ablage im Browser |
| `toast`, `esc`, `icon`, `dialog` | Hilfsfunktionen der Oberfläche |

## Server-Teil (Python)

```python
def setup(ww):
    @ww.router.get("/status")                 # erreichbar als GET /api/plugins/<id>/status
    async def status():
        return {"rufzeichen": ww.station()["callsign"], "einstellungen": ww.settings()}

    async def neues_qso(msg):                 # jede Meldung an die Oberfläche kommt auch hier an
        q = msg["qso"]
        ww.log.info("neues QSO mit %s", q["call"])
        await ww.broadcast({"type": "mein_ereignis", "call": q["call"]})

    ww.on("qso", neues_qso)
```

| `ww.…` | Bedeutung |
|---|---|
| `router` | FastAPI-`APIRouter` unter `/api/plugins/<id>` (erscheint in `/api/docs`) |
| `on(typ, fn)` | Meldungen abonnieren (`rig`, `qso`, `spot`, `station_identity`, `winlink`, `decode`, `radios` … oder `*`) |
| `station()`, `settings()`, `program_settings()` | Stationsdaten, eigene Einstellungen, Programmoptionen (Kennwörter maskiert) |
| `broadcast(meldung)` | Meldung an alle Fenster (kommt dort als `ctx.on(type, …)` an) |
| `rig`, `radios` | aktuelles Funkgerät (`await ww.rig.set_freq(hz)` …) bzw. Geräteverwaltung |
| `log_qso(rec)` | QSO eintragen (mit Land, Callbook, Weiterleitung, Uploads) |
| `register_receiver(art, klasse, name)` | eigene Empfänger-Art (Unterklasse von `wellenwerk.sdr.base.SdrRig`) |
| `data_dir`, `log` | eigener Datenordner, Protokoll |

Der Server-Teil wird beim Einschalten geladen und beim Ausschalten sofort abgemeldet (Ereignisse und API-Routen); eine Funktion `teardown()` im Modul wird dann aufgerufen, falls vorhanden.

## Sicherheit

Erweiterungen sind nach der Installation **aus**. Eingeschaltet haben sie dieselben Rechte wie Wellenwerk – sie können das Funkgerät steuern (auch senden), das Logbuch ändern und Dateien lesen. Nur Erweiterungen aus vertrauenswürdiger Quelle einschalten.
