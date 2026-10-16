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
function sigOnClick(radioId, f, e, tapId) {
  if (e && e.altKey) return false;                                   // Alt+Klick: nur abstimmen
  if (wfOpts().sig === false) return false;
  const st = sigState(radioId), inv = SIG_SB[st.mode];
  if (inv === undefined) return false;                               // AM/FM/CW: wie bisher direkt abstimmen
  const dial = Math.round(inv ? f + 1500 : f - 1500);
  sigRig(radioId, "freq", { hz: dial }).catch(err => toast(err.message, true));
  sigIdentify({ radio: tapId || radioId || WW.current, ctl: radioId || WW.current, fc: 1500, rf: f, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: tapId ? 1.8 : 1.2 });
  return true;
}
// Klick im Wasserfall des Digitalbetriebs (Tonfrequenz af): ohne Umstimmen
function sigOnDmClick(af, e) {
  if (wfOpts().sig === false || !D.running) return;
  const st = sigState(), inv = !!SIG_SB[st.mode], dial = st.freq || 0;
  sigIdentify({ radio: WW.current, dmTap: true, fc: af, rf: dial ? (inv ? dial - af : dial + af) : 0, dial, inverted: inv, x: e?.clientX, y: e?.clientY, settle: 0 });
}

function sigCancel() { const R = SIG.run; if (!R) return; R.stop = true; try { R.un?.(); } catch { } R.card?.remove(); SIG.run = null; }
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
  if (res) { sigRender(R, res, false); sigTag(o, res); WW.emit("sig-result", { o, res }); }
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
    ${res.abort ? `<div class="err">${esc(res.abort)}</div>` : ""}<div class="sig-act"></div>`;
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
