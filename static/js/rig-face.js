"use strict";
// Wellenwerk – Gerätesteuerung: Geraete-Anzeige im klassischen Aufbau (Status, Tastenbloecke, Frequenz, Abstimmleisten)

// ---------- Bandplaene (ITU-Regionen) ----------
const BANDPLANS = {
  "R1": [["160m", 1810, 2000], ["80m", 3500, 3800], ["60m", 5351.5, 5366.5], ["40m", 7000, 7200], ["30m", 10100, 10150], ["20m", 14000, 14350],
    ["17m", 18068, 18168], ["15m", 21000, 21450], ["12m", 24890, 24990], ["10m", 28000, 29700], ["6m", 50000, 52000], ["4m", 70000, 70500], ["2m", 144000, 146000], ["70cm", 430000, 440000]],
  "R2": [["160m", 1800, 2000], ["80m", 3500, 4000], ["60m", 5330.5, 5406.4], ["40m", 7000, 7300], ["30m", 10100, 10150], ["20m", 14000, 14350],
    ["17m", 18068, 18168], ["15m", 21000, 21450], ["12m", 24890, 24990], ["10m", 28000, 29700], ["6m", 50000, 54000], ["2m", 144000, 148000], ["70cm", 420000, 450000]],
  "R3": [["160m", 1800, 2000], ["80m", 3500, 3900], ["40m", 7000, 7300], ["30m", 10100, 10150], ["20m", 14000, 14350], ["17m", 18068, 18168],
    ["15m", 21000, 21450], ["12m", 24890, 24990], ["10m", 28000, 29700], ["6m", 50000, 54000], ["2m", 144000, 148000], ["70cm", 430000, 440000]],
};
const PLAN_NAMES = [["R1-HF", "160m – 10m (Region 1)", "R1", 10], ["R1-ALL", "160m – 70cm (Region 1)", "R1", 99], ["R2-HF", "160m – 10m (Region 2)", "R2", 10],
  ["R2-ALL", "160m – 70cm (Region 2)", "R2", 99], ["R3-HF", "160m – 10m (Region 3)", "R3", 10], ["R3-ALL", "160m – 70cm (Region 3)", "R3", 99]];
function currentPlan() {
  const key = store.get("rc.plan", "R1-HF"), p = PLAN_NAMES.find(x => x[0] === key) || PLAN_NAMES[0];
  const rng = rxRanges();
  if (rng) {   // Empfaenger (WebSDR/SDR): alle Baender der Region, aber nur die empfangbaren
    const bands = BANDPLANS[p[2]].filter(b => rng.some(([lo, hi]) => b[1] * 1000 < hi && b[2] * 1000 > lo));
    return { key: p[0], title: `${p[1].replace(/ – .*\(/, " (").replace("160m (", "Empfänger (")} · ${bands.length} Bänder empfangbar`, bands: bands.length ? bands : BANDPLANS[p[2]].slice(0, 1) };
  }
  const bands = BANDPLANS[p[2]].filter(b => p[3] === 99 || b[2] <= 30000);
  return { key: p[0], title: p[1], bands };
}
function rxRanges() { const r = WW.rig || {}; return r.receiver && r.sdr && Array.isArray(r.sdr.ranges) && r.sdr.ranges.length ? r.sdr.ranges : null; }

// ---------- Schemata (Farben der Geraeteanzeige) ----------
const SCHEMES = {
  "Standard": { face: "#101214", panel: "#16191c", digits: "#f4f6f8", digitsSub: "#d7dde3", active: "#f4f6f8", inactive: "#3a3f45", btn: "#2a2e33", btnText: "#d9dee4", btnOn: "#3b78c4", btnOnText: "#ffffff", status: "#2ec95c", statusOff: "#5d6670", warn: "#ff4a3a", bars: "#e08a16", barsBg: "#2a2e33", text: "#c9d1d9", meterLow: "#3ccf5a", meterHigh: "#ff4a3a", meterFree: "#2c3136", slider: "#3a3f45", sliderFill: "#5b6570" },
  "LCD": { face: "#ffffff", panel: "#f3f4f6", digits: "#000000", digitsSub: "#202020", active: "#000000", inactive: "#e5e7eb", btn: "#e5e7eb", btnText: "#111827", btnOn: "#6b7280", btnOnText: "#ffffff", status: "#16a34a", statusOff: "#9ca3af", warn: "#dc2626", bars: "#9ca3af", barsBg: "#e5e7eb", text: "#1f2937", meterLow: "#a3a382", meterHigh: "#dc2626", meterFree: "#ececec", slider: "#4b5563", sliderFill: "#6b7280" },
  "Plastik blau": { face: "#0d2a50", panel: "#123762", digits: "#eaf3ff", digitsSub: "#bcd6f5", active: "#ffd34d", inactive: "#1d4c86", btn: "#1d4c86", btnText: "#eaf3ff", btnOn: "#f6b73c", btnOnText: "#1a1000", status: "#7cf08a", statusOff: "#5f7fa8", warn: "#ff6b5e", bars: "#9cc3ef", barsBg: "#1d4c86", text: "#cfe0f5", meterLow: "#47e06a", meterHigh: "#ff5a4a", meterFree: "#1d3f6b", slider: "#1d4c86", sliderFill: "#3b82c4" },
  "LCD grün": { face: "#b9c99a", panel: "#a9be7f", digits: "#1b260b", digitsSub: "#24330e", active: "#1b260b", inactive: "#9fb27a", btn: "#cfd8b6", btnText: "#1b260b", btnOn: "#3f5220", btnOnText: "#e6efd0", status: "#1b260b", statusOff: "#7d8f5c", warn: "#7a1a0a", bars: "#3f5220", barsBg: "#9fb27a", text: "#1b260b", meterLow: "#24330e", meterHigh: "#7a1a0a", meterFree: "#9fb27a", slider: "#7d8f5c", sliderFill: "#3f5220" },
  "Nachtsicht": { face: "#050202", panel: "#0c0505", digits: "#ff3b2f", digitsSub: "#c42a20", active: "#ff3b2f", inactive: "#2a0c0a", btn: "#1a0907", btnText: "#d43a2e", btnOn: "#8a160f", btnOnText: "#ffd7d2", status: "#ff3b2f", statusOff: "#5a1a14", warn: "#ffb0a8", bars: "#a02a20", barsBg: "#1a0907", text: "#d43a2e", meterLow: "#ff3b2f", meterHigh: "#ffb0a8", meterFree: "#1a0907", slider: "#3a110d", sliderFill: "#8a160f" },
};
function rigScheme() {
  const cfg = RC.layout?.scheme || {}; const base = SCHEMES[cfg.base || store.get("rc.scheme", "Standard")] || SCHEMES.Standard;
  return { ...base, ...(cfg.colors || {}) };
}
function applyScheme(root) {
  const s = rigScheme(), st = root.style;
  for (const [k, v] of Object.entries(s)) st.setProperty("--rc-" + k, v);
  const size = RC.layout?.size || "small"; root.dataset.size = size;
}

// ---------- Tastenkatalog ----------
const OP_LABELS = { CPY: "A > B", XCHG: "A ⇄ B", TOGGLE: "A / B", UP: "CH +", DOWN: "CH −", BAND_UP: "Band +", BAND_DOWN: "Band −", TUNE: "Tune", FROM_VFO: "V > M", TO_VFO: "M > V", MCL: "M Clr", LEFT: "◀", RIGHT: "▶" };
function buttonCatalog() {
  const c = WW.caps || {}, cat = {};
  cat["vfo:VFOA"] = { label: "VFO A", kind: "vfo", v: "VFOA" }; cat["vfo:VFOB"] = { label: "VFO B", kind: "vfo", v: "VFOB" };
  cat["vfo:Main"] = { label: "Main", kind: "vfo", v: "Main" }; cat["vfo:Sub"] = { label: "Sub", kind: "vfo", v: "Sub" }; cat["vfo:MEM"] = { label: "Mem", kind: "vfo", v: "MEM" };
  cat["tx:A"] = { label: "TX - A", kind: "tx", v: false }; cat["tx:B"] = { label: "TX - B", kind: "tx", v: true };
  cat["split"] = { label: "Split", kind: "split" };
  cat["ptt"] = { label: "TX", kind: "ptt" };
  cat["scan"] = { label: "Scan", kind: "scan" };
  (c.vfo_ops || Object.keys(OP_LABELS)).forEach(o => { if (OP_LABELS[o]) cat["op:" + o] = { label: OP_LABELS[o], kind: "op", v: o }; });
  (c.ui_funcs || []).forEach(f => cat["func:" + f.name] = { label: f.label, kind: "func", v: f.name });
  ["RIT", "XIT"].forEach(f => { if ((c.funcs_set || []).includes(f)) cat["func:" + f] = { label: f, kind: "func", v: f }; });
  (RC.layout?.custom || []).forEach(b => cat["custom:" + b.id] = { label: b.label, kind: "custom", def: b });
  return cat;
}
const DROP_CATALOG = () => {
  const c = WW.caps || {}, d = { mode: "Mode", filter: "Filter", quickmem: "Quick Mem", offset: "Ablage", tone: "CTCSS" };
  (c.ui_choices || []).forEach(ch => d["lvl:" + ch.name] = ch.label);
  return d;
};
function defaultRigLayout() {
  const cat = buttonCatalog(), has = k => !!cat[k];
  const left = ["vfo:VFOA", "op:CPY", "vfo:VFOB", "op:XCHG", "tx:A", "op:UP", "tx:B", "op:DOWN", "vfo:Main", "vfo:Sub", "vfo:MEM", "split"].filter(has);
  const right = [...Object.keys(cat).filter(k => k.startsWith("func:") && !["func:RIT", "func:XIT"].includes(k)), "op:BAND_UP", "op:BAND_DOWN", "op:TUNE", "scan", "ptt"].filter(has);
  const drops = ["mode", "filter", ...Object.keys(DROP_CATALOG()).filter(k => k.startsWith("lvl:")), "quickmem", "offset"];
  return { left, right, drops, custom: [], sliders: { active: 0, layouts: [(WW.caps.ui_levels || []).map(l => l.name), [], [], [], [], []] } };
}

// ---------- Zustand Gerätesteuerung ----------
const RC = { layout: null, activeDigit: store.get("rc.digit", 6), alt: false, bsp: false, scan: null, peak: null };
async function loadRigLayout() {
  const key = "rig-" + (WW.rig.model || "none").replace(/\W+/g, "_");
  let l = null; try { l = await api("/api/store/" + key); } catch { }
  const def = defaultRigLayout();
  RC.layoutKey = key; RC.layout = l ? { ...def, ...l, sliders: { ...def.sliders, ...(l.sliders || {}) } } : def;
  WW.emit("rc-layout");
}
async function saveRigLayout() { await api("/api/store/" + RC.layoutKey, { method: "PUT", body: RC.layout }); WW.emit("rc-layout"); }

// ---------- Geraeteanzeige (Panel "face") ----------
function createFace(root) {
  root.innerHTML = `<div class="rc" tabindex="0">
    <div class="rc-tabs"></div>
    <div class="rc-face">
      <div class="rc-status"></div>
      <div class="rc-btns rc-left"></div>
      <div class="rc-center">
        <button type="button" class="rc-mode" title="Mode wählen"></button>
        <div class="rc-freq" title="Mausrad: aktive Ziffer · Klick oben/unten: + / − · Ziffern tippen · Enter: Frequenz eingeben"></div>
        <div class="rc-under"><div class="rc-smeter"><div class="rc-sbar"></div><div class="rc-sscale"></div><div class="rc-sval"></div></div>
          <div class="rc-sub" title="Doppelklick: VFO A/B tauschen"><span class="rc-subtag">VFO B</span><span class="rc-subf"></span></div></div>
      </div>
      <div class="rc-btns rc-right"></div>
      <div class="rc-drops"></div>
    </div>
    <div class="rc-dateline"><button type="button" class="rc-scroll" data-d="-1" title="Bänder nach oben blättern">▲</button><button type="button" class="rc-scroll" data-d="1" title="Bänder nach unten blättern">▼</button>
      <span class="rc-date"></span><button type="button" class="rc-plan" title="Bandplan wählen"></button><span class="rc-time"></span></div>
    <div class="rc-tuning">
      <div class="rc-fine" data-span="2400"></div>
      <div class="rc-fine2 hidden" data-span="800"></div>
      <div class="rc-bandbtns"></div>
      <div class="rc-mainbars"></div>
    </div>
  </div>`;
  const rc = $(".rc", root);
  applyScheme(rc);
  // Frequenz: Mausrad / Klick oben-unten / Tastatur
  const fr = $(".rc-freq", rc);
  fr.addEventListener("wheel", e => {
    const d = e.target.closest(".d"); if (!d) return; e.preventDefault();
    RC.activeDigit = +d.dataset.pos; store.set("rc.digit", RC.activeDigit);
    stepDigit(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  let rep;
  fr.addEventListener("mousedown", e => {
    const d = e.target.closest(".d"); if (!d) return;
    RC.activeDigit = +d.dataset.pos; store.set("rc.digit", RC.activeDigit);
    const r = d.getBoundingClientRect(), dir = e.clientY < r.top + r.height / 2 ? 1 : -1;
    stepDigit(dir); rep = setTimeout(function again() { stepDigit(dir); rep = setTimeout(again, 120); }, 450);
  });
  ["mouseup", "mouseleave"].forEach(ev => fr.addEventListener(ev, () => clearTimeout(rep)));
  rc.addEventListener("keydown", e => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.key === "ArrowLeft") { RC.activeDigit = Math.min(9, RC.activeDigit + 1); renderFreqDigits(rc); e.preventDefault(); }
    else if (e.key === "ArrowRight") { RC.activeDigit = Math.max(0, RC.activeDigit - 1); renderFreqDigits(rc); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "+") { stepDigit(1); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "-") { stepDigit(-1); e.preventDefault(); }
    else if (/^[0-9]$/.test(e.key)) { typeDigit(+e.key); e.preventDefault(); }
    else if (e.key === "Enter") { freqDialog(); e.preventDefault(); }
    store.set("rc.digit", RC.activeDigit);
  });
  $(".rc-mode", rc).addEventListener("click", e => popupMenu(e.currentTarget, modeList().map(m => ({ label: m, on: m === WW.rig.mode, act: () => setMode(m) }))));
  $(".rc-sub", rc).addEventListener("dblclick", () => (WW.caps.vfo_ops || []).includes("XCHG") ? act("/api/rig/op", { op: "XCHG" }) : toast("A/B-Tausch nicht unterstützt", true));
  $(".rc-plan", rc).addEventListener("click", e => popupMenu(e.currentTarget, PLAN_NAMES.map(p => ({ label: p[1], on: p[0] === currentPlan().key, act: () => { store.set("rc.plan", p[0]); RC.bsp = false; buildTuning(rc); } }))));
  rc.querySelectorAll(".rc-scroll").forEach(b => b.addEventListener("click", () => { $(".rc-mainbars", rc).scrollBy({ top: +b.dataset.d * 60, behavior: "smooth" }); }));
  rc.addEventListener("click", e => { const b = e.target.closest(".rc-btn"); if (b) pressButton(b.dataset.k, b); });
  rc.addEventListener("click", e => { const t = e.target.closest(".rc-tab"); if (!t) return;
    if (e.target.closest(".x")) { act(`/api/radios/${t.dataset.id}/disconnect`); return; }
    if (t.dataset.id === "+") openConnect(); else act(`/api/radios/${t.dataset.id}/select`); });
  const rebuild = () => { applyScheme(rc); buildButtons(rc); buildTuning(rc); renderFace(rc); };
  let rkey = JSON.stringify(rxRanges());
  const offs = [WW.on("rig", () => { const k = JSON.stringify(rxRanges()); if (k !== rkey) { rkey = k; RC.bsp = false; buildTuning(rc); renderTabs(rc); } renderFace(rc); }), WW.on("rig-local", () => renderFace(rc)), WW.on("rc-layout", rebuild), WW.on("caps", () => loadRigLayout()),
    WW.on("radios", () => renderTabs(rc)), WW.on("spots", () => renderBars(rc)), WW.on("spot", () => renderBars(rc)), WW.on("quicksave", () => renderBars(rc))];
  const clk = setInterval(() => { const n = new Date(); $(".rc-date", rc).textContent = n.toLocaleDateString(I18N.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $(".rc-time", rc).textContent = n.toLocaleTimeString(I18N.locale) + "  ·  " + n.toISOString().slice(11, 19) + " UTC"; }, 1000);
  const ro = new ResizeObserver(() => renderBars(rc)); ro.observe(rc);
  if (!RC.layout) loadRigLayout(); else rebuild();
  renderTabs(rc);
  return () => { offs.forEach(f => f()); clearInterval(clk); ro.disconnect(); };
}
function renderTabs(rc) {
  const conn = WW.radios.filter(r => r.connected), cur = WW.radios.find(r => r.id === WW.current);
  $(".rc-tabs", rc).innerHTML = conn.map(r => `<span class="rc-tab${r.id === WW.current ? " on" : ""}" data-id="${r.id}" title="${esc(r.mfg || "")} ${esc(r.model_name || "")}">${esc(r.name)}<b class="x" title="Trennen">×</b></span>`).join("")
    + `<span class="rc-tab add" data-id="+" title="Funkgerät verbinden">＋ Verbinden</span>`
    + (cur && cur.kind === "sdr" && ["kiwisdr", "openwebrx"].includes(cur.sdr_type) ? `<select class="rc-srv" title="Empfänger wechseln"><option value="">${esc(cur.name)}</option><option value="__load" disabled>Liste wird geladen …</option></select>` : "");
  const sel = $(".rc-srv", rc); if (!sel) return;
  const f = WW.rig.freq || 7074000, curKey = (() => { try { const u = new URL(cur.url.includes("://") ? cur.url : "http://" + cur.url); return u.hostname.toLowerCase() + (["", "80", "443", "8073"].includes(u.port) ? "" : ":" + u.port) + u.pathname.replace(/\/$/, ""); } catch { return cur.url; } })();
  api(`/api/sdr/receivers?type=${cur.sdr_type}&free=true&khz=${cur.sdr_type === "kiwisdr" ? f / 1000 : 0}&limit=40`).then(r => {
    sel.innerHTML = `<option value="">${esc(cur.name)}</option>` + r.receivers.filter(x => x.key !== curKey).map((x, i) =>
      `<option value="${i}">${esc(x.name.slice(0, 60))}${x.km != null ? ` · ${x.km} km` : ""}${x.users_max ? ` · ${x.users}/${x.users_max}` : ""}</option>`).join("") + `<option value="__list">Alle Empfänger …</option>`;
    sel._list = r.receivers.filter(x => x.key !== curKey); }).catch(() => { });
  sel.onchange = async () => { const v = sel.value; if (!v) return; if (v === "__list") { sel.value = ""; return openConnect(null, "sdr"); }
    const x = sel._list[+v]; sel.disabled = true; toast(`wechsle zu ${x.name.slice(0, 50)} …`);
    // Erst den neuen Empfaenger verbinden; der bisherige bleibt verbunden, bis das geklappt hat (sonst koennte sein Platz weg sein)
    let nu = null;
    try { nu = await post("/api/radios", { kind: "sdr", sdr_type: x.type, url: x.url, name: x.name.slice(0, 60), role: cur.role || "main",
        params: `freq=${(f / 1000).toFixed(3)}; mode=${WW.rig.mode || "USB"}; user=${WW.station?.callsign || "Wellenwerk"}` });
      await post(`/api/radios/${nu.id}/connect`); if (cur.role !== "second") await post(`/api/radios/${nu.id}/select`);
      await post(`/api/radios/${cur.id}/disconnect`).catch(() => { }); await api(`/api/radios/${cur.id}`, { method: "DELETE" }).catch(() => { });
      await loadRadios(); rxSync?.(); toast("Empfänger gewechselt"); }
    catch (e) { toast(`${e.message} – bleibe bei ${cur.name}`, true);
      if (nu) await api(`/api/radios/${nu.id}`, { method: "DELETE" }).catch(() => { });
      if (cur.role !== "second") await post(`/api/radios/${cur.id}/select`).catch(() => { });
      await loadRadios(); rxSync?.(); } };
}
function modeList() {
  const m = (WW.caps.modes || []).filter(x => !["WFM", "AMS", "ECSSUSB", "ECSSLSB", "FAX", "SAM", "SAL", "SAH", "DSB"].includes(x));
  return m.length ? [...new Set([...m, ...["PKTUSB", "PKTLSB"].filter(x => (WW.caps.modes || []).includes(x))])] : ["LSB", "USB", "CW", "CWR", "AM", "FM", "RTTY", "PKTUSB", "PKTLSB"];
}
function stepDigit(dir) { setFreq((WW.rig.freq || 0) + dir * 10 ** RC.activeDigit); }
function typeDigit(n) {
  const s = String(Math.round(WW.rig.freq || 0)).padStart(10, "0").split(""), i = 9 - RC.activeDigit;
  s[i] = String(n); RC.activeDigit = Math.max(0, RC.activeDigit - 1); setFreq(+s.join(""));
}
function freqDialog() {
  const d = dialog({ title: "Frequenz eingeben", icon: "i-tune", buttons: [["Schließen", "close"], ["Übernehmen", "apply", "primary"]], body: `
    <div class="grid2"><label class="wide">Frequenz (MHz, kHz oder Hz)<input id="fd-f" value="${esc(fmtMHz(WW.rig.freq || 0))}" autofocus></label>
    <label class="chkrow"><input type="checkbox" id="fd-auto"> Sofort übernehmen</label><label class="chkrow"><input type="checkbox" id="fd-track" checked> Anzeige mitführen</label></div>`,
    onOpen: dd => { const i = $("#fd-f", dd); i.select();
      i.addEventListener("input", () => { if ($("#fd-auto", dd).checked) setFreq(parseFreqInput(i.value)); });
      const off = WW.on("rig", r => { if ($("#fd-track", dd).checked && document.activeElement !== i) i.value = fmtMHz(r.freq); }); dd.addEventListener("close", off); } });
  d.querySelector('[value="apply"]').addEventListener("click", e => { e.preventDefault(); setFreq(parseFreqInput($("#fd-f", d).value)); d.close(); });
}
function renderFreqDigits(rc) {
  const hz = WW.rig.freq || 0, s = String(Math.max(0, Math.round(hz))).padStart(10, "0");
  let html = "", lead = true;
  for (let i = 0; i < 10; i++) {
    const pos = 9 - i; if (s[i] !== "0" || pos < 7) lead = false;
    html += `<span class="d${lead ? " lead" : ""}${pos === RC.activeDigit ? " act" : ""}" data-pos="${pos}">${s[i]}</span>`;
    if (pos % 3 === 0 && pos) html += `<span class="sep${lead ? " lead" : ""}">.</span>`;
  }
  $(".rc-freq", rc).innerHTML = html;
}
function smeterSegs(db) { return db == null ? 0 : db <= 0 ? Math.max(0, Math.min(18, (9 + db / 6) * 2)) : Math.min(30, 18 + db / 5); }
function renderFace(rc) {
  if (!rc.isConnected) return;
  const r = WW.rig, f = r.funcs || {}, lv = r.levels || {}, m = r.meters || {}, o = store.get("opts", {});
  rc.classList.toggle("off", !r.connected); rc.classList.toggle("tx", !!r.ptt);
  renderFreqDigits(rc);
  $(".rc-mode", rc).textContent = r.connected ? (r.mode || "—") : "—";
  $(".rc-subf", rc).textContent = r.vfob_freq ? `${fmtDots(r.vfob_freq)} ${r.vfob_mode || ""}` : "";
  $(".rc-subtag", rc).textContent = (r.vfo === "VFOB" ? "VFO A" : "VFO B") + (r.split ? " · TX" : "");
  // S-Meter (mit Kalibrierung und Spitzenwert)
  let db = m.STRENGTH; if (db != null) db = db * (o.sscale || 1) + (o.soff || 0);
  const segs = r.ptt ? (m.RFPOWER_METER || 0) * 30 : smeterSegs(db);
  RC.peak = Math.max((RC.peak ?? 0) * 0.97, segs);
  if (!$(".rc-sbar i", rc)) $(".rc-sbar", rc).innerHTML = "<i></i>".repeat(30);
  $$(".rc-sbar i", rc).forEach((i, k) => { i.className = k < Math.round(segs) ? (k >= 18 && !r.ptt ? "lit hi" : "lit") : (Math.round(RC.peak) - 1 === k && RC.layout?.peak !== false ? "pk" : ""); });
  $(".rc-sscale", rc).innerHTML = r.ptt ? "<span>PWR 0</span><span>25</span><span>50</span><span>75</span><span>100 %</span>" : "<span>S 1</span><span>3</span><span>5</span><span>7</span><span>9</span><span>+20</span><span>+40</span><span>+60</span>";
  $(".rc-sval", rc).textContent = r.ptt ? `SWR ${(m.SWR ?? 1).toFixed(1)}  ALC ${Math.round((m.ALC || 0) * 100)}%` : sText(db);
  // Statusblock
  const flt = r.passband ? `Filter: ${(r.passband / 1000).toLocaleString(I18N.locale)} kHz` : "Filter: –";
  const st = [["TX", r.ptt, "warn"], ["Busy", r.busy], ["Scanning", !!RC.scan], ["Split", r.split], [flt, !!r.passband, "plain"],
    [`Memory: ${r.mem >= 0 && r.mem != null ? r.mem : "–"}`, r.vfo === "MEM", "plain"], [`CTCSS: ${r.ctcss ? r.ctcss.toFixed(1) : "–"}`, !!f.TSQL || !!f.TONE, "plain"],
    [`RIT ${r.rit ? (r.rit > 0 ? "+" : "") + r.rit : ""}`, !!r.rit || f.RIT], [`XIT ${r.xit ? (r.xit > 0 ? "+" : "") + r.xit : ""}`, !!r.xit || f.XIT],
    ["DSP", !!(f.NR || f.ANF || f.NB)], ["Lock", !!f.LOCK]];
  $(".rc-status", rc).innerHTML = `<div class="rc-meters">${r.ptt ? `ALC ${Math.round((m.ALC || 0) * 100)}<br>SWR ${(m.SWR ?? 1).toFixed(1)}<br>PWR ${Math.round((m.RFPOWER_METER || 0) * 100)}` : "ALC<br>SWR<br>PWR"}</div>`
    + st.map(([t, on, cls]) => `<div class="${on ? "on" : ""} ${cls || ""}">${esc(t.trim())}</div>`).join("")
    + (r.connected ? "" : `<div class="warn on">${esc(r.error || "nicht verbunden")}</div>`);
  // Tastenzustaende
  $$(".rc-btn", rc).forEach(b => b.classList.toggle("on", btnState(b.dataset.k)));
  $$(".rc-drop", rc).forEach(b => { const v = dropValue(b.dataset.k); b.querySelector("span").textContent = v; });
  $$(".rc-bandbtns [data-band]", rc).forEach(b => b.classList.toggle("on", b.dataset.band === bandFor(r.freq)));
  $(".rc-bandbtns [data-x=alt]", rc)?.classList.toggle("on", r.vfo === "VFOB");
  renderBars(rc);
  oobCheck(r.freq);
}
function btnState(k) {
  const r = WW.rig, f = r.funcs || {}, c = buttonCatalog()[k]; if (!c) return false;
  switch (c.kind) {
    case "vfo": return r.vfo === c.v; case "tx": return !!r.split === c.v; case "split": return !!r.split; case "ptt": return !!r.ptt;
    case "func": return !!f[c.v]; case "scan": return !!RC.scan; case "custom": return c.def.type === "mode" && r.mode === c.def.mode;
  }
  return false;
}
async function pressButton(k, el) {
  const c = buttonCatalog()[k]; if (!c) return;
  const r = WW.rig;
  switch (c.kind) {
    case "vfo": return act("/api/rig/vfo", { vfo: c.v });
    case "tx": return act("/api/rig/split", { on: c.v });
    case "split": return act("/api/rig/split", { on: !r.split });
    case "ptt": return act("/api/rig/ptt", { on: !r.ptt });
    case "op": return act("/api/rig/op", { op: c.v });
    case "scan": return RC.scan ? stopScan("gestoppt") : openScanner();
    case "func": { const on = !(r.funcs || {})[c.v]; el.classList.toggle("on", on); WW.rig.funcs = { ...(r.funcs || {}), [c.v]: on }; return act("/api/rig/func", { name: c.v, on }); }
    case "custom": return runCustom(c.def);
  }
}
async function runCustom(b) {
  if (b.type === "mode") return setMode(b.mode);
  if (b.type === "freq") return setFreq(parseFreqInput(b.freq));
  if (b.type === "cat") { try { const r = await post("/api/rig/raw", { cmd: b.cmd }); toast(`${b.label}: ${(r.reply || []).join(" ") || "OK"}`); } catch (e) { toast(e.message, true); } return; }
  if (b.type === "macro") return runMacro(b.macro);
  if (b.type === "func") return act("/api/rig/func", { name: b.func, on: !(WW.rig.funcs || {})[b.func] });
}
function dropValue(k) {
  const r = WW.rig, lv = r.levels || {};
  if (k === "mode") return `Mode: ${r.mode || "–"}`;
  if (k === "filter") return `Filter: ${r.passband ? (r.passband / 1000).toLocaleString(I18N.locale) + " kHz" : "–"}`;
  if (k === "quickmem") return `Quick Mem: ${(store.get("qs." + WW.current, [])).length}`;
  if (k === "offset") return `Ablage: ${r.rptr_shift && r.rptr_shift !== "None" ? r.rptr_shift + " " + (r.rptr_offs / 1e3) + " kHz" : "Simplex"}`;
  if (k === "tone") return `CTCSS: ${r.ctcss ? r.ctcss.toFixed(1) : "aus"}`;
  if (k.startsWith("lvl:")) { const n = k.slice(4), ch = (WW.caps.ui_choices || []).find(x => x.name === n); const o = ch?.options.find(x => x.value == Math.round(lv[n] ?? -99)); return `${ch?.label || n}: ${o ? o.label : "–"}`; }
  return k;
}
const FILTERS = { USB: [1800, 2100, 2400, 2700, 3000], LSB: [1800, 2100, 2400, 2700, 3000], CW: [50, 100, 250, 500, 1200], CWR: [50, 100, 250, 500, 1200], AM: [3000, 6000, 9000], FM: [7000, 10000, 15000], RTTY: [250, 500, 1000, 2400], PKTUSB: [500, 1200, 2400, 3000], PKTLSB: [500, 1200, 2400, 3000] };
const CTCSS = [67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1, 225.7, 233.6, 241.8, 250.3];
function dropMenu(k, anchor) {
  const r = WW.rig, lv = r.levels || {};
  let items = [];
  if (k === "mode") items = modeList().map(m => ({ label: m, on: m === r.mode, act: () => setMode(m) }));
  else if (k === "filter") items = (FILTERS[r.mode] || FILTERS.USB).map(w => ({ label: `${(w / 1000).toLocaleString(I18N.locale)} kHz`, on: w === r.passband, act: () => setMode(r.mode, w) })).concat([{ label: "Standard des Geräts", act: () => setMode(r.mode, 0) }]);
  else if (k === "quickmem") { const qs = store.get("qs." + WW.current, []);
    items = qs.map((q, i) => ({ label: `${i + 1}: ${fmtMHz(q.f)} ${q.m || ""}`, act: () => { setFreq(q.f); if (q.m) setMode(q.m); } })).concat([{ label: "Aktuelle Frequenz speichern", act: quickSave }, { label: "Alle löschen", act: () => { store.set("qs." + WW.current, []); WW.emit("quicksave"); } }]); }
  else if (k === "offset") items = [["Simplex", "+", 0], ["−600 kHz (2 m)", "-", 600000], ["+600 kHz (2 m)", "+", 600000], ["−7,6 MHz (70 cm)", "-", 7600000], ["+7,6 MHz (70 cm)", "+", 7600000]].map(([l, s, o]) => ({ label: l, act: () => setOffset(s, o) }));
  else if (k === "tone") items = [{ label: "aus", act: () => act("/api/rig/func", { name: "TONE", on: false }) }].concat(CTCSS.map(t => ({ label: t.toFixed(1) + " Hz", on: Math.abs((r.ctcss || 0) - t) < 0.05, act: () => setTone(t) })));
  else if (k.startsWith("lvl:")) { const n = k.slice(4), ch = (WW.caps.ui_choices || []).find(x => x.name === n);
    items = (ch?.options || []).map(o => ({ label: o.label, on: o.value == Math.round(lv[n] ?? -99), act: () => act("/api/rig/level", { name: n, value: o.value }) })); }
  popupMenu(anchor, items);
}
async function setOffset(shift, offs) { try { await post("/api/rig/repeater", { shift: offs ? shift : "None", offset: offs }); } catch (e) { toast(e.message, true); } }
async function setTone(t) { try { await post("/api/rig/ctcss", { tone: t }); } catch (e) { toast(e.message, true); } }
function popupMenu(anchor, items) {
  $$(".popmenu").forEach(p => p.remove());
  const m = h(`<div class="popmenu">${items.map((it, i) => `<button type="button" data-i="${i}" class="${it.on ? "on" : ""}">${it.on ? "✓ " : ""}${esc(it.label)}</button>`).join("") || '<div class="hint">keine Einträge</div>'}</div>`);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = (r.bottom + m.offsetHeight > innerHeight ? Math.max(4, r.top - m.offsetHeight) : r.bottom) + "px";
  m.addEventListener("click", e => { const b = e.target.closest("[data-i]"); if (b) { m.remove(); items[+b.dataset.i].act(); } });
  setTimeout(() => document.addEventListener("click", function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("click", off); } }), 0);
}
function buildButtons(rc) {
  const L = RC.layout; if (!L) return; const cat = buttonCatalog();
  const btn = k => cat[k] ? `<button type="button" class="rc-btn" data-k="${esc(k)}" title="${esc(cat[k].label)}">${esc(cat[k].label)}</button>` : "";
  $(".rc-left", rc).innerHTML = L.left.map(btn).join("");
  $(".rc-right", rc).innerHTML = L.right.map(btn).join("");
  const dc = DROP_CATALOG();
  $(".rc-drops", rc).innerHTML = L.drops.filter(k => dc[k]).map(k => `<button type="button" class="rc-drop" data-k="${esc(k)}"><span></span><b>▾</b></button>`).join("");
  $$(".rc-drop", rc).forEach(b => b.addEventListener("click", () => dropMenu(b.dataset.k, b)));
}

// ---------- Abstimmleisten ----------
function buildTuning(rc) {
  const plan = currentPlan();
  $(".rc-plan", rc).textContent = RC.bsp ? `${RC.bsp.band} – Bandspreizung` : plan.title;
  $(".rc-fine2", rc).classList.toggle("hidden", !store.get("rc.fine2", false));
  const bands = plan.bands.map(b => b[0]);
  $(".rc-bandbtns", rc).innerHTML = `<button type="button" data-x="alt" title="Zweiten VFO abstimmen">ALT</button><button type="button" data-x="bsp" title="Bandspreizung">Spreizung</button>`
    + bands.map(b => `<button type="button" data-band="${b}">${b}</button>`).join("");
  $(".rc-bandbtns", rc).onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.x === "alt") return act("/api/rig/vfo", { vfo: WW.rig.vfo === "VFOB" ? "VFOA" : "VFOB" });
    if (b.dataset.x === "bsp") return popupMenu(b, [{ label: "Aus", on: !RC.bsp, act: () => { RC.bsp = false; buildTuning(rc); } },
      ...[25, 50, 100].map(w => ({ label: `${w} kHz je Leiste`, on: RC.bsp?.w === w, act: () => { RC.bsp = { band: bandFor(WW.rig.freq) || "20m", w }; buildTuning(rc); } }))]);
    const band = plan.bands.find(x => x[0] === b.dataset.band), mem = store.get("bandmem", {})[b.dataset.band];
    setFreq(mem?.f || Math.round((band[1] + Math.min(70, (band[2] - band[1]) / 4)) * 1000)); if (mem?.m) setMode(mem.m);
  };
  let rows = plan.bands.map(([n, lo, hi]) => ({ n, lo: lo * 1000, hi: hi * 1000 }));
  if (RC.bsp) { const b = plan.bands.find(x => x[0] === RC.bsp.band) || plan.bands[0]; rows = [];
    for (let f = b[1]; f < b[2]; f += RC.bsp.w) rows.push({ n: (f / 1000).toFixed(3), lo: f * 1000, hi: Math.min(b[2], f + RC.bsp.w) * 1000 }); }
  $(".rc-mainbars", rc).innerHTML = rows.map(r => `<div class="rc-bar" data-lo="${r.lo}" data-hi="${r.hi}"><span class="rc-bl">${esc(r.n)}</span><div class="rc-ruler"></div><span class="rc-bl">${esc(r.n)}</span></div>`).join("");
  rc.querySelectorAll(".rc-fine, .rc-fine2").forEach(el => { el.innerHTML = `<span class="rc-bl">${el.classList.contains("rc-fine2") ? "Feinabstimmung 2" : (store.get("rc.fine2", false) ? "Feinabstimmung 1" : "Feinabstimmung")}</span><div class="rc-ruler"></div><span class="rc-bl"></span>`; });
  rc.querySelectorAll(".rc-ruler").forEach(attachRuler);
  renderBars(rc);
  setTimeout(() => { const cur = rc.querySelector(".rc-bar.cur"); if (cur) cur.scrollIntoView({ block: "nearest" }); }, 50);
}
function rulerRange(rul) {
  const p = rul.parentElement;
  if (p.dataset.lo) return [+p.dataset.lo, +p.dataset.hi];
  const span = +p.dataset.span, f = WW.rig.freq || 0; return [f - span / 2, f + span / 2];
}
function attachRuler(rul) {
  const toF = e => { const [lo, hi] = rulerRange(rul), r = rul.getBoundingClientRect(); return lo + (hi - lo) * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const step = () => { const fine = !!rul.parentElement.dataset.span; return fine ? 10 : 100; };
  let drag = false;
  rul.addEventListener("mousedown", e => { if (e.button !== 0 || e.target.closest(".qs,.sp")) return; drag = true; setFreq(Math.round(toF(e) / step()) * step()); e.preventDefault(); });
  window.addEventListener("mousemove", e => { if (drag) { clearTimeout(rul._t); rul._t = setTimeout(() => setFreq(Math.round(toF(e) / step()) * step()), 40); } });
  window.addEventListener("mouseup", () => drag = false);
  rul.addEventListener("wheel", e => { e.preventDefault(); const o = store.get("opts", {}); let s = +(o.wheel || 100); if (e.shiftKey) s *= 2; if (e.ctrlKey) s *= 5; setFreq((WW.rig.freq || 0) + (e.deltaY < 0 ? s : -s)); }, { passive: false });
  rul.addEventListener("click", e => { const sp = e.target.closest(".sp"), qs = e.target.closest(".qs");
    if (sp) tuneSpot(+sp.dataset.f, sp.dataset.call, sp.dataset.cmt); else if (qs) { setFreq(+qs.dataset.f); if (qs.dataset.m) setMode(qs.dataset.m); } });
}
function faceStep(span, px) { const target = span / (px / 70); const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1e6, 2e6, 5e6]; return steps.find(s => s >= target) || 1e7; }
function renderBars(rc) {
  if (!rc.isConnected) return;
  const f = WW.rig.freq || 0, qs = store.get("qs." + WW.current, []);
  rc.querySelectorAll(".rc-ruler").forEach(rul => {
    const [lo, hi] = rulerRange(rul), w = rul.clientWidth || 600, st = faceStep(hi - lo, w), px = w / (hi - lo);
    const fine = !!rul.parentElement.dataset.span;
    let html = "";
    for (let t = Math.ceil(lo / st) * st; t <= hi; t += st) {
      const x = (t - lo) * px;
      html += `<i class="tk" style="left:${x}px"></i><span class="tl" style="left:${x}px">${(t / 1e6).toFixed(st < 1000 ? 4 : st < 10000 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, ".0")}</span>`;
      for (let k = 1; k < 5; k++) { const xm = x + k * st / 5 * px; if (xm < w) html += `<i class="tk m" style="left:${xm}px"></i>`; }
    }
    if (!fine) {
      const seen = new Set();
      WW.spots.filter(s => s.freq >= lo && s.freq <= hi).forEach(s => { if (seen.has(s.call)) return; seen.add(s.call);
        html += `<span class="sp st-${s.status || "none"}" style="left:${(s.freq - lo) * px}px" data-f="${s.freq}" data-call="${esc(s.call)}" data-cmt="${esc(s.comment)}" title="${esc(s.call)} ${(s.freq / 1e3).toFixed(1)} ${esc(s.country)}">${esc(s.call)}</span>`; });
      qs.forEach((q, i) => { if (q.f >= lo && q.f <= hi) html += `<span class="qs" style="left:${(q.f - lo) * px}px" data-f="${q.f}" data-m="${esc(q.m || "")}" title="Schnellspeicher ${i + 1}: ${fmtMHz(q.f)} ${esc(q.m || "")}">${i + 1}</span>`; });
    }
    const inR = f >= lo && f <= hi;
    rul.parentElement.classList.toggle("cur", inR && !fine);
    if (inR) html += `<b class="mk" style="left:${(f - lo) * px}px"></b>`;
    rul.innerHTML = html;
  });
}
let _oobLast = null;
function oobCheck(f) {
  if (!store.get("opts", {}).oob || !f) return;
  const inB = currentPlan().bands.some(([, lo, hi]) => f >= lo * 1000 && f <= hi * 1000);
  if (_oobLast !== null && inB !== _oobLast) beep(inB ? 880 : 440, 0.18, 0.15);
  _oobLast = inB;
}

// ---------- Schnellspeicher ----------
function quickSave() {
  if (!WW.rig.freq) return toast("Keine Frequenz", true);
  const qs = store.get("qs." + WW.current, []); qs.push({ f: WW.rig.freq, m: WW.rig.mode }); while (qs.length > 10) qs.shift();
  store.set("qs." + WW.current, qs); WW.emit("quicksave"); toast(`Schnellspeicher ${qs.length}: ${fmtMHz(WW.rig.freq)} ${WW.rig.mode}`);
}
