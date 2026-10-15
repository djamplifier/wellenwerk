// Wellenwerk – Desktop-Programm: startet den lokalen Dienst und zeigt die Oberflaeche in einem eigenen Fenster.
const { app, BrowserWindow, Menu, session, shell, dialog, screen } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");

let server = null, port = 0, mainWin = null, quitting = false;
const DEV_URL = process.env.WW_SERVER_URL;          // Entwicklung: vorhandenen Dienst benutzen
const stateFile = () => path.join(app.getPath("userData"), "fenster.json");

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
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
  server.on("exit", code => { server = null; if (!quitting) dialog.showErrorBox("Wellenwerk", `Der Wellenwerk-Dienst wurde beendet (Code ${code}). Details: ${path.join(app.getPath("userData"), "dienst.log")}`); });
  const url = `http://localhost:${port}/`;
  await waitReady(url); return url;
}
function stopServer() {
  return new Promise(res => { if (!server) return res();
    const req = http.request({ host: "127.0.0.1", port, path: "/api/shutdown", method: "POST" }, r => r.resume()); req.on("error", () => { }); req.end();
    const t = setTimeout(() => { try { server && server.kill(); } catch { } res(); }, 4000);
    server.once("exit", () => { clearTimeout(t); res(); }); });
}
function loadBounds() { try { const b = JSON.parse(fs.readFileSync(stateFile(), "utf8")); const d = screen.getDisplayMatching(b); return d ? b : null; } catch { return null; } }
function saveBounds(w) { try { fs.writeFileSync(stateFile(), JSON.stringify({ ...w.getNormalBounds(), max: w.isMaximized() })); } catch { } }

function createWindow(url) {
  const b = loadBounds() || { width: 1440, height: 900 };
  mainWin = new BrowserWindow({ ...b, minWidth: 900, minHeight: 600, title: "Wellenwerk", icon: path.join(__dirname, "build", "icon.png"), backgroundColor: "#dfe8f3", show: false, ...(process.env.WW_TEST_SHOT ? { x: -3000, y: 0 } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });
  if (b.max) mainWin.maximize();
  mainWin.once("ready-to-show", () => { if (!process.env.WW_TEST_SHOT) mainWin.show(); else mainWin.showInactive(); });
  mainWin.on("close", () => saveBounds(mainWin));
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
  try { createWindow(await startServer()); }
  catch (e) { dialog.showErrorBox("Wellenwerk", e.message); app.quit(); }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", async e => { if (quitting) return; quitting = true; if (server) { e.preventDefault(); await stopServer(); app.quit(); } });
