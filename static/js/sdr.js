"use strict";
// Wellenwerk – Empfaenger (KiwiSDR, OpenWebRX, SDR-Hardware): Ton im Browser, Auswahl aus oeffentlichen Listen,
// Fenster „Empfaenger“ fuer Haupt- und Zweitempfaenger.
const RX = { players: new Map() };
const isSdr = r => r && r.kind === "sdr";
async function rxPlay(id) {
  if (RX.players.has(id)) return RX.players.get(id);
  const P = { id, mute: store.get("rx.mute." + id, false), level: 0 };
  RX.players.set(id, P);
  P.ctx = new AudioContext();
  await P.ctx.audioWorklet.addModule("/static/sdr-worklet.js");
  P.node = new AudioWorkletNode(P.ctx, "ww-pcm-player", { outputChannelCount: [1] });
  P.gain = P.ctx.createGain(); P.dest = P.ctx.createMediaStreamDestination(); P.an = P.ctx.createAnalyser(); P.an.fftSize = 1024;
  P.node.connect(P.gain).connect(P.ctx.destination); P.node.connect(P.dest); P.node.connect(P.an);
  rxGain(id);
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const open = () => { P.ws = new WebSocket(`${proto}${location.host}/ws/audio?radio=${encodeURIComponent(id)}`); P.ws.binaryType = "arraybuffer";
    P.ws.onmessage = e => { const dv = new DataView(e.data), rate = dv.getUint32(0, true), s = new Int16Array(e.data, 4), f = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768; P.node.port.postMessage({ pcm: f, rate }, [f.buffer]); };
    P.ws.onclose = () => { if (RX.players.get(id) === P) setTimeout(open, 2000); }; };
  open();
  if (P.ctx.state !== "running") document.addEventListener("pointerdown", () => P.ctx.resume(), { once: true });
  WW.emit("rx"); return P;
}
function rxStop(id) { const P = RX.players.get(id); if (!P) return; RX.players.delete(id); try { P.ws.onclose = null; P.ws.close(); P.ctx.close(); } catch { } WW.emit("rx"); }
function rxGain(id) { const P = RX.players.get(id); if (!P || !P.gain) return; const r = (WW.radios || []).find(x => x.id === id), af = r?.state?.levels?.AF ?? 0.8;
  P.gain.gain.value = P.mute ? 0 : af; }
function rxMute(id, on) { const P = RX.players.get(id); if (!P) return; P.mute = on; store.set("rx.mute." + id, on); rxGain(id); WW.emit("rx"); }
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
    <fieldset><legend>Empfänger direkt eintragen</legend><div class="grid2">
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
      $("tbody", root).innerHTML = rows.map((x, i) => `<tr data-i="${i}"><td>${esc(SDR_TYPES.find(t => t[0] === x.type)?.[1].split(" ")[0] || x.type)}</td><td title="${esc(x.antenna || "")}">${esc(x.name)}</td><td>${esc(x.place || x.grid || "")}</td><td>${x.km ?? "–"}</td>
        <td>${x.users_max ? `${x.users}/${x.users_max}` : ""}</td><td class="nowrap">${x.type === "websdr" ? `<button type="button" data-a="web">im Browser</button>` : `<button type="button" data-a="main">verbinden</button><button type="button" data-a="second" title="zusätzlich zum Funkgerät">2. Empf.</button>`}</td></tr>`).join("")
        || `<tr><td colspan="6" class="hint">Keine passenden Empfänger.</td></tr>`;
      $(".sp-st", root).textContent = `${rows.length} von ${r.total} Empfängern`; } catch (e) { $(".sp-st", root).textContent = e.message; } };
  const connect = async (type, url, params, role, name) => {
    $(".sp-st", root).textContent = `verbinde mit ${name || url} …`;
    try { const p = await post("/api/radios", { kind: "sdr", sdr_type: type, url, params, role, name: (name || "").slice(0, 60) });
      await post(`/api/radios/${p.id}/connect`); await loadRadios(); rxSync(); toast(`${p.name} verbunden`); done && done(); }
    catch (e) { $(".sp-st", root).textContent = e.message; toast(e.message, true); } };
  root.addEventListener("change", e => { if (e.target.closest(".ctl-row") && e.target.matches("select, input[type=checkbox]")) load(); });
  root.addEventListener("input", e => { if (e.target.classList.contains("sp-q")) { clearTimeout(root._t); root._t = setTimeout(load, 300); } });
  root.addEventListener("click", e => { const b = e.target.closest("button[data-a]"); if (!b) return; const x = rows[+b.closest("tr").dataset.i];
    if (b.dataset.a === "web") window.open(websdrLink(x.url, (WW.rig.freq || 7074000) / 1000, WW.rig.mode), "_blank");
    else connect(x.type, x.url, `freq=${((WW.rig.freq || 7074000) / 1000).toFixed(3)}; mode=${WW.rig.mode || "USB"}; user=${WW.station?.callsign || WW.settings.callsign || "Wellenwerk"}`, b.dataset.a, x.name); });
  $(".sp-go", root).onclick = () => connect($(".sp-mtype", root).value, $(".sp-url", root).value.trim(), $(".sp-par", root).value, "main");
  $(".sp-go2", root).onclick = () => connect($(".sp-mtype", root).value, $(".sp-url", root).value.trim(), $(".sp-par", root).value, "second");
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
  const line = l => { const c = root.querySelector(`[data-id="${CSS.escape(l.radio)}"] .rx-wf`); if (!c) return; const W = c.clientWidth, H = c.clientHeight; if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } const g = c.getContext("2d"); g.drawImage(c, 0, 0, W, H - 1, 0, 1, W, H - 1);
    const img = g.createImageData(W, 1), n = l.data.length, span = (l.max - l.min) || 1;
    for (let x = 0; x < W; x++) { const v = Math.max(0, Math.min(1, (l.data[Math.floor(x / W * n)] - l.min) / span)); const [r, gg, b] = wfColor(v); img.data.set([r, gg, b, 255], 4 * x); }
    g.putImageData(img, 0, 0); const s = (WW.radios || []).find(r => r.id === l.radio)?.state; if (s?.freq) { g.fillStyle = "rgba(255,80,80,.9)"; g.fillRect((s.freq - l.low) / (l.high - l.low) * W, 0, 1, 1); } };
  let tt = 0; const offs = [WW.on("radios", draw), WW.on("rx", draw), WW.on("spectrum", line), WW.on("rig-any", m => { const it = root.querySelector(`[data-id="${CSS.escape(m.radio)}"]`); if (!it) return;
    const f = it.querySelector(".rx-f"); if (document.activeElement !== f) f.value = ((m.rig.freq || 0) / 1000).toFixed(2); it.querySelector(".rx-s").textContent = fmtS(m.rig.meters?.STRENGTH);
    const ms = it.querySelector(".rx-m"); if (document.activeElement !== ms && m.rig.mode) ms.value = m.rig.mode; })];
  draw(); return () => offs.forEach(f => f());
}
APPS.rig.panels.receivers = { title: "Empfänger", create: createReceivers, dock: { ref: "face", dir: "right" }, size: { width: 460 } };
