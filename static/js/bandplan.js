"use strict";
// Wellenwerk – Bandplaene (Bereiche je Band mit Standard-Betriebsart und Filter) und Frequenzliste der Digimodes.
// Region 1 nach dem IARU-Region-1-Bandplan (vereinfacht auf die Nutzungsbereiche), Region 2/3 vereinfacht.
// Automatik: Wer in einen anderen Bereich oder auf eine bekannte Digi-Frequenz abstimmt, bekommt Betriebsart und Filter
// nach Bandplan. Von Hand gewaehlte Betriebsart gilt, bis der Bereich verlassen wird. Abschaltbar (Optionen → Bandplan).

// Art des Bereichs: Farbe, Name, Betriebsart (leer = Betriebsart nicht aendern)
const SEG_KIND = {
  cw: { c: "#3b82f6", n: "CW", m: "CW" }, narrow: { c: "#a855f7", n: "Schmalband / Digi", m: "PKTUSB" }, digi: { c: "#d946ef", n: "Digimodes", m: "PKTUSB" },
  ssb: { c: "#22c55e", n: "SSB", m: "" }, all: { c: "#14b8a6", n: "alle Betriebsarten", m: "" }, beacon: { c: "#facc15", n: "Baken", m: "CW" },
  fm: { c: "#f59e0b", n: "FM", m: "FM" }, rep: { c: "#fb923c", n: "FM-Relais", m: "FM" }, sat: { c: "#ef4444", n: "Satelliten", m: "" }, atv: { c: "#64748b", n: "ATV / breitbandig", m: "" },
};
const MODE_BW = { CW: 500, CWR: 500, USB: 2400, LSB: 2400, PKTUSB: 3000, PKTLSB: 3000, AM: 6000, FM: 0, RTTY: 500 };
// [von kHz, bis kHz, Art, Betriebsart (optional, sonst aus der Art; SSB unter 10 MHz LSB, darueber USB), Bezeichnung]
const BANDSEGS = {};
BANDSEGS.R1 = [
  [1810, 1838, "cw"], [1838, 1840, "narrow"], [1840, 1843, "digi"], [1843, 2000, "ssb"],
  [3500, 3570, "cw"], [3570, 3600, "narrow"], [3600, 3620, "digi"], [3620, 3800, "ssb"],
  [5351.5, 5354, "narrow"], [5354, 5366, "ssb", "USB"], [5366, 5366.5, "narrow"],
  [7000, 7040, "cw"], [7040, 7050, "narrow"], [7050, 7060, "digi"], [7060, 7200, "ssb"],
  [10100, 10130, "cw"], [10130, 10150, "narrow"],
  [14000, 14070, "cw"], [14070, 14099, "narrow"], [14099, 14101, "beacon", "", "IBP-Baken"], [14101, 14112, "digi"], [14112, 14350, "ssb"],
  [18068, 18095, "cw"], [18095, 18109, "narrow"], [18109, 18111, "beacon", "", "IBP-Baken"], [18111, 18168, "ssb"],
  [21000, 21070, "cw"], [21070, 21110, "narrow"], [21110, 21120, "digi"], [21120, 21149, "narrow"], [21149, 21151, "beacon", "", "IBP-Baken"], [21151, 21450, "ssb"],
  [24890, 24915, "cw"], [24915, 24929, "narrow"], [24929, 24931, "beacon", "", "IBP-Baken"], [24931, 24990, "ssb"],
  [28000, 28070, "cw"], [28070, 28190, "narrow"], [28190, 28225, "beacon"], [28225, 29000, "ssb"], [29000, 29100, "all", "AM"], [29100, 29200, "fm", "", "FM-Simplex"],
  [29200, 29300, "digi", "", "Digimodes / Packet"], [29300, 29510, "sat", "USB", "Satelliten-Downlink"], [29510, 29590, "rep", "", "Relais-Eingabe"], [29590, 29610, "fm", "", "FM-Anruf 29,600"], [29610, 29700, "rep", "", "Relais-Ausgabe"],
  [50000, 50100, "cw"], [50100, 50300, "ssb", "USB"], [50300, 50400, "narrow"], [50400, 50500, "beacon"], [50500, 52000, "fm"],
  [70000, 70100, "beacon"], [70100, 70250, "ssb", "USB"], [70250, 70500, "fm"],
  [144000, 144110, "cw"], [144110, 144150, "narrow"], [144150, 144400, "ssb", "USB"], [144400, 144490, "beacon"], [144500, 144794, "all", "FM", "Simplex / Digi"],
  [144794, 144990, "digi", "FM", "Digimodes / APRS"], [144990, 145194, "rep", "", "Relais-Eingabe"], [145194, 145206, "sat", "FM", "Raumfahrt"], [145206, 145594, "fm", "", "FM-Simplex"],
  [145594, 145794, "rep", "", "Relais-Ausgabe"], [145794, 145806, "sat", "FM", "Raumfahrt (ISS)"], [145806, 146000, "sat", "FM"],
  [430000, 432000, "rep", "", "Relais / Digi"], [432000, 432100, "cw"], [432100, 432400, "ssb", "USB"], [432400, 432490, "beacon"], [432500, 434000, "fm"],
  [434000, 434594, "atv", "FM"], [434594, 435000, "rep", "", "Relais-Eingabe"], [435000, 438000, "sat", "FM"], [438000, 440000, "rep", "", "Relais / DMR / D-STAR"],
  [1240000, 1296000, "atv", "FM"], [1296000, 1296150, "cw"], [1296150, 1296800, "ssb", "USB"], [1296800, 1297000, "beacon"], [1297000, 1300000, "fm"],
];
BANDSEGS.R2 = [
  [1800, 1840, "cw"], [1840, 1843, "digi"], [1843, 2000, "ssb"],
  [3500, 3570, "cw"], [3570, 3600, "narrow"], [3600, 4000, "ssb"],
  [7000, 7070, "cw"], [7070, 7125, "narrow"], [7125, 7300, "ssb"],
  [10100, 10130, "cw"], [10130, 10150, "narrow"],
  [14000, 14070, "cw"], [14070, 14112, "narrow"], [14112, 14150, "cw"], [14150, 14350, "ssb"],
  [18068, 18100, "cw"], [18100, 18110, "narrow"], [18110, 18168, "ssb"],
  [21000, 21070, "cw"], [21070, 21200, "narrow"], [21200, 21450, "ssb"],
  [24890, 24915, "cw"], [24915, 24930, "narrow"], [24930, 24990, "ssb"],
  [28000, 28070, "cw"], [28070, 28300, "narrow"], [28300, 29300, "ssb"], [29300, 29510, "sat", "USB"], [29510, 29700, "fm"],
  [50000, 50100, "cw"], [50100, 50300, "ssb", "USB"], [50300, 50400, "narrow"], [50400, 51000, "all", "USB"], [51000, 54000, "fm"],
  [144000, 144100, "cw"], [144100, 144300, "ssb", "USB"], [144300, 144500, "all", "USB"], [144500, 148000, "fm"],
  [420000, 432000, "fm"], [432000, 432100, "cw"], [432100, 433000, "ssb", "USB"], [433000, 435000, "fm"], [435000, 438000, "sat", "FM"], [438000, 450000, "rep"],
];
BANDSEGS.R3 = BANDSEGS.R1.map(s => s[0] === 7060 ? [7060, 7300, "ssb"] : s);
// Digimode-Frequenzen (Rufzeichen-/Aktivitaetszentren, Einstellfrequenz in kHz). Weitere kommen aus static/freqs.json (FT8, FT4, JS8, WSPR …)
const DIGI_EXTRA = {
  PSK31: [1838, 3580, 7040, 10142, 14070, 18100, 21070, 24920, 28120, 50290, 144138],
  RTTY: [3585, 7043, 10142, 14083, 18103, 21083, 24923, 28083],
  Olivia: [3583, 7072, 10142, 14072, 14106, 18103, 21072, 28122],
  SSTV: [[3735, "LSB"], [7165, "LSB"], [14230, "USB"], [14233, "USB"], [21340, "USB"], [28680, "USB"], [144500, "FM"], [145800, "FM", "ISS-SSTV"]],
  FreeDV: [3625, 3643, 7177, 14236, 18118, 21313, 24933, 28330],
  "CW-QRP": [[1836, "CW"], [3560, "CW"], [7030, "CW"], [10116, "CW"], [14060, "CW"], [18086, "CW"], [21060, "CW"], [24906, "CW"], [28060, "CW"]],
};
const DIGI_DM = { PSK31: "PSK31", RTTY: "RTTY", Olivia: "Olivia 8/250", "CW-QRP": "CW" };   // Betriebsart im Digitalbetrieb
let BP_FREQS = null;
async function digiFreqs() {
  if (BP_FREQS) return BP_FREQS;
  const L = {};
  try { const j = await api("/api/freqs/typical"); for (const x of j.freqs || []) { if (x.g !== "ham" || !/^(FT8|FT4|JS8|WSPR|MSK144|Olivia|FreeDV|PSK31|RTTY)$/.test(x.t)) continue;
    (L[x.t] ||= []).push({ f: x.f, m: x.m, n: x.n || "" }); } } catch { }
  for (const [k, v] of Object.entries(DIGI_EXTRA)) for (const e of v) { const [kHz, m, n] = Array.isArray(e) ? e : [e, k === "SSTV" || k === "FreeDV" ? (e < 10000 ? "LSB" : "USB") : "PKTUSB"];
    const f = Math.round(kHz * 1000); if (!(L[k] ||= []).some(x => Math.abs(x.f - f) < 500)) L[k].push({ f, m: k === "FreeDV" ? "USB" : m, n: n || "" }); }
  for (const v of Object.values(L)) v.sort((a, b) => a.f - b.f);
  return (BP_FREQS = L);
}
function planRegion() { return (PLAN_NAMES.find(x => x[0] === store.get("rc.plan", "R1-HF")) || PLAN_NAMES[0])[2]; }
// Bereich und ggf. bekannte Digi-Frequenz an hz
function planAt(hz) {
  const k = hz / 1000, segs = BANDSEGS[planRegion()] || BANDSEGS.R1, s = segs.find(x => k >= x[0] && k < x[1]);
  let spot = null;
  if (BP_FREQS) for (const [t, v] of Object.entries(BP_FREQS)) for (const e of v) if (Math.abs(e.f - hz) <= 300 && !(t === "SSTV" || t === "FreeDV" || t === "CW-QRP")) spot = { t, ...e };
  if (!s && !spot) return null;
  const kind = s ? SEG_KIND[s[2]] : null;
  let mode = spot ? spot.m : (s[3] || kind.m);
  if (!mode && s && (s[2] === "ssb" || s[2] === "all")) mode = k < 10000 ? "LSB" : "USB";
  return { key: spot ? `spot:${spot.t}:${spot.f}` : `seg:${s[0]}`, seg: s, kind, spot, mode, bw: mode ? (MODE_BW[mode] ?? 0) : null,
    label: spot ? `${spot.t}${spot.n ? " · " + spot.n : ""}` : (s[4] || kind.n) };
}
// ---------- Automatik ----------
const BPA = { key: null, override: null, sent: null, t: 0, timer: 0, lastMode: null };
function planOn() { return store.get("opts", {}).plan !== false; }
function planFollow() {
  const r = WW.rig || {}; if (!r.connected || !r.freq) return;
  const p = planAt(r.freq), key = p ? p.key : null;
  if (BPA.lastMode && r.mode !== BPA.lastMode && key === BPA.key && (!BPA.sent || r.mode !== BPA.sent.mode)) BPA.override = key;   // von Hand umgestellt: gilt bis zum Bereichswechsel
  BPA.lastMode = r.mode;
  if (key === BPA.key) return;
  BPA.key = key; BPA.override = null; const m0 = r.mode;
  clearTimeout(BPA.timer);
  BPA.timer = setTimeout(() => {                                // kurz warten: setzt der Aufrufer selbst eine Betriebsart (Bandtaste, Signalerkennung), gilt diese
    const now = WW.rig || {}; if (!planOn() || !p || !p.mode || BPA.override === key || BPA.key !== key || now.mode !== m0) return;
    if (typeof SIG !== "undefined" && SIG.run && !SIG.run.stop) return;          // Signalerkennung stellt selbst ein
    if (now.receiver && !["USB", "LSB", "CW", "AM", "FM", "PKTUSB", "PKTLSB"].includes(p.mode)) return;
    const mode = now.receiver && p.mode.startsWith("PKT") ? p.mode.slice(3) : p.mode;   // Empfaenger kennen kein PKTUSB
    if (now.mode === mode && (!p.bw || Math.abs((now.passband || 0) - p.bw) < 50)) return;
    BPA.sent = { mode, t: Date.now() }; setMode(mode, p.bw || 0);
  }, 700);
}
WW.on("rig", planFollow);
digiFreqs();
// ---------- Frequenzliste der Digimodes ----------
function tuneDigi(t, e) {
  if (!WW.current) return toast("Kein Gerät verbunden", true);
  BPA.key = `spot:${t}:${e.f}`; BPA.override = BPA.key;          // Auswahl ist ausdruecklich: nicht vom Bandplan ueberschreiben
  setFreq(e.f).then(() => setMode(e.m, MODE_BW[e.m] ?? 0));
  if (DIGI_DM[t] && typeof dmSetMode === "function") dmSetMode(DIGI_DM[t]);
  toast(`${t} · ${fmtMHz(e.f)} MHz ${e.m}`);
}
function createFreqList(root, params = {}) {
  root.innerHTML = `<div class="pane-tb fl-tabs"></div><div class="fl-body"></div>`;
  let cur = params.mode || store.get("fl.mode", "FT8");
  const draw = async () => { const L = await digiFreqs(); if (!L[cur]) cur = Object.keys(L)[0];
    $(".fl-tabs", root).innerHTML = Object.keys(L).map(t => `<button type="button" data-t="${esc(t)}" class="${t === cur ? "on" : ""}">${esc(t)}</button>`).join("");
    const f0 = WW.rig?.freq || 0;
    $(".fl-body", root).innerHTML = `<table class="grid fl-t"><thead><tr><th>Band</th><th>Frequenz</th><th>Mode</th><th>Hinweis</th></tr></thead><tbody>${L[cur].map((e, i) =>
      `<tr data-i="${i}" class="${Math.abs(e.f - f0) < 500 ? "sel" : ""}"><td>${esc(bandFor(e.f) || "")}</td><td>${fmtMHz(e.f)}</td><td>${esc(e.m)}</td><td>${esc(e.n || "")}</td></tr>`).join("")}</tbody></table>`; };
  root.addEventListener("click", async e => { const b = e.target.closest("[data-t]"); if (b) { cur = b.dataset.t; store.set("fl.mode", cur); return draw(); }
    const tr = e.target.closest("tr[data-i]"); if (tr) { const L = await digiFreqs(); tuneDigi(cur, L[cur][+tr.dataset.i]); } });
  let lastF = 0; const off = WW.on("rig", () => { const f = WW.rig?.freq || 0; if (Math.abs(f - lastF) > 400) { lastF = f; draw(); } }); draw();
  return () => off();
}
// Kurzliste als Ausklappmenue (z. B. im FreeDV-Fenster)
async function freqMenu(anchor, t) { const L = await digiFreqs(); popupMenu(anchor, (L[t] || []).map(e => ({ label: `${bandFor(e.f) || ""}  ${fmtMHz(e.f)} ${e.m}${e.n ? " · " + e.n : ""}`, act: () => tuneDigi(t, e) }))); }
