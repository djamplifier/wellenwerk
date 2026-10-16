"use strict";
// Wellenwerk – Digitalbetrieb: Wasserfall, Empfang/Senden PSK31/63/125, RTTY, CW, Makros, QSO, WWK Sweeper
const D = { ctx: null, rx: null, mode: store.get("dm.mode", "PSK31"), running: false, fft: new FFT(1024), buf: new Float32Array(1024), bufN: 0, avg: null,
  wfMin: -80, wfMax: -20, txSrc: null, txCtx: null, sweep: [], sweepOn: false, heard: new Map() };
const WF_MAX = 3000, PSK_BAUD = { PSK31: 31.25, PSK63: 62.5, PSK125: 125 };
// Betriebsarten, nach Gruppen (Grundmodi aus dsp.js, weitere aus dsp2.js)
const DM_GROUPS = (() => { const g = { PSK: ["PSK31", "PSK63", "PSK125"], RTTY: ["RTTY"], CW: ["CW"] };
  for (const [n, m] of Object.entries(DIGI_MODES)) (g[m.group] = g[m.group] || []).push(n); return g; })();
const DM_ALL = Object.values(DM_GROUPS).flat();
const dmBw = m => m === "RTTY" ? +store.get("dm.rtty.shift", 170) + 80 : PSK_BAUD[m] ? PSK_BAUD[m] * 2 : DIGI_MODES[m] ? DIGI_MODES[m].bw : 80;
const dmModeOptions = () => Object.entries(DM_GROUPS).map(([g, ms]) => `<optgroup label="${esc(g)}">${ms.map(m => `<option ${m === D.mode ? "selected" : ""}>${esc(m)}</option>`).join("")}</optgroup>`).join("");
function dmAdif(m) {   // ADIF-Modus/Submodus fuer das Logbuch
  if (PSK_BAUD[m]) return ["PSK", m]; if (m === "RTTY" || m === "CW") return [m, ""];
  if (/^QPSK/.test(m)) return ["PSK", m]; if (/^MFSK/.test(m)) return ["MFSK", m];
  if (/^DominoEX/.test(m)) return ["DOMINO", "DOM" + m.split(" ")[1]]; if (/^THOR/.test(m)) return ["THOR", ""];
  if (/^Olivia/.test(m)) return ["OLIVIA", "OLIVIA " + m.split(" ")[1]]; if (/^Contestia/.test(m)) return ["CONTESTI", ""];
  if (/^Throb/.test(m)) return ["THRB", ""]; if (/^MT63/.test(m)) return ["MT63", ""]; if (m === "Hell") return ["HELL", ""]; if (m === "SSTV") return ["SSTV", ""];
  return [m, ""];
}
function dmSetMode(m) { if (!DM_ALL.includes(m)) return; store.set("dm.logmode", ""); D.mode = m; store.set("dm.mode", m); dmMakeRx(); WW.emit("dm-char", "\n"); }
const DM_TAGS = [["MYCALL", "Rufzeichen"], ["MYNAME", "Name"], ["MYAGE", "Alter"], ["MYLOC", "Locator"], ["MYQTH", "QTH"], ["MYEMAIL", "E-Mail"], ["MYHOMEPAGE", "Homepage"], ["MYCLUBS", "Clubs"], ["MYRIG", "Funkgerät"], ["MYANT", "Antenne"], ["MYPWR", "Leistung"]];
const DM_MACROS_DEFAULT = [["CQ", "CQ CQ CQ de <MYCALL> <MYCALL> <MYCALL> pse k\n"], ["Antwort", "<CALL> <CALL> de <MYCALL> <MYCALL> <MYCALL> k\n"],
  ["Rapport", "<CALL> de <MYCALL> - tnx fer call - ur RST <RST> <RST> - name <MYNAME> <MYNAME> - qth <MYQTH> loc <MYLOC> - hw? <CALL> de <MYCALL> k\n"],
  ["Station", "<CALL> de <MYCALL> - rig <MYRIG> ant <MYANT> pwr <MYPWR> - <CALL> de <MYCALL> k\n"], ["Danke 73", "<CALL> de <MYCALL> - tnx fer QSO <NAME> - 73 es gl - <CALL> de <MYCALL> sk\n"],
  ["QRZ?", "QRZ? de <MYCALL> k\n"], ["BTU", "btu <CALL> de <MYCALL> k\n"], ["Test", "test test de <MYCALL>\n"]];
const dmTags = () => ({ MYCALL: WW.settings.callsign || "", MYLOC: WW.settings.locator || "", MYPWR: WW.settings.tx_pwr ? WW.settings.tx_pwr + " W" : "", ...store.get("dm.tags", {}) });
function dmFill(t) {
  const q = store.get("dm.qso", {}), tags = dmTags();
  const v = { CALL: q.call || "QRZ", NAME: q.name || "", RST: q.rsts || "599", QTH: q.qth || "", LOC: q.grid || "", ...tags, TIME: new Date().toISOString().slice(11, 16) + "z", DATE: new Date().toISOString().slice(0, 10) };
  return t.replace(/[<{]([A-Z]+)[>}]/g, (m, k) => v[k] !== undefined ? v[k] : m);
}

// ---------- Audio-Kette ----------
function dmMakeRx() {
  const f = D.rx ? D.rx.freq : +store.get("dm.f", 1500), out = ch => WW.emit("dm-char", ch);
  const markHigh = !/LSB|RTTYR/.test(WW.rig.mode || "USB") !== (store.get("dm.rev", "auto") === true);
  if (!DM_ALL.includes(D.mode)) D.mode = "PSK31";
  const M = DIGI_MODES[D.mode];
  D.rx = PSK_BAUD[D.mode] ? new Psk31Rx(f, out, PSK_BAUD[D.mode]) : D.mode === "RTTY" ? (store.get("dm.rev", "auto") === "auto" ? new RttyAuto(f, out, +store.get("dm.rtty.baud", 45.45), +store.get("dm.rtty.shift", 170), store.get("dm.rtty.usos", true))
      : Object.assign(new RttyRx(f, out, markHigh, +store.get("dm.rtty.baud", 45.45), +store.get("dm.rtty.shift", 170)), { usos: store.get("dm.rtty.usos", true) })) : D.mode === "CW" ? new CwRx(f, out)
    : M.image === "hell" ? M.rx(f, col => WW.emit("dm-hell", col)) : M.rx(f, out);
  D.rx.sql = store.get("dm.sql", 25) / 100; if (D.rx instanceof RttyAuto) D.rx.sqlv = D.rx.sql; if (D.rx instanceof Psk31Rx) { D.rx.afc = store.get("dm.afc", true); D.rx.freqCb = f2 => WW.emit("dm-freq", f2); }
  WW.emit("dm-freq", f); WW.emit("dm-mode");
}
async function dmStart(dev) {
  if (D.running) return dmStop();
  if (dev !== "__sdr" && !navigator.mediaDevices?.getUserMedia) {   // http ohne https: Soundkarte gesperrt – dann den Empfaenger nehmen
    if (!(WW.radios || []).some(r => r.kind === "sdr" && r.connected)) return toast("Soundkarte nur über https://…:8443 oder im Desktop-Programm – oder einen Empfänger (WebSDR/KiwiSDR) verbinden", true);
    dev = "__sdr"; store.set("dm.in", dev); $$(".dm-in").forEach(s => s.value = dev); toast("Eingang: Empfänger (Soundkarte nur über https)");
  }
  try {
    D.fromSdr = dev === "__sdr";
    if (D.fromSdr) {   // Empfaenger: PCM direkt aus dem Datenstrom – ohne Lücken durch Wiedergabe/Audiokontext (wichtig fuer RTTY-/CW-Takt)
      D.ctx = null; D.unPcm = await rxPcm(null, rxTo8k((x, peak) => dmFeed(x, peak))); D.running = true; WW.emit("dm-run"); return;
    }
    D.stream = D.fromSdr ? await rxStream() : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    try { D.ctx = new AudioContext({ sinkId: { type: "none" } }); } catch { D.ctx = new AudioContext(); }
    await D.ctx.audioWorklet.addModule("/static/digi-worklet.js");
    const src = D.ctx.createMediaStreamSource(D.stream);
    const lp1 = new BiquadFilterNode(D.ctx, { type: "lowpass", frequency: 3500 }), lp2 = new BiquadFilterNode(D.ctx, { type: "lowpass", frequency: 3500 });
    D.tap = new AudioWorkletNode(D.ctx, "ww-tap"); D.tap.port.onmessage = e => dmFeed(e.data.samples, e.data.peak);
    src.connect(lp1).connect(lp2).connect(D.tap); D.running = true; WW.emit("dm-run");
  } catch (e) { toast("Audio: " + e.message, true); }
}
function dmStop() { D.running = false; try { D.unPcm?.(); D.unPcm = null; } catch { } try { if (!D.fromSdr) D.stream?.getTracks().forEach(t => t.stop()); D.ctx?.close(); } catch { } WW.emit("dm-run"); }
async function dmFeedBuffer(samples, sr) {   // Testeinspeisung durch dieselbe Kette
  try { D.ctx = new AudioContext({ sinkId: { type: "none" } }); } catch { D.ctx = new AudioContext(); }
  await D.ctx.audioWorklet.addModule("/static/digi-worklet.js");
  const b = D.ctx.createBuffer(1, samples.length, sr); b.copyToChannel(Float32Array.from(samples), 0); const s = D.ctx.createBufferSource(); s.buffer = b;
  const lp = new BiquadFilterNode(D.ctx, { type: "lowpass", frequency: 3500 }); D.tap = new AudioWorkletNode(D.ctx, "ww-tap"); D.tap.port.onmessage = e => dmFeed(e.data.samples, e.data.peak);
  s.connect(lp).connect(D.tap); D.running = true; WW.emit("dm-run"); s.start(); return new Promise(r => s.onended = r);
}
function dmFeed(x, peak) {
  if (D.rx) D.rx.process(x);
  WW.emit("dm-pcm", x);   // Signalerkennung
  if (D.sstv) D.sstv.process(x);
  if (D.sweepOn) D.sweep.forEach(ch => ch.rx.process(x));
  WW.emit("dm-level", peak);
  for (let i = 0; i < x.length; i++) { D.buf[D.bufN++] = x[i]; if (D.bufN === 1024) { const p = D.fft.power(D.buf); D.buf.copyWithin(0, 256); D.bufN = 768;
    if (!D.avg) D.avg = Float32Array.from(p); else for (let k = 0; k < p.length; k++) D.avg[k] = 0.85 * D.avg[k] + 0.15 * p[k]; WW.emit("dm-row", p); } }
}
function dmSnap(f) {   // Signalmitte: Schwerpunkt der Leistung, mehrfach nachzentriert (PSK hat zwei Linien bei f ± Baud/2)
  if (!D.avg) return f; const bw = DFS / 1024;
  for (let it = 0; it < 4; it++) {
    const lo = Math.max(1, Math.round((f - 30) / bw)), hi = Math.round((f + 30) / bw);
    let mx = -Infinity; for (let i = lo; i <= hi; i++) mx = Math.max(mx, D.avg[i]);
    let w = 0, ws = 0; for (let i = lo; i <= hi; i++) { const v = Math.max(0, D.avg[i] - (mx - 10)); w += v; ws += v * i * bw; }
    if (!(w > 0)) break; f = ws / w;
  }
  return Math.round(f * 10) / 10;
}
function dmSetFreq(f) { f = Math.max(100, Math.min(WF_MAX - 50, f)); if (D.rx) D.rx.freq = f; store.set("dm.f", f); WW.emit("dm-freq", f); }

// ---------- Senden ----------
async function dmTx(text) {
  if (D.txSrc) return toast("Es wird bereits gesendet", true);
  text = dmFill(text); if (!text.trim()) return;
  if (!WW.settings.callsign) return toast("Erst eigenes Rufzeichen eintragen (Optionen)", true);
  if (D.mode === "CW") { if (await act("/api/rig/morse", { text })) WW.emit("dm-echo", text); return; }
  const f = D.rx ? D.rx.freq : 1500, markHigh = !/LSB|RTTYR/.test(WW.rig.mode || "USB") !== (store.get("dm.rev", "auto") === true);
  D.txCtx = D.txCtx || new AudioContext();
  const sr = D.txCtx.sampleRate, data = PSK_BAUD[D.mode] ? psk31Tx(text, f, sr, PSK_BAUD[D.mode]) : D.mode === "RTTY" ? rttyTx(text, f, sr, markHigh, +store.get("dm.rtty.baud", 45.45), +store.get("dm.rtty.shift", 170)) : DIGI_MODES[D.mode].tx(text, f, sr);
  const done = dmPlay(data); WW.emit("dm-echo", text); await done;
}
// Audio ueber die gewaehlte Soundkarte ausgeben, PTT davor an und danach aus (auch fuer SSTV)
async function dmPlay(data) {
  if (D.txSrc) return toast("Es wird bereits gesendet", true);
  D.txCtx = D.txCtx || new AudioContext(); try { await D.txCtx.resume(); } catch { }
  const sink = store.get("dm.out", ""); if (sink && D.txCtx.setSinkId) { try { await D.txCtx.setSinkId(sink); } catch (e) { toast("Ausgabe: " + e.message, true); } }
  const sr = D.txCtx.sampleRate, buf = D.txCtx.createBuffer(1, data.length, sr); buf.copyToChannel(data, 0);
  const g = D.txCtx.createGain(); g.gain.value = store.get("dm.txlvl", 50) / 100;
  D.txSrc = D.txCtx.createBufferSource(); D.txSrc.buffer = buf; D.txSrc.connect(g).connect(D.txCtx.destination);
  await post("/api/rig/ptt", { on: true }).catch(e => toast("PTT: " + e.message, true));
  WW.emit("dm-tx", true); await new Promise(r => setTimeout(r, 120));
  return new Promise(res => { D.txSrc.onended = () => { D.txSrc = null; setTimeout(() => post("/api/rig/ptt", { on: false }).catch(() => { }), 80); WW.emit("dm-tx", false); res(); };
    D.txSrc.start(); });
}
function dmTxStop() {   // Senden abbrechen; PTT geht in jedem Fall aus (auch wenn die Wiedergabe kein Ende meldet)
  const src = D.txSrc; if (src) { try { src.stop(); } catch { } }
  setTimeout(() => { if (D.txSrc === src && src) { const end = src.onended; D.txSrc = null; if (end) end(); else WW.emit("dm-tx", false); } if (!src || !D.txSrc) post("/api/rig/ptt", { on: false }).catch(() => { }); }, 300);
}
function dmTune() {
  if (D.txSrc) return; D.txCtx = D.txCtx || new AudioContext(); const sr = D.txCtx.sampleRate, f = D.rx ? D.rx.freq : 1500, d = new Float32Array(sr * 4);
  for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(TAU * f * i / sr);
  const b = D.txCtx.createBuffer(1, d.length, sr); b.copyToChannel(d, 0); const g = D.txCtx.createGain(); g.gain.value = store.get("dm.txlvl", 50) / 100;
  D.txSrc = D.txCtx.createBufferSource(); D.txSrc.buffer = b; D.txSrc.connect(g).connect(D.txCtx.destination);
  post("/api/rig/ptt", { on: true }).then(() => { WW.emit("dm-tx", true); D.txSrc.onended = () => { D.txSrc = null; post("/api/rig/ptt", { on: false }); WW.emit("dm-tx", false); }; D.txSrc.start(); }).catch(e => { D.txSrc = null; toast(e.message, true); });
}

// ---------- Bereiche ----------
async function audioDevices(kind) { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind); } catch { return []; } }
function createWaterfall(root) {
  root.innerHTML = `<div class="pane-tb dm-tb"><select class="dm-mode">${dmModeOptions()}</select>
    <button class="dm-run">▶ Empfang</button><label class="chk">Eingang <select class="dm-in"><option value="">Standard</option><option value="__sdr" ${store.get("dm.in", "") === "__sdr" || !navigator.mediaDevices?.getUserMedia ? "selected" : ""}>Empfänger (WebSDR/KiwiSDR)</option></select></label><span class="lvl dm-lvl"><i></i></span>
    <b class="dm-f">1500 Hz</b><span class="hint dm-wpm"></span><label class="chk dm-afcw"><input type="checkbox" class="dm-afc" ${store.get("dm.afc", true) ? "checked" : ""}> AFC</label>
    <label class="chk dm-revw"><select class="dm-rev" title="Lage von Mark/Space">${[["false", "normal"], ["true", "umgekehrt"], ["auto", "Lage automatisch"]].map(([v, l]) => `<option value="${v}" ${String(store.get("dm.rev", "auto")) === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label class="chk" title="Nach Leerzeichen auf Buchstaben zurückschalten (im Amateurfunk üblich, beim Wetterdienst aus)"><input type="checkbox" class="dm-usos" ${store.get("dm.rtty.usos", true) ? "checked" : ""}> USOS</label>
      <select class="dm-baud" title="Baudrate">${[45.45, 50, 75, 100].map(b => `<option ${b === +store.get("dm.rtty.baud", 45.45) ? "selected" : ""}>${b}</option>`).join("")}</select> Bd
      <select class="dm-shift" title="Shift">${[170, 200, 425, 450, 850].map(b => `<option ${b === +store.get("dm.rtty.shift", 170) ? "selected" : ""}>${b}</option>`).join("")}</select> Hz</label>
    <label class="chk">Squelch <input type="range" class="dm-sql" min="0" max="90" value="${store.get("dm.sql", 25)}" style="width:80px"></label></div>
    <div class="dm-wfwrap"><canvas class="dm-wf"></canvas><div class="dm-mk"></div><div class="dm-scale"></div></div>`;
  const cv = $(".dm-wf", root), ctx = cv.getContext("2d");
  const fit = () => { cv.width = cv.clientWidth || 800; cv.height = cv.clientHeight || 120; marker(); };
  const marker = () => { const W = cv.clientWidth; if (!D.rx || !W) return; const bw = dmBw(D.mode);
    const mk = $(".dm-mk", root); mk.style.left = ((D.rx.freq - bw / 2) / WF_MAX * W) + "px"; mk.style.width = Math.max(3, bw / WF_MAX * W) + "px"; };
  $(".dm-scale", root).innerHTML = Array.from({ length: WF_MAX / 250 + 1 }, (_, i) => i * 250).map(f => `<span style="left:${f / WF_MAX * 100}%">${f % 500 === 0 ? f : "·"}</span>`).join("");
  audioDevices("audioinput").then(ds => { $(".dm-in", root).innerHTML += ds.filter(d => d.deviceId !== "__sdr").map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === store.get("dm.in", "") ? "selected" : ""}>${esc(d.label || d.deviceId.slice(0, 8))}</option>`).join(""); });
  cv.addEventListener("click", e => { const r = cv.getBoundingClientRect(), f = Math.round(dmSnap((e.clientX - r.left) / r.width * WF_MAX)); dmSetFreq(f); if (!e.altKey) sigOnDmClick((e.clientX - r.left) / r.width * WF_MAX, e); });
  root.addEventListener("change", e => { const t = e.target;
    if (t.classList.contains("dm-mode")) dmSetMode(t.value);
    if (t.classList.contains("dm-in")) { store.set("dm.in", t.value); if (D.running) { dmStop(); dmStart(t.value); } }
    if (t.classList.contains("dm-baud") || t.classList.contains("dm-shift")) { store.set(t.classList.contains("dm-baud") ? "dm.rtty.baud" : "dm.rtty.shift", +t.value); dmMakeRx(); }
    if (t.classList.contains("dm-afc")) { store.set("dm.afc", t.checked); if (D.rx) D.rx.afc = t.checked; }
    if (t.classList.contains("dm-rev")) { store.set("dm.rev", t.value === "auto" ? "auto" : t.value === "true"); dmMakeRx(); }
    if (t.classList.contains("dm-usos")) { store.set("dm.rtty.usos", t.checked); dmMakeRx(); } });
  $(".dm-sql", root).addEventListener("input", e => { store.set("dm.sql", +e.target.value); if (D.rx) D.rx.sql = +e.target.value / 100; });
  $(".dm-run", root).onclick = () => dmStart($(".dm-in", root).value);
  const row = p => { const W = cv.width, H = cv.height, bins = Math.floor(WF_MAX / (DFS / 1024)); ctx.drawImage(cv, 0, 0, W, H - 1, 0, 1, W, H - 1);
    const im = ctx.createImageData(W, 1); let lo = Infinity, hi = -Infinity; for (let i = 2; i < bins; i++) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    D.wfMin = 0.97 * D.wfMin + 0.03 * (lo + 6); D.wfMax = 0.97 * D.wfMax + 0.03 * Math.max(hi, D.wfMin + 25);
    for (let x = 0; x < W; x++) { const v = Math.max(0, Math.min(1, (p[Math.floor(x / W * bins)] - D.wfMin) / (D.wfMax - D.wfMin)));
      const [r, g, b] = v < 0.33 ? [0, v * 3 * 120, 60 + v * 3 * 140] : v < 0.66 ? [(v - 0.33) * 3 * 255, 120 + (v - 0.33) * 3 * 135, 200 - (v - 0.33) * 3 * 200] : [255, 255, (v - 0.66) * 3 * 255];
      im.data.set([r, g, b, 255], x * 4); }
    ctx.putImageData(im, 0, 0); };
  const ui = () => { $(".dm-run", root).textContent = D.running ? "■ Empfang aus" : "▶ Empfang"; $(".dm-run", root).classList.toggle("on", D.running);
    $(".dm-afcw", root).classList.toggle("hidden", !(D.rx instanceof Psk31Rx)); $(".dm-revw", root).classList.toggle("hidden", D.mode !== "RTTY"); $(".dm-mode", root).value = D.mode; marker(); };
  const ro = new ResizeObserver(fit); ro.observe(root);
  const offs = [WW.on("dm-row", row), WW.on("dm-freq", f => { $(".dm-f", root).textContent = Math.round(f) + " Hz"; marker(); }), WW.on("dm-run", ui), WW.on("dm-mode", ui),
    WW.on("dm-level", pk => { const i = $(".dm-lvl i", root); i.style.width = Math.min(100, pk * 100) + "%"; i.style.background = pk > 0.9 ? "var(--bad)" : "var(--ok)"; if (D.mode === "CW" && D.rx) $(".dm-wpm", root).textContent = D.rx.wpm + " WpM"; })];
  if (!D.rx) dmMakeRx(); ui(); fit(); return () => { ro.disconnect(); offs.forEach(f => f()); };
}
function createDmRx(root) {
  root.innerHTML = `<div class="pane-tb"><button class="dm-clr">Leeren</button><span class="hint">Klick auf ein Wort: als Rufzeichen, Name, QTH, Locator oder RST in den QSO-Bereich übernehmen.</span></div><canvas class="dm-hell hidden" title="Hellschreiber: das Auge liest – Text erscheint doppelt untereinander"></canvas><div class="dm-rx" translate="no"></div>`;
  const el = $(".dm-rx", root), hc = $(".dm-hell", root);
  // Hellschreiber: Spalten laufen von rechts nach links, jede Spalte doppelt untereinander (gleicht Zeitversatz aus)
  let hx = 0; const hell = col => { if (hc.classList.contains("hidden")) return; const W = hc.width = hc.clientWidth || 600, s = 3, H = hc.height = 2 * col.length * s + 8;
    if (!hc._img || hc._img.width !== W) { hc._img = document.createElement("canvas"); hc._img.width = W; hc._img.height = H; const g0 = hc._img.getContext("2d"); g0.fillStyle = "#fff"; g0.fillRect(0, 0, W, H); }
    const g = hc._img.getContext("2d"); g.drawImage(hc._img, -s, 0); g.fillStyle = "#fff"; g.fillRect(W - s, 0, s, H);
    for (let r = 0; r < col.length; r++) { const v = Math.round(255 * (1 - col[r])); g.fillStyle = `rgb(${v},${v},${v})`; for (const o of [0, col.length]) g.fillRect(W - s, H - 4 - (o + r + 1) * s, s, s); }
    hc.getContext("2d").drawImage(hc._img, 0, 0); hx++; };
  const hellVis = () => hc.classList.toggle("hidden", !(DIGI_MODES[D.mode] && DIGI_MODES[D.mode].image === "hell"));
  const add = ch => { if (ch === "\n") el.appendChild(document.createElement("br")); else { let l = el.lastChild; if (!l || l.nodeType !== 3) { l = document.createTextNode(""); el.appendChild(l); } l.data += ch; }
    if (el.textContent.length > 30000) el.textContent = el.textContent.slice(-20000); el.scrollTop = el.scrollHeight; };
  const echo = t => { const s = document.createElement("span"); s.className = "txecho"; s.textContent = t; el.appendChild(s); el.scrollTop = el.scrollHeight; };
  $(".dm-clr", root).onclick = () => el.textContent = "";
  el.addEventListener("click", e => { const sel = getSelection(); if (!sel?.anchorNode || sel.anchorNode.nodeType !== 3) return;
    const t = sel.anchorNode.data, i = sel.anchorOffset; let a = i, b = i; while (a > 0 && /[A-Z0-9/\-+]/i.test(t[a - 1])) a--; while (b < t.length && /[A-Z0-9/\-+]/i.test(t[b])) b++;
    const w = t.slice(a, b).trim(); if (!w) return;
    const isCall = /^([A-Z0-9]{1,3}\/)?[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]{1,4})?$/i.test(w);
    popupMenu({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY + 4, top: e.clientY }) }, [
      ...(isCall ? [{ label: `Rufzeichen: ${w.toUpperCase()}`, act: () => dmQsoSet({ call: w.toUpperCase() }) }] : []),
      { label: `Name: ${w}`, act: () => dmQsoSet({ name: w[0].toUpperCase() + w.slice(1).toLowerCase() }) }, { label: `QTH: ${w}`, act: () => dmQsoSet({ qth: w }) },
      ...(/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(w) ? [{ label: `Locator: ${w}`, act: () => dmQsoSet({ grid: w }) }] : []),
      ...(/^[1-5][1-9][1-9]?$/.test(w) ? [{ label: `RST empfangen: ${w}`, act: () => dmQsoSet({ rstr: w }) }] : [])]); });
  const offs = [WW.on("dm-char", add), WW.on("dm-echo", echo), WW.on("dm-hell", hell), WW.on("dm-mode", hellVis)]; hellVis(); return () => offs.forEach(f => f());
}
function createDmTx(root) {
  root.innerHTML = `<div class="dm-txwrap"><div class="dm-txbar hidden">● SENDEN</div><textarea class="dm-tx" placeholder="Text zum Senden … (Strg+Enter = senden)"></textarea>
    <div class="pane-tb"><button class="primary dm-send">TX Senden</button><button class="danger dm-stop">RX Stopp</button><button class="dm-tune" title="4 s Dauerton">Tune</button>
    <label class="chk">Ausgang <select class="dm-out"><option value="">Standard</option></select></label><label class="chk">Pegel <input type="range" class="dm-lvlout" min="5" max="100" value="${store.get("dm.txlvl", 50)}" style="width:90px"></label></div></div>`;
  audioDevices("audiooutput").then(ds => { $(".dm-out", root).innerHTML += ds.map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === store.get("dm.out", "") ? "selected" : ""}>${esc(d.label || d.deviceId.slice(0, 8))}</option>`).join(""); });
  const tx = $(".dm-tx", root);
  $(".dm-send", root).onclick = () => { const t = tx.value; if (t.trim()) { dmTx(t.endsWith("\n") ? t : t + "\n"); tx.value = ""; } };
  tx.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $(".dm-send", root).click(); } });
  $(".dm-stop", root).onclick = dmTxStop; $(".dm-tune", root).onclick = dmTune;
  $(".dm-out", root).onchange = e => store.set("dm.out", e.target.value); $(".dm-lvlout", root).oninput = e => store.set("dm.txlvl", +e.target.value);
  const off = WW.on("dm-tx", on => $(".dm-txbar", root).classList.toggle("hidden", !on)); return off;
}
function createDmMacros(root) {
  const draw = () => { const ms = store.get("dm.macros", DM_MACROS_DEFAULT);
    root.innerHTML = `<div class="dm-mac">${ms.map(([l, t], i) => `<button data-i="${i}" title="${esc(t)}">F${i + 1} ${esc(l)}</button>`).join("")}</div><div class="pane-tb"><button class="dm-med">Bearbeiten …</button><span class="hint">Platzhalter: &lt;CALL&gt; &lt;NAME&gt; &lt;RST&gt; &lt;MYCALL&gt; &lt;MYNAME&gt; &lt;MYQTH&gt; &lt;MYLOC&gt; …</span></div>`; };
  root.addEventListener("click", e => { const b = e.target.closest("[data-i]"); if (b) dmTx(store.get("dm.macros", DM_MACROS_DEFAULT)[+b.dataset.i][1]); if (e.target.closest(".dm-med")) dmMacroEditor(draw); });
  const key = e => { if (SHELL.active !== "dm" || !/^F([1-9]|1[0-2])$/.test(e.key) || e.key === "F8" || e.key === "F11") return; const ms = store.get("dm.macros", DM_MACROS_DEFAULT), i = +e.key.slice(1) - 1; if (ms[i]) { e.preventDefault(); dmTx(ms[i][1]); } };
  document.addEventListener("keydown", key); draw(); return () => document.removeEventListener("keydown", key);
}
function dmMacroEditor(cb) {
  const ms = store.get("dm.macros", DM_MACROS_DEFAULT);
  const d = dialog({ title: "Makros (Digitalbetrieb)", wide: true, buttons: [["Abbrechen", "close"], ["Standard", "def"], ["Speichern", "ok", "primary"]], body: `<table class="mini dm-medt">${ms.map(([l, t], i) => `<tr><td>F${i + 1}</td><td><input value="${esc(l)}" style="width:100px"></td><td><textarea rows="2" style="width:100%">${esc(t)}</textarea></td><td><button type="button" data-del="${i}">×</button></td></tr>`).join("")}</table><button type="button" class="dm-add">+ Makro</button>` });
  const tb = $(".dm-medt", d);
  $(".dm-add", d).onclick = () => tb.insertAdjacentHTML("beforeend", `<tr><td>F${tb.rows.length + 1}</td><td><input style="width:100px"></td><td><textarea rows="2" style="width:100%"></textarea></td><td></td></tr>`);
  tb.onclick = e => { const b = e.target.closest("[data-del]"); if (b) b.closest("tr").remove(); };
  d.querySelector('[value="def"]').onclick = e => { e.preventDefault(); store.set("dm.macros", DM_MACROS_DEFAULT); d.close(); cb(); };
  d.querySelector('[value="ok"]').onclick = e => { e.preventDefault(); store.set("dm.macros", [...tb.rows].map(r => [r.querySelector("input").value, r.querySelector("textarea").value]).filter(m => m[0] || m[1]).slice(0, 12)); d.close(); cb(); };
}
function dmQsoSet(o) { const q = { ...store.get("dm.qso", {}), ...o }; store.set("dm.qso", q); WW.emit("dm-qso", q); }
function createDmQso(root) {
  root.innerHTML = `<form class="dm-qso" autocomplete="off"><div class="grid2"><label>Rufzeichen<input name="call"></label><label>Name<input name="name"></label><label>QTH<input name="qth"></label><label>Locator<input name="grid"></label>
    <label>RST gesendet<input name="rsts"></label><label>RST empfangen<input name="rstr"></label><label class="wide">Bemerkung<input name="comment"></label></div><div class="dm-qinfo hint"></div>
    <div class="ctl-row"><button type="submit" class="primary">Loggen</button><button type="button" class="dm-qclr">Neu</button><button type="button" class="dm-qlk">Nachschlagen</button></div></form>`;
  const form = $("form", root);
  const fill = q => { for (const el of form.elements) if (el.name) el.value = q[el.name] || (el.name.startsWith("rst") ? (D.mode === "SSTV" ? "595" : "599") : ""); info(q.call); };
  const info = async c => { if (!c || c.length < 3) { $(".dm-qinfo", root).textContent = ""; return; } try { const r = await api(`/api/lookup/${encodeURIComponent(c)}?${logq()}`); $(".dm-qinfo", root).textContent = `${r.country || "?"} · ${r.km != null ? r.km.toLocaleString(I18N.locale) + " km · " + r.bearing + "°" : ""}${r.worked.call_count ? " · " + r.worked.call_count + "× gearbeitet" : ""}${r.dxcc && !r.worked.dxcc_worked ? " · NEUES LAND" : ""}`;
    if (r.lat != null) D.heard.set(c, { lat: r.lat, lon: r.lon, country: r.country, t: Date.now() }); WW.emit("dm-heard"); } catch { } };
  form.addEventListener("input", e => { const q = store.get("dm.qso", {}); q[e.target.name] = e.target.name === "call" ? e.target.value.toUpperCase() : e.target.value; if (e.target.name === "call") e.target.value = q.call; store.set("dm.qso", q); if (e.target.name === "call") { clearTimeout(form._t); form._t = setTimeout(() => info(q.call), 300); } });
  form.addEventListener("submit", async e => { e.preventDefault(); const q = store.get("dm.qso", {}); if (!q.call) return toast("Rufzeichen fehlt", true);
    const [mode, submode] = dmAdif(store.get("dm.logmode", "") || D.mode), rec = { call: q.call, name: q.name, qth: q.qth, gridsquare: q.grid, rst_sent: q.rsts, rst_rcvd: q.rstr, comment: q.comment, mode, submode,
      freq: WW.rig.freq ? fmtMHz(WW.rig.freq + (D.rx ? D.rx.freq : 0) * (/LSB/.test(WW.rig.mode) ? -1 : 1)) : "" };
    try { const r = await post("/api/qso?" + logq(), rec); toast(`${r.call} geloggt (${mode})`); store.set("dm.qso", {}); fill({}); } catch (err) { toast(err.message, true); } });
  $(".dm-qclr", root).onclick = () => { store.set("dm.qso", {}); fill({}); };
  $(".dm-qlk", root).onclick = () => { const c = store.get("dm.qso", {}).call; if (c) { switchApp("log"); WW.emit("dx", { call: c }); } };
  const off = WW.on("dm-qso", fill); fill(store.get("dm.qso", {})); return off;
}
function createDmTags(root) {
  const t = dmTags();
  root.innerHTML = `<div class="dm-tags"><b>Über mich</b><table class="mini">${DM_TAGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td><input data-k="${k}" value="${esc(t[k] || "")}" ${k === "MYCALL" || k === "MYLOC" ? 'title="aus den Programmoptionen"' : ""}></td><td class="hint">&lt;${k}&gt;</td></tr>`).join("")}</table></div>`;
  root.addEventListener("input", e => { const k = e.target.dataset.k; if (!k) return; const s = store.get("dm.tags", {}); s[k] = e.target.value; store.set("dm.tags", s); });
}
function createSweeper(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk"><input type="checkbox" class="sw-on"> WWK Sweeper an</label><select class="sw-mode">${["PSK31", "RTTY", "CW"].map(m => `<option ${m === store.get("sw.mode", "PSK31") ? "selected" : ""}>${m}</option>`).join("")}</select><span class="hint">Dekodiert bis zu 16 Signale gleichzeitig (BPSK, RTTY oder CW). Klick auf eine Zeile übernimmt das Signal in den Haupt-Dekoder.</span></div><div class="tablewrap"><table class="grid sw-t"><tbody></tbody></table></div>`;
  let scanT;
  const rescan = () => { if (!D.avg) return; const bw = DFS / 1024, p = D.avg, med = [...p.slice(30, 384)].sort((a, b) => a - b)[180]; const peaks = [];
    for (let i = 30; i < 384; i++) if (p[i] > med + 10 && p[i] >= p[i - 1] && p[i] >= p[i + 1]) peaks.push(i * bw);
    const fs = []; peaks.forEach(f => { if (!fs.some(x => Math.abs(x - f) < 40)) fs.push(dmSnap(f)); });
    D.sweep = D.sweep.filter(ch => fs.some(f => Math.abs(f - ch.f) < 25));
    const sm = store.get("sw.mode", "PSK31"), sh = +store.get("dm.rtty.shift", 170), sep = sm === "RTTY" ? sh * 0.7 : 25, cf = f => sm === "RTTY" ? f - sh / 2 : f;   // RTTY: Mitte zwischen Mark/Space
    fs.slice(0, 16).forEach(f => { f = cf(f); if (!D.sweep.some(ch => Math.abs(ch.f - f) < sep)) { const ch = { f, text: "", mode: sm }; const on = c => { ch.text = (ch.text + c).slice(-120); };
      ch.rx = sm === "RTTY" ? new RttyRx(f, on, true, +store.get("dm.rtty.baud", 45.45), sh) : sm === "CW" ? new CwRx(f, on) : new Psk31Rx(f, on); ch.rx.sql = 0.3; D.sweep.push(ch); } });
    draw(); };
  const draw = () => { $(".sw-t tbody", root).innerHTML = D.sweep.sort((a, b) => a.f - b.f).map(ch => `<tr data-f="${ch.rx.freq}"><td class="nowrap"><b>${Math.round(ch.rx.freq)} Hz</b></td><td class="mono" translate="no">${esc(ch.text.replace(/\n/g, " "))}</td></tr>`).join("") || '<tr><td class="hint">noch keine Signale erkannt</td></tr>'; };
  $(".sw-mode", root).onchange = e => { store.set("sw.mode", e.target.value); D.sweep = []; if (D.sweepOn) rescan(); else draw(); };
  $(".sw-on", root).onchange = e => { D.sweepOn = e.target.checked; clearInterval(scanT); if (D.sweepOn) { rescan(); scanT = setInterval(() => { rescan(); }, 3000); } else { D.sweep = []; draw(); } };
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-f]"); if (tr) { const sm = store.get("sw.mode", "PSK31"); if (D.mode !== sm) dmSetMode(sm); dmSetFreq(+tr.dataset.f); } });
  const t = setInterval(() => { if (D.sweepOn) draw(); }, 1000); return () => { clearInterval(t); clearInterval(scanT); };
}
function createDmMap(root) {
  root.innerHTML = `<div style="height:100%" class="dm-map"></div>`;
  const m = L.map($(".dm-map", root), { worldCopyJump: true, attributionControl: false, minZoom: 1 }).setView([30, 10], 1);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 8 }).addTo(m); const g = L.layerGroup().addTo(m), grey = L.layerGroup().addTo(m);
  const draw = () => { g.clearLayers(); grey.clearLayers(); L.polygon(nightPolygon(), { stroke: false, fillColor: "#001030", fillOpacity: .25, interactive: false }).addTo(grey);
    if (WW.home) L.circleMarker(WW.home, { radius: 5, color: "#fff", fillColor: "#f5a524", fillOpacity: 1, weight: 2 }).addTo(g);
    D.heard.forEach((v, c) => { L.circleMarker([v.lat, v.lon], { radius: 5, color: "#d62828", fillOpacity: .8, weight: 1 }).bindTooltip(`${c} · ${v.country}`).addTo(g); if (WW.home) L.polyline([WW.home, [v.lat, v.lon]], { color: "#d62828", weight: 1, opacity: .5 }).addTo(g); }); };
  const ro = new ResizeObserver(() => m.invalidateSize()); ro.observe(root); const off = WW.on("dm-heard", draw); draw(); return () => { ro.disconnect(); off(); m.remove(); };
}

// ---------- Programm Digitalbetrieb ----------
APPS.dm = {
  title: "Digitalbetrieb", icon: "i-wave",
  panels: {
    waterfall: { title: "Wasserfall", create: createWaterfall }, rx: { title: "Empfang", create: createDmRx }, tx: { title: "Senden", create: createDmTx },
    macros: { title: "Makros", create: createDmMacros }, qso: { title: "QSO", create: createDmQso }, tags: { title: "Über mich", create: createDmTags },
    radio: { title: "Funkgerät", create: createRadioPane }, sweeper: { title: "WWK Sweeper", create: createSweeper }, worldmap: { title: "Weltkarte", create: createDmMap },
    sstv: { title: "SSTV", create: createSstv, dock: { ref: "rx", dir: "within" } }, sstvgal: { title: "SSTV-Bilder", create: createSstvGallery, dock: { ref: ["sweeper", "rx"], dir: "within" } },
  },
  layout(dv) {
    const q = dv.addPanel({ id: "qso", component: "qso", title: "QSO" });
    dv.addPanel({ id: "tags", component: "tags", title: "Über mich", position: { referencePanel: "qso", direction: "within" } });
    dv.addPanel({ id: "radio", component: "radio", title: "Funkgerät", position: { referencePanel: "qso", direction: "within" } }); q.api.setActive();
    const rx = dv.addPanel({ id: "rx", component: "rx", title: "Empfang", position: { referencePanel: "qso", direction: "right" } });
    dv.addPanel({ id: "sweeper", component: "sweeper", title: "WWK Sweeper", position: { referencePanel: "rx", direction: "within" } });
    dv.addPanel({ id: "worldmap", component: "worldmap", title: "Weltkarte", position: { referencePanel: "rx", direction: "within" } }); rx.api.setActive();
    const wf = dv.addPanel({ id: "waterfall", component: "waterfall", title: "Wasserfall", position: { referencePanel: "rx", direction: "above" } });
    dv.addPanel({ id: "tx", component: "tx", title: "Senden", position: { referencePanel: "rx", direction: "below" } });
    dv.addPanel({ id: "macros", component: "macros", title: "Makros", position: { referencePanel: "tx", direction: "right" } });
    setTimeout(() => { try { q.group.api.setSize({ width: 300 }); wf.group.api.setSize({ height: 210 }); dv.getPanel("tx").group.api.setSize({ height: 170 }); dv.getPanel("macros").group.api.setSize({ width: 330 }); } catch { } }, 60);
  },
  menus: [
    { label: "Datei", items: [{ label: "Programmoptionen …", key: "F8", act: () => openOptions() }] },
    { label: "Bearbeiten", items: [{ label: "Makros bearbeiten …", act: () => dmMacroEditor(() => WW.emit("dm-macros")) }] },
    { label: "Ansicht", items: Object.entries({ waterfall: "Wasserfall", rx: "Empfang", tx: "Senden", macros: "Makros", qso: "QSO", tags: "Über mich", radio: "Funkgerät", sweeper: "WWK Sweeper", worldmap: "Weltkarte", sstv: "SSTV", sstvgal: "SSTV-Bilder", freedv: "FreeDV (digitale Sprache)" }).map(([k, l]) => ({ label: l, check: () => panelOpen("dm", k), act: () => togglePanel("dm", k) })) },
    { label: "QSO", items: [{ label: "Loggen", act: () => $(".dm-qso button[type=submit]")?.click() }, { label: "Neues QSO", act: () => { store.set("dm.qso", {}); WW.emit("dm-qso", {}); } }] },
    { label: "Betriebsart", items: Object.entries(DM_GROUPS).flatMap(([g, ms], i) => [...(i ? ["-"] : []), g, ...ms.map(m => ({ label: m, check: () => D.mode === m, act: () => dmSetMode(m) }))]) },
    { label: "SSTV", items: [{ label: "SSTV-Fenster", act: () => addPanel("dm", "sstv") }, { label: "Bild senden …", act: () => sstvSendDialog() }, { label: "Empfangene Bilder", act: () => addPanel("dm", "sstvgal") }] },
    { label: "Logbuch", items: [{ label: "Logbuch öffnen", act: () => switchApp("log") }] },
    MENU_WINDOW("dm"), MENU_HELP,
  ],
  toolbar: [
    { label: "QSO", icon: "i-edit", act: () => addPanel("dm", "qso") }, { label: "WWK Sweeper", icon: "i-scan", act: () => addPanel("dm", "sweeper") }, { label: "SSTV", icon: "i-cam", act: () => addPanel("dm", "sstv") },
    { label: "Funkgerät", icon: "i-radio", act: () => addPanel("dm", "radio") }, { label: "Soundkarte", icon: "i-mic", act: () => dmStart(store.get("dm.in", "")), on: () => D.running },
    { label: "Wasserfall", icon: "i-wave", act: () => addPanel("dm", "waterfall") }, "|", { label: "Gerätesteuerung", icon: "i-radio", act: () => switchApp("rig") }, { label: "Logbuch", icon: "i-book", act: () => switchApp("log") },
    { label: "Rotor", icon: "i-compass", act: () => switchApp("rot") }, { label: "Optionen", icon: "i-gear", act: () => openOptions() }, { label: "Vollbild", icon: "i-full", act: fullScreen }, "->",
    { html: `<div class="ribbon-box rb-clk"></div>`, init: el => setInterval(() => el.firstChild.textContent = new Date().toISOString().slice(11, 19), 1000) },
  ],
};
