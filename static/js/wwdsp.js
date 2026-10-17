"use strict";
// Wellenwerk – Rauschfilter fuers Hoeren (Vorbild Thetis): Stoerimpulsaustaster (NB), Rauschminderung spektral (NR, wie NR2/NR4)
// oder per KI (RNNoise, wie NR3), automatische Notch (ANF) und eigene Notches. Arbeitet blockweise auf dem Ton jeder Quelle
// (Empfaenger, WebSDR, Funkgeraet ueber die Soundkarte) bei deren Abtastrate. Dekoder bekommen weiter den unbearbeiteten Ton.
const DSP_DEF = { nb: false, nbLvl: 5, nr: "off", nrLvl: 0.6, anf: false, notches: [], notchW: 80 };
const DSP = { opts: { ...DSP_DEF, ...store.get("dsp", {}) }, rnn: null, rnnLoad: null, rnnErr: "" };
function dspSet(o) { Object.assign(DSP.opts, o); store.set("dsp", DSP.opts); WW.emit("dsp", DSP.opts); if (DSP.opts.nr === "ai") dspRnnLoad(); }
function dspActive() { const o = DSP.opts; return o.nb || o.nr !== "off" || o.anf || o.notches.length > 0; }

// ---------- FFT (radix 2, an Ort und Stelle) ----------
function dspFft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ---------- Stoerimpulsaustaster im Ton ----------
// Bei eigener SDR-Hardware wirkt der Austaster des Empfaengers auf den IQ-Daten besser (Taste NB am Funkgeraet).
function dspNb(rate) {
  const D = Math.max(4, Math.round(rate * 0.0015)), buf = new Float32Array(D); let w = 0, avg = 1e-4, blank = 0, fade = 1;
  return (x, lvl) => { const thr = (2.2 + (10 - lvl) * 0.9) ** 2, y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i], p = v * v;
      if (p > thr * avg && avg > 1e-9) blank = 2 * D; else avg += (p - avg) * 0.002;     // Impuls: davor (Verzoegerung) und danach austasten
      const out = buf[w]; buf[w] = v; w = (w + 1) % D;
      if (blank > 0) { blank--; fade = Math.max(0, fade - 0.25); } else fade = Math.min(1, fade + 0.05);
      y[i] = out * fade; }
    return y; };
}

// ---------- Spektrale Rauschminderung (Wiener-Filter mit Minimum-Statistik der Rauschleistung) ----------
function dspSpecNr(rate) {
  const N = rate >= 32000 ? 1024 : rate >= 16000 ? 512 : 256, H = N / 2, B = N / 2 + 1;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const inb = new Float32Array(N), ola = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N);
  const P = new Float64Array(B), Pmin = new Float64Array(B).fill(1e9), Ptmp = new Float64Array(B).fill(1e9), G = new Float64Array(B).fill(1), post0 = new Float64Array(B);
  const minLen = Math.round(0.8 * rate / H); let fill = 0, frames = 0, out = [], outLen = 0;
  const frame = lvl => {
    for (let i = 0; i < N; i++) { re[i] = inb[i] * win[i]; im[i] = 0; }
    dspFft(re, im, false);
    const gmin = Math.pow(10, -(6 + lvl * 22) / 20); frames++;
    for (let k = 0; k < B; k++) {
      const X = re[k] * re[k] + im[k] * im[k];
      P[k] = frames === 1 ? X : 0.8 * P[k] + 0.2 * X;
      Pmin[k] = Math.min(Pmin[k], P[k]); Ptmp[k] = Math.min(Ptmp[k], P[k]);
      const noise = Math.max(1e-12, Pmin[k] * 2.5), post = X / noise;   // Minimum liegt unter dem Mittel: Ausgleich (an Sprache mit Rauschen abgestimmt)
      const prio = 0.97 * G[k] * G[k] * post0[k] + 0.03 * Math.max(post - 1, 0); post0[k] = post;
      G[k] = Math.max(gmin, prio / (1 + prio)); }
    if (frames % minLen === 0) for (let k = 0; k < B; k++) { Pmin[k] = Ptmp[k]; Ptmp[k] = P[k]; }   // Minimum ueber ~1,6 s gleitend
    for (let k = 0; k < B; k++) { const g = k > 0 && k < B - 1 ? (G[k - 1] + 2 * G[k] + G[k + 1]) / 4 : G[k]; re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
    dspFft(re, im, true);
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i];
    out.push(ola.slice(0, H)); outLen += H; ola.copyWithin(0, H); ola.fill(0, N - H);
    inb.copyWithin(0, H); fill = N - H;
  };
  return (x, lvl) => {
    for (let i = 0; i < x.length; i++) { inb[fill++] = x[i]; if (fill === N) frame(lvl); }
    const y = new Float32Array(x.length); let k = 0;                                   // gleich lang ausgeben (Vorlauf zu Beginn: Stille)
    const need = x.length; if (outLen < need) return y.fill(0);
    while (k < need) { const b = out[0], n = Math.min(b.length, need - k); y.set(b.subarray(0, n), k); k += n;
      if (n < b.length) out[0] = b.subarray(n); else out.shift(); outLen -= n; }
    return y; };
}

// ---------- KI-Rauschminderung (RNNoise, 48 kHz, Rahmen zu 480 Werten) ----------
async function dspRnnLoad() {
  if (DSP.rnn || DSP.rnnLoad) return DSP.rnnLoad;
  DSP.rnnLoad = import("/static/vendor/rnnoise/rnnoise.js").then(m => m.Rnnoise.load()).then(r => { DSP.rnn = r; DSP.rnnErr = ""; WW.emit("dsp", DSP.opts); return r; })
    .catch(e => { DSP.rnnErr = e.message || String(e); DSP.rnnLoad = null; WW.emit("dsp", DSP.opts); toast("KI-Rauschminderung nicht verfügbar: " + DSP.rnnErr, true); });
  return DSP.rnnLoad;
}
function dspRnnNr(rate) {
  const up = 48000 / rate, fr = new Float32Array(480); let st = null, fn = 0, inPos = 0, last = 0;
  let ob = new Float32Array(48000), ow = 0, t = 0, primed = false;                    // Ausgang bei 48 kHz, t = Leseposition
  const put = o => { if (ow + o.length > ob.length) { const keep = Math.max(0, Math.floor(t) - 1); ob.copyWithin(0, keep, ow); ow -= keep; t -= keep;
      if (ow + o.length > ob.length) { const nb = new Float32Array((ow + o.length) * 2); nb.set(ob.subarray(0, ow)); ob = nb; } } ob.set(o, ow); ow += o.length; };
  const push48 = (v, lvl) => { fr[fn++] = v * 32768; if (fn < 480) return; fn = 0;
    const dry = fr.slice(), wet = Math.min(1, 0.6 + lvl * 0.4); st.processFrame(fr);
    const o = new Float32Array(480); for (let i = 0; i < 480; i++) o[i] = (fr[i] * wet + dry[i] * (1 - wet)) / 32768; put(o); };
  return (x, lvl) => {
    if (!DSP.rnn) { dspRnnLoad(); return x; }
    if (!st) st = DSP.rnn.createDenoiseState();
    for (let i = 0; i < x.length; i++) { const v = x[i];                                 // hoch auf 48 kHz (Ton ist schmalbandig: linear genuegt)
      while (inPos < 1) { push48(last + (v - last) * inPos, lvl); inPos += 1 / up; } inPos -= 1; last = v; }
    const y = new Float32Array(x.length);
    if (!primed) { if (ow - t < x.length * up + 960) return y; primed = true; }             // Vorlauf: ein bis zwei Rahmen
    for (let i = 0; i < x.length; i++) { const k = Math.floor(t); if (k + 1 >= ow) { primed = false; break; }
      y[i] = ob[k] + (ob[k + 1] - ob[k]) * (t - k); t += up; }                             // zurueck auf die Quellrate
    return y; };
}

// ---------- Automatische Notch (adaptiver Linienpraediktor: entfernt gleichbleibende Toene, Sprache bleibt) ----------
function dspAnf(rate) {
  const L = Math.round(rate * 0.004), Dl = Math.max(1, Math.round(rate * 0.001)), M = L + Dl + 2, h = new Float32Array(L), xb = new Float32Array(2 * M);
  let p = 0, pw = 1e-6;                                                                    // Ringpuffer doppelt: xb[p..p+M) = neueste zuerst
  return x => { const y = new Float32Array(x.length), mu = 0.01;
    for (let i = 0; i < x.length; i++) {
      xb[p] = xb[p + M] = x[i]; const o = p + Dl + 1; let pred = 0;
      for (let k = 0; k < L; k++) pred += h[k] * xb[o + k];
      const e = x[i] - pred, d = xb[o]; pw = 0.999 * pw + 0.001 * d * d;
      const g = mu * e / (pw * L + 1e-7); for (let k = 0; k < L; k++) h[k] = h[k] * 0.99995 + g * xb[o + k];
      y[i] = e; p = (p - 1 + M) % M; }
    return y; };
}

// ---------- Eigene Notches (Frequenz im Band, Lage im Ton je nach Betriebsart) ----------
function dspAudioOf(f, st, receiver) {
  const d = st?.freq || 0, m = (st?.mode || "USB").toUpperCase(); if (!d) return 0;
  if (m === "LSB" || m === "PKTLSB" || m === "RTTY") return d - f;
  if (m === "CWR") return d - f + (receiver ? 0 : (WW.settings?.cw_pitch || 600));
  if (m === "CW") return f - d + (receiver ? 0 : (WW.settings?.cw_pitch || 600));
  if (m === "AM" || m === "SAM" || m === "FM") return Math.abs(f - d);
  return f - d;
}
function dspNotches(rate) {
  let filt = [], key = "";
  return (x, st, receiver) => {
    const fs = DSP.opts.notches.map(f => dspAudioOf(f, st, receiver)).filter(a => a > 30 && a < rate / 2 - 50), k = fs.map(Math.round).join() + "|" + DSP.opts.notchW;
    if (k !== key) { key = k; const old = filt; filt = fs.map((f0, i) => { const w = 2 * Math.PI * f0 / rate, Q = Math.max(2, f0 / Math.max(20, DSP.opts.notchW)), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      return { b0: 1 / a0, b1: -2 * Math.cos(w) / a0, b2: 1 / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, z1: old[i]?.z1 || 0, z2: old[i]?.z2 || 0 }; }); }
    if (!filt.length) return x;
    const y = Float32Array.from(x);
    for (const q of filt) for (let i = 0; i < y.length; i++) { const v = y[i], o = q.b0 * v + q.z1; q.z1 = q.b1 * v - q.a1 * o + q.z2; q.z2 = q.b2 * v - q.a2 * o; y[i] = o; }
    return y; };
}

// ---------- Kette je Tonquelle ----------
function dspChain() {
  let rate = 0, nb, nr, rnn, anf, nt;
  const reset = r => { rate = r; nb = dspNb(r); nr = dspSpecNr(r); rnn = dspRnnNr(r); anf = dspAnf(r); nt = dspNotches(r); };
  return (x, r, st, receiver) => {
    if (!dspActive()) return x;
    if (r !== rate) reset(r);
    const o = DSP.opts; let y = x;
    try {
      if (o.nb) y = nb(y, o.nbLvl);
      if (o.notches.length) y = nt(y, st, receiver);
      if (o.anf) y = anf(y);
      if (o.nr === "spec") y = nr(y, o.nrLvl); else if (o.nr === "ai") y = rnn(y, o.nrLvl);
    } catch (e) { console.error("Rauschfilter", e); return x; }
    return y; };
}

// ---------- Ton des Funkgeraets (CAT) ueber die Soundkarte am PC hoeren – damit wirken die Rauschfilter auch dort ----------
const RIGAUD = { on: false, ctx: null, stream: null, node: null, err: "" };
async function rigAudioStart(dev) {
  rigAudioStop();
  if (!navigator.mediaDevices?.getUserMedia) { RIGAUD.err = "Soundkarte nur im Desktop-Programm, über localhost oder https"; WW.emit("rigaudio"); throw new Error(RIGAUD.err); }
  const ctx = new AudioContext(), stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const src = ctx.createMediaStreamSource(stream), gain = ctx.createGain(), push = pcmScheduler(ctx, gain), chain = dspChain();
  gain.connect(ctx.destination);
  const sp = ctx.createScriptProcessor(2048, 1, 1);                  // ohne AudioWorklet: laeuft auch ueber http (Fernbedienung)
  sp.onaudioprocess = e => { const x = Float32Array.from(e.inputBuffer.getChannelData(0)); push(chain(x, ctx.sampleRate, WW.rig, false), ctx.sampleRate); };
  const mute = ctx.createGain(); mute.gain.value = 0; src.connect(sp); sp.connect(mute).connect(ctx.destination);
  Object.assign(RIGAUD, { on: true, ctx, stream, node: sp, gain, err: "" }); rigAudioGain(); store.set("rigaud", { on: true, dev });
  if (ctx.state !== "running") ["pointerdown", "keydown"].forEach(ev => document.addEventListener(ev, () => ctx.resume(), { once: true }));
  WW.emit("rigaudio");
}
function rigAudioStop(save) { try { RIGAUD.node?.disconnect(); RIGAUD.stream?.getTracks().forEach(t => t.stop()); RIGAUD.ctx?.close(); } catch { }
  Object.assign(RIGAUD, { on: false, ctx: null, stream: null, node: null }); if (save) store.set("rigaud", { ...store.get("rigaud", {}), on: false }); WW.emit("rigaudio"); }
function rigAudioGain() { if (RIGAUD.gain) RIGAUD.gain.gain.value = store.get("rigaud.vol", 1); }

// ---------- Fenster „Rauschfilter“ ----------
function createDspPanel(root) {
  root.innerHTML = `<div class="dspp"></div>`;
  const box = $(".dspp", root);
  const draw = async () => {
    const o = DSP.opts, r = (WW.radios || []).find(x => x.id === WW.current), rx = isSdr(r), hwNb = rx && (WW.caps?.funcs_set || []).includes("NB");
    let devs = []; try { devs = (await navigator.mediaDevices?.enumerateDevices() || []).filter(d => d.kind === "audioinput"); } catch { }
    const ra = store.get("rigaud", {});
    box.innerHTML = `
      <div class="dsp-row"><label class="chk"><input type="checkbox" data-o="nb" ${o.nb ? "checked" : ""}> <b>NB</b> Störimpulse austasten</label>
        <input type="range" data-o="nbLvl" min="1" max="10" step="1" value="${o.nbLvl}" title="Empfindlichkeit"><span class="hint">${o.nbLvl}</span>
        ${hwNb ? `<label class="chk" title="Austaster des Empfängers auf den IQ-Daten – wirkt besser als im Ton"><input type="checkbox" data-hw="NB" ${WW.rig?.funcs?.NB ? "checked" : ""}> im Empfänger (IQ)</label>` : ""}</div>
      <div class="dsp-row"><b>NR</b> <div class="dsp-seg">${[["off", "aus"], ["spec", "Spektral"], ["ai", "KI (RNNoise)"]].map(([k, l]) => `<button type="button" data-nr="${k}" class="${o.nr === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <input type="range" data-o="nrLvl" min="0" max="1" step="0.05" value="${o.nrLvl}" title="Stärke"><span class="hint">${Math.round(o.nrLvl * 100)} %</span>
        ${o.nr === "ai" ? `<span class="hint">${DSP.rnn ? "KI geladen" : DSP.rnnErr ? "Fehler: " + esc(DSP.rnnErr) : "lädt …"}</span>` : ""}</div>
      <div class="dsp-row"><label class="chk"><input type="checkbox" data-o="anf" ${o.anf ? "checked" : ""}> <b>ANF</b> Pfeiftöne automatisch entfernen</label></div>
      <div class="dsp-row"><b>Notch</b> ${o.notches.length ? o.notches.map((f, i) => `<span class="dsp-chip">${fmtMHz(f)} <button type="button" data-del="${i}" title="Entfernen">×</button></span>`).join("") : `<span class="hint">Rechtsklick im Wasserfall → „Notch hier“</span>`}
        <label class="chk">Breite <select data-o="notchW">${[40, 80, 150, 300].map(w => `<option ${w === o.notchW ? "selected" : ""}>${w}</option>`).join("")}</select> Hz</label>
        ${o.notches.length ? `<button type="button" data-a="clear">alle löschen</button>` : ""}</div>
      ${rx ? `<p class="hint">Wirkt auf den Ton dieses Empfängers. Digitale Dekoder bekommen weiter den unbearbeiteten Ton.</p>` : `
      <div class="dsp-row"><label class="chk"><input type="checkbox" data-a="rigaud" ${RIGAUD.on ? "checked" : ""}> Ton des Funkgeräts über den PC hören</label>
        <select data-a="rigdev"><option value="">Standard-Eingang</option>${devs.map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === ra.dev ? "selected" : ""}>${esc(d.label || "Eingang")}</option>`).join("")}</select></div>
      <p class="hint">${RIGAUD.err ? esc(RIGAUD.err) : "Die Rauschfilter wirken auf den Ton, den der PC hört: USB-Soundkarte des Funkgeräts als Eingang wählen und den Lautsprecher am Gerät leise stellen. Die Filter im Funkgerät selbst (NB, NR, Notch) schaltest du über die Tasten der Geräteanzeige."}</p>`}`;
  };
  box.addEventListener("input", e => { const k = e.target.dataset.o; if (!k) return; const v = e.target.type === "checkbox" ? e.target.checked : e.target.tagName === "SELECT" ? +e.target.value : +e.target.value;
    dspSet({ [k]: v }); if (e.target.type === "range") e.target.nextElementSibling.textContent = k === "nrLvl" ? Math.round(v * 100) + " %" : v; });
  box.addEventListener("change", async e => { const t = e.target;
    if (t.dataset.hw) return act("/api/rig/func", { name: t.dataset.hw, on: t.checked });
    if (t.dataset.a === "rigaud") { try { t.checked ? await rigAudioStart($('[data-a="rigdev"]', box)?.value || "") : rigAudioStop(true); } catch (err) { t.checked = false; toast(err.message, true); } draw(); }
    if (t.dataset.a === "rigdev") { store.set("rigaud", { ...store.get("rigaud", {}), dev: t.value }); if (RIGAUD.on) rigAudioStart(t.value).catch(err => toast(err.message, true)); } });
  box.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.nr) dspSet({ nr: b.dataset.nr });
    if (b.dataset.del) { const n = DSP.opts.notches.slice(); n.splice(+b.dataset.del, 1); dspSet({ notches: n }); }
    if (b.dataset.a === "clear") dspSet({ notches: [] }); });
  const offs = [WW.on("dsp", draw), WW.on("radios", draw), WW.on("caps", draw), WW.on("rigaudio", draw)]; draw();
  return () => offs.forEach(f => f());
}
function dspNotchAt(f) { const n = DSP.opts.notches.filter(x => Math.abs(x - f) > 20); n.push(Math.round(f)); dspSet({ notches: n.slice(-6) }); toast(`Notch bei ${fmtMHz(f)} MHz`); }
APPS.rig.panels.dsp = { title: "Rauschfilter", create: createDspPanel, dock: { ref: ["sliders", "face"], dir: "within" } };
if (DSP.opts.nr === "ai") setTimeout(dspRnnLoad, 2000);
setTimeout(() => { const ra = store.get("rigaud", {}); if (ra.on && navigator.mediaDevices?.getUserMedia) rigAudioStart(ra.dev || "").catch(() => { }); }, 2500);
