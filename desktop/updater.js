// Wellenwerk – Aktualisierung des Desktop-Programms: neueste veroeffentlichte Version auf GitHub suchen,
// passendes Installationspaket laden (Pruefsumme), installieren und neu starten.
// Windows: Setup still ausfuehren · macOS: Programm im Programme-Ordner austauschen · Linux: AppImage ersetzen bzw. .deb mit pkexec
const { app, BrowserWindow, net, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

const FEED = process.env.WW_UPDATE_URL || "https://api.github.com/repos/djamplifier/wellenwerk/releases/latest";

// Datenordner des Dienstes (wie wellenwerk/__main__.py) – dort steht die Einstellung update_mode
function serverDataDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Wellenwerk");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Wellenwerk");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "wellenwerk");
}
function cfg() { try { return JSON.parse(fs.readFileSync(path.join(serverDataDir(), "config.json"), "utf8")); } catch { return {}; } }
function mode() { return cfg().update_mode || "auto"; }
// Texte des Fortschrittsfensters: Sprache wie in Wellenwerk eingestellt
const EN = { "Überspringen": "Skip", "Wellenwerk wird aktualisiert": "Updating Wellenwerk", "Version {} wird geladen …": "Downloading version {} …",
  "Installiere …": "Installing …", "Installiere … Wellenwerk startet danach neu.": "Installing … Wellenwerk restarts afterwards.", "Beende Wellenwerk …": "Closing Wellenwerk …",
  "Version {} installiert – Neustart …": "Version {} installed – restarting …", "Installiere (Passwort für die Paketverwaltung) …": "Installing (password for the package manager) …", "Neu in Version {}": "New in version {}" };
function tr(s, x = "") { const l = cfg().lang || (String(app.getLocale()).startsWith("de") ? "de" : "en"); return (l === "en" && EN[s] ? EN[s] : s).replace("{}", x); }

function parseVer(v) {
  const m = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(String(v || "").trim()); if (!m) return [0];
  const n = m[1].split(".").map(Number); while (n.length < 3) n.push(0);
  return [...n, m[2] ? 0 : 1, m[2] || ""];
}
function newer(a, b) { const x = parseVer(a), y = parseVer(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) > (y[i] ?? 0)) return true; if ((x[i] ?? 0) < (y[i] ?? 0)) return false; } return false; }

// Passendes Paket fuer dieses System
function pickAsset(assets) {
  const L = a => (a.name || "").toLowerCase();
  if (process.platform === "win32") return assets.find(a => /\.exe$/.test(L(a)) && /setup/.test(L(a))) || assets.find(a => /\.exe$/.test(L(a)));
  if (process.platform === "darwin") {
    const dmgs = assets.filter(a => /\.dmg$/.test(L(a))), arm = a => /(applesilicon|arm64)/.test(L(a));
    return process.arch === "arm64" ? dmgs.find(arm) : (dmgs.find(a => /(intel|x64)/.test(L(a))) || dmgs.find(a => !arm(a)));
  }
  if (process.env.APPIMAGE) return assets.find(a => /\.appimage$/.test(L(a)));
  return assets.find(a => /amd64\.deb$/.test(L(a)) && process.arch === "x64") || assets.find(a => /\.deb$/.test(L(a)));
}

async function check(timeout = 15000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await net.fetch(FEED, { headers: { "User-Agent": "Wellenwerk-Updater", Accept: "application/vnd.github+json" }, signal: ac.signal });
    if (!r.ok) throw new Error(`Update-Server antwortet ${r.status}`);
    const j = await r.json();
    const latest = String(j.tag_name || "").replace(/^v/, "");
    const asset = pickAsset(j.assets || []);
    return { current: app.getVersion(), latest, newer: newer(latest, app.getVersion()), asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || "" } : null, notes: j.body || "", url: j.html_url || "" };
  } catch (e) { throw new Error(e.name === "AbortError" ? "Netz: Zeitüberschreitung" : e.message); }
  finally { clearTimeout(t); }
}

// ---------- kleines Fortschrittsfenster ----------
// Neuerungen (Markdown der Veroeffentlichung) einfach als HTML: Ueberschriften, Aufzaehlungen, fett, Links als Text
function mdToHtml(md) {
  const e = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const inl = s => e(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  let out = "", list = false;
  for (const raw of String(md || "").split(/\r?\n/)) {
    const l = raw.trim(), li = /^[-*+] +(.*)$/.exec(l), h = /^#{1,6} +(.*)$/.exec(l);
    if (!li && list) { out += "</ul>"; list = false; }
    if (li) { if (!list) { out += "<ul>"; list = true; } out += `<li>${inl(li[1])}</li>`; }
    else if (h) out += `<h4>${inl(h[1])}</h4>`;
    else if (l) out += `<p>${inl(l)}</p>`;
  }
  return out + (list ? "</ul>" : "");
}

function splash(u) {
  const notes = mdToHtml(u && u.notes);
  const w = new BrowserWindow({ width: notes ? 620 : 460, height: notes ? 520 : 190, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: "Wellenwerk – Aktualisierung",
    icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true, show: !process.env.WW_UPDATE_HIDDEN, backgroundColor: "#dfe8f3", webPreferences: { sandbox: true, contextIsolation: true } });
  const T = { skip: tr("Überspringen"), title: tr("Wellenwerk wird aktualisiert"), news: tr("Neu in Version {}", u && u.latest) };
  w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>update</title>
    <body style="font:14px system-ui,sans-serif;margin:18px;background:#dfe8f3;color:#123">
    <b>${T.title}${u && u.latest ? " – " + u.latest : ""}</b><p id="t" style="min-height:1.4em;margin:8px 0">…</p>
    <div style="height:10px;background:#fff;border:1px solid #9ab;border-radius:5px;overflow:hidden"><div id="b" style="height:100%;width:0;background:#2f6fb3"></div></div>
    ${notes ? `<div style="margin-top:12px;font-weight:600">${T.news}</div><div style="height:300px;overflow:auto;background:#fff;border:1px solid #9ab;border-radius:4px;padding:2px 12px;margin-top:4px;font-size:13px">${notes}</div>` : ""}
    <p style="text-align:right;margin:12px 0 0"><button id="s" onclick="document.title='skip'">${T.skip}</button></p></body>`));
  let skipped = false;
  if (process.env.WW_UPDATE_SHOT)   // nur Test: Bildschirmfoto des Fensters, danach „Überspringen“
    w.webContents.once("did-finish-load", () => setTimeout(() => w.webContents.capturePage().then(i => { fs.writeFileSync(process.env.WW_UPDATE_SHOT, i.toPNG()); skipped = true; }), 2500));
  w.on("page-title-updated", (e, t) => { if (t === "skip") skipped = true; });
  w.on("closed", () => { skipped = true; });
  const js = code => { if (!w.isDestroyed()) w.webContents.executeJavaScript(code).catch(() => { }); };
  return { win: w, get skipped() { return skipped; },
    text: t => js(`document.getElementById("t").textContent=${JSON.stringify(t)}`),
    bar: f => js(`document.getElementById("b").style.width="${Math.round(f * 100)}%"`),
    noSkip: () => js(`document.getElementById("s").disabled=true`),
    close: () => { if (!w.isDestroyed()) w.destroy(); } };
}

async function download(asset, dest, sp) {
  const r = await net.fetch(asset.url, { headers: { "User-Agent": "Wellenwerk-Updater" } });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  const total = +r.headers.get("content-length") || asset.size || 0;
  const hash = crypto.createHash("sha256"), out = fs.createWriteStream(dest);
  const rd = r.body.getReader(); let got = 0, last = 0;
  try {
    for (;;) {
      if (sp.skipped) throw new Error("übersprungen");
      const { done, value } = await rd.read(); if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(res => out.once("drain", res));
      if (Date.now() - last > 200) { last = Date.now(); sp.bar(total ? got / total : 0); sp.text(`${asset.name}: ${(got / 1048576).toFixed(1)}${total ? " / " + (total / 1048576).toFixed(1) : ""} MB`); }
    }
  } finally { await new Promise(res => out.end(res)); }
  if (total && got !== total) throw new Error("Download unvollständig");
  const want = String(asset.digest || "").replace(/^sha256:/, "");
  if (want && hash.digest("hex") !== want) throw new Error("Prüfsumme stimmt nicht – Paket verworfen");
}

const run_ = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, so, se) => e ? rej(new Error(`${path.basename(cmd)}: ${(se || e.message).trim().slice(-300)}`)) : res(so)));
// Shell-Skript, das wartet, bis dieses Programm beendet ist, und dann weitermacht
function afterExit(lines) {
  const f = path.join(app.getPath("temp"), `wellenwerk-update-${Date.now()}.sh`);
  fs.writeFileSync(f, `#!/bin/sh\nwhile kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done\n${lines.join("\n")}\nrm -f "$0"\n`, { mode: 0o755 });
  spawn("/bin/sh", [f], { detached: true, stdio: "ignore" }).unref();
}
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function install(file, sp) {
  sp.noSkip(); sp.bar(1);
  if (process.platform === "win32") {
    sp.text(tr("Installiere … Wellenwerk startet danach neu."));
    spawn(file, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (process.platform === "darwin") {
    const appPath = path.resolve(process.execPath, "../../..");
    const dir = path.dirname(appPath);
    let writable = appPath.endsWith(".app"); try { fs.accessSync(dir, fs.constants.W_OK); } catch { writable = false; }
    if (!writable) { await shell.openPath(file); throw new Error("Keine Schreibrechte im Programme-Ordner – das Installationsabbild wurde geöffnet, bitte Wellenwerk hineinziehen."); }
    sp.text(tr("Installiere …"));
    const mnt = fs.mkdtempSync(path.join(app.getPath("temp"), "wwdmg-"));
    await run_("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mnt, file]);
    const neu = path.join(dir, ".Wellenwerk-neu.app");
    try {
      const src = fs.readdirSync(mnt).find(n => n.endsWith(".app")); if (!src) throw new Error("Im Abbild ist kein Programm");
      fs.rmSync(neu, { recursive: true, force: true });
      await run_("/usr/bin/ditto", [path.join(mnt, src), neu]);
    } finally { await run_("/usr/bin/hdiutil", ["detach", mnt, "-force"]).catch(() => { }); }
    afterExit([`A=${q(appPath)}; N=${q(neu)}`, `rm -rf "$A.alt"; if mv "$A" "$A.alt" && mv "$N" "$A"; then rm -rf "$A.alt"; else [ -d "$A.alt" ] && mv "$A.alt" "$A"; fi`,
      `xattr -dr com.apple.quarantine "$A" 2>/dev/null`, `open "$A"`]);
    return true;
  }
  if (process.env.APPIMAGE) {
    const target = process.env.APPIMAGE, tmp = target + ".neu";
    fs.copyFileSync(file, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, target);
    afterExit([`${q(target)} >/dev/null 2>&1 &`]);
    return true;
  }
  sp.text(tr("Installiere (Passwort für die Paketverwaltung) …"));
  try { await run_("pkexec", ["apt-get", "install", "-y", "--allow-downgrades", file]); }
  catch (e) { await shell.openPath(file); throw new Error("Paket konnte nicht automatisch installiert werden – es wurde zur Installation geöffnet. " + e.message); }
  afterExit([`${q(process.execPath)} >/dev/null 2>&1 &`]);
  return true;
}

// Aktualisieren. Gibt true zurueck, wenn das Programm jetzt beendet wird (Installation laeuft / Neustart folgt).
async function run(u, { atStart = false, beforeQuit } = {}) {
  if (!u.asset) throw new Error("Für dieses System gibt es in der neuen Version kein Installationspaket.");
  const sp = splash(u);
  let stopped = false;
  try {
    sp.text(tr("Version {} wird geladen …", u.latest));
    const dir = path.join(app.getPath("temp"), "wellenwerk-update"); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, u.asset.name.replace(/[^\w.\-]/g, "_"));
    await download(u.asset, file, sp);
    if (process.platform !== "win32") fs.chmodSync(file, 0o755);
    if (!app.isPackaged) throw new Error("Entwicklungsmodus – Installation übersprungen");   // nie die Entwicklungsumgebung ersetzen
    if (beforeQuit) { sp.text(tr("Beende Wellenwerk …")); await beforeQuit(); stopped = true; }
    await install(file, sp);
    sp.text(tr("Version {} installiert – Neustart …", u.latest));
    setTimeout(() => app.exit(0), 600);
    return true;
  } catch (e) {
    sp.close();
    if (stopped) { app.relaunch(); setTimeout(() => app.exit(0), 300); }   // Dienst war schon beendet: neu starten
    if (sp.skipped && !atStart) throw new Error("abgebrochen");
    if (sp.skipped) return false;
    throw e;
  }
}

module.exports = { check, run, mode, serverDataDir, newer, pickAsset };
