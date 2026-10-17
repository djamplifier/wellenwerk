"use strict";
// Wellenwerk – Grundfunktionen: Zustand, Ereignisse, Server-Zugriff, Live-Verbindung, Hilfsfunktionen
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const WW = {
  rig: {}, caps: {}, radios: [], current: null, settings: {}, spots: [], rotor: {}, wsjtx: {}, cluster: {}, home: null,
  bands: [], version: "", logbook: "Mein Logbuch", logbooks: [], decodes: [], clusterInfo: {},
  _ev: {},
  on(ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); return () => this._ev[ev] = this._ev[ev].filter(f => f !== fn); },
  emit(ev, data) { (this._ev[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(ev, e); } }); },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("ww." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ww." + k, JSON.stringify(v)); } catch { } },
};

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.body = JSON.stringify(o.body); o.headers = { "Content-Type": "application/json" }; }
  const r = await fetch(path, o);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error((d && d.detail) || r.statusText || "Fehler");
  return d;
}
const post = (path, body) => api(path, { method: "POST", body: body || {} });
async function act(path, body) { try { await post(path, body); return true; } catch (e) { toast(e.message, true); return false; } }
const logq = (extra = "") => `log=${encodeURIComponent(WW.logbook)}${extra ? "&" + extra : ""}`;

// ---------- Fehlerprotokoll: Skriptfehler und Fehlermeldungen an den Dienst melden (Optionen → Fehler & Updates) ----------
const reportError = (() => {
  const seen = new Map();
  return (message, detail = "", where = "", level = "error") => {
    message = String(message || "").slice(0, 2000); if (!message) return;
    const k = level + message + where, n = Date.now(); if (seen.get(k) > n - 30000) return; seen.set(k, n);
    if (seen.size > 500) seen.clear();
    where = [where, window.SHELL && SHELL.active ? "Programm " + SHELL.active : ""].filter(Boolean).join(" · ");
    fetch("/api/errors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "ui", message, detail: String(detail || "").slice(0, 20000), where, level }) }).catch(() => { });
  };
})();
window.addEventListener("error", e => { if (e.message && !/^Script error\.?$/.test(e.message)) reportError(e.message, e.error && e.error.stack || "", `${(e.filename || "").replace(location.origin, "")}:${e.lineno}:${e.colno}`); });
window.addEventListener("unhandledrejection", e => { const r = e.reason; if (r && r.name === "AbortError") return; reportError(r && r.message || String(r), r && r.stack || "", "Promise"); });

function toast(msg, bad = false) {
  if (bad) reportError(msg, "", "Meldung", "meldung");
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.className = "", bad ? 5000 : 2200);
}
const _scripts = {};
function loadScript(src) {   // jede Bibliothek nur einmal laden; gleichzeitige Aufrufe warten auf dasselbe Laden
  return _scripts[src] = _scripts[src] || new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = src; sc.onload = ok; sc.onerror = () => { delete _scripts[src]; bad(new Error("Laden fehlgeschlagen: " + src)); }; document.head.appendChild(sc); });
}

// Wasserfall: langsame Quellen (z. B. OpenWebRX mit 5 Zeilen/s) laufen sonst kaum sichtbar – jede Zeile dann mehrfach
// zeichnen, so dass der Wasserfall gleichmaessig etwa 25 Pixel je Sekunde weiterlaeuft.
function wfRows(key) {
  const now = performance.now(), t = wfRows.t[key]; wfRows.t[key] = now; if (!t) return 1;
  const dt = Math.min(1000, now - t), e = wfRows.e[key] = (wfRows.e[key] || dt) * 0.8 + dt * 0.2;
  return Math.max(1, Math.min(8, Math.round(e * 0.025)));
}
wfRows.t = {}; wfRows.e = {};
// Gleichmaessig laufender Wasserfall: Zeilen kommen stossweise (KiwiSDR, OpenWebRX, Netz). Angezeigt wird mit fester
// Geschwindigkeit (px/s), leicht verzoegert und zwischen zwei Zeilen ueberblendet. levels(row, W) liefert 0..255 je Pixel.
function wfScroller(canvas, levels, opts = {}) {
  const S = { q: [], iv: 100, tl: 0, last: 0, D: 400, acc: 0, prev: 0, raf: 0, lut: null, pps: opts.pps || 25, idle: 0 };
  const g = canvas.getContext("2d");
  S.push = row => { const now = performance.now();
    if (S.last) S.iv = S.iv * 0.9 + Math.min(1500, Math.max(10, now - S.last)) * 0.1; S.last = now;
    S.tl = S.tl && Math.abs(now - S.tl - S.iv) < 2000 ? S.tl + S.iv + (now - S.tl - S.iv) * 0.05 : now;   // gleichmaessige Zeitachse
    S.q.push({ t: S.tl, row }); while (S.q.length > 64) S.q.shift();
    if (!S.raf) { S.prev = performance.now(); S.raf = requestAnimationFrame(frame); } };
  S.clear = () => { S.q = []; S.tl = 0; };
  const sample = (t, W) => { const q = S.q; let b = q.findIndex(r => r.t >= t);
    if (b < 0) { S.D = Math.min(3000, S.D + 40); b = q.length - 1; }                                     // zu wenig Vorlauf: Verzoegerung erhoehen
    else S.D = Math.max(S.iv * 1.5 + 60, S.D - 0.3);
    const B = q[b], A = q[Math.max(0, b - 1)], la = lv(A, W), lb = lv(B, W); if (A === B || B.t <= A.t) return lb;
    const k = Math.max(0, Math.min(1, (t - A.t) / (B.t - A.t))), out = new Uint8Array(W); for (let x = 0; x < W; x++) out[x] = la[x] + (lb[x] - la[x]) * k; return out; };
  const lv = (r, W) => { if (!r.lv || r.W !== W || r.v !== S.ver) { r.lv = levels(r.row, W); r.W = W; r.v = S.ver; } return r.lv; };
  S.ver = 0; S.invalidate = () => S.ver++;
  function frame(now) {
    S.raf = 0; if (!canvas.isConnected) return;
    const dt = Math.min(250, now - S.prev); S.prev = now;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (W && H && (canvas.width !== W || canvas.height !== H)) { canvas.width = W; canvas.height = H; }
    if (W && H) opts.before?.(g, W, H);
    if (W && H && S.q.length && S.lut) {
      S.acc += dt * S.pps / 1000; let n = Math.floor(S.acc); S.acc -= n; n = Math.min(n, H);
      if (n > 0) { g.drawImage(canvas, 0, 0, W, H - n, 0, n, W, H - n); const img = g.createImageData(W, n), d = img.data, lut = S.lut;
        for (let y = 0; y < n; y++) { const L = sample(now - S.D - (y * 1000 / S.pps), W), o = y * W * 4;     // oberste Zeile = neueste
          for (let x = 0; x < W; x++) { const k = L[x] * 4, j = o + x * 4; d[j] = lut[k]; d[j + 1] = lut[k + 1]; d[j + 2] = lut[k + 2]; d[j + 3] = 255; } }
        g.putImageData(img, 0, 0); opts.after?.(g, W, H, n); }
      while (S.q.length > 2 && S.q[1].t < now - S.D - 1000) S.q.shift();
    }
    if (now - S.last < 4000) S.raf = requestAnimationFrame(frame);                                           // ohne Daten anhalten
  }
  return S;
}
// Automatischer Pegel fuer Wasserfall-Zeilen: Rauschboden (20 %) bis Spitzen (99,5 %), geglaettet; liefert [unten, oben]
function wfAutoLevel(state, data) { const s = Array.from(data).sort((a, b) => a - b), lo = s[Math.floor(s.length * 0.2)], hi = Math.max(s[Math.floor(s.length * 0.995)], lo + 25);
  state.L = state.L ? [state.L[0] * 0.9 + lo * 0.1, state.L[1] * 0.9 + hi * 0.1] : [lo, hi]; return state.L; }
// Wasserfall um k Zeilen nach unten schieben und die neue Zeile (RGBA, Breite W) k-mal oben eintragen
function wfPush(g, W, H, row, k) {
  k = Math.max(1, Math.min(k, H)); g.drawImage(g.canvas, 0, 0, W, H - k, 0, k, W, H - k);
  const img = g.createImageData(W, k); for (let y = 0; y < k; y++) img.data.set(row, y * W * 4); g.putImageData(img, 0, 0);
}

// ---------- Abstimmraster: sinnvolle Schritte je Band und Betriebsart (Kanalraster, Rundfunkraster) ----------
// Rueckgabe [Schritt Hz, Versatz Hz, Name]; Frequenzen liegen auf Versatz + n * Schritt
const SW_BC = [[2300, 2495], [3200, 3400], [3900, 4000], [4750, 5060], [5900, 6200], [7200, 7450], [9400, 9900], [11600, 12100], [13570, 13870], [15100, 15800], [17480, 17900], [18900, 19020], [21450, 21850], [25670, 26100]];
function rasterAuto(f, mode) {
  const k = (f || 0) / 1000, m = (mode || "").toUpperCase(), r2 = /^R2/.test(store.get("rc.plan", "R1-HF")), in_ = (a, b) => k >= a && k <= b;
  if (/^(AM|SAM)/.test(m)) {
    if (in_(148.5, 283.5)) return [9000, 0, "Langwelle"];
    if (r2 ? in_(530, 1700) : in_(526.5, 1606.5)) return r2 ? [10000, 0, "Mittelwelle"] : [9000, 0, "Mittelwelle"];
    if (SW_BC.some(([a, b]) => in_(a, b))) return [5000, 0, "Kurzwellen-Rundfunk"];
    if (in_(108000, 137000)) return [25000 / 3, 0, "Flugfunk 8,33 kHz"];
    return [1000, 0, ""];
  }
  if (in_(26965, 27405)) return [10000, 5000, "CB-Funk"];
  if (/FM/.test(m)) {
    if (in_(28000, 29700) || in_(50000, 54000)) return [10000, 0, "FM-Kanäle"];
    if (in_(87500, 108000)) return [50000, 0, "UKW-Rundfunk"];
    if (in_(144000, 148000) || in_(149000, 149200) || in_(156000, 163000) || in_(1240000, 1300000)) return [12500, 0, "Kanalraster"];
    if (in_(430000, 440000) || in_(446000, 446200)) return [6250, 0, "Kanalraster"];
    return k > 30000 ? [12500, 0, "Kanalraster"] : [5000, 0, ""];
  }
  if (/^(USB|LSB)$/.test(m)) return [100, 0, "SSB"];
  return [10, 0, ""];
}
const RASTER_STEPS = [10, 100, 500, 1000, 5000, 6250, 25000 / 3, 9000, 10000, 12500, 25000, 50000, 100000];
function tuneRaster(f, mode) {
  const o = store.get("tune.step", "auto");
  if (o !== "auto" && +o > 0) return { step: +o, base: 0, auto: false, label: "" };
  const [step, base, label] = rasterAuto(f ?? WW.rig.freq, mode ?? WW.rig.mode); return { step, base, label, auto: true };
}
function snapRaster(f, mode) { const r = tuneRaster(f, mode); return r.step <= 1 ? Math.round(f) : Math.round(Math.round((f - r.base) / r.step) * r.step + r.base); }
const fmtStep = s => s >= 1000 ? (s / 1000).toLocaleString(I18N.locale, { maximumFractionDigits: 2 }) + " kHz" : Math.round(s) + " Hz";

// ---------- Formatierung ----------
const bandFor = hz => (WW.bands.find(b => hz >= b.lo && hz <= b.hi) || {}).name || "";
const fmtMHz = hz => (hz / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const fmtDots = hz => String(Math.round(hz || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fmtDate = d => d ? `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}` : "";
const fmtTime = t => t ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : "";
const fmtTimeS = t => t ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${(t + "00").slice(4, 6)}` : "";
const yes = v => ["Y", "V"].includes((v || "").toUpperCase());
function sText(db) { if (db == null) return ""; if (db <= 0) return "S" + Math.max(0, Math.round(9 + db / 6)); return "S9+" + Math.round(db / 10) * 10; }
function parseFreqInput(v) {
  const x = parseFloat(String(v).replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  if (!x) return 0; if (x < 1000) return x * 1e6; if (x < 1e6) return x * 1e3; return x;
}
const BAND_COLORS = { "160m": "#7f5af0", "80m": "#2cb1bc", "60m": "#94a3b8", "40m": "#3fb950", "30m": "#a3e635", "20m": "#f5a524", "17m": "#fb923c", "15m": "#f85149", "12m": "#ec4899", "10m": "#d946ef", "6m": "#58a6ff", "4m": "#22d3ee", "2m": "#38bdf8", "70cm": "#64748b", "23cm": "#475569" };
const CW_END = { "160m": 1838, "80m": 3570, "40m": 7040, "30m": 10150, "20m": 14070, "17m": 18095, "15m": 21070, "12m": 24915, "10m": 28070, "6m": 50100, "2m": 144150, "70cm": 432100 };
const FT8 = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 144174];
const FT4 = [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318];
function guessMode(hz, comment) {
  const c = (comment || "").toUpperCase(), khz = hz / 1000, band = bandFor(hz);
  if (/\bFT8\b/.test(c) || FT8.some(f => Math.abs(khz - f) <= 3)) return ["PKTUSB", "FT8"];
  if (/\bFT4\b/.test(c) || FT4.some(f => Math.abs(khz - f) <= 2)) return ["PKTUSB", "FT4"];
  if (/\bRTTY\b/.test(c)) return ["RTTY", "RTTY"];
  if (/\bCW\b|WPM/.test(c) || (CW_END[band] && khz < CW_END[band])) return ["CW", "CW"];
  if (/\bFM\b/.test(c)) return ["FM", "FM"];
  return [hz >= 10e6 ? "USB" : "LSB", "SSB"];
}
function modeGroup(m) { m = (m || "").toUpperCase(); if (m === "CW") return "CW"; if (["SSB", "USB", "LSB", "AM", "FM"].includes(m)) return "Phone"; return m ? "Digital" : ""; }

// ---------- Sonne / Peilung ----------
function sunPos(d = new Date()) {
  const rad = Math.PI / 180, n = d.getTime() / 864e5 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / rad;
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  return { lat: decl / rad, lon: ((ra - gmst * 15) % 360 + 540) % 360 - 180 };
}
function nightPolygon() {
  const sun = sunPos(), rad = Math.PI / 180, pts = [], dec = sun.lat === 0 ? 0.01 : sun.lat;
  for (let lon = -180; lon <= 180; lon += 2) pts.push([Math.atan(-Math.cos((lon - sun.lon) * rad) / Math.tan(dec * rad)) / rad, lon]);
  const pole = dec > 0 ? -85 : 85;
  return [...pts, [pole, 180], [pole, -180]];
}
function bearingTo(lat, lon) {
  if (!WW.home) return null;
  const rad = Math.PI / 180, [la1, lo1, la2, lo2] = [WW.home[0] * rad, WW.home[1] * rad, lat * rad, lon * rad];
  const y = Math.sin(lo2 - lo1) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  const km = 6371 * 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  return { az: (Math.atan2(y, x) / rad + 360) % 360, km };
}

// ---------- Funkgeraet: gemeinsame Befehle ----------
async function setFreq(hz) {
  hz = Math.round(hz); if (!(hz > 0)) return;
  WW.rig.freq = hz; WW._fpend = { hz, t: Date.now() }; WW.emit("rig-local", WW.rig);   // lokal sofort; aeltere Meldungen kurz ignorieren
  await act("/api/rig/freq", { hz });
  const b = bandFor(hz); if (b) { const m = store.get("bandmem", {}); m[b] = { f: hz, m: WW.rig.mode }; store.set("bandmem", m); }
}
const setMode = (mode, passband = 0) => act("/api/rig/mode", { mode, passband });
async function tuneSpot(hz, call, cmt) {
  const [rigMode, logMode] = guessMode(hz, cmt);
  await setFreq(hz); if (WW.rig.connected && rigMode !== WW.rig.mode) await setMode(rigMode);
  WW.emit("prefill", { call, mode: logMode, freq: hz });
}
async function rotorSet(az, el) {
  if (!WW.rotor?.enabled) return toast("Rotor ist nicht verbunden (Rotor → Verbinden)", true);
  az = ((Math.round(az) % 360) + 360) % 360;
  if (await act("/api/rotor/set", el != null ? { az, el } : { az })) toast(`Rotor dreht auf ${az}°`);
}

// ---------- Live-Verbindung ----------
function connectWs() {
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case "rig":
        // Nur das aktuelle Geraet zeigen. Meldet der Dienst ein anderes als aktuell, ist unsere Liste veraltet: neu laden statt
        // beide Geraete abwechselnd anzuzeigen (Regler und Betriebsart sprangen sonst hin und her)
        if (m.current && m.radio && m.radio !== WW.current) { if (!WW._lrp) { WW._lrp = true; loadRadios().finally(() => { WW._lrp = false; }); } }
        else if (m.radio === WW.current || (m.current && !m.radio)) {
          const modelChanged = m.rig.connected && capsKey(m.radio, m.rig) !== WW.capsModel;   // anderes Geraet oder Modell: Faehigkeiten neu laden
          // Waehrend schnellen Abstimmens (Mausrad, Tasten) keine noch nicht aktualisierte Geraetefrequenz uebernehmen
          const p = WW._fpend; if (p && Date.now() - p.t < 1500 && m.rig.connected && m.rig.freq !== p.hz) m.rig = { ...m.rig, freq: p.hz };
          WW.rig = m.rig; if (modelChanged) loadCaps(); WW.emit("rig", WW.rig);
        }
        { const r = (WW.radios || []).find(x => x.id === m.radio); if (r) r.state = m.rig; }   // Zustand aller Geraete aktuell halten
        WW.emit("rig-any", m); break;
      case "radios": loadRadios(); break;
      case "spot": WW.spots.unshift(m.spot); if (WW.spots.length > 300) WW.spots.pop(); WW.emit("spot", m.spot); break;
      case "cluster": WW.cluster = m.cluster; WW.emit("cluster", m.cluster); break;
      case "cluster_line": if (m.key) { WW.clusterInfo[m.key] = m.line; WW.emit("cluster-info", WW.clusterInfo); } WW.emit("cluster-line", m.line); break;
      case "wsjtx": WW.wsjtx = m.wsjtx; WW.emit("wsjtx", m.wsjtx); break;
      case "decode": WW.decodes.unshift(m.decode); if (WW.decodes.length > 500) WW.decodes.pop(); WW.emit("decode", m.decode); break;
      case "winlink": WW.emit("winlink", m); break;
      case "station_identity": WW.station = m.station; if (m.station.lat != null) WW.home = [m.station.lat, m.station.lon]; WW.emit("station", m.station); break;
      case "hello": WW.wsId = m.id; WW.audioStation = { available: m.audio_station, name: m.audio_station_name }; WW.emit("audio-station"); break;
      case "audio_station": WW.audioStation = m; WW.emit("audio-station"); break;
      case "rtc": WW.emit("rtc", m); break;
      case "rtc_gone": WW.emit("rtc-gone", m.id); break;
      case "rotor": WW.rotor = m.rotor; WW.emit("rotor", m.rotor); break;
      case "winkey": WW.winkey = m.winkey; WW.emit("winkey", m.winkey); break;
      case "stations": if (window.PRG) PRG.stations = m.stations; WW.emit("stations", m.stations); break;
      case "spectrum": WW.emit("spectrum", m); break;
      case "decode": WW.emit("decode", m.decode); break;
      case "favorites": WW.emit("favorites"); break;
      case "notice": toast(m.text, m.bad); break;
      case "update": WW.update = m.update; WW.emit("update", m.update); break;
      case "logbooks": loadLogbooks(); break;
      case "qso": if (m.source !== "manual") toast(`${m.qso.call} von ${m.source} übernommen`); WW.emit("qso", m.qso); break;
      case "qso_changed": case "qso_deleted": case "reload": WW.emit("reload"); break;
      default: if (m.type) WW.emit(m.type, m);     // z. B. eigene Meldungen von Erweiterungen
    }
  };
  ws.onopen = () => { WW.ws = ws; refreshState(); WW.emit("ws-open"); };
  ws.onclose = () => { WW.emit("offline"); setTimeout(connectWs, 2000); };
}
// Faehigkeiten gehoeren zu Geraet + Modell (SDR-Empfaenger melden kein Modell – daher auch die Geraete-ID)
const capsKey = (id, st) => `${id || ""}|${st?.model || st?.sdr?.kind || ""}`;
async function loadCaps() {
  const key = capsKey(WW.current, WW.rig); WW.capsModel = key;
  let c; try { c = await api("/api/rig/caps"); } catch { c = {}; }
  if (WW.capsModel !== key) return;                     // inzwischen anderes Geraet: dessen Abfrage gilt
  WW.caps = c; WW.emit("caps", WW.caps);
}
async function loadRadios() {
  const r = await api("/api/radios"); const changed = r.current !== WW.current; WW.radios = r.radios; WW.current = r.current;
  const cur = r.radios.find(x => x.id === r.current);       // Zustand des (neuen) aktuellen Geraets sofort uebernehmen
  if (changed && cur?.state) { WW.rig = { ...cur.state, band: bandFor(cur.state.freq) }; WW.emit("rig", WW.rig); }
  if (changed) loadCaps();
  WW.emit("radios", r);
}
async function loadLogbooks() {
  const r = await api("/api/logbooks"); WW.logbooks = r.logbooks;
  if (!r.logbooks.some(l => l.name === WW.logbook)) WW.logbook = r.current;
  WW.emit("logbooks", r);
}
async function refreshState() {
  const st = await api("/api/state");
  Object.assign(WW, { settings: st.settings, station: st.station || {}, home: st.home, rotor: st.rotor, winkey: st.winkey || {}, cluster: st.cluster, wsjtx: st.wsjtx, bands: st.bands, version: st.version });
  WW.devReports = !!st.developers;
  WW.emit("version", st.version);
  if (!I18N.chosen()) {   // dieser Browser hat noch keine Sprache gewaehlt: Sprache der Station; bestehende Installationen bleiben deutsch
    const want = st.settings.lang || (st.settings.callsign ? "de" : I18N.lang);
    let again = false; try { again = sessionStorage.getItem("ww.langReload") === want; sessionStorage.setItem("ww.langReload", want); } catch { }
    if (want !== I18N.lang && I18N.languages[want] && !again) I18N.set(want, true, true);   // hoechstens einmal neu laden
  }
  WW.rig = st.rig;
  await loadRadios();
  if (st.rig.connected && capsKey(WW.current, st.rig) !== WW.capsModel) await loadCaps();
  WW.spots = await api("/api/spots");
  try { WW.decodes = await api("/api/decodes"); const ci = await api("/api/cluster/info"); WW.clusterInfo = ci.info; } catch { }
  WW.emit("state"); WW.emit("rig", WW.rig); WW.emit("rotor", WW.rotor); WW.emit("cluster", WW.cluster); WW.emit("spots"); WW.emit("cluster-info", WW.clusterInfo);
}

// Vergroesserung der Oberflaeche (CSS-Zoom am <html>): Mauskoordinaten und Fenstergroesse fuer position: fixed umrechnen
const uiZ = () => +document.documentElement.style.zoom || 1;
// ---------- Rechtsklick-Menues ----------
// items: { label, act, icon?, check?: bool|fn, disabled?: bool, sub?: items } | "-" (Trennlinie) | "Text" (Ueberschrift)
function ctxMenu(e, items) {
  e.preventDefault(); e.stopPropagation(); ctxClose();
  const Z = uiZ(), VW = innerWidth / Z, VH = innerHeight / Z;
  const build = (list, x, y, level, leftEdge = 0) => {
    const m = document.createElement("div"); m.className = "ctxmenu"; m.dataset.level = level;
    list.forEach((it, i) => {
      if (it === "-") { m.appendChild(document.createElement("hr")); return; }
      if (typeof it === "string") { const d = document.createElement("div"); d.className = "label"; d.textContent = it; m.appendChild(d); return; }
      if (!it) return;
      const b = document.createElement("button"); b.type = "button"; const chk = typeof it.check === "function" ? it.check() : it.check;
      b.innerHTML = `<span class="ck">${chk ? "✓" : ""}</span>${it.icon ? icon(it.icon) : '<span class="ic"></span>'}<span class="lb">${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}${it.sub ? '<span class="arr">▸</span>' : ""}`;
      if (it.disabled) b.disabled = true;
      b.addEventListener("mouseenter", () => { $$(`.ctxmenu`).forEach(x => { if (+x.dataset.level > level) x.remove(); });
        if (it.sub && !it.disabled) { const r = b.getBoundingClientRect(); build(it.sub, r.right / Z - 2, r.top / Z - 4, level + 1, r.left / Z); } });
      b.addEventListener("click", ev => { ev.stopPropagation(); if (it.sub || it.disabled) return; ctxClose(); try { const r = it.act && it.act(); if (r && r.catch) r.catch(err => toast(err.message, true)); } catch (err) { toast(err.message, true); } });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const w = m.offsetWidth, hgt = m.offsetHeight;
    m.style.left = Math.max(4, x + w > VW - 4 ? (level ? leftEdge - w + 2 : VW - w - 4) : x) + "px";
    m.style.top = Math.max(4, Math.min(y, VH - hgt - 4)) + "px";
    return m;
  };
  build(items, e.clientX / Z, e.clientY / Z, 0);
}
function ctxClose() { $$(".ctxmenu").forEach(m => m.remove()); }
document.addEventListener("mousedown", e => { if (!e.target.closest(".ctxmenu")) ctxClose(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") ctxClose(); });
window.addEventListener("blur", ctxClose);
// Zwischenablage-Helfer fuer Menues
async function clipCopy(t) { try { await navigator.clipboard.writeText(String(t)); toast("In die Zwischenablage kopiert"); } catch { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); toast("In die Zwischenablage kopiert"); } }
async function clipRead() { try { return await navigator.clipboard.readText(); } catch { toast("Zwischenablage nicht lesbar (Berechtigung)", true); return ""; } }
// Verteiler: Bereiche melden ctxRegister(selector, (element, event) => items) an; das innerste passende Element gewinnt.
const CTX_REG = [];
function ctxRegister(sel, fn) { CTX_REG.push([sel, fn]); }
document.addEventListener("contextmenu", e => {
  if (e.defaultPrevented) return;
  let best = null;
  for (const [sel, fn] of CTX_REG) { const el = e.target.closest(sel); if (el && (!best || best[0].contains(el))) best = [el, fn]; }
  if (best) { const items = best[1](best[0], e); if (items && items.length) return ctxMenu(e, items); }
  // Standard: Eingabefelder bekommen Bearbeiten-Befehle, sonst kein Browser-Menue (eigenes Programm)
  const inp = e.target.closest("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, [contenteditable=true]");
  if (inp) {
    const sel = inp.value !== undefined ? inp.value.slice(inp.selectionStart || 0, inp.selectionEnd || 0) : getSelection().toString(), ro = inp.readOnly || inp.disabled;
    return ctxMenu(e, [
      { label: "Ausschneiden", icon: "i-cut", disabled: ro || !sel, act: () => { clipCopy(sel); inp.setRangeText(""); inp.dispatchEvent(new Event("input", { bubbles: true })); } },
      { label: "Kopieren", icon: "i-copy", disabled: !sel, act: () => clipCopy(sel) },
      { label: "Einfügen", icon: "i-paste", disabled: ro, act: async () => { const t = await clipRead(); if (!t) return; inp.focus(); inp.setRangeText(t, inp.selectionStart, inp.selectionEnd, "end"); inp.dispatchEvent(new Event("input", { bubbles: true })); } },
      "-", { label: "Alles markieren", act: () => { inp.focus(); inp.select(); } }, { label: "Leeren", disabled: ro, act: () => { inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); } }]);
  }
  const sel = getSelection().toString();
  if (sel) return ctxMenu(e, [{ label: "Kopieren", icon: "i-copy", act: () => clipCopy(sel) }, { label: "Als Rufzeichen nachschlagen", disabled: !/^[A-Z0-9/]{3,}$/i.test(sel.trim()), act: () => { switchApp("log"); WW.emit("dx", { call: sel.trim().toUpperCase() }); } }]);
  e.preventDefault();
});
// Leaflet-Karten fuer Rechtsklick-Menues am Element merken
if (window.L && L.map) { const _lmap = L.map; L.map = (...a) => { const m = _lmap(...a); m.getContainer()._wwmap = m; return m; }; }

// Hinweiston (Alarme, Bandgrenzen): ein gemeinsamer Audio-Kontext, der wiederverwendet wird
let _beepCtx = null;
function beep(freq, sec = 0.2, vol = 0.12) {
  try { _beepCtx = _beepCtx || new AudioContext(); if (_beepCtx.state === "suspended") _beepCtx.resume().catch(() => { });
    const c = _beepCtx, o = c.createOscillator(), g = c.createGain(); o.frequency.value = freq; g.gain.value = vol; o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + sec); o.onended = () => { o.disconnect(); g.disconnect(); };
  } catch { }
}

// Betriebsarten mit RST-Vorgabe (Programmoptionen -> Betriebsarten); eine Zeile je Mode: "MODE RST"
const MODE_RST_DEFAULT = "SSB 59\nCW 599\nFT8 -10\nFT4 -10\nRTTY 599\nPSK31 599\nFM 59\nAM 59\nJS8 -10\nJT65 -10\nJT9 -10\nQ65 -10\nSSTV 595\nOLIVIA 599\nMFSK 599\nDIGITALVOICE 59";
function modeTable() {
  const t = {};
  for (const line of String((WW.settings && WW.settings.mode_rst) || MODE_RST_DEFAULT).split(/\r?\n/)) {
    const [m, r] = line.trim().split(/\s+/); if (m) t[m.toUpperCase()] = r || "";
  }
  return t;
}
function rstFor(mode) { const t = modeTable(), m = (mode || "").toUpperCase(); return m in t ? t[m] : (["CW", "RTTY", "PSK31"].includes(m) ? "599" : "59"); }
function wsSend(m) { if (WW.ws && WW.ws.readyState === 1) WW.ws.send(JSON.stringify(m)); }

// ---------- Anpassung an die Bildschirmgroesse ----------
// Inhalt eines Fensters verkleinern (CSS-Zoom), wenn er nicht hineinpasst – statt Scrollbalken (z. B. Geraeteanzeige auf dem Laptop)
// shrink: Bereiche, die selbst scrollen und dafuer schrumpfen duerfen (werden beim Messen auf shrinkPx begrenzt)
// Detailstufe eines Fensters nach seinem Platz (s/m/l in el.dataset.det): grosse Fenster zeigen mehr, kleine weniger – statt alles zu vergroessern
function detailTier(box, el, test, cb) {
  let init = true;
  const run = () => { const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; const d = test(w, h);
    if (el.dataset.det !== d) { el.dataset.det = d; if (!init && cb) cb(d); } };
  const ro = new ResizeObserver(run); run(); init = false; ro.observe(box);
  return () => ro.disconnect();
}
function fitZoom(box, el, min = 0.6, shrink = "", shrinkPx = 90) {
  let raf = 0, self = false;
  const run = () => { raf = 0; if (!box.isConnected) return; self = true; el.style.zoom = "";
    const sh = shrink ? [...el.querySelectorAll(shrink)] : []; sh.forEach(x => { x.style.maxHeight = shrinkPx + "px"; });
    const need = box.scrollHeight, have = box.clientHeight, needW = box.scrollWidth, haveW = box.clientWidth;
    sh.forEach(x => { x.style.maxHeight = ""; });
    const z = need && have && needW && haveW ? Math.max(min, Math.min(1, have / need, haveW / needW)) : 1;
    el.style.zoom = z < 0.99 ? z.toFixed(3) : ""; el.classList.toggle("zoomed", z < 0.99);
    const size = `${box.clientWidth}x${box.clientHeight}`; requestAnimationFrame(() => { self = false; if (size !== `${box.clientWidth}x${box.clientHeight}`) later(); }); };
  const later = () => { if (!self && !raf) raf = requestAnimationFrame(run); };
  const ro = new ResizeObserver(later); ro.observe(box); ro.observe(el); [...el.children].forEach(c => ro.observe(c));   // Inhalt waechst nachtraeglich
  const off = WW.on("caps", later); later();
  return () => { ro.disconnect(); off?.(); };
}
// Leisten mit beschrifteten Knoepfen: passt die Leiste nicht in eine Zeile, nur Symbole zeigen (Beschriftung als Tooltip)
function fitBar(bar) {
  const run = () => { if (!bar.isConnected) return; bar.querySelectorAll("button").forEach(b => { const s = b.querySelector(":scope > span"); if (s && !b.title) b.title = s.textContent; });
    bar.classList.remove("tb-icons"); const bs = [...bar.querySelectorAll(":scope > button")];
    const wraps = bs.length > 1 && bs[bs.length - 1].offsetTop > bs[0].offsetTop + 4;
    if (wraps || bar.scrollWidth > bar.clientWidth + 2) bar.classList.add("tb-icons"); };
  let raf = 0; const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; run(); }); }); ro.observe(bar); run();
  bar._fitRun = run; return () => ro.disconnect();
}
// Groesse der Oberflaeche: nur noch manuell (Programmoptionen). Grosse Bildschirme bekommen mehr Details und Fenster statt groesserer Schrift.
function wwScale() {
  let v = (store.get("opts", {}) || {}).uiscale || "1";
  if (v === "auto") v = 1;
  return Math.max(0.5, Math.min(3, +v || 1));
}
// Bildschirmklasse: s = Laptop/klein, m = Full HD, l = 2560 und groesser. Jede Klasse hat eigene Fensteranordnungen.
function wwScreen(w, h) { return w < 1366 || h < 720 ? "s" : w >= 2200 && h >= 1100 ? "l" : "m"; }
function wwFit() {
  const de = document.documentElement, sc = wwScale();
  de.style.zoom = sc !== 1 ? String(sc) : "";
  const h = innerHeight / sc, w = innerWidth / sc, cls = wwScreen(w, h), prev = de.dataset.screen;
  de.classList.toggle("ww-compact", h < 900 || w < 1280);
  de.classList.toggle("ww-tight", h < 700);
  de.classList.toggle("ww-wide", cls === "l");
  de.dataset.screen = cls;
  if (prev && prev !== cls) { clearTimeout(wwFit.t); wwFit.t = setTimeout(() => { if (typeof screenChanged === "function") screenChanged(de.dataset.screen); }, 700); }
}
addEventListener("resize", () => { cancelAnimationFrame(wwFit.r); wwFit.r = requestAnimationFrame(wwFit); });
wwFit();
