// Wellenwerk – Desktop-Programm: startet den lokalen Dienst und zeigt die Oberflaeche in einem eigenen Fenster.
const { app, BrowserWindow, Menu, session, shell, dialog, screen, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const updater = require("./updater");

let server = null, port = 0, mainWin = null, quitting = false;
const DEV_URL = process.env.WW_SERVER_URL;          // Entwicklung: vorhandenen Dienst benutzen
const stateFile = () => path.join(app.getPath("userData"), "fenster.json");

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function tryPort(want) { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(want, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
// Immer derselbe Port: Die Oberflaeche speichert Anordnung und Einstellungen im Browser-Speicher, und der gilt je Adresse
// (mit Port). Ein wechselnder Port haette bei jedem Start eine leere Oberflaeche bedeutet.
const portFile = () => path.join(app.getPath("userData"), "port.json");
async function freePort() {
  let want = 48090; try { want = JSON.parse(fs.readFileSync(portFile(), "utf8")).port || want; } catch { }
  let p; try { p = await tryPort(want); } catch { p = await tryPort(0); }
  try { fs.writeFileSync(portFile(), JSON.stringify({ port: p })); } catch { }
  return p;
}
function serverExe() {
  const exe = process.platform === "win32" ? "Wellenwerk.exe" : "Wellenwerk";
  const cands = [path.join(process.resourcesPath || "", "server", exe), path.join(__dirname, "..", "dist", "Wellenwerk", exe)];
  return cands.find(p => fs.existsSync(p));
}
function waitReady(url, ms = 30000) {
  const t0 = Date.now();
  return new Promise((res, rej) => { const tryIt = () => http.get(url + "api/state", r => { r.resume(); r.statusCode === 200 ? res() : retry(); }).on("error", retry);
    const retry = () => Date.now() - t0 > ms ? rej(new Error("Der Wellenwerk-Dienst startet nicht.")) : setTimeout(tryIt, 300); tryIt(); });
}
async function startServer() {
  if (DEV_URL) return DEV_URL;
  const exe = serverExe(); if (!exe) throw new Error("Programmdateien unvollständig (Dienst fehlt).");
  port = await freePort();
  const log = fs.createWriteStream(path.join(app.getPath("userData"), "dienst.log"), { flags: "a" });
  server = spawn(exe, ["--desktop", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(log); server.stderr.pipe(log);
  server.on("exit", code => { server = null; if (!quitting) noteCrash(`Wellenwerk-Dienst unerwartet beendet (Code ${code})`, tail(path.join(app.getPath("userData"), "dienst.log"))); if (!quitting) dialog.showErrorBox("Wellenwerk", `Der Wellenwerk-Dienst wurde beendet (Code ${code}). Details: ${path.join(app.getPath("userData"), "dienst.log")}`); });
  const url = `http://localhost:${port}/`;
  await waitReady(url); return url;
}
function stopServer() {
  return new Promise(res => { if (!server) return res();
    const req = http.request({ host: "127.0.0.1", port, path: "/api/shutdown", method: "POST" }, r => r.resume()); req.on("error", () => { }); req.end();
    const t = setTimeout(() => { try { server && server.kill(); } catch { } res(); }, 4000);
    server.once("exit", () => { clearTimeout(t); res(); }); });
}
// ---------- Fehler des Desktop-Programms ins Fehlerprotokoll des Dienstes ----------
function tail(file, n = 60) { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-n).join("\n"); } catch { return ""; } }
function noteCrash(message, detail = "", where = "Desktop-Programm") {
  const e = { message: String(message).slice(0, 2000), detail: String(detail || "").slice(0, 20000), where: `${where} ${app.getVersion()} ${process.platform}/${process.arch}` };
  if (server && port) {   // Dienst laeuft: direkt melden
    const body = JSON.stringify({ source: "desktop", ...e });
    const req = http.request({ host: "127.0.0.1", port, path: "/api/errors", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, r => r.resume());
    req.on("error", () => appendCrash(e)); req.end(body); return;
  }
  appendCrash(e);   // sonst merken – der Dienst liest die Datei beim naechsten Start ein
}
function appendCrash(e) { try { const d = updater.serverDataDir(); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, "desktop-errors.jsonl"), JSON.stringify(e) + "\n"); } catch { } }
process.on("uncaughtException", err => { noteCrash(`${err.name}: ${err.message}`, err.stack, "Desktop-Hauptprozess"); console.error(err); });
process.on("unhandledRejection", err => noteCrash(String(err && err.message || err), err && err.stack, "Desktop-Hauptprozess"));

function loadBounds() { try { const b = JSON.parse(fs.readFileSync(stateFile(), "utf8")); const d = screen.getDisplayMatching(b); return d ? b : null; } catch { return null; } }
function saveBounds(w) { try { fs.writeFileSync(stateFile(), JSON.stringify({ ...w.getNormalBounds(), max: w.isMaximized() })); } catch { } }

function createWindow(url) {
  const b = loadBounds() || { width: 1440, height: 900 };
  mainWin = new BrowserWindow({ ...b, minWidth: 900, minHeight: 600, title: "Wellenwerk", icon: path.join(__dirname, "build", "icon.png"), backgroundColor: "#dfe8f3", show: false, ...(process.env.WW_TEST_SHOT ? { x: -3000, y: 0 } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });
  if (b.max) mainWin.maximize();
  mainWin.once("ready-to-show", () => { if (!process.env.WW_TEST_SHOT) mainWin.show(); else mainWin.showInactive(); });
  mainWin.on("close", () => saveBounds(mainWin));
  mainWin.webContents.on("render-process-gone", (ev, d) => { if (d.reason !== "clean-exit") noteCrash(`Oberfläche abgestürzt (${d.reason}, Code ${d.exitCode})`, "", "Desktop-Fenster"); });
  // Ausgelagerte Fenster (zweiter Bildschirm) als eigene Programmfenster, Links nach aussen im Standardbrowser
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url) || u === "about:blank") return { action: "allow", overrideBrowserWindowOptions: { title: "Wellenwerk", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } } };
    shell.openExternal(u); return { action: "deny" };
  });
  mainWin.loadURL(url + "?desktop=1");
  if (process.env.WW_TEST_SHOT) selfTest(url);
}
// Selbsttest (nur Entwicklung/CI): Oberflaeche pruefen, Bildschirmfoto, ausgelagertes Fenster, sauberes Beenden
function selfTest(url) {
  mainWin.webContents.once("did-finish-load", async () => {
    await new Promise(r => setTimeout(r, 5000));
    const r = await mainWin.webContents.executeJavaScript(`(async () => { const st = await (await fetch("/api/state")).json();
      const mic = await navigator.permissions.query({ name: "microphone" }).then(p => p.state).catch(e => "?");
      return { title: document.title, version: WW.version, desktop: !!window.wwDesktop, rig: st.rig.connected, secure: window.isSecureContext, mic, apps: [...document.querySelectorAll("#apptabs button")].map(b => b.textContent.trim()) }; })()`);
    console.log("SELBSTTEST " + JSON.stringify(r));
    const img = await mainWin.webContents.capturePage(); fs.writeFileSync(process.env.WW_TEST_SHOT, img.toPNG());
    const before = BrowserWindow.getAllWindows().length;
    await mainWin.webContents.executeJavaScript(`window.open("/static/popout.html", "_blank", "width=400,height=300"); 1`);
    await new Promise(r => setTimeout(r, 1500)); console.log("FENSTER " + before + " -> " + BrowserWindow.getAllWindows().length);
    app.quit();
  });
}

app.whenReady().then(async () => {
  // Soundkarte (Digitalbetrieb, SSTV, Sprachspeicher) ohne Rueckfrage im Programm erlauben
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(["media", "speaker-selection", "clipboard-sanitized-write", "fullscreen", "notifications"].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ["media", "speaker-selection", "clipboard-sanitized-write", "fullscreen"].includes(perm));
  // Programm-Menues bringt die Oberflaeche selbst mit; macOS braucht trotzdem die Standard-Bearbeiten-Befehle
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  ipcMain.handle("ww-update-check", () => updater.check());
  ipcMain.handle("ww-update-install", async () => { const u = await updater.check(); if (!u.newer) throw new Error("Keine neuere Version vorhanden"); return updater.run(u, { beforeQuit: () => { quitting = true; return stopServer(); } }); });
  // Beim Start nach einer neuen Version sehen und sie (Einstellung „automatisch installieren“) gleich installieren
  if (!DEV_URL && !process.env.WW_TEST_SHOT && (app.isPackaged || process.env.WW_UPDATE_URL) && updater.mode() === "auto") {
    try { const u = await updater.check(6000); if (u.newer && u.asset && await updater.run(u, { atStart: true })) return; }
    catch (e) { console.warn("Update:", e.message); if (!/Netz|fetch|ENOTFOUND|timeout|abgebrochen|übersprungen/i.test(e.message)) noteCrash("Aktualisierung fehlgeschlagen: " + e.message, e.stack, "Updater"); }
  }
  try { createWindow(await startServer()); }
  catch (e) { dialog.showErrorBox("Wellenwerk", e.message); app.quit(); }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", async e => { if (quitting) return; quitting = true; if (server) { e.preventDefault(); await stopServer(); app.quit(); } });
