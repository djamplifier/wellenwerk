"use strict";
// Wellenwerk – Signalerkennung in der Oberflaeche. Klick auf ein Signal im Wasserfall: Geraet so abstimmen, dass das Signal
// bei 1500 Hz im Ton liegt (wie bei Digitalprogrammen ueblich), einige Sekunden aufnehmen und anzeigen, was es ist
// (Analyse: sigid.js im Hintergrund-Worker). Im Digitalbetrieb wird ohne Umstimmen an der angeklickten Tonfrequenz gemessen.
const SIG = { worker: null, seq: 0, jobs: new Map(), run: null, tags: [] };
const SIG_SB = { USB: false, PKTUSB: false, DIGU: false, LSB: true, PKTLSB: true, DIGL: true };   // Seitenband-Betriebsarten: true = Kehrlage
function sigWorker() {
  if (SIG.worker) return SIG.worker;
  const v = ((document.querySelector('script[src*="sigid-ui.js"]') || {}).src || "").match(/[?&]v=([^&]+)/);
  SIG.worker = new Worker(`/static/js/sigid-worker.js?v=${v ? v[1] : ""}`);
  SIG.worker.onmessage = e => { const j = SIG.jobs.get(e.data.id); if (!j) return; SIG.jobs.delete(e.data.id); e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data.res); };
  SIG.worker.onerror = e => { SIG.jobs.forEach(j => j.reject(new Error(e.message || "Analyse fehlgeschlagen"))); SIG.jobs.clear(); SIG.worker = null; };
  return SIG.worker;
}
function sigAnalyze(x, opts) { return new Promise((resolve, reject) => { const id = ++SIG.seq; SIG.jobs.set(id, { resolve, reject }); sigWorker().postMessage({ id, x, opts }); }); }
// FT8/FT4 dekodieren (ft8_lib im Worker): [{snr, dt, f, text}]
function sigFtx(x, ft4) { return new Promise((resolve, reject) => { const id = ++SIG.seq; SIG.jobs.set(id, { resolve, reject }); sigWorker().postMessage({ id, x, ftx: { ft4, rate: 8000 } }); }); }
const sigRadio = id => (WW.radios || []).find(r => r.id === (id || WW.current));
const sigState = id => sigRadio(id)?.state || WW.rig || {};
const sigRig = (id, what, body) => id && id !== WW.current ? api(`/api/radios/${encodeURIComponent(id)}/rig/${what}`, { method: "POST", body }) : post(`/api/rig/${what}`, body);

// letzte Spektrumzeilen je Geraet (HF-Spektrum): Signalmitte bestimmen, um genau abzustimmen
const SIG_LINES = new Map();
WW.on("spectrum", l => { let a = SIG_LINES.get(l.radio); if (!a) SIG_LINES.set(l.radio, a = []); a.push({ t: Date.now(), l }); while (a.length > 400 || a[0].t < Date.now() - 6000) a.shift(); });
const sigLines = (id, ms = 6000) => (SIG_LINES.get(id) || []).filter(x => x.t > Date.now() - ms).map(x => x.l);
// Mitte des Signals nahe f im HF-Spektrum (Maximum ueber die Zeilen, damit auch Bursts wie DMR zaehlen): zusammenhaengende Bereiche
// ueber dem Rauschen, je Bereich Leistungsschwerpunkt; gewaehlt wird der dem Klick naechste (Mitte hoechstens hw entfernt),
// so zieht ein starker Nachbarkanal nicht weg. null: kein klares Signal
function sigRfCenter(lines, f, hw) {
  if (!lines || !lines.length || !f) return null;
  const l0 = lines[lines.length - 1], n = l0.data.length, hz = (l0.high - l0.low) / n; if (hz > 3000 || f < l0.low || f > l0.high) return null;
  const mx = new Float32Array(n).fill(-1e9), avg = new Float32Array(n); let k = 0;
  for (const l of lines) { if (l.low !== l0.low || l.high !== l0.high || l.data.length !== n) continue; for (let i = 0; i < n; i++) { const v = l.data[i]; if (v > mx[i]) mx[i] = v; avg[i] += v; } k++; }
  if (!k) return null; for (let i = 0; i < n; i++) avg[i] /= k;
  const bin = x => Math.max(0, Math.min(n - 1, Math.round((x - l0.low) / hz - 0.5))), fOf = i => l0.low + (i + 0.5) * hz;
  const ref = [...avg.subarray(bin(f - 8 * hw), bin(f + 8 * hw) + 1)].sort((x, y) => x - y), floor = ref[Math.floor(ref.length * 0.3)];
  const a = bin(f - 3 * hw), b = bin(f + 3 * hw), best = { d: Infinity };
  for (let i = a; i <= b; i++) {
    if (!(mx[i] > floor + 8)) continue;
    let e = i; while (e < b && mx[e + 1] > floor + 8) e++;
    let pk = i; for (let q = i; q <= e; q++) if (mx[q] > mx[pk]) pk = q;
    const thr = mx[pk] - Math.min(12, (mx[pk] - floor) * 0.6); let lo = pk, hi = pk;
    while (lo > i && mx[lo - 1] >= thr) lo--; while (hi < e && mx[hi + 1] >= thr) hi++;
    let sw = 0, sf = 0; for (let q = lo; q <= hi; q++) { const w = Math.pow(10, (mx[q] - floor) / 10); sw += w; sf += w * fOf(q); }
    const c = sf / sw, d = Math.abs(c - f);
    if (d <= hw && d < best.d) Object.assign(best, { d, center: Math.round(c), bw: Math.round((hi - lo + 1) * hz), snr: Math.round(mx[pk] - floor), res: hz });
    i = e;
  }
  return best.center ? { center: best.center, bw: best.bw, snr: best.snr, res: best.res } : null;
}

// Tonquelle mit 8 kHz: Empfaenger direkt aus dem Datenstrom, sonst der Eingang des Digitalbetriebs (Soundkarte)
async function sigTap(o, fn) {
  const r = sigRadio(o.radio);
  if (!o.dmTap && isSdr(r)) return rxPcm(r.id, rxTo8k(x => fn(x)));
  const off = WW.on("dm-pcm", fn);
  if (D.running) return off;
  await dmStart(store.get("dm.in", ""));
  if (!D.running) { off(); throw new Error("Kein Ton – im Digitalbetrieb den Eingang (Soundkarte des Funkgeräts) wählen"); }
  return () => { off(); dmStop(); };
}

// Klick im Wasserfall eines Geraets/Empfaengers (f in Hz). Rueckgabe true: Klick erledigt (abgestimmt + Erkennung laeuft)
// tapId: Geraet, dessen Ton analysiert wird (SDR als Panadapter folgt dem Funkgeraet und liefert den Ton)
// AM im HF-Spektrum (SDR-Wasserfall): starker Traeger mit symmetrischen Seitenbaendern 1..6 kHz daneben.
// Im Ton (USB/LSB) ist nur ein Seitenband sichtbar – daher die Pruefung am Spektrum.
function sigRfAm(lines, f) {
  if (!lines || lines.length < 4 || !f) return null;
  const l0 = lines[lines.length - 1], n = l0.data.length, hz = (l0.high - l0.low) / n; if (hz > 1500 || f < l0.low || f > l0.high) return null;
  const avg = new Float32Array(n); let k = 0; for (const l of lines) { if (l.low !== l0.low || l.high !== l0.high || l.data.length !== n) continue; for (let i = 0; i < n; i++) avg[i] += l.data[i]; k++; }
  if (k < 4) return null; for (let i = 0; i < n; i++) avg[i] /= k;
  const bin = x => Math.round((x - l0.low) / hz), c0 = bin(f), w = Math.max(1, Math.round(300 / hz));
  let cb = c0, cp = -1e9; for (let i = c0 - w; i <= c0 + w; i++) if (i >= 0 && i < n && avg[i] > cp) { cp = avg[i]; cb = i; }
  const mean = (a, b) => { let s = 0, m = 0; for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) { s += avg[i]; m++; } return m ? s / m : NaN; };
  const lo = mean(cb - Math.round(6000 / hz), cb - Math.round(1000 / hz)), hi = mean(cb + Math.round(1000 / hz), cb + Math.round(6000 / hz));
  const floor = [...avg].sort((a, b) => a - b)[Math.floor(n * 0.3)], dyn = cp - floor;
  if (!(dyn > 12) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const am = lo > floor + dyn * 0.12 && hi > floor + dyn * 0.12 && Math.abs(lo - hi) < dyn * 0.35 && cp > Math.max(lo, hi) + dyn * 0.25;
  return am ? { carrier: Math.round(l0.low + (cb + 0.5) * hz) } : null;
}
function sigOnClick(radioId, f, e, tapId, rfLines) {
  if (e && e.altKey) return false;                                   // Alt+Klick: nur abstimmen
  if (wfOpts().sig === false) return false;
  const dr = sigRadio(tapId || radioId), decs = dr?.state?.sdr?.decoders || [];
  const st0 = sigState(radioId), ssbSeg = SIG_SB[st0.mode] !== undefined && SIG_NB.some(([a, z]) => f >= a && f <= z);   // Schmalband-Segmente (SSB/CW/Baken): kein Digitalfunk
  if (decs.length && f <= 30e6) { const L = sigProbeList(f, decs); if (L.length && SIG_FIXF[L[0]]) { sigProbe({ radio: dr.id, ctl: radioId || dr.id, rf: f, x: e?.clientX, y: e?.clientY }, L.slice(0, 1), decs); return true; } }
  if (f > 30e6 && !ssbSeg && typeof fmkRepAt === "function" && wfOpts().mrep !== false) {   // bekanntes Relais: Daten aus der Datenbank, nichts erraten
    const rep = fmkRepAt(f); if (rep) { fmkRepeater(rep, radioId || dr?.id, dr?.id, e); return true; } }
  if (f > 30e6 && !ssbSeg && (decs.length || isSdr(dr) || sigProbeList(f, []).length)) {   // auch Funkgeraet: APRS ueber die Soundkarte
    const lines = rfLines && rfLines.length ? rfLines : sigLines(dr.id, 4000), am = sigRfAm(lines, f), air = f >= 108e6 && f <= 137e6;
    sigProbe({ radio: dr.id, ctl: radioId || dr.id, rf: f, x: e?.clientX, y: e?.clientY, am: am || air ? { carrier: am?.carrier, air } : null }, sigProbeList(f, decs), decs); return true; }
  const st = sigState(radioId), inv = SIG_SB[st.mode];
  if (inv === undefined) return false;                               // AM/FM/CW: wie bisher direkt abstimmen
  const dial = Math.round(inv ? f + 1500 : f - 1500);
  sigRig(radioId, "freq", { hz: dial }).catch(err => toast(err.message, true));
  sigIdentify({ radio: tapId || radioId || WW.current, ctl: radioId || WW.current, rfAm: sigRfAm(rfLines && rfLines.length ? rfLines : sigLines(tapId || radioId || WW.current, 4000), f), fc: 1500, rf: f, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: tapId ? 1.8 : 1.2 });
  return true;
}
// Klick im Wasserfall des Digitalbetriebs (Tonfrequenz af): ohne Umstimmen
function sigOnDmClick(af, e) {
  if (wfOpts().sig === false || !D.running) return;
  const st = sigState(), inv = !!SIG_SB[st.mode], dial = st.freq || 0;
  sigIdentify({ radio: WW.current, dmTap: true, fc: af, rf: dial ? (inv ? dial - af : dial + af) : 0, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: 0 });
}

// ---------- VHF/UHF: Dekoder des Empfaengers (OpenWebRX) durchprobieren ----------
const SIG_NB = [[50e6, 50.5e6], [70e6, 70.25e6], [144e6, 144.5e6], [432e6, 432.5e6], [1296e6, 1296.8e6], [2320e6, 2320.5e6], [10368e6, 10368.5e6], [10489.5e6, 10490e6]];
const SIG_FIXED = ["packet", "ism", "sonde", "ais", "adsb", "lora-aprs", "meshcom", "meshtastic", "meshcore", "dsc", "navtex"];
// feste Frequenzen der Dienste (Mitte des Signals); Kurzwelle: abgestimmt wird 1500 Hz tiefer (USB), der Dekoder sitzt bei 1500 Hz im Ton
const SIG_FIXF = { ais: [161975000, 162025000], adsb: [1090000000], "lora-aprs": [433775000], meshcom: [433175000], meshtastic: [869525000], meshcore: [869618000],
  dsc: [156525000, 2187500, 4207500, 6312000, 8414500, 12577000, 16804500], navtex: [490000, 518000, 4209500] };
const sigFixF = (id, f) => (SIG_FIXF[id] || []).reduce((b, x) => Math.abs(x - f) < Math.abs(b - f) ? x : b, f);              // nach Frequenz eindeutig: Dekoder bleibt an, Meldungen kommen in Abstaenden
function sigProbeList(f, decs) {
  const has = id => decs.some(d => d.id === id), near = (a, t = 8000) => Math.abs(f - a) < t, L = [];
  if ([144800000, 144390000, 144575000, 145825000, 144640000, 144660000, 432500000].some(a => near(a))) L.push("packet");
  if ((f >= 433.05e6 && f <= 434.79e6) || (f >= 868e6 && f <= 868.6e6) || (f >= 314e6 && f <= 316e6) || (f >= 915e6 && f <= 928e6)) L.push("ism");
  if (f >= 400e6 && f <= 406.1e6) L.push("sonde");
  for (const [id, fs] of Object.entries(SIG_FIXF)) if (fs.some(x => near(x, x > 30e6 ? (id === "adsb" ? 1.5e6 : id.startsWith("mesh") || id === "lora-aprs" ? 70000 : 12500) : 1200))) L.unshift(id);   // vor ISM: LoRa liegt im 433-MHz-Band
  if (f >= 50e6) L.push("dmr", "dstar", "ysf", "m17", "nxdn", "p25");
  return [...new Set(L)].filter(id => has(id) || SIG_LOCAL.has(id));
}
const SIG_LOCAL = new Set(["packet"]);                     // dekodiert Wellenwerk selbst – auch ohne Dekoder im Empfaenger
async function sigProbe(o, list, decs, opt = {}) {
  sigCancel();
  const R = SIG.run = { o, stop: false, card: sigCard(o) }, c = R.card, body = $(".sig-body", c), name = id => (decs.find(d => d.id === id) || {}).label || id;
  const T0 = Date.now(), fx = SIG_FIXED.includes(list[0]) ? list[0] : "";
  // Digitalfunk: auf die gemessene Signalmitte abstimmen (Klick ist selten genau, DMR/D-STAR brauchen die Mitte auf wenige 100 Hz);
  // liegt sie nahe am Kanalraster (6,25 kHz), aufs Raster. Ohne Signal im Moment: Raster, die Mitte wird nachgefuehrt, sobald gesendet wird
  // aufs Raster nur innerhalb der Messgenauigkeit (Aufloesung des Spektrums), echte Ablagen bleiben erhalten
  const snap = (c, res = 600) => { const t = tuneRaster(c, o.am ? "AM" : "FM"), r = Math.round(Math.round((c - t.base) / t.step) * t.step + t.base);   // Abstimmraster des Bandes (z. B. 6,25/12,5 kHz)
    return Math.abs(c - r) <= Math.min(1500, Math.max(200, res * 0.65)) ? r : Math.round(c / 50) * 50; };
  const meas = (at, ms, hw = 7500) => sigRfCenter(sigLines(o.radio, ms), at, hw);
  const m0 = fx ? null : meas(o.rf, 3000);
  let f = fx === "ism" ? (Math.abs(o.rf - 433.92e6) < 60e3 ? 433920000 : Math.abs(o.rf - 868.3e6) < 300e3 ? 868300000 : o.rf) : SIG_FIXF[fx] ? sigFixF(fx, o.rf) : fx ? Math.round(o.rf / 6250) * 6250 : (m0 ? snap(m0.center, m0.res) : Math.round(o.rf / 6250) * 6250);
  const hfText = fx && f < 30e6;                                                  // NAVTEX/DSC auf Kurzwelle: USB, Signal bei 1500 Hz im Ton
  if (o.keep) f = sigState(o.ctl).freq || f;                                      // Dekoder fuer die aktuelle Einstellung (z. B. FT8 im Empfaenger)
  // AM (Flugfunk, Traeger mit zwei Seitenbaendern): auf den Traeger bzw. das 8,33-kHz-Raster
  if (o.am) f = o.am.carrier ? snap(o.am.carrier) : o.am.air ? snapRaster(o.rf, "AM") : f;
  if (o.rep) f = o.rep.f;                                                         // Relais aus der Datenbank: genau dessen Frequenz
  R.track = !fx && !o.am && !o.rep && !o.keep; R.f0 = f; R.f0m = m0 ? f : 0;
  // waehrend der Pruefung und des Empfangs: Mitte erneut messen und nachstimmen (max. 12,5 kHz vom Klick weg)
  R.retune = async () => { if (!R.track || R.stop || Date.now() - (R.tuned || 0) < 1500) return false; const m = meas(f, 1500, 4500); if (!m || m.bw < 2000) return false;
    const nf = snap(m.center, m.res); if (Math.abs(nf - f) < Math.max(300, m.res * 0.6) || Math.abs(nf - o.rf) > 12500 || (R.f0m && Math.abs(nf - R.f0m) > 3000)) return false;   // nicht weiter als 3 kHz von der ersten Messung (Nachbarkanal)
    R.tuned = Date.now(); f = nf; R.f0m ||= nf; await sigRig(o.ctl, "freq", { hz: f }).catch(() => { }); R.onTune?.(f); return true; };
  const active = () => !!meas(f, 1200, 4500);          // sendet dort gerade jemand?
  const setDec = m => api(`/api/radios/${encodeURIComponent(o.radio)}/rig/decoder`, { method: "POST", body: { mode: m } });
  const msgs = [];
  R.un = WW.on("decode", d => { if (d.radio !== o.radio || R.stop) return; msgs.push(d); R.onMsg?.(d); });
  const mod = o.am ? "AM" : "FM";
  if (!o.keep) try { await sigRig(o.ctl, "mode", { mode: hfText ? "USB" : mod, passband: 0 }); await sigRig(o.ctl, "freq", { hz: hfText ? f - 1500 : f }); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const secs = () => ((Date.now() - T0) / 1000).toFixed(1).replace(".", I18N.lang === "de" ? "," : ".");
  // Ergebnis ohne Digitalfunk (analog, Rauschen …) anzeigen
  const showAnalog = (fm, tried) => {
    body.innerHTML = `<div class="sig-res ${fm.score >= 0.7 ? "sure" : fm.score >= 0.5 ? "maybe" : "weak"}"><span class="sig-name">${esc(fm.label || "kein digitales Signal erkannt")}</span>${fm.score ? `<span class="sig-conf">${sigPct(fm.score)}</span>` : ""}</div>
      ${fm.facts && fm.facts.length ? `<div class="hint">${fm.facts.map(x => `<span>${esc(x)}</span>`).join(" · ")}</div>` : ""}
      ${tried && tried.length ? `<div class="hint">Digital geprüft (nichts gefunden): ${tried.map(name).map(esc).join(", ")}. Empfänger steht auf ${mod}.</div>` : `<div class="hint">Empfänger steht auf ${mod} · <span>nach ${secs()} s</span></div>`}
      ${fm.err ? `<div class="hint">Tonanalyse: ${esc(fm.err)}</div>` : ""}<div class="hint sig-db"></div><div class="sig-act"></div>`;
    $(".sig-bar", c).classList.add("done"); sigProgress(R, 1); if (fm.db && fm.db !== "FM") sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbHtml(f, { id: fm.db }, 0, !!bandFor(f)); });   // Sprechfunk/Traeger: Datenbank sagt nichts
    if (fm.label) SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - f) > 3000).concat({ rf: f, label: fm.tag || fm.label, until: Date.now() + 30000, radio: o.radio });
    const act = $(".sig-act", body), btn = (t, fn) => { const b = document.createElement("button"); b.textContent = t; b.onclick = fn; act.appendChild(b); };
    if (!tried && list.length && !o.am) btn(fm.probe ? "Dekoder des Servers durchprobieren" : "Digital trotzdem prüfen", () => sigProbe({ ...o, rf: f }, list, decs, { noPre: true }));
    btn("Nochmal", () => sigProbe(o, list, decs));
  };
  let found = "";
  if (fx === "packet" || (!fx && !list.length && opt.local === "packet")) return sigAprsLive(R, f, name("packet"));   // APRS liest Wellenwerk selbst
  if (fx) { found = fx; await setDec(fx).catch(e => { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; found = null; }); if (found === null) return; }
  else {
    // 1) schnell (2,5 s) in den Ton hoeren: Sprache, Unterton, Packet-Toene -> analog, fertig – kein Durchprobieren der Digitaldekoder.
    //    Digitalfunk klingt nach dem FM-Demodulator wie Rauschen; dann weiter mit 2)
    //    Gleichzeitig: eigene Digitalfunk-Erkennung am FM-Diskriminator (DMR, D-STAR, YSF, P25, NXDN, M17 auf einmal, 1,5 s)
    let pre = null, dv = null;
    if (!opt.noPre) {
      // bis zu 3 Versuche in rund 10 s: auf eine Aussendung warten, 1,5 s auswerten; war das Signal die ganze Zeit da und nichts gefunden -> fertig
      const dvP = o.am ? Promise.resolve(null) : (async () => { let idle = 0, last = null;
        for (let k = 0; k < 3 && !R.stop; k++) {
          for (const t0 = Date.now(); !active() && idle < 8000 && !R.stop; idle += 200) await new Promise(r => setTimeout(r, 200));
          if (!active()) return last || { idle: true };                            // 8 s keine Aussendung
          last = await api(`/api/radios/${encodeURIComponent(o.radio)}/rig/dvdetect`, { method: "POST", body: { secs: 1.5 } });
          if ((last.found || []).some(x => x.score >= 0.6)) return last;
          if (active() && k >= 1) return last;                                     // zweimal 1,5 s durchgehend gesendet, nichts gefunden
        }
        return last; })().catch(() => null);
      [pre, dv] = await Promise.all([sigFmAnalog(R, o, f, body, { secs: 2.5, mod, wait: 6 }).catch(e => ({ err: e.message })), dvP]); if (R.stop) return;
      const hit = (dv?.found || []).find(x => x.score >= 0.6);
      if (hit) {
        const sid = hit.id === "nxdn48" ? "nxdn" : hit.id;
        if (list.includes(sid)) { opt.only = sid; R.dv = hit; }                 // Server-Dekoder direkt waehlen
        else return sigDvResult(R, o, f, body, hit, mod, secs());               // eigenes Geraet: Verfahren anzeigen
      } else if (pre.analog || o.am || !list.length) return showAnalog(pre.analog || o.am || !list.length ? pre : { ...pre, label: "" }, null);
      else if (dv?.idle) return showAnalog({ ...pre, label: "gerade keine Aussendung", score: 0 }, null);
      else if (dv) return showAnalog(pre.rf ? { ...pre, label: "kein bekanntes Digitalverfahren erkannt", score: 0.3, probe: true } : { ...pre, label: "gerade keine Aussendung", score: 0 }, null);
    }
    // 2) Digitaldekoder des Servers – nur einer zur Zeit moeglich (ein Demodulator je Verbindung). Reihenfolge: was hier zuletzt gefunden wurde,
    //    dann nach gemessener Breite (schmal: D-STAR/NXDN, breit: DMR/YSF/M17/P25). Wartezeit zaehlt nur, solange gesendet wird
    const key = `${o.radio}:${Math.round(f / 1000)}`, last = SIG.found?.get(key), bw = (pre && pre.rf?.bw) || m0?.bw || 0;
    const narrow = ["dstar", "nxdn"], rank = id => (id === last ? -10 : 0) + (bw && bw < 7000 ? (narrow.includes(id) ? -2 : 0) : (narrow.includes(id) ? 2 : 0));
    const order = opt.only ? [opt.only] : list.map((id, i) => [id, rank(id) + i * 0.01]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    let waited = 0;
    if (opt.only) { try { await setDec(opt.only); found = opt.only; } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; } }
    for (let i = 0; i < order.length && !R.stop && !found; i++) {
      const id = order[i]; body.innerHTML = `<div class="hint">prüfe ${esc(name(id))} … (${i + 1}/${order.length})</div>`; sigProgress(R, 0.3 + 0.7 * i / order.length);
      try { await setDec(id); } catch { continue; }
      let on = 0, t = Date.now();
      while (!R.stop && on < 2200 && !msgs.some(d => d.decoder === id)) {
        await new Promise(r => setTimeout(r, 150)); const now = Date.now(), dt = now - t; t = now;
        if (active()) on += dt; else { waited += dt; if (waited > 8000) break;               // Sendepause: warten, hoechstens 8 s insgesamt
          const h = $(".hint", body); if (h) h.textContent = `prüfe ${name(id)} … (${i + 1}/${order.length}) – warte auf Aussendung`; }
        if (await R.retune()) on = 0;
      }
      if (msgs.some(d => d.decoder === id)) { found = id; break; }
      if (waited > 8000) break;
    }
    if (R.stop) return;
    if (!found) { await setDec("").catch(() => { }); R.track = false;
      const fm = pre && !pre.err ? pre : await sigFmAnalog(R, o, f, body, { secs: 3, mod }).catch(e => ({ err: e.message })); if (R.stop) return;
      return showAnalog(waited > 8000 ? { ...fm, label: "keine Aussendung während der Prüfung", score: 0 } : fm, order); }
    (SIG.found ||= new Map()).set(key, found);
  }
  $(".sig-bar", c).classList.add("done"); sigProgress(R, 1);
  body.innerHTML = `<div class="sig-res sure"><span class="sig-name">${esc(name(found))}</span><span class="sig-conf">${o.rep ? "Relais-Datenbank" : fx ? "nach Frequenz" : R.dv ? `Synchronmuster erkannt · ${secs()} s` : "Synchronmuster erkannt"}</span></div>
    ${o.rep ? `<div class="hint"><b>${esc(o.rep.c)}</b> · ${fmkRepFacts(o.rep).map(x => `<span>${esc(x)}</span>`).join(" · ")}</div>` : ""}
    <div class="hint"><span>Dekoder des Empfängers läuft</span> · <span class="sig-tf">${fmtMHz(f)}</span> MHz · <span>Meldungen auch im Fenster „Datenempfang“</span></div>
    ${!fx && Math.abs(f - o.rf) >= 500 ? `<div class="hint sig-auto">✓ <span>auf Signalmitte abgestimmt (${f > o.rf ? "+" : "−"}${(Math.abs(f - o.rf) / 1000).toFixed(1)} kHz)</span></div>` : ""}
    <div class="sig-live"><div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: ${esc(name(found))}</b><i class="grow"></i><button type="button" class="sig-live-x">Dekoder aus</button></div><pre translate="no"></pre></div>
    <div class="hint sig-db"></div><div class="sig-act"></div>`;
  const pre = $("pre", body); let got = [];
  // Zeilen bei jedem Neuzeichnen aus den Meldungen bilden – so erscheinen Namen (Rufzeichen, Talkgroup), sobald sie nachgeladen sind
  const render = () => { const L = got.map(d => [d, decSummary(d)]).filter(x => x[1].trim()).slice(-60).map(([d, s]) => `${new Date((d.t || Date.now() / 1000) * 1000).toLocaleTimeString(I18N.locale)}  ${s}`);
    if (L.length) { pre.textContent = L.join("\n"); pre.scrollTop = 1e9; } };
  const add = d => { if (d.decoder !== found) return; got.push(d); if (got.length > 300) got = got.slice(-200); render(); };
  const offIds = WW.on("ids", () => { if (pre.isConnected) render(); else offIds(); });
  pre.textContent = fx ? "warte auf die nächste Aussendung …" : ""; msgs.forEach(add); R.onMsg = add;
  // Nachfuehren, solange der Dekoder laeuft (Sender mit Ablage, Drift); Handabstimmen beendet es
  R.onTune = nf => { const el = $(".sig-tf", body); if (el) el.textContent = fmtMHz(nf); SIG.tags.forEach(t => { if (t.radio === o.radio && t.label === name(found)) t.rf = nf; }); };
  (async () => { while (!R.stop && R.track && SIG.run === R) { await new Promise(r => setTimeout(r, 1000)); const cur = sigState(o.ctl).freq;
    if (cur && Math.abs(cur - f) > 50 && Date.now() - (R.tuned || 0) > 2500) { R.track = false; break; } await R.retune(); } })();
  $(".sig-live-x", body).onclick = async () => { await setDec("").catch(() => { }); R.onMsg = null; R.track = false; body.querySelector(".sig-live").classList.add("off"); $(".sig-live-x", body).remove(); };
  sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbLink(found) || sigDbHtml(f, { id: found === "packet" ? "PACKET" : "FSK" }, 0, !!bandFor(f)); });
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - f) > 3000).concat({ rf: f, label: name(found), until: Date.now() + 60000, radio: o.radio });
}
// Digitalfunk mit der eigenen Erkennung gefunden (Geraet ohne Server-Dekoder, z. B. RTL-SDR)
function sigDvResult(R, o, f, body, hit, mod, secs) {
  const c = R.card, kinds = Object.entries(hit.kinds || {}).map(([k, n]) => `${k} ×${n}`);
  body.innerHTML = `<div class="sig-res sure"><span class="sig-name">${esc(hit.label)}</span><span class="sig-conf">${sigPct(hit.score)}</span></div>
    <div class="hint"><span>Synchronmuster erkannt (eigene Auswertung)</span> · <span>${hit.hits} Rahmen</span> · <span>nach ${secs} s</span>${hit.polarity < 0 ? " · <span>Kehrlage</span>" : ""}</div>
    ${kinds.length ? `<div class="hint">${kinds.map(esc).join(" · ")}</div>` : ""}
    ${Math.abs(f - o.rf) >= 500 ? `<div class="hint sig-auto">✓ <span>auf Signalmitte abgestimmt (${f > o.rf ? "+" : "−"}${(Math.abs(f - o.rf) / 1000).toFixed(1)} kHz)</span></div>` : ""}
    <div class="hint sig-db"></div><div class="sig-act"></div>`;
  $(".sig-bar", c).classList.add("done"); sigProgress(R, 1);
  sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbLink(hit.id) || sigDbHtml(f, { id: "FSK" }, 0, !!bandFor(f)); });
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - f) > 3000).concat({ rf: f, label: hit.label, until: Date.now() + 60000, radio: o.radio });
  const b = document.createElement("button"); b.textContent = "Nochmal"; b.onclick = () => sigProbe(o, sigProbeList(o.rf, []), []); $(".sig-act", body).appendChild(b);
}
// Ton nach dem Demodulator ansehen (FM bzw. AM): Sprache, Packet/Daten, CTCSS-Unterton, unmodulierter Traeger, Rauschen.
// analog: true, wenn der Inhalt analog erklaert ist (dann muessen die Digitaldekoder nicht durchprobiert werden)
async function sigFmAnalog(R, o, f, body, { secs = 6, mod = "FM", wait = 0 } = {}) {
  body.innerHTML = `<div class="hint">höre in den ${mod}-Ton (Sprache, Unterton, Daten) …</div>`;
  const live = () => sigRfCenter(sigLines(o.radio, 1200), f, 7500);
  for (const t0 = Date.now(); wait && !live() && Date.now() - t0 < wait * 1000 && !R.stop;) await new Promise(r => setTimeout(r, 200));   // kurz auf eine Aussendung warten
  const rf = live() || sigRfCenter(sigLines(o.radio, 3000), f, 7500), buf = []; let n = 0; const need = Math.round(secs * 8000);
  const un = await sigTap({ radio: o.radio }, x => { if (n < need) { buf.push(Float32Array.from(x)); n += x.length; } });
  try { const t0 = Date.now(); while (!R.stop && n < need) { if (Date.now() - t0 > secs * 1000 + 6000) throw new Error("kein Ton vom Empfänger"); sigProgress(R, 0.3 * n / need); await new Promise(r => setTimeout(r, 100)); } }
  finally { try { un(); } catch { } }
  if (R.stop) return {};
  const x = new Float32Array(n); let k = 0; for (const b of buf) { x.set(b, k); k += b.length; }
  const res = await sigAnalyze(x, { fc: 1500, rf: f }), t = SIGID.fmTones(x), id = res.best?.id || "", facts = [];
  if (t.ctcss && mod === "FM") facts.push(`CTCSS ${String(t.ctcss).replace(".", ",")} Hz`);
  if (rf) facts.push(`HF-Breite ca. ${(rf.bw / 1000).toFixed(1)} kHz`, `${rf.snr} dB über Rauschen`);
  const quiet = t.rms < 0.01, A = { rf, facts, analog: true };
  if (/^VOICE/.test(id) && res.best.score >= 0.5) return { ...A, label: mod === "AM" ? "AM-Sprechfunk" : "Analoges FM – Sprechfunk", tag: `${mod}-Sprache`, score: res.best.score, db: "FM" };
  if (id === "PACKET" || /AFSK|Packet/i.test(res.best?.label || "")) return { ...A, label: `${mod} mit Packet-/APRS-Tönen (AFSK)`, tag: "AFSK", score: res.best.score, db: "PACKET" };
  // nach dem FM-Demodulator ist Rauschen breit und flach – sieht aus wie Mehrtraeger-Digital (OFDM/MT63); das zaehlt hier nicht
  if (res.best && res.best.score >= 0.6 && !/^(NOISE|UNKNOWN|CARRIER|OFDM|MT63|FREEDV)/.test(id)) return { ...A, label: `${mod} mit Daten: ${res.best.label}`, tag: res.best.label.split(" · ")[0], score: res.best.score * 0.9, db: id };
  if (t.ctcss && mod === "FM") return { ...A, label: "FM-Träger mit Unterton (Relais/Funkgerät, gerade ohne Sprache)", tag: "FM + CTCSS", score: 0.7, db: "FM" };
  if (rf && quiet) return { ...A, label: `${mod}-Träger ohne Modulation`, tag: `${mod}-Träger`, score: 0.6, db: "FM" };
  if (!rf) return { rf, facts, analog: false, label: "kein Signal (nur Rauschen)", score: 0 };
  if (rf.snr >= 15 && rf.bw >= 4000) return { rf, facts, analog: false, label: "Signal ohne erkennbaren Inhalt – evtl. anderes Digitalverfahren oder verschlüsselt", tag: "unbekannt", score: 0.3, db: "FSK" };
  return { rf, facts, analog: false, label: "schwaches Signal – im FM-Ton nur Rauschen", score: 0.2, db: "FM" };
}
function sigCancel() { const R = SIG.run; if (!R) return; R.stop = true; try { R.un?.(); } catch { } try { R.live?.un?.(); } catch { } R.card?.remove(); SIG.run = null; }
// SSB-Sprache: Abstimmpunkt ist der unterdrueckte Traeger an der Kante des Seitenbands, nicht die Signalmitte.
// Ton a (Hz) entspricht der HF dial ± a. Gemessene Kante (20 dB unter dem Sprachpegel) liegt bei richtiger Abstimmung ~200 Hz neben dem Traeger.
// VOICE: Sprache beginnt deutlich hoeher im Ton -> zu tief abgestimmt. Zu hoch abgestimmt schneidet das Empfaengerfilter die Unterkante ab;
// dann nur bei klar fehlender Oberkante korrigieren (Senderfilter sind verschieden breit). VOICE_INV: falsches Seitenband, Traeger ueber der Oberkante.
// null: keine sichere Aussage (VOICE) – lieber nicht verstimmen
function sigSsbCarrier(o, b) {
  const rfOf = a => Math.round((o.inverted ? o.dial - a : o.dial + a) / 10) * 10, lo = b.vlo, hi = b.vhi;
  if (b.id === "VOICE_INV") return hi && hi < 2600 ? rfOf(hi + 210) : rfOf(o.fc + 1500);
  if (!lo || !hi) return null;
  if (lo > 330) return rfOf(lo - 210);
  if (hi < 1900 && lo <= 230) return rfOf(hi - 2400);
  return null;
}
// Nach der Erkennung (Option „automatisch umschalten“): AM/Seitenband einstellen bzw. den Inhalt live in der Karte mitschreiben
async function sigAuto(R, res) {
  const o = R.o, b = res.best; if (wfOpts().sigauto === false || R.stop || !b || b.score < 0.6) return;
  const c = R.card, ctl = o.ctl || o.radio, note = t => $(".sig-body", c)?.insertAdjacentHTML("beforeend", `<div class="hint sig-auto">✓ <span>${esc(t)}</span></div>`);
  try {
    const af = Math.round(b.center || res.center || o.fc);
    if (b.id === "AM" && o.dial && !o.dmTap) { const c = Math.round(o.inverted ? o.dial - af : o.dial + af), s = snapRaster(c, "AM"), hz = Math.abs(s - c) <= 600 ? s : c;   // Rundfunk: auf das Senderraster
      await sigRig(ctl, "mode", { mode: "AM", passband: 0 }); await sigRig(ctl, "freq", { hz }); note(`auf AM umgeschaltet · ${fmtMHz(hz)} MHz`); return; }
    if (b.id === "VOICE_INV" && o.dial && !o.dmTap) { const sb = o.inverted ? "USB" : "LSB", hz = sigSsbCarrier(o, b); await sigRig(ctl, "mode", { mode: sb, passband: 2700 }); await sigRig(ctl, "freq", { hz }); note(`auf ${sb} umgeschaltet · Träger ${fmtMHz(hz)} MHz`); return; }
    if (b.id === "VOICE" && o.dial && !o.dmTap) { const hz = sigSsbCarrier(o, b); if (hz && Math.abs(hz - o.dial) >= 120) { await sigRig(ctl, "freq", { hz }); note(`auf den Träger nachgestimmt (${(hz > o.dial) ? "+" : "−"}${Math.abs(hz - o.dial)} Hz)`); } return; }
  } catch (e) { note("Umschalten nicht möglich: " + e.message); return; }
  if (/^FT[48]$/.test(b.id)) return sigFtxLive(R, b.id);
  const mode = DM_ALL.includes(b.decode) ? b.decode : DM_ALL.includes(b.id) ? b.id : null;
  if (!mode || DIGI_MODES[mode]?.image) return;
  // genau abstimmen: Signalmitte auf 1500 Hz im Ton legen (Klick liegt meist etwas daneben; Dekoder fangen so sicher)
  let af = Math.round(b.center || res.center || o.fc);
  if (o.dial && !o.dmTap && Math.abs(af - 1500) >= 15 && Math.abs(af - 1500) < 1400) {
    const d = af - 1500; let dial = Math.round(o.inverted ? o.dial - d : o.dial + d);
    try { await sigRig(ctl, "freq", { hz: dial }); } catch (e) { note("Nachstimmen nicht möglich: " + e.message); dial = 0; }
    if (dial && !R.stop) { o.dial = dial; o.rf = Math.round(o.inverted ? dial - 1500 : dial + 1500); b.center = 1500; af = 1500;
      note(`auf Signalmitte abgestimmt (${d > 0 === !o.inverted ? "+" : "−"}${Math.abs(d)} Hz) · ${fmtMHz(o.rf)} MHz`); $(".sig-f", c).textContent = fmtMHz(o.rf) + " MHz";
      SIG.tags = SIG.tags.filter(t => !(t.radio === o.radio && Math.abs(t.rf - o.rf) < 1500)); sigTag(o, res); await new Promise(r => setTimeout(r, o.radio !== ctl ? 1500 : 800)); if (R.stop) return; }
  }
  const box = document.createElement("div"); box.className = "sig-live";
  box.innerHTML = `<div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: ${esc(DIGI_MODES[mode]?.label || mode)}</b><i class="grow"></i><button type="button" class="sig-live-x">Stopp</button></div><pre translate="no"></pre>`;
  $(".sig-body", c).insertBefore(box, $(".sig-act", c)); const pre = $("pre", box);
  let txt = b.text && b.textScore > 0.6 ? b.text + " " : "", last = Date.now();
  const out = ch => { txt = (txt + ch).slice(-4000); pre.textContent = txt; pre.scrollTop = 1e9; last = Date.now(); };
  // Wetter-/Behoerdenfunk (Shift ab 400 Hz, z. B. DWD): Zahlengruppen ohne erneutes Ziffernzeichen nach dem Leerzeichen – kein „Unshift on Space“
  const rx = dmNewRx(mode, af, out, { baud: b.baud, shift: b.shift, usos: !(b.shift >= 400) }); rx.sql = 0.1; if ("sqlv" in rx) rx.sqlv = 0.1;
  pre.textContent = txt || "…";
  const stop = why => { try { R.live?.un?.(); } catch { } R.live = null; box.classList.add("off"); $(".sig-live-x", box).remove(); if (why) $(".sig-live-h b", box).textContent += " – " + why; };
  $(".sig-live-x", box).onclick = () => stop("angehalten");
  let n = 0;
  try { R.live = { un: await sigTap(o, x => { rx.process(x);
    if (++n % 40 === 0 && o.dial) { const f = sigState(o.radio).freq; if (f && Math.abs(f - o.dial) > 30) stop("umgestimmt"); } }) }; }
  catch (e) { stop(e.message); }
}
// APRS/Packet live: eigener Dekoder (aprs.js) auf dem FM-Ton; Meldungen auch ins Fenster „Datenempfang“
async function sigAprsLive(R, f, label) {
  const o = R.o, c = R.card, body = $(".sig-body", c);
  $(".sig-bar", c).classList.add("done"); sigProgress(R, 1);
  body.innerHTML = `<div class="sig-res sure"><span class="sig-name">APRS / Packet</span><span class="sig-conf">nach Frequenz</span></div>
    <div class="hint"><span>Wellenwerk dekodiert selbst</span> (AFSK 1200 Bd) · ${fmtMHz(f)} MHz · <span>Meldungen auch im Fenster „Datenempfang“</span></div>
    <div class="sig-live"><div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: APRS</b><i class="grow"></i><button type="button" class="sig-live-x">Stopp</button></div><pre translate="no"></pre></div><div class="hint sig-db"></div><div class="sig-act"></div>`;
  const pre = $("pre", body); let got = [];
  const render = () => { pre.textContent = got.length ? got.slice(-50).map(d => `${new Date(d.t * 1000).toLocaleTimeString(I18N.locale)}  ${decSummary(d)}`).join("\n") : "warte auf die nächste Aussendung …"; pre.scrollTop = 1e9; };
  render(); const offIds = WW.on("ids", () => pre.isConnected ? render() : offIds());
  const stop = why => { try { R.live?.un?.(); } catch { } R.live = null; body.querySelector(".sig-live")?.classList.add("off"); $(".sig-live-x", body)?.remove(); if (why) { const b = $(".sig-live-h b", body); if (b) b.textContent += " – " + why; } };
  $(".sig-live-x", body).onclick = () => stop("angehalten");
  sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbLink("packet"); });
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - f) > 3000).concat({ rf: f, label: "APRS", until: Date.now() + 60000, radio: o.radio });
  const rx = APRS.Rx(8000, v => { const d = { decoder: "packet", radio: o.radio, freq: f, t: Date.now() / 1000, value: v, local: true };
    got.push(d); if (got.length > 300) got = got.slice(-200); render(); WW.decodes?.unshift(d); WW.emit("decode", d); });
  let n = 0;
  try { R.live = { un: await sigTap(o, x => { rx.process(x); if (++n % 40 === 0) { const g = sigState(o.ctl || o.radio).freq; if (g && Math.abs(g - f) > 3000) stop("umgestimmt"); } }) }; }
  catch (e) { stop(e.message); }
}
// FT8/FT4 live in der Karte: Ton mitschneiden, nach jedem UTC-Zeitschlitz (15 s bzw. 7,5 s) diesen dekodieren – wie WSJT-X,
// mit Namen zu den Rufzeichen. Ende bei Stopp, Umstimmen oder Schliessen der Karte.
async function sigFtxLive(R, id) {
  const o = R.o, c = R.card, P = id === "FT8" ? 15000 : 7500, chunks = [];   // [Ankunftszeit, Abtastwerte]
  const box = document.createElement("div"); box.className = "sig-live";
  box.innerHTML = `<div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: ${id}</b><i class="grow"></i><button type="button" class="sig-live-x">Stopp</button></div><pre translate="no"></pre>`;
  $(".sig-body", c).insertBefore(box, $(".sig-act", c)); const pre = $("pre", box);
  let got = [], next = Math.ceil(Date.now() / P) * P, busy = false, timer = 0;
  const line = m => { const call = decWsjtCall(m.text), u = call ? idName("call", call) : null;
    return `${new Date(m.t).toISOString().slice(11, 19)} ${String(Math.round(m.f)).padStart(4)} Hz  ${m.text}${u ? `  (${u.n || ""}${u.city ? ", " + u.city : ""})`.replace("(, ", "(") : ""}`; };
  const render = () => { pre.textContent = got.length ? got.slice(-40).map(line).join("\n") : `warte auf den nächsten Zeitschlitz (${P / 1000} s) …`; pre.scrollTop = 1e9; };
  render(); const offIds = WW.on("ids", () => pre.isConnected ? render() : offIds());
  const stop = why => { clearInterval(timer); try { R.live?.un?.(); } catch { } R.live = null; box.classList.add("off"); $(".sig-live-x", box)?.remove(); if (why) $(".sig-live-h b", box).textContent += " – " + why; };
  $(".sig-live-x", box).onclick = () => stop("angehalten");
  try { R.live = { un: await sigTap(o, x => { chunks.push([Date.now(), Float32Array.from(x)]); while (chunks.length && chunks[0][0] < Date.now() - 40000) chunks.shift(); }) }; }
  catch (e) { return stop(e.message); }
  timer = setInterval(async () => {
    if (R.stop || !box.isConnected) return stop();
    const f = sigState(o.ctl || o.radio).freq; if (o.dial && f && Math.abs(f - o.dial) > 30) return stop("umgestimmt");
    if (busy || Date.now() < next + P - 500) return;
    const s0 = next; next += P; busy = true;
    try {                                                                         // Abtastwerte des Zeitschlitzes s0 (−1 s … +P), Zeit je Wert aus der Ankunftszeit
      const a = s0 - 1000, e = s0 + P - 300, parts = [];
      for (const [t, d] of chunks) { const t1 = t, t0 = t - d.length / 8; if (t1 <= a || t0 >= e) continue; const i0 = Math.max(0, Math.round((a - t0) * 8)), i1 = Math.min(d.length, Math.round((e - t0) * 8)); parts.push(d.subarray(i0, i1)); }
      const n = parts.reduce((s, p) => s + p.length, 0); if (n < (P - 1500) * 8) return;
      const x = new Float32Array(n); let k = 0; for (const p of parts) { x.set(p, k); k += p.length; }
      const msgs = await sigFtx(x, id === "FT4"); for (const m of msgs) got.push({ ...m, t: s0 }); if (got.length > 300) got = got.slice(-200); render();
      WW.emit("ftx", { radio: o.radio, mode: id, slot: s0, msgs });
    } catch (e) { } finally { busy = false; }
  }, 250);
}
async function sigIdentify(o) {
  sigCancel();
  const R = SIG.run = { o, buf: [], n: 0, stop: false, last: null }, max = Math.max(6, Math.min(30, +wfOpts().sigsecs || 15)) * 8000;
  R.card = sigCard(o);
  let skip = Math.round((o.settle || 0) * 8000);   // nach dem Umstimmen kurz warten (Empfaenger-Laufzeit, Regelung)
  try { R.un = await sigTap(o, x => { if (R.stop) return; if (skip > 0) { skip -= x.length; return; }
    if (!R.n) R.tAt0 = Date.now() - x.length / 8;                                  // Uhrzeit des ersten Abtastwerts (fuer FT8/FT4-Zeitschlitze)
    R.buf.push(Float32Array.from(x)); R.n += x.length; }); }
  catch (err) { sigRender(R, { error: err.message }); return; }
  if (R.stop) { R.un(); return; }
  const steps = [...new Set([4, 8, 15].map(s => s * 8000).filter(n => n < max).concat(max))];
  const t0 = Date.now(); let res = null, lastN = 0, quiet = Date.now();
  try {
    for (const need of steps) {
      while (!R.stop && R.n < need) {
        await new Promise(r => setTimeout(r, 200));
        if (R.n !== lastN) { lastN = R.n; quiet = Date.now(); } else if (Date.now() - quiet > 5000) throw new Error("Es kommt kein Ton an");
        const f = sigState(o.radio).freq;   // umgestimmt? dann passt die Aufnahme nicht mehr
        if (o.dial && f && Date.now() - t0 > 2500 && Math.abs(f - o.dial) > 30) throw new Error("abgebrochen – das Gerät wurde umgestimmt");
        sigProgress(R, R.n / max);
      }
      if (R.stop) return;
      const x = new Float32Array(need); let k = 0; for (const b of R.buf) { if (k >= need) break; x.set(b.subarray(0, need - k), k); k += b.length; }
      res = await sigAnalyze(x, { fc: o.fc, rf: o.rf, inverted: o.inverted });
      if (R.stop) return;
      R.last = res; sigRender(R, res, need < max);
      const b = res.best; if (b && b.score >= 0.85 && !["NOISE", "UNKNOWN"].includes(b.id) && !(/^FT[48]$/.test(b.id) && !b.ftx)) break;
    }
    // FT8/FT4 erkannt, aber noch nicht gelesen: weiter aufnehmen, bis ein ganzer UTC-Zeitschlitz im Puffer liegt, und diesen dekodieren
    const fb = res?.best; if (!R.stop && fb && /^FT[48]$/.test(fb.id) && !fb.ftx && R.tAt0) {
      const P = fb.id === "FT8" ? 15000 : 7500, s0 = Math.ceil((R.tAt0 + 300) / P) * P, until = s0 + P - 800;
      $(".sig-body .hint", R.card)?.insertAdjacentHTML("beforeend", ` · <span>lese ${fb.id} im nächsten Zeitschlitz …</span>`);
      while (!R.stop && Date.now() < until && Date.now() - t0 < 34000) { await new Promise(r => setTimeout(r, 250)); sigProgress(R, 0.5 + 0.5 * (1 - (until - Date.now()) / P)); }
      if (R.stop) return;
      const a = Math.max(0, Math.round((s0 - 1000 - R.tAt0) * 8)), len = Math.round((P + 500) * 8), x = new Float32Array(len); let k = 0, pos = 0;
      for (const bb of R.buf) { const e = pos + bb.length; if (e > a && k < len) { const from = Math.max(0, a - pos), part = bb.subarray(from, Math.min(bb.length, from + len - k)); x.set(part, k); k += part.length; } pos = e; }
      const msgs = await sigFtx(x.subarray(0, k), fb.id === "FT4").catch(() => []);
      if (msgs.length) Object.assign(fb, { score: 0.99, text: msgs.map(m => m.text).join(" · "), textScore: 1, ftx: msgs, label: `${fb.id} · ${msgs.length} ${msgs.length === 1 ? "Telegramm" : "Telegramme"} gelesen` });
    }
  } catch (err) { R.err = err.message; }
  finally { try { R.un?.(); } catch { } R.un = null; }
  if (R.stop) return;
  if (R.err) { sigRender(R, res ? { ...res, abort: R.err } : { error: R.err }, !!res); return; }   // abgebrochen: Meldung bleibt sichtbar
  if (res && o.rfAm && ["UNKNOWN", "CARRIER", "VOICE", "VOICE_INV", "NOISE", "AM"].includes(res.best?.id)) {   // AM aus dem HF-Spektrum
    const am = { id: "AM", label: "AM (Träger mit zwei Seitenbändern)", score: 0.85, center: o.fc + (o.rfAm.carrier - o.rf) * (o.inverted ? -1 : 1) };
    res = { ...res, best: am, cands: [am, ...(res.cands || []).filter(x => x.id !== "AM")] };
  }
  if (res) { sigRender(R, res, false); sigTag(o, res); WW.emit("sig-result", { o, res }); sigAuto(R, res); }
}

// ---------- Ergebnis ----------
function sigCard(o) {
  const c = document.createElement("div"); c.className = "sig-card";
  c.innerHTML = `<div class="sig-h">${icon("i-wave")}<b>Signalerkennung</b><span class="sig-f hint"></span><i class="grow"></i><button class="sig-x" title="Schließen">×</button></div>
    <div class="sig-bar"><i></i></div><div class="sig-body"><div class="hint">nehme auf …</div></div>`;
  document.body.appendChild(c);
  const Z = uiZ(), VW = innerWidth / Z, VH = innerHeight / Z;
  const W = 340, x = Math.min(VW - W - 8, Math.max(8, (o.x != null ? o.x / Z : VW / 2) + 14)), y = Math.min(VH - 200, Math.max(8, (o.y != null ? o.y / Z : 120) + 14));
  Object.assign(c.style, { left: x + "px", top: y + "px", width: W + "px" });
  $(".sig-f", c).textContent = o.rf ? fmtMHz(o.rf) + " MHz" : Math.round(o.fc) + " Hz";
  $(".sig-x", c).onclick = sigCancel;
  // verschiebbar am Kopf
  $(".sig-h", c).addEventListener("pointerdown", e => { if (e.target.closest("button")) return; const sx = e.clientX / Z - c.offsetLeft, sy = e.clientY / Z - c.offsetTop;
    const mv = ev => { c.style.left = (ev.clientX / Z - sx) + "px"; c.style.top = (ev.clientY / Z - sy) + "px"; }, up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up); });
  return c;
}
function sigProgress(R, p) { const b = R.card && $(".sig-bar i", R.card); if (b) b.style.width = Math.min(100, p * 100) + "%"; }
const sigPct = v => Math.round(v * 100) + " %";
// ---------- Signal-Datenbank: Auszug aus dem Signal Identification Wiki (sigidwiki.com), static/sigdb.json ----------
const SIGDB = { data: null, p: null };
function sigDbLoad() { return SIGDB.p ||= fetch("/static/sigdb.json").then(r => r.json()).then(d => (SIGDB.data = d)).catch(() => null); }
const SIG_MOD = [[/^(RTTY|NAVTEX|FSK|PACKET|PACTOR|SITOR)/, /(?<![M48G]-?)FSK|IFK/i], [/^Q?PSK/, /PSK/i], [/^(FT8|FT4|WSPR|JT|MFSK|OLIVIA|CONTESTIA|DOMINO|THOR)/, /MFSK|8-FSK|4FSK|IFK/i],
  [/^CW/, /CW|OOK|ASK/i], [/^(AM|CARRIER)/, /\bAM\b|CW/i], [/^VOICE/, /USB|LSB|SSB|\bAM\b|\bFM\b|NFM/i], [/^(MT63|OFDM|FREEDV)/, /OFDM|PSK/i], [/^(FAX|SSTV|HELL)/, /\bFM\b|\bAM\b/i]];
// Passende Eintraege zur Empfangsfrequenz rf: Frequenz muss passen; Modulation und Breite der Erkennung gewichten
function sigDbMatch(rf, best, bw, ham) {
  const d = SIGDB.data; if (!d || !rf) return [];
  const modRe = (SIG_MOD.find(([a]) => a.test(best?.id || "")) || [])[1], out = [];
  for (const s of d.signals) {
    let hit = false;
    for (const [lo, hi] of s.f) { const tol = lo === hi ? Math.max(3000, Math.min((s.bw || 0) / 2, lo * 0.003)) : 0; if (rf >= lo - tol && rf <= hi + tol) { hit = true; break; } }
    if (!hit) continue;
    const span = Math.max(...s.f.map(([a, b]) => b - a));                // sehr breite Bereiche sagen wenig
    let sc = 1 - Math.min(0.6, Math.log10(1 + span / 1e6) * 0.3);
    if (modRe) sc += modRe.test(`${s.mod} ${s.m}`) ? 0.6 : -0.5;
    if (bw > 0 && s.bw > 0) sc += 0.3 - Math.min(0.6, Math.abs(Math.log2(s.bw / bw)) * 0.15);
    if (s.c.includes("Inactive")) sc -= 0.3;
    if (ham) sc += s.c.includes("Amateur Radio") ? 0.4 : /jammer|radar/i.test(s.n) || s.c.includes("Military") ? -0.4 : 0;   // im Amateurfunkband
    out.push({ s, sc });
  }
  return out.sort((a, b) => b.sc - a.sc).filter(x => x.sc > 0.5).slice(0, 3);
}
// Eintrag der Signal-Datenbank zu einem erkannten Digitalfunk-Verfahren (Kennung wie bei OpenWebRX/dvsync)
const SIG_DV_DB = { dmr: "Digital Mobile Radio", dstar: "D-STAR", ysf: "Yaesu System Fusion", p25: "Project 25", nxdn: "NXDN", nxdn48: "NXDN", m17: "M17", packet: "APRS" };
function sigDbLink(id) {
  const k = SIG_DV_DB[id], e = k && SIGDB.data?.signals.find(x => x.n.includes(k)); if (!e) return "";
  return `<span>Signal-Datenbank:</span> <a href="${SIGDB.data.base + e.u}" target="_blank" rel="noopener">${esc(e.n)}</a>${e.mod || e.bw ? ` <span class="sig-dbm">(${esc([e.mod, e.bw ? Math.round(e.bw / 100) / 10 + " kHz" : ""].filter(Boolean).join(", "))})</span>` : ""}`;
}
function sigDbHtml(rf, best, bw, ham) {
  const m = sigDbMatch(rf, best, bw, ham); if (!m.length) return "";
  const fb = v => v >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + " MHz" : v >= 1e3 ? Math.round(v / 1e3) + " kHz" : v + " Hz";
  return `<span>Signal-Datenbank:</span> ${m.map(({ s }) => `<a href="${SIGDB.data.base + s.u}" target="_blank" rel="noopener" title="${esc([s.mod, s.m, s.acf].filter(Boolean).join(" · "))}">${esc(s.n)}</a>${s.mod || s.bw ? ` <span class="sig-dbm">(${esc([s.mod, s.bw ? fb(s.bw) : ""].filter(Boolean).join(", "))})</span>` : ""}`).join(" · ")}`;
}
function sigRender(R, res, interim) {
  const c = R.card; if (!c) return; const body = $(".sig-body", c);
  if (res.error) { body.innerHTML = `<div class="err">${esc(res.error)}</div>`; $(".sig-bar", c).classList.add("done"); return; }
  if (res.abort) $(".sig-bar", c).classList.add("done");
  const b = res.best, others = (res.cands || []).filter(x => x !== b && x.id !== b.id && x.score >= 0.35).slice(0, 3);
  if (!interim) $(".sig-bar", c).classList.add("done");
  const facts = [res.center ? `Mitte ${Math.round(b.center || res.center)} Hz` : "", res.bw >= 1 ? `Breite ${Math.round(res.bw)} Hz` : "", Number.isFinite(res.snr) ? `${Math.round(res.snr)} dB über Rauschen` : "", `${Math.round(res.secs)} s`].filter(Boolean);
  body.innerHTML = `<div class="sig-res ${b.score >= 0.7 ? "sure" : b.score >= 0.5 ? "maybe" : "weak"}"><span class="sig-name">${esc(b.label)}</span><span class="sig-conf">${interim ? "<span>vorläufig</span> · " : ""}${sigPct(b.score)}</span></div>
    <div class="sig-cbar"><i style="width:${Math.round(b.score * 100)}%"></i></div>
    <div class="hint">${facts.map(f => `<span>${esc(f)}</span>`).join(" · ")}</div>
    ${b.text && b.textScore > 0.6 ? `<div class="sig-text" translate="no">${esc(b.text)}</div>` : ""}
    ${res.plan && res.plan.length ? `<div class="hint"><span>Bandplan: typisch für</span> ${res.plan.map(p => `<span>${esc(p)}</span>`).join(", ")}</div>` : ""}
    ${others.length ? `<div class="hint"><span>auch möglich:</span> ${others.map(x => `<span>${esc(x.label)}</span> ${sigPct(x.score)}`).join(" · ")}</div>` : ""}
    <div class="hint sig-db"></div>
    ${res.abort ? `<div class="err">${esc(res.abort)}</div>` : ""}<div class="sig-act"></div>`;
  const rf = R.o.rf, dbEl = $(".sig-db", body);
  if (rf && !interim && !(/^(AM|VOICE|CARRIER|NOISE)/.test(b.id || "") && b.score >= 0.5)) sigDbLoad().then(() => { if (dbEl.isConnected) dbEl.innerHTML = sigDbHtml(rf, b, res.bw, !!(res.plan && res.plan.length) || !!bandFor(rf)); });
  if (!interim) sigActions(R, res, $(".sig-act", body)); else if (res.abort) sigActions(R, { best: { id: "", label: "" } }, $(".sig-act", body));
}
function sigActions(R, res, el) {
  const o = R.o, b = res.best, afOf = () => Math.round(b.center || res.center || o.fc), btn = (label, fn, primary) => { const x = document.createElement("button"); x.textContent = label; if (primary) x.className = "primary"; x.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, true); } }; el.appendChild(x); };
  const dmMode = DM_ALL.includes(b.decode) ? b.decode : DM_ALL.includes(b.id) ? b.id : null;
  if (dmMode) btn("Im Digitalbetrieb dekodieren", async () => {
    if (b.id === "RTTY" || dmMode === "RTTY") { if (b.baud) store.set("dm.rtty.baud", b.baud); if (b.shift) store.set("dm.rtty.shift", b.shift); }
    switchApp("dm"); dmSetMode(dmMode);
    if (!D.running) await dmStart(isSdr(sigRadio(o.radio)) ? "__sdr" : store.get("dm.in", ""));
    dmSetFreq(afOf()); sigCancel();
  }, true);
  if (b.id === "SSTV") btn("SSTV-Empfang öffnen", () => { switchApp("dm"); if (!panelOpen("dm", "sstv")) addPanel("dm", "sstv"); if (!D.running) dmStart(isSdr(sigRadio(o.radio)) ? "__sdr" : store.get("dm.in", "")); sigCancel(); }, true);
  if (b.id === "FREEDV") btn("FreeDV öffnen", () => { const st = store.get("fdv", {}); if (b.freedv) store.set("fdv", { ...st, mode: b.freedv }); switchApp("dm"); if (!panelOpen("dm", "freedv")) addPanel("dm", "freedv"); sigCancel(); }, true);
  if (["FT8", "FT4", "WSPR", "JT9", "JT65"].includes(b.id)) {
    const p = (SIGID.planFor(o.rf) || []).find(x => x.id === b.id), std = p ? p.lo - (b.id === "WSPR" ? 1350 : 100) : 0;
    const rr = sigRadio(o.radio), decs = rr?.state?.sdr?.decoders || [], sid = b.id.toLowerCase();
    if (/^FT[48]$/.test(b.id)) { }                                                   // liest Wellenwerk selbst (live in der Karte)
    else if (decs.some(d => d.id === sid)) btn(`Vom Empfänger dekodieren lassen (${b.id})`, () => sigProbe({ ...o, ctl: o.ctl || o.radio, keep: true }, [sid], decs, { noPre: true, only: sid }), true);
    else el.insertAdjacentHTML("beforeend", `<div class="hint">Dekodieren mit WSJT-X – Wellenwerk übernimmt dessen Meldungen (Optionen → WSJT-X).</div>`);
    if (std && Math.abs(std - o.dial) > 10) btn(`Auf ${fmtMHz(std)} MHz (Standard) abstimmen`, async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "USB", passband: 3000 }); await sigRig(o.ctl || o.radio, "freq", { hz: std }); sigCancel(); });
  }
  if (b.id === "VOICE_INV" && o.dial) {
    const sb = o.inverted ? "USB" : "LSB", carrier = sigSsbCarrier(o, b);
    btn(`Als ${sb} abstimmen`, async () => { await sigRig(o.ctl || o.radio, "mode", { mode: sb, passband: 2700 }); await sigRig(o.ctl || o.radio, "freq", { hz: carrier }); sigCancel(); }, true);
  }
  if (b.id === "AM" && o.dial) btn("AM einstellen", async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "AM", passband: 0 }); await sigRig(o.ctl || o.radio, "freq", { hz: Math.round(o.inverted ? o.dial - afOf() : o.dial + afOf()) }); sigCancel(); }, true);
  if (b.id === "CW" && o.dial) btn("CW einstellen", async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "CW", passband: 500 }); await sigRig(o.ctl || o.radio, "freq", { hz: Math.round(o.inverted ? o.dial - afOf() : o.dial + afOf()) }); sigCancel(); });
  btn("Nochmal", () => sigIdentify({ ...o, settle: 0 }));
}
// kurzes Etikett im Wasserfall an der Signalfrequenz (30 s sichtbar)
function sigTag(o, res) { if (!o.rf || !res.best || ["NOISE", "UNKNOWN"].includes(res.best.id)) return;
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - o.rf) > 50).concat({ rf: o.rf, label: res.best.label.split(" · ")[0], until: Date.now() + 30000, radio: o.radio }); }
addEventListener("keydown", e => { if (e.key === "Escape" && SIG.run) sigCancel(); });
