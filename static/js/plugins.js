"use strict";
// Wellenwerk – Erweiterungen (Oberflaechen-Teil). Eine Erweiterung meldet sich mit
//   Wellenwerk.register("meine-id", { start(ctx) { … }, stop() { … } })
// an; ctx bietet Stationsdaten, Ereignisse, API, eigene Fenster/Register/Menuepunkte und die eigenen Einstellungen.
const PLUGINS = { list: [], running: new Map(), defs: new Map(), menu: [] };
window.Wellenwerk = {
  get version() { return WW.version; },
  get lang() { return I18N.lang; }, t: s => I18N.t(s), addTranslations: (lang, dict) => { if (lang === I18N.lang) I18N.add(dict); },
  register(id, def) { PLUGINS.defs.set(id, def); const w = PLUGINS.waiting?.get(id); if (w) w(def); },
};
function pluginCtx(p) {
  const offs = [];
  const ctx = {
    id: p.id, manifest: p,
    get settings() { return (PLUGINS.list.find(x => x.id === p.id) || p).values || {}; },
    station: () => WW.station || {}, settings_program: () => WW.settings, rig: () => WW.rig,
    get lang() { return I18N.lang; }, locale: () => I18N.locale, t: s => I18N.t(s),
    on(ev, cb) { const off = WW.on(ev, cb); offs.push(off); return off; },
    api: (path, opts) => api(path.startsWith("/") ? path : `/api/plugins/${p.id}/${path}`, opts),
    post: (path, body) => post(path.startsWith("/") ? path : `/api/plugins/${p.id}/${path}`, body),
    toast, esc, icon, dialog,
    setFrequency: hz => post("/api/rig/freq", { hz }), setMode: (mode, passband = 0) => post("/api/rig/mode", { mode, passband }),
    logQso: rec => post("/api/qso", rec),
    storage: { get: (k, d) => store.get(`plugin.${p.id}.${k}`, d), set: (k, v) => store.set(`plugin.${p.id}.${k}`, v) },
    addPanel(app, key, def) { const pk = `p_${p.id}_${key}`; if (!APPS[app]) throw new Error("Register " + app + " gibt es nicht");
      APPS[app].panels[pk] = { title: def.title, create: root => def.create(root, ctx), dock: def.dock, size: def.size };
      PLUGINS.menu.push({ plugin: p.id, app, label: def.title, act: () => togglePanel(app, pk), check: () => panelOpen(app, pk) }); return pk; },
    openPanel(app, key) { addPanel(app, `p_${p.id}_${key}`); },
    addApp(key, def) { const ak = `p_${p.id}_${key}`; APPS[ak] = { title: def.title, icon: def.icon || "i-plug", panels: Object.fromEntries(Object.entries(def.panels || {}).map(([k, v]) => [k, { title: v.title, create: r => v.create(r, ctx) }])),
        layout: def.layout || (dv => { for (const k of Object.keys(def.panels || {})) dv.addPanel({ id: k, component: k, title: def.panels[k].title }); }),
        menus: [...(def.menus || []), MENU_WINDOW(ak), MENU_HELP], toolbar: def.toolbar || [] }; PLUGINS.newApps = true; return ak; },
    addMenuItem(label, act, app = "*") { PLUGINS.menu.push({ plugin: p.id, app, label, act }); },
  };
  ctx._offs = offs;
  return ctx;
}
async function loadPlugin(p) {
  if (PLUGINS.running.has(p.id) || !p.frontend) return;
  const def = PLUGINS.defs.get(p.id) || await new Promise((res, rej) => {
    (PLUGINS.waiting = PLUGINS.waiting || new Map()).set(p.id, res);
    const s = document.createElement("script"); s.src = `/plugins/${encodeURIComponent(p.id)}/${p.frontend}?v=${encodeURIComponent(p.version || "")}`;
    s.onerror = () => rej(new Error("Skript nicht ladbar")); document.head.appendChild(s);
    setTimeout(() => rej(new Error("hat sich nicht mit Wellenwerk.register angemeldet")), 5000);
  });
  const ctx = pluginCtx(p);
  try { await def.start?.(ctx); PLUGINS.running.set(p.id, { def, ctx }); }
  catch (e) { console.error("Erweiterung", p.id, e); toast(`Erweiterung „${p.name}“: ${e.message}`, true); }
}
function stopPlugin(id) { const r = PLUGINS.running.get(id); if (!r) return; try { r.def.stop?.(); } catch { } r.ctx._offs.forEach(f => f()); PLUGINS.running.delete(id);
  PLUGINS.menu = PLUGINS.menu.filter(m => m.plugin !== id); }
async function loadPlugins() {
  try { PLUGINS.list = await api("/api/plugins"); } catch { PLUGINS.list = []; return; }
  for (const p of PLUGINS.list.filter(x => x.enabled && x.frontend && !x.error)) await loadPlugin(p).catch(e => toast(`Erweiterung „${p.name}“: ${e.message}`, true));
}
function pluginMenu(appId) {
  const items = PLUGINS.menu.filter(m => m.app === "*" || m.app === appId).map(m => ({ label: m.label, act: m.act, check: m.check }));
  return { label: "Erweiterungen", items: [...items, ...(items.length ? ["-"] : []), { label: "Erweiterungen verwalten …", icon: "i-plug", act: () => openOptions("plugins") }] };
}
WW.on("plugins", async () => { const old = PLUGINS.list; PLUGINS.list = await api("/api/plugins").catch(() => old); WW.emit("plugins-changed"); });

// ---------- Programmoptionen → Erweiterungen ----------
function pluginOptions(root) {
  const draw = async () => {
    const list = await api("/api/plugins"), ex = await api("/api/plugins/examples").catch(() => []);
    const field = (p, s) => { const v = p.values?.[s.key] ?? s.default ?? "", n = `pl:${p.id}:${s.key}`;
      if (s.type === "bool") return `<label class="chkrow"><input type="checkbox" data-pl="${esc(n)}" ${v ? "checked" : ""}> ${esc(s.label || s.key)}</label>`;
      if (s.type === "select") return `<label>${esc(s.label || s.key)}<select data-pl="${esc(n)}">${(s.options || []).map(o => `<option ${String(o) === String(v) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
      return `<label>${esc(s.label || s.key)}<input data-pl="${esc(n)}" type="${s.type === "password" ? "password" : s.type === "number" ? "number" : "text"}" value="${esc(v)}"></label>`; };
    root.innerHTML = `<div class="pl-list">${list.map(p => `<fieldset class="pl-item" data-id="${esc(p.id)}"><legend><label class="chk"><input type="checkbox" class="pl-on" ${p.enabled ? "checked" : ""}> <b>${esc(p.name || p.id)}</b></label> <span class="hint">${esc(p.version || "")}${p.author ? " · " + esc(p.author) : ""}</span></legend>
        <div class="hint">${esc(p.description || "")}${p.backend ? " · mit Server-Teil" : ""}${p.frontend ? " · mit Oberfläche" : ""}</div>${p.error ? `<div class="err">${esc(p.error)}</div>` : ""}
        <div class="grid2">${(p.settings || []).map(s => field(p, s)).join("")}</div><div class="ctl-row"><i class="grow"></i><button type="button" class="pl-del danger">Entfernen</button></div></fieldset>`).join("") || `<p class="hint">Noch keine Erweiterungen installiert.</p>`}</div>
      <div class="ctl-row"><label class="btnlike">ZIP installieren …<input type="file" class="pl-zip hidden" accept=".zip"></label>${ex.map(e => `<button type="button" class="pl-ex" data-ex="${esc(e.id)}">Beispiel „${esc(e.name)}“ installieren</button>`).join("")}<a href="/static/hilfe.html?d=plugins" target="_blank" class="hint">Anleitung für Entwickler</a></div>
      <p class="hint">Erweiterungen laufen mit denselben Rechten wie Wellenwerk (Funkgerät, Logbuch, Dateien). Nur aus vertrauenswürdiger Quelle installieren.</p>`;
  };
  root.addEventListener("change", async e => {
    const it = e.target.closest(".pl-item");
    if (e.target.classList.contains("pl-on")) { const on = e.target.checked;
      if (on && !confirm("Erweiterung einschalten? Sie läuft mit denselben Rechten wie Wellenwerk.")) { e.target.checked = false; return; }
      const r = await api(`/api/plugins/${it.dataset.id}`, { method: "PUT", body: { enabled: on } }); PLUGINS.list = r.plugins;
      const p = r.plugins.find(x => x.id === it.dataset.id); if (on) await loadPlugin(p).catch(err => toast(err.message, true)); else stopPlugin(p.id);
      if (r.restart) toast("Der Server-Teil wird beim nächsten Programmstart ausgeschaltet"); if (APPS[SHELL.active]) renderMenus(APPS[SHELL.active]); draw(); }
    if (e.target.classList.contains("pl-zip") && e.target.files[0]) { const fd = new FormData(); fd.append("file", e.target.files[0]);
      const r = await fetch("/api/plugins/install", { method: "POST", body: fd }); const j = await r.json(); toast(r.ok ? `„${j.id}“ installiert – zum Benutzen einschalten` : j.detail, !r.ok); draw(); } });
  root.addEventListener("click", async e => {
    if (e.target.classList.contains("pl-del")) { const id = e.target.closest(".pl-item").dataset.id; if (!confirm(`Erweiterung „${id}“ entfernen?`)) return; stopPlugin(id); await api(`/api/plugins/${id}`, { method: "DELETE" }); draw(); }
    if (e.target.classList.contains("pl-ex")) { await post(`/api/plugins/examples/${e.target.dataset.ex}`); toast("Beispiel installiert – zum Benutzen einschalten"); draw(); } });
  draw();
}
async function savePluginSettings(root) {   // beim Speichern der Programmoptionen
  const by = {};
  root.querySelectorAll("[data-pl]").forEach(el => { const [, id, key] = el.dataset.pl.split(":"); (by[id] = by[id] || {})[key] = el.type === "checkbox" ? el.checked : el.value; });
  for (const [id, settings] of Object.entries(by)) await api(`/api/plugins/${id}`, { method: "PUT", body: { settings } });
  if (Object.keys(by).length) { PLUGINS.list = await api("/api/plugins"); WW.emit("plugin-settings"); }
}
