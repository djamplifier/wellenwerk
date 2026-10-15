"use strict";
// Wellenwerk – Programmrahmen: Programme (Gerätesteuerung, Logbuch, Digitalbetrieb, Satelliten, Rotor, Karten) als
// Hauptregister, je Programm eigene Menues/Werkzeugleiste und andockbare Fenster (verschieben, stapeln, loesen).
const APPS = {};
const SHELL = { active: null, dv: {}, panels: {} };

function icon(id, cls = "") { return `<svg class="ic ${cls}"><use href="/static/icons.svg#${id}"/></svg>`; }

// ---------- Dialoge ----------
function dialog({ title, icon: ic, body, buttons = [["Schließen", "close"]], wide = false, onOpen }) {
  const d = h(`<dialog class="dlg${wide ? " wide" : ""}"><form method="dialog"><h2>${ic ? icon(ic) : ""}${esc(title)}</h2><div class="dlg-body"></div>
    <div class="actions">${buttons.map(([l, v, cls]) => `<button value="${v}" class="${cls || ""}" ${v === "close" ? "formnovalidate" : ""}>${esc(l)}</button>`).join("")}</div></form></dialog>`);
  const b = d.querySelector(".dlg-body"); if (typeof body === "string") b.innerHTML = body; else if (body) b.appendChild(body);
  document.body.appendChild(d);
  d.addEventListener("close", () => d.remove());
  d.showModal(); if (onOpen) onOpen(d);
  return d;
}
function tabsIn(root) {   // einfache Register in Dialogen: .dtabs > button[data-t], .dtab[data-t]
  root.querySelectorAll(".dtabs button").forEach(b => b.type = "button");   // sonst faengt der erste Reiter Enter im Formular ab
  root.querySelectorAll(".dtabs button").forEach(b => b.addEventListener("click", e => {
    e.preventDefault();
    root.querySelectorAll(".dtabs button").forEach(x => x.classList.toggle("on", x === b));
    root.querySelectorAll(".dtab").forEach(t => t.classList.toggle("hidden", t.dataset.t !== b.dataset.t));
  }));
}
function info(title, html) { dialog({ title, body: html, buttons: [["OK", "close", "primary"]] }); }

// ---------- Menues ----------
function renderMenus(app) {
  const mb = $("#menubar");
  mb.innerHTML = (app.menus || []).map((m, i) => `<div class="menu" data-i="${i}"><button type="button">${esc(m.label)}</button><div class="drop"></div></div>`).join("");
  mb.querySelectorAll(".menu").forEach(el => {
    const m = app.menus[+el.dataset.i];
    el.querySelector(".drop").innerHTML = m.items.map((it, j) => it === "-" ? "<hr>" : typeof it === "string" ? `<div class="label">${esc(it)}</div>` :
      `<button type="button" data-j="${j}" ${it.disabled ? "disabled" : ""}>${it.icon ? icon(it.icon) : '<span class="ic"></span>'}<span>${esc(it.label)}</span>${it.check ? `<b class="chk" data-check="${j}"></b>` : ""}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}</button>`).join("");
    el.querySelector(".drop").addEventListener("click", e => {
      const b = e.target.closest("button[data-j]"); if (!b) return;
      closeMenus(); const it = m.items[+b.dataset.j]; if (it.act) it.act();
    });
  });
}
function closeMenus() { $$(".menu.open").forEach(x => x.classList.remove("open")); }
function refreshMenuChecks() {
  const app = APPS[SHELL.active]; if (!app) return;
  $$("#menubar .menu").forEach(el => { const m = app.menus[+el.dataset.i];
    el.querySelectorAll("[data-check]").forEach(c => { const it = m.items[+c.dataset.check]; c.textContent = it.check() ? "✓" : ""; }); });
}

// ---------- Werkzeugleiste ----------
function renderToolbar(app) {
  const tb = $("#toolbar");
  tb.innerHTML = (app.toolbar || []).map((t, i) => t === "|" ? '<i class="sep"></i>' : t === "->" ? '<i class="grow"></i>' :
    t.html ? `<div class="tb-widget" data-i="${i}">${t.html}</div>` :
    `<button type="button" data-i="${i}" title="${esc(t.title || t.label)}" ${t.disabled ? "disabled" : ""}>${icon(t.icon)}<span>${esc(t.label)}</span></button>`).join("");
  tb.querySelectorAll("button[data-i]").forEach(b => b.addEventListener("click", () => { const t = app.toolbar[+b.dataset.i]; t.act && t.act(); refreshToolbar(); }));
  (app.toolbar || []).forEach((t, i) => { if (t.init) t.init(tb.querySelector(`[data-i="${i}"]`)); });
  refreshToolbar();
}
function refreshToolbar() {
  const app = APPS[SHELL.active]; if (!app) return;
  $$("#toolbar button[data-i]").forEach(b => { const t = app.toolbar[+b.dataset.i]; if (t.on) b.classList.toggle("on", !!t.on()); });
}

// ---------- Andockbare Fenster ----------
function dvApi(appId) { return SHELL.dv[appId]; }
function panelOpen(appId, id) { return !!dvApi(appId)?.getPanel(id); }
function addPanel(appId, comp, opts = {}) {
  const app = APPS[appId], def = app.panels[comp], dv = dvApi(appId);
  if (!dv) return;
  const id = opts.id || comp;
  const ex = dv.getPanel(id); if (ex) { ex.api.setActive(); return ex; }
  let position = opts.position;
  if (!position && def.dock) {
    const ref = def.dock.ref && [].concat(def.dock.ref).map(r => dv.getPanel(r)).find(Boolean);
    position = ref ? { referencePanel: ref.id, direction: def.dock.dir || "within" } : def.dock.dir && def.dock.dir !== "within" ? { direction: def.dock.dir } : undefined;
  }
  const p = dv.addPanel({ id, component: comp, title: opts.title || def.title, params: opts.params || {}, position, floating: opts.floating });
  if (def.size && !opts.floating) setTimeout(() => { try { p.group.api.setSize(def.size); } catch { } }, 30);
  return p;
}
function togglePanel(appId, comp) {
  const dv = dvApi(appId); const p = dv?.getPanel(comp);
  if (p) dv.removePanel(p); else addPanel(appId, comp);
  refreshToolbar(); refreshMenuChecks();
}
function headerActions() {   // Tasten rechts in jedem Fensterkopf: loesen, eigenes Browserfenster, maximieren
  const el = h(`<div class="dv-actions"><button title="Lösen (schwebend)">⇱</button><button title="In eigenem Browserfenster (zweiter Bildschirm)">⧉</button><button title="Maximieren / zurück">□</button></div>`);
  let group, api;
  const [fl, po, mx] = el.querySelectorAll("button");
  fl.onclick = () => { const p = group.activePanel; if (p) api.addFloatingGroup(p, { width: 520, height: 380, x: 80, y: 80 }); };
  po.onclick = () => { const p = group.activePanel; if (p) api.addPopoutGroup(p, { popoutUrl: "/static/popout.html" }); };
  mx.onclick = () => { if (group.api.isMaximized()) group.api.exitMaximized(); else group.api.maximize(); };
  return { element: el, init(params) { group = params.group; api = params.containerApi; }, dispose() { } };
}
function createWorkspace(appId) {
  const app = APPS[appId];
  const el = h(`<div class="ws hidden" data-app="${appId}"></div>`); $("#workspaces").appendChild(el);
  const dv = window.dockview.createDockview(el, {
    className: "dockview-theme-light ww-dock",
    rightHeaderActionsComponent: () => headerActions(),
    createComponent: o => {
      const def = app.panels[o.name], root = document.createElement("div"); root.className = "pane-root pane-" + o.name;
      let cleanup = [];
      return { element: root, init(params) {
        try { const r = def.create(root, params.params || {}, params.api); if (typeof r === "function") cleanup.push(r); else if (Array.isArray(r)) cleanup = r; } catch (e) { root.innerHTML = `<div class="err">${esc(e.message)}</div>`; console.error(e); }
      }, dispose() { cleanup.forEach(f => { try { f(); } catch { } }); } };
    },
  });
  SHELL.dv[appId] = dv;
  const saved = store.get(`layout.${appId}`, null);
  let ok = false;
  if (saved) { try { dv.fromJSON(saved); ok = dv.panels.length > 0; } catch (e) { console.warn("Layout", e); } }
  if (!ok) { dv.clear(); app.layout(dv); }
  let t; dv.onDidLayoutChange(() => { clearTimeout(t); t = setTimeout(() => { try { store.set(`layout.${appId}`, dv.toJSON()); } catch { } refreshToolbar(); refreshMenuChecks(); }, 400); });
  dv.onDidRemovePanel(() => { refreshToolbar(); refreshMenuChecks(); });
  return el;
}
function resetLayout(appId = SHELL.active) {
  const dv = dvApi(appId); dv.clear(); APPS[appId].layout(dv); store.set(`layout.${appId}`, dv.toJSON()); toast("Standardanordnung wiederhergestellt");
}
function panelInfo(p) { return { id: p.id, component: p.api.component || p.id, title: p.title || p.api.title, params: p.params || {} }; }
function tileLayout(appId = SHELL.active) {   //  „Nebeneinander“: alle Fenster als gleichmaessiges Raster
  const dv = dvApi(appId), list = dv.panels.map(panelInfo); if (!list.length) return;
  const cols = Math.ceil(Math.sqrt(list.length)); dv.clear();
  let rowFirst = null, prev = null;
  list.forEach((d, i) => {
    const position = i === 0 ? undefined : i % cols === 0 ? { referencePanel: rowFirst, direction: "below" } : { referencePanel: prev, direction: "right" };
    dv.addPanel({ ...d, position }); prev = d.id; if (i % cols === 0) rowFirst = d.id;
  });
  toast("Fenster nebeneinander angeordnet");
}
function dockAll(appId = SHELL.active) {   // schwebende und ausgelagerte Fenster zurueck ins Hauptfenster
  const dv = dvApi(appId);
  const loose = dv.panels.filter(p => p.group?.api.location?.type && p.group.api.location.type !== "grid");
  if (!loose.length) { toast("Keine schwebenden Fenster"); return; }
  const anchor = dv.panels.find(p => !loose.includes(p));
  loose.map(p => { const d = panelInfo(p); dv.removePanel(p); return d; })
    .forEach(d => dv.addPanel({ ...d, position: anchor ? { referencePanel: anchor.id, direction: "within" } : undefined }));
  toast(`${loose.length} Fenster angedockt`);
}
function saveLayoutAs(slot, appId = SHELL.active) { store.set(`layout${slot}.${appId}`, dvApi(appId).toJSON()); toast(`Anordnung als Layout ${slot} gespeichert`); }
function loadLayout(slot, appId = SHELL.active) {
  const j = store.get(`layout${slot}.${appId}`, null);
  if (!j) { saveLayoutAs(slot, appId); return; }
  const dv = dvApi(appId); dv.clear(); dv.fromJSON(j); toast(`Layout ${slot}`);
}

// ---------- Programme wechseln ----------
function switchApp(id) {
  if (!APPS[id]) return;
  if (!SHELL.dv[id]) createWorkspace(id);
  SHELL.active = id; store.set("app", id);
  $$(".ws").forEach(w => w.classList.toggle("hidden", w.dataset.app !== id));
  $$("#apptabs button").forEach(b => b.classList.toggle("on", b.dataset.app === id));
  renderMenus(APPS[id]); renderToolbar(APPS[id]);
  document.title = `Wellenwerk – ${APPS[id].title}`;
  $("#wintitle").textContent = `Wellenwerk – ${APPS[id].title}`;
  if (APPS[id].onShow) APPS[id].onShow();
  setTimeout(() => SHELL.dv[id]?.layout(SHELL.dv[id].width, SHELL.dv[id].height, true), 0);
}
function fullScreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => { }); }

// gemeinsame Menuepunkte
const MENU_WINDOW = (appId) => ({ label: "Fenster", items: [
  { label: "Standardanordnung wiederherstellen", act: () => resetLayout(appId) },
  { label: "Nebeneinander anordnen", act: () => tileLayout(appId) }, { label: "Alle Fenster andocken", act: () => dockAll(appId) },
  { label: "Als Layout A speichern", act: () => saveLayoutAs("A", appId) }, { label: "Als Layout B speichern", act: () => saveLayoutAs("B", appId) },
  { label: "Layout A", act: () => loadLayout("A", appId) }, { label: "Layout B", act: () => loadLayout("B", appId) }, "-",
  { label: "Vollbild", key: "F11", act: fullScreen }, "-",
  ...Object.keys(APPS).map(a => ({ label: APPS[a].title, act: () => switchApp(a) })),
] });
const MENU_HELP = { label: "Hilfe", items: [
  { label: "Anleitung", icon: "i-info", act: () => window.open("/static/hilfe.html", "_blank", "width=1100,height=860") },
  { label: "Tastenkürzel", act: () => showKeys() },
  { label: "Lizenzen und Fremdkomponenten", act: () => window.open("/static/hilfe.html?d=lizenzen", "_blank", "width=1000,height=800") },
  { label: "Über Wellenwerk", act: () => info("Über Wellenwerk", `<p><b>Wellenwerk</b> v${esc(WW.version)} – Stationssteuerung, Logbuch und Digitalbetrieb für Funkamateure.</p>
    <p>Freie Software unter der <b>GNU General Public License 3</b> (oder später). Verwendet u. a. <b>Hamlib</b> (LGPL), Zeichentabellen aus <b>fldigi</b> (GPL),
    <b>Electron</b>, <b>Leaflet</b>, <b>dockview</b>, <b>D3</b>, <b>satellite.js</b> sowie Daten von OpenStreetMap, AD1C/country-files.com, NOAA SWPC, EiBi, CelesTrak und SatNOGS –
    <a href="/static/hilfe.html?d=lizenzen" target="_blank">alle Lizenzen</a>.</p>
    <p class="hint">Ohne jede Gewährleistung; Nutzung auf eigene Verantwortung, insbesondere bei der Steuerung von Sendern und Rotoren.
    Wellenwerk ist ein eigenständiges Programm und steht in keiner Verbindung zu Herstellern anderer Funk-Software oder von Funkgeräten.</p>`) },
] };
function showKeys() {
  const acc = store.get("accel", []);
  info("Tastenkürzel", `<dl class="kv"><dt>Mausrad</dt><dd>über einer Ziffer: diese Stelle verstellen (Shift ×2, Strg ×5 auf Abstimmleisten)</dd>
    <dt>← / →</dt><dd>aktive Ziffer wechseln</dd><dt>↑ / ↓, + / −</dt><dd>aktive Ziffer erhöhen / verringern</dd><dt>0–9</dt><dd>Ziffer eintippen</dd>
    <dt>Enter</dt><dd>Frequenz-Dialog (Gerätesteuerung) bzw. QSO loggen (Eingabe)</dd><dt>Esc</dt><dd>Eingabe leeren</dd><dt>F8</dt><dd>Optionen</dd><dt>Strg+F8</dt><dd>Layout anpassen</dd><dt>F11</dt><dd>Vollbild</dd>
    ${acc.map(a => `<dt>${esc(a.combo)}</dt><dd>${esc(a.label)}</dd>`).join("")}</dl>`);
}

// ---------- Statuszeile ----------
function renderStatus() {
  const r = WW.rig, c = WW.cluster || {}, ro = WW.rotor || {}, ci = WW.clusterInfo || {};
  const cur = WW.radios.find(x => x.id === WW.current);
  $("#statusbar").innerHTML = `
    <span class="st ${r.connected ? "on" : "off"}"><i></i><b>Funkgerät</b> ${esc(r.connected ? (cur?.name || r.model || "") : (r.error || "nicht verbunden"))}</span>
    <span class="st ${c.connected ? "on" : "off"}"><i></i><b>Cluster</b> ${esc(c.connected ? c.host : (c.error || "–"))}</span>
    <span class="st ${WW.wsjtx?.ident ? "on" : ""}"><i></i><b>WSJT-X</b> ${esc(WW.wsjtx?.ident || "–")}</span>
    <span class="st ${ro.enabled ? (ro.connected ? "on" : "off") : ""}"><i></i><b>Rotor</b> ${ro.enabled ? (ro.connected ? Math.round(((ro.az % 360) + 360) % 360) + "°" : "getrennt") : "aus"}</span>
    <span class="cinfo" title="${esc(ci.ann || "")}">${esc(ci.ann ? "ANN: " + ci.ann : "")}</span>
    <span class="cinfo" title="${esc(ci.wcy || "")}">${esc(ci.wcy || "")}</span><span class="cinfo" title="${esc(ci.wwv || "")}">${esc(ci.wwv || "")}</span>
    <i class="grow"></i><span>${esc(WW.settings.callsign || "")} · ${esc(WW.settings.locator || "")} · ${esc(WW.logbook)}</span><span>v${esc(WW.version)}</span>`;
}

// ---------- Tastatur ----------
function matchCombo(e) { return `${e.ctrlKey ? "Strg+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`; }
document.addEventListener("keydown", e => {
  if (e.key === "F11") { e.preventDefault(); fullScreen(); return; }
  if (e.key === "F8" && !e.ctrlKey) { e.preventDefault(); openOptions(); return; }
  if (e.key === "F8" && e.ctrlKey) { e.preventDefault(); if (typeof openCustomize === "function") openCustomize(); return; }
  if (e.key === "Escape") closeMenus();
  const acc = store.get("accel", []).find(a => a.combo === matchCombo(e));
  if (acc && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { e.preventDefault(); runAccel(acc); }
});
document.addEventListener("click", e => {
  const mb = e.target.closest(".menu > button");
  if (mb) { const m = mb.parentElement, was = m.classList.contains("open"); closeMenus(); if (!was) { m.classList.add("open"); refreshMenuChecks(); } return; }
  if (!e.target.closest(".drop")) closeMenus();
});
document.addEventListener("mouseover", e => {
  const mb = e.target.closest(".menu > button"); if (!mb || !$(".menu.open")) return;
  if (!mb.parentElement.classList.contains("open")) { closeMenus(); mb.parentElement.classList.add("open"); refreshMenuChecks(); }
});
function runAccel(a) {
  if (a.action === "button") { const b = $$(".rc-btn").find(x => x.textContent.trim() === a.target); if (b) b.click(); else toast(`Taste „${a.target}“ nicht gefunden`, true); }
  else if (a.action === "band") { const b = WW.bands.find(x => x.name === a.target); if (b) setFreq(b.start); }
  else if (a.action === "mode") setMode(a.target);
  else if (a.action === "app") switchApp(a.target);
  else if (a.action === "ptt") act("/api/rig/ptt", { on: !WW.rig.ptt });
}

// ---------- Programmoptionen (F8) ----------
function openOptions(tab = "station") {
  const s = WW.settings, o = store.get("opts", {});
  const d = dialog({ title: "Programmoptionen", icon: "i-gear", wide: true, buttons: [["Abbrechen", "close"], ["Speichern", "save", "primary"]], body: `
    <div class="dtabs">${[["station", "Station"], ["cluster", "DX-Cluster"], ["online", "Online-Dienste"], ["wsjtx", "WSJT-X"], ["keys", "Tastenkürzel"], ["comms", "Kommunikation"], ["wheel", "Mausrad"], ["oob", "Außerband"], ["smeter", "S-Meter"], ["modes", "Betriebsarten"], ["winlink", "Winlink"], ["cw", "CW / WinKeyer"], ["links", "Programme & Sicherung"], ["theme", "Darstellung"]]
      .map(([k, l]) => `<button class="${k === tab ? "on" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
    <div class="dtab ${tab === "station" ? "" : "hidden"}" data-t="station"><div class="grid2">
      <label>Rufzeichen<input name="callsign" value="${esc(s.callsign)}"></label><label>Locator<input name="locator" value="${esc(s.locator)}"></label>
      <label>Operator (falls anders)<input name="operator" value="${esc(s.operator)}"></label><label>Standard-Leistung W<input name="tx_pwr" value="${esc(s.tx_pwr)}"></label>
      <label>Name (für Makros)<input name="opname" value="${esc(o.opname || "")}" data-local></label><label>QTH (für Makros)<input name="opqth" value="${esc(o.opqth || "")}" data-local></label></div></div>
    <div class="dtab ${tab === "cluster" ? "" : "hidden"}" data-t="cluster"><div class="grid2">
      <label>Host<input name="cluster_host" value="${esc(s.cluster_host)}"></label><label>Port<input name="cluster_port" type="number" value="${esc(s.cluster_port)}"></label>
      <label class="wide">Befehle nach Login (mit ; trennen)<input name="cluster_cmds" value="${esc(s.cluster_cmds)}" placeholder="SET/SKIMMER;SET/FT8"></label></div></div>
    <div class="dtab ${tab === "online" ? "" : "hidden"}" data-t="online"><div class="grid2">
      <label>HamQTH-Benutzer<input name="hamqth_user" value="${esc(s.hamqth_user)}"></label><label>HamQTH-Passwort<input name="hamqth_pass" type="password" value="${esc(s.hamqth_pass)}"></label>
      <label>QRZ.com-Benutzer (XML)<input name="qrz_user" value="${esc(s.qrz_user)}"></label><label>QRZ.com-Passwort<input name="qrz_pass" type="password" value="${esc(s.qrz_pass)}"></label>
      <label class="wide">QRZ-Logbuch API-Schlüssel<input name="qrz_logbook_key" type="password" value="${esc(s.qrz_logbook_key)}"></label>
      <label>eQSL-Benutzer<input name="eqsl_user" value="${esc(s.eqsl_user)}"></label><label>eQSL-Passwort<input name="eqsl_pass" type="password" value="${esc(s.eqsl_pass)}"></label>
      <label>LoTW-Benutzer<input name="lotw_user" value="${esc(s.lotw_user)}"></label><label>LoTW-Passwort<input name="lotw_pass" type="password" value="${esc(s.lotw_pass)}"></label>
      <label>TQSL-Stationsort<input name="lotw_location" value="${esc(s.lotw_location)}"></label><label>TQSL-Signierpasswort<input name="lotw_cert_pass" type="password" value="${esc(s.lotw_cert_pass)}"></label>
      <label>Club Log E-Mail<input name="clublog_email" value="${esc(s.clublog_email)}"></label><label>Club Log Passwort<input name="clublog_pass" type="password" value="${esc(s.clublog_pass)}"></label>
      <label class="wide">Club Log API-Schlüssel<input name="clublog_api" type="password" value="${esc(s.clublog_api)}"></label>
      ${[["callbook_auto", "Callbook beim Tippen und bei WSJT-X automatisch abfragen"], ["auto_qrz", "Neue QSOs sofort zu QRZ.com"], ["auto_eqsl", "Neue QSOs sofort zu eQSL"], ["auto_clublog", "Neue QSOs sofort zu Club Log"], ["eqsl_counts", "eQSL-Bestätigungen bei Diplomen zählen"]]
        .map(([k, l]) => `<label class="wide chkrow"><input type="checkbox" name="${k}" ${s[k] ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
    <div class="dtab ${tab === "wsjtx" ? "" : "hidden"}" data-t="wsjtx"><div class="grid2"><label>UDP-Port<input name="wsjtx_port" type="number" value="${esc(s.wsjtx_port)}"></label>
      <p class="hint wide">In WSJT-X/JTDX: Einstellungen → Reporting → UDP Server = Adresse dieses Rechners, Port wie hier. Geloggte QSOs kommen automatisch ins aktuelle Logbuch, Decodes erscheinen im Bereich „Alert“.</p></div></div>
    <div class="dtab ${tab === "keys" ? "" : "hidden"}" data-t="keys"><p class="hint">Eigene Tastenkürzel. F8, Strg+F8, F11 sind belegt.</p>
      <table class="mini"><thead><tr><th>Taste</th><th>Aktion</th><th>Ziel</th><th></th></tr></thead><tbody id="acc-rows"></tbody></table>
      <div class="ctl-row"><input id="acc-combo" placeholder="Taste drücken …" readonly style="width:140px"><select id="acc-act"><option value="button">Rig-Taste</option><option value="band">Band</option><option value="mode">Mode</option><option value="app">Programm</option><option value="ptt">PTT umschalten</option></select>
      <input id="acc-target" placeholder="z. B. NB, 20m, USB, logbook" style="width:180px"><button type="button" id="acc-add">Hinzufügen</button></div></div>
    <div class="dtab ${tab === "comms" ? "" : "hidden"}" data-t="comms"><div class="grid2">
      <label>Anzeige-Aktualisierung (ms)<input name="rig_poll_ms" type="number" min="100" max="2000" value="${s.rig_poll_ms || 250}"></label>
      <label class="wide chkrow"><input type="checkbox" name="rig_dualvfo" ${s.rig_dualvfo ? "checked" : ""}> Beide VFOs bei jeder Aktualisierung lesen (Satellitenbetrieb)</label>
      <p class="hint wide">PTT über DTR/RTS eines COM-Ports, Handshake und CI-V-Adresse stellst du je Funkgerät im Verbinden-Dialog ein.</p></div></div>
    <div class="dtab ${tab === "wheel" ? "" : "hidden"}" data-t="wheel"><div class="grid2">
      <label>Mausrad-Schritt auf den Abstimmleisten (Hz)<select name="o_wheel" data-local>${[1, 10, 50, 100, 250, 500, 1000, 5000].map(v => `<option ${+(o.wheel || 100) === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="wide chkrow"><input type="checkbox" name="o_single" ${o.single ? "checked" : ""} data-local> Favoriten-Ordner mit Einfachklick öffnen</label></div></div>
    <div class="dtab ${tab === "oob" ? "" : "hidden"}" data-t="oob"><div class="grid2">
      <label class="wide chkrow"><input type="checkbox" name="o_oob" ${o.oob ? "checked" : ""} data-local> Ton beim Verlassen und Betreten eines Amateurfunkbandes</label></div></div>
    <div class="dtab ${tab === "modes" ? "" : "hidden"}" data-t="modes"><div class="grid2">
      <label class="wide">Betriebsarten und RST-Vorgabe (eine Zeile je Mode: <code>MODE RST</code>)<textarea name="mode_rst" rows="14" spellcheck="false" style="font-family:monospace">${esc(s.mode_rst || MODE_RST_DEFAULT)}</textarea></label>
      <div class="ctl-row wide"><button type="button" class="mr-def">Standard wiederherstellen</button></div>
      <p class="hint wide">Die Liste erscheint als Auswahl im Feld „Mode“ des Logbuch-Eintrags. Beim Wechsel der Betriebsart werden „Gesendet“ und „Empfangen“ mit der Vorgabe gefüllt.</p></div></div>
    <div class="dtab ${tab === "winlink" ? "" : "hidden"}" data-t="winlink"><div class="grid2">
      <label>Winlink-Rufzeichen (leer = Stationsrufzeichen)<input name="wl_call" value="${esc(s.wl_call || "")}"></label><label>Winlink-Passwort<input name="wl_password" type="password" value="${esc(s.wl_password || "")}"></label>
      <label>Winlink-Server (Telnet)<input name="wl_telnet_host" value="${esc(s.wl_telnet_host || "server.winlink.org")}"></label><label>Port<input name="wl_telnet_port" type="number" value="${s.wl_telnet_port || 8772}"></label>
      <label>PTT bei ARDOP/VARA<select name="wl_ptt"><option value="rig" ${s.wl_ptt !== "none" ? "selected" : ""}>über das Funkgerät (CAT)</option><option value="none" ${s.wl_ptt === "none" ? "selected" : ""}>macht das Modem selbst / VOX</option></select></label><span></span>
      <label>ARDOP-Modem Host<input name="ardop_host" value="${esc(s.ardop_host || "127.0.0.1")}"></label><label>ARDOP Port (Daten = Port+1)<input name="ardop_port" type="number" value="${s.ardop_port || 8515}"></label>
      <label>ARDOP Bandbreite<select name="ardop_bw">${["200MAX", "500MAX", "1000MAX", "2000MAX", "200FORCED", "500FORCED", "1000FORCED", "2000FORCED"].map(v => `<option ${v === (s.ardop_bw || "2000MAX") ? "selected" : ""}>${v}</option>`).join("")}</select></label><span></span>
      <label>VARA-Modem Host<input name="vara_host" value="${esc(s.vara_host || "127.0.0.1")}"></label><label>VARA Port (Daten = Port+1)<input name="vara_port" type="number" value="${s.vara_port || 8300}"></label>
      <label>VARA Bandbreite (HF)<select name="vara_bw">${[["500", "500 Hz"], ["2300", "2300 Hz"], ["2750", "2750 Hz"], ["", "nicht setzen (VARA FM)"]].map(([v, l]) => `<option value="${v}" ${v === String(s.vara_bw ?? "2300") ? "selected" : ""}>${l}</option>`).join("")}</select></label><span></span>
      <label>Packet: AGW-Host (Direwolf)<input name="agw_host" value="${esc(s.agw_host || "127.0.0.1")}"></label><label>AGW-Port<input name="agw_port" type="number" value="${s.agw_port || 8000}"></label>
      <label>Funkkanal am Packet-Modem<input name="agw_radio_port" type="number" min="0" max="15" value="${s.agw_radio_port || 0}"></label><span></span>
      <p class="hint wide">ARDOP: das freie Modem <i>ardopcf</i> starten (z. B. <code>ardopcf 8515 Soundkarte Soundkarte</code>). Packet: <i>Direwolf</i> mit AGWPORT 8000. VARA ist ein eigenständiges Programm mit eigener Lizenz; Wellenwerk spricht nur seine TCP-Schnittstelle an. Wellenwerk tastet das Funkgerät, wenn das Modem PTT anfordert.</p></div></div>
    <div class="dtab ${tab === "cw" ? "" : "hidden"}" data-t="cw"><div class="grid2">
      <label>CW senden über<select name="cw_out"><option value="rig" ${s.cw_out !== "winkey" ? "selected" : ""}>Funkgerät (CAT, Hamlib send_morse)</option><option value="winkey" ${s.cw_out === "winkey" ? "selected" : ""}>K1EL WinKeyer</option></select></label>
      <label>WinKeyer-Port<select name="winkey_device" class="wk-dev"><option value="${esc(s.winkey_device || "")}">${esc(s.winkey_device || "– wählen –")}</option></select></label>
      <label>Tempo (WpM)<input name="winkey_wpm" type="number" min="5" max="99" value="${s.winkey_wpm || 22}"></label>
      <div class="ctl-row wide"><button type="button" class="wk-con">WinKeyer verbinden</button><button type="button" class="wk-dis">Trennen</button><span class="wk-st hint"></span></div>
      <p class="hint wide">Makros im Digitalbetrieb (Betriebsart CW) und der CW-Keyer gehen dann über den WinKeyer (wie gewohnt). Der WinKeyer tastet das Funkgerät über seine Key- und PTT-Leitung.</p></div></div>
    <div class="dtab ${tab === "links" ? "" : "hidden"}" data-t="links"><div class="grid2">
      <label class="wide">Neue QSOs weiterleiten an (UDP, host:port, mehrere mit Komma)<input name="fwd_targets" value="${esc(s.fwd_targets || "")}" placeholder="z. B. 127.0.0.1:2333, 192.168.1.20:12060"></label>
      <label>Format der Weiterleitung<select name="fwd_format">${[["adif", "ADIF-Text"], ["wsjtx", "WSJT-X „Logged ADIF“ (z. B. GridTracker, Log4OM)"], ["n1mm", "N1MM <contactinfo>"]].map(([k, l]) => `<option value="${k}" ${(s.fwd_format || "adif") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>N1MM Logger+ empfangen (UDP-Port, 0 = aus)<input name="n1mm_port" type="number" min="0" max="65535" value="${s.n1mm_port || 0}" placeholder="12060"></label>
      <label class="wide">WSJT-X/JTDX-Pakete weiterreichen an (host:port, mehrere mit Komma)<input name="wsjtx_forward" value="${esc(s.wsjtx_forward || "")}" placeholder="z. B. 127.0.0.1:2238 für GridTracker oder JTAlert"></label>
      <label class="wide">Automatische tägliche Sicherung in Ordner (z. B. Dropbox-, OneDrive- oder Google-Drive-Ordner)<input name="backup_dir" value="${esc(s.backup_dir || "")}" placeholder="leer = aus"></label>
      <label>Sicherungen behalten (Tage)<input name="backup_keep" type="number" min="1" max="3650" value="${s.backup_keep || 30}"></label>
      <p class="hint wide">N1MM: in N1MM unter <i>Config → WSJT/JTDX and Broadcast Data</i> „Contacts“ an diesen Rechner und Port senden. Weitergeleitet wird jedes neue QSO – auch aus WSJT-X und N1MM.</p></div></div>
    <div class="dtab ${tab === "smeter" ? "" : "hidden"}" data-t="smeter"><div class="grid2">
      <label>Versatz (dB)<input name="o_soff" type="number" value="${o.soff || 0}" data-local></label><label>Faktor<input name="o_sscale" type="number" step="0.05" value="${o.sscale || 1}" data-local></label>
      <p class="hint wide">Gleicht die S-Meter-Anzeige an das Gerät an. Angezeigt wird Faktor × Messwert + Versatz.</p></div></div>
    <div class="dtab ${tab === "theme" ? "" : "hidden"}" data-t="theme"><div class="grid2">
      <label>Fensterdesign<select name="o_chrome" data-local>${[["office", "Klassisch (hellblau)"], ["light", "Hell"], ["dark", "Dunkel"], ["night", "Nachtsicht (rot)"]].map(([k, l]) => `<option value="${k}" ${(o.chrome || "office") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <p class="hint wide">Farben der Funkgeräte-Anzeige stellst du unter „Layout anpassen“ (Strg+F8) ein.</p></div></div>
    <div class="err"></div>`, onOpen: dd => {
      tabsIn(dd);
      const acc = store.get("accel", []);
      const draw = () => { $("#acc-rows", dd).innerHTML = acc.map((a, i) => `<tr><td>${esc(a.combo)}</td><td>${esc(a.action)}</td><td>${esc(a.target || "")}</td><td><button type="button" data-del="${i}">×</button></td></tr>`).join("") || `<tr><td colspan="4" class="hint">keine</td></tr>`; };
      draw();
      $("#acc-combo", dd).addEventListener("keydown", e => { e.preventDefault(); if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) e.target.value = matchCombo(e); });
      $("#acc-add", dd).onclick = () => { const combo = $("#acc-combo", dd).value; if (!combo) return; acc.push({ combo, action: $("#acc-act", dd).value, target: $("#acc-target", dd).value.trim(), label: `${$("#acc-act", dd).selectedOptions[0].text} ${$("#acc-target", dd).value}` }); store.set("accel", acc); draw(); };
      $("#acc-rows", dd).onclick = e => { const b = e.target.closest("[data-del]"); if (b) { acc.splice(+b.dataset.del, 1); store.set("accel", acc); draw(); } };
    } });
  const wkSt = () => { const w = WW.winkey || {}; d.querySelector(".wk-st").textContent = w.connected ? `verbunden an ${w.device}${w.version ? ", Firmware " + w.version : ""}` : (w.error || "nicht verbunden"); };
  api("/api/hamlib/ports").then(ps => { const sel = d.querySelector(".wk-dev"), cur = sel.value; sel.innerHTML = `<option value="">– wählen –</option>` + ps.map(p => `<option value="${esc(p.device)}" ${p.device === cur ? "selected" : ""}>${esc(p.device)}${p.desc ? " – " + esc(p.desc) : ""}</option>`).join("") + (cur && !ps.some(p => p.device === cur) ? `<option selected>${esc(cur)}</option>` : ""); }).catch(() => { });
  d.querySelector(".mr-def").onclick = () => { d.querySelector('[name="mode_rst"]').value = MODE_RST_DEFAULT; };
  d.querySelector(".wk-con").onclick = async () => { try { WW.winkey = await post("/api/winkey/connect", { device: d.querySelector(".wk-dev").value, wpm: +d.querySelector('[name="winkey_wpm"]').value }); } catch (e) { WW.winkey = { error: e.message }; } wkSt(); };
  d.querySelector(".wk-dis").onclick = async () => { WW.winkey = await post("/api/winkey/disconnect", {}); wkSt(); };
  wkSt();
  d.querySelector('button[value="save"]').addEventListener("click", async e => {
    e.preventDefault();
    const body = {}, loc = store.get("opts", {});
    d.querySelectorAll("[name]").forEach(el => {
      const v = el.type === "checkbox" ? el.checked : el.value.trim();
      if (el.dataset.local !== undefined) loc[el.name.replace(/^o_/, "")] = el.type === "number" ? +v : v; else body[el.name] = v;
    });
    store.set("opts", loc); applyChrome();
    try { WW.settings = await api("/api/settings", { method: "PUT", body }); d.close(); toast("Optionen gespeichert"); WW.emit("settings"); renderStatus(); }
    catch (err) { d.querySelector(".err").textContent = err.message; }
  });
}
function applyChrome() { document.documentElement.dataset.chrome = store.get("opts", {}).chrome || "office"; }
