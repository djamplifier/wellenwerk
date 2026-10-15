"use strict";
// Wellenwerk – Gerätesteuerung: Regler, Auswahl/Favoriten, Kurzwellen-Datenbank, Bandübersicht, Scanner, Makros, Sprach-Keyer,
// Verbinden-Dialog, Layout anpassen sowie Menues und Werkzeugleiste des Programms.

// ---------- Schieberegler (unten,) ----------
function createSliders(root) {
  root.innerHTML = `<div class="rc rc-sliders-wrap"><div class="rc-sl-head"><select class="rc-sl-layout" title="Regler-Layout"></select></div><div class="rc-sliders"></div></div>`;
  const wrap = $(".rc", root);
  const build = () => {
    applyScheme(wrap);
    const L = RC.layout?.sliders || { active: 0, layouts: [[]] }, defs = WW.caps.ui_levels || [];
    $(".rc-sl-layout", root).innerHTML = L.layouts.map((l, i) => `<option value="${i}" ${i === L.active ? "selected" : ""}>Regler-Layout ${i + 1}${l.length ? "" : " (leer)"}</option>`).join("");
    const names = (L.layouts[L.active] || []).length ? L.layouts[L.active] : defs.map(d => d.name);
    $(".rc-sliders", root).innerHTML = names.map(n => defs.find(d => d.name === n)).filter(Boolean).map(d =>
      `<div class="hslider" data-n="${d.name}" data-min="${d.min}" data-max="${d.max}" data-step="${d.step}" data-type="${d.type}"><i></i><b></b><span></span></div>`).join("")
      || `<div class="hint">${WW.rig.connected ? "Das Funkgerät meldet keine einstellbaren Regler." : "Kein Funkgerät verbunden."}</div>`;
    upd();
  };
  const fmt = (el, v) => { const d = (WW.caps.ui_levels || []).find(x => x.name === el.dataset.n); return `${d?.label || el.dataset.n}: ${d?.type === "f" ? Math.round(v * 100) : Math.round(v)}${d?.type === "f" ? "" : " " + (d?.unit || "")}`; };
  const setVis = (el, v) => { const lo = +el.dataset.min, hi = +el.dataset.max, p = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))); el.querySelector("i").style.width = p * 100 + "%"; el.querySelector("b").style.left = `calc(${p * 100}% - 4px)`; el.querySelector("span").textContent = fmt(el, v); };
  const upd = () => $$(".hslider", root).forEach(el => { if (el._hold) return; const v = (WW.rig.levels || {})[el.dataset.n]; if (v != null) setVis(el, v); else el.querySelector("span").textContent = fmt(el, 0); });
  root.addEventListener("mousedown", e => {
    const el = e.target.closest(".hslider"); if (!el) return;
    const move = ev => { const r = el.getBoundingClientRect(), p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), lo = +el.dataset.min, hi = +el.dataset.max, st = +el.dataset.step || 0.01;
      const v = Math.round((lo + p * (hi - lo)) / st) * st; el._hold = true; setVis(el, v); clearTimeout(el._t); el._t = setTimeout(() => { act("/api/rig/level", { name: el.dataset.n, value: v }); setTimeout(() => el._hold = false, 1500); }, 90); };
    move(e); const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  root.addEventListener("wheel", e => { const el = e.target.closest(".hslider"); if (!el) return; e.preventDefault(); const v = ((WW.rig.levels || {})[el.dataset.n] || 0) + (e.deltaY < 0 ? 1 : -1) * (+el.dataset.step || 0.01) * (el.dataset.type === "f" ? 5 : 1);
    const c = Math.max(+el.dataset.min, Math.min(+el.dataset.max, v)); el._hold = true; setVis(el, c); act("/api/rig/level", { name: el.dataset.n, value: c }).then(() => setTimeout(() => el._hold = false, 1500)); }, { passive: false });
  $(".rc-sl-layout", root).addEventListener("change", e => { RC.layout.sliders.active = +e.target.value; saveRigLayout(); });
  const offs = [WW.on("rig", upd), WW.on("rc-layout", build), WW.on("caps", build)]; build();
  return () => offs.forEach(f => f());
}

// ---------- Auswahl: Favoriten-Baum, Menues, Advanced ----------
async function favList() { try { return await api("/api/favorites"); } catch { return []; } }
function createSelection(root) {
  root.innerHTML = `<div class="selpane"><div class="sel-tabs"><button class="on" data-t="fav">Favoriten</button><button data-t="menus">Menüs</button><button data-t="adv">Advanced</button></div>
    <div class="sel-tb"><button type="button" data-a="add">${icon("i-star")} Favorit</button><button type="button" data-a="folder">${icon("i-plus")} Ordner</button></div><div class="sel-body"></div></div>`;
  let tab = "fav", open = store.get("fav.open", {});
  const body = $(".sel-body", root);
  const draw = async () => {
    $(".sel-tb", root).classList.toggle("hidden", tab !== "fav");
    if (tab === "fav") {
      const favs = await favList(), tree = {};
      favs.forEach(f => { const path = (f.group || "Sonstige").split("/"); let n = tree; path.forEach(p => n = (n[p] = n[p] || { _items: [] })); n._items.push(f); });
      const render = (node, path) => Object.keys(node).filter(k => k !== "_items").sort((a, b) => (parseFloat(b) || 0) - (parseFloat(a) || 0) || a.localeCompare(b)).map(k => {
        const p = path ? path + "/" + k : k, isOpen = open[p] !== false;
        return `<div class="tr-f"><div class="tr-row folder" data-p="${esc(p)}">${isOpen ? "▾" : "▸"} 📁 ${esc(k)}</div>${isOpen ? `<div class="tr-kids">${render(node[k], p)}${node[k]._items.sort((a, b) => a.freq - b.freq).map(f =>
          `<div class="tr-row item" data-id="${f.id}" title="${esc(fmtMHz(f.freq))} MHz ${esc(f.mode)}">📄 ${esc(f.name)} <small>${esc(f.mode || "")}</small><b class="del" data-del="${f.id}">×</b></div>`).join("")}</div>` : ""}</div>`;
      }).join("");
      body.innerHTML = render(tree, "") || `<div class="hint">Noch keine Favoriten. „Favorit“ speichert die aktuelle Frequenz.</div>`;
      body._favs = favs;
    } else if (tab === "menus") {
      const c = WW.caps; body.innerHTML = `<table class="mini">${(c.ui_funcs || []).map(f => `<tr><td>${esc(f.label)}</td><td><button type="button" class="tgl ${(WW.rig.funcs || {})[f.name] ? "on" : ""}" data-func="${f.name}">${(WW.rig.funcs || {})[f.name] ? "Ein" : "Aus"}</button></td></tr>`).join("")}
        ${(c.ui_choices || []).map(ch => `<tr><td>${esc(ch.label)}</td><td><select data-lvl="${ch.name}">${ch.options.map(o => `<option value="${o.value}" ${o.value == Math.round((WW.rig.levels || {})[ch.name] ?? -99) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></td></tr>`).join("")}
        <tr><td>Mode</td><td><select data-mode>${modeList().map(m => `<option ${m === WW.rig.mode ? "selected" : ""}>${m}</option>`).join("")}</select></td></tr></table>`;
    } else {
      body.innerHTML = `<div class="adv">${(WW.caps.ui_levels || []).map(d => { const v = (WW.rig.levels || {})[d.name] ?? d.min;
        return `<label>${esc(d.label)} <b>${d.type === "f" ? Math.round(v * 100) + " %" : Math.round(v) + " " + esc(d.unit)}</b><input type="range" data-lvl2="${d.name}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"></label>`; }).join("") || '<div class="hint">keine Regler</div>'}</div>`;
    }
  };
  root.addEventListener("click", async e => {
    const t = e.target.closest(".sel-tabs button"); if (t) { tab = t.dataset.t; $$(".sel-tabs button", root).forEach(b => b.classList.toggle("on", b === t)); draw(); return; }
    const a = e.target.closest(".sel-tb button"); if (a) { if (a.dataset.a === "add") addFavoriteDialog(); else { const n = prompt("Name des neuen Ordners (Unterordner mit /, z. B. 60m/UK):"); if (n) { open[n] = true; store.set("fav.open", open); addFavoriteDialog(n); } } return; }
    const del = e.target.closest("[data-del]"); if (del) { e.stopPropagation(); if (confirm("Favorit löschen?")) await api(`/api/favorites/${del.dataset.del}`, { method: "DELETE" }); return; }
    const fo = e.target.closest(".folder"); if (fo) { open[fo.dataset.p] = open[fo.dataset.p] === false; store.set("fav.open", open); draw(); return; }
    const it = e.target.closest(".item"); if (it) { const f = body._favs.find(x => x.id == it.dataset.id); if (f) { await setFreq(f.freq); if (f.mode && f.mode !== WW.rig.mode) setMode(f.mode, f.passband || 0); } }
    const tg = e.target.closest("[data-func]"); if (tg) act("/api/rig/func", { name: tg.dataset.func, on: !(WW.rig.funcs || {})[tg.dataset.func] });
  });
  root.addEventListener("change", e => {
    if (e.target.dataset.lvl) act("/api/rig/level", { name: e.target.dataset.lvl, value: +e.target.value });
    if (e.target.dataset.mode !== undefined) setMode(e.target.value);
    if (e.target.dataset.lvl2) act("/api/rig/level", { name: e.target.dataset.lvl2, value: +e.target.value });
  });
  let t; const redraw = () => { if (tab !== "fav") { clearTimeout(t); t = setTimeout(() => { if (!root.contains(document.activeElement)) draw(); }, 600); } };
  const offs = [WW.on("favorites", draw), WW.on("caps", draw), WW.on("rig", redraw)]; draw();
  return () => offs.forEach(f => f());
}
async function addFavoriteDialog(folder) {
  const favs = await favList(), folders = [...new Set([...currentPlan().bands.map(b => b[0]), ...favs.map(f => f.group || "Sonstige"), ...(folder ? [folder] : [])])].sort();
  const auto = `${fmtMHz(WW.rig.freq || 0)} ${WW.rig.mode || ""}`.trim();
  const d = dialog({ title: "Favorit hinzufügen", icon: "i-star", buttons: [["Abbrechen", "close"], ["OK", "ok", "primary"]], body: `
    <p class="hint">Die aktuelle Einstellung wird zu den Favoriten hinzugefügt. Mit „Neuer Ordner“ legst du Ordner an.</p>
    <div class="grid2"><label class="wide chkrow"><input type="radio" name="tt" value="own" checked> Titel <input id="af-t" placeholder="z. B. DCF77 / WWV" style="flex:1"></label>
    <label class="wide chkrow"><input type="radio" name="tt" value="auto"> ${esc(auto)}</label>
    <label>Frequenz<input id="af-f" value="${esc(fmtDots(WW.rig.freq || 0))}"></label><label>Mode<select id="af-m">${modeList().map(m => `<option ${m === WW.rig.mode ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label class="wide">Ordner<select id="af-g" size="7">${folders.map(f => `<option ${f === (folder || bandFor(WW.rig.freq)) ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>
    <button type="button" id="af-new">Neuer Ordner …</button></div>` });
  $("#af-new", d).onclick = () => { const n = prompt("Ordnername (Unterordner mit /):"); if (n) { const o = h(`<option selected>${esc(n)}</option>`); $("#af-g", d).appendChild(o); } };
  d.querySelector('[value="ok"]').addEventListener("click", async e => {
    e.preventDefault();
    const own = d.querySelector('[name="tt"]:checked').value === "own";
    try { await post("/api/favorites", { name: own ? ($("#af-t", d).value || auto) : auto, freq: Math.round(parseFreqInput($("#af-f", d).value)), mode: $("#af-m", d).value, passband: WW.rig.passband || 0, group: $("#af-g", d).value || bandFor(WW.rig.freq) });
      d.close(); toast("Favorit gespeichert"); } catch (err) { toast(err.message, true); }
  });
}

// ---------- Kurzwellen-Datenbank ----------
function createSwData(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk"><input type="checkbox" class="sw-follow" checked> Frequenz folgen (±5 kHz)</label><label class="chk"><input type="checkbox" class="sw-now" checked> nur jetzt auf Sendung</label>
    <input class="sw-q grow" placeholder="Sender / Zielgebiet suchen …"><span class="hint sw-src"></span></div><div class="tablewrap"><table class="grid"><thead><tr><th>kHz</th><th>UTC</th><th>Tage</th><th>Land</th><th>Sender</th><th>Sprache</th><th>Ziel</th><th></th></tr></thead><tbody></tbody></table></div>`;
  let t, last = 0;
  const load = async () => {
    const follow = $(".sw-follow", root).checked, q = $(".sw-q", root).value.trim();
    const p = new URLSearchParams({ now: $(".sw-now", root).checked, q }); if (follow && WW.rig.freq) { p.set("khz", WW.rig.freq / 1000); p.set("span", 5); }
    try { const r = await api("/api/swdb?" + p); $(".sw-src", root).textContent = `EiBi ${r.season?.toUpperCase() || ""}`;
      $("tbody", root).innerHTML = r.rows.map(x => `<tr data-k="${x.khz}"><td>${x.khz}</td><td>${esc(x.start)}–${esc(x.stop)}</td><td>${esc(x.days)}</td><td>${esc(x.itu)}</td><td><b>${esc(x.station)}</b></td><td>${esc(x.lang)}</td><td>${esc(x.target)}</td><td>${x.live ? "●" : ""}</td></tr>`).join("") || `<tr><td colspan="8" class="hint">keine Einträge${follow ? " in der Nähe der aktuellen Frequenz" : ""}</td></tr>`;
    } catch (e) { $("tbody", root).innerHTML = `<tr><td colspan="8" class="err">${esc(e.message)}</td></tr>`; }
  };
  root.addEventListener("change", load); root.addEventListener("input", e => { if (e.target.classList.contains("sw-q")) { clearTimeout(t); t = setTimeout(load, 300); } });
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-k]"); if (tr) { setFreq(+tr.dataset.k * 1000); setMode("AM"); } });
  const off = WW.on("rig", r => { if ($(".sw-follow", root).checked && Math.abs((r.freq || 0) - last) > 3000) { last = r.freq; load(); } });
  load(); return off;
}

// ---------- Bandübersicht (Durchlauf mit S-Meter, fuer Geraete ohne eigenes Spektrum) ----------
function createBandscope(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk">Breite <select class="bs-span"><option value="10000">±5 kHz</option><option value="20000" selected>±10 kHz</option><option value="50000">±25 kHz</option><option value="100000">±50 kHz</option></select></label>
    <label class="chk">Schritt <select class="bs-step"><option value="250">250 Hz</option><option value="500" selected>500 Hz</option><option value="1000">1 kHz</option><option value="2500">2,5 kHz</option></select></label>
    <button type="button" class="bs-go">▶ Durchlauf</button><label class="chk"><input type="checkbox" class="bs-rep"> wiederholen</label><span class="hint bs-info">Fährt die Frequenz ab und liest das S-Meter. Danach zurück auf die Ausgangsfrequenz.</span></div><canvas class="bs-cv"></canvas>`;
  const cv = $(".bs-cv", root); let run = null, data = [];
  const draw = () => { const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight, c = cv.getContext("2d"); c.fillStyle = "#0b0f14"; c.fillRect(0, 0, W, H);
    if (!data.length) return; const lo = data[0].f, hi = data[data.length - 1].f || lo + 1;
    c.strokeStyle = "#233"; for (let s = 1; s <= 9; s += 2) { const y = H - (s / 9) * 0.6 * H; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); c.fillStyle = "#567"; c.fillText("S" + s, 2, y - 2); }
    data.forEach(p => { const x = (p.f - lo) / (hi - lo || 1) * W, segs = smeterSegs(p.db); c.fillStyle = segs > 18 ? "#ff5a4a" : "#3ccf5a"; const hh = segs / 30 * H; c.fillRect(x - 1, H - hh, Math.max(2, W / data.length - 1), hh); });
    c.fillStyle = "#9ab"; c.fillText(`${fmtMHz(lo)} – ${fmtMHz(hi)} MHz`, W / 2 - 50, 12); };
  cv.addEventListener("click", e => { if (!data.length) return; const r = cv.getBoundingClientRect(), lo = data[0].f, hi = data[data.length - 1].f; setFreq(Math.round(lo + (e.clientX - r.left) / r.width * (hi - lo))); });
  $(".bs-go", root).addEventListener("click", async () => {
    if (run) { run.stop = true; return; }
    const span = +$(".bs-span", root).value, step = +$(".bs-step", root).value, center = WW.rig.freq; if (!center) return toast("Kein Funkgerät", true);
    run = { stop: false }; $(".bs-go", root).textContent = "■ Stopp";
    do { data = []; for (let f = center - span / 2; f <= center + span / 2 && !run.stop; f += step) {
      await post("/api/rig/freq", { hz: Math.round(f) }).catch(() => { }); await new Promise(r => setTimeout(r, 160)); const db = (WW.rig.meters || {}).STRENGTH; data.push({ f, db: db ?? -54 }); draw(); }
    } while ($(".bs-rep", root).checked && !run.stop);
    await setFreq(center); run = null; $(".bs-go", root).textContent = "▶ Durchlauf";
  });
  const ro = new ResizeObserver(draw); ro.observe(cv); return () => { ro.disconnect(); if (run) run.stop = true; };
}

// ---------- Scanner (Bereich / Favoriten) ----------
function openScanner() {
  const d = dialog({ title: "Scanner", icon: "i-scan", buttons: [["Schließen", "close"]], body: `
    <div class="seg"><label><input type="radio" name="sm" value="range" checked> Bereich</label><label><input type="radio" name="sm" value="favs"> Favoriten</label><label><input type="radio" name="sm" value="qs"> Schnellspeicher</label></div>
    <div class="grid2 sc-range"><label>Von MHz<input id="sc-from" value="${esc(fmtMHz((WW.rig.freq || 14150000) - 50000))}"></label><label>Bis MHz<input id="sc-to" value="${esc(fmtMHz((WW.rig.freq || 14250000) + 50000))}"></label>
      <label>Schritt kHz<input id="sc-step" value="5"></label><label>Verweilen ms<input id="sc-dwell" value="400"></label></div>
    <div class="grid2"><label>Anhalten ab<select id="sc-stop"><option value="">nie</option><option value="-42">S3</option><option value="-30" selected>S5</option><option value="-18">S7</option><option value="0">S9</option><option value="20">S9+20</option><option value="busy">Squelch offen</option></select></label>
      <label>Pause bei Signal s<input id="sc-pause" value="5"></label></div>
    <div class="scan-status" id="sc-st">${RC.scan ? "läuft" : "bereit"}</div>
    <div class="ctl-row"><button type="button" class="primary" id="sc-go">Start</button><button type="button" id="sc-stopb">Stopp</button></div>` });
  $("#sc-go", d).onclick = async () => {
    stopScan(); const mode = d.querySelector('[name="sm"]:checked').value; let list;
    if (mode === "favs") list = (await favList()).map(f => ({ f: f.freq, m: f.mode, n: f.name }));
    else if (mode === "qs") list = store.get("qs." + WW.current, []).map(q => ({ f: q.f, m: q.m }));
    else { const a = parseFreqInput($("#sc-from", d).value), b = parseFreqInput($("#sc-to", d).value), st = +String($("#sc-step", d).value).replace(",", ".") * 1000;
      if (!(a > 0 && b > a && st > 0) || (b - a) / st > 5000) return toast("Bereich prüfen", true); list = []; for (let f = a; f <= b; f += st) list.push({ f: Math.round(f) }); }
    if (!list.length) return toast("Nichts zu scannen", true);
    const dwell = Math.max(150, +$("#sc-dwell", d).value || 400), stopAt = $("#sc-stop", d).value, pause = Math.max(1, +$("#sc-pause", d).value || 5) * 1000;
    const sc = RC.scan = { i: 0, alive: true }; WW.emit("rig", WW.rig);
    const step = async () => { if (!sc.alive) return; const it = list[sc.i++ % list.length]; await setFreq(it.f); if (it.m && it.m !== WW.rig.mode) await setMode(it.m);
      if (!sc.alive) return; const st = $("#sc-st"); if (st) st.textContent = `läuft · ${fmtMHz(it.f)} MHz${it.n ? " · " + it.n : ""}`;
      sc.t = setTimeout(() => { const db = (WW.rig.meters || {}).STRENGTH, hit = stopAt === "busy" ? WW.rig.busy : stopAt !== "" && db != null && db >= +stopAt;
        if (hit) { const s2 = $("#sc-st"); if (s2) s2.textContent = `Signal ${sText(db)} auf ${fmtMHz(it.f)} MHz – Pause`; sc.t = setTimeout(step, pause); } else step(); }, dwell); };
    step();
  };
  $("#sc-stopb", d).onclick = () => stopScan("gestoppt");
}
function stopScan(msg) { if (RC.scan) { RC.scan.alive = false; clearTimeout(RC.scan.t); RC.scan = null; WW.emit("rig", WW.rig); } const st = $("#sc-st"); if (msg && st) st.textContent = msg; }

// ---------- Makros (Befehlsfolgen) ----------
const MACRO_HELP = "Eine Zeile je Schritt: FREQ 14.205 · MODE USB · FILTER 2400 · FUNC NB ON · LEVEL AF 0.4 · VFO VFOB · SPLIT ON · OP CPY · CAT FA00014205000; · PTT ON · WAIT 500";
async function runMacro(text) {
  for (const raw of (text || "").split("\n")) {
    const [cmd, ...a] = raw.trim().split(/\s+/); if (!cmd) continue;
    const C = cmd.toUpperCase();
    try {
      if (C === "FREQ") await setFreq(parseFreqInput(a[0]));
      else if (C === "MODE") await post("/api/rig/mode", { mode: a[0], passband: 0 });
      else if (C === "FILTER") await post("/api/rig/mode", { mode: WW.rig.mode, passband: +a[0] });
      else if (C === "FUNC") await post("/api/rig/func", { name: a[0], on: /^(ON|1|EIN)$/i.test(a[1] || "ON") });
      else if (C === "LEVEL") await post("/api/rig/level", { name: a[0], value: +a[1] });
      else if (C === "VFO") await post("/api/rig/vfo", { vfo: a[0] });
      else if (C === "SPLIT") await post("/api/rig/split", { on: /^(ON|1|EIN)$/i.test(a[0]) });
      else if (C === "OP") await post("/api/rig/op", { op: a[0] });
      else if (C === "CAT") await post("/api/rig/raw", { cmd: a.join(" ") });
      else if (C === "PTT") await post("/api/rig/ptt", { on: /^(ON|1|EIN)$/i.test(a[0]) });
      else if (C === "WAIT") await new Promise(r => setTimeout(r, +a[0] || 100));
      else throw new Error("unbekannter Schritt " + cmd);
    } catch (e) { toast(`Makro: ${raw.trim()} – ${e.message}`, true); return; }
  }
}
function openMacros() {
  const ms = store.get("macros", []);
  const d = dialog({ title: "Makros", icon: "i-key", wide: true, buttons: [["Schließen", "close"]], body: `<p class="hint">${esc(MACRO_HELP)}</p>
    <div class="macro-ed"><select size="10" id="mc-list">${ms.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join("")}</select>
    <div><label>Name<input id="mc-name"></label><label>Schritte<textarea id="mc-text" rows="8"></textarea></label>
    <div class="ctl-row"><button type="button" id="mc-save" class="primary">Speichern</button><button type="button" id="mc-run">Ausführen</button><button type="button" id="mc-del" class="danger">Löschen</button></div></div></div>` });
  const sel = $("#mc-list", d); let cur = -1;
  sel.onchange = () => { cur = +sel.value; $("#mc-name", d).value = ms[cur].name; $("#mc-text", d).value = ms[cur].text; };
  $("#mc-save", d).onclick = () => { const m = { name: $("#mc-name", d).value || "Makro", text: $("#mc-text", d).value }; if (cur >= 0) ms[cur] = m; else ms.push(m); store.set("macros", ms); d.close(); openMacros(); renderMenus(APPS.rig); };
  $("#mc-run", d).onclick = () => runMacro($("#mc-text", d).value);
  $("#mc-del", d).onclick = () => { if (cur >= 0) { ms.splice(cur, 1); store.set("macros", ms); d.close(); openMacros(); renderMenus(APPS.rig); } };
}

// ---------- Sprach-Keyer ----------
const VK = { rec: null, ctx: null };
function openVoiceKeyer() {
  const d = dialog({ title: "Sprach-Keyer", icon: "i-mic", buttons: [["Schließen", "close"]], body: `<p class="hint">Bis zu 6 Durchsagen mit dem Mikrofon aufnehmen und über die Soundkarte zum Funkgerät senden (PTT automatisch). Soundkarten-Zugriff nur über https://…:8443.</p>
    <table class="mini">${[1, 2, 3, 4, 5, 6].map(i => `<tr><td>M${i}</td><td><input class="vk-name" data-i="${i}" value="${esc(store.get("vk.name." + i, i === 1 ? "CQ" : ""))}" style="width:140px"></td><td><button type="button" data-rec="${i}">● Aufnehmen</button></td><td><button type="button" data-play="${i}">▶ Senden</button></td><td class="hint vk-st" data-i="${i}"></td></tr>`).join("")}</table>
    <label class="chk">Ausgang <select id="vk-out"><option value="">Standard</option></select></label>` });
  navigator.mediaDevices?.enumerateDevices().then(ds => { $("#vk-out", d).innerHTML += ds.filter(x => x.kind === "audiooutput").map(x => `<option value="${esc(x.deviceId)}">${esc(x.label || x.deviceId.slice(0, 8))}</option>`).join(""); });
  d.addEventListener("change", e => { if (e.target.classList.contains("vk-name")) store.set("vk.name." + e.target.dataset.i, e.target.value); });
  d.addEventListener("click", async e => {
    const r = e.target.closest("[data-rec]"), p = e.target.closest("[data-play]");
    if (r) {
      const i = r.dataset.rec;
      if (VK.rec) { VK.rec.stop(); return; }
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const chunks = []; VK.rec = new MediaRecorder(s); r.textContent = "■ Stopp";
        VK.rec.ondataavailable = ev => chunks.push(ev.data);
        VK.rec.onstop = async () => { s.getTracks().forEach(t => t.stop()); VK.rec = null; r.textContent = "● Aufnehmen"; const b = new Blob(chunks, { type: "audio/webm" });
          const buf = await b.arrayBuffer(); const db = await vkDb(); db.put(buf, "m" + i); $(`.vk-st[data-i="${i}"]`, d).textContent = `${(b.size / 1024).toFixed(0)} kB gespeichert`; };
        VK.rec.start(); } catch (err) { toast("Mikrofon: " + err.message, true); }
    }
    if (p) { const db = await vkDb(); const buf = await db.get("m" + p.dataset.play); if (!buf) return toast("Erst aufnehmen", true);
      VK.ctx = VK.ctx || new AudioContext(); const out = $("#vk-out", d).value; if (out && VK.ctx.setSinkId) await VK.ctx.setSinkId(out).catch(() => { });
      const ab = await VK.ctx.decodeAudioData(buf.slice(0)); const src = VK.ctx.createBufferSource(); src.buffer = ab; src.connect(VK.ctx.destination);
      await post("/api/rig/ptt", { on: true }).catch(e2 => toast(e2.message, true)); src.onended = () => post("/api/rig/ptt", { on: false }); src.start(); }
  });
}
function vkDb() { return new Promise((ok, bad) => { const r = indexedDB.open("ww-voice", 1); r.onupgradeneeded = () => r.result.createObjectStore("m"); r.onerror = () => bad(r.error);
  r.onsuccess = () => { const db = r.result; ok({ put: (v, k) => new Promise(res => { const tx = db.transaction("m", "readwrite"); tx.objectStore("m").put(v, k); tx.oncomplete = res; }),
    get: k => new Promise(res => { const q = db.transaction("m").objectStore("m").get(k); q.onsuccess = () => res(q.result); }) }); }; }); }

// ---------- Verbinden ----------
async function openConnect(editId) {
  let models = [], ports = [];
  try { [models, ports] = await Promise.all([api("/api/hamlib/models"), api("/api/hamlib/ports")]); } catch (e) { toast(e.message, true); }
  const mfgs = [...new Set(models.map(m => m.mfg))].sort((a, b) => a.localeCompare(b));
  const d = dialog({ title: "Verbinden", icon: "i-plug", wide: true, buttons: [["Schließen", "close"]], body: `
    <div class="dtabs"><button class="on" data-t="new">Neu</button><button data-t="preset">Gespeichert</button><button data-t="ports">Serielle Ports</button><button data-t="help">Hilfe</button></div>
    <div class="dtab" data-t="new"><div class="cn-grid"><div>
      <input type="hidden" id="cn-id">
      <div class="ctl-row cn-tpl"><span class="hint">Vorlage:</span><button type="button" data-tpl="wfview">wfview (Icom-Remote)</button><button type="button" data-tpl="flrig">FLRig</button><button type="button" data-tpl="ww">andere Wellenwerk-Station</button></div>
      <p class="hint cn-tplhint hidden"></p>
      <label>Hersteller<select id="cn-mfg">${mfgs.map(m => `<option>${esc(m)}</option>`).join("")}</select></label>
      <label>Funkgerät<select id="cn-model"></select></label>
      <label>Name<input id="cn-name" placeholder="z. B. IC-7300 Shack"></label>
      <div class="cn-serial"><label>COM-Port<select id="cn-dev">${ports.map(p => `<option value="${esc(p.device)}">${esc(p.device)}${p.desc ? " – " + esc(p.desc) : ""}</option>`).join("")}<option value="__other">anderer …</option></select></label>
        <input id="cn-dev2" class="hidden" placeholder="/dev/ttyUSB0 oder COM3">
        <label>Geschwindigkeit<select id="cn-speed"><option value="auto">Auto-Detect</option>${[4800, 9600, 19200, 38400, 57600, 115200].map(s => `<option ${s === 19200 ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label>CI-V-Adresse (Icom, hex)<input id="cn-civ" placeholder="automatisch, z. B. 94"></label>
        <fieldset><legend>Flusssteuerung / Schnittstellen-Strom</legend><label class="chkrow"><input type="checkbox" id="cn-cts"> CTS (Hardware-Handshake)</label>
          <label class="chkrow"><input type="checkbox" id="cn-dtr"> DTR</label><label class="chkrow"><input type="checkbox" id="cn-rts"> RTS</label></fieldset>
        <label>PTT über<select id="cn-ptt"><option value="RIG">CAT-Befehl (Funkgerät)</option><option value="DTR">DTR-Leitung</option><option value="RTS">RTS-Leitung</option><option value="CM108">CM108 (USB-Soundkarte)</option><option value="NONE">keine (VOX)</option></select></label>
        <input id="cn-pttdev" class="hidden" placeholder="Port für PTT (leer = gleicher Port)"></div>
      <div class="cn-net hidden"><label>Adresse (Host:Port)<input id="cn-host" placeholder="192.168.1.20:4532"></label></div>
      <label>Weitere Hamlib-Einstellungen<input id="cn-conf" placeholder="z. B. post_write_delay=10, timeout=1000"></label>
      <label class="chkrow"><input type="checkbox" id="cn-auto"> Beim Start immer mit diesem Gerät verbinden</label>
      <label class="chkrow"><input type="checkbox" id="cn-scope"> Panadapter: Scope-Daten vom Gerät empfangen (Icom mit Spektrum, z. B. IC-7300/705/9700)</label>
      <label class="chkrow"><input type="checkbox" id="cn-share"> Für andere Rechner im Heimnetz freigeben (WSJT-X, N1MM, fldigi auf einem anderen PC)</label>
      <div class="ctl-row"><button type="button" class="primary" id="cn-go">${icon("i-plug")} Verbinden</button><button type="button" id="cn-save">Nur speichern</button><button type="button" id="cn-det">Baudrate suchen</button></div>
    </div><div><b>Status</b><div class="cn-status" id="cn-st"></div></div></div></div>
    <div class="dtab hidden" data-t="preset"><table class="grid" id="cn-presets"></table></div>
    <div class="dtab hidden" data-t="ports"><table class="grid"><thead><tr><th>Port</th><th>Beschreibung</th><th>Hardware</th></tr></thead><tbody>${ports.map(p => `<tr><td>${esc(p.device)}</td><td>${esc(p.desc)}</td><td>${esc(p.hwid)}</td></tr>`).join("") || `<tr><td colspan="3" class="hint">Keine seriellen Ports gefunden. Funkgerät per USB anschließen und neu öffnen.</td></tr>`}</tbody></table></div>
    <div class="dtab hidden" data-t="help"><p>Wellenwerk steuert Funkgeräte über <b>Hamlib</b> (${models.length} Modelle). Für Geräte im Netzwerk wähle Hersteller <b>Hamlib → NET rigctl</b>, <b>FLRig</b> oder bei FlexRadio das passende Modell mit Adresse.</p>
      <ul><li><b>Icom:</b> CI-V-Adresse wie im Gerätemenü (z. B. IC-7300 = 94, IC-705 = A4, IC-9700 = A2). Im Gerät „CI-V USB Echo Back“ meist aus.</li>
      <li><b>Yaesu/Kenwood:</b> Baudrate wie im Gerätemenü (CAT RATE), oft 38400.</li><li><b>Geräte mit eigener USB-Soundkarte:</b> PTT über CAT; Audio für Digitalmodi im Programm Digitalbetrieb einstellen.</li>
      <li>Antwortet das Gerät nicht, steht die Meldung von Hamlib im Statusfeld.</li>
      <li><b>Gerät mit anderen Programmen teilen</b> (wie Gerätefreigabe für Fremdprogramme): In WSJT-X, JTDX, N1MM, Log4OM oder fldigi als Funkgerät <b>Hamlib NET rigctl</b> wählen und die Adresse aus „Gespeichert → Für andere Programme“ eintragen (z. B. 127.0.0.1:4600). Wellenwerk und das andere Programm steuern dann gleichzeitig dasselbe Gerät.</li></ul></div>` });
  tabsIn(d);
  const fillModels = () => { const mf = $("#cn-mfg", d).value; $("#cn-scope", d).checked = /icom/i.test(mf); $("#cn-model", d).innerHTML = models.filter(m => m.mfg === mf).map(m => `<option value="${m.id}">${esc(m.model)}${m.status && m.status !== "Stable" ? " (" + esc(m.status) + ")" : ""}</option>`).join(""); netVis(); };
  const netVis = () => { const id = +$("#cn-model", d).value, mf = $("#cn-mfg", d).value; const net = [2, 4, 5].includes(id) || /flex/i.test(mf) && /6\d00|smart|tci/i.test($("#cn-model", d).selectedOptions[0]?.text || "");
    $(".cn-net", d).classList.toggle("hidden", !net); $(".cn-serial", d).classList.toggle("hidden", net || id === 1); };
  $("#cn-mfg", d).onchange = fillModels; $("#cn-model", d).onchange = netVis;
  $("#cn-dev", d).onchange = e => $("#cn-dev2", d).classList.toggle("hidden", e.target.value !== "__other");
  $("#cn-ptt", d).onchange = e => $("#cn-pttdev", d).classList.toggle("hidden", !["DTR", "RTS"].includes(e.target.value));
  $("#cn-mfg", d).value = mfgs.includes("Icom") ? "Icom" : mfgs[0]; fillModels();
  const status = (t, bad) => { $("#cn-st", d).innerHTML += `<div class="${bad ? "err" : ""}">${esc(t)}</div>`; $("#cn-st", d).scrollTop = 1e6; };
  const collect = () => { const id = +$("#cn-model", d).value, m = models.find(x => x.id === id) || {}, dev = $("#cn-dev", d).value === "__other" ? $("#cn-dev2", d).value.trim() : $("#cn-dev", d).value;
    return { id: $("#cn-id", d).value || undefined, name: $("#cn-name", d).value.trim() || `${m.mfg} ${m.model}`, model: id, mfg: m.mfg, model_name: m.model, device: dev,
      speed: $("#cn-speed", d).value, civaddr: $("#cn-civ", d).value.trim(), handshake: $("#cn-cts", d).checked ? "hardware" : "default",
      dtr_state: $("#cn-dtr", d).checked ? "on" : "default", rts_state: $("#cn-rts", d).checked && !$("#cn-cts", d).checked ? "on" : "default",
      ptt_type: $("#cn-ptt", d).value, ptt_device: $("#cn-pttdev", d).value.trim(), host: $("#cn-host", d).value.trim(), conf: $("#cn-conf", d).value.trim(), autoconnect: $("#cn-auto", d).checked, share: $("#cn-share", d).checked, scope: $("#cn-scope", d).checked }; };
  const fill = p => { $("#cn-id", d).value = p.id; $("#cn-mfg", d).value = p.mfg || (models.find(m => m.id === +p.model) || {}).mfg; fillModels(); $("#cn-model", d).value = p.model; netVis();
    $("#cn-name", d).value = p.name || ""; if (p.device) { if (![...$("#cn-dev", d).options].some(o => o.value === p.device)) { $("#cn-dev", d).value = "__other"; $("#cn-dev2", d).value = p.device; $("#cn-dev2", d).classList.remove("hidden"); } else $("#cn-dev", d).value = p.device; }
    $("#cn-speed", d).value = p.speed || "auto"; $("#cn-civ", d).value = p.civaddr || ""; $("#cn-cts", d).checked = p.handshake === "hardware"; $("#cn-dtr", d).checked = p.dtr_state === "on"; $("#cn-rts", d).checked = p.rts_state === "on";
    $("#cn-ptt", d).value = p.ptt_type || "RIG"; $("#cn-pttdev", d).value = p.ptt_device || ""; $("#cn-host", d).value = p.host || ""; $("#cn-conf", d).value = p.conf || ""; $("#cn-auto", d).checked = !!p.autoconnect; $("#cn-share", d).checked = !!p.share; $("#cn-scope", d).checked = p.scope ?? /icom/i.test(p.mfg || ""); };
  const TPL = {
    wfview: { mfg: "Hamlib", model: 2, name: "wfview Remote", host: "127.0.0.1:4533", hint: "In wfview: <i>Einstellungen → External Control → Enable RigCtld</i> (Port 4533). wfview verbindet sich selbst mit der entfernten Icom-Station (LAN/Internet) und stellt Gerät und Ton bereit; Wellenwerk steuert über diesen Port. Läuft wfview auf einem anderen Rechner, dessen Adresse eintragen. Ton: wfview-Audio als Soundkarte im Digitalbetrieb bzw. Fernbetrieb-Audio wählen." },
    flrig: { mfg: "FLRig", model: 4, name: "FLRig", host: "127.0.0.1:12345", hint: "FLRig muss laufen (XML-RPC, Standardport 12345)." },
    ww: { mfg: "Hamlib", model: 2, name: "Wellenwerk-Station", host: "192.168.1.20:4600", hint: "Auf der anderen Wellenwerk-Station das Gerät für andere Rechner freigeben; Adresse aus „Gespeichert → Für andere Programme“ eintragen." } };
  $(".cn-tpl", d).onclick = e => { const t = TPL[e.target.dataset.tpl]; if (!t) return;
    const mf = $("#cn-mfg", d); mf.value = [...mf.options].some(o => o.value === t.mfg) ? t.mfg : mf.value; mf.dispatchEvent(new Event("change"));
    const md = $("#cn-model", d); md.value = String(t.model); md.dispatchEvent(new Event("change"));
    $("#cn-name", d).value = t.name; $("#cn-host", d).value = t.host; const h = $(".cn-tplhint", d); h.innerHTML = t.hint; h.classList.remove("hidden"); };
  const save = async () => { const p = collect(); if (!p.model) throw new Error("Funkgerät wählen"); const r = await post("/api/radios", p); $("#cn-id", d).value = r.id; return r; };
  $("#cn-save", d).onclick = async () => { try { const r = await save(); status(`Gespeichert: ${r.name}`); drawPresets(); } catch (e) { status(e.message, true); } };
  $("#cn-go", d).onclick = async () => { try { const r = await save(); status(`Verbinde mit ${r.name} …`);
    await post(`/api/radios/${r.id}/connect`); status("Verbunden ✓"); const lg = await api(`/api/radios/${r.id}/log`); (lg.log || []).slice(0, 1).forEach(l => status(l));
    await loadRadios(); setTimeout(() => d.close(), 700); } catch (e) { status(e.message, true); } };
  $("#cn-det", d).onclick = async () => { const p = collect(); status(`Suche Baudrate für ${p.model_name} an ${p.device} …`);
    try { const r = await post("/api/radios/detect", p); if (r.ok) { $("#cn-speed", d).value = String(r.speed); status(`Gefunden: ${r.speed} Baud, Frequenz ${fmtMHz(r.freq)} MHz ✓`); } else (r.log || []).forEach(l => status(l, true)); } catch (e) { status(e.message, true); } };
  const drawPresets = async () => { await loadRadios();
    $("#cn-presets", d).innerHTML = `<thead><tr><th>Name</th><th>Gerät</th><th>Port</th><th>Baud</th><th>Auto</th><th title="Andere Programme verbinden sich mit Hamlib „NET rigctl“ auf diese Adresse">Für andere Programme</th><th></th></tr></thead><tbody>${WW.radios.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.mfg || "")} ${esc(r.model_name || "")}</td><td>${esc(r.device || r.host || "–")}</td><td>${esc(r.speed || "")}</td><td>${r.autoconnect ? "✓" : ""}</td><td>${r.cat_port ? `NET rigctl ${r.share ? location.hostname : "127.0.0.1"}:${r.cat_port}` : "–"}</td>
      <td class="nowrap">${r.connected ? `<button type="button" data-dis="${r.id}">Trennen</button>` : `<button type="button" class="primary" data-con="${r.id}">Verbinden</button>`}<button type="button" data-ed="${r.id}">Bearbeiten</button><button type="button" class="danger" data-rm="${r.id}">×</button></td></tr>`).join("")}</tbody>`; };
  $("#cn-presets", d).onclick = async e => { const b = e.target.closest("button"); if (!b) return;
    try { if (b.dataset.con) { b.textContent = "…"; await post(`/api/radios/${b.dataset.con}/connect`); toast("Verbunden"); }
      if (b.dataset.dis) await post(`/api/radios/${b.dataset.dis}/disconnect`);
      if (b.dataset.rm && confirm("Profil löschen?")) await api(`/api/radios/${b.dataset.rm}`, { method: "DELETE" });
      if (b.dataset.ed) { fill(WW.radios.find(r => r.id === b.dataset.ed)); d.querySelector('.dtabs [data-t="new"]').click(); }
    } catch (err) { toast(err.message, true); } drawPresets(); };
  drawPresets();
  if (editId) { const p = WW.radios.find(r => r.id === editId); if (p) fill(p); }
}

// ---------- Layout anpassen ----------
function openCustomize() {
  if (!RC.layout) return toast("Erst ein Funkgerät verbinden", true);
  const L = JSON.parse(JSON.stringify(RC.layout)), cat = () => { const c = buttonCatalog(); (L.custom || []).forEach(b => c["custom:" + b.id] = { label: b.label, kind: "custom", def: b }); return c; };
  const sch = L.scheme || {}, base = sch.base || store.get("rc.scheme", "Standard"), colors = { ...SCHEMES[base], ...(sch.colors || {}) };
  const COLOR_LABELS = { face: "Hintergrund", digits: "Frequenz-Ziffern", digitsSub: "Sub-VFO", active: "Aktive Ziffer (Balken)", inactive: "Inaktive Ziffer", btn: "Taste", btnText: "Tastenschrift", btnOn: "Taste aktiv", btnOnText: "Schrift aktiv", status: "Status ein", statusOff: "Status aus", warn: "Warnung/TX", bars: "Abstimmleisten", text: "Text", meterLow: "Meter niedrig", meterHigh: "Meter hoch", meterFree: "Meter frei", slider: "Regler", sliderFill: "Regler gefüllt" };
  const d = dialog({ title: "Layout anpassen", icon: "i-gear", wide: true, buttons: [["Abbrechen", "close"], ["Übernehmen", "apply", "primary"]], body: `
    <div class="dtabs"><button class="on" data-t="schemes">Schemata</button><button data-t="layout">Tasten-Layout</button><button data-t="colors">Farben &amp; Größe</button><button data-t="sliders">Regler-Layouts</button><button data-t="dial">Abstimmskala</button></div>
    <div class="dtab" data-t="schemes"><div class="cn-grid"><div><label>Schema<select id="cu-base" size="7">${Object.keys(SCHEMES).map(s => `<option ${s === base ? "selected" : ""}>${esc(s)}</option>`).join("")}${Object.keys(store.get("userschemes", {})).map(s => `<option value="u:${esc(s)}">${esc(s)} (eigen)</option>`).join("")}</select></label></div>
      <div><p class="hint">Ein Schema legt Farben fest. Eigene Schemata speicherst du hier und gibst sie als Datei weiter.</p><div class="ctl-row"><button type="button" id="cu-ssave">Als eigenes Schema speichern …</button><button type="button" id="cu-sdel">Eigenes löschen</button></div>
      <div class="ctl-row"><button type="button" id="cu-exp">Layout als Datei speichern</button><label class="btn">Layout aus Datei laden<input type="file" id="cu-imp" accept=".json" hidden></label><button type="button" id="cu-def">Standard-Tastenbelegung</button></div></div></div></div>
    <div class="dtab hidden" data-t="layout"><p class="hint">Tasten mit der Maus zwischen den Bereichen und der Liste „Nicht zugeordnet“ ziehen. Klick wählt eine Taste, <b>Entfernen</b> legt sie zurück. Eigene Tasten: Mode, Frequenz, CAT-Befehl oder Makro.</p>
      <div class="cu-zones"><div><b>Links (Abstimmung)</b><div class="cu-zone" data-z="left"></div></div><div><b>Rechts (Funktionen)</b><div class="cu-zone" data-z="right"></div></div><div><b>Auswahllisten</b><div class="cu-zone" data-z="drops"></div></div><div><b>Nicht zugeordnet</b><div class="cu-zone un" data-z="un"></div></div></div>
      <div class="ctl-row"><button type="button" id="cu-rm">Entfernen</button><span class="grow"></span><select id="cu-nt"><option value="mode">Mode-Taste</option><option value="freq">Frequenz-Taste</option><option value="cat">CAT-Befehl</option><option value="macro">Makro</option><option value="func">Funktion</option></select>
      <input id="cu-nl" placeholder="Beschriftung" style="width:110px"><input id="cu-nv" placeholder="Wert (USB / 14.074 / FA; / Makroname / NB)" style="width:220px"><button type="button" id="cu-add">Eigene Taste anlegen</button></div></div>
    <div class="dtab hidden" data-t="colors"><div class="cu-colors">${Object.entries(COLOR_LABELS).map(([k, l]) => `<label>${esc(l)}<input type="color" data-c="${k}" value="${colors[k] || "#000000"}"></label>`).join("")}</div>
      <div class="grid2"><label>Tastengröße<select id="cu-size">${[["small", "klein"], ["medium", "mittel"], ["large", "groß"]].map(([v, l]) => `<option value="${v}" ${(L.size || "small") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="chkrow"><input type="checkbox" id="cu-peak" ${L.peak !== false ? "checked" : ""}> Spitzenwert im S-Meter anzeigen</label></div></div>
    <div class="dtab hidden" data-t="sliders"><p class="hint">Bis zu sechs Regler-Layouts, z. B. eines für SSB und eines für CW. Umschalten unten im Bereich „Regler“.</p>
      <div class="cu-sl">${[0, 1, 2, 3, 4, 5].map(i => `<fieldset><legend>Layout ${i + 1}</legend>${(WW.caps.ui_levels || []).map(lv => `<label class="chkrow"><input type="checkbox" data-sl="${i}" value="${lv.name}" ${(L.sliders.layouts[i] || []).includes(lv.name) ? "checked" : ""}> ${esc(lv.label)}</label>`).join("")}</fieldset>`).join("")}</div></div>
    <div class="dtab hidden" data-t="dial"><div class="grid2"><label class="chkrow"><input type="checkbox" id="cu-f2" ${store.get("rc.fine2", false) ? "checked" : ""}> Zweite Feinabstimmung (Fine II) zeigen</label>
      <label>Bandplan<select id="cu-plan">${PLAN_NAMES.map(p => `<option value="${p[0]}" ${p[0] === currentPlan().key ? "selected" : ""}>${esc(p[1])}</option>`).join("")}</select></label></div></div>` });
  tabsIn(d);
  let selK = null;
  const drawZones = () => { const c = cat(), used = new Set([...L.left, ...L.right]); const dc = DROP_CATALOG(); const usedD = new Set(L.drops);
    const chip = (k, lbl, z) => `<span class="cu-chip${k === selK ? " sel" : ""}" draggable="true" data-k="${esc(k)}" data-from="${z}">${esc(lbl)}</span>`;
    $('[data-z="left"]', d).innerHTML = L.left.filter(k => c[k]).map(k => chip(k, c[k].label, "left")).join("");
    $('[data-z="right"]', d).innerHTML = L.right.filter(k => c[k]).map(k => chip(k, c[k].label, "right")).join("");
    $('[data-z="drops"]', d).innerHTML = L.drops.filter(k => dc[k]).map(k => chip(k, dc[k], "drops")).join("");
    $('[data-z="un"]', d).innerHTML = Object.keys(c).filter(k => !used.has(k)).map(k => chip(k, c[k].label, "un")).join("") + Object.keys(dc).filter(k => !usedD.has(k)).map(k => chip(k, "▾ " + dc[k], "un")).join(""); };
  const isDrop = k => !!DROP_CATALOG()[k];
  const moveTo = (k, from, to, beforeK) => { ["left", "right", "drops"].forEach(z => { L[z] = L[z].filter(x => x !== k); });
    if (to === "un") return; if ((to === "drops") !== isDrop(k)) return toast(isDrop(k) ? "Auswahllisten nur in die Spalte „Auswahllisten“" : "Tasten nicht in die Auswahllisten", true);
    const arr = L[to], i = beforeK ? arr.indexOf(beforeK) : -1; if (i >= 0) arr.splice(i, 0, k); else arr.push(k); };
  d.addEventListener("dragstart", e => { const c = e.target.closest(".cu-chip"); if (c) e.dataTransfer.setData("text/plain", JSON.stringify({ k: c.dataset.k, from: c.dataset.from })); });
  d.querySelectorAll(".cu-zone").forEach(z => { z.addEventListener("dragover", e => e.preventDefault()); z.addEventListener("drop", e => { e.preventDefault();
    const { k, from } = JSON.parse(e.dataTransfer.getData("text/plain")); const before = e.target.closest(".cu-chip")?.dataset.k; moveTo(k, from, z.dataset.z, before !== k ? before : null); drawZones(); }); });
  d.addEventListener("click", e => { const c = e.target.closest(".cu-chip"); if (c) { selK = c.dataset.k; drawZones(); } });
  $("#cu-rm", d).onclick = () => { if (selK) { moveTo(selK, "", "un"); selK = null; drawZones(); } };
  $("#cu-add", d).onclick = () => { const t = $("#cu-nt", d).value, lbl = $("#cu-nl", d).value.trim(), v = $("#cu-nv", d).value.trim(); if (!lbl || !v) return toast("Beschriftung und Wert eingeben", true);
    const b = { id: Date.now().toString(36), label: lbl, type: t };
    if (t === "mode") b.mode = v.toUpperCase(); else if (t === "freq") b.freq = v; else if (t === "cat") b.cmd = v; else if (t === "func") b.func = v.toUpperCase();
    else { const m = store.get("macros", []).find(x => x.name === v); if (!m) return toast("Makro nicht gefunden (Menü Makros)", true); b.macro = m.text; }
    L.custom = [...(L.custom || []), b]; L.right.push("custom:" + b.id); drawZones(); };
  $("#cu-def", d).onclick = () => { const def = defaultRigLayout(); L.left = def.left; L.right = def.right; L.drops = def.drops; drawZones(); toast("Standardbelegung – mit „Übernehmen“ speichern"); };
  $("#cu-base", d).onchange = e => { const v = e.target.value; const c2 = v.startsWith("u:") ? store.get("userschemes", {})[v.slice(2)] : SCHEMES[v]; d.querySelectorAll("[data-c]").forEach(i => { if (c2[i.dataset.c]) i.value = c2[i.dataset.c]; }); };
  $("#cu-ssave", d).onclick = () => { const n = prompt("Name des Schemas:"); if (!n) return; const us = store.get("userschemes", {}); us[n] = Object.fromEntries([...d.querySelectorAll("[data-c]")].map(i => [i.dataset.c, i.value])); store.set("userschemes", us); toast("Schema gespeichert"); };
  $("#cu-sdel", d).onclick = () => { const v = $("#cu-base", d).value; if (!v.startsWith("u:")) return; const us = store.get("userschemes", {}); delete us[v.slice(2)]; store.set("userschemes", us); $("#cu-base", d).selectedOptions[0].remove(); };
  $("#cu-exp", d).onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(L, null, 1)], { type: "application/json" })); a.download = `wellenwerk-layout-${(WW.rig.model || "radio").replace(/\W+/g, "_")}.json`; a.click(); };
  $("#cu-imp", d).onchange = async e => { try { const j = JSON.parse(await e.target.files[0].text()); Object.assign(L, j); drawZones(); toast("Layout geladen – mit „Übernehmen“ speichern"); } catch (err) { toast("Datei ungültig", true); } };
  drawZones();
  d.querySelector('[value="apply"]').addEventListener("click", async e => {
    e.preventDefault();
    const bv = $("#cu-base", d).value;
    L.scheme = { base: bv.startsWith("u:") ? base : bv, colors: Object.fromEntries([...d.querySelectorAll("[data-c]")].map(i => [i.dataset.c, i.value])) };
    if (!bv.startsWith("u:")) store.set("rc.scheme", bv);
    L.size = $("#cu-size", d).value; L.peak = $("#cu-peak", d).checked;
    for (let i = 0; i < 6; i++) L.sliders.layouts[i] = [...d.querySelectorAll(`[data-sl="${i}"]:checked`)].map(x => x.value);
    store.set("rc.fine2", $("#cu-f2", d).checked); store.set("rc.plan", $("#cu-plan", d).value);
    RC.layout = L; await saveRigLayout(); d.close(); toast("Layout gespeichert");
  });
}

// ---------- Programm Gerätesteuerung ----------
APPS.rig = {
  title: "Gerätesteuerung", icon: "i-radio",
  panels: {
    face: { title: "Funkgerät", create: createFace },
    sliders: { title: "Regler", create: createSliders, dock: { ref: "face", dir: "below" }, size: { height: 150 } },
    selection: { title: "Auswahl", create: createSelection, dock: { ref: "face", dir: "left" }, size: { width: 250 } },
    swdata: { title: "KW-Datenbank", create: createSwData, dock: { ref: ["sliders", "face"], dir: "below" }, size: { height: 220 } },
    bandscope: { title: "Bandübersicht", create: createBandscope, dock: { ref: ["swdata", "sliders", "face"], dir: "within" } },
    panadapter: { title: "Panadapter", create: createPanadapter, dock: { ref: "face", dir: "below" }, size: { height: 300 } },
    memories: { title: "Speicherkanäle", create: createMemories, dock: { ref: ["selection", "sliders", "face"], dir: "within" } },
  },
  layout(dv) { addPanel("rig", "face"); addPanel("rig", "sliders"); },
  menus: [],
  toolbar: [],
};
function rigMenus() {
  const macros = store.get("macros", []);
  APPS.rig.menus = [
    { label: "Datei", items: [{ label: "Verbinden …", icon: "i-plug", act: () => openConnect() }, { label: "Trennen", act: () => WW.current && act(`/api/radios/${WW.current}/disconnect`) },
      { label: "Verbindung bearbeiten …", act: () => openConnect(WW.current) }, "-", { label: "Programmoptionen …", key: "F8", act: () => openOptions() }] },
    { label: "Bearbeiten", items: [{ label: "Frequenz eingeben …", key: "Enter", act: freqDialog }, { label: "Frequenz kopieren", act: () => navigator.clipboard?.writeText(fmtMHz(WW.rig.freq || 0)) }] },
    { label: "Ansicht", items: [
      { label: "Auswahl", check: () => panelOpen("rig", "selection"), act: () => togglePanel("rig", "selection") },
      { label: "Regler", check: () => panelOpen("rig", "sliders"), act: () => togglePanel("rig", "sliders") },
      { label: "KW-Datenbank", check: () => panelOpen("rig", "swdata"), act: () => togglePanel("rig", "swdata") },
      { label: "Bandübersicht", check: () => panelOpen("rig", "bandscope"), act: () => togglePanel("rig", "bandscope") },
      { label: "Panadapter", check: () => panelOpen("rig", "panadapter"), act: () => togglePanel("rig", "panadapter") },
      { label: "Speicherkanäle", check: () => panelOpen("rig", "memories"), act: () => togglePanel("rig", "memories") },
      { label: "Fernbetrieb-Audio", check: () => panelOpen("rig", "remoteaudio"), act: () => togglePanel("rig", "remoteaudio") }, "-",
      "Schema", ...Object.keys(SCHEMES).map(s => ({ label: s, act: () => { store.set("rc.scheme", s); if (RC.layout) { RC.layout.scheme = { base: s }; saveRigLayout(); } } })), "-",
      { label: "Vollbild", key: "F11", act: fullScreen }] },
    { label: "Bänder", items: [...PLAN_NAMES.map(p => ({ label: p[1], act: () => { store.set("rc.plan", p[0]); WW.emit("rc-layout"); } })), "-", { label: "Bandspreizung aus", act: () => { RC.bsp = false; WW.emit("rc-layout"); } }] },
    { label: "Favoriten", items: [{ label: "Hinzufügen …", icon: "i-star", act: () => addFavoriteDialog() }, { label: "Anzeigen", act: () => addPanel("rig", "selection") }] },
    { label: "Schnellspeicher", items: [{ label: "Speichern", act: quickSave }, ...store.get("qs." + WW.current, []).map((q, i) => ({ label: `${i + 1}: ${fmtMHz(q.f)} ${q.m || ""}`, act: () => { setFreq(q.f); if (q.m) setMode(q.m); } })), "-", { label: "Alle löschen", act: () => { store.set("qs." + WW.current, []); WW.emit("quicksave"); } }] },
    { label: "Makros", items: [{ label: "Bearbeiten …", act: openMacros }, ...(macros.length ? ["-"] : []), ...macros.map(m => ({ label: m.name, act: () => runMacro(m.text) }))] },
    { label: "Logbuch", items: [{ label: "Logbuch öffnen", act: () => switchApp("log") }, { label: "Neuer Eintrag …", act: () => { switchApp("log"); setTimeout(() => openAle(), 100); } }] },
    { label: "Funkgerät", items: [{ label: "Geräte-Informationen", act: rigInfo }, { label: "Schnappschüsse …", icon: "i-save", act: () => snapshotsDialog() }, { label: "Synchronisieren …", act: () => syncDialog() }, { label: "Speicherkanäle …", act: () => addPanel("rig", "memories") }, { label: "VFO A ⇄ B", act: () => act("/api/rig/op", { op: "XCHG" }) }, { label: "Split ein/aus", act: () => act("/api/rig/split", { on: !WW.rig.split }) }, { label: "PTT ein/aus", act: () => act("/api/rig/ptt", { on: !WW.rig.ptt }) }] },
    { label: "Scannen", items: [{ label: "Scanner …", icon: "i-scan", act: openScanner }, { label: "Scanner stoppen", act: () => stopScan("gestoppt") }] },
    { label: "Abstimmen", items: [{ label: "Feinabstimmung 2 zeigen", check: () => store.get("rc.fine2", false), act: () => { store.set("rc.fine2", !store.get("rc.fine2", false)); WW.emit("rc-layout"); } },
      ...[1, 10, 100, 1000].map(s => ({ label: `Mausrad-Schritt ${s} Hz`, act: () => { const o = store.get("opts", {}); o.wheel = s; store.set("opts", o); } }))] },
    { label: "Extras", items: [{ label: "Panadapter", icon: "i-wave", act: () => addPanel("rig", "panadapter") }, { label: "Layout anpassen …", key: "Strg+F8", act: openCustomize }, { label: "Programmoptionen …", key: "F8", act: () => openOptions() }, { label: "Sprach-Keyer …", icon: "i-mic", act: openVoiceKeyer }, { label: "Fernbetrieb-Audio", icon: "i-mic", act: () => addPanel("rig", "remoteaudio") }, { label: "CW-Keyer (Digitalbetrieb)", act: () => switchApp("dm") }] },
    MENU_WINDOW("rig"), MENU_HELP,
  ];
  APPS.rig.toolbar = [
    { label: "Verbinden", icon: "i-plug", act: () => openConnect() },
    { label: "Auswahl", icon: "i-list", act: () => togglePanel("rig", "selection"), on: () => panelOpen("rig", "selection") },
    { label: "Favorit", icon: "i-star", act: () => addFavoriteDialog() },
    { label: "Schnellspeicher", icon: "i-save", act: quickSave }, "|",
    { label: "Satelliten", icon: "i-sat", act: () => switchApp("sat") }, { label: "Logbuch", icon: "i-book", act: () => switchApp("log") },
    { label: "Digital", icon: "i-wave", title: "Digitalbetrieb", act: () => switchApp("dm") }, { label: "Rotor", icon: "i-compass", act: () => switchApp("rot") },
    { label: "Karten", icon: "i-globe", act: () => switchApp("map") }, "|",
    { label: "Vollbild", icon: "i-full", act: fullScreen }, { label: "KW-Daten", icon: "i-db", act: () => togglePanel("rig", "swdata"), on: () => panelOpen("rig", "swdata") },
    { label: "Regler", icon: "i-sliders", act: () => togglePanel("rig", "sliders"), on: () => panelOpen("rig", "sliders") },
    { label: "Anpassen", icon: "i-brush", act: openCustomize }, { label: "Optionen", icon: "i-gear", act: () => openOptions() }, "->",
    { label: "Eintrag", icon: "i-plus", title: "Logbuch-Eintrag hinzufügen", act: () => { switchApp("log"); setTimeout(() => openAle(), 100); } },
  ];
}
// ---------- Speicherkanaele des Funkgeraets ----------
function createMemories(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk">Kanäle <input type="number" class="me-lo" min="0" value="${store.get("mem.lo", "")}" style="width:60px"> bis <input type="number" class="me-hi" min="0" value="${store.get("mem.hi", "")}" style="width:60px"></label>
    <button class="me-read primary">Lesen</button><button class="me-store" title="Aktuelle VFO-Einstellung in den gewählten Kanal schreiben">VFO → Speicher</button><button class="me-recall">Speicher → VFO</button><button class="me-clear">Löschen</button>
    <button class="me-csv">CSV-Export</button><span class="hint me-st"></span></div><div class="tablewrap"><table class="grid me-t"><thead><tr><th>Kanal</th><th>Name</th><th>Frequenz</th><th>Mode</th><th>Breite</th><th>Ablage</th><th>CTCSS</th><th>Split/TX</th></tr></thead><tbody></tbody></table></div>`;
  let rows = [], sel = null;
  const st = t => $(".me-st", root).textContent = t;
  const draw = () => { $("tbody", root).innerHTML = rows.map(c => `<tr data-ch="${c.ch}" class="${c.ch === sel ? "sel" : ""}${c.freq ? "" : " empty"}"><td>${c.ch}</td><td>${esc(c.name || "")}</td><td>${c.freq ? fmtMHz(c.freq) : (c.error ? "<i>" + esc(c.error) + "</i>" : "–")}</td><td>${esc(c.mode || "")}</td><td>${c.width ? (c.width / 1000).toFixed(1) + " kHz" : ""}</td>
    <td>${c.shift && c.shift !== "None" ? esc(c.shift) + " " + (c.offset / 1000) + " kHz" : ""}</td><td>${c.ctcss ? c.ctcss.toFixed(1) : ""}</td><td>${c.split ? fmtMHz(c.txfreq) : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="hint">„Lesen“ holt die Speicherkanäle aus dem Funkgerät.</td></tr>'; };
  const read = async () => { const lo = $(".me-lo", root).value, hi = $(".me-hi", root).value; store.set("mem.lo", lo); store.set("mem.hi", hi); st("lese …");
    try { const r = await api(`/api/rig/memories${lo !== "" ? `?lo=${+lo}&hi=${+(hi || lo)}` : ""}`); rows = r.channels;
      const mem = r.ranges.find(x => x.type === "MEM"); if (mem && lo === "") { $(".me-lo", root).value = mem.lo; $(".me-hi", root).value = Math.min(mem.hi, mem.lo + 199); }
      st(r.ranges.length ? `Gerät: ${r.ranges.map(x => `${x.type} ${x.lo}–${x.hi}`).join(", ")} · ${rows.filter(c => c.freq).length} belegt` : "Das Funkgerät meldet keine Speicherkanäle"); draw(); } catch (e) { st(e.message); } };
  const op = async action => { if (sel === null) return toast("Erst einen Kanal anklicken", true); if (action === "clear" && !confirm(`Kanal ${sel} löschen?`)) return;
    if (await act("/api/rig/memory", { ch: sel, action })) { toast({ recall: `Kanal ${sel} abgerufen`, store: `In Kanal ${sel} gespeichert`, clear: `Kanal ${sel} gelöscht` }[action]);
      if (action !== "recall") { const r = await api(`/api/rig/memories?lo=${sel}&hi=${sel}`); const c = r.channels[0]; rows = rows.map(x => x.ch === sel ? c : x); draw(); } } };
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-ch]"); if (tr) { sel = +tr.dataset.ch; draw(); } });
  root.addEventListener("dblclick", e => { const tr = e.target.closest("tr[data-ch]"); if (tr) { sel = +tr.dataset.ch; op("recall"); } });
  $(".me-read", root).onclick = read; $(".me-store", root).onclick = () => op("store"); $(".me-recall", root).onclick = () => op("recall"); $(".me-clear", root).onclick = () => op("clear");
  $(".me-csv", root).onclick = () => { const csv = ["Kanal;Name;Frequenz_Hz;Mode;Breite_Hz;Ablage;Ablage_Hz;CTCSS;TX_Hz", ...rows.filter(c => c.freq).map(c => [c.ch, c.name, c.freq, c.mode, c.width, c.shift, c.offset, c.ctcss, c.split ? c.txfreq : ""].join(";"))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "speicherkanaele.csv"; a.click(); };
  root._op = c => { sel = c; draw(); }; root._do = op;
  draw();
}

// ---------- Panadapter (Scope-Daten des Funkgeraets ueber Hamlib, z. B. IC-7300/705/9700) ----------
function createPanadapter(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk">Quelle <select class="pa-src"><option value="rig">Scope des Funkgeräts</option><option value="iq">IQ-Soundkarte (SDR)</option></select></label>
    <span class="pa-rigopt"><label class="chk"><input type="checkbox" class="pa-on"> Scope-Daten vom Gerät</label>
    <label class="chk">Spanne <select class="pa-span">${[2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000].map(v => `<option value="${v}">±${v >= 1000 ? v / 1000 + " kHz" : v + " Hz"}</option>`).join("")}</select></label>
    <label class="chk">Modus <select class="pa-mode"><option value="0">Mitte</option><option value="1">Fest</option></select></label></span>
    <span class="pa-iqopt hidden"><label class="chk">Eingang <select class="pa-dev"><option value="">Standard</option></select></label><label class="chk">ZF-Ablage Hz <input type="number" class="pa-if" value="${store.get("pa.if", 0)}" style="width:70px"></label>
      <label class="chk"><input type="checkbox" class="pa-swap" ${store.get("pa.swap", false) ? "checked" : ""}> I/Q tauschen</label><button class="pa-iqgo">▶ Start</button></span>
    <label class="chk">Kontrast <input type="range" class="pa-gain" min="0.5" max="3" step="0.1" value="1.4"></label><span class="hint pa-st"></span></div>
    <div class="pa-wrap"><canvas class="pa-spec"></canvas><canvas class="pa-wf"></canvas></div>`;
  const spec = $(".pa-spec", root), wf = $(".pa-wf", root), st = $(".pa-st", root);
  let last = null, wctx = null;
  const prof = () => WW.radios.find(r => r.id === WW.current) || {};
  // IQ ueber die Soundkarte: Stereo-Eingang, links I, rechts Q; Mitte = Geraetefrequenz + ZF-Ablage
  const IQ = { ctx: null, stream: null, fft: new FFT(2048), avg: null };
  const iqStop = () => { try { IQ.stream?.getTracks().forEach(t => t.stop()); IQ.ctx?.close(); } catch { } IQ.ctx = IQ.stream = null; $(".pa-iqgo", root).textContent = "▶ Start"; };
  const iqStart = async () => { if (IQ.ctx) return iqStop();
    try { IQ.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $(".pa-dev", root).value ? { exact: $(".pa-dev", root).value } : undefined, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      IQ.ctx = new AudioContext({ sampleRate: IQ.stream.getAudioTracks()[0].getSettings().sampleRate || undefined }); await IQ.ctx.audioWorklet.addModule("/static/digi-worklet.js");
      const node = new AudioWorkletNode(IQ.ctx, "ww-iq", { channelCount: 2, channelCountMode: "explicit", processorOptions: { n: 2048 } }); node.port.onmessage = e => iqFrame(e.data);
      IQ.ctx.createMediaStreamSource(IQ.stream).connect(node); $(".pa-iqgo", root).textContent = "■ Stopp"; } catch (e) { toast("IQ-Eingang: " + e.message, true); iqStop(); } };
  const iqFrame = d => { const p = IQ.fft.powerIQ(d.i, d.q, $(".pa-swap", root).checked); if (!IQ.avg) IQ.avg = Float32Array.from(p); else for (let k = 0; k < p.length; k++) IQ.avg[k] = 0.6 * IQ.avg[k] + 0.4 * p[k];
    const s2 = [...IQ.avg].sort((a, b) => a - b), floor = s2[Math.floor(s2.length * 0.3)], top = Math.max(s2[s2.length - 1], floor + 30);
    const c = (WW.rig.freq || 0) + (+$(".pa-if", root).value || 0);
    draw({ low: c - d.sr / 2, high: c + d.sr / 2, min: floor - 5, max: top, data: Array.from(IQ.avg), name: "IQ" }); };
  window.__wwIqFeed = (i, q, sr) => iqFrame({ i, q, sr });      // Testeinspeisung
  const srcVis = () => { const iq = $(".pa-src", root).value === "iq"; $(".pa-iqopt", root).classList.toggle("hidden", !iq); $(".pa-rigopt", root).classList.toggle("hidden", iq); store.set("pa.src", $(".pa-src", root).value); if (!iq) iqStop(); };
  $(".pa-src", root).value = store.get("pa.src", "rig"); $(".pa-src", root).onchange = srcVis; $(".pa-iqgo", root).onclick = iqStart;
  $(".pa-if", root).onchange = e => store.set("pa.if", +e.target.value); $(".pa-swap", root).onchange = e => store.set("pa.swap", e.target.checked);
  audioDevices("audioinput").then(ds => { $(".pa-dev", root).innerHTML += ds.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || d.deviceId.slice(0, 8))}</option>`).join(""); });
  const status = () => { if ($(".pa-src", root).value === "iq") { st.textContent = last && last.name === "IQ" ? `IQ: ${fmtMHz(last.low)} – ${fmtMHz(last.high)} MHz` : "IQ-Soundkarte: Eingang wählen, Start"; return; } const p = prof(); st.textContent = !p.connected ? "Funkgerät nicht verbunden" : !p.scope ? "Scope für dieses Gerät aus (Verbinden → Bearbeiten → „Panadapter“)" : last ? `${fmtMHz(last.low)} – ${fmtMHz(last.high)} MHz` : "warte auf Scope-Daten … (Gerät: Scope einschalten, CI-V USB-Port „Unlinked“, 115200 Bd)"; };
  const fx = (f, W) => last ? (f - last.low) / (last.high - last.low) * W : 0;
  const draw = line => {
    last = line; const W = spec.clientWidth, H = spec.clientHeight; if (!W || !H) return;
    if (spec.width !== W) spec.width = W; if (spec.height !== H) spec.height = H;
    const c = spec.getContext("2d"), cs = getComputedStyle(document.documentElement), g = +$(".pa-gain", root).value;
    c.fillStyle = cs.getPropertyValue("--wf-bg") || "#0b1622"; c.fillRect(0, 0, W, H);
    const n = line.data.length, span = Math.max(1, (line.max || 255) - (line.min || 0));
    c.strokeStyle = "#5cd0ff"; c.beginPath();
    line.data.forEach((v, i) => { const x = i / (n - 1) * W, y = H - Math.min(1, (v - line.min) / span * g) * (H - 4) - 2; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
    // Raster und aktuelle Frequenz
    c.fillStyle = "rgba(255,255,255,.55)"; c.font = "10px sans-serif"; const stp = niceStep((line.high - line.low) / 6);
    for (let f = Math.ceil(line.low / stp) * stp; f < line.high; f += stp) { const x = fx(f, W); c.fillRect(x, 0, 1, 6); c.fillText((f / 1e6).toFixed(stp < 1000 ? 4 : 3), x + 2, 12); }
    const xf = fx(WW.rig.freq, W); c.fillStyle = "rgba(255,80,80,.9)"; c.fillRect(xf, 0, 1.5, H);
    // Wasserfall
    const WH = wf.clientHeight; if (wf.width !== W || wf.height !== WH) { wf.width = W; wf.height = WH; wctx = wf.getContext("2d"); }
    if (!wctx) wctx = wf.getContext("2d"); if (!WH) return;
    wctx.drawImage(wf, 0, 0, W, WH - 1, 0, 1, W, WH - 1);
    const img = wctx.createImageData(W, 1);
    for (let x = 0; x < W; x++) { const v = Math.min(1, (line.data[Math.floor(x / W * n)] - line.min) / span * g); const [r, gg, b] = wfColor(v); img.data.set([r, gg, b, 255], 4 * x); }
    wctx.putImageData(img, 0, 0);
    status();
  };
  const tune = e => { if (!last) return; const r = e.currentTarget.getBoundingClientRect(); setFreq(Math.round((last.low + (e.clientX - r.left) / r.width * (last.high - last.low)) / 10) * 10); };
  spec.addEventListener("click", tune); wf.addEventListener("click", tune);
  $(".pa-on", root).onchange = e => act("/api/rig/func", { name: "SPECTRUM", on: e.target.checked });
  $(".pa-span", root).onchange = e => act("/api/rig/level", { name: "SPECTRUM_SPAN", value: +e.target.value });
  $(".pa-mode", root).onchange = e => act("/api/rig/level", { name: "SPECTRUM_MODE", value: +e.target.value });
  $(".pa-on", root).checked = !!(WW.rig.funcs || {}).SPECTRUM;
  const offs = [WW.on("spectrum", l => { if (l.radio === WW.current && $(".pa-src", root).value === "rig") draw(l); }), WW.on("radios", status), WW.on("rig", () => { if (last && last.name !== "IQ") draw(last); })];
  srcVis(); status(); return () => { iqStop(); offs.forEach(f => f()); };
}
function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)), m = x / p; return (m < 2 ? 1 : m < 5 ? 2 : 5) * p; }
function wfColor(v) { // dunkelblau -> blau -> gelb -> rot
  const st = [[0, 8, 24, 48], [0.35, 20, 60, 200], [0.6, 40, 200, 220], [0.8, 250, 230, 60], [1, 255, 60, 30]];
  for (let i = 1; i < st.length; i++) if (v <= st[i][0]) { const a = st[i - 1], b = st[i], t = (v - a[0]) / (b[0] - a[0]); return [0, 1, 2].map(k => Math.round(a[k + 1] + (b[k + 1] - a[k + 1]) * t)); }
  return [255, 60, 30];
}
function rigInfo() { const c = WW.caps || {};
  info("Funkgerät", `<dl class="kv"><dt>Gerät</dt><dd>${esc(WW.rig.model || "—")}</dd><dt>Profil</dt><dd>${esc((WW.radios.find(r => r.id === WW.current) || {}).name || "—")}</dd>
    <dt>Betriebsarten</dt><dd>${esc((c.modes || []).join(", ") || "—")}</dd><dt>Regler</dt><dd>${esc((c.ui_levels || []).map(x => x.label).join(", ") || "—")}</dd>
    <dt>Schalter</dt><dd>${esc((c.ui_funcs || []).map(x => x.label).join(", ") || "—")}</dd><dt>VFO-Funktionen</dt><dd>${esc((c.vfo_ops || []).join(", ") || "—")}</dd>
    <dt>Messwerte</dt><dd>${esc((c.meters || []).join(", ") || "—")}</dd><dt>Vorverstärker / Abschwächer</dt><dd>${esc((c.preamp || []).join(", ") || "—")} / ${esc((c.att || []).join(", ") || "—")} dB</dd></dl>`); }
rigMenus();
WW.on("radios", () => { rigMenus(); if (SHELL.active === "rig") { renderMenus(APPS.rig); } });
WW.on("quicksave", () => { rigMenus(); if (SHELL.active === "rig") renderMenus(APPS.rig); });
