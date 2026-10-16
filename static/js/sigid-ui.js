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
const sigRadio = id => (WW.radios || []).find(r => r.id === (id || WW.current));
const sigState = id => sigRadio(id)?.state || WW.rig || {};
const sigRig = (id, what, body) => id && id !== WW.current ? api(`/api/radios/${encodeURIComponent(id)}/rig/${what}`, { method: "POST", body }) : post(`/api/rig/${what}`, body);

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
  if (decs.length && f > 30e6) { const list = sigProbeList(f, decs); if (list.length) { sigProbe({ radio: dr.id, ctl: radioId || dr.id, rf: f, x: e?.clientX, y: e?.clientY }, list, decs); return true; } }
  const st = sigState(radioId), inv = SIG_SB[st.mode];
  if (inv === undefined) return false;                               // AM/FM/CW: wie bisher direkt abstimmen
  const dial = Math.round(inv ? f + 1500 : f - 1500);
  sigRig(radioId, "freq", { hz: dial }).catch(err => toast(err.message, true));
  sigIdentify({ radio: tapId || radioId || WW.current, ctl: radioId || WW.current, rfAm: sigRfAm(rfLines, f), fc: 1500, rf: f, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: tapId ? 1.8 : 1.2 });
  return true;
}
// Klick im Wasserfall des Digitalbetriebs (Tonfrequenz af): ohne Umstimmen
function sigOnDmClick(af, e) {
  if (wfOpts().sig === false || !D.running) return;
  const st = sigState(), inv = !!SIG_SB[st.mode], dial = st.freq || 0;
  sigIdentify({ radio: WW.current, dmTap: true, fc: af, rf: dial ? (inv ? dial - af : dial + af) : 0, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: 0 });
}

// ---------- VHF/UHF: Dekoder des Empfaengers (OpenWebRX) durchprobieren ----------
const SIG_FIXED = ["packet", "ism", "sonde"];              // nach Frequenz eindeutig: Dekoder bleibt an, Meldungen kommen in Abstaenden
function sigProbeList(f, decs) {
  const has = id => decs.some(d => d.id === id), near = (a, t = 8000) => Math.abs(f - a) < t, L = [];
  if ([144800000, 144390000, 144575000, 145825000, 144640000, 144660000, 432500000].some(a => near(a))) L.push("packet");
  if ((f >= 433.05e6 && f <= 434.79e6) || (f >= 868e6 && f <= 868.6e6) || (f >= 314e6 && f <= 316e6) || (f >= 915e6 && f <= 928e6)) L.push("ism");
  if (f >= 400e6 && f <= 406.1e6) L.push("sonde");
  if (f >= 50e6) L.push("dmr", "dstar", "ysf", "m17", "nxdn", "p25");
  return [...new Set(L)].filter(has);
}
async function sigProbe(o, list, decs) {
  sigCancel();
  const R = SIG.run = { o, stop: false, card: sigCard(o) }, c = R.card, body = $(".sig-body", c), name = id => (decs.find(d => d.id === id) || {}).label || id;
  const fx = SIG_FIXED.includes(list[0]) ? list[0] : "";
  const f = fx === "ism" ? (Math.abs(o.rf - 433.92e6) < 60e3 ? 433920000 : Math.abs(o.rf - 868.3e6) < 300e3 ? 868300000 : o.rf) : Math.round(o.rf / 6250) * 6250;   // Kanalraster
  const setDec = m => api(`/api/radios/${encodeURIComponent(o.radio)}/rig/decoder`, { method: "POST", body: { mode: m } });
  const msgs = [];
  R.un = WW.on("decode", d => { if (d.radio !== o.radio || R.stop) return; msgs.push(d); R.onMsg?.(d); });
  try { await sigRig(o.ctl, "mode", { mode: "FM", passband: 0 }); await sigRig(o.ctl, "freq", { hz: f }); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  let found = "";
  if (fx) { found = fx; await setDec(fx).catch(e => { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; found = null; }); if (found === null) return; }
  else {
    for (let i = 0; i < list.length && !R.stop; i++) {
      const id = list[i]; body.innerHTML = `<div class="hint">prüfe ${esc(name(id))} … (${i + 1}/${list.length})</div>`; sigProgress(R, (i + 0.3) / list.length);
      try { await setDec(id); } catch { continue; }
      const t0 = Date.now(); while (!R.stop && Date.now() - t0 < 3500 && !msgs.some(d => d.decoder === id)) await new Promise(r => setTimeout(r, 150));
      if (msgs.some(d => d.decoder === id)) { found = id; break; }
    }
    if (R.stop) return;
    if (!found) { await setDec("").catch(() => { });
      body.innerHTML = `<div class="sig-res weak"><span class="sig-name">kein digitales Signal erkannt</span></div><div class="hint">Geprüft: ${list.map(name).map(esc).join(", ")}. Vermutlich analoges FM oder gerade Sendepause – Empfänger steht auf FM.</div><div class="hint sig-db"></div><div class="sig-act"></div>`;
      $(".sig-bar", c).classList.add("done"); sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbHtml(f, { id: "FSK" }, 0, !!bandFor(f)); });
      const b = document.createElement("button"); b.textContent = "Nochmal"; b.onclick = () => sigProbe(o, list, decs); $(".sig-act", body).appendChild(b); return; }
  }
  $(".sig-bar", c).classList.add("done"); sigProgress(R, 1);
  body.innerHTML = `<div class="sig-res sure"><span class="sig-name">${esc(name(found))}</span><span class="sig-conf">${fx ? "nach Frequenz" : "Synchronmuster erkannt"}</span></div>
    <div class="hint">Dekoder des Empfängers läuft · ${fmtMHz(f)} MHz · Meldungen auch im Fenster „Datenempfang“</div>
    <div class="sig-live"><div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: ${esc(name(found))}</b><i class="grow"></i><button type="button" class="sig-live-x">Dekoder aus</button></div><pre translate="no"></pre></div>
    <div class="hint sig-db"></div><div class="sig-act"></div>`;
  const pre = $("pre", body); let lines = [];
  const add = d => { if (d.decoder !== found) return; lines.push(`${new Date((d.t || Date.now() / 1000) * 1000).toLocaleTimeString(I18N.locale)}  ${decSummary(d)}`); lines = lines.slice(-60); pre.textContent = lines.join("\n"); pre.scrollTop = 1e9; };
  pre.textContent = fx ? "warte auf die nächste Aussendung …" : ""; msgs.forEach(add); R.onMsg = add;
  $(".sig-live-x", body).onclick = async () => { await setDec("").catch(() => { }); R.onMsg = null; body.querySelector(".sig-live").classList.add("off"); $(".sig-live-x", body).remove(); };
  sigDbLoad().then(() => { const el = $(".sig-db", body); if (el) el.innerHTML = sigDbHtml(f, { id: found === "packet" ? "PACKET" : "FSK" }, 0, !!bandFor(f)); });
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - f) > 3000).concat({ rf: f, label: name(found), until: Date.now() + 60000, radio: o.radio });
}
function sigCancel() { const R = SIG.run; if (!R) return; R.stop = true; try { R.un?.(); } catch { } try { R.live?.un?.(); } catch { } R.card?.remove(); SIG.run = null; }
// Nach der Erkennung (Option „automatisch umschalten“): AM/Seitenband einstellen bzw. den Inhalt live in der Karte mitschreiben
async function sigAuto(R, res) {
  const o = R.o, b = res.best; if (wfOpts().sigauto === false || R.stop || !b || b.score < 0.6) return;
  const c = R.card, af = Math.round(b.center || res.center || o.fc), ctl = o.ctl || o.radio, note = t => $(".sig-body", c)?.insertAdjacentHTML("beforeend", `<div class="hint sig-auto">✓ ${esc(t)}</div>`);
  try {
    if (b.id === "AM" && o.dial && !o.dmTap) { await sigRig(ctl, "mode", { mode: "AM", passband: 0 }); await sigRig(ctl, "freq", { hz: Math.round(o.inverted ? o.dial - af : o.dial + af) }); note("auf AM umgeschaltet"); return; }
    if (b.id === "VOICE_INV" && o.dial && !o.dmTap) { const sb = o.inverted ? "USB" : "LSB"; await sigRig(ctl, "mode", { mode: sb, passband: 2700 }); await sigRig(ctl, "freq", { hz: Math.round(o.inverted ? o.rf - 1500 : o.rf + 1500) }); note(`auf ${sb} umgeschaltet`); return; }
  } catch (e) { note("Umschalten nicht möglich: " + e.message); return; }
  const mode = DM_ALL.includes(b.decode) ? b.decode : DM_ALL.includes(b.id) ? b.id : null;
  if (!mode || DIGI_MODES[mode]?.image) return;
  const box = document.createElement("div"); box.className = "sig-live";
  box.innerHTML = `<div class="sig-live-h"><span class="sig-live-dot"></span><b>Live: ${esc(DIGI_MODES[mode]?.label || mode)}</b><i class="grow"></i><button type="button" class="sig-live-x">Stopp</button></div><pre translate="no"></pre>`;
  $(".sig-body", c).insertBefore(box, $(".sig-act", c)); const pre = $("pre", box);
  let txt = b.text && b.textScore > 0.6 ? b.text + " " : "", last = Date.now();
  const out = ch => { txt = (txt + ch).slice(-4000); pre.textContent = txt; pre.scrollTop = 1e9; last = Date.now(); };
  const rx = dmNewRx(mode, af, out, { baud: b.baud, shift: b.shift }); rx.sql = 0.1; if ("sqlv" in rx) rx.sqlv = 0.1;
  pre.textContent = txt || "…";
  const stop = why => { try { R.live?.un?.(); } catch { } R.live = null; box.classList.add("off"); $(".sig-live-x", box).remove(); if (why) $(".sig-live-h b", box).textContent += " – " + why; };
  $(".sig-live-x", box).onclick = () => stop("angehalten");
  let n = 0;
  try { R.live = { un: await sigTap(o, x => { rx.process(x);
    if (++n % 40 === 0 && o.dial) { const f = sigState(o.radio).freq; if (f && Math.abs(f - o.dial) > 30) stop("umgestimmt"); } }) }; }
  catch (e) { stop(e.message); }
}
async function sigIdentify(o) {
  sigCancel();
  const R = SIG.run = { o, buf: [], n: 0, stop: false, last: null }, max = Math.max(6, Math.min(30, +wfOpts().sigsecs || 15)) * 8000;
  R.card = sigCard(o);
  let skip = Math.round((o.settle || 0) * 8000);   // nach dem Umstimmen kurz warten (Empfaenger-Laufzeit, Regelung)
  try { R.un = await sigTap(o, x => { if (R.stop) return; if (skip > 0) { skip -= x.length; return; } R.buf.push(Float32Array.from(x)); R.n += x.length; }); }
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
      const b = res.best; if (b && b.score >= 0.85 && !["NOISE", "UNKNOWN"].includes(b.id)) break;
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
  const o = R.o, b = res.best, af = Math.round(b.center || res.center || o.fc), btn = (label, fn, primary) => { const x = document.createElement("button"); x.textContent = label; if (primary) x.className = "primary"; x.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, true); } }; el.appendChild(x); };
  const dmMode = DM_ALL.includes(b.decode) ? b.decode : DM_ALL.includes(b.id) ? b.id : null;
  if (dmMode) btn("Im Digitalbetrieb dekodieren", async () => {
    if (b.id === "RTTY" || dmMode === "RTTY") { if (b.baud) store.set("dm.rtty.baud", b.baud); if (b.shift) store.set("dm.rtty.shift", b.shift); }
    switchApp("dm"); dmSetMode(dmMode);
    if (!D.running) await dmStart(isSdr(sigRadio(o.radio)) ? "__sdr" : store.get("dm.in", ""));
    dmSetFreq(af); sigCancel();
  }, true);
  if (b.id === "SSTV") btn("SSTV-Empfang öffnen", () => { switchApp("dm"); if (!panelOpen("dm", "sstv")) addPanel("dm", "sstv"); if (!D.running) dmStart(isSdr(sigRadio(o.radio)) ? "__sdr" : store.get("dm.in", "")); sigCancel(); }, true);
  if (b.id === "FREEDV") btn("FreeDV öffnen", () => { const st = store.get("fdv", {}); if (b.freedv) store.set("fdv", { ...st, mode: b.freedv }); switchApp("dm"); if (!panelOpen("dm", "freedv")) addPanel("dm", "freedv"); sigCancel(); }, true);
  if (["FT8", "FT4", "WSPR", "JT9", "JT65"].includes(b.id)) {
    const p = (SIGID.planFor(o.rf) || []).find(x => x.id === b.id), std = p ? p.lo - (b.id === "WSPR" ? 1350 : 100) : 0;
    el.insertAdjacentHTML("beforeend", `<div class="hint">Dekodieren mit WSJT-X – Wellenwerk übernimmt dessen Meldungen (Optionen → WSJT-X).</div>`);
    if (std && Math.abs(std - o.dial) > 10) btn(`Auf ${fmtMHz(std)} MHz (Standard) abstimmen`, async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "USB", passband: 3000 }); await sigRig(o.ctl || o.radio, "freq", { hz: std }); sigCancel(); });
  }
  if (b.id === "VOICE_INV" && o.dial) {
    const sb = o.inverted ? "USB" : "LSB", carrier = Math.round(o.inverted ? o.rf - 1500 : o.rf + 1500);
    btn(`Als ${sb} abstimmen`, async () => { await sigRig(o.ctl || o.radio, "mode", { mode: sb, passband: 2700 }); await sigRig(o.ctl || o.radio, "freq", { hz: carrier }); sigCancel(); }, true);
  }
  if (b.id === "AM" && o.dial) btn("AM einstellen", async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "AM", passband: 0 }); await sigRig(o.ctl || o.radio, "freq", { hz: Math.round(o.inverted ? o.dial - af : o.dial + af) }); sigCancel(); }, true);
  if (b.id === "CW" && o.dial) btn("CW einstellen", async () => { await sigRig(o.ctl || o.radio, "mode", { mode: "CW", passband: 500 }); await sigRig(o.ctl || o.radio, "freq", { hz: Math.round(o.inverted ? o.dial - af : o.dial + af) }); sigCancel(); });
  btn("Nochmal", () => sigIdentify({ ...o, settle: 0 }));
}
// kurzes Etikett im Wasserfall an der Signalfrequenz (30 s sichtbar)
function sigTag(o, res) { if (!o.rf || !res.best || ["NOISE", "UNKNOWN"].includes(res.best.id)) return;
  SIG.tags = SIG.tags.filter(t => t.until > Date.now() && Math.abs(t.rf - o.rf) > 50).concat({ rf: o.rf, label: res.best.label.split(" · ")[0], until: Date.now() + 30000, radio: o.radio }); }
addEventListener("keydown", e => { if (e.key === "Escape" && SIG.run) sigCancel(); });
