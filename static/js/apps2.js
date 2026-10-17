"use strict";
// Wellenwerk – Diplome, QSL & Online, Statistik, Rotor, Karten, Satelliten und Programmstart

// ---------- Diplome ----------
function createAwards(root) {
  const draw = async () => {
    const a = await api("/api/awards?" + logq());
    const k = (t, x, total) => `<div class="kpi"><div>${t}</div><b>${x.worked}${total ? `<small>/${total}</small>` : ""}</b><span class="cf">${x.confirmed} bestätigt</span></div>`;
    const grid = (list, key, label) => `<div class="awgrid">${list.map(i => `<span class="${i.confirmed ? "c" : i.worked ? "w" : ""}" title="${esc(i.name || i[key])}">${esc(label ? i[label] : i[key])}</span>`).join("")}</div>`;
    const cols = [...a.bands, ...a.modes];
    root.innerHTML = `<div class="awards"><p class="hint">${WW.settings.eqsl_counts ? "Bestätigt = Papier-QSL, LoTW oder eQSL." : "Bestätigt = Papier-QSL oder LoTW (eQSL in den Optionen zuschaltbar)."} Logbuch: ${esc(WW.logbook)}</p>
      <div class="kpis">${k("DXCC", a.dxcc, 340)}${k("WAZ", a.waz, 40)}${k("ITU-Zonen", a.itu, 75)}${k("WAS", a.was, 50)}${k("WAC", a.wac, 6)}${k("WPX", a.wpx)}${k("Europa (EU-Länder)", a.wae)}${k("DOK", a.dok)}${k("IOTA", a.iota)}
        ${k("Locatorfelder", a.grids)}${k("US-Counties", a.counties, 3077)}${Object.entries(a.vucc).map(([b, x]) => k(`VUCC ${b}`, x, x.total)).join("")}
        <div class="kpi"><div>CQ DX Marathon ${esc(a.marathon.year)}</div><b>${a.marathon.total}</b><span class="cf">${a.marathon.countries} Länder + ${a.marathon.zones} Zonen</span></div>
        <div class="kpi"><div>DXCC-Challenge</div><b>${a.challenge.worked}</b><span class="cf">Land-Band-Punkte 160–6 m</span></div></div>
      <div class="awsec"><h3>DXCC nach Band und Mode</h3><div class="tablewrap mx"><table class="matrix"><thead><tr><th>Land</th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr>
        <tr class="sum"><td>Summe</td>${a.bands.map(b => `<td>${a.dxcc_bands[b].worked}/${a.dxcc_bands[b].confirmed}</td>`).join("")}${a.modes.map(m => `<td>${a.dxcc_modes[m].worked}/${a.dxcc_modes[m].confirmed}</td>`).join("")}</tr></thead>
        <tbody>${a.matrix.map(r => `<tr><td class="${r.confirmed ? "c" : ""}">${esc(r.country)}</td>${cols.map(c => `<td class="${r.cells[c] === "C" ? "c" : r.cells[c] === "W" ? "w" : ""}">${r.cells[c] || ""}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length + 1}">Noch keine Länder.</td></tr>`}</tbody></table></div></div>
      <div class="awsec"><h3>WAZ – CQ-Zonen</h3>${grid(a.waz_list, "zone")}</div><div class="awsec"><h3>WAC – Kontinente</h3>${grid(a.wac_list, "cont", "name")}</div><div class="awsec"><h3>ITU-Zonen</h3>${grid(a.itu_list, "zone")}</div>
      <div class="awsec"><h3>WAS – US-Bundesstaaten</h3>${grid(a.was_list, "state")}</div>
      <div class="awsec"><h3>DOK (${a.dok_list.length})</h3><div class="taglist">${a.dok_list.map(d => `<span>${esc(d)}</span>`).join("") || "—"}</div></div>
      <div class="awsec"><h3>IOTA (${a.iota_list.length})</h3><div class="taglist">${a.iota_list.map(d => `<span>${esc(d)}</span>`).join("") || "—"}</div></div></div>`;
  };
  const offs = [WW.on("qso", draw), WW.on("reload", draw)]; draw(); return () => offs.forEach(f => f());
}

// ---------- QSL & Online ----------
function createQslPanel(root) {
  const draw = async () => {
    const st = await api("/api/services/status?" + logq()), c = st.configured, sy = st.sync || {};
    const row = (id, name, conf, pend, extra = "") => `<tr><td><b>${name}</b></td><td>${conf ? '<span class="ok">eingerichtet</span>' : '<span class="no">nicht eingerichtet</span>'}</td><td>${pend} QSOs offen</td><td>${extra}</td><td><button data-up="${id}" ${conf ? "" : "disabled"}>Jetzt hochladen</button></td></tr>`;
    root.innerHTML = `<div class="qslpanel"><div class="awsec"><h3>Hochladen</h3><table class="grid svc"><tbody>${row("qrz", "QRZ.com-Logbuch", c.qrz, st.pending.qrz)}${row("eqsl", "eQSL.cc", c.eqsl, st.pending.eqsl)}
      ${row("lotw", "LoTW (ARRL)", st.tqsl && st.tqsl_cert && (st.tqsl_locations || []).includes(WW.settings.lotw_location), st.pending.lotw, !st.tqsl ? "TQSL fehlt auf dem Server" : !st.tqsl_cert ? "Zertifikat fehlt (unten)" : !(st.tqsl_locations || []).includes(WW.settings.lotw_location) ? "Stationsort fehlt (unten)" : "Stationsort „" + esc(WW.settings.lotw_location) + "“")}
      ${row("clublog", "Club Log", c.clublog, st.pending.clublog)}</tbody></table></div>
      <div class="awsec"><h3>Bestätigungen abholen</h3><table class="grid svc"><tbody><tr><td><b>LoTW</b></td><td>zuletzt: ${esc(sy.lotw_last || "nie")}</td><td><button data-sync="lotw" ${c.lotw ? "" : "disabled"}>LoTW abgleichen</button></td></tr>
        <tr><td><b>eQSL</b></td><td>zuletzt: ${esc(sy.eqsl_last || "nie")}</td><td><button data-sync="eqsl" ${c.eqsl ? "" : "disabled"}>eQSL abgleichen</button></td></tr></tbody></table><div class="hint sync-res"></div></div>
      <div class="awsec"><h3>LoTW-Zertifikat (TQSL)</h3><p class="hint">Status: ${st.tqsl_cert ? '<span class="ok">Zertifikat vorhanden</span>' : "kein Zertifikat"} · Stationsorte: ${esc((st.tqsl_locations || []).join(", ") || "keine")}</p>
        <div class="ctl-row"><input type="file" class="p12" accept=".p12,.tq6"><input type="password" class="p12pw" placeholder="Passwort der .p12-Datei"><button class="p12go">Zertifikat importieren</button><button class="locgo">Stationsort anlegen</button></div></div>
      <div class="awsec"><h3>Papier-QSL</h3><p class="hint">Im Logbuch QSOs markieren → „Mehr …“ → QSL vormerken, Etiketten drucken, QSL gesendet.</p><button class="lbl">Etiketten für alle vorgemerkten/ungesendeten …</button></div>
      <p><button class="cfg">Zugangsdaten (Optionen) …</button></p></div>`;
  };
  root.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.up) await upload(b.dataset.up, []);
      else if (b.dataset.sync) { b.disabled = true; const r = await post("/api/sync/confirmations?" + logq(), { service: b.dataset.sync }); $(".sync-res", root).textContent = `${r.received} empfangen, ${r.matched} zugeordnet${r.unmatched.length ? ", nicht gefunden: " + r.unmatched.slice(0, 8).join(", ") : ""}`; }
      else if (b.classList.contains("p12go")) { const f = $(".p12", root).files[0]; if (!f) return toast("Erst die .p12-Datei wählen", true); const fd = new FormData(); fd.append("file", f);
        const r = await api(`/api/lotw/cert?password=${encodeURIComponent($(".p12pw", root).value)}`, { method: "POST", body: fd }); toast(r.has_cert ? "Zertifikat importiert" : "Kein Zertifikat gefunden", !r.has_cert); draw(); }
      else if (b.classList.contains("locgo")) { const r = await post("/api/lotw/location", {}); toast(`Stationsort „${r.location}“ angelegt`); draw(); }
      else if (b.classList.contains("lbl")) { const sk = prompt("Wie viele Etiketten oben auf dem Bogen sind schon verbraucht?", "0"); if (sk !== null) window.open(`/print/labels?${logq("qsl=to_send&skip=" + (+sk || 0))}`, "_blank"); }
      else if (b.classList.contains("cfg")) openOptions("online");
    } catch (err) { toast(err.message, true); }
  });
  draw(); return WW.on("settings", draw);
}
function createStats(root) {
  const draw = async () => { const s = await api("/api/stats?" + logq());
    const list = (arr, key, label) => { const mx = Math.max(1, ...arr.map(x => x.n)); return `<div class="kpi"><div>${label}</div>${arr.map(x => `<div class="srow"><span>${esc(x[key])}</span><span>${x.n}${x.dxcc != null ? ` · ${x.dxcc} Länder` : ""}</span></div><div class="sbar" style="width:${x.n / mx * 100}%"></div>`).join("") || "—"}</div>`; };
    root.innerHTML = `<div class="stats"><div class="kpi">QSOs<b>${s.total}</b></div><div class="kpi">DXCC-Länder<b>${s.dxcc}</b></div><div class="kpi">Rufzeichen<b>${s.calls}</b></div>${list(s.by_band, "band", "Nach Band")}${list(s.by_mode, "mode", "Nach Mode")}${list(s.by_cont, "cont", "Nach Kontinent")}</div>`; };
  const offs = [WW.on("qso", draw), WW.on("reload", draw)]; draw(); return () => offs.forEach(f => f());
}

// ---------- Rotor ----------
async function openRotorConnect() {
  let models = []; let ports = [];
  try { [models, ports] = await Promise.all([api("/api/hamlib/models?kind=rot"), api("/api/hamlib/ports")]); } catch (e) { toast(e.message, true); }
  const s = WW.settings, mfgs = [...new Set(models.map(m => m.mfg))].sort();
  const d = dialog({ title: "Rotor verbinden", icon: "i-compass", buttons: [["Abbrechen", "close"], ["Trennen", "off"], ["Verbinden", "ok", "primary"]], body: `<div class="grid2">
    <label>Hersteller<select id="ro-mfg">${mfgs.map(m => `<option>${esc(m)}</option>`).join("")}</select></label><label>Rotor / Protokoll<select id="ro-model"></select></label>
    <label>Port<select id="ro-dev">${ports.map(p => `<option value="${esc(p.device)}" ${p.device === s.rot_device ? "selected" : ""}>${esc(p.device)} ${esc(p.desc)}</option>`).join("")}<option value="">–</option></select></label>
    <label>Geschwindigkeit<select id="ro-speed"><option value="">Standard</option>${[1200, 2400, 4800, 9600, 19200, 38400].map(v => `<option ${String(v) === String(s.rot_speed) ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label>Anschlag<select id="ro-stop"><option value="north" ${s.rot_stop !== "south" ? "selected" : ""}>Norden (0° … 360°)</option><option value="south" ${s.rot_stop === "south" ? "selected" : ""}>Süden (−180° … +180°)</option></select></label>
    <label>Azimut-Versatz (Kalibrierung, Grad)<input id="ro-off" type="number" step="0.5" value="${esc(s.rot_offset || 0)}"></label>
    <label>Drehbereich von (Grad, leer = vom Rotor)<input id="ro-min" type="number" value="${esc(s.rot_min_az ?? "")}" placeholder="z. B. 0"></label><label>bis (Grad)<input id="ro-max" type="number" value="${esc(s.rot_max_az ?? "")}" placeholder="z. B. 450"></label>
    <label class="chkrow wide"><input type="checkbox" id="ro-log" ${s.rot_log ? "checked" : ""}> Rotorbewegungen protokollieren <button type="button" id="ro-showlog">Protokoll anzeigen</button></label>
    <p class="hint wide">Versatz: zeigt der Rotor z. B. 10° zu viel an, −10 eintragen. Drehbereich bei Rotoren mit Überlauf (z. B. 0–450°) – Wellenwerk wählt dann den kürzeren Weg innerhalb des Bereichs.</p>
    <p class="hint wide">Steuerung über Hamlib (${models.length} Rotor-Typen, z. B. Yaesu GS-232, SPID, ERC, EA4TX ARS, PstRotator). Zum Testen: Hamlib → Dummy.</p></div>` });
  const fill = () => { $("#ro-model", d).innerHTML = models.filter(m => m.mfg === $("#ro-mfg", d).value).map(m => `<option value="${m.id}" ${m.id === +s.rot_model ? "selected" : ""}>${esc(m.model)}</option>`).join(""); };
  $("#ro-mfg", d).onchange = fill; const cur = models.find(m => m.id === +s.rot_model); $("#ro-mfg", d).value = cur ? cur.mfg : (mfgs.includes("Yaesu") ? "Yaesu" : mfgs[0]); fill();
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault(); try { WW.settings = await api("/api/settings", { method: "PUT", body: { rot_enabled: true, rot_model: +$("#ro-model", d).value, rot_device: $("#ro-dev", d).value, rot_stop: $("#ro-stop", d).value, rot_offset: $("#ro-off", d).value || "0", rot_min_az: $("#ro-min", d).value, rot_max_az: $("#ro-max", d).value, rot_log: $("#ro-log", d).checked, rot_speed: $("#ro-speed", d).value } }); toast("Rotor wird verbunden …"); d.close(); } catch (err) { toast(err.message, true); } };
  $("#ro-showlog", d).onclick = () => window.open("/api/rotor/log", "_blank", "width=700,height=600");
  d.querySelector('[value="off"]').onclick = async e => { e.preventDefault(); WW.settings = await api("/api/settings", { method: "PUT", body: { rot_enabled: false } }); d.close(); };
}
function createRotDials(root) {
  root.innerHTML = `<div class="rot-dials"><canvas class="d-az"></canvas><canvas class="d-el"></canvas></div><div class="rot-ctl"><input type="number" class="ro-in" placeholder="Grad" min="0" max="359"><button class="primary ro-go">Drehen</button><button class="ro-stop danger">Stopp</button><button class="ro-park">Parken</button></div>`;
  const az = $(".d-az", root), el = $(".d-el", root);
  const draw = () => { const r = WW.rotor; dialGauge(az, r.connected ? r.az : null, r.target, "Azimut"); dialGauge(el, r.connected ? r.el : null, null, "Elevation"); };
  az.addEventListener("click", e => { const g = az._geom; if (!g) return; const r = az.getBoundingClientRect(); rotorSet((Math.atan2(e.clientX - r.left - g.cx, -(e.clientY - r.top - g.cy)) * 180 / Math.PI + 360) % 360); });
  $(".ro-go", root).onclick = () => { const v = $(".ro-in", root).value; if (v !== "") rotorSet(+v); }; $(".ro-stop", root).onclick = () => act("/api/rotor/stop", {}); $(".ro-park", root).onclick = () => act("/api/rotor/park", {});
  const ro = new ResizeObserver(draw); ro.observe(root); const off = WW.on("rotor", draw); draw(); return () => { ro.disconnect(); off(); };
}
const ROT = { target: null, path: "short" };
function createRotMap(root) {
  root.innerHTML = `<div class="pane-tb rot-tb"><label>Rufzeichen <input class="rt-call" style="width:100px"></label><label>Land <select class="rt-country"><option value=""></option></select></label><label>Locator <input class="rt-loc" style="width:80px"></label>
    <span class="seg2"><button data-p="short" class="on">Kurz</button><button data-p="long">Lang</button></span><b class="rt-info"></b><button class="primary rt-go">Drehen</button></div>
    <div class="rot-mapbox"></div>`;
  api("/api/countries").then(cs => { $(".rt-country", root).innerHTML += cs.map(c => `<option value="${c.lat},${c.lon},${esc(c.name)}">${esc(c.name)}</option>`).join(""); }).catch(() => { });
  const E = wwEarth($(".rot-mapbox", root), { mode: store.get("rt.mode", "azi"), modes: [["azi", "Großkreis"], ["flat", "Karte"], ["globe", "Globus"]], grid: "", onMode: m => store.set("rt.mode", m),
    draw: (ctx, E) => drawBeam(ctx, E, WW.rotor, ROT.target),
    onClick: ll => { if (ll) setTarget({ lat: ll[0], lon: ll[1], name: `${ll[0].toFixed(1)}°, ${ll[1].toFixed(1)}°` }); } });
  const draw = () => {
    E.points = WW.home ? [{ lat: WW.home[0], lon: WW.home[1], color: "#2bd4ff", r: 4, pulse: true }] : []; E.arcs = []; E.lines = [];
    if (WW.home && WW.rotor.connected && WW.rotor.az != null && E.o.mode !== "azi") { const pts = []; for (let d = 0; d <= 20000; d += 250) pts.push(destPoint(WW.home, WW.rotor.az, d)); E.lines.push({ pts, color: "#7ff0ff", width: 2 }); }
    if (WW.home && ROT.target) { E.points.push({ lat: ROT.target.lat, lon: ROT.target.lon, color: "#ff4fd8", r: 5, label: ROT.target.name || "" });
      const b = bearingTo(ROT.target.lat, ROT.target.lon), az = ROT.path === "long" ? (b.az + 180) % 360 : b.az, km = ROT.path === "long" ? 40030 - b.km : b.km;
      const pts = []; for (let d = 0; d <= km; d += 150) pts.push(destPoint(WW.home, az, d)); pts.push(destPoint(WW.home, az, km)); E.lines.push({ pts, color: "#ff4fd8", width: 2.2, dash: [7, 6], glow: 12 });
      $(".rt-info", root).textContent = `${Math.round(az)}° · ${Math.round(km).toLocaleString(I18N.locale)} km`; ROT.az = az; }
    if (WW.home) E.set({ center: E.o.mode === "azi" ? [WW.home[0], WW.home[1]] : E.o.center }); E.redraw(); };
  const setTarget = t => { ROT.target = t; draw(); };
  root.addEventListener("change", async e => {
    if (e.target.classList.contains("rt-country") && e.target.value) { const [la, lo, n] = e.target.value.split(","); setTarget({ lat: +la, lon: +lo, name: n }); }
    if (e.target.classList.contains("rt-loc") && e.target.value) { try { const r = await api(`/api/lookup/X?grid=${encodeURIComponent(e.target.value)}`); setTarget({ lat: r.lat, lon: r.lon, name: e.target.value.toUpperCase() }); } catch { } }
    if (e.target.classList.contains("rt-call") && e.target.value) { try { const r = await api(`/api/lookup/${encodeURIComponent(e.target.value)}?${logq()}`); setTarget({ lat: r.lat, lon: r.lon, name: `${e.target.value.toUpperCase()} (${r.country})` }); } catch { } } });
  root.addEventListener("click", e => { const p = e.target.closest("[data-p]");
    if (p) { ROT.path = p.dataset.p; $$("[data-p]", root).forEach(x => x.classList.toggle("on", x === p)); draw(); }
    if (e.target.closest(".rt-go") && ROT.az != null) rotorSet(ROT.az); });
  const offs = [WW.on("rotor", draw), WW.on("settings", draw), WW.on("dx", d => { if (d?.lat != null) { $(".rt-call", root).value = d.call; setTarget({ lat: d.lat, lon: d.lon, name: `${d.call} (${d.country})` }); } })];
  draw(); return () => { offs.forEach(f => f()); E.destroy(); };
}
function destPoint(home, az, km) { const R = 6371, d = km / R, b = az * Math.PI / 180, la1 = home[0] * Math.PI / 180, lo1 = home[1] * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b)); const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI + 540) % 360) - 180]; }
function splitLine(pts) { const out = [[]]; pts.forEach((p, i) => { if (i && Math.abs(p[1] - pts[i - 1][1]) > 180) out.push([]); out[out.length - 1].push(p); }); return out; }
APPS.rot = {
  title: "Rotor", icon: "i-compass",
  panels: { dials: { title: "Rotor", create: createRotDials }, rmap: { title: "Karte", create: createRotMap } },
  layout(dv) { const a = dv.addPanel({ id: "dials", component: "dials", title: "Rotor" }); dv.addPanel({ id: "rmap", component: "rmap", title: "Karte", position: { referencePanel: "dials", direction: "right" } }); setTimeout(() => { try { a.group.api.setSize({ width: 260 }); } catch { } }, 60); },
  menus: [{ label: "Datei", items: [{ label: "Verbinden …", icon: "i-plug", act: openRotorConnect }, { label: "Trennen", act: () => api("/api/settings", { method: "PUT", body: { rot_enabled: false } }) }] },
    { label: "Ansicht", items: [{ label: "Rotor", check: () => panelOpen("rot", "dials"), act: () => togglePanel("rot", "dials") }, { label: "Karte", check: () => panelOpen("rot", "rmap"), act: () => togglePanel("rot", "rmap") }] },
    MENU_WINDOW("rot"), MENU_HELP],
  toolbar: [{ label: "Verbinden", icon: "i-plug", act: openRotorConnect }, { label: "Stopp", icon: "i-x", act: () => act("/api/rotor/stop", {}) }, { label: "Parken", icon: "i-compass", act: () => act("/api/rotor/park", {}) }, "->", { label: "Optionen", icon: "i-gear", act: () => openOptions() }],
};

// ---------- Karten ----------
function createWorldMap(root) {   // Weltkarte: Erde als Karte oder Globus mit QSOs, Spots, Locator-Feldern und DX-Bogen
  root.innerHTML = `<div class="pane-tb"><label class="chk"><input type="checkbox" class="wm-grey" checked> Graulinie</label><label class="chk"><input type="checkbox" class="wm-qso" checked> QSOs</label><label class="chk"><input type="checkbox" class="wm-spots" checked> Spots</label><label class="chk"><input type="checkbox" class="wm-grid"> Locator-Felder</label><span class="hint">Umschalt+Klick: Antenne drehen</span></div><div class="wm" style="height:calc(100% - 30px)"></div><div class="wm-pop hidden"></div>`;
  const pop = $(".wm-pop", root); let pts = [], dx = null;
  const E = wwEarth($(".wm", root), { mode: store.get("wm.mode", "flat"), modes: [["flat", "Karte"], ["globe", "Globus"]], grid: "", onMode: m => store.set("wm.mode", m),
    onClick: (ll, hit, ev) => { pop.classList.add("hidden");
      if (ev.shiftKey && WW.rotor?.enabled && ll) { const b = bearingTo(ll[0], ll[1]); if (b) rotorSet(b.az); return; }
      if (hit?.spot) return tuneSpot(hit.spot.freq, hit.spot.call, hit.spot.comment);
      if (hit?.qsos) { pop.innerHTML = `<b>${esc(hit.qsos[0].country || "")}</b><br>` + hit.qsos.slice(0, 12).map(q => `${esc(q.call)} · ${esc(q.band)} ${esc(q.mode)} · ${fmtDate(q.date)}`).join("<br>") + (hit.qsos.length > 12 ? `<br>… ${hit.qsos.length - 12} weitere` : "");
        pop.style.left = Math.min(ev.offsetX + 12, root.clientWidth - 260) + "px"; pop.style.top = ev.offsetY + 40 + "px"; pop.classList.remove("hidden"); } } });
  const build = () => { const on = c => $(c, root).checked; E.set({ terminator: on(".wm-grey"), grid: on(".wm-grid") ? "maiden" : "" });
    const P = [];
    if (on(".wm-qso")) { const gr = {}; pts.forEach(p => { const k = p.lat.toFixed(2) + "," + p.lon.toFixed(2); (gr[k] = gr[k] || []).push(p); });
      Object.values(gr).forEach(g => { const p = g[0]; P.push({ lat: p.lat, lon: p.lon, color: BAND_COLORS[p.band] || "#94a3b8", r: Math.min(2.5 + g.length * .6, 7), qsos: g, tip: `${p.country || ""} · ${g.length} QSO${g.length > 1 ? "s" : ""}` }); }); }
    if (on(".wm-spots")) WW.spots.forEach(sp => { if (sp.lat != null) P.push({ lat: sp.lat, lon: sp.lon, color: sp.status === "new_dxcc" ? "#ff3b5c" : sp.status === "new_band" ? "#ffb02e" : "#2bd4ff", r: 3, spot: sp, tip: `${sp.call} · ${(sp.freq / 1e3).toFixed(1)} kHz · ${sp.country}` }); });
    if (WW.home) P.push({ lat: WW.home[0], lon: WW.home[1], color: "#2bd4ff", r: 4, pulse: true, tip: `${WW.settings.callsign || ""} ${WW.settings.locator || ""}` });
    if (dx) P.push({ lat: dx.lat, lon: dx.lon, color: "#ff4fd8", r: 4, label: dx.call });
    E.points = P; E.arcs = dx && WW.home ? [{ from: WW.home, to: [dx.lat, dx.lon], color: "#ff4fd8" }] : []; E.redraw(); };
  const load = async () => { try { pts = (await api("/api/map?" + logq())).points; } catch { } build(); };
  root.addEventListener("change", build);
  const offs = [WW.on("qso", load), WW.on("reload", load), WW.on("spots", build), WW.on("dx", d => { dx = d?.lat != null ? d : null; build(); })];
  const t = setInterval(load, 120000); load(); return () => { offs.forEach(f => f()); clearInterval(t); E.destroy(); };
}
function createBeamMap(root) {   // Peilkarte: mittabstandstreu um den eigenen Standort, Antennenkeule, QSOs, Ziel
  root.innerHTML = `<div class="beam-wrap"></div><div class="beam-hover"></div>`;
  let pts = [], dx = null;
  const E = wwEarth($(".beam-wrap", root), { mode: "azi", grid: "", draw: (ctx, E) => drawBeam(ctx, E, WW.rotor, dx),
    onClick: ll => { if (ll) { const b = bearingTo(ll[0], ll[1]); if (b) rotorSet(b.az); } },
    onHover: (hit, ll) => { const b = ll && bearingTo(ll[0], ll[1]); $(".beam-hover", root).textContent = b ? `${Math.round(b.az)}° · ${Math.round(b.km).toLocaleString(I18N.locale)} km` : ""; } });
  const build = () => { E.points = pts.map(p => ({ lat: p.lat, lon: p.lon, color: BAND_COLORS[p.band] || "#94a3b8", r: 2.2, glow: 6, tip: `${p.call} · ${p.band}` }));
    if (dx) E.points.push({ lat: dx.lat, lon: dx.lon, color: "#ff4fd8", r: 4, label: dx.call });
    E.arcs = dx && WW.home ? [{ from: WW.home, to: [dx.lat, dx.lon], color: "#ff4fd8" }] : []; if (WW.home) E.set({ center: [WW.home[0], WW.home[1]] }); E.redraw(); };
  api("/api/map?" + logq()).then(r => { pts = r.points; build(); }).catch(build);
  const offs = [WW.on("rotor", () => E.redraw()), WW.on("dx", d => { dx = d?.lat != null ? d : null; build(); }), WW.on("settings", build)];
  return () => { offs.forEach(f => f()); E.destroy(); };
}
// Antennenkeule (Peilkarte/Rotorkarte): leuchtender Faecher in Drehrichtung, Hauptstrahl, eigener Standort
function drawBeam(ctx, E, rot, target) {
  if (E.o.mode !== "azi") return;
  const [cx, cy] = E.azCenter(), R = E.azRadius();
  if (rot?.connected && rot.az != null) { const a = (rot.az % 360) * Math.PI / 180, w = 30 * Math.PI / 180;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); g.addColorStop(0, "rgba(43,212,255,.35)"); g.addColorStop(1, "rgba(43,212,255,.03)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a - w - Math.PI / 2, a + w - Math.PI / 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#7ff0ff"; ctx.lineWidth = 2.2; ctx.shadowColor = "#2bd4ff"; ctx.shadowBlur = 14; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); ctx.stroke();
    ctx.fillStyle = "#bff8ff"; ctx.font = "bold 13px 'Share Tech Mono', monospace"; ctx.textAlign = "center"; ctx.fillText(`${String(Math.round(((rot.az % 360) + 360) % 360)).padStart(3, "0")}°`, cx + Math.sin(a) * R * .55, cy - Math.cos(a) * R * .55 - 8); }
  ctx.shadowBlur = 16; ctx.shadowColor = "#2bd4ff"; ctx.fillStyle = "#e6fbff"; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fill();
}
APPS.map = {
  title: "Karten", icon: "i-globe",
  panels: { world: { title: "Weltkarte", create: createWorldMap }, beam: { title: "Peilkarte (Großkreis)", create: createBeamMap, dock: { ref: "world", dir: "right" } } },
  layout(dv) { dv.addPanel({ id: "world", component: "world", title: "Weltkarte" }); dv.addPanel({ id: "beam", component: "beam", title: "Peilkarte (Großkreis)", position: { referencePanel: "world", direction: "right" } }); },
  menus: [{ label: "Ansicht", items: [{ label: "Weltkarte", check: () => panelOpen("map", "world"), act: () => togglePanel("map", "world") }, { label: "Peilkarte", check: () => panelOpen("map", "beam"), act: () => togglePanel("map", "beam") }] }, MENU_WINDOW("map"), MENU_HELP],
  toolbar: [],
};

// ---------- Satelliten ----------
const SAT = { list: [], sel: null, txi: 0, lastDop: null, lastRot: null, passes: [] };
const C_KMS = 299792.458;
let _satInit = null;
function satInit() { return _satInit = _satInit || satInitOnce().catch(e => { _satInit = null; throw e; }); }
async function satInitOnce() {
  if (!window.satellite) await loadScript("/static/vendor/satellite.min.js");
  const r = await api("/api/sat/catalog");
  SAT.list = r.sats.map(x => ({ ...x, rec: satellite.twoline2satrec(x.tle1, x.tle2), voice: x.transmitters.some(t => /FM|SSB|LSB|USB|CW|Transponder/i.test(t.mode + " " + t.desc) && t.up_low) }));
  SAT.chosen = new Set(store.get("sat.chosen", SAT.list.filter(s => s.transmitters.length).slice(0, 100).map(s => s.norad)));
  setInterval(satTick, 1000);
}
const satObs = () => { const h = WW.home || [51, 10]; return { latitude: satellite.degreesToRadians(h[0]), longitude: satellite.degreesToRadians(h[1]), height: 0.02 }; };
const satObsAt = (lat, lon) => ({ latitude: satellite.degreesToRadians(lat), longitude: satellite.degreesToRadians(lon), height: 0 });
function satLook(rec, date, obs) { const pv = satellite.propagate(rec, date); if (!pv || !pv.position) return null; const g = satellite.gstime(date), ecf = satellite.eciToEcf(pv.position, g), la = satellite.ecfToLookAngles(obs || satObs(), ecf), gd = satellite.eciToGeodetic(pv.position, g);
  return { az: satellite.radiansToDegrees(la.azimuth), el: satellite.radiansToDegrees(la.elevation), range: la.rangeSat, lat: satellite.degreesLat(gd.latitude), lon: satellite.degreesLong(gd.longitude), alt: gd.height }; }
// Ueberfluege; mit obs2 = gemeinsame Sichtbarkeit (Satellit bei beiden Stationen ueber dem Horizont)
function satPasses(rec, from, hours = 48, max = 12, obs2 = null) {
  const out = [], step = 20e3, end = from.getTime() + hours * 3600e3, el = t => { const d = new Date(t), l = satLook(rec, d); if (!l) return -90; if (!obs2) return l.el; const l2 = satLook(rec, d, obs2); return l2 ? Math.min(l.el, l2.el) : -90; };
  const edge = (a, b, rising) => { for (let i = 0; i < 12; i++) { const m = (a + b) / 2; (el(m) > 0) === rising ? (b = m) : (a = m); } return (a + b) / 2; };
  let t = from.getTime(), prev = el(t), cur = null;
  if (prev > 0) { let b = t; while (el(b - step) > 0 && t - b < 3 * 3600e3) b -= step; cur = { aos: edge(b - step, b, true), maxEl: prev, maxT: t }; }
  for (t += step; t < end && out.length < max; t += step) { const e = el(t); if (e > 0 && prev <= 0) cur = { aos: edge(t - step, t, true), maxEl: e, maxT: t };
    if (cur && e > cur.maxEl) { cur.maxEl = e; cur.maxT = t; } if (e <= 0 && prev > 0 && cur) { cur.los = edge(t - step, t, false); out.push(cur); cur = null; } prev = e; }
  return out.map(p => { let a = Math.max(p.aos, p.maxT - step), b = Math.min(p.los, p.maxT + step); for (let i = 0; i < 25; i++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; el(m1) < el(m2) ? (a = m1) : (b = m2); }
    return { ...p, maxT: (a + b) / 2, maxEl: el((a + b) / 2), aosAz: satLook(rec, new Date(p.aos)).az, losAz: satLook(rec, new Date(p.los)).az }; });
}
function gridLatLon(g) {
  g = (g || "").trim().toUpperCase(); if (!/^[A-R]{2}\d{2}([A-X]{2}(\d{2})?)?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + +g[2] * 2, lat = (g.charCodeAt(1) - 65) * 10 - 90 + +g[3], w = 2, h = 1;
  if (g.length >= 6) { lon += (g.charCodeAt(4) - 65) * 2 / 24; lat += (g.charCodeAt(5) - 65) / 24; w = 2 / 24; h = 1 / 24; }
  if (g.length >= 8) { lon += +g[6] * 2 / 240; lat += +g[7] / 240; w = 2 / 240; h = 1 / 240; }
  return [lat + h / 2, lon + w / 2];
}
const fmtDT = t => { const s = new Date(t).toISOString(); return `${s.slice(8, 10)}.${s.slice(5, 7)}. ${s.slice(11, 16)}`; };
// Gemeinsame Sichtbarkeit mit einer anderen Station (Rufzeichen oder Locator)
function createSatMutual(root) {
  const st = store.get("sat.mutual", { dx: "", all: false, minEl: 0 });
  root.innerHTML = `<div class="pane-tb"><input class="sm-dx" placeholder="Rufzeichen oder Locator der Gegenstation" value="${esc(st.dx)}" style="width:230px"><button class="sm-go">Berechnen</button>
    <label class="chk"><input type="checkbox" class="sm-all" ${st.all ? "checked" : ""}> alle ausgewählten Satelliten</label><label class="chk">min. El <input type="number" class="sm-min" value="${st.minEl}" min="0" max="60" style="width:46px">°</label><span class="hint sm-info"></span></div>
    <div class="tablewrap"><table class="grid sm-t"><thead><tr><th>Satellit</th><th>Beginn (UTC)</th><th>Ende</th><th>Dauer</th><th>max. El gemeinsam</th><th>El hier / dort</th></tr></thead><tbody></tbody></table></div>`;
  const run = async () => {
    const dx = $(".sm-dx", root).value.trim().toUpperCase(), all = $(".sm-all", root).checked, minEl = +$(".sm-min", root).value || 0; store.set("sat.mutual", { dx, all, minEl });
    if (!dx) return; await satInit(); let pos = gridLatLon(dx), where = dx;
    if (!pos) { try { const r = await api("/api/lookup/" + encodeURIComponent(dx)); if (r.lat == null) throw new Error(); pos = [r.lat, r.lon]; where = `${dx} (${r.country || ""}${r.pos_from === "dxcc" ? ", Landesmitte" : ""})`; } catch { $(".sm-info", root).textContent = "Rufzeichen/Locator unbekannt"; return; } }
    const o2 = satObsAt(pos[0], pos[1]), sats = all ? SAT.list.filter(x => SAT.chosen.has(x.norad)) : (SAT.sel ? [SAT.sel] : []), rows = [], now = new Date();
    $(".sm-info", root).textContent = "rechnet …"; await new Promise(r => setTimeout(r, 20));
    for (const x of sats) for (const p of satPasses(x.rec, now, all ? 24 : 72, all ? 6 : 20, o2)) if (p.maxEl >= minEl) {
      const a = satLook(x.rec, new Date(p.maxT)), b = satLook(x.rec, new Date(p.maxT), o2); rows.push({ x, p, here: a.el, there: b.el }); }
    rows.sort((a, b) => a.p.aos - b.p.aos);
    $(".sm-info", root).textContent = `${where} · ${pos[0].toFixed(1)}°, ${pos[1].toFixed(1)}° · ${rows.length} Fenster`;
    const nowT = Date.now();
    $("tbody", root).innerHTML = rows.map(({ x, p, here, there }) => `<tr data-n="${x.norad}" class="${p.aos <= nowT && p.los >= nowT ? "now" : ""}"><td>${esc(x.name)}</td><td>${fmtDT(p.aos)}</td><td>${hhmm(p.los)}</td><td>${Math.round((p.los - p.aos) / 60000)} min</td><td><b>${Math.round(p.maxEl)}°</b></td><td>${Math.round(here)}° / ${Math.round(there)}°</td></tr>`).join("")
      || `<tr><td colspan="6" class="hint">Kein gemeinsames Fenster in ${all ? 24 : 72} h.</td></tr>`; };
  root.addEventListener("click", e => { if (e.target.closest(".sm-go")) run(); const r = e.target.closest("tr[data-n]"); if (r) satSelect(+r.dataset.n); });
  root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("sm-dx")) run(); });
  const off = WW.on("sat-sel", () => { if (!$(".sm-all", root).checked && $(".sm-dx", root).value) run(); });
  satInit().then(() => st.dx && run()).catch(() => { }); return off;
}
// Zeitplan: alle ausgewaehlten Satelliten nach Beginn sortiert
function createSatSchedule(root) {
  const st = store.get("sat.sched", { hours: 12, minEl: 10, voice: true });
  root.innerHTML = `<div class="pane-tb"><label class="chk">nächste <select class="ss-h">${[3, 6, 12, 24, 48].map(h => `<option ${h === st.hours ? "selected" : ""}>${h}</option>`).join("")}</select> h</label>
    <label class="chk">min. El <input type="number" class="ss-min" value="${st.minEl}" min="0" max="80" style="width:46px">°</label><label class="chk"><input type="checkbox" class="ss-voice" ${st.voice ? "checked" : ""}> nur mit Sprechfunk/Transponder</label><span class="hint ss-info"></span></div>
    <div class="tablewrap"><table class="grid ss-t"><thead><tr><th>Satellit</th><th>Beginn (UTC)</th><th>Az</th><th>max. El</th><th>Ende</th><th>Az</th><th>Dauer</th><th>Betrieb</th></tr></thead><tbody></tbody></table></div>`;
  const draw = async () => {
    await satInit(); const hours = +$(".ss-h", root).value, minEl = +$(".ss-min", root).value || 0, voice = $(".ss-voice", root).checked; store.set("sat.sched", { hours, minEl, voice });
    const now = new Date(), rows = [];
    for (const x of SAT.list.filter(s => SAT.chosen.has(s.norad) && (!voice || s.voice))) for (const p of satPasses(x.rec, now, hours, 50)) if (p.maxEl >= minEl) rows.push({ x, p });
    rows.sort((a, b) => a.p.aos - b.p.aos); const t = Date.now();
    const op = x => [...new Set(x.transmitters.filter(t => t.up_low).map(t => /transponder/i.test(t.type) || t.invert ? (t.invert ? "Lin. Transp. (inv.)" : "Lin. Transp.") : t.mode))].slice(0, 3).join(", ");
    $(".ss-info", root).textContent = `${rows.length} Überflüge`;
    $("tbody", root).innerHTML = rows.map(({ x, p }) => `<tr data-n="${x.norad}" class="${p.aos <= t && p.los >= t ? "now" : ""}${x.norad === SAT.sel?.norad ? " sel" : ""}"><td>${esc(x.name)}</td><td>${fmtDT(p.aos)}</td><td>${Math.round(p.aosAz)}°</td><td><b>${Math.round(p.maxEl)}°</b></td><td>${hhmm(p.los)}</td><td>${Math.round(p.losAz)}°</td><td>${Math.round((p.los - p.aos) / 60000)} min</td><td>${esc(op(x))}</td></tr>`).join("")
      || '<tr><td colspan="8" class="hint">keine Überflüge</td></tr>'; };
  root.addEventListener("change", e => { if (e.target.closest(".pane-tb")) draw(); });
  root.addEventListener("click", e => { const r = e.target.closest("tr[data-n]"); if (r) satSelect(+r.dataset.n); });
  draw().catch(e => root.innerHTML = `<div class="err">${esc(e.message)}</div>`);
  const tm = setInterval(draw, 60000), offs = [WW.on("sat-chosen", draw)]; return () => { clearInterval(tm); offs.forEach(f => f()); };
}
const hhmm = t => new Date(t).toISOString().slice(11, 16);
function satSelect(norad) { SAT.sel = SAT.list.find(x => x.norad === norad); if (!SAT.sel) return; store.set("sat", norad); SAT.txi = 0; SAT.lastDop = null; SAT.lastRot = null; SAT.passes = satPasses(SAT.sel.rec, new Date()); WW.emit("sat-sel"); }
function satTick() {
  if (!SAT.sel) return; const now = new Date(), x = SAT.sel, l = satLook(x.rec, now), l2 = satLook(x.rec, new Date(+now + 1000)); if (!l) return;
  const rr = l2.range - l.range; SAT.now = { ...l, rr };
  if (SAT.passes[0] && SAT.passes[0].los < +now) SAT.passes = satPasses(x.rec, now);
  const t = x.transmitters[SAT.txi], info = [], tr = store.get("sat.track", {});
  if (tr.rig && t && l.el > -2) { const rx = t.down_low ? Math.round(t.down_low * (1 - rr / C_KMS) / 10) * 10 : null, tx = t.up_low ? Math.round(t.up_low * (1 + rr / C_KMS) / 10) * 10 : null;
    if (rx && (!SAT.lastDop || Math.abs(SAT.lastDop.rx - rx) >= 20)) { SAT.lastDop = { rx, tx }; post("/api/rig/freq", { hz: rx }).catch(() => { }); if (tx && tr.up) { if (!WW.rig.split) post("/api/rig/split", { on: true }).catch(() => { }); post("/api/rig/split_freq", { hz: tx }).catch(() => { }); } }
    if (SAT.lastDop) info.push(`RX ${fmtMHz(SAT.lastDop.rx)}${SAT.lastDop.tx && tr.up ? " · TX " + fmtMHz(SAT.lastDop.tx) : ""}`); }
  if (tr.rot) { if (!WW.rotor?.enabled) info.push("Rotor nicht verbunden"); else if (l.el >= 0 && (!SAT.lastRot || Math.abs(SAT.lastRot.az - l.az) > 2 || Math.abs(SAT.lastRot.el - l.el) > 2)) { SAT.lastRot = { az: l.az, el: l.el }; post("/api/rotor/set", { az: Math.round(l.az), el: Math.round(l.el) }).catch(() => { }); } if (l.el < 0) info.push("Rotor wartet auf Aufgang"); }
  SAT.info = info.join(" · "); WW.emit("sat-tick");
}
function createSatList(root) {
  root.innerHTML = `<div class="pane-tb"><input class="sl-q grow" placeholder="Satellit suchen …"><label class="chk"><input type="checkbox" class="sl-sel" checked> nur ausgewählte</label><button class="sl-choose">Auswahl …</button></div><div class="sat-rows"></div>`;
  const draw = () => { if (!SAT.list.length) return; const q = $(".sl-q", root).value.toLowerCase(), onlySel = $(".sl-sel", root).checked, now = new Date();
    const rows = SAT.list.filter(x => (!q || x.name.toLowerCase().includes(q) || String(x.norad) === q) && (!onlySel || SAT.chosen.has(x.norad))).map(x => ({ x, l: satLook(x.rec, now) })).sort((a, b) => (b.l?.el ?? -99) - (a.l?.el ?? -99));
    $(".sat-rows", root).innerHTML = rows.map(({ x, l }) => `<div class="sat-row${l?.el > 0 ? " up" : ""}${x.norad === SAT.sel?.norad ? " sel" : ""}" data-n="${x.norad}"><span class="nm">${esc(x.name)}</span><span class="el">${l ? Math.round(l.el) + "°" : "–"}</span></div>`).join("") || '<div class="hint">keine</div>'; };
  root.addEventListener("input", draw); root.addEventListener("change", draw);
  root.addEventListener("click", e => { const r = e.target.closest("[data-n]"); if (r) satSelect(+r.dataset.n); if (e.target.closest(".sl-choose")) satChooser(draw); });
  satInit().then(() => { draw(); const pre = store.get("sat", 25544); if (!SAT.sel && SAT.list.some(x => x.norad === pre)) satSelect(pre); }).catch(e => root.innerHTML = `<div class="err">${esc(e.message)}</div>`);
  const t = setInterval(draw, 10000); const off = WW.on("sat-sel", draw), off2 = WW.on("sat-chosen", draw); return () => { clearInterval(t); off(); off2(); };
}
function satChooser(cb) {
  const d = dialog({ title: "Satelliten auswählen (max. 100)", icon: "i-sat", wide: true, buttons: [["Abbrechen", "close"], ["OK", "ok", "primary"]], body: `<div class="dual"><div><b>Verfügbar</b><select multiple size="18" class="av">${SAT.list.filter(x => !SAT.chosen.has(x.norad)).map(x => `<option value="${x.norad}">${esc(x.name)}</option>`).join("")}</select></div>
    <div class="dual-btns"><button type="button" data-m="add">&gt;</button><button type="button" data-m="all">&gt;&gt;</button><button type="button" data-m="rm">&lt;</button><button type="button" data-m="none">&lt;&lt;</button></div>
    <div><b>Ausgewählt</b><select multiple size="18" class="ch">${SAT.list.filter(x => SAT.chosen.has(x.norad)).map(x => `<option value="${x.norad}">${esc(x.name)}</option>`).join("")}</select></div></div><p class="hint">Bahndaten: CelesTrak (Amateur), Sender: SatNOGS – werden automatisch aktualisiert.</p>` });
  const av = $(".av", d), ch = $(".ch", d);
  d.addEventListener("click", e => { const m = e.target.dataset.m; if (!m) return; const mv = (from, to, all) => [...from.options].filter(o => all || o.selected).forEach(o => to.appendChild(o));
    if (m === "add") mv(av, ch); if (m === "all") mv(av, ch, true); if (m === "rm") mv(ch, av); if (m === "none") mv(ch, av, true); });
  av.ondblclick = () => [...av.selectedOptions].forEach(o => ch.appendChild(o)); ch.ondblclick = () => [...ch.selectedOptions].forEach(o => av.appendChild(o));
  d.querySelector('[value="ok"]').onclick = e => { e.preventDefault(); SAT.chosen = new Set([...ch.options].slice(0, 100).map(o => +o.value)); store.set("sat.chosen", [...SAT.chosen]); d.close(); cb(); WW.emit("sat-chosen"); };
}
function createSatInfo(root) {
  const tr = store.get("sat.track", {});
  root.innerHTML = `<div class="sat-head"></div><div class="pane-tb"><label class="chk"><input type="checkbox" data-t="rig" ${tr.rig ? "checked" : ""}> Funkgerät nachführen (Doppler)</label><label class="chk"><input type="checkbox" data-t="up" ${tr.up ? "checked" : ""}> Uplink per Split</label>
    <label class="chk"><input type="checkbox" data-t="rot" ${tr.rot ? "checked" : ""}> Rotor nachführen (Az/El)</label><span class="hint sat-trinfo"></span></div>
    <div class="tablewrap"><table class="grid sat-tx"><thead><tr><th></th><th>Sender</th><th>Mode</th><th>Downlink</th><th>Doppler RX</th><th>Uplink</th><th>Doppler TX</th></tr></thead><tbody></tbody></table></div>`;
  root.addEventListener("change", e => { if (e.target.dataset.t) { const t = store.get("sat.track", {}); t[e.target.dataset.t] = e.target.checked; store.set("sat.track", t); SAT.lastDop = null; SAT.lastRot = null; } if (e.target.name === "stx") { SAT.txi = +e.target.value; SAT.lastDop = null; } });
  const sel = () => { const x = SAT.sel; if (!x) return; $("tbody", root).innerHTML = x.transmitters.map((t, i) => `<tr><td><input type="radio" name="stx" value="${i}" ${i === SAT.txi ? "checked" : ""}></td><td title="${esc(t.desc)}">${esc(t.desc.slice(0, 44))}</td><td>${esc(t.mode)}${t.invert ? " inv." : ""}</td><td class="mono">${t.down_low ? fmtMHz(t.down_low) : "–"}</td><td class="mono" data-dl="${i}">–</td><td class="mono">${t.up_low ? fmtMHz(t.up_low) : "–"}</td><td class="mono" data-ul="${i}">–</td></tr>`).join("") || '<tr><td colspan="7" class="hint">keine aktiven Sender bekannt</td></tr>'; };
  const tick = () => { const x = SAT.sel, l = SAT.now; if (!x || !l) return; const p = SAT.passes[0], now = Date.now();
    const nx = !p ? "kein Überflug in 48 h" : p.aos <= now ? `Überflug läuft, noch ${Math.max(0, Math.round((p.los - now) / 60000))} min` : `nächster Überflug in ${Math.round((p.aos - now) / 60000)} min (${hhmm(p.aos)} UTC, max ${Math.round(p.maxEl)}°)`;
    $(".sat-head", root).innerHTML = `<b>${esc(x.name)}</b><span class="${l.el > 0 ? "up" : ""}">Az ${l.az.toFixed(1)}° · El ${l.el.toFixed(1)}°</span><span>${Math.round(l.range).toLocaleString(I18N.locale)} km</span><span>Höhe ${Math.round(l.alt)} km</span><span>${l.rr > 0 ? "entfernt sich" : "nähert sich"} ${Math.abs(l.rr).toFixed(2)} km/s</span><span class="hint">${nx}</span>`;
    x.transmitters.forEach((t, i) => { const dl = $(`[data-dl="${i}"]`, root), ul = $(`[data-ul="${i}"]`, root); if (dl && t.down_low) dl.textContent = fmtMHz(Math.round(t.down_low * (1 - l.rr / C_KMS))); if (ul && t.up_low) ul.textContent = fmtMHz(Math.round(t.up_low * (1 + l.rr / C_KMS))); });
    $(".sat-trinfo", root).textContent = SAT.info || ""; };
  const offs = [WW.on("sat-sel", sel), WW.on("sat-tick", tick)]; satInit().then(sel); return () => offs.forEach(f => f());
}
function createSatPasses(root) {
  root.innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Datum</th><th>Beginn</th><th>Az</th><th>max. El</th><th>Ende</th><th>Az</th><th>Dauer</th></tr></thead><tbody></tbody></table></div>`;
  const draw = () => { const now = Date.now(); $("tbody", root).innerHTML = SAT.passes.map(p => `<tr class="${p.aos <= now && p.los >= now ? "now" : ""}"><td>${new Date(p.aos).toISOString().slice(8, 10)}.${new Date(p.aos).toISOString().slice(5, 7)}.</td><td>${hhmm(p.aos)}</td><td>${Math.round(p.aosAz)}°</td><td><b>${Math.round(p.maxEl)}°</b></td><td>${hhmm(p.los)}</td><td>${Math.round(p.losAz)}°</td><td>${Math.round((p.los - p.aos) / 60000)} min</td></tr>`).join("") || '<tr><td colspan="7" class="hint">kein Überflug in 48 h</td></tr>'; };
  return WW.on("sat-sel", draw);
}
function createSatPolar(root) {
  root.innerHTML = `<canvas class="pol"></canvas>`; const cv = $(".pol", root);
  const draw = () => { const W = Math.min(root.clientWidth, root.clientHeight) - 4; if (W < 50) return; cv.width = cv.height = W; const ctx = cv.getContext("2d"), c = W / 2, R = c - 16;
    const xy = (az, el) => { const r = R * (90 - Math.max(0, el)) / 90, a = az * Math.PI / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
    ctx.clearRect(0, 0, W, W); ctx.strokeStyle = "#999"; ctx.fillStyle = "#555"; ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    [0, 30, 60].forEach(el => { ctx.beginPath(); ctx.arc(c, c, R * (90 - el) / 90, 0, 7); ctx.stroke(); }); [["N", 0], ["O", 90], ["S", 180], ["W", 270]].forEach(([l, a]) => { const p = xy(a, -8); ctx.fillText(l, p[0], p[1]); });
    const p = SAT.passes[0]; if (p && SAT.sel) { ctx.beginPath(); let f = true; for (let t = p.aos; t <= p.los; t += 10e3) { const l = satLook(SAT.sel.rec, new Date(t)), q = xy(l.az, l.el); f ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1]); f = false; } ctx.strokeStyle = "#1f5fae"; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      ctx.textAlign = "left"; ctx.fillText(`${p.aos <= Date.now() ? "jetzt" : hhmm(p.aos) + " UTC"} · max ${Math.round(p.maxEl)}°`, 4, 10); }
    const l = SAT.now; if (l && l.el > -5) { const q = xy(l.az, l.el); ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, 7); ctx.fillStyle = l.el > 0 ? "#d62828" : "#888"; ctx.fill(); } };
  const ro = new ResizeObserver(draw); ro.observe(root); const offs = [WW.on("sat-tick", draw), WW.on("sat-sel", draw)]; return () => { ro.disconnect(); offs.forEach(f => f()); };
}
function createSatMap(root) {   // Satellit ueber der Erde: Bodenspur, Sichtbereich, eigener Standort
  const E = wwEarth(root, { mode: store.get("sm.mode", "globe"), modes: [["globe", "Globus"], ["flat", "Karte"]], grid: "latlon", onMode: m => store.set("sm.mode", m) });
  let last = 0, follow = true;
  const draw = () => { if (!SAT.sel || !SAT.now || Date.now() - last < 3000) return; last = Date.now(); const x = SAT.sel, now = new Date(), l = SAT.now;
    const track = []; for (let t = -45; t <= 90; t++) { const p = satLook(x.rec, new Date(+now + t * 60e3)); if (p) track.push([p.lat, p.lon]); }
    const fr = Math.acos(6371 / (6371 + l.alt)) * 6371, foot = []; for (let a = 0; a <= 360; a += 4) foot.push(destPoint([l.lat, l.lon], a, fr));
    E.lines = [{ pts: track, color: "#ffb02e", width: 1.6, dash: [5, 5], glow: 8 }, { pts: foot, color: l.el > 0 ? "#3dffa2" : "#2bd4ff", width: 1.4, glow: 10 }];
    E.points = [...(WW.home ? [{ lat: WW.home[0], lon: WW.home[1], color: "#2bd4ff", r: 3.5, pulse: true }] : []), { lat: l.lat, lon: l.lon, color: "#ff4fd8", r: 5, pulse: true, label: x.name }];
    E.arcs = WW.home && l.el > 0 ? [{ from: WW.home, to: [l.lat, l.lon], color: "#3dffa2", width: 1.4 }] : [];
    if (follow && E.o.mode === "globe") E.set({ center: [Math.max(-60, Math.min(60, l.lat)), l.lon] }); else E.redraw(); };
  root.addEventListener("pointerdown", () => { follow = false; });
  root.addEventListener("dblclick", () => { follow = true; last = 0; draw(); });
  const offs = [WW.on("sat-tick", draw), WW.on("sat-sel", () => { last = 0; follow = true; draw(); })]; return () => { offs.forEach(f => f()); E.destroy(); };
}
APPS.sat = {
  title: "Satelliten", icon: "i-sat",
  panels: { satlist: { title: "Satelliten", create: createSatList }, satinfo: { title: "Position & Frequenzen", create: createSatInfo }, satpolar: { title: "Überflug", create: createSatPolar },
    satmap: { title: "Karte", create: createSatMap }, satpasses: { title: "Überflüge", create: createSatPasses },
    satmutual: { title: "Gemeinsame Sichtbarkeit", create: createSatMutual }, satsched: { title: "Zeitplan", create: createSatSchedule } },
  layout(dv) { const l = dv.addPanel({ id: "satlist", component: "satlist", title: "Satelliten" });
    const m = dv.addPanel({ id: "satmap", component: "satmap", title: "Karte", position: { referencePanel: "satlist", direction: "right" } });
    dv.addPanel({ id: "satpolar", component: "satpolar", title: "Überflug", position: { referencePanel: "satmap", direction: "left" } });
    dv.addPanel({ id: "satinfo", component: "satinfo", title: "Position & Frequenzen", position: { referencePanel: "satmap", direction: "below" } });
    dv.addPanel({ id: "satpasses", component: "satpasses", title: "Überflüge", position: { referencePanel: "satinfo", direction: "right" } });
    dv.addPanel({ id: "satsched", component: "satsched", title: "Zeitplan", position: { referencePanel: "satpasses", direction: "within" }, inactive: true });
    dv.addPanel({ id: "satmutual", component: "satmutual", title: "Gemeinsame Sichtbarkeit", position: { referencePanel: "satpasses", direction: "within" }, inactive: true });
    setTimeout(() => { try { l.group.api.setSize({ width: 230 }); dv.getPanel("satpolar").group.api.setSize({ width: 300 }); dv.getPanel("satinfo").group.api.setSize({ height: 280 }); } catch { } }, 60); },
  menus: [{ label: "Datei", items: [{ label: "Satelliten auswählen …", act: () => satChooser(() => WW.emit("sat-sel")) }] },
    { label: "Ansicht", items: Object.entries({ satlist: "Satelliten", satinfo: "Position & Frequenzen", satpolar: "Überflug", satmap: "Karte", satpasses: "Überflüge", satsched: "Zeitplan", satmutual: "Gemeinsame Sichtbarkeit" }).map(([k, l]) => ({ label: l, check: () => panelOpen("sat", k), act: () => togglePanel("sat", k) })) },
    MENU_WINDOW("sat"), MENU_HELP],
  toolbar: [{ label: "Satelliten wählen", icon: "i-list", act: () => satChooser(() => WW.emit("sat-sel")) }],
};

// ---------- Programmstart ----------
async function boot() {
  applyChrome();
  await refreshState();
  await loadLogbooks();
  await loadPlugins();
  const ORDER = ["rig", "log", "dm", "wl", "sat", "rot", "map", ...Object.keys(APPS).filter(k => k.startsWith("p_"))];
  $("#apptabs").innerHTML = ORDER.filter(k => APPS[k]).map(k => [k, APPS[k]]).map(([k, a]) => `<button data-app="${k}">${icon(a.icon)}${esc(a.title)}</button>`).join("");
  $("#apptabs").addEventListener("click", e => { const b = e.target.closest("[data-app]"); if (b) switchApp(b.dataset.app); });
  const h0 = new URLSearchParams(location.search).get("app") || location.hash.slice(1);
  switchApp(APPS[h0] ? h0 : store.get("app", "rig"));
  connectWs();
  ["state", "rig", "radios", "cluster", "rotor", "wsjtx", "cluster-info", "settings", "logbooks"].forEach(ev => WW.on(ev, renderStatus)); renderStatus();
  WW.on("offline", () => { $("#statusbar").classList.add("offline"); }); WW.on("state", () => $("#statusbar").classList.remove("offline"));
  if (!WW.settings.callsign) { openOptions("station"); toast("Bitte zuerst Rufzeichen und Locator eintragen"); }
}
boot().catch(e => { console.error(e); toast("Start fehlgeschlagen: " + e.message, true); });
