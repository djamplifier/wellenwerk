// Oberflaechen-Selbsttest im Build: das fertige Programm laeuft auf :8099, Chrome laedt die Oberflaeche wie das
// Desktop-Programm (auch mit Windows-Skalierung 125 %), oeffnet die Programme und den Wasserfall und prueft:
// keine JavaScript-Fehler, Regler bleiben ohne Bedienung stehen, Bildschirmklasse/Anordnung pendelt nicht.
const path = require("path"), fs = require("fs");
const puppeteer = require(path.join(process.env.RUNNER_TEMP, "ui", "node_modules", "puppeteer-core"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = [process.env.CHROME, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"].find(p => p && fs.existsSync(p));
(async () => {
  if (!chrome) { console.log("Kein Chrome gefunden – Oberflaechentest uebersprungen"); return; }
  const br = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] });
  const fails = [];
  for (const [w, h, dpr] of [[1536, 790, 1.25], [1920, 1000, 1], [2560, 1400, 1], [1280, 680, 1.5]]) {
    const pg = await br.newPage(); const errs = [];
    pg.on("pageerror", e => errs.push(e.message)); await pg.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
    await pg.evaluateOnNewDocument(() => { window.__flip = 0; new MutationObserver(m => m.forEach(x => { if (x.attributeName === "data-screen" || x.attributeName === "data-det") window.__flip++; }))
      .observe(document, { attributes: true, subtree: true, attributeFilter: ["data-screen", "data-det"] }); });
    await pg.goto((process.env.WW_URL || "http://127.0.0.1:8099") + "/?app=rig", { waitUntil: "domcontentloaded" }); await sleep(4000);
    await pg.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
    await pg.evaluate(() => { if (!panelOpen("rig", "waterfall")) addPanel("rig", "waterfall"); }); await sleep(1500);
    for (const app of await pg.evaluate(() => Object.keys(APPS))) { await pg.evaluate(a => switchApp(a), app); await sleep(1200); }
    await pg.evaluate(() => switchApp("rig")); await sleep(2000);
    const f0 = await pg.evaluate(() => window.__flip);
    const vals = await pg.evaluate(() => new Promise(res => { const s = new Set(); const t = setInterval(() => document.querySelectorAll(".hslider span").forEach(e => s.add(e.textContent)), 100);
      setTimeout(() => { clearInterval(t); res([...s]); }, 4000); }));
    const flips = await pg.evaluate(() => window.__flip) - f0;
    const n = await pg.evaluate(() => document.querySelectorAll(".hslider").length);
    console.log(`${w}x${h} @${dpr}: JS-Fehler ${errs.length}, Regler ${n}, verschiedene Reglertexte ${vals.length}, Wechsel ${flips}`);
    if (errs.length) fails.push(`${w}x${h}: ${errs.slice(0, 3).join(" | ")}`);
    if (vals.length > n) fails.push(`${w}x${h}: Regler springen ohne Bedienung (${vals.slice(0, 6).join(" / ")})`);
    if (flips > 2) fails.push(`${w}x${h}: Anordnung/Detailstufe pendelt (${flips} Wechsel in 4 s)`);
    await pg.close();
  }
  await br.close();
  if (fails.length) { console.error("Oberflaechentest fehlgeschlagen:\n" + fails.join("\n")); process.exit(1); }
  console.log("Oberflaechentest bestanden");
})().catch(e => { console.error(e); process.exit(1); });
