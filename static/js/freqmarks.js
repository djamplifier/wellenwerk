"use strict";
// Wellenwerk – Markierungen im Wasserfall: typische Frequenzen der Betriebsarten (static/freqs.json, Aktualisierung ueber das Projekt),
// Rundfunksender, die gerade senden (EiBi), und Relais in der Naehe (hearham, BrandMeister) – um den Standort des Empfaengers
// bzw. der eigenen Station. Ein Klick auf eine Markierung stellt Frequenz und Betriebsart ein, bei Relais auch Dekoder bzw. Ablage und CTCSS.
const FMK = { typ: null, typP: null, bc: { key: "", t: 0, list: [] }, rep: { key: "", t: 0, list: [], ref: null }, hits: [], busy: {} };
const FMK_DV = { DMR: "dmr", "D-STAR": "dstar", YSF: "ysf", NXDN: "nxdn", P25: "p25", M17: "m17" };
const FMK_COL = { ham: "#6fd3c0", wetter: "#ffb35c", zeit: "#b8c4cc", cb: "#c79bff", pmr: "#c79bff", see: "#7fb0ff", flug: "#7fb0ff", ism: "#b8c4cc", bc: "#ffe066", rep: "#7dff8a", repd: "#5cc8ff" };
const fmkOpts = () => { const o = wfOpts(); return { typ: o.mtyp !== false, bc: o.mbc !== false, rep: o.mrep !== false, radius: +o.mrad || 100 }; };
const fmkBroadcastBand = (lo, hi) => (lo < 30e6) && (hi > 148500) && (SW_BC.some(([a, b]) => hi > a * 1000 && lo < b * 1000) || (lo < 1710e3 && hi > 148e3));

function fmkTyp() {
  if (FMK.typ || FMK.typP) return FMK.typ || [];
  FMK.typP = api("/api/freqs/typical").then(d => { FMK.typ = d.freqs || []; }).catch(() => { FMK.typ = []; }).finally(() => { FMK.typP = null; });
  return [];
}
// Rundfunk und Relais: fuer den sichtbaren Bereich nachladen (Bereich gerundet, damit Verschieben nicht staendig neu laedt)
function fmkLoad(kind, url, key, maxAge) {
  const c = FMK[kind];
  if ((c.key === key && Date.now() - c.t < maxAge) || FMK.busy[kind]) return;
  FMK.busy[kind] = true;
  api(url).then(d => { Object.assign(c, { key, t: d.loading ? Date.now() - maxAge + 15000 : Date.now(), list: d.stations || d.repeaters || [], ref: d.ref || null, loading: !!d.loading }); })
    .catch(() => { Object.assign(c, { key, t: Date.now(), list: [] }); }).finally(() => { FMK.busy[kind] = false; });
}
// Markierungen im Bereich view (Hz) fuer den Empfaenger radioId
function fmkMarks(radioId, view) {
  const o = fmkOpts(), [lo, hi] = view, out = [];
  if (o.typ) for (const e of fmkTyp()) if (e.hi >= lo && e.lo <= hi) out.push({ ...e, kind: "typ", col: FMK_COL[e.g] || FMK_COL.ham });
  if (o.bc && fmkBroadcastBand(lo, hi) && hi - lo < 3e6) {
    const a = Math.floor(lo / 1e6) * 1e6, b = Math.ceil(hi / 1e6) * 1e6, key = `${a}-${b}-${Math.floor(Date.now() / 600000)}`;
    fmkLoad("bc", `/api/freqs/broadcast?lo=${a}&hi=${b}`, key, 600000);
    const by = new Map(); for (const s of FMK.bc.list) if (s.f >= lo - 5000 && s.f <= hi + 5000) (by.get(s.f) || by.set(s.f, []).get(s.f)).push(s);
    for (const [f, ss] of by) out.push({ f, lo: f - 4500, hi: f + 4500, m: "AM", t: [...new Set(ss.map(s => s.n))].slice(0, 2).join(" / "), n: ss.map(s => `${s.n} (${s.itu}, ${s.lang}${s.tgt ? " → " + s.tgt : ""})`).join("\n"), kind: "bc", col: FMK_COL.bc });
  }
  if (o.rep && hi > 28e6 && hi - lo < 30e6) {
    const a = Math.floor(lo / 1e6) * 1e6, b = Math.ceil(hi / 1e6) * 1e6, key = `${radioId}-${a}-${b}-${o.radius}`;
    fmkLoad("rep", `/api/freqs/repeaters?lo=${a}&hi=${b}&radius=${o.radius}&radio=${encodeURIComponent(radioId || "")}`, key, 3600000);
    for (const r of FMK.rep.list) if (r.f >= lo - 6000 && r.f <= hi + 6000) {
      const dv = !!FMK_DV[r.m], w = r.m === "D-STAR" || r.m === "NXDN" ? 3000 : 6000;
      out.push({ f: r.f, lo: r.f - w, hi: r.f + w, m: "FM", t: `${r.c} ${r.m}${r.cc != null && r.m === "DMR" ? " CC" + r.cc : ""}${r.tone && !dv ? " " + r.tone : ""}`, kind: "rep", rep: r, col: dv ? FMK_COL.repd : FMK_COL.rep });
    }
  }
  return out;
}
// Zeichnen in die Spektrumflaeche (Leiste unter der Frequenzskala); Trefferflaechen fuer Klicks merken
function fmkDraw(c, W, view, radioId) {
  FMK.hits = [];
  if (!view) return;
  const m = fmkMarks(radioId, view), fx = f => (f - view[0]) / (view[1] - view[0]) * W, y0 = 30;
  c.font = "10px sans-serif";
  const pri = { rep: 0, typ: 1, bc: 2 }; m.sort((a, b) => pri[a.kind] - pri[b.kind] || a.lo - b.lo);
  const used = [], dense = m.length > W / 28;                      // sehr viele: nur Striche in einer Reihe, Beschriftung beim Hineinzoomen
  if (dense) { for (const k of m) { const x0 = Math.max(0, fx(k.lo)), x1 = Math.min(W, Math.max(fx(k.hi), x0 + 2)); c.fillStyle = k.col; c.globalAlpha = 0.8; c.fillRect(x0, y0, x1 - x0, 3); c.globalAlpha = 1;
    FMK.hits.push({ x0: x0 - 1, x1: x1 + 1, y0: y0 - 4, y1: y0 + 8, k }); } return; }
  for (const k of m) {
    const x0 = Math.max(0, fx(k.lo)), x1 = Math.min(W, Math.max(fx(k.hi), x0 + 2)), tw = c.measureText(k.t).width, lx = Math.min(W - tw - 2, Math.max(1, x0));
    const showLbl = x1 - x0 >= tw * 0.6 || (view[1] - view[0]) < 200000, a0 = showLbl ? Math.min(x0, lx) : x0, a1 = showLbl ? Math.max(x1, lx + tw) : x1;
    let row = 0; while (row < 3 && used.some(u => u.row === row && !(a1 + 3 < u.x0 || a0 > u.x1 + 3))) row++;
    const y = y0 + Math.min(row, 2) * 13, lbl = showLbl && row < 3;
    c.fillStyle = k.col; c.globalAlpha = 0.85; c.fillRect(x0, y, x1 - x0, 2); c.globalAlpha = 1;
    if (lbl) { c.fillStyle = "rgba(8,18,28,.75)"; c.fillRect(lx - 1, y + 2, tw + 2, 11); c.fillStyle = k.col; c.fillText(k.t, lx, y + 11); }
    used.push({ row: Math.min(row, 2), x0: lbl ? a0 : x0, x1: lbl ? a1 : x1 });
    FMK.hits.push({ x0: (lbl ? a0 : x0) - 2, x1: (lbl ? a1 : x1) + 2, y0: y - 3, y1: y + 13, k });
  }
}
// Text fuer den Tooltip an der Mausposition (alle Markierungen dort)
function fmkTip(x, y) { const ks = FMK.hits.filter(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1).map(h => h.k);
  return ks.slice(0, 6).map(k => k.kind === "rep" ? `${k.rep.c} · ${k.rep.m} · ${fmkRepFacts(k.rep).slice(0, 4).join(" · ")}` : `${k.t} · ${fmtMHz(k.f)} MHz ${k.m}${k.n ? "\n" + k.n : ""}`).join("\n") + (ks.length ? "\n(Klick: abstimmen)" : ""); }
function fmkHit(x, y) { return (FMK.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) || {}).k || null; }
// bekanntes Relais an dieser Frequenz (Klick in den Kanal: Daten aus der Datenbank statt Erkennung)
function fmkRepAt(f) { return FMK.rep.list.filter(r => Math.abs(r.f - f) <= (r.m === "D-STAR" || r.m === "NXDN" ? 3500 : 6500)).sort((a, b) => Math.abs(a.f - f) - Math.abs(b.f - f) || a.km - b.km)[0] || null; }

// Markierung angeklickt: abstimmen. ctl = Geraet, das abgestimmt wird; data = Empfaenger, dessen Spektrum gezeigt wird
async function fmkTune(k, ctl, data, e) {
  try {
    if (k.kind === "rep") return fmkRepeater(k.rep, ctl, data, e);
    await sigRig(ctl, "mode", { mode: k.m, passband: 0 }); await sigRig(ctl, "freq", { hz: k.f });
    toast(`${k.t} · ${fmtMHz(k.f)} MHz ${k.m}${k.n ? " – " + k.n.split("\n")[0] : ""}`);
  } catch (err) { toast(err.message, true); }
}
async function fmkRepeater(r, ctl, data, e) {
  const dr = sigRadio(data || ctl), decs = dr?.state?.sdr?.decoders || [], dv = FMK_DV[r.m], o = { radio: (dr || {}).id || ctl, ctl, rf: r.f, x: e?.clientX, y: e?.clientY, rep: r };
  if (dv && decs.some(d => d.id === dv)) return sigProbe(o, [dv], decs, { noPre: true, only: dv });     // Dekoder des Empfaengers direkt
  sigCancel();
  const R = SIG.run = { o, stop: false, card: sigCard(o) }, body = $(".sig-body", R.card);
  await sigRig(ctl, "mode", { mode: "FM", passband: 0 }).catch(() => { }); await sigRig(ctl, "freq", { hz: r.f }).catch(err => toast(err.message, true));
  let set = "";
  const radio = sigRadio(ctl);
  if (!dv && radio && !radio.state?.receiver && ctl === WW.current) {                                    // Funkgeraet: Ablage und CTCSS fuer das Relais
    const off = r.rx - r.f; try { await post("/api/rig/repeater", { shift: off ? (off < 0 ? "-" : "+") : "None", offset: Math.abs(off) }); set += "Ablage"; } catch { }
    const t = parseFloat(r.tone); if (t > 60 && t < 260) { try { await post("/api/rig/ctcss", { tone: t }); set += (set ? " und " : "") + "CTCSS"; } catch { } }
  }
  body.innerHTML = `<div class="sig-res sure"><span class="sig-name">${esc(r.c)} · ${esc(r.m === "FM" ? "FM-Relais" : r.m)}</span><span class="sig-conf">Relais-Datenbank</span></div>
    <div class="hint">${fmkRepFacts(r).map(x => `<span>${esc(x)}</span>`).join(" · ")}</div>
    ${set ? `<div class="hint sig-auto">✓ <span>${esc(set)} am Funkgerät eingestellt</span></div>` : ""}
<div class="sig-act"></div>`;
  $(".sig-bar", R.card).classList.add("done"); sigProgress(R, 1);
  if (dv && radio && isSdr(sigRadio(o.radio))) (async () => {                    // ohne Server-Dekoder: Eintrag mit der eigenen Erkennung bestaetigen
    const el = document.createElement("div"); el.className = "hint"; el.textContent = "prüfe das Signal …"; body.insertBefore(el, $(".sig-act", body));
    try { const d = await api(`/api/radios/${encodeURIComponent(o.radio)}/rig/dvdetect`, { method: "POST", body: { secs: 2 } }); if (R.stop) return;
      const hit = (d.found || []).find(x => x.score >= 0.6), id = hit ? (hit.id === "nxdn48" ? "nxdn" : hit.id) : "";
      el.className = hit ? "hint sig-auto" : "hint"; el.textContent = !hit ? "gerade kein Digitalsignal zu hören" : id === dv ? `✓ ${hit.label} bestätigt (Synchronmuster)` : `⚠ abweichend: ${hit.label} erkannt – Eintrag der Datenbank passt nicht`;
    } catch (err) { el.textContent = err.message; } })();
  const b = document.createElement("button"); b.textContent = "Signal prüfen"; b.onclick = () => sigProbe({ ...o, rep: null }, sigProbeList(r.f, decs), decs); $(".sig-act", body).appendChild(b);
}
function fmkRepFacts(r) {
  const off = r.rx - r.f;
  return [`${fmtMHz(r.f)} MHz`, off ? `Ablage ${off > 0 ? "+" : "−"}${(Math.abs(off) / 1e6).toLocaleString(I18N.locale, { maximumFractionDigits: 4 })} MHz` : "Simplex",
    r.m === "DMR" && r.cc != null ? `Colorcode ${r.cc}` : "", r.tone && !FMK_DV[r.m] ? `CTCSS ${String(r.tone).replace(".", ",")} Hz` : "", r.city || "", `${String(r.km).replace(".", ",")} km`,
    r.seen ? `zuletzt aktiv ${r.seen}` : "", r.online === true ? "EchoLink online" : r.online === false ? "EchoLink offline" : "",
    `Quelle: ${{ brandmeister: "BrandMeister", dl3el: "DARC-Relaisliste (DL3EL)", echolink: "EchoLink" }[r.s] || "hearham.com"}`].filter(Boolean);
}
