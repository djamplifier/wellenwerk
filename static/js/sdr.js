"use strict";
// Wellenwerk – Empfaenger (KiwiSDR, OpenWebRX, SDR-Hardware): Ton im Browser, Auswahl aus oeffentlichen Listen,
// Fenster „Empfaenger“ fuer Haupt- und Zweitempfaenger.
const RX = { players: new Map() };
const isSdr = r => r && r.kind === "sdr";
async function rxPlay(id) {
  if (RX.players.has(id)) return RX.players.get(id);
  const P = { id, mute: store.get("rx.mute." + id, false), level: 0, pcm: new Set() };
  RX.players.set(id, P);
  P.ctx = new AudioContext();
  P.node = P.ctx.createGain(); P.push = pcmScheduler(P.ctx, P.node);
  P.gain = P.ctx.createGain(); P.dest = P.ctx.createMediaStreamDestination(); P.an = P.ctx.createAnalyser(); P.an.fftSize = 1024;
  P.node.connect(P.gain).connect(P.ctx.destination); P.node.connect(P.dest); P.node.connect(P.an);
  rxGain(id);
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const open = () => { P.ws = new WebSocket(`${proto}${location.host}/ws/audio?radio=${encodeURIComponent(id)}`); P.ws.binaryType = "arraybuffer";
    P.ws.onmessage = e => { const dv = new DataView(e.data), rate = dv.getUint32(0, true), s = new Int16Array(e.data, 4), f = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
      P.pcm.forEach(fn => { try { fn(f, rate); } catch (err) { console.error(err); } });   // Dekoder bekommen den Ton direkt, ohne Umweg ueber die Wiedergabe
      P.push(f, rate); };
    P.ws.onclose = () => { if (RX.players.get(id) === P) setTimeout(open, 2000); }; };
  open();
  if (P.ctx.state !== "running") ["pointerdown", "keydown"].forEach(ev => document.addEventListener(ev, () => P.ctx.resume(), { once: true }));
  WW.emit("rx"); return P;
}
// Wiedergabe: Bloecke auf die Abtastrate der Soundkarte umrechnen (lueckenlos ueber Blockgrenzen) und mit Vorlauf
// im Audio-Thread einplanen. Laeuft ohne AudioWorklet (also auch ueber http) und stockt nicht, wenn die Oberflaeche
// gerade beschaeftigt ist. Der Vorlauf waechst nach einem Aussetzer (0,5 s … 2 s); laeuft der Empfaenger etwas
// schneller als die Soundkarte, wird minimal schneller abgespielt statt Bloecke zu verwerfen.
// Zwei Tiefpaesse hinter der Umrechnung entfernen die Spiegelfrequenzen der linearen Interpolation (klingt sonst rau).
function pcmScheduler(ctx, dest) {
  let next = 0, lead = 0.5, ph = 0, last = 0, okSince = 0, rin = 0;
  const lp = [0, 1].map(() => new BiquadFilterNode(ctx, { type: "lowpass", Q: 0.6 })); lp[0].connect(lp[1]).connect(dest);
  const push = (f, rate) => {
    const R = ctx.sampleRate, now = ctx.currentTime;
    st.blocks++; if (st.t && now - st.t > st.maxGap) st.maxGap = now - st.t; st.t = now;
    if (rate !== rin) { rin = rate; lp.forEach(x => x.frequency.value = Math.min(rate, R) * 0.45); }
    if (ctx.state !== "running") { next = 0; return; }
    if (next < now + 0.02) { if (next) { lead = Math.min(2, lead + 0.2); st.underruns++; } next = now + lead; okSince = now; }
    else if (now - okSince > 60 && lead > 0.5) { lead = Math.max(0.5, lead - 0.05); okSince = now; }   // lange stabil: Vorlauf wieder verkleinern
    st.lead = lead; const ahead = next - now;
    if (ahead > lead + 1.5) return;                                           // weit voraus (z. B. nach Pause): Block auslassen
    const adj = Math.max(-0.01, Math.min(0.01, (ahead - lead) * 0.02));
    const step = rate / R * (1 + adj), len = f.length, o = new Float32Array(Math.ceil((len - ph) / step) + 1);
    let p = ph, k = 0;
    for (; p < len - 1; p += step) { const i = Math.floor(p), a = i < 0 ? last : f[i], b = f[i + 1]; o[k++] = a + (b - a) * (p - i); }
    ph = p - len; last = f[len - 1];
    if (!k) return;
    const buf = ctx.createBuffer(1, k, R); buf.copyToChannel(o.subarray(0, k), 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(lp[0]); src.start(next); next += k / R;
  };
  const st = push.stats = { blocks: 0, underruns: 0, maxGap: 0, lead, t: 0 };   // fuer Fehlersuche
  return push;
}
function rxStop(id) { const P = RX.players.get(id); if (!P) return; RX.players.delete(id); try { P.ws.onclose = null; P.ws.close(); P.ctx.close(); } catch { } WW.emit("rx"); }
function rxGain(id) { const P = RX.players.get(id); if (!P || !P.gain) return; const r = (WW.radios || []).find(x => x.id === id), af = r?.state?.levels?.AF ?? 0.8;
  P.gain.gain.value = P.mute ? 0 : af; }
function rxMute(id, on) { const P = RX.players.get(id); if (!P) return; P.mute = on; store.set("rx.mute." + id, on); rxGain(id); WW.emit("rx"); }
// Ton eines Empfaengers als PCM-Bloecke (Float32, Abtastrate des Empfaengers) an fn; Rueckgabe: abmelden
async function rxPcm(id, fn) { const P = await rxPlay(id || WW.current || [...RX.players.keys()][0]); P.pcm.add(fn); return () => P.pcm.delete(fn); }
// Abtastrate auf 8 kHz fuer die Dekoder: Tiefpass (gefenstertes sinc, 3,4 kHz) und lineare Interpolation; liefert Bloecke zu 512
function rxTo8k(out) {
  let rate = 0, taps = null, hist = null, pos = 0, prev = 0, blk = new Float32Array(512), bn = 0, peak = 0;
  const design = r => { const N = 31, fc = 3400 / r, h = new Float32Array(N); let s = 0;
    for (let i = 0; i < N; i++) { const m = i - (N - 1) / 2; h[i] = (m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1))); s += h[i]; }
    for (let i = 0; i < N; i++) h[i] /= s; return h; };
  return (x, r) => {
    if (r !== rate) { rate = r; taps = design(r); hist = new Float32Array(taps.length); pos = 0; }
    const step = rate / 8000, N = taps.length;
    for (let i = 0; i < x.length; i++) {
      hist.copyWithin(0, 1); hist[N - 1] = x[i]; let y = 0; for (let k = 0; k < N; k++) y += hist[k] * taps[k];
      while (pos < 1) { const v = prev + (y - prev) * pos; blk[bn++] = v; const a = Math.abs(v); if (a > peak) peak = a;
        if (bn === 512) { out(blk, peak); blk = new Float32Array(512); bn = 0; peak = 0; } pos += step; }
      pos -= 1; prev = y;
    }
  };
}
// Ton eines Empfaengers als MediaStream (fuer Digitalbetrieb und Fernbetrieb-Audio)
async function rxStream(id) { const P = await rxPlay(id || [...RX.players.keys()][0] || WW.current); await P.ctx.resume(); return P.dest.stream; }
function rxSync() {   // Wiedergabe passend zu den verbundenen Empfaengern starten/stoppen
  const want = new Set((WW.radios || []).filter(r => isSdr(r) && r.connected).map(r => r.id));
  for (const id of want) if (!RX.players.has(id)) rxPlay(id).catch(e => toast("Empfänger-Ton: " + e.message, true));
  for (const id of [...RX.players.keys()]) if (!want.has(id)) rxStop(id);
}
WW.on("radios", rxSync);
WW.on("rig-any", m => { if (RX.players.has(m.radio)) { const r = (WW.radios || []).find(x => x.id === m.radio); if (r) r.state = m.rig; rxGain(m.radio); } });

// ---------- Auswahl im Verbinden-Dialog ----------
const SDR_TYPES = [["kiwisdr", "KiwiSDR"], ["openwebrx", "OpenWebRX"], ["websdr", "WebSDR (nur im Browser)"]];
function websdrLink(url, khz, mode) { const m = { USB: "usb", LSB: "lsb", CW: "cw", CWR: "cw", AM: "am", FM: "fm", PKTUSB: "usb", PKTLSB: "lsb" }[mode] || "usb";
  return url.replace(/\/?$/, "/") + `?tune=${(+khz).toFixed(2)}${m}`; }
function sdrPicker(root, done) {
  const st = store.get("sdr.pick", { type: "kiwisdr", q: "", free: true, band: true });
  root.innerHTML = `<div class="ctl-row"><select class="sp-type"><option value="">alle Arten</option>${SDR_TYPES.map(([k, l]) => `<option value="${k}" ${k === st.type ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input class="sp-q grow" placeholder="Suche: Ort, Rufzeichen, Locator, Antenne …" value="${esc(st.q)}"><label class="chk"><input type="checkbox" class="sp-free" ${st.free ? "checked" : ""}> freie Plätze</label>
      <label class="chk"><input type="checkbox" class="sp-band" ${st.band ? "checked" : ""}> empfängt aktuelle Frequenz</label></div>
    <div class="tablewrap sp-wrap"><table class="grid sp-t"><thead><tr><th>Art</th><th>Name</th><th>Ort</th><th>km</th><th>Plätze</th><th></th></tr></thead><tbody><tr><td colspan="6" class="hint">Liste wird geladen …</td></tr></tbody></table></div>
    <fieldset><legend>Gewählter Empfänger / direkt eintragen</legend><div class="grid2">
      <label>Art<select class="sp-mtype"></select></label>
      <label>Adresse<input class="sp-url" placeholder="http://empfaenger.example:8073"></label>
      <label class="wide">Parameter (optional, mit ; getrennt)<input class="sp-par" placeholder="z. B. password=…; span=200; freq=7074; mode=USB; user=Name"></label>
      <div class="ctl-row wide"><button type="button" class="sp-go primary">Als Hauptgerät verbinden</button><button type="button" class="sp-go2">Als zweiten Empfänger</button></div></div></fieldset>
    <p class="hint">Listen: receiverbook.de und kiwisdr.com. Empfänger sind Angebote von Funkamateuren – Plätze sind begrenzt, bitte nach Gebrauch trennen. Die Liste von websdr.org ist nur auf <a href="http://websdr.org" target="_blank">websdr.org</a> selbst zu sehen.</p><div class="sp-st hint"></div>`;
  let rows = [];
  const load = async () => {
    Object.assign(st, { type: $(".sp-type", root).value, q: $(".sp-q", root).value, free: $(".sp-free", root).checked, band: $(".sp-band", root).checked }); store.set("sdr.pick", st);
    const khz = st.band && WW.rig.freq ? WW.rig.freq / 1000 : 0;
    try { const r = await api(`/api/sdr/receivers?type=${st.type}&q=${encodeURIComponent(st.q)}&free=${st.free}&khz=${khz}&limit=300`); rows = r.receivers;
      $("tbody", root).innerHTML = rows.map((x, i) => `<tr data-i="${i}" title="Klick: auswählen · Doppelklick: verbinden"><td>${esc(SDR_TYPES.find(t => t[0] === x.type)?.[1].split(" ")[0] || x.type)}</td><td title="${esc(x.antenna || "")}">${esc(x.name)}</td><td>${esc(x.place || x.grid || "")}</td><td>${x.km ?? "–"}</td>
        <td>${x.users_max ? `${x.users}/${x.users_max}` : ""}</td><td class="nowrap">${x.type === "websdr" ? `<button type="button" data-a="web">im Browser</button>` : `<button type="button" data-a="main">verbinden</button><button type="button" data-a="second" title="zusätzlich zum Funkgerät">2. Empf.</button>`}</td></tr>`).join("")
        || `<tr><td colspan="6" class="hint">Keine passenden Empfänger.</td></tr>`;
      $(".sp-st", root).textContent = `${rows.length} von ${r.total} Empfängern`; } catch (e) { $(".sp-st", root).textContent = e.message; } };
  const connect = async (type, url, params, role, name) => {
    $(".sp-st", root).textContent = `verbinde mit ${name || url} …`;
    try { const p = await post("/api/radios", { kind: "sdr", sdr_type: type, url, params, role, name: (name || "").slice(0, 60) });
      await post(`/api/radios/${p.id}/connect`); await loadRadios(); rxSync(); toast(`${p.name} verbunden`); done && done();
      if (role === "main" && SHELL.active === "rig" && !panelOpen("rig", "waterfall")) addPanel("rig", "waterfall"); }   // Wasserfall gleich zeigen
    catch (e) { $(".sp-st", root).textContent = e.message; toast(e.message, true); } };
  root.addEventListener("change", e => { if (e.target.closest(".ctl-row") && e.target.matches("select, input[type=checkbox]")) load(); });
  root.addEventListener("input", e => { if (e.target.classList.contains("sp-q")) { clearTimeout(root._t); root._t = setTimeout(load, 300); } });
  const params = () => `freq=${((WW.rig.freq || 7074000) / 1000).toFixed(3)}; mode=${WW.rig.mode || "USB"}; user=${WW.station?.callsign || WW.settings.callsign || "Wellenwerk"}`;
  const use = (x, role) => x.type === "websdr" ? window.open(websdrLink(x.url, (WW.rig.freq || 7074000) / 1000, WW.rig.mode), "_blank") : connect(x.type, x.url, params(), role, x.name);
  let picked = null;   // per Klick gewaehlte Zeile: die Knoepfe unten verbinden sie, Doppelklick verbindet sofort
  const pick = tr => { $$("tr.sel", root).forEach(t => t.classList.remove("sel")); picked = null; if (!tr || tr.dataset.i == null) return;
    tr.classList.add("sel"); picked = rows[+tr.dataset.i];
    if (picked.type !== "websdr") { $(".sp-mtype", root).value = picked.type; $(".sp-url", root).value = picked.url; $(".sp-par", root).value = ""; }
    $(".sp-st", root).textContent = `gewählt: ${picked.name}`; };
  root.addEventListener("click", e => { const tr = e.target.closest(".sp-t tbody tr"); const b = e.target.closest("button[data-a]");
    if (b && tr) return use(rows[+tr.dataset.i], b.dataset.a);
    if (tr) pick(tr); });
  root.addEventListener("dblclick", e => { const tr = e.target.closest(".sp-t tbody tr"); if (tr && tr.dataset.i != null && !e.target.closest("button")) use(rows[+tr.dataset.i], "main"); });
  const go = role => picked && picked.type !== "websdr" && $(".sp-url", root).value.trim() === picked.url ? use(picked, role)
    : connect($(".sp-mtype", root).value, $(".sp-url", root).value.trim(), $(".sp-par", root).value || params(), role);
  $(".sp-go", root).onclick = () => go("main");
  $(".sp-go2", root).onclick = () => go("second");
  const HINT = { kiwisdr: "http://empfaenger.example:8073", openwebrx: "http://empfaenger.example:8073/", rtltcp: "127.0.0.1:1234 (rtl_tcp)", hl2: "leer = automatisch suchen, sonst IP-Adresse" };
  api("/api/sdr/kinds").then(ks => { const sel = $(".sp-mtype", root); sel.innerHTML = ks.map(k => `<option value="${esc(k.kind)}">${esc(k.label)}</option>`).join("");
    sel.onchange = () => { $(".sp-url", root).placeholder = HINT[sel.value] || ""; }; sel.onchange(); }).catch(() => { });
  load();
}

// ---------- Fenster „Empfänger“ ----------
function createReceivers(root) {
  root.innerHTML = `<div class="pane-tb"><button class="rx-add">${icon("i-plus")} Empfänger wählen …</button><span class="hint rx-hint"></span></div><div class="rx-list"></div>`;
  const draw = () => {
    const rs = (WW.radios || []).filter(r => isSdr(r) && r.connected);
    $(".rx-hint", root).textContent = rs.length ? "" : "Kein Empfänger verbunden – z. B. einen KiwiSDR aus der Liste wählen.";
    $(".rx-list", root).innerHTML = rs.map(r => { const s = r.state || {}, P = RX.players.get(r.id), sync = WW.settings.sync_on && WW.settings.sync_slave === r.id;
      return `<div class="rx-item${r.id === WW.current ? " cur" : ""}" data-id="${esc(r.id)}"><div class="rx-head"><b>${esc(r.name)}</b><span class="hint">${esc(r.model_name || "")}${r.id === WW.current ? " · Hauptgerät" : ""}</span><i class="grow"></i>
        ${r.id !== WW.current ? `<button type="button" data-a="cur">als Hauptgerät</button>` : ""}<button type="button" data-a="off">Trennen</button></div>
        <div class="ctl-row"><input class="rx-f" value="${((s.freq || 0) / 1000).toFixed(2)}" title="Frequenz kHz, Enter"> kHz
        <select class="rx-m">${["USB", "LSB", "CW", "AM", "SAM", "FM", "PKTUSB"].map(m => `<option ${m === s.mode ? "selected" : ""}>${m}</option>`).join("")}</select>
        <button type="button" data-a="mute" class="${P?.mute ? "on" : ""}">${P?.mute ? "Ton aus" : "Ton an"}</button>
        <input type="range" class="rx-vol" min="0" max="1" step="0.05" value="${s.levels?.AF ?? 0.8}" title="Lautstärke">
        <span class="rx-s">${fmtS(s.meters?.STRENGTH)}</span>
        ${r.id !== WW.current ? `<label class="chk"><input type="checkbox" class="rx-sync" ${sync ? "checked" : ""}> folgt dem Hauptgerät</label>` : ""}</div>
        ${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}<canvas class="rx-wf"></canvas></div>`; }).join(""); };
  const fmtS = db => db == null ? "–" : db <= 0 ? "S" + Math.max(0, Math.round(9 + db / 6)) : "9+" + Math.round(db);
  root.addEventListener("click", async e => { const b = e.target.closest("button"); if (!b) return; if (b.classList.contains("rx-add")) return openConnect(null, "sdr");
    const id = b.closest("[data-id]")?.dataset.id; if (!id) return;
    if (b.dataset.a === "off") { await post(`/api/radios/${id}/disconnect`); await loadRadios(); rxSync(); }
    else if (b.dataset.a === "cur") { await post(`/api/radios/${id}/select`); await loadRadios(); }
    else if (b.dataset.a === "mute") rxMute(id, !RX.players.get(id)?.mute); draw(); });
  root.addEventListener("change", async e => { const id = e.target.closest("[data-id]")?.dataset.id; if (!id) return;
    const call = (p, b) => api(`/api/radios/${id}/rig/${p}`, { method: "POST", body: b }).catch(err => toast(err.message, true));
    if (e.target.classList.contains("rx-f")) call("freq", { hz: Math.round(parseFloat(e.target.value.replace(",", ".")) * 1000) });
    if (e.target.classList.contains("rx-m")) call("mode", { mode: e.target.value });
    if (e.target.classList.contains("rx-vol")) call("level", { name: "AF", value: +e.target.value });
    if (e.target.classList.contains("rx-sync")) { WW.settings = await api("/api/settings", { method: "PUT", body: e.target.checked ? { sync_on: true, sync_master: WW.current, sync_slave: id, sync_offset: 0, sync_mode: true } : { sync_on: false } }); } });
  // Wasserfall je Empfaenger
  const wfs = new Map();
  // Klick in den Wasserfall stimmt diesen Empfaenger auf die angeklickte Frequenz ab
  root.addEventListener("click", e => { const c = e.target.closest(".rx-wf"); if (!c) return; const id = c.closest("[data-id]")?.dataset.id, l = wfs.get(id); if (!l) return;
    const r = c.getBoundingClientRect(), hz = Math.round((l.low + (e.clientX - r.left) / r.width * (l.high - l.low)) / 10) * 10;
    if (sigOnClick(id, hz, e)) return;
    api(`/api/radios/${id}/rig/freq`, { method: "POST", body: { hz: snapRaster(hz, (WW.radios || []).find(r => r.id === id)?.state?.mode) } }).catch(err => toast(err.message, true)); });
  root.addEventListener("mousemove", e => { const c = e.target.closest(".rx-wf"); if (!c) return; const l = wfs.get(c.closest("[data-id]")?.dataset.id); if (!l) return;
    const r = c.getBoundingClientRect(); c.title = `${((l.low + (e.clientX - r.left) / r.width * (l.high - l.low)) / 1000).toFixed(1)} kHz – klicken zum Abstimmen`; });
  const line = l => { wfs.set(l.radio, l); const c = root.querySelector(`[data-id="${CSS.escape(l.radio)}"] .rx-wf`); if (!c) return; const W = c.clientWidth, H = c.clientHeight; if (!W || !H) return;
    let e = scrs.get(l.radio); if (!e || e.c !== c) { e = { c, scr: wfScroller(c, rxLevels, { after: (g, W2, H2, k) => { const s = (WW.radios || []).find(r => r.id === e.id)?.state, L = e.l;
      if (s?.freq && L) { g.fillStyle = "rgba(255,80,80,.9)"; g.fillRect((s.freq - L.low) / (L.high - L.low) * W2, 0, 1, k); } } }), id: l.radio }; e.scr.lut = wfLut("klassisch"); scrs.set(l.radio, e); }
    e.l = l; e.scr.push({ l, L: wfAutoLevel(e, l.data) }); };
  const scrs = new Map();
  const rxLevels = ({ l, L }, W) => { const out = new Uint8Array(W), n = l.data.length, span = (L[1] - L[0]) || 1;
    for (let x = 0; x < W; x++) { let v = -1e9; for (let i = Math.floor(x / W * n), e = Math.max(i + 1, Math.floor((x + 1) / W * n)); i < e; i++) v = Math.max(v, l.data[i]);
      out[x] = Math.max(0, Math.min(255, (v - L[0]) / span * 255)); } return out; };
  let tt = 0; const offs = [WW.on("radios", draw), WW.on("rx", draw), WW.on("spectrum", line), WW.on("rig-any", m => { const it = root.querySelector(`[data-id="${CSS.escape(m.radio)}"]`); if (!it) return;
    const f = it.querySelector(".rx-f"); if (document.activeElement !== f) f.value = ((m.rig.freq || 0) / 1000).toFixed(2); it.querySelector(".rx-s").textContent = fmtS(m.rig.meters?.STRENGTH);
    const ms = it.querySelector(".rx-m"); if (document.activeElement !== ms && m.rig.mode) ms.value = m.rig.mode; })];
  draw(); return () => offs.forEach(f => f());
}
APPS.rig.panels.receivers = { title: "Empfänger", create: createReceivers, dock: { ref: "face", dir: "right" }, size: { width: 460 } };

// ---------- Fenster „Datenempfang“: Meldungen der Empfaenger-Dekoder (OpenWebRX: DMR, D-STAR, YSF, APRS, Funksensoren, Wettersonden) ----------
const DEC_LABEL = { dmr: "DMR", dstar: "D-STAR", ysf: "YSF", nxdn: "NXDN", p25: "P25", m17: "M17", packet: "APRS", ism: "Sensor", sonde: "Sonde",
  ft8: "FT8", ft4: "FT4", wspr: "WSPR", jt65: "JT65", jt9: "JT9", fst4: "FST4", fst4w: "FST4W", q65: "Q65", msk144: "MSK144", js8: "JS8", bpsk31: "PSK31", bpsk63: "PSK63",
  rtty170: "RTTY", rtty450: "RTTY DWD", rtty85: "RTTY", cwdecoder: "CW", navtex: "NAVTEX", sitorb: "SITOR-B", dsc: "DSC", ais: "AIS", adsb: "ADS-B",
  "lora-aprs": "LoRa-APRS", meshtastic: "Meshtastic", meshcom: "MeshCom", meshcore: "MeshCore", "lora-fanet": "FANET" };
const DEC_WSJT = new Set(["ft8", "ft4", "wspr", "jt65", "jt9", "fst4", "fst4w", "q65", "msk144"]);
// Absender einer WSJT-Nachricht: „CQ [DX|TEST|…] RUF LOC“ -> RUF, „AN VON …“ -> VON
function decWsjtCall(msg) { const t = String(msg || "").trim().split(/\s+/), isCall = x => /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z](\/[A-Z0-9]+)?$/.test(x || "");
  if (t[0] === "CQ") return isCall(t[1]) ? t[1] : isCall(t[2]) ? t[2] : ""; return isCall(t[1]) ? t[1] : ""; }
function decTempC(v) { if (v.temperature_C != null) return +v.temperature_C; if (v.temperature_F != null) return (v.temperature_F - 32) * 5 / 9; if (v.temp != null) return +v.temp; return null; }
// eine Zeile Text je Meldung
// ---------- Namen zu Kennungen (RadioID.net, BrandMeister) – gesammelt beim eigenen Server angefragt, im Speicher gehalten ----------
const IDS = { dmr: new Map(), nxdn: new Map(), tg: new Map(), call: new Map(), want: { dmr: new Set(), nxdn: new Set(), tg: new Set(), call: new Set() }, timer: 0 };
function idName(kind, key) {
  if (key == null || key === "" || key === false) return null; key = String(key).trim(); if (!key || key === "0") return null;
  const m = IDS[kind]; if (m.has(key)) return m.get(key);
  m.set(key, null); IDS.want[kind].add(key); clearTimeout(IDS.timer); IDS.timer = setTimeout(idFetch, 250); return null;
}
async function idFetch() {
  const body = {}; for (const k of Object.keys(IDS.want)) { body[k] = [...IDS.want[k]]; IDS.want[k].clear(); }
  try { const r = await api("/api/ids", { method: "POST", body });
    if (r.loading) { for (const k of Object.keys(body)) for (const x of body[k]) IDS[k].delete(x); setTimeout(() => WW.emit("ids"), 1500); return; }
    for (const k of Object.keys(body)) for (const x of body[k]) IDS[k].set(x, r[k]?.[x] || false);
    WW.emit("ids");
  } catch { }
}
// „DL5HZ Holger (Berlin)“ bzw. nur die Kennung, solange der Name (noch) unbekannt ist
const idPerson = (u, fallback) => u ? `${u.c}${u.n ? " " + u.n.split(" ")[0] : ""}${u.city ? " (" + u.city + ")" : ""}` : fallback;
const idTg = n => { if (n == null || n === "") return ""; const nm = idName("tg", n); return `TG ${n}${nm ? " " + nm.trim() : ""}`; };
function decSummary(d) {
  const v = d.value; if (v == null) return ""; if (typeof v !== "object") return String(v);
  const j = (...a) => a.filter(x => x !== undefined && x !== null && x !== "").join(" · ");
  const pos = v.lat != null && v.lon != null ? `${Math.abs(v.lat).toFixed(4)}°${v.lat >= 0 ? "N" : "S"} ${Math.abs(v.lon).toFixed(4)}°${v.lon >= 0 ? "E" : "W"}` : "";
  if (DEC_WSJT.has(d.decoder)) { const msg = v.msg ?? v.message ?? "", c = v.callsign || decWsjtCall(msg), u = c ? idName("call", c) : null;
    return j(v.db != null ? `${v.db} dB` : v.snr != null ? `${v.snr} dB` : "", v.freq != null ? `${Math.round(v.freq)} Hz` : "", msg || j(v.callsign, v.locator, v.dbm != null ? v.dbm + " dBm" : ""), u ? `(${u.n || ""}${u.city ? ", " + u.city : ""})`.replace("(, ", "(") : ""); }
  if (d.decoder === "js8") return j(v.db != null ? `${v.db} dB` : "", v.msg ?? v.message);
  if (d.decoder === "ais") return j(v.shipname || v.name, v.callsign, v.mmsi != null ? "MMSI " + v.mmsi : "", pos, v.speed != null ? (+v.speed).toFixed(1) + " kn" : "", v.course != null ? Math.round(v.course) + "°" : "", v.destination ? "→ " + v.destination : "", v.text || v.message);
  if (d.decoder === "adsb") { const alt = v.altitude ?? v.alt_baro ?? v.alt;
    return j(String(v.flight || v.callsign || "").trim() || (v.icao || v.hex ? "ICAO " + (v.icao || v.hex) : ""), alt != null && alt !== "ground" ? `${Math.round(alt)} ft (${Math.round(alt * 0.3048)} m)` : alt === "ground" ? "am Boden" : "",
      v.speed ?? v.gs ? Math.round(v.speed ?? v.gs) + " kn" : "", v.heading ?? v.track ? Math.round(v.heading ?? v.track) + "°" : "", pos, v.squawk ? "Squawk " + v.squawk : ""); }
  if (d.decoder === "lora-aprs") return j(`${v.source || "?"} → ${v.destination || "?"}`, v.comment || v.data || v.text, pos);
  if (/^(meshtastic|meshcom|meshcore|lora-fanet)$/.test(d.decoder)) return j(v.from || v.source || v.src || v.id, v.to || v.destination ? "→ " + (v.to || v.destination) : "", v.text || v.message || v.msg || v.name, pos, v.alt != null ? Math.round(v.alt) + " m" : "");
  if (d.decoder === "packet") return j(`${call(v.source) || "?"} → ${v.to ? call(v.to) : v.destination || "?"}`, v.object ? "Objekt " + v.object : "", v.message || v.status || v.comment || v.data, pos,
    v.speed ? v.speed + " kn" : "", v.temperature_C != null ? v.temperature_C + " °C" : "");
  if (d.decoder === "ism") { const t = decTempC(v);
    return j(v.model, v.id != null ? "ID " + v.id : "", v.channel != null ? "Kanal " + v.channel : "", t != null ? t.toFixed(1) + " °C" : "", v.humidity != null ? v.humidity + " % Feuchte" : "",
      v.wind_avg_km_h != null ? v.wind_avg_km_h + " km/h Wind" : "", v.rain_mm != null ? v.rain_mm + " mm Regen" : "", v.pressure_hPa != null ? v.pressure_hPa + " hPa" : "", v.battery_ok === 0 ? "Batterie schwach" : ""); }
  if (d.decoder === "sonde") return j(v.type || v.model, v.id || v.serial, pos, v.alt != null ? Math.round(v.alt) + " m" : "", v.temp != null ? (+v.temp).toFixed(1) + " °C" : "", v.vel_v != null ? (+v.vel_v).toFixed(1) + " m/s" : "");
  const call = c => { c = String(c || "").trim(); return c ? idPerson(idName("call", c), c) : ""; };
  if (d.decoder === "dstar") { if (!v.ourcall && !v.message) return "";
    return j(v.ourcall && `${call(v.ourcall)} → ${String(v.yourcall || "CQCQCQ").trim()}`, v.departure && `über ${String(v.departure).trim()}${v.destination ? " / " + String(v.destination).trim() : ""}`, v.message, pos); }
  if (d.decoder === "dmr") {                                                   // Sprecher (DMR-ID -> Rufzeichen/Name) und Talkgroup mit Namen
    if (v.source == null || v.source === "") return "";                       // reine Synchronmeldungen ohne Inhalt nicht anzeigen
    const src = idPerson(idName("dmr", v.source), "ID " + v.source), ta = String(v.talkeralias || "").trim();
    const tgt = v.type === "direct" || v.type === "private" ? "privat → " + idPerson(idName("dmr", v.target), "ID " + v.target) : v.type === "data" || v.sync === "data" ? "Daten → ID " + v.target : idTg(v.target);
    return j(v.slot != null ? "TS" + (+v.slot + 1) : "", `${src}${ta && !src.startsWith(ta.split(" ")[0]) ? " „" + ta + "“" : ""}`, tgt, pos); }
  if (d.decoder === "ysf") { if (!v.source) return ""; return j(`${call(v.source)} → ${String(v.target || "ALL").trim()}`, v.up && "über " + String(v.up).trim(), pos); }
  if (d.decoder === "m17") { if (!v.source) return ""; return j(`${call(v.source)} → ${String(v.destination || v.target || "ALL").trim()}`, pos); }
  if (d.decoder === "nxdn") { if (v.source == null || v.source === "") return "";
    return j(idPerson(idName("nxdn", v.source), "ID " + v.source), v.destination != null || v.target != null ? (v.type === "private" ? "privat → " : "→ Gruppe ") + (v.destination ?? v.target) : "", pos); }
  if (d.decoder === "p25") { if (v.source == null || v.source === "") return "";
    return j(v.nac != null ? "NAC " + v.nac : "", idPerson(idName("dmr", v.source), "ID " + v.source), v.target != null ? "→ TG " + v.target : "", pos); }
  return Object.entries(v).filter(([k, x]) => x !== "" && x != null && typeof x !== "object" && !/^(mode|timestamp|color|raw|protocol)$/.test(k)).slice(0, 8).map(([k, x]) => `${k}=${x}`).join(" · ");
}
function createDecodes(root) {
  root.innerHTML = `<div class="pane-tb"><select class="dc-rx" title="Empfänger"></select><select class="dc-mode" title="Dekoder"></select><button class="dc-clr">Leeren</button><span class="hint dc-hint"></span></div>
    <div class="tablewrap"><table class="grid dc-t"><thead><tr><th>Zeit</th><th>Art</th><th>MHz</th><th>Inhalt</th></tr></thead><tbody></tbody></table></div>`;
  let rows = [];
  const rxs = () => (WW.radios || []).filter(r => isSdr(r) && r.connected && r.state?.sdr?.decoders?.length);
  const fill = () => { const sel = $(".dc-rx", root), cur = sel.value || store.get("dc.rx", "") || (rxs().find(r => r.id === WW.current) || rxs()[0] || {}).id || "";
    sel.innerHTML = rxs().map(r => `<option value="${esc(r.id)}" ${r.id === cur ? "selected" : ""}>${esc(r.name)}</option>`).join("") || `<option value="">kein Empfänger mit Dekodern</option>`;
    const r = rxs().find(x => x.id === sel.value), d = r?.state?.sdr || {};
    $(".dc-mode", root).innerHTML = `<option value="">Dekoder aus</option>` + (d.decoders || []).map(x => `<option value="${x.id}" ${x.id === d.decoder ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    $(".dc-hint", root).textContent = r ? "" : "Dekoder bietet z. B. ein OpenWebRX-Empfänger (Datei → Empfänger)."; };
  const draw = () => { $("tbody", root).innerHTML = rows.slice(-400).filter(d => decSummary(d)).slice(-200).reverse().map(d => `<tr><td>${new Date(d.t * 1000).toLocaleTimeString(I18N.locale)}</td><td>${esc(DEC_LABEL[d.decoder] || d.decoder)}</td><td>${d.freq ? (d.freq / 1e6).toFixed(4) : ""}</td><td translate="no">${esc(decSummary(d))}</td></tr>`).join("")
    || `<tr><td colspan="4" class="hint">Noch keine Meldungen. Dekoder wählen (z. B. APRS auf 144,800 MHz, Funksensoren auf 433,92 MHz) oder im Wasserfall auf ein Signal klicken.</td></tr>`; };
  $(".dc-rx", root).onchange = e => { store.set("dc.rx", e.target.value); fill(); };
  $(".dc-mode", root).onchange = e => api(`/api/radios/${$(".dc-rx", root).value}/rig/decoder`, { method: "POST", body: { mode: e.target.value } }).catch(err => { toast(err.message, true); fill(); });
  $(".dc-clr", root).onclick = () => { rows = []; draw(); };
  api("/api/sdr/decodes").then(l => { rows = l.concat(rows); draw(); }).catch(() => { });
  const offs = [WW.on("decode", d => { rows.push(d); if (rows.length > 500) rows.splice(0, 100); draw(); }), WW.on("ids", draw), WW.on("radios", fill), WW.on("rig-any", () => { const k = rxs().map(r => r.id + ":" + (r.state.sdr.decoder || "") + (r.state.sdr.decoders || []).length).join(); if (k !== fill.k && document.activeElement !== $(".dc-mode", root)) { fill.k = k; fill(); } })];
  fill(); draw(); return () => offs.forEach(f => f());
}
APPS.rig.panels.decodes = { title: "Datenempfang", create: createDecodes, dock: { ref: "face", dir: "right" }, size: { width: 520 } };
