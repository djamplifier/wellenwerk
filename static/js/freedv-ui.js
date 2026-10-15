"use strict";
// Wellenwerk – FreeDV (digitale Sprache): Empfang vom Funkgeraet bzw. Empfaenger -> Sprache im Lautsprecher,
// Senden: Mikrofon -> Modemton zum Funkgeraet (mit PTT). Modem laeuft im Wellenwerk-Server (codec2).
const FDV = { on: false, tx: false };
async function fdvDevices() { try { return await navigator.mediaDevices.enumerateDevices(); } catch { return []; } }
function createFreedv(root) {
  const st = store.get("fdv", { mode: "700D", inp: "", spk: "", mic: "", out: "", vol: 0.9, latch: false });
  root.innerHTML = `<div class="fdv"><div class="grid2">
      <label>Modus<select class="fd-mode">${["700D", "700E", "1600"].map(m => `<option ${m === st.mode ? "selected" : ""}>${m}</option>`).join("")}</select></label><span class="fd-avail hint"></span>
      <label>Empfang von<select class="fd-inp"></select></label><label>Lautsprecher<select class="fd-spk"></select></label>
      <label>Mikrofon<select class="fd-mic"></select></label><label>Senden zum Funkgerät (Soundkarte)<select class="fd-out"></select></label></div>
    <div class="ctl-row"><button class="fd-run primary">▶ Empfang</button><span class="fd-sync" title="Synchronisation">●</span><span class="fd-snr hint">–</span>
      <div class="ra-meter" title="Eingangspegel"><i class="fd-lvl"></i></div><label class="chk">Lautstärke <input type="range" class="fd-vol" min="0" max="1.5" step="0.05" value="${st.vol}"></label></div>
    <div class="ctl-row"><button class="fd-ptt" disabled>PTT – Sprechen</button><label class="chk"><input type="checkbox" class="fd-latch" ${st.latch ? "checked" : ""}> PTT rastet ein</label><span class="hint fd-txinfo"></span></div>
    <p class="hint">FreeDV-Signale liegen meist im USB auf eigenen Frequenzen (z. B. 14,236 MHz, 7,177 MHz, 3,625 MHz). Funkgerät auf USB, NF-Pegel so einstellen, dass die Pegelanzeige etwa zur Hälfte ausschlägt.</p></div>`;
  const fill = async () => { const ds = await fdvDevices(), o = (kind, sel, extra = "") => `<option value="">Standard</option>${extra}` + ds.filter(d => d.kind === kind && d.deviceId !== "default").map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? "selected" : ""}>${esc(d.label || kind)}</option>`).join("");
    $(".fd-inp", root).innerHTML = o("audioinput", st.inp, `<option value="__sdr" ${st.inp === "__sdr" || !navigator.mediaDevices?.getUserMedia ? "selected" : ""}>Empfänger (WebSDR/KiwiSDR/SDR)</option>`);
    $(".fd-spk", root).innerHTML = o("audiooutput", st.spk); $(".fd-mic", root).innerHTML = o("audioinput", st.mic); $(".fd-out", root).innerHTML = o("audiooutput", st.out); };
  api("/api/freedv").then(r => { $(".fd-avail", root).textContent = r.available ? "" : "codec2 fehlt (macOS: brew install codec2 · Linux: libcodec2-1.2)"; $(".fd-run", root).disabled = !r.available; }).catch(() => { });
  root.addEventListener("change", e => { const c = e.target.classList; const map = { "fd-mode": "mode", "fd-inp": "inp", "fd-spk": "spk", "fd-mic": "mic", "fd-out": "out" };
    for (const k in map) if (c.contains(k)) { st[map[k]] = e.target.value; if (FDV.on && k !== "fd-spk") { stop(); start(); } }
    if (c.contains("fd-latch")) st.latch = e.target.checked; store.set("fdv", st);
    if (c.contains("fd-spk") && FDV.ctx?.setSinkId) FDV.ctx.setSinkId(st.spk || "").catch(() => { }); });
  $(".fd-vol", root).oninput = e => { st.vol = +e.target.value; store.set("fdv", st); if (FDV.gain) FDV.gain.gain.value = st.vol; };
  const status = () => { $(".fd-run", root).textContent = FDV.on ? "■ Stopp" : "▶ Empfang"; $(".fd-ptt", root).disabled = !FDV.on; $(".fd-ptt", root).classList.toggle("on", FDV.tx); };
  async function start() {
    if (!navigator.mediaDevices?.getUserMedia && st.inp !== "__sdr") {   // http: Soundkarte gesperrt – Empfaenger nehmen, falls verbunden
      if (!(WW.radios || []).some(r => r.kind === "sdr" && r.connected)) return toast("Soundkarte nur über https://…:8443 oder im Desktop-Programm – oder einen Empfänger (WebSDR/KiwiSDR) verbinden", true);
      st.inp = "__sdr"; store.set("fdv", st); $(".fd-inp", root).value = "__sdr";
    }
    try {
      FDV.ctx = new AudioContext(); if (st.spk && FDV.ctx.setSinkId) await FDV.ctx.setSinkId(st.spk).catch(() => { });
      await FDV.ctx.audioWorklet.addModule("/static/digi-worklet.js");
      if (st.inp !== "__sdr") {
        FDV.in = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: st.inp ? { exact: st.inp } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const src = FDV.ctx.createMediaStreamSource(FDV.in), lp = new BiquadFilterNode(FDV.ctx, { type: "lowpass", frequency: 3600 }), lp2 = new BiquadFilterNode(FDV.ctx, { type: "lowpass", frequency: 3600 });
        FDV.tap = new AudioWorkletNode(FDV.ctx, "ww-tap"); src.connect(lp).connect(lp2).connect(FDV.tap);
      }
      FDV.gain = FDV.ctx.createGain(); FDV.gain.gain.value = st.vol; FDV.play = pcmScheduler(FDV.ctx, FDV.gain);
      FDV.gain.connect(FDV.ctx.destination);
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      FDV.ws = new WebSocket(`${proto}${location.host}/ws/freedv?mode=${st.mode}`); FDV.ws.binaryType = "arraybuffer";
      FDV.ws.onmessage = e => { if (typeof e.data === "string") { const m = JSON.parse(e.data);
          if (m.type === "stats") { $(".fd-sync", root).classList.toggle("ok", m.sync); $(".fd-snr", root).textContent = m.sync ? `Sync · SNR ${m.snr} dB` : "kein Sync"; }
          if (m.type === "error") { toast(m.text, true); stop(); } return; }
        const kind = new Uint8Array(e.data, 0, 1)[0], s = new Int16Array(e.data.slice(1)), f = new Float32Array(s.length); for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
        if (kind === 1 && !FDV.tx) FDV.play(f, 8000);
        if (kind === 2 && FDV.txPlay) FDV.txPlay(f, 8000); };
      const feed = (x, peak) => { const el = $(".fd-lvl", root); if (el) el.style.width = Math.min(100, peak * 100) + "%";
        if (FDV.tx || FDV.ws?.readyState !== 1) return; const out = new DataView(new ArrayBuffer(1 + x.length * 2)); out.setUint8(0, 1);
        for (let i = 0; i < x.length; i++) out.setInt16(1 + i * 2, Math.max(-32767, Math.min(32767, x[i] * 32767)), true); FDV.ws.send(out.buffer); };
      if (FDV.tap) FDV.tap.port.onmessage = e => feed(e.data.samples, e.data.peak);
      else FDV.unPcm = await rxPcm(null, rxTo8k(feed));   // Empfaenger: Ton direkt aus dem Datenstrom
      FDV.on = true; status();
    } catch (e) { toast("FreeDV: " + e.message, true); stop(); }
  }
  function stop() { pttOff(); FDV.on = false; try { FDV.unPcm?.(); } catch { } FDV.unPcm = FDV.tap = null; try { FDV.ws?.close(); if (st.inp !== "__sdr") FDV.in?.getTracks().forEach(t => t.stop()); FDV.ctx?.close(); } catch { } FDV.ws = FDV.ctx = null; status(); }
  async function pttOn() {
    if (!FDV.on || FDV.tx) return;
    try {
      FDV.txCtx = new AudioContext(); if (st.out && FDV.txCtx.setSinkId) await FDV.txCtx.setSinkId(st.out).catch(() => { });
      await FDV.txCtx.audioWorklet.addModule("/static/digi-worklet.js");
      FDV.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: st.mic ? { exact: st.mic } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const m = FDV.txCtx.createMediaStreamSource(FDV.mic), lp = new BiquadFilterNode(FDV.txCtx, { type: "lowpass", frequency: 3600 });
      FDV.micTap = new AudioWorkletNode(FDV.txCtx, "ww-tap"); m.connect(lp).connect(FDV.micTap);
      FDV.txPlay = pcmScheduler(FDV.txCtx, FDV.txCtx.destination);
      FDV.micTap.port.onmessage = e => { if (!FDV.tx || FDV.ws?.readyState !== 1) return; const x = e.data.samples, out = new DataView(new ArrayBuffer(1 + x.length * 2)); out.setUint8(0, 2);
        for (let i = 0; i < x.length; i++) out.setInt16(1 + i * 2, Math.max(-32767, Math.min(32767, x[i] * 32767)), true); FDV.ws.send(out.buffer); };
      await post("/api/rig/ptt", { on: true }); FDV.tx = true; $(".fd-txinfo", root).textContent = `sendet FreeDV ${st.mode}`; status();
    } catch (e) { toast("Senden: " + e.message, true); pttOff(); }
  }
  function pttOff() { if (!FDV.tx && !FDV.txCtx) return; FDV.tx = false; const c = FDV.txCtx, mic = FDV.mic; FDV.txPlay = null; FDV.txCtx = FDV.mic = null;
    setTimeout(() => { post("/api/rig/ptt", { on: false }).catch(() => { }); try { mic?.getTracks().forEach(t => t.stop()); c?.close(); } catch { } }, 400); $(".fd-txinfo", root).textContent = ""; status(); }
  $(".fd-run", root).onclick = () => FDV.on ? stop() : start();
  const ptt = $(".fd-ptt", root);
  ptt.addEventListener("pointerdown", e => { e.preventDefault(); st.latch ? (FDV.tx ? pttOff() : pttOn()) : pttOn(); });
  ["pointerup", "pointerleave", "pointercancel"].forEach(ev => ptt.addEventListener(ev, () => { if (!st.latch) pttOff(); }));
  fill(); status();
  return () => stop();
}
APPS.dm.panels.freedv = { title: "FreeDV", create: createFreedv, dock: { ref: ["rx"], dir: "within" } };
