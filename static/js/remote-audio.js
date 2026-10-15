"use strict";
// Wellenwerk – Fernbetrieb-Audio: Das Fenster am Stationsrechner gibt die Soundkarte des Funkgeraets frei
// (Empfang -> Gegenstellen, Mikrofon der Gegenstelle -> Sendeeingang). Verbindung per WebRTC (Opus),
// vermittelt ueber den Wellenwerk-Server; das Audio fliesst direkt zwischen den Rechnern.
const RA = { station: false, local: null, outId: "", pcs: new Map(), remote: null, ptt: false };
const raIce = () => ({ iceServers: (WW.settings.rtc_stun || "").split(",").map(u => u.trim()).filter(Boolean).map(urls => ({ urls })) });
const raCanMedia = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
function raLevel(stream, cb) {   // Pegelanzeige (0..1) fuer einen Audiostrom
  try { const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    const buf = new Float32Array(an.fftSize); let on = true;
    const tick = () => { if (!on) return; an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; cb(Math.min(1, Math.sqrt(s / buf.length) * 4)); requestAnimationFrame(tick); }; tick();
    return () => { on = false; ctx.close(); }; } catch { return () => { }; }
}
// ---------- Station ----------
async function raStationStart(inId, outId, name) {
  if (!raCanMedia()) throw new Error("Audio braucht eine sichere Verbindung (Desktop-Programm, localhost oder https)");
  RA.local = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: inId ? { exact: inId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  RA.outId = outId; RA.station = true; RA.name = name || WW.settings.callsign || "Station";
  wsSend({ type: "station", on: true, name: RA.name }); WW.emit("ra");
}
function raStationStop() {
  RA.pcs.forEach((pc, id) => { wsSend({ type: "rtc", to: id, kind: "bye" }); raClosePc(pc); }); RA.pcs.clear();
  RA.local?.getTracks().forEach(t => t.stop()); RA.local = null; RA.station = false;
  wsSend({ type: "station", on: false }); WW.emit("ra");
}
// ICE-Kandidaten puffern, bis die Gegenbeschreibung gesetzt ist
function raCand(pc, c) { if (!pc) return; if (pc.remoteDescription) pc.addIceCandidate(c).catch(() => { }); else (pc._q = pc._q || []).push(c); }
async function raSetRemote(pc, sdp) { await pc.setRemoteDescription(sdp); for (const c of pc._q || []) pc.addIceCandidate(c).catch(() => { }); pc._q = []; }
function raClosePc(pc) { try { pc._audio?.pause(); pc._lvl?.(); pc.close(); } catch { } }
async function raStationRtc(m) {
  if (!RA.station) return;
  if (m.kind === "offer") {
    raClosePc(RA.pcs.get(m.from));
    const pc = new RTCPeerConnection(raIce()); RA.pcs.set(m.from, pc);
    RA.local.getTracks().forEach(t => pc.addTrack(t, RA.local));
    pc.ontrack = e => { const a = new Audio(); a.srcObject = e.streams[0] || new MediaStream([e.track]); if (RA.outId && a.setSinkId) a.setSinkId(RA.outId).catch(() => { }); a.play().catch(() => { }); pc._audio = a; };
    pc.onicecandidate = e => e.candidate && wsSend({ type: "rtc", to: m.from, kind: "ice", cand: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => { if (["failed", "closed"].includes(pc.connectionState)) { raClosePc(pc); RA.pcs.delete(m.from); } WW.emit("ra"); };
    await raSetRemote(pc, m.sdp); await pc.setLocalDescription(await pc.createAnswer());
    wsSend({ type: "rtc", to: m.from, kind: "answer", sdp: pc.localDescription.toJSON() }); WW.emit("ra");
  } else if (m.kind === "ice") { raCand(RA.pcs.get(m.from), m.cand); }
  else if (m.kind === "bye") { raClosePc(RA.pcs.get(m.from)); RA.pcs.delete(m.from); WW.emit("ra"); }
}
// ---------- Gegenstelle (Fernbedienung) ----------
async function raConnect(micId) {
  raDisconnect();
  let mic = null;
  if (raCanMedia()) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { toast("Kein Mikrofon – nur Empfang", true); } }
  else toast("Ohne sichere Verbindung (https) nur Empfang möglich", true);
  const pc = new RTCPeerConnection(raIce()), R = RA.remote = { pc, mic, state: "verbinden" };
  if (mic) { mic.getAudioTracks().forEach(t => { t.enabled = false; pc.addTrack(t, mic); }); } else pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = e => { const st = e.streams[0] || new MediaStream([e.track]); const a = new Audio(); a.srcObject = st; a.volume = store.get("ra.vol", 0.8); a.play().catch(() => toast("Zum Hören einmal in das Fenster klicken", true)); R.audio = a; R.stream = st; WW.emit("ra"); };
  pc.onicecandidate = e => e.candidate && wsSend({ type: "rtc", to: "station", kind: "ice", cand: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => { R.state = pc.connectionState; WW.emit("ra"); if (pc.connectionState === "failed") toast("Audio-Verbindung gescheitert (Netz/Firewall? STUN-Server in den Optionen)", true); };
  await pc.setLocalDescription(await pc.createOffer());
  wsSend({ type: "rtc", to: "station", kind: "offer", sdp: pc.localDescription.toJSON() }); WW.emit("ra");
}
function raDisconnect() {
  const R = RA.remote; if (!R) return; raPtt(false);
  wsSend({ type: "rtc", to: "station", kind: "bye" }); try { R.audio?.pause(); R.pc.close(); } catch { } R.mic?.getTracks().forEach(t => t.stop()); RA.remote = null; WW.emit("ra");
}
async function raRemoteRtc(m) {
  const R = RA.remote; if (!R) return;
  if (m.kind === "answer") { R.station = m.from; await raSetRemote(R.pc, m.sdp); }
  else if (m.kind === "ice") raCand(R.pc, m.cand);
  else if (m.kind === "error") { toast(m.text, true); raDisconnect(); }
  else if (m.kind === "bye") { toast("Station hat die Audio-Freigabe beendet", true); raDisconnect(); }
}
function raPtt(on) {
  const R = RA.remote; if (on === RA.ptt) return; RA.ptt = on;
  R?.mic?.getAudioTracks().forEach(t => t.enabled = on);
  if (R || !on) post("/api/rig/ptt", { on }).catch(e => toast("PTT: " + e.message, true));
  WW.emit("ra");
}
WW.on("rtc", m => { if (m.kind === "offer" || (RA.station && RA.pcs.has(m.from) && m.kind !== "answer")) raStationRtc(m); else raRemoteRtc(m); });
WW.on("audio-station", () => { if (RA.remote && !(WW.audioStation || {}).available) { toast("Station hat die Audio-Freigabe beendet", true); raDisconnect(); } });
WW.on("rtc-gone", id => { if (RA.pcs.has(id)) { raClosePc(RA.pcs.get(id)); RA.pcs.delete(id); WW.emit("ra"); } if (RA.remote && RA.remote.station === id) { toast("Station hat die Audio-Freigabe beendet", true); raDisconnect(); } });
WW.on("ws-open", () => { if (RA.station) wsSend({ type: "station", on: true, name: RA.name }); });
window.addEventListener("beforeunload", () => { if (RA.remote) raDisconnect(); });

function createRemoteAudio(root) {
  const st = store.get("ra", { inId: "", outId: "", micId: "", latch: false });
  root.innerHTML = `<div class="ra">
    <fieldset><legend>Station – dieser Rechner hängt am Funkgerät</legend><div class="grid2">
      <label>Empfang vom Funkgerät (Soundkarten-Eingang)<select class="ra-in"></select></label><label>Senden zum Funkgerät (Soundkarten-Ausgang)<select class="ra-out"></select></label></div>
      <div class="ctl-row"><button class="ra-st primary"></button><span class="ra-sti hint"></span><i class="grow"></i><div class="ra-meter"><i class="ra-lvl-st"></i></div></div></fieldset>
    <fieldset><legend>Fernbedienung – mit der Station verbinden</legend>
      <div class="ctl-row"><span class="ra-avail"></span></div><div class="grid2"><label>Mikrofon<select class="ra-mic"></select></label><label>Lautstärke<input type="range" class="ra-vol" min="0" max="1" step="0.05" value="${store.get("ra.vol", 0.8)}"></label></div>
      <div class="ctl-row"><button class="ra-con primary"></button><span class="ra-rs hint"></span><i class="grow"></i><div class="ra-meter"><i class="ra-lvl-rx"></i></div></div>
      <div class="ctl-row"><button class="ra-ptt" disabled>PTT – Senden</button><label class="chk"><input type="checkbox" class="ra-latch" ${st.latch ? "checked" : ""}> PTT rastet ein (Klick ein/aus)</label></div></fieldset>
    <p class="hint">Am Stationsrechner Wellenwerk (Desktop-Programm) öffnen und „Audio freigeben“. Unterwegs im Browser über <b>https</b> (Port 8443) verbinden – nur so darf der Browser das Mikrofon nutzen. Außerhalb des Heimnetzes ggf. einen STUN-Server in den Optionen (Kommunikation) eintragen.</p></div>`;
  let lvlSt = null, lvlRx = null;
  const fill = async () => { if (!raCanMedia() || !navigator.mediaDevices.enumerateDevices) return; const ds = await navigator.mediaDevices.enumerateDevices();
    const opt = (kind, sel) => `<option value="">Standard</option>` + ds.filter(d => d.kind === kind && d.deviceId !== "default").map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? "selected" : ""}>${esc(d.label || kind)}</option>`).join("");
    $(".ra-in", root).innerHTML = opt("audioinput", st.inId); $(".ra-out", root).innerHTML = opt("audiooutput", st.outId); $(".ra-mic", root).innerHTML = opt("audioinput", st.micId); };
  const draw = () => {
    const S = RA.station, R = RA.remote, a = WW.audioStation || {};
    $(".ra-st", root).textContent = S ? "Freigabe beenden" : "Audio freigeben"; $(".ra-st", root).classList.toggle("danger", S);
    $(".ra-sti", root).textContent = S ? `freigegeben als „${RA.name}“ · ${[...RA.pcs.values()].filter(p => p.connectionState === "connected").length} Gegenstelle(n)` : "";
    $(".ra-avail", root).innerHTML = a.available ? `<b class="ok">●</b> Station „${esc(a.name || "")}“ ist bereit` : `<b class="bad">●</b> Keine Station hat Audio freigegeben`;
    $(".ra-con", root).textContent = R ? "Trennen" : "Verbinden"; $(".ra-con", root).disabled = !R && (!a.available || S);
    $(".ra-rs", root).textContent = R ? ({ new: "verbinde …", connecting: "verbinde …", connected: "verbunden", disconnected: "unterbrochen", failed: "gescheitert", verbinden: "verbinde …" }[R.state] || R.state) + (R.mic ? "" : " · nur Empfang") : "";
    $(".ra-ptt", root).disabled = !(R && R.mic && R.state === "connected"); $(".ra-ptt", root).classList.toggle("on", RA.ptt);
    if (S && RA.local && !lvlSt) lvlSt = raLevel(RA.local, v => { const e = $(".ra-lvl-st", root); if (e) e.style.width = (v * 100) + "%"; });
    if (!S && lvlSt) { lvlSt(); lvlSt = null; $(".ra-lvl-st", root).style.width = "0"; }
    if (R?.stream && !lvlRx) lvlRx = raLevel(R.stream, v => { const e = $(".ra-lvl-rx", root); if (e) e.style.width = (v * 100) + "%"; });
    if (!R && lvlRx) { lvlRx(); lvlRx = null; $(".ra-lvl-rx", root).style.width = "0"; } };
  root.addEventListener("change", e => { const c = e.target.classList;
    if (c.contains("ra-in")) st.inId = e.target.value; if (c.contains("ra-out")) st.outId = e.target.value; if (c.contains("ra-mic")) st.micId = e.target.value; if (c.contains("ra-latch")) st.latch = e.target.checked; store.set("ra", st); });
  $(".ra-vol", root).oninput = e => { store.set("ra.vol", +e.target.value); if (RA.remote?.audio) RA.remote.audio.volume = +e.target.value; };
  $(".ra-st", root).onclick = async () => { try { if (RA.station) raStationStop(); else { await raStationStart(st.inId, st.outId); fill(); } } catch (err) { toast("Audio: " + err.message, true); } draw(); };
  $(".ra-con", root).onclick = async () => { try { if (RA.remote) raDisconnect(); else await raConnect(st.micId); } catch (err) { toast("Audio: " + err.message, true); } draw(); };
  const ptt = $(".ra-ptt", root);
  ptt.addEventListener("pointerdown", e => { e.preventDefault(); if (st.latch) raPtt(!RA.ptt); else raPtt(true); });
  ["pointerup", "pointerleave", "pointercancel"].forEach(ev => ptt.addEventListener(ev, () => { if (!st.latch) raPtt(false); }));
  fill().catch(() => { }); draw();
  const offs = [WW.on("ra", draw), WW.on("audio-station", draw)]; return () => { offs.forEach(f => f()); lvlSt?.(); lvlRx?.(); };
}
APPS.rig.panels.remoteaudio = { title: "Fernbetrieb-Audio", create: createRemoteAudio, dock: { ref: "face", dir: "right" }, size: { width: 420 } };

// ---------- Schnappschuesse und Synchronisierung (Menue Funkgeraet) ----------
async function snapshotsDialog() {
  const d = dialog({ title: "Schnappschüsse – kompletter Gerätezustand", icon: "i-save", wide: true, body: `
    <div class="ctl-row"><input class="sn-name grow" placeholder="Name, z. B. „40 m FT8“ oder „Contest SSB“"><button type="button" class="sn-take primary">Aktuellen Zustand speichern</button></div>
    <div class="tablewrap" style="max-height:340px"><table class="grid sn-t"><thead><tr><th>Name</th><th>Frequenz</th><th>Mode</th><th>Regler/Schalter</th><th>Gerät</th><th></th></tr></thead><tbody></tbody></table></div>
    <p class="hint">Gespeichert werden Frequenz, Betriebsart und Bandbreite, Split mit Sendefrequenz, RIT sowie alle Regler und Schalter, die das Funkgerät setzen kann.</p><div class="sn-res hint"></div>` });
  const draw = async () => { const l = await api("/api/snapshots");
    $("tbody", d).innerHTML = l.map(x => `<tr data-id="${x.id}"><td>${esc(x.name)}</td><td>${fmtMHz(x.state.freq || 0)}</td><td>${esc(x.state.mode || "")}${x.state.split ? " · Split" : ""}</td><td>${Object.keys(x.state.levels || {}).length + Object.keys(x.state.funcs || {}).length}</td><td>${esc(x.model)}</td>
      <td><button type="button" data-a="apply">Abrufen</button><button type="button" data-a="del">×</button></td></tr>`).join("") || `<tr><td colspan="6" class="hint">noch keine</td></tr>`; };
  $(".sn-take", d).onclick = async () => { try { await post("/api/snapshots", { name: $(".sn-name", d).value }); $(".sn-name", d).value = ""; draw(); toast("Schnappschuss gespeichert"); } catch (e) { toast(e.message, true); } };
  $("tbody", d).onclick = async e => { const b = e.target.closest("button[data-a]"); if (!b) return; const id = b.closest("tr").dataset.id;
    if (b.dataset.a === "del") { await api("/api/snapshots/" + id, { method: "DELETE" }); draw(); return; }
    try { const r = await post(`/api/snapshots/${id}/apply`); $(".sn-res", d).textContent = `Übernommen: ${r.done.length} Einstellungen${r.skipped.length ? ` · nicht möglich: ${r.skipped.join(", ")}` : ""}`; } catch (err) { toast(err.message, true); } };
  draw();
}
function syncDialog() {
  const s = WW.settings, rs = WW.radios || [];
  const opts = sel => rs.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? "selected" : ""}>${esc(r.name || r.id)}${r.connected ? "" : " (nicht verbunden)"}</option>`).join("");
  const d = dialog({ title: "Funkgeräte synchronisieren", icon: "i-radio", buttons: [["Abbrechen", "close"], ["Speichern", "ok", "primary"]], body: `<div class="grid2">
    <label>Führendes Gerät<select class="sy-m">${opts(s.sync_master || WW.current)}</select></label><label>Folgendes Gerät<select class="sy-s">${opts(s.sync_slave)}</select></label>
    <label>Versatz (Hz, z. B. 0 oder −1500)<input class="sy-o" type="number" value="${+s.sync_offset || 0}"></label><span></span>
    <label class="chkrow wide"><input type="checkbox" class="sy-mo" ${s.sync_mode !== false ? "checked" : ""}> Betriebsart mitnehmen</label>
    <label class="chkrow wide"><input type="checkbox" class="sy-on" ${s.sync_on ? "checked" : ""}> Synchronisierung eingeschaltet</label>
    <p class="hint wide">Das folgende Gerät stellt sich bei jeder Änderung auf die Frequenz des führenden (plus Versatz) – z. B. Empfänger/Skimmer, Transverter-ZF oder SDR-Panadapter. Beide Geräte müssen verbunden sein.</p>${rs.length < 2 ? `<p class="err wide">Dafür werden zwei eingerichtete Funkgeräte gebraucht (Datei → Verbinden …).</p>` : ""}</div>` });
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault();
    if ($(".sy-on", d).checked && $(".sy-m", d).value === $(".sy-s", d).value) return toast("Führendes und folgendes Gerät müssen verschieden sein", true);
    try { WW.settings = await api("/api/settings", { method: "PUT", body: { sync_on: $(".sy-on", d).checked, sync_master: $(".sy-m", d).value, sync_slave: $(".sy-s", d).value, sync_offset: $(".sy-o", d).value || "0", sync_mode: $(".sy-mo", d).checked } }); d.close(); toast($(".sy-on", d).checked ? "Synchronisierung ein" : "Synchronisierung aus"); } catch (err) { toast(err.message, true); } };
}
