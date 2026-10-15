# Developing extensions for Wellenwerk

*Deutsch: [Erweiterungen.md](Erweiterungen.md)*

Wellenwerk can be extended with **extensions** (plugins) – with their own windows, tabs and menu items in the interface and their own functions in the server. If you prefer to control it from outside, use the **API** (`/api/docs` in the running program) or the **MCP server** for AI assistants (see the manual, chapter “Access, API and AI assistants”).

A complete example is included: **F8 → Extensions → install example “Stationsanzeige”**, then switch it on. The source code is in the data folder under `plugins/beispiel/` (or in the repository under `beispiele/plugins/beispiel/`).

## Structure

An extension is a folder in the data folder under `plugins/<id>/` (data folder: Windows `%APPDATA%\Wellenwerk`, macOS `~/Library/Application Support/Wellenwerk`, Linux `~/.local/share/wellenwerk`). To pass it on, zip the folder; it is installed via **F8 → Extensions → Install ZIP**.

```
plugins/my-extension/
  manifest.json     required
  plugin.js         optional: interface part
  plugin.py         optional: server part
  daten/            created automatically: storage for the server part (not reachable over the network)
```

### manifest.json

```json
{
  "id": "my-extension",
  "name": "My extension",
  "version": "1.0",
  "author": "N0CALL",
  "description": "What it does – shown in the program options.",
  "frontend": "plugin.js",
  "backend": "plugin.py",
  "settings": [
    { "key": "server", "label": "Server address", "type": "text", "default": "" },
    { "key": "password", "label": "Password", "type": "password" },
    { "key": "interval", "label": "Interval (s)", "type": "number", "default": 30 },
    { "key": "active", "label": "send automatically", "type": "bool", "default": false },
    { "key": "band", "label": "Band", "type": "select", "options": ["20m", "40m"], "default": "20m" }
  ]
}
```

`id`: lower-case letters, digits, `-` and `_`. Wellenwerk builds the **settings** form in the program options itself; values of type `password` are never sent back to the interface.

## Interface part (JavaScript)

```js
Wellenwerk.register("my-extension", {
  start(ctx) {
    ctx.addPanel("log", "list", {                 // window in the Logbook tab
      title: "My list",
      create(root) {
        const draw = () => root.textContent = `${ctx.station().callsign} – ${ctx.settings.band}`;
        ctx.on("station", draw);                  // station data changed (profile, callsign, locator …)
        ctx.on("plugin-settings", draw);          // own settings changed
        draw();
      },
    });
    ctx.addMenuItem("My action", () => ctx.toast("Hello"));
  },
  stop() { /* clean up */ },
});
```

| `ctx.…` | Meaning |
|---|---|
| `station()` | station data: `callsign`, `home_callsign`, `operator`, `locator`, `lat`, `lon`, `tx_pwr`, `profile`, `my_pota_ref`, `my_sota_ref`, `my_wwff_ref`, `winlink_call`, `lang` (language of the station) |
| `lang`, `locale()`, `t(text)` | interface language in this browser (`de`, `en`), matching locale for dates/numbers, translation of a German text |
| `settings` | own settings (current values) |
| `rig()` | state of the current radio (`freq` in Hz, `mode`, `ptt`, `meters` …) |
| `on(event, fn)` | events: `rig`, `station`, `spot`, `qso`, `decode`, `cluster`, `rotor`, `winlink`, `radios`, `spectrum`, `settings`, `plugin-settings` and the server part's own messages (by their `type`). Unsubscribed automatically on switch-off. |
| `api(path, options)` / `post(path, data)` | REST API. A path without leading `/` = the server part's own routes (`/api/plugins/<id>/…`) |
| `setFrequency(hz)`, `setMode(mode)` | tune the radio |
| `logQso({call, band, mode, …})` | log a QSO (ADIF field names) |
| `addPanel(tab, key, {title, create})` | window in a tab: `rig`, `log`, `dm`, `wl`, `sat`, `rot`, `map` |
| `addApp(key, {title, icon, panels})` | own main tab (shown on the next load) |
| `addMenuItem(text, fn, tab?)` | item in the “Extensions” menu |
| `storage.get/set` | small storage in the browser |
| `toast`, `esc`, `icon`, `dialog` | interface helpers |

### Languages

The interface translates all visible texts itself using `static/i18n/<language>.json` (German text → translation). Texts of an extension can be written in English if it only targets English users, or in German with translations supplied:

```js
Wellenwerk.addTranslations("en", { "Meine Liste": "My list", "{} QSOs heute": "{} QSOs today" });
```

`{}` stands for any part (number, callsign …). Areas that must not be translated (received text, data) get `translate="no"`. More languages for the whole program: create `static/i18n/<language>.json` following `en.json` and add it to `LANGS`/`LOCALES` in `static/js/i18n.js`.

## Server part (Python)

```python
def setup(ww):
    @ww.router.get("/status")                 # reachable as GET /api/plugins/<id>/status
    async def status():
        return {"callsign": ww.station()["callsign"], "settings": ww.settings()}

    async def new_qso(msg):                   # every message to the interface also arrives here
        q = msg["qso"]
        ww.log.info("new QSO with %s", q["call"])
        await ww.broadcast({"type": "my_event", "call": q["call"]})

    ww.on("qso", new_qso)
```

| `ww.…` | Meaning |
|---|---|
| `router` | FastAPI `APIRouter` under `/api/plugins/<id>` (appears in `/api/docs`) |
| `on(type, fn)` | subscribe to messages (`rig`, `qso`, `spot`, `station_identity`, `winlink`, `decode`, `radios` … or `*`) |
| `station()`, `settings()`, `program_settings()` | station data (including `lang`), own settings, program options (passwords masked) |
| `broadcast(message)` | message to all windows (arrives there as `ctx.on(type, …)`) |
| `rig`, `radios` | current radio (`await ww.rig.set_freq(hz)` …) and radio management |
| `log_qso(rec)` | log a QSO (with country, callbook, forwarding, uploads) |
| `register_receiver(kind, cls, name)` | own receiver type (subclass of `wellenwerk.sdr.base.SdrRig`) |
| `data_dir`, `log` | own data folder, log |

The server part is loaded on switch-on and unregistered immediately on switch-off (events and API routes); a function `teardown()` in the module is then called if present.

## Security

Extensions are **off** after installation. Once switched on they have the same rights as Wellenwerk – they can control the radio (including transmitting), change the logbook and read files. Only switch on extensions from a trusted source.
