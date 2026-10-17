"use strict";
// Wellenwerk – Logbuch: Logbuch oben mit Rufzeichen-Info rechts, darunter Cluster, Bandkarte und Graulinie,
// Bandkarte, Graulinie, Uhr und Rotor rechts. Eingabe ueber "Neuer Eintrag".
const LOG_COLS = [["qso_date", "Datum"], ["time_on", "Beginn"], ["time_off", "Ende"], ["call", "Rufzeichen"], ["mode", "Mode"], ["submode", "Submode"], ["rst_sent", "Ges."], ["rst_rcvd", "Empf."],
  ["band", "Band"], ["freq", "Freq"], ["name", "Name"], ["qth", "QTH"], ["gridsquare", "Locator"], ["country", "Land"], ["cont", "Kont."], ["cqz", "CQ"], ["ituz", "ITU"], ["state", "Staat"], ["cnty", "County"],
  ["iota", "IOTA"], ["darc_dok", "DOK"], ["tx_pwr", "Leistung"], ["comment", "Bemerkung"], ["qsl_sent", "QSL ges."], ["qsl_rcvd", "QSL empf."], ["qsl_via", "QSL via"], ["lotw_qsl_sent", "LoTW ges."], ["lotw_qsl_rcvd", "LoTW empf."],
  ["eqsl_qsl_sent", "eQSL ges."], ["eqsl_qsl_rcvd", "eQSL empf."], ["qrzcom_qso_upload_status", "QRZ"], ["clublog_qso_upload_status", "Club Log"], ["contest_id", "Contest"], ["stx_string", "Nr. ges."], ["srx_string", "Nr. empf."], ["operator", "Operator"], ["my_gridsquare", "Mein Loc."], ["pota_ref", "POTA"], ["my_pota_ref", "Mein POTA"], ["sota_ref", "SOTA"], ["my_sota_ref", "Mein SOTA"], ["wwff_ref", "WWFF"], ["my_wwff_ref", "Mein WWFF"], ["sig", "SIG"], ["sig_info", "SIG-Info"]];
const LOG_LESS = ["submode", "qth", "lotw_qsl_sent", "eqsl_qsl_sent", "qrzcom_qso_upload_status", "clublog_qso_upload_status", "eqsl_qsl_rcvd", "time_off", "cnty", "state"];   // fallen in schmalen Logbuechern weg
const LOG_MORE = [["freq", "band"], ["gridsquare", "qth"], ["cont", "country"], ["cqz", "cont"], ["comment", null]];                                       // kommen in breiten Logbuechern dazu (nach Spalte)
function logVisCols(cols, det) {
  if (det === "s") return cols.filter(k => !LOG_LESS.includes(k));
  if (det !== "l") return cols;
  const c = [...cols]; for (const [k, after] of LOG_MORE) { if (c.includes(k)) continue; const i = after ? c.indexOf(after) : -1; i >= 0 ? c.splice(i + 1, 0, k) : c.push(k); }
  return c;
}
const LOG_DEFAULT_COLS = ["qso_date", "time_on", "call", "mode", "submode", "rst_sent", "rst_rcvd", "band", "name", "qth", "country", "lotw_qsl_sent", "lotw_qsl_rcvd", "eqsl_qsl_rcvd", "clublog_qso_upload_status"];
const LOGB = { sel: new Set(), clip: null, filter: {}, sort: store.get("log.sort", ["qso_date", -1]), contest: false, serial: store.get("log.serial", 1) };
const fmtCell = (k, v) => k === "qso_date" ? fmtDate(v) : (k === "time_on" || k === "time_off") ? fmtTimeS(v) : v ?? "";

// ---------- Logbuch-Tabelle ----------
function createLogbook(root, params) {
  const name = params.name || WW.logbook;
  root.innerHTML = `<div class="lb-tb">
    <button data-a="add" title="Neuer Eintrag">${icon("i-plus")}<span>Neu</span></button><button data-a="edit">${icon("i-edit")}<span>Bearbeiten</span></button><button data-a="delete">${icon("i-x")}<span>Löschen</span></button><i class="sep"></i>
    <button data-a="find">${icon("i-search")}<span>Suchen</span></button><button data-a="filter">${icon("i-filter")}<span>Filter</span></button><button data-a="cols">${icon("i-list")}<span>Spalten</span></button><button data-a="bulk">${icon("i-edit")}<span>Auswahl ändern</span></button><i class="sep"></i>
    <button data-a="qsl">${icon("i-cloud")}<span>QSL</span></button><button data-a="lotwup">${icon("i-upload")}<span>LoTW hoch</span></button><button data-a="lotwdown">${icon("i-download")}<span>LoTW holen</span></button><i class="sep"></i>
    <button data-a="contest" title="Contest-Modus: laufende Nummer">${icon("i-trophy")}<span>Contest</span></button><button data-a="awards">${icon("i-award")}<span>Diplome</span></button><button data-a="more">${icon("i-more")}<span>Mehr …</span></button>
    <span class="hidden"><button data-a="cut"></button><button data-a="copy"></button><button data-a="paste"></button><button data-a="refresh"></button><button data-a="width"></button><button data-a="qrz"></button><button data-a="backup"></button></span></div>
    <div class="lb-find hidden"><input class="lb-q" placeholder="Suchen: Rufzeichen, Land, Name, Locator, DOK …"><button class="lb-clear" title="Filter zurücksetzen">×</button><select class="lb-band"><option value="">Band</option>${WW.bands.map(b => `<option>${b.name}</option>`).join("")}</select>
      <select class="lb-mode"><option value="">Mode</option>${Object.keys(modeTable()).map(m => `<option>${esc(m)}</option>`).join("")}</select>
      <select class="lb-qsl"><option value="">alle QSOs</option><option value="confirmed">bestätigt</option><option value="unconfirmed">unbestätigt</option><option value="lotw">LoTW bestätigt</option><option value="eqsl">eQSL bestätigt</option><option value="paper">Papier-QSL erhalten</option><option value="queued">QSL vorgemerkt</option><option value="to_send">QSL nicht gesendet</option><option value="no_qrz">nicht bei QRZ</option><option value="no_lotw">nicht bei LoTW</option><option value="no_eqsl">nicht bei eQSL</option><option value="no_clublog">nicht bei Club Log</option></select>
      <input type="date" class="lb-from"><input type="date" class="lb-to"><input class="lb-cond" placeholder="Bedingung, z. B. cqz=14; iota nicht leer" title="Feld-Bedingungen mit ; trennen. Vergleich: = != < > <= >=, ~ enthält, !~ enthält nicht, „leer“, „nicht leer“. Felder: call, band, mode, country, cqz, ituz, dxcc, state, cnty, iota, darc_dok, comment, qso_date (JJJJMMTT) …">
      <select class="lb-view" title="Gespeicherte Ansichten (Filter, Spalten, Sortierung)"></select></div>
    <div class="tablewrap lb-wrap"><table class="grid lb-grid"><thead></thead><tbody translate="no"></tbody></table></div>
    <div class="lb-foot"><span class="lb-info"></span><i class="grow"></i><span>${esc(name)}</span><span>SQLite</span><span class="lb-count"></span><span class="lb-selc"></span></div>`;
  fitBar($(".lb-tb", root));
  const cols = () => store.get("log.cols", LOG_DEFAULT_COLS);
  const q = () => { const p = new URLSearchParams({ log: name, limit: 2000, q: $(".lb-q", root).value.trim(), band: $(".lb-band", root).value, mode: $(".lb-mode", root).value, qsl: $(".lb-qsl", root).value, date_from: $(".lb-from", root).value, date_to: $(".lb-to", root).value, cond: $(".lb-cond", root).value.trim() }); return p; };
  const VF = ["q", "band", "mode", "qsl", "from", "to", "cond"];
  const views = () => { const v = store.get("log.views", []), sel = $(".lb-view", root);
    sel.innerHTML = `<option value="">Ansicht …</option>${v.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join("")}<option value="save">Aktuelle Ansicht speichern …</option>${v.length ? `<option value="del">Ansicht löschen …</option>` : ""}`; };
  const applyView = x => { for (const k of VF) $(".lb-" + k, root).value = x.f?.[k] ?? ""; if (x.cols) { store.set("log.cols", x.cols); } if (x.sort) { LOGB.sort = x.sort; store.set("log.sort", x.sort); } $(".lb-find", root).classList.remove("hidden"); load(); };
  $(".lb-view", root).addEventListener("change", e => { e.stopPropagation(); const v = store.get("log.views", []), val = e.target.value; e.target.value = "";
    if (val === "save") { const n = prompt("Name der Ansicht (Filter, Spalten und Sortierung werden gespeichert):"); if (!n) return;
      const f = Object.fromEntries(VF.map(k => [k, $(".lb-" + k, root).value])), i = v.findIndex(x => x.name === n.trim()), rec = { name: n.trim(), f, cols: cols(), sort: LOGB.sort };
      if (i >= 0) v[i] = rec; else v.push(rec); store.set("log.views", v); WW.emit("log-views"); toast(`Ansicht „${rec.name}“ gespeichert`); }
    else if (val === "del") { const n = prompt("Welche Ansicht löschen? Name:\n" + v.map(x => x.name).join("\n")); const i = v.findIndex(x => x.name === (n || "").trim()); if (i < 0) return; v.splice(i, 1); store.set("log.views", v); WW.emit("log-views"); }
    else if (val !== "") applyView(v[+val]); });
  views();
  let rows = [];
  const load = async () => {
    let r; try { r = await api("/api/qso?" + q()); $(".lb-cond", root).classList.remove("bad"); } catch (err) { $(".lb-cond", root).classList.add("bad"); $(".lb-info", root).textContent = err.message; return; }
    $(".lb-info", root).textContent = ""; rows = r.qsos;
    const [sk, sd] = LOGB.sort; rows.sort((a, b) => { const x = sk === "qso_date" ? (a.qso_date + a.time_on) : a[sk] ?? "", y = sk === "qso_date" ? (b.qso_date + b.time_on) : b[sk] ?? ""; return (x > y ? 1 : x < y ? -1 : 0) * sd; });
    const C = logVisCols(cols(), root.dataset.det), wid = store.get("log.widths", {});
    $("thead", root).innerHTML = `<tr><th class="rh"></th>${C.map(k => `<th data-k="${k}" style="${wid[k] ? `width:${wid[k]}px` : ""}">${esc((LOG_COLS.find(c => c[0] === k) || [k, k])[1])}${sk === k ? (sd > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
    $("tbody", root).innerHTML = rows.map(x => `<tr data-id="${x.id}" class="${LOGB.sel.has(x.id) ? "sel" : ""}"><td class="rh">${LOGB.sel.has(x.id) ? "›" : ""}</td>${C.map(k => `<td class="c-${k}">${esc(fmtCell(k, x[k]))}</td>`).join("")}</tr>`).join("")
      || `<tr><td colspan="${C.length + 1}" class="hint">Keine QSOs${[...q().values()].slice(3).some(Boolean) ? " für diesen Filter" : ""}.</td></tr>`;
    $(".lb-count", root).textContent = r.total; $(".lb-selc", root).textContent = LOGB.sel.size ? `${LOGB.sel.size} ausgewählt` : "";
  };
  root.addEventListener("click", async e => {
    const th = e.target.closest("th[data-k]"); if (th) { LOGB.sort = [th.dataset.k, LOGB.sort[0] === th.dataset.k ? -LOGB.sort[1] : 1]; store.set("log.sort", LOGB.sort); load(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { const id = +tr.dataset.id;
      if (e.shiftKey && LOGB.last) { const ids = rows.map(r => r.id), a = ids.indexOf(LOGB.last), b = ids.indexOf(id); ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(i => LOGB.sel.add(i)); }
      else if (e.ctrlKey || e.metaKey) LOGB.sel.has(id) ? LOGB.sel.delete(id) : LOGB.sel.add(id);
      else { LOGB.sel.clear(); LOGB.sel.add(id); }
      LOGB.last = id; WW.logbook = name; load(); WW.emit("log-select", rows.find(r => r.id === id)); return; }
    const b = e.target.closest(".lb-tb button"); if (!b) return;
    const ids = [...LOGB.sel], a = b.dataset.a;
    WW.logbook = name;
    if (a === "add") openAle();
    else if (a === "contest") { LOGB.contest = !LOGB.contest; b.classList.toggle("on", LOGB.contest); toast(LOGB.contest ? `Contest-Modus: nächste Nr. ${String(LOGB.serial).padStart(3, "0")}` : "Contest-Modus aus"); WW.emit("contest"); }
    else if (a === "delete") { if (!ids.length) return toast("Erst QSOs auswählen", true); if (!confirm(`${ids.length} QSO(s) löschen?`)) return; await post("/api/qso/bulk?" + logq(), { ids, action: "delete" }); LOGB.sel.clear(); load(); }
    else if (a === "edit") { const r = rows.find(x => x.id === ids[0]); if (!r) return toast("Erst ein QSO auswählen", true); openAle(r); }
    else if (a === "cut" || a === "copy") { if (!ids.length) return toast("Erst QSOs auswählen", true); LOGB.clip = { ids, source: name, move: a === "cut" }; toast(`${ids.length} QSO(s) ${a === "cut" ? "ausgeschnitten" : "kopiert"} – im Ziel-Logbuch „Einfügen“`); }
    else if (a === "paste") { if (!LOGB.clip) return toast("Nichts in der Zwischenablage", true); if (LOGB.clip.source === name && !LOGB.clip.move) return toast("Zum Duplizieren ein anderes Logbuch öffnen", true);
      const r = await post("/api/qso/transfer", { ...LOGB.clip, target: name }); toast(`${r.copied} QSO(s) eingefügt`); LOGB.clip = null; WW.emit("reload"); }
    else if (a === "refresh") load();
    else if (a === "width") { const w = {}; $$("thead th[data-k]", root).forEach(t => w[t.dataset.k] = null); store.set("log.widths", {}); load(); toast("Spaltenbreiten an Inhalt angepasst"); }
    else if (a === "cols") columnsDialog(load);
    else if (a === "bulk") bulkEdit(ids, load);
    else if (a === "find") $(".lb-find", root).classList.toggle("hidden");
    else if (a === "filter") { $(".lb-find", root).classList.remove("hidden"); $(".lb-qsl", root).focus(); }
    else if (a === "qrz") { const r = rows.find(x => x.id === ids[0]); if (r) window.open(`https://www.qrz.com/db/${encodeURIComponent(r.call)}`, "_blank"); else toast("Erst ein QSO auswählen", true); }
    else if (a === "backup") { const r = await post("/api/logbooks/backup", { name }); toast(`Gesichert: ${r.file}`); }
    else if (a === "awards") addPanel("log", "awards");
    else if (a === "qsl") addPanel("log", "qsl");
    else if (a === "more") { const run = k => $(`.lb-tb [data-a="${k}"]`, root).click(); popupMenu(b, [{ label: "Ausschneiden (in anderes Logbuch)", act: () => run("cut") }, { label: "Kopieren (in anderes Logbuch)", act: () => run("copy") }, { label: "Einfügen", act: () => run("paste") },
      { label: "Neu laden", act: () => run("refresh") }, { label: "Spaltenbreiten an Inhalt anpassen", act: () => run("width") }, { label: "Auf QRZ.com ansehen", act: () => run("qrz") }, { label: "Sicherung jetzt", act: () => run("backup") }, { label: "ADIF importieren …", act: () => adifImport(name) }, { label: "ADIF exportieren (Filter)", act: () => location.href = `/api/adif?log=${encodeURIComponent(name)}` },
      { label: "Cabrillo-Export …", act: cabrilloDialog }, { label: "Logbuch drucken (Filter)", act: () => window.open(`/print/log?${q()}`, "_blank") },
      { label: "QSL-Etiketten drucken (Auswahl)", act: () => { if (!ids.length) return toast("Erst QSOs auswählen", true); const sk = prompt("Wie viele Etiketten oben auf dem Bogen sind schon verbraucht?", "0"); if (sk !== null) window.open(`/print/labels?log=${encodeURIComponent(name)}&ids=${ids.join(",")}&skip=${+sk || 0}`, "_blank"); } },
      { label: "QSL gesendet markieren (Auswahl)", act: () => bulkAct(ids, "qsl_sent", load) }, { label: "QSL vormerken (Auswahl)", act: () => bulkAct(ids, "qsl_queue", load) }, { label: "QSL erhalten (Auswahl)", act: () => bulkAct(ids, "qsl_rcvd", load) },
      { label: "→ QRZ.com hochladen (Auswahl/alle neuen)", act: () => upload("qrz", ids) }, { label: "→ eQSL hochladen", act: () => upload("eqsl", ids) }, { label: "→ Club Log hochladen", act: () => upload("clublog", ids) },
      { label: "Callbook für Auswahl abfragen (leere Felder füllen)", act: async () => { if (!ids.length) return toast("Erst QSOs auswählen", true); toast(`Callbook-Abfrage für ${Math.min(ids.length, 300)} QSOs läuft …`); try { const r = await post("/api/qso/bulk?" + logq(), { ids, action: "callbook" }); toast(`${r.changed} QSOs ergänzt`); load(); } catch (err) { toast(err.message, true); } } },
      { label: "Adressetiketten drucken (Auswahl)", act: () => { if (!ids.length) return toast("Erst QSOs auswählen", true); window.open(`/print/address?log=${encodeURIComponent(name)}&ids=${ids.join(",")}`, "_blank"); } },
      { label: "Google-Earth-Datei (KML) exportieren", act: () => location.href = `/api/kml?log=${encodeURIComponent(name)}${ids.length ? "&ids=" + ids.join(",") : ""}` },
      { label: "Datenbank prüfen und optimieren", act: async () => { try { const r = await post("/api/logbooks/check", { name }); toast(r.ok ? "Datenbank in Ordnung (geprüft und optimiert)" : "Datenbank-Fehler: " + r.result.join("; "), !r.ok); } catch (err) { toast(err.message, true); } } },
      { label: "Logbuch-Verwaltung …", act: logbookManager }, { label: "Sicherungen …", act: backupsDialog }, { label: "Statistik", act: () => addPanel("log", "stats") }]); }
    else if (a === "lotwup") upload("lotw", ids);
    else if (a === "lotwdown") { toast("LoTW-Abgleich läuft …"); try { const r = await post("/api/sync/confirmations?" + logq(), { service: "lotw" }); toast(`LoTW: ${r.received} empfangen, ${r.matched} zugeordnet`); load(); } catch (err) { toast(err.message, true); } }
  });
  root.addEventListener("dblclick", e => { const tr = e.target.closest("tr[data-id]"); if (tr) openAle(rows.find(r => r.id === +tr.dataset.id)); });
  root.addEventListener("input", e => { if (e.target.classList.contains("lb-q") || e.target.classList.contains("lb-cond")) { clearTimeout(root._t); root._t = setTimeout(load, 250); } });
  root.addEventListener("change", e => { if (e.target.closest(".lb-find")) load(); });
  $(".lb-clear", root).onclick = () => { $$(".lb-find input, .lb-find select", root).forEach(i => i.value = ""); load(); };
  // Spaltenbreite per Ziehen am Kopf
  root.addEventListener("mousedown", e => { const th = e.target.closest("th[data-k]"); if (e.button !== 0 || !th || e.offsetX < th.clientWidth - 6) return; e.preventDefault();
    const x0 = e.clientX, w0 = th.offsetWidth, mv = ev => th.style.width = Math.max(30, w0 + ev.clientX - x0) + "px",
      up = () => { const w = store.get("log.widths", {}); w[th.dataset.k] = th.offsetWidth; store.set("log.widths", w); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
  const offs = [WW.on("qso", load), WW.on("reload", load), WW.on("log-cols", load), WW.on("log-views", views),
    detailTier(root, root, w => w < 1000 ? "s" : w >= 1500 ? "l" : "m", load)]; load();   // Spalten je nach Breite: schmal weniger, breit mehr
  return () => offs.forEach(f => f());
}
async function bulkAct(ids, action, cb) { if (!ids.length) return toast("Erst QSOs auswählen", true); const r = await post("/api/qso/bulk?" + logq(), { ids, action }); toast(`${r.changed} geändert`); cb && cb(); }
async function upload(svc, ids) {
  if (!ids.length && !confirm(`Keine Auswahl – alle noch nicht hochgeladenen QSOs zu ${svc} senden?`)) return;
  toast(`Upload zu ${svc} läuft …`);
  try { const r = await post("/api/upload?" + logq(), { service: svc, ids: ids.length ? ids : null }); toast(`${svc}: ${r.uploaded}/${r.total} hochgeladen${r.errors.length ? " – " + r.errors[0] : ""}`, r.errors.length > 0); WW.emit("reload"); }
  catch (e) { toast(e.message, true); }
}
function columnsDialog(cb) {
  const cur = store.get("log.cols", LOG_DEFAULT_COLS);
  const d = dialog({ title: "Spalten-Layout", icon: "i-list", buttons: [["Abbrechen", "close"], ["Standard", "def"], ["OK", "ok", "primary"]], body: `<p class="hint">Haken = sichtbar. Reihenfolge per Ziehen.</p>
    <div class="cols-list">${[...cur, ...LOG_COLS.map(c => c[0]).filter(k => !cur.includes(k))].map(k => `<label class="chkrow" draggable="true" data-k="${k}"><input type="checkbox" ${cur.includes(k) ? "checked" : ""}> ${esc((LOG_COLS.find(c => c[0] === k) || [k, k])[1])}</label>`).join("")}</div>` });
  const list = $(".cols-list", d); let drag;
  list.addEventListener("dragstart", e => drag = e.target.closest("[data-k]")); list.addEventListener("dragover", e => { e.preventDefault(); const t = e.target.closest("[data-k]"); if (t && drag && t !== drag) list.insertBefore(drag, t); });
  d.querySelector('[value="def"]').onclick = e => { e.preventDefault(); store.set("log.cols", LOG_DEFAULT_COLS); d.close(); WW.emit("log-cols"); };
  d.querySelector('[value="ok"]').onclick = e => { e.preventDefault(); store.set("log.cols", [...list.querySelectorAll("[data-k]")].filter(l => l.querySelector("input").checked).map(l => l.dataset.k)); d.close(); WW.emit("log-cols"); };
}
function bulkEdit(ids, cb) {
  if (!ids.length) return toast("Erst QSOs auswählen", true);
  const d = dialog({ title: `Auswahl ändern (${ids.length} QSOs)`, icon: "i-edit", buttons: [["Abbrechen", "close"], ["Ändern", "ok", "primary"]], body: `<div class="grid2"><label>Feld<select id="be-f">${LOG_COLS.filter(c => !["qso_date", "time_on", "call"].includes(c[0])).map(c => `<option value="${c[0]}">${esc(c[1])}</option>`).join("")}</select></label><label>Neuer Wert<input id="be-v"></label></div>` });
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault(); let n = 0; for (const id of ids) { await api(`/api/qso/${id}?${logq()}`, { method: "PUT", body: { [$("#be-f", d).value]: $("#be-v", d).value } }); n++; } toast(`${n} QSOs geändert`); d.close(); cb && cb(); };
}
function adifImport(name) {
  const i = h(`<input type="file" accept=".adi,.adif,.txt">`); i.onchange = async () => { const fd = new FormData(); fd.append("file", i.files[0]);
    try { const r = await api(`/api/adif?log=${encodeURIComponent(name)}`, { method: "POST", body: fd }); toast(`ADIF: ${r.added} neu, ${r.duplicates} doppelt${r.errors ? `, ${r.errors} Fehler` : ""}`); WW.emit("reload"); } catch (e) { toast(e.message, true); } }; i.click();
}
function cabrilloDialog() {
  const t = new Date().toISOString().slice(0, 10);
  const d = dialog({ title: "Cabrillo-Export", buttons: [["Abbrechen", "close"], ["Exportieren", "ok", "primary"]], body: `<div class="grid2"><label class="wide">Contest (z. B. CQ-WW-SSB)<input id="cb-c"></label><label>Von<input type="date" id="cb-f" value="${t}"></label><label>Bis<input type="date" id="cb-t" value="${t}"></label><label class="wide">Kategorie<input id="cb-k" value="SINGLE-OP ALL HIGH"></label></div>` });
  d.querySelector('[value="ok"]').onclick = e => { e.preventDefault(); location.href = `/api/cabrillo?${logq(new URLSearchParams({ contest: $("#cb-c", d).value, date_from: $("#cb-f", d).value, date_to: $("#cb-t", d).value, category: $("#cb-k", d).value }).toString())}`; d.close(); };
}
async function logbookManager() {
  await loadLogbooks();
  const d = dialog({ title: "Logbücher", icon: "i-book", buttons: [["Schließen", "close"]], body: `<table class="grid"><thead><tr><th>Logbuch</th><th>QSOs</th><th></th></tr></thead><tbody>${WW.logbooks.map(l => `<tr><td><b>${esc(l.name)}</b>${l.name === WW.logbook ? " (aktiv)" : ""}</td><td>${l.qsos}</td>
    <td class="nowrap"><button type="button" data-open="${esc(l.name)}">Öffnen</button><button type="button" data-ren="${esc(l.name)}">Umbenennen</button><button type="button" data-bak="${esc(l.name)}">Sichern</button><button type="button" class="danger" data-del="${esc(l.name)}">Löschen</button></td></tr>`).join("")}</tbody></table>
    <div class="ctl-row"><input id="lm-new" placeholder="Name des neuen Logbuchs"><button type="button" id="lm-add" class="primary">Neues Logbuch</button></div>` });
  d.addEventListener("click", async e => { const b = e.target.closest("button"); if (!b) return;
    try { if (b.id === "lm-add") { const r = await post("/api/logbooks", { name: $("#lm-new", d).value }); openLogbookTab(r.name); }
      if (b.dataset.open) { openLogbookTab(b.dataset.open); d.close(); return; }
      if (b.dataset.ren) { const n = prompt("Neuer Name:", b.dataset.ren); if (n) await post("/api/logbooks/rename", { old: b.dataset.ren, new: n }); }
      if (b.dataset.bak) { const r = await post("/api/logbooks/backup", { name: b.dataset.bak }); toast("Gesichert: " + r.file); }
      if (b.dataset.del && confirm(`Logbuch „${b.dataset.del}“ löschen? (Vorher wird automatisch gesichert.)`)) await api(`/api/logbooks/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
      d.close(); logbookManager(); } catch (err) { toast(err.message, true); } });
}
async function backupsDialog() {
  const bs = await api("/api/backups");
  const d = dialog({ title: "Sicherungen", icon: "i-save", buttons: [["Schließen", "close"]], body: `<table class="grid"><thead><tr><th>Datei</th><th>Zeit</th><th>Größe</th><th></th></tr></thead><tbody>${bs.map(b => `<tr><td>${esc(b.file)}</td><td>${esc(b.time)}</td><td>${(b.size / 1024).toFixed(0)} kB</td>
    <td class="nowrap"><a class="btn" href="/api/backups/${encodeURIComponent(b.file)}">Herunterladen</a><button type="button" data-res="${esc(b.file)}">Als Logbuch wiederherstellen</button></td></tr>`).join("") || '<tr><td colspan="4" class="hint">keine Sicherungen</td></tr>'}</tbody></table>` });
  d.addEventListener("click", async e => { const b = e.target.closest("[data-res]"); if (!b) return; const n = prompt("Name des wiederhergestellten Logbuchs:", b.dataset.res.replace(/\.sqlite$/, ""));
    if (n) try { const r = await post("/api/backups/restore", { file: b.dataset.res, name: n }); toast("Wiederhergestellt: " + r.name); openLogbookTab(r.name); d.close(); } catch (err) { toast(err.message, true); } });
}
function openLogbookTab(name) { WW.logbook = name; addPanel("log", "logbook", { id: "logbook:" + name, title: name, params: { name }, position: SHELL.dv.log.getPanel("logbook:" + WW.logbooks[0]?.name) ? { referencePanel: SHELL.dv.log.panels.find(p => p.id.startsWith("logbook:")).id, direction: "within" } : undefined }); }

// ---------- Neuer Eintrag (ALE) ----------
const ALE = { editing: null, dirty: new Set(), seq: 0, start: null };
function openAle(q) {
  const ex = SHELL.dv.log?.getPanel("ale");
  if (!ex) addPanel("log", "ale", { floating: { width: 820, height: 430, x: 120, y: 90 } }); else ex.api.setActive();
  setTimeout(() => WW.emit("ale-open", q || null), 50);
}
function createAle(root) {
  const F = id => $("#ale-" + id, root);
  root.innerHTML = `<form class="ale2" autocomplete="off">
    <div class="ale-top"><label class="big">Rufzeichen<input id="ale-call" spellcheck="false"></label>
      <div class="ale-info"><span class="ale-state">Neuer Eintrag</span><span class="ale-dx"></span><span class="ale-cb"></span></div></div>
    <div class="ale-grid">
      <label>Datum (UTC)<input id="ale-date" type="date"></label><label>Beginn (UTC)<span class="with-check"><input id="ale-ton" type="time" step="1"><button type="button" id="ale-startb" title="Beginn jetzt">▶</button></span></label>
      <label>Ende (UTC)<span class="with-check"><input id="ale-toff" type="time" step="1"><button type="button" id="ale-stopb" title="Ende jetzt">■</button></span></label><label class="chkrow"><input type="checkbox" id="ale-live" checked> Zeit läuft mit</label>
      <label>Frequenz MHz<input id="ale-freq"></label><label>Band<input id="ale-band"></label><label>Mode<input id="ale-mode" list="ale-modes"></label><label>Submode<input id="ale-sub"></label>
      <label>RST gesendet<input id="ale-rsts"></label><label>RST empfangen<input id="ale-rstr"></label><label>Leistung W<input id="ale-pwr"></label><label class="chkrow"><input type="checkbox" id="ale-lock"> Freq/Mode festhalten</label>
      <label>Name<input id="ale-name"></label><label>QTH<input id="ale-qth"></label><label>Locator<input id="ale-grid"></label><label>Land<input id="ale-country" readonly></label>
    </div>
    <div class="dtabs"><button class="on" data-t="note">Bemerkung</button><button data-t="qsl">QSL</button><button data-t="awards">Diplome</button><button data-t="prg">Park/Gipfel</button><button data-t="contest">Contest</button><button data-t="station">Station</button></div>
    <div class="dtab" data-t="note"><label class="wide">Bemerkung<input id="ale-comment"></label></div>
    <div class="dtab hidden" data-t="qsl"><div class="ale-grid"><label>QSL gesendet<select id="ale-qsls"><option value="">–</option><option value="N">nein</option><option value="Q">vormerken</option><option value="Y">gesendet</option><option value="I">ignorieren</option></select></label>
      <label>QSL empfangen<select id="ale-qslr"><option value="">–</option><option value="N">nein</option><option value="R">angefordert</option><option value="Y">erhalten</option></select></label><label>QSL via<input id="ale-via"></label><label>E-Mail<input id="ale-email"></label></div></div>
    <div class="dtab hidden" data-t="awards"><div class="ale-grid"><label>Staat/Provinz<input id="ale-state"></label><label>County<input id="ale-cnty"></label><label>IOTA<input id="ale-iota"></label><label>DOK<input id="ale-dok"></label></div></div>
    <div class="dtab hidden" data-t="prg"><div class="ale-grid"><label>POTA-Park der Gegenstation<input id="ale-pota" placeholder="z. B. DE-0001 (mehrere mit Komma)"></label><label>SOTA-Gipfel<input id="ale-sota" placeholder="z. B. DM/BW-001"></label>
      <label>WWFF-Referenz<input id="ale-wwff" placeholder="z. B. DLFF-0001"></label><span class="ale-prgname hint"></span>
      <label>Mein POTA-Park<input id="ale-mypota"></label><label>Mein SOTA-Gipfel<input id="ale-mysota"></label><label>Meine WWFF-Referenz<input id="ale-mywwff"></label></div></div>
    <div class="dtab hidden" data-t="contest"><div class="ale-grid"><label>Contest-ID<input id="ale-cid" placeholder="z. B. CQ-WW-SSB"></label><label>Nr. gesendet<input id="ale-stx"></label><label>Nr. empfangen<input id="ale-srx"></label><label class="chkrow"><input type="checkbox" id="ale-auto" checked> Nr. hochzählen</label></div></div>
    <div class="dtab hidden" data-t="station"><div class="ale-grid"><label>Mein Rufzeichen<input id="ale-mycall"></label><label>Operator<input id="ale-op"></label><label>Mein Locator<input id="ale-myloc"></label><label>Logbuch<select id="ale-log"></select></label></div></div>
    <div class="ale-prev"></div>
    <div class="actions"><button type="button" id="ale-clear">Leeren (Esc)</button><button type="button" id="ale-del" class="danger hidden">Löschen</button><i class="grow"></i><button type="submit" class="primary" id="ale-save">Hinzufügen ⏎</button></div>
    <datalist id="ale-modes"></datalist></form>`;
  tabsIn(root);
  const modes = () => { $("#ale-modes", root).innerHTML = Object.keys(modeTable()).map(m => `<option>${esc(m)}</option>`).join(""); };
  modes();
  const form = $("form", root);
  const set = (id, v, force) => { if (force || !ALE.dirty.has(id)) F(id).value = v ?? ""; };
  const rst = rstFor;
  const logs = () => { F("log").innerHTML = WW.logbooks.map(l => `<option ${l.name === WW.logbook ? "selected" : ""}>${esc(l.name)}</option>`).join(""); };
  const sync = () => { if (ALE.editing || F("lock").checked || !WW.rig.connected || !WW.rig.freq) return;
    set("freq", fmtMHz(WW.rig.freq)); set("band", bandFor(WW.rig.freq));
    const m = WW.rig.mode === "USB" || WW.rig.mode === "LSB" ? "SSB" : WW.rig.mode === "CWR" ? "CW" : (WW.rig.mode || "").startsWith("PKT") ? (F("mode").value && !["SSB", "CW", "AM", "FM"].includes(F("mode").value) ? F("mode").value : "FT8") : WW.rig.mode;
    if (!ALE.dirty.has("mode") && F("mode").value !== m) { F("mode").value = m; set("rsts", rst(m)); set("rstr", rst(m)); }
    set("sub", ["USB", "LSB"].includes(WW.rig.mode) ? WW.rig.mode : ""); };
  const tick = () => { if (ALE.editing || !F("live").checked) return; const n = new Date().toISOString(); F("date").value = n.slice(0, 10); if (!ALE.start) F("ton").value = n.slice(11, 19); };
  const clear = () => { ALE.editing = null; ALE.dirty.clear(); ALE.start = null; form.reset(); F("live").checked = true; F("auto").checked = true; F("pwr").value = WW.settings.tx_pwr || "";
    const stp = (PRG.stations.list || []).find(x => x.id === PRG.stations.active) || {};
    F("mycall").value = stp.callsign || WW.settings.callsign || ""; F("myloc").value = stp.locator || WW.settings.locator || ""; F("op").value = stp.operator || WW.settings.operator || "";
    if (stp.tx_pwr) F("pwr").value = stp.tx_pwr; F("mypota").value = stp.my_pota_ref || ""; F("mysota").value = stp.my_sota_ref || ""; F("mywwff").value = stp.my_wwff_ref || ""; $(".ale-prgname", root).textContent = ""; $(".ale-state", root).textContent = "Neuer Eintrag";
    $("#ale-save", root).textContent = "Hinzufügen ⏎"; $("#ale-del", root).classList.add("hidden"); $(".ale-dx", root).innerHTML = ""; $(".ale-cb", root).innerHTML = ""; $(".ale-prev", root).innerHTML = "";
    if (LOGB.contest) { F("stx").value = String(LOGB.serial).padStart(3, "0"); } logs(); tick(); sync(); set("rsts", rst(F("mode").value)); set("rstr", rst(F("mode").value)); F("call").focus(); WW.emit("dx", null); };
  const fill = q => { clear(); ALE.editing = q.id; F("live").checked = false; $(".ale-state", root).textContent = `QSO #${q.id} bearbeiten`; $("#ale-save", root).textContent = "Ändern ⏎"; $("#ale-del", root).classList.remove("hidden");
    const map = { call: "call", qso_date: "date", time_on: "ton", time_off: "toff", freq: "freq", band: "band", mode: "mode", submode: "sub", rst_sent: "rsts", rst_rcvd: "rstr", tx_pwr: "pwr", name: "name", qth: "qth", gridsquare: "grid",
      country: "country", comment: "comment", qsl_sent: "qsls", qsl_rcvd: "qslr", qsl_via: "via", email: "email", state: "state", cnty: "cnty", iota: "iota", darc_dok: "dok", contest_id: "cid", stx_string: "stx", srx_string: "srx", pota_ref: "pota", sota_ref: "sota", wwff_ref: "wwff", my_pota_ref: "mypota", my_sota_ref: "mysota", my_wwff_ref: "mywwff", station_callsign: "mycall", operator: "op", my_gridsquare: "myloc" };
    for (const [k, id] of Object.entries(map)) { let v = q[k] ?? ""; if (k === "qso_date" && v) v = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`; if ((k === "time_on" || k === "time_off") && v) v = fmtTimeS(v); F(id).value = v; }
    lookup(true); };
  const lookup = async (noCb) => {
    const call = F("call").value.trim().toUpperCase(), seq = ++ALE.seq;
    if (call.length < 3) { $(".ale-dx", root).innerHTML = ""; $(".ale-prev", root).innerHTML = ""; WW.emit("dx", null); return; }
    let r; try { r = await api(`/api/lookup/${encodeURIComponent(call)}?${logq(new URLSearchParams({ band: F("band").value, mode: F("mode").value, grid: F("grid").value }).toString())}`); } catch { return; }
    if (seq !== ALE.seq) return;
    const w = r.worked, b = [];
    F("country").value = r.country || "";
    if (r.country) b.push(`<b>${esc(r.country)}</b>`, `<span class="badge">${esc(r.cont)}</span>`, `<span class="badge">CQ ${r.cqz} · ITU ${r.ituz}</span>`);
    if (r.km != null) b.push(`<span class="badge clickable" data-bearing="${r.bearing}" title="Klick: Rotor drehen">${r.km.toLocaleString(I18N.locale)} km · ${r.bearing}° ↻</span>`);
    if (r.dxcc && !w.dxcc_worked) b.push(`<span class="badge new_dxcc">Neues Land!</span>`); else if (r.dxcc && F("band").value && !w.dxcc_band) b.push(`<span class="badge new_band">Neu auf ${esc(F("band").value)}</span>`);
    if (w.call_count) b.push(`<span class="badge worked">${w.call_count}× gearbeitet</span>`);
    $(".ale-dx", root).innerHTML = b.join("");
    const prev = (w.previous || []).filter(p => p.id !== ALE.editing);
    $(".ale-prev", root).innerHTML = prev.length ? `<table class="mini"><tr><th>Datum</th><th>UTC</th><th>Band</th><th>Mode</th><th>Name</th><th>Bemerkung</th></tr>${prev.slice(0, 5).map(p => `<tr><td>${fmtDate(p.qso_date)}</td><td>${fmtTime(p.time_on)}</td><td>${esc(p.band)}</td><td>${esc(p.mode)}</td><td>${esc(p.name || "")}</td><td>${esc(p.comment || "")}</td></tr>`).join("")}</table>` : "";
    if (!ALE.editing && prev.length) { const f = k => prev.find(p => p[k]) || {}; if (!F("name").value) F("name").value = f("name").name || ""; if (!F("qth").value) F("qth").value = f("qth").qth || ""; if (!F("grid").value) F("grid").value = f("gridsquare").gridsquare || ""; }
    WW.emit("dx", { ...r, call });
    if (!noCb && !ALE.editing && WW.settings.callbook_auto && (WW.settings.hamqth_user || WW.settings.qrz_user)) {
      try { const c = await api(`/api/callbook/${encodeURIComponent(call)}`); if (seq !== ALE.seq) return;
        for (const [k, id] of [["name", "name"], ["qth", "qth"], ["gridsquare", "grid"], ["state", "state"], ["cnty", "cnty"], ["iota", "iota"], ["email", "email"], ["qsl_via", "via"]]) if (c[k] && !F(id).value) F(id).value = c[k];
        $(".ale-cb", root).innerHTML = `<span class="badge cb">${esc(c.source)}: ${esc(c.fullname || c.name || "")}</span>${c.lotw ? '<span class="badge worked">LoTW</span>' : ""}${c.eqsl ? '<span class="badge worked">eQSL</span>' : ""}`;
        WW.emit("callbook", c); } catch { } }
  };
  F("call").addEventListener("input", e => { const p = e.target.selectionStart; e.target.value = e.target.value.toUpperCase().replace(/\s/g, ""); e.target.setSelectionRange(p, p);
    if (!ALE.start && !ALE.editing && e.target.value.length === 1) { ALE.start = new Date(); F("ton").value = ALE.start.toISOString().slice(11, 19); }
    clearTimeout(ALE.lt); ALE.lt = setTimeout(() => lookup(), 250);
    const pd = PRG.pending; if (pd && !ALE.editing && Date.now() - pd.t < 30 * 60000 && e.target.value === pd.call && !F(pd.prog).value) { F(pd.prog).value = pd.ref; prgName(pd.prog, pd.ref); } });
  const prgName = async (prog, ref) => { const r = await api(`/api/programs/ref/${prog}/${encodeURIComponent(ref.split(",")[0].trim())}`).catch(() => null); $(".ale-prgname", root).textContent = r ? `${PRG.names[prog]} ${r.ref}: ${r.name}${r.loc ? " (" + r.loc + ")" : ""}` : ""; };
  for (const [id, prog] of [["pota", "pota"], ["sota", "sota"], ["wwff", "wwff"], ["mypota", "pota"], ["mysota", "sota"], ["mywwff", "wwff"]]) { prgRefInput(F(id), prog); F(id).addEventListener("change", () => F(id).value && prgName(prog, F(id).value)); }
  root.addEventListener("input", e => { if (e.target.id && e.target.id !== "ale-call") ALE.dirty.add(e.target.id.slice(4)); if (["ale-date", "ale-ton"].includes(e.target.id)) F("live").checked = false; });
  F("freq").addEventListener("change", () => { const hz = parseFloat(F("freq").value.replace(",", ".")) * 1e6; if (hz) set("band", bandFor(hz), true); });
  F("mode").addEventListener("change", () => { F("mode").value = F("mode").value.toUpperCase(); if (!ALE.editing) { set("rsts", rst(F("mode").value), true); set("rstr", rst(F("mode").value), true); } });
  F("grid").addEventListener("change", () => lookup(true));
  $("#ale-startb", root).onclick = () => { ALE.start = new Date(); F("ton").value = ALE.start.toISOString().slice(11, 19); };
  $("#ale-stopb", root).onclick = () => { F("toff").value = new Date().toISOString().slice(11, 19); };
  $("#ale-clear", root).onclick = clear;
  $("#ale-del", root).onclick = async () => { if (!ALE.editing || !confirm("QSO löschen?")) return; await api(`/api/qso/${ALE.editing}?${logq()}`, { method: "DELETE" }); toast("Gelöscht"); clear(); };
  root.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); clear(); } });
  root.addEventListener("click", e => { const b = e.target.closest("[data-bearing]"); if (b) rotorSet(+b.dataset.bearing); });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const rec = { call: F("call").value.trim().toUpperCase(), qso_date: F("date").value.replaceAll("-", ""), time_on: F("ton").value.replaceAll(":", "").padEnd(6, "0"),
      time_off: F("toff").value.replaceAll(":", ""), freq: F("freq").value.replace(",", "."), band: F("band").value.trim(), mode: F("mode").value.trim().toUpperCase(), submode: F("sub").value.trim(),
      rst_sent: F("rsts").value.trim(), rst_rcvd: F("rstr").value.trim(), tx_pwr: F("pwr").value.trim(), name: F("name").value.trim(), qth: F("qth").value.trim(), gridsquare: F("grid").value.trim(),
      comment: F("comment").value.trim(), qsl_sent: F("qsls").value, qsl_rcvd: F("qslr").value, qsl_via: F("via").value.trim(), email: F("email").value.trim(), state: F("state").value.trim(), cnty: F("cnty").value.trim(),
      iota: F("iota").value.trim(), darc_dok: F("dok").value.trim(), contest_id: F("cid").value.trim(), stx_string: F("stx").value.trim(), srx_string: F("srx").value.trim(),
      station_callsign: F("mycall").value.trim(), operator: F("op").value.trim(), my_gridsquare: F("myloc").value.trim(),
      pota_ref: F("pota").value.trim().toUpperCase(), sota_ref: F("sota").value.trim().toUpperCase(), wwff_ref: F("wwff").value.trim().toUpperCase(),
      my_pota_ref: F("mypota").value.trim().toUpperCase(), my_sota_ref: F("mysota").value.trim().toUpperCase(), my_wwff_ref: F("mywwff").value.trim().toUpperCase() };
    if (rec.call.length < 3) { toast("Rufzeichen fehlt", true); F("call").focus(); return; }
    if (rec.freq && !rec.band) rec.band = bandFor(parseFloat(rec.freq) * 1e6);
    if (!rec.time_off && !ALE.editing) rec.time_off = new Date().toISOString().slice(11, 19).replaceAll(":", "");
    const lg = F("log").value || WW.logbook;
    try {
      if (ALE.editing) { await api(`/api/qso/${ALE.editing}?log=${encodeURIComponent(lg)}`, { method: "PUT", body: rec }); toast(`${rec.call} geändert`); }
      else { const q = await post(`/api/qso?log=${encodeURIComponent(lg)}`, rec); toast(`${q.call} geloggt – ${q.band || ""} ${q.mode || ""}`);
        if (LOGB.contest && F("auto").checked) { LOGB.serial++; store.set("log.serial", LOGB.serial); } }
      clear();
    } catch (err) { toast(err.message, true); }
  });
  const offs = [WW.on("settings", modes), WW.on("rig", sync), WW.on("ale-open", q => q ? fill(q) : clear()), WW.on("prefill", p => { clear(); F("call").value = p.call; if (p.mode) { F("mode").value = p.mode; ALE.dirty.add("mode"); set("rsts", rst(p.mode), true); set("rstr", rst(p.mode), true); }
    if (p.freq) { F("freq").value = (p.freq / 1e6).toFixed(4); F("band").value = bandFor(p.freq); }
    for (const k of ["pota", "sota", "wwff"]) if (p[k]) { F(k).value = p[k]; prgName(k, p[k]); root.querySelector('.dtabs [data-t="prg"]')?.click(); } lookup(); }), WW.on("logbooks", logs), WW.on("contest", () => { if (LOGB.contest && !F("stx").value) F("stx").value = String(LOGB.serial).padStart(3, "0"); })];
  const tk = setInterval(tick, 1000); clear();
  return () => { offs.forEach(f => f()); clearInterval(tk); };
}

// ---------- Lookup ----------
function matrixHtml(m, title) {
  const bands = ["160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"];
  const cell = v => v === "C" ? '<td class="mx c">✓</td>' : v === "W" ? '<td class="mx w" title="gearbeitet, nicht bestätigt">◆</td>' : '<td class="mx n">✗</td>';
  return `<table class="matrix2"><tr><th>${esc(title)}</th>${bands.map(b => `<th>${b.replace("m", "")}</th>`).join("")}</tr>${["CW", "Phone", "Digital"].map(g => `<tr><th>${g}</th>${bands.map(b => cell((m[b] || {})[g])).join("")}</tr>`).join("")}</table>`;
}
function createLookup(root) {
  root.innerHTML = `<div class="pane-tb"><button data-a="cb">${icon("i-globe")} Callbook</button><button data-a="lb">${icon("i-book")} Logbuch</button><button data-a="reset">${icon("i-x")} Leeren</button><button data-a="spot">${icon("i-plus")} Spot</button></div>
    <div class="lk-call"><label>Rufzeichen: <input class="lk-in" spellcheck="false"></label></div><div class="lk-body"><div class="hint">Rufzeichen eingeben oder im Logbuch/Cluster anklicken.</div></div>`;
  const body = $(".lk-body", root);
  const show = async (call, useCb = true) => {
    call = (call || "").toUpperCase().trim(); if (call.length < 3) return; $(".lk-in", root).value = call;
    let r, c = null; try { r = await api(`/api/lookup/${encodeURIComponent(call)}?${logq()}`); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    if (useCb && (WW.settings.hamqth_user || WW.settings.qrz_user)) { try { c = await api(`/api/callbook/${encodeURIComponent(call)}`); } catch { } }
    body.innerHTML = `${c?.photo ? `<div class="lk-photo"><img src="${esc(c.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></div>` : ""}
      <fieldset><legend>Rufzeichen</legend>${c ? `<div>eQSL: ${c.eqsl ? "Ja" : "Nein"} | LoTW: ${c.lotw ? "Ja" : "Nein"}${c.qsl_via ? " | via " + esc(c.qsl_via) : ""}</div>` : ""}${matrixHtml(r.matrix_call || {}, call)}</fieldset>
      ${c ? `<fieldset><legend>Inhaber</legend><div class="lk-lines"><div>👤 <b>${esc(c.fullname || c.name || "")}</b></div>${c.address ? `<div>🏠 ${esc(c.address)}</div>` : ""}${c.email ? `<div>✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
        ${c.web ? `<div>🌐 <a href="${esc(c.web)}" target="_blank">${esc(c.web)}</a></div>` : ""}${c.gridsquare ? `<div>⌗ ${esc(c.gridsquare)}</div>` : ""}<div class="hint">Quelle: ${esc(c.source)}</div></div></fieldset>` : ""}
      <fieldset><legend>Land</legend><div class="lk-lines"><div>🌍 <b>${esc(r.country || "unbekannt")}</b></div><div>DXCC=${r.dxcc ?? "–"}, Kont.=${esc(r.cont || "–")}, CQ ${r.cqz ?? "–"}, ITU ${r.ituz ?? "–"}</div>
        ${r.km != null ? `<div class="clickable" data-bearing="${r.bearing}">🧭 ${r.km.toLocaleString(I18N.locale)} km, ${r.bearing}° (lang ${(r.bearing + 180) % 360}°) ↻</div>` : ""}</div>${matrixHtml(r.matrix_dxcc || {}, r.prefix || "Land")}</fieldset>
      ${(r.worked.previous || []).length ? `<fieldset><legend>Letzte QSOs</legend><table class="mini">${r.worked.previous.slice(0, 8).map(p => `<tr><td>${fmtDate(p.qso_date)}</td><td>${esc(p.band)}</td><td>${esc(p.mode)}</td><td>${esc(p.name || "")}</td></tr>`).join("")}</table></fieldset>` : ""}`;
  };
  $(".lk-in", root).addEventListener("keydown", e => { if (e.key === "Enter") show(e.target.value); });
  root.addEventListener("click", e => { const b = e.target.closest(".pane-tb button"), br = e.target.closest("[data-bearing]");
    if (br) rotorSet(+br.dataset.bearing);
    if (!b) return; const call = $(".lk-in", root).value;
    if (b.dataset.a === "cb") show(call, true); else if (b.dataset.a === "lb") show(call, false); else if (b.dataset.a === "reset") { $(".lk-in", root).value = ""; body.innerHTML = ""; }
    else if (b.dataset.a === "spot") spotDialog(call); });
  const offs = [WW.on("dx", d => { if (d?.call) show(d.call, false); }), WW.on("log-select", q => q && show(q.call, false)), WW.on("callbook", () => { const v = $(".lk-in", root).value; if (v) show(v, true); })];
  return () => offs.forEach(f => f());
}
function spotDialog(call = "") {
  const d = dialog({ title: "Spot senden", buttons: [["Abbrechen", "close"], ["Senden", "ok", "primary"]], body: `<div class="grid2"><label>Rufzeichen<input id="sp-c" value="${esc(call)}"></label><label>Frequenz kHz<input id="sp-f" value="${WW.rig.freq ? (WW.rig.freq / 1000).toFixed(1) : ""}"></label><label class="wide">Kommentar<input id="sp-k" maxlength="30"></label></div>` });
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault(); try { await post("/api/cluster/send", { cmd: `DX ${$("#sp-f", d).value} ${$("#sp-c", d).value.toUpperCase()} ${$("#sp-k", d).value}` }); toast("Spot gesendet"); d.close(); } catch (err) { toast(err.message, true); } };
}

// ---------- Gerätestatus (kleine Gerätesteuerung) ----------
function createRadioPane(root) {
  root.innerHTML = `<div class="pane-tb"><button data-a="conn">${icon("i-plug")} Verbinden</button><button data-a="rc">${icon("i-radio")} Gerätesteuerung</button></div><div class="rp"></div>`;
  const draw = () => { const r = WW.rig, cur = WW.radios.find(x => x.id === WW.current);
    $(".rp", root).innerHTML = `<div class="rp-tab">${esc(cur?.name || "kein Funkgerät")}</div><div class="rp-row"><span>VFO A:</span><b class="rp-f">${r.freq ? fmtDots(r.freq) : "—"}</b></div><div class="rp-row"><span>VFO B:</span><b class="rp-f">${r.vfob_freq ? fmtDots(r.vfob_freq) : "—"}</b></div>
      <div class="rp-grid"><button data-d="mode">Mode: ${esc(r.mode || "–")}</button><button data-d="filter">Filter: ${r.passband ? (r.passband / 1000).toLocaleString(I18N.locale) + " kHz" : "–"}</button>
      ${(WW.caps.ui_choices || []).map(ch => `<button data-d="lvl:${ch.name}">${esc(dropValue("lvl:" + ch.name))}</button>`).join("")}
      ${(WW.caps.ui_funcs || []).slice(0, 12).map(f => `<button data-f="${f.name}" class="${(r.funcs || {})[f.name] ? "on" : ""}">${esc(f.label)}</button>`).join("")}<button data-p class="${r.ptt ? "on tx" : ""}">PTT</button></div>`; };
  root.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.a === "conn") openConnect(); else if (b.dataset.a === "rc") switchApp("rig");
    else if (b.dataset.d) dropMenu(b.dataset.d, b); else if (b.dataset.f) act("/api/rig/func", { name: b.dataset.f, on: !(WW.rig.funcs || {})[b.dataset.f] }); else if (b.dataset.p !== undefined) act("/api/rig/ptt", { on: !WW.rig.ptt }); });
  const offs = [WW.on("rig", draw), WW.on("caps", draw), WW.on("radios", draw)]; draw(); return () => offs.forEach(f => f());
}

// ---------- Audio-Rekorder ----------
function createRecorder(root) {
  root.innerHTML = `<div class="pane-tb"><button data-a="rec" class="rec">● Aufnahme</button><button data-a="stop">■ Stopp</button><label class="chk">Grenze <select class="ar-lim"><option value="1">1 min</option><option value="5" selected>5 min</option><option value="15">15 min</option><option value="60">60 min</option></select></label></div>
    <div class="ar-info"><div>QSO: <span class="ar-qso">–</span></div><div>Eingang: <select class="ar-in"><option value="">Standard</option></select></div></div><div class="tablewrap"><table class="grid ar-list"><tbody></tbody></table></div>`;
  let rec = null, stopT;
  const list = async () => { const r = await api("/api/recordings"); $(".ar-list tbody", root).innerHTML = r.map(x => `<tr><td>${esc(x.file)}</td><td>${(x.size / 1024).toFixed(0)} kB</td><td><a class="btn" href="/api/recordings/${encodeURIComponent(x.file)}" target="_blank">▶</a></td></tr>`).join("") || '<tr><td class="hint">noch keine Aufnahmen</td></tr>'; };
  navigator.mediaDevices?.enumerateDevices().then(ds => { $(".ar-in", root).innerHTML += ds.filter(x => x.kind === "audioinput").map(x => `<option value="${esc(x.deviceId)}">${esc(x.label || x.deviceId.slice(0, 8))}</option>`).join(""); });
  const qso = () => `${WW.rig.freq ? fmtMHz(WW.rig.freq) + " MHz" : ""} @ ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  root.addEventListener("click", async e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.a === "rec" && !rec) { if (!navigator.mediaDevices?.getUserMedia) return toast("Soundkarte nur über https://…:8443", true);
      try { const dev = $(".ar-in", root).value, s = await navigator.mediaDevices.getUserMedia({ audio: dev ? { deviceId: { exact: dev } } : true }); const chunks = []; rec = new MediaRecorder(s);
        rec.ondataavailable = ev => chunks.push(ev.data); rec.onstop = async () => { s.getTracks().forEach(t => t.stop()); clearTimeout(stopT); const fd = new FormData(); fd.append("file", new Blob(chunks, { type: "audio/webm" }), "a.webm");
          const call = document.getElementById("ale-call")?.value || ""; await api(`/api/recordings?call=${encodeURIComponent(call)}`, { method: "POST", body: fd }); rec = null; b.classList.remove("on"); toast("Aufnahme gespeichert"); list(); };
        rec.start(); b.classList.add("on"); $(".ar-qso", root).textContent = qso(); stopT = setTimeout(() => rec && rec.stop(), +$(".ar-lim", root).value * 60000); } catch (err) { toast(err.message, true); } }
    if (b.dataset.a === "stop" && rec) rec.stop(); });
  list(); return () => { if (rec) rec.stop(); };
}

// ---------- Netzwerk (Verbindungen) ----------
function createNetServer(root) {
  const draw = () => { root.innerHTML = `<table class="grid"><thead><tr><th>Verbindung</th><th>Status</th><th>Details</th></tr></thead><tbody>
    ${WW.radios.map(r => `<tr><td>Funkgerät ${esc(r.name)}</td><td>${r.connected ? "✓ verbunden" : "–"}</td><td>${esc(r.model_name || "")} ${esc(r.device || r.host || "")}</td></tr>`).join("")}
    <tr><td>Rotor</td><td>${WW.rotor.enabled ? (WW.rotor.connected ? "✓" : "✗") : "aus"}</td><td>${esc(WW.rotor.model || "")}</td></tr>
    <tr><td>DX-Cluster</td><td>${WW.cluster.connected ? "✓" : "✗"}</td><td>${esc(WW.cluster.host || "")} <span>${esc(WW.cluster.error || "")}</span></td></tr>
    <tr><td>WSJT-X/JTDX (UDP ${esc(WW.settings.wsjtx_port)})</td><td>${WW.wsjtx.ident ? "✓" : "–"}</td><td>${esc(WW.wsjtx.ident || "")} ${esc(WW.wsjtx.mode || "")}</td></tr>
    <tr><td>Wellenwerk-Server</td><td>✓</td><td>${esc(location.host)}</td></tr></tbody></table>`; };
  const offs = [WW.on("radios", draw), WW.on("rotor", draw), WW.on("cluster", draw), WW.on("wsjtx", draw)]; draw(); return () => offs.forEach(f => f());
}

// ---------- Sonnendaten ----------
async function solar() { if (!WW._solar || Date.now() - WW._solarT > 3600e3) { WW._solar = await api("/api/solar"); WW._solarT = Date.now(); } return WW._solar; }
function chart(cv, series, opts = {}) {
  const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio, c = cv.getContext("2d"); c.scale(devicePixelRatio, devicePixelRatio);
  const w = cv.clientWidth, hh = cv.clientHeight, pad = 34, css = getComputedStyle(document.documentElement);
  c.fillStyle = css.getPropertyValue("--panel").trim() || "#fff"; c.fillRect(0, 0, w, hh);
  const all = series.flatMap(s => s.data.map(p => p.v).filter(v => v != null && v >= 0)); if (!all.length) return;
  const mx = opts.max || Math.max(...all) * 1.1, n = Math.max(...series.map(s => s.data.length));
  c.strokeStyle = "#ccc"; c.fillStyle = "#777"; c.font = "10px system-ui";
  for (let i = 0; i <= 4; i++) { const y = hh - pad / 2 - (hh - pad) * i / 4; c.beginPath(); c.moveTo(pad, y); c.lineTo(w - 6, y); c.stroke(); c.fillText(Math.round(mx * i / 4), 2, y + 3); }
  series.forEach(s => { const dx = (w - pad - 6) / Math.max(1, n - 1);
    if (s.bar) s.data.forEach((p, i) => { if (p.v == null || p.v < 0) return; const bh = (hh - pad) * p.v / mx; c.fillStyle = typeof s.color === "function" ? s.color(p.v) : s.color; c.fillRect(pad + i * dx - dx * 0.35, hh - pad / 2 - bh, dx * 0.7, bh); });
    else { c.strokeStyle = s.color; c.lineWidth = s.width || 1.5; c.beginPath(); let st = false; s.data.forEach((p, i) => { if (p.v == null || p.v < 0) { st = false; return; } const x = pad + i * (w - pad - 6) / Math.max(1, s.data.length - 1), y = hh - pad / 2 - (hh - pad) * p.v / mx; st ? c.lineTo(x, y) : c.moveTo(x, y); st = true; }); c.stroke(); } });
  c.fillStyle = "#555"; (opts.labels || []).forEach(([i, t]) => c.fillText(t, pad + i * (w - pad - 6) / Math.max(1, n - 1) - 12, hh - 3));
  if (opts.legend) { let x = pad + 4; opts.legend.forEach(([t, col]) => { c.fillStyle = col; c.fillRect(x, 4, 10, 8); c.fillStyle = "#333"; c.fillText(t, x + 13, 12); x += c.measureText(t).width + 30; }); }
}
function createSolar30(root) {
  root.innerHTML = `<div class="solar-grid"><div><b>Solarer Flux (10,7 cm)</b><canvas class="sc1"></canvas></div><div><b>Planetarer K-Index (3 h)</b><canvas class="sc2"></canvas></div></div><div class="hint">Quelle: NOAA SWPC</div>`;
  const draw = async () => { try { const s = await solar();
    chart($(".sc1", root), [{ data: s.flux.map(x => ({ v: x.v })), bar: true, color: "#f5a524" }], { labels: s.flux.map((x, i) => [i, i % 7 === 0 ? x.t.slice(5) : ""]).filter(x => x[1]) });
    const kp = s.kp.slice(-56); chart($(".sc2", root), [{ data: kp.map(x => ({ v: x.v })), bar: true, color: v => v >= 5 ? "#d62828" : v >= 4 ? "#e09a1a" : "#3fb950" }], { max: 9, labels: kp.map((x, i) => [i, i % 8 === 0 ? x.t.slice(5, 10) : ""]).filter(x => x[1]) });
  } catch (e) { root.innerHTML = `<div class="err">${esc(e.message)}</div>`; } };
  const ro = new ResizeObserver(draw); ro.observe(root); return () => ro.disconnect();
}
function createSolarCycle(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk">ab Jahr <select class="cy-from">${[1899, 1950, 1990, 2000, 2010, 2019].map(y => `<option ${y === 2000 ? "selected" : ""}>${y}</option>`).join("")}</select></label></div><canvas class="cy"></canvas>`;
  const draw = async () => { try { const s = await solar(), from = $(".cy-from", root).value, obs = s.cycle.filter(x => x.t >= from), pred = s.pred;
    const all = [...obs.map(x => x.t), ...pred.map(x => x.t).filter(t => t > (obs[obs.length - 1] || {}).t)];
    const idx = t => all.indexOf(t), mk = (arr, k) => all.map(t => { const x = arr.find(a => a.t === t); return { v: x ? x[k] : null }; });
    chart($(".cy", root), [{ data: mk(obs, "ssn"), color: "#93c5fd", width: 1 }, { data: mk(obs, "smooth"), color: "#1f5fae", width: 2 }, { data: mk(pred, "ssn"), color: "#d62828", width: 2 }],
      { labels: all.map((t, i) => [i, t.endsWith("-01") && +t.slice(0, 4) % 5 === 0 ? t.slice(0, 4) : ""]).filter(x => x[1]), legend: [["Sonnenflecken monatlich", "#93c5fd"], ["geglättet", "#1f5fae"], ["Prognose", "#d62828"]] });
  } catch (e) { root.innerHTML = `<div class="err">${esc(e.message)}</div>`; } };
  $(".cy-from", root).onchange = draw; const ro = new ResizeObserver(draw); ro.observe(root); return () => ro.disconnect();
}

// ---------- Audio-Monitor ----------
function createAudioMon(root) {
  root.innerHTML = `<div class="pane-tb"><button class="am-go">▶ Start</button><select class="am-in"><option value="">Standard-Eingang</option></select><span class="hint">Spektrum und Pegel der Soundkarte (nur über https://…:8443)</span></div><canvas class="am-cv"></canvas>`;
  let ctx, an, raf, stream;
  navigator.mediaDevices?.enumerateDevices().then(ds => { $(".am-in", root).innerHTML += ds.filter(x => x.kind === "audioinput").map(x => `<option value="${esc(x.deviceId)}">${esc(x.label || x.deviceId.slice(0, 8))}</option>`).join(""); });
  const stop = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); ctx?.close(); ctx = null; $(".am-go", root).textContent = "▶ Start"; };
  $(".am-go", root).onclick = async () => { if (ctx) return stop();
    try { const dev = $(".am-in", root).value; stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      try { ctx = new AudioContext({ sinkId: { type: "none" } }); } catch { ctx = new AudioContext(); }
      an = ctx.createAnalyser(); an.fftSize = 2048; ctx.createMediaStreamSource(stream).connect(an); $(".am-go", root).textContent = "■ Stopp";
      const cv = $(".am-cv", root), buf = new Uint8Array(an.frequencyBinCount);
      const loop = () => { const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight, c = cv.getContext("2d"); an.getByteFrequencyData(buf); c.fillStyle = "#0b0f14"; c.fillRect(0, 0, W, H);
        const maxBin = Math.floor(4000 / (ctx.sampleRate / 2) * buf.length); c.fillStyle = "#3ccf5a";
        for (let x = 0; x < W; x++) { const v = buf[Math.floor(x / W * maxBin)] / 255; c.fillRect(x, H - v * H, 1, v * H); }
        c.fillStyle = "#9ab"; for (let f = 0; f <= 4000; f += 500) c.fillText(f, f / 4000 * W, 10); raf = requestAnimationFrame(loop); }; loop();
    } catch (e) { toast(e.message, true); } };
  return stop;
}

// ---------- DX-Cluster (mit A:B:M-Spalten) ----------
const abmCell = a => a ? a.map(v => v ? '<i class="ok">✓</i>' : '<i class="no">✗</i>').join("") : "";
function createCluster(root) {
  root.innerHTML = `<div class="pane-tb"><button data-a="conn">${icon("i-plug")} <span class="cl-conn">Verbinden</span></button><label class="chk">Zeigen <select class="cl-band"><option value="">alle Bänder</option>${WW.bands.map(b => `<option>${b.name}</option>`).join("")}</select></label>
    <select class="cl-mode"><option value="">alle Modes</option><option>CW</option><option>SSB</option><option>FT8</option><option>RTTY</option></select><label class="chk"><input type="checkbox" class="cl-new"> nur Neue</label>
    <button data-a="alarms">${icon("i-bell")} Alarme</button><button data-a="opt">${icon("i-gear")} Optionen</button><button data-a="spot">${icon("i-plus")} Spot</button><span class="cl-cnt hint"></span>
    <input class="cl-cmd grow" placeholder="Cluster-Befehl, z. B. SH/DX 20"></div>
    <div class="tablewrap"><table class="grid cl-grid"><thead><tr><th>Zeit</th><th>Mode</th><th>Band</th><th>Freq</th><th title="auf diesem Band im Log">L</th><th title="schon einmal gearbeitet">B4</th><th>DX</th><th title="Land: jemals · Band · Mode">A:B:M Land</th><th>A:B:M CQ</th><th>A:B:M ITU</th><th>A:B:M Loc</th><th>Kommentar</th><th>Spotter</th></tr></thead><tbody></tbody></table></div>`;
  const vis = s => (!$(".cl-band", root).value || s.band === $(".cl-band", root).value) && (!$(".cl-mode", root).value || (s.mode || "").startsWith($(".cl-mode", root).value)) && (!$(".cl-new", root).checked || ["new_dxcc", "new_band"].includes(s.status));
  const row = (s, fresh) => `<tr class="st-${s.status || "none"}${fresh ? " fresh" : ""}" data-f="${s.freq}" data-call="${esc(s.call)}" data-cmt="${esc(s.comment)}"><td>${esc(s.time)}Z</td><td>${esc(s.mgroup === "Digital" ? "DIGI" : s.mode || "")}</td><td>${esc(s.band)}</td><td>${(s.freq / 1000).toFixed(1)}</td>
    <td>${s.logged ? "✓" : ""}</td><td>${s.b4 ? "✓" : '<i class="no">✗</i>'}</td><td class="call">${esc(s.call)}</td><td class="abm">${abmCell(s.abm?.country)} ${esc(s.country || "")}</td><td class="abm">${abmCell(s.abm?.cqz)} ${s.cqz ?? ""}</td><td class="abm">${abmCell(s.abm?.ituz)} ${s.ituz ?? ""}</td>
    <td class="abm">${abmCell(s.abm?.grid)} ${esc(s.spotted_grid || "")}</td><td class="cmt">${esc(s.comment)}</td><td>${esc(s.spotter)}</td></tr>`;
  const draw = () => { $("tbody", root).innerHTML = WW.spots.filter(vis).map(s => row(s)).join("") || `<tr><td colspan="13" class="hint">${WW.cluster.connected ? "Noch keine Spots für diesen Filter." : "Cluster nicht verbunden."}</td></tr>`;
    $(".cl-cnt", root).textContent = `${WW.spots.length} Spots`; $(".cl-conn", root).textContent = WW.cluster.connected ? "Trennen" : "Verbinden"; };
  root.addEventListener("change", draw);
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-call]"); if (tr) { tuneSpot(+tr.dataset.f, tr.dataset.call, tr.dataset.cmt); if (!SHELL.dv.log.getPanel("ale")) openAle(); return; }
    const b = e.target.closest(".pane-tb button"); if (!b) return;
    if (b.dataset.a === "opt" || b.dataset.a === "conn") openOptions("cluster"); else if (b.dataset.a === "spot") spotDialog(); else if (b.dataset.a === "alarms") alarmsDialog(); });
  $(".cl-cmd", root).addEventListener("keydown", async e => { if (e.key === "Enter" && e.target.value.trim()) { if (await act("/api/cluster/send", { cmd: e.target.value })) { toast("an Cluster gesendet"); e.target.value = ""; } } });
  const offs = [WW.on("spot", s => { checkAlarm(s); if (vis(s)) { const tb = $("tbody", root); if (tb.querySelector(".hint")) tb.innerHTML = ""; tb.insertAdjacentHTML("afterbegin", row(s, true)); if (tb.rows.length > 300) tb.deleteRow(-1); } $(".cl-cnt", root).textContent = `${WW.spots.length} Spots`; }),
    WW.on("spots", draw), WW.on("cluster", draw)]; draw(); return () => offs.forEach(f => f());
}
function checkAlarm(s) {
  const al = store.get("alarms", { newdxcc: true, newband: false, calls: "", sound: true });
  const calls = al.calls.toUpperCase().split(/[\s,]+/).filter(Boolean);
  const hit = (al.newdxcc && s.status === "new_dxcc") || (al.newband && s.status === "new_band") || calls.some(c => s.call === c || (c.endsWith("*") && s.call.startsWith(c.slice(0, -1))));
  if (!hit) return; toast(`Alarm: ${s.call} ${(s.freq / 1000).toFixed(1)} kHz ${s.country || ""}`);
  if (al.sound) beep(988, 0.25, 0.12);
}
function alarmsDialog() {
  const al = store.get("alarms", { newdxcc: true, newband: false, calls: "", sound: true });
  const d = dialog({ title: "Cluster-Alarme", icon: "i-bell", buttons: [["Abbrechen", "close"], ["Speichern", "ok", "primary"]], body: `<div class="grid2"><label class="wide chkrow"><input type="checkbox" id="al-1" ${al.newdxcc ? "checked" : ""}> Neues Land (DXCC)</label>
    <label class="wide chkrow"><input type="checkbox" id="al-2" ${al.newband ? "checked" : ""}> Neues Land auf dem Band</label><label class="wide">Rufzeichen (Komma, * am Ende = Präfix)<input id="al-3" value="${esc(al.calls)}" placeholder="VP8LP, 3Y0*"></label>
    <label class="wide chkrow"><input type="checkbox" id="al-4" ${al.sound ? "checked" : ""}> Ton</label></div>` });
  d.querySelector('[value="ok"]').onclick = e => { e.preventDefault(); store.set("alarms", { newdxcc: $("#al-1", d).checked, newband: $("#al-2", d).checked, calls: $("#al-3", d).value, sound: $("#al-4", d).checked }); d.close(); };
}

// ---------- Alert (FT8/FT4-Decodes aus WSJT-X) ----------
function createAlert(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk"><input type="checkbox" class="al-cq"> nur CQ</label><label class="chk"><input type="checkbox" class="al-new"> nur Neue</label><span class="hint al-src"></span><button class="al-halt" title="WSJT-X: Senden stoppen">TX stopp</button><button class="al-clr">Leeren</button></div>
    <div class="tablewrap"><table class="grid"><thead><tr><th>UTC</th><th>dB</th><th>DT</th><th>Hz</th><th>Band</th><th>Nachricht</th><th>Rufzeichen</th><th>Land</th><th>km</th></tr></thead><tbody></tbody></table></div>`;
  const vis = d => (!$(".al-cq", root).checked || d.cq) && (!$(".al-new", root).checked || ["new_dxcc", "new_band"].includes(d.status));
  const row = (d, f) => `<tr class="st-${d.status || "none"}${f ? " fresh" : ""}" data-call="${esc(d.call)}" data-id="${d.id || ""}" title="Doppelklick: in WSJT-X anrufen (Shift: auf der eigenen Frequenz)"><td>${esc(d.utc)}</td><td>${d.snr}</td><td>${d.dt}</td><td>${d.df}</td><td>${esc(d.band)}</td><td class="msg">${esc(d.message)}</td><td class="call">${esc(d.call)}</td><td>${esc(d.country)}</td><td>${d.km != null ? d.km.toLocaleString(I18N.locale) : ""}</td></tr>`;
  const draw = () => { $("tbody", root).innerHTML = WW.decodes.filter(vis).slice(0, 300).map(d => row(d)).join("") || `<tr><td colspan="9" class="hint">Noch keine Decodes. WSJT-X/JTDX: Einstellungen → Reporting → UDP Server auf diesen Rechner, Port ${esc(WW.settings.wsjtx_port)}.</td></tr>`;
    $(".al-src", root).textContent = WW.wsjtx.ident ? `${WW.wsjtx.ident} · ${WW.wsjtx.mode || ""} · ${fmtMHz(WW.wsjtx.dial || 0)} MHz` : ""; };
  root.addEventListener("change", draw); $(".al-clr", root).onclick = () => { WW.decodes = []; draw(); };
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-call]"); if (tr && tr.dataset.call) WW.emit("dx", { call: tr.dataset.call }); });
  root.addEventListener("dblclick", async e => { const tr = e.target.closest("tr[data-id]"); if (!tr || !tr.dataset.id) return;
    if (await act("/api/wsjtx/reply", { id: +tr.dataset.id, shift: e.shiftKey })) toast(`WSJT-X ruft ${tr.dataset.call}`); });
  $(".al-halt", root).onclick = async () => { if (await act("/api/wsjtx/halt", {})) toast("WSJT-X: Senden gestoppt"); };
  const offs = [WW.on("decode", d => { if (!vis(d)) return; const tb = $("tbody", root); if (tb.querySelector(".hint")) tb.innerHTML = ""; tb.insertAdjacentHTML("afterbegin", row(d, true)); if (tb.rows.length > 300) tb.deleteRow(-1); }), WW.on("wsjtx", draw)];
  draw(); return () => offs.forEach(f => f());
}

// ---------- Kalender (Contests WA7BNM, DXpeditionen NG3K) ----------
function createCalendar(root) {
  root.innerHTML = `<div class="pane-tb"><button data-k="c" class="on">Contests</button><button data-k="d">DXpeditionen</button><label class="chk"><input type="checkbox" class="ca-now"> nur aktuell</label><label class="chk"><input type="checkbox" class="ca-need"> nur fehlende Länder</label><span class="hint ca-src"></span></div><div class="tablewrap"><table class="grid"><tbody><tr><td class="hint">Lade Kalender …</td></tr></tbody></table></div>`;
  let data = null, kind = "c";
  const fmt = iso => iso ? new Date(iso).toLocaleString(I18N.locale, { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC" : "";
  const draw = () => { if (!data) return; const now = Date.now(), onlyNow = $(".ca-now", root).checked, need = $(".ca-need", root).checked;
    $(".ca-need", root).parentElement.classList.toggle("hidden", kind === "c");
    if (kind === "c") {
      const rows = data.contests.filter(c => !onlyNow || (c.start && Date.parse(c.start) <= now + 86400e3 && Date.parse(c.end) >= now));
      $(".ca-src", root).textContent = "Quelle: WA7BNM Contest Calendar";
      $("table", root).innerHTML = `<thead><tr><th></th><th>Contest</th><th>Beginn</th><th>Ende</th><th>Zeit (Original)</th></tr></thead><tbody>${rows.map(c => { const run = c.start && Date.parse(c.start) <= now && Date.parse(c.end) >= now, soon = !run && c.start && Date.parse(c.start) - now < 86400e3 && Date.parse(c.start) > now;
        return `<tr class="${run ? "st-new_dxcc" : soon ? "st-new_band" : ""}"><td>${run ? "läuft" : soon ? "bald" : ""}</td><td><a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.name)}</a></td><td>${fmt(c.start)}</td><td>${fmt(c.end)}</td><td>${esc(c.when)}</td></tr>`; }).join("") || `<tr><td colspan="5" class="hint">Keine Einträge</td></tr>`}</tbody>`;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const rows = data.dx.filter(x => (!onlyNow || (x.start <= today && x.end >= today)) && (!need || x.needed));
      $(".ca-src", root).textContent = "Quelle: NG3K ADXO";
      $("table", root).innerHTML = `<thead><tr><th></th><th>Rufzeichen</th><th>Land</th><th>Zeitraum</th><th>QSL</th><th>Info</th></tr></thead><tbody>${rows.map(x => { const run = x.start <= today && x.end >= today;
        return `<tr class="${x.needed ? "st-new_dxcc" : ""}" data-call="${esc(x.call)}"><td>${run ? "QRV" : ""}${x.needed ? " neu" : ""}</td><td class="call">${esc(x.call)}</td><td>${esc(x.entity)}</td><td>${esc(x.dates)}</td><td>${esc(x.qsl)}</td><td class="msg">${esc(x.info)}</td></tr>`; }).join("") || `<tr><td colspan="6" class="hint">Keine Einträge</td></tr>`}</tbody>`;
    } };
  root.addEventListener("click", e => { const b = e.target.closest(".pane-tb button[data-k]"); if (b) { kind = b.dataset.k; root.querySelectorAll(".pane-tb button[data-k]").forEach(x => x.classList.toggle("on", x === b)); draw(); return; }
    const tr = e.target.closest("tr[data-call]"); if (tr) WW.emit("dx", { call: tr.dataset.call.split("/")[0] }); });
  root.addEventListener("change", draw);
  api("/api/calendar").then(r => { data = r; draw(); }).catch(e => { $("table", root).innerHTML = `<tr><td class="err">${esc(e.message)}</td></tr>`; });
}

// ---------- DX-Histogramm ----------
function createHistogram(root) {
  root.innerHTML = `<canvas class="hg"></canvas><div class="hint">Spots der letzten Zeit je Band und Stunde (UTC) – wo ist etwas los?</div>`;
  const draw = () => { const cv = $(".hg", root), W = cv.width = cv.clientWidth, H = cv.height = Math.max(80, cv.clientHeight), c = cv.getContext("2d");
    const bands = ["160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"], now = Date.now() / 1000, cnt = {}; let mx = 1;
    WW.spots.forEach(s => { const hh = Math.floor((now - (s.ts || now)) / 3600); if (hh > 23 || !bands.includes(s.band)) return; const k = s.band + ":" + hh; cnt[k] = (cnt[k] || 0) + 1; mx = Math.max(mx, cnt[k]); });
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim(); c.fillRect(0, 0, W, H);
    const cw = (W - 40) / 24, ch = (H - 14) / bands.length; c.font = "10px system-ui";
    bands.forEach((b, i) => { c.fillStyle = "#555"; c.fillText(b, 2, 12 + i * ch + ch / 2); for (let hh = 0; hh < 24; hh++) { const v = (cnt[b + ":" + hh] || 0) / mx; if (!v) continue; c.fillStyle = `rgba(214,40,40,${0.15 + v * 0.85})`; c.fillRect(40 + (23 - hh) * cw, 4 + i * ch, cw - 1, ch - 1); } });
    c.fillStyle = "#555"; c.fillText("−24 h", 40, H - 2); c.fillText("jetzt", W - 28, H - 2); };
  const ro = new ResizeObserver(draw); ro.observe(root); const offs = [WW.on("spot", draw), WW.on("spots", draw)]; draw();
  return () => { ro.disconnect(); offs.forEach(f => f()); };
}

// ---------- Bandkarte (senkrecht) ----------
function createBandMap(root) {
  const bands = ["160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m"];
  root.innerHTML = `<div class="bm-wrap"><canvas class="bm"></canvas></div><div class="bm-tabs">${bands.map(b => `<button data-b="${b}">${b}</button>`).join("")}</div>`;
  let band = store.get("bm.band", "20m"), follow = true, hits = [];
  const draw = () => { const cv = $(".bm", root), W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight, c = cv.getContext("2d");
    if (follow && bandFor(WW.rig.freq)) band = bandFor(WW.rig.freq);
    $$(".bm-tabs button", root).forEach(b => b.classList.toggle("on", b.dataset.b === band));
    const bd = WW.bands.find(b => b.name === band); if (!bd) return; const lo = bd.lo, hi = bd.hi, y = f => 10 + (f - lo) / (hi - lo) * (H - 20);
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim(); c.fillRect(0, 0, W, H);
    c.fillStyle = "#c9a227"; c.fillRect(70, 10, 4, H - 20); c.font = "10px system-ui"; c.fillStyle = "#555";
    const st = (hi - lo) > 1e6 ? 250000 : (hi - lo) > 300000 ? 50000 : 25000;
    for (let f = Math.ceil(lo / st) * st; f <= hi; f += st) { c.fillText((f / 1000).toFixed(0), 30, y(f) + 3); c.fillRect(64, y(f), 6, 1); }
    const sp = WW.spots.filter(s => s.freq >= lo && s.freq <= hi).sort((a, b) => a.freq - b.freq); const seen = new Set(); let lastY = -99; hits = [];
    c.font = "bold 13px system-ui";
    sp.forEach(s => { if (seen.has(s.call)) return; seen.add(s.call); const yy = Math.max(y(s.freq), lastY + 15); lastY = yy;
      c.strokeStyle = "#999"; c.beginPath(); c.moveTo(74, y(s.freq)); c.lineTo(96, yy - 4); c.stroke();
      c.fillStyle = s.status === "new_dxcc" ? "#d62828" : s.status === "new_band" ? "#c77800" : s.status === "worked" ? "#888" : "#111"; c.fillText(s.call, 100, yy); hits.push([yy, s]); });
    cv._hits = hits;
    if (WW.rig.freq >= lo && WW.rig.freq <= hi) { const yy = y(WW.rig.freq); c.fillStyle = "#1f5fae"; c.font = "bold 12px system-ui"; c.fillText("M→", 44, yy + 4); }
  };
  root.addEventListener("click", e => { const b = e.target.closest("[data-b]"); if (b) { band = b.dataset.b; follow = false; store.set("bm.band", band); draw(); return; }
    if (e.target.classList.contains("bm")) { const r = e.target.getBoundingClientRect(), yy = e.clientY - r.top, h = hits.find(([y]) => Math.abs(y - 5 - yy) < 8); if (h) tuneSpot(h[1].freq, h[1].call, h[1].comment); } });
  const ro = new ResizeObserver(draw); ro.observe(root); const offs0 = WW.on("bm-follow", () => { follow = true; draw(); }); const offs = [WW.on("spot", draw), WW.on("spots", draw), WW.on("rig", draw)]; draw();
  return () => { ro.disconnect(); offs0(); offs.forEach(f => f()); };
}

// ---------- Graulinie, Uhr, Rotor ----------
function createGreyline(root) {   // Graulinie: fotorealistische Erde, Globus oder Karte, eigener Standort und DX-Bogen
  const E = wwEarth(root, { mode: store.get("gl.mode", "globe"), modes: [["globe", "Globus"], ["flat", "Karte"]], grid: "latlon", onMode: m => store.set("gl.mode", m) });
  let dx = null;
  const upd = () => { E.points = [...(WW.home ? [{ lat: WW.home[0], lon: WW.home[1], color: "#2bd4ff", r: 3.5, pulse: true, tip: WW.settings.callsign || "" }] : []),
      ...(dx ? [{ lat: dx.lat, lon: dx.lon, color: "#ff4fd8", r: 3.5, label: dx.call, tip: `${dx.call} · ${dx.country || ""}` }] : [])];
    E.arcs = dx && WW.home ? [{ from: WW.home, to: [dx.lat, dx.lon], color: "#ff4fd8" }] : []; E.redraw(); };
  const offs = [WW.on("dx", d => { dx = d?.lat != null ? d : null; upd(); }), WW.on("settings", upd), WW.on("state", upd)]; upd();
  return () => { offs.forEach(f => f()); E.destroy(); };
}
function createClock(root) {
  root.innerHTML = `<div class="clk"><div class="clk-t"></div><div class="clk-s"></div></div>`;
  let utc = store.get("clk.utc", true);
  const t = setInterval(() => { const n = new Date(); $(".clk-t", root).textContent = utc ? n.toISOString().slice(11, 19) : n.toLocaleTimeString(I18N.locale); $(".clk-s", root).textContent = (utc ? "UTC · " : "Ortszeit · ") + n.toLocaleDateString(I18N.locale); }, 500);
  root.onclick = () => { utc = !utc; store.set("clk.utc", utc); };
  return () => clearInterval(t);
}
function dialGauge(cv, az, target, label) {   // Holo-Skala: leuchtender Ring, Teilung, Ziel gestrichelt, Antennenrichtung als Lichtstrahl
  const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio, c = cv.getContext("2d"); c.scale(devicePixelRatio, devicePixelRatio);
  const w = cv.clientWidth, hh = cv.clientHeight, r = Math.min(w, hh) / 2 - 10, cx = w / 2, cy = hh / 2;
  if (r < 20) return;
  const pt = (a, k) => { const rad = (a - 90) * Math.PI / 180; return [cx + Math.cos(rad) * r * k, cy + Math.sin(rad) * r * k]; };
  const bg = c.createRadialGradient(cx, cy, r * .1, cx, cy, r); bg.addColorStop(0, "#0b2238"); bg.addColorStop(1, "#030b14");
  c.fillStyle = bg; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.fill();
  c.shadowColor = "#2bd4ff"; c.shadowBlur = 14; c.strokeStyle = "rgba(90,210,255,.9)"; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
  c.shadowBlur = 0; c.strokeStyle = "rgba(90,210,255,.25)"; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, r * .72, 0, 7); c.stroke(); c.beginPath(); c.arc(cx, cy, r * .4, 0, 7); c.stroke();
  c.font = `${Math.max(9, r * .1)}px "Share Tech Mono", monospace`; c.textAlign = "center"; c.textBaseline = "middle";
  for (let a = 0; a < 360; a += 5) { const big = a % 30 === 0, mid = a % 10 === 0, [x1, y1] = pt(a, .97), [x2, y2] = pt(a, big ? .86 : mid ? .9 : .93);
    c.strokeStyle = big ? "rgba(160,235,255,.95)" : "rgba(90,210,255,.45)"; c.lineWidth = big ? 1.6 : 1; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    if (big) { const [tx, ty] = pt(a, .76); c.fillStyle = "rgba(170,235,255,.85)"; c.fillText(a % 90 === 0 && label === "Azimut" ? { 0: "N", 90: I18N.lang === "de" ? "O" : "E", 180: "S", 270: "W" }[a] : a, tx, ty); } }
  if (target != null) { const [tx, ty] = pt(target, .95); c.strokeStyle = "#ff4fd8"; c.shadowColor = "#ff4fd8"; c.shadowBlur = 10; c.setLineDash([5, 5]); c.lineWidth = 1.6; c.beginPath(); c.moveTo(cx, cy); c.lineTo(tx, ty); c.stroke(); c.setLineDash([]); c.shadowBlur = 0; }
  if (az != null) { const a = az * Math.PI / 180, wd = 14 * Math.PI / 180, g = c.createRadialGradient(cx, cy, 0, cx, cy, r * .96);
    g.addColorStop(0, "rgba(43,212,255,.45)"); g.addColorStop(1, "rgba(43,212,255,0)"); c.fillStyle = g; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r * .96, a - wd - Math.PI / 2, a + wd - Math.PI / 2); c.closePath(); c.fill();
    const [ex, ey] = pt(az, .95); c.strokeStyle = "#bff8ff"; c.shadowColor = "#2bd4ff"; c.shadowBlur = 16; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, cy); c.lineTo(ex, ey); c.stroke(); c.shadowBlur = 0; }
  c.fillStyle = "#081a2b"; c.strokeStyle = "rgba(90,210,255,.6)"; c.beginPath(); c.arc(cx, cy, r * .2, 0, 7); c.fill(); c.stroke();
  c.fillStyle = "#dffaff"; c.shadowColor = "#2bd4ff"; c.shadowBlur = 12; c.font = `${Math.max(12, r * .17)}px "Share Tech Mono", monospace`;
  c.fillText(az != null ? String(Math.round(((az % 360) + 360) % 360)).padStart(3, "0") + "°" : "---", cx, cy - r * .3); c.shadowBlur = 0;
  c.fillStyle = "rgba(140,220,255,.75)"; c.font = `${Math.max(9, r * .085)}px "Share Tech Mono", monospace`; c.fillText(I18N.t(label).toUpperCase(), cx, cy + r * .3);
  cv._geom = { cx, cy };
}
function createRotorPane(root) {
  root.innerHTML = `<div class="pane-tb"><button data-a="conn">${icon("i-plug")} Verbinden</button><button data-a="opt">${icon("i-gear")} Optionen</button><button data-a="stop">Stopp</button></div><canvas class="dial"></canvas>`;
  const cv = $(".dial", root);
  const draw = () => dialGauge(cv, WW.rotor.connected ? WW.rotor.az : null, WW.rotor.target, "Azimut");
  cv.addEventListener("click", e => { const g = cv._geom; if (!g) return; const r = cv.getBoundingClientRect(); rotorSet((Math.atan2(e.clientX - r.left - g.cx, -(e.clientY - r.top - g.cy)) * 180 / Math.PI + 360) % 360); });
  root.addEventListener("click", e => { const b = e.target.closest(".pane-tb button"); if (!b) return; if (b.dataset.a === "stop") act("/api/rotor/stop", {}); else openRotorConnect(); });
  const ro = new ResizeObserver(draw); ro.observe(root); const off = WW.on("rotor", draw); draw(); return () => { ro.disconnect(); off(); };
}

// ---------- Programm Logbuch ----------
APPS.log = {
  title: "Logbuch", icon: "i-book",
  panels: {
    logbook: { title: "Mein Logbuch", create: createLogbook },
    lookup: { title: "Rufzeichen-Info", create: createLookup, dock: { ref: "logbook", dir: "left" }, size: { width: 330 } },
    favorites: { title: "Favoriten", create: createSelection, dock: { ref: "lookup", dir: "within" } },
    radiopane: { title: "Gerätestatus", create: createRadioPane, dock: { ref: "lookup", dir: "within" } },
    recorder: { title: "Audio-Rekorder", create: createRecorder, dock: { ref: "lookup", dir: "below" } },
    netserver: { title: "Netzwerk", create: createNetServer, dock: { ref: "recorder", dir: "within" } },
    solar30: { title: "30-Tage-Sonnendaten", create: createSolar30, dock: { ref: "logbook", dir: "below" } },
    solarcycle: { title: "Sonnenzyklus", create: createSolarCycle, dock: { ref: "solar30", dir: "within" } },
    audiomon: { title: "Audio-Monitor", create: createAudioMon, dock: { ref: "solar30", dir: "within" } },
    cluster: { title: "DX-Cluster", create: createCluster, dock: { ref: ["solar30", "logbook"], dir: "within" } },
    alert: { title: "Spot-Alarm (FT8)", create: createAlert, dock: { ref: ["cluster", "solar30"], dir: "within" } },
    histogram: { title: "DX-Histogramm", create: createHistogram, dock: { ref: ["cluster", "solar30"], dir: "within" } },
    bandmap: { title: "Bandkarte", create: createBandMap, dock: { ref: "logbook", dir: "right" }, size: { width: 240 } },
    greyline: { title: "Graulinie", create: createGreyline, dock: { ref: "logbook", dir: "right" } },
    clock: { title: "Uhr", create: createClock, dock: { ref: "greyline", dir: "right" } },
    rotator: { title: "Rotor", create: createRotorPane, dock: { ref: "bandmap", dir: "below" } },
    calendar: { title: "Kalender", create: createCalendar, dock: { ref: ["histogram", "cluster"], dir: "within" } },
    programs: { title: "POTA / SOTA / WWFF", create: createPrograms, dock: { ref: ["cluster", "alert"], dir: "within" } },
    ale: { title: "Neuer Eintrag", create: createAle, dock: { dir: "within" } },
    awards: { title: "Diplome", create: (...a) => createAwards(...a), dock: { ref: "logbook", dir: "within" } },
    qsl: { title: "QSL & Online", create: (...a) => createQslPanel(...a), dock: { ref: "logbook", dir: "within" } },
    stats: { title: "Statistik", create: (...a) => createStats(...a), dock: { ref: "logbook", dir: "within" } },
  },
  layout(dv, cls = "m") {   // eigene Anordnung: Logbuch gross, Rufzeichen-Info rechts; unten Cluster | Bandkarte | Graulinie (klein: weniger Spalten, gross: Uhr, Rotor, Histogramm)
    const T = c => APPS.log.panels[c].title, add = (c, ref, dir, extra = {}) => dv.addPanel({ id: c, component: c, title: T(c), position: { referencePanel: ref, direction: dir }, ...extra });
    const lb = dv.addPanel({ id: "logbook:" + WW.logbook, component: "logbook", title: WW.logbook, params: { name: WW.logbook } });
    const lk = add("lookup", lb.id, "right");
    add("favorites", "lookup", "within"); add("radiopane", "lookup", "within");
    lk.api.setActive();
    const cl = add("cluster", lb.id, "below");
    ["alert", "programs", "calendar"].concat(cls === "l" ? ["histogram"] : []).forEach(c => add(c, "cluster", "within"));
    if (cls === "s") {   // klein: Bandkarte und Graulinie als Reiter beim Cluster, kein drittes Fensterpaar
      ["bandmap", "greyline", "solar30"].forEach(c => add(c, "cluster", "within"));
      cl.api.setActive();
      setTimeout(() => { try { lk.group.api.setSize({ width: 300 }); cl.group.api.setSize({ height: 250 }); } catch { } }, 80);
      return;
    }
    cl.api.setActive();
    const bm = add("bandmap", "cluster", "right");
    const gl = add("greyline", "bandmap", "right");
    ["solar30", "solarcycle"].forEach(c => add(c, "greyline", "within"));
    gl.api.setActive();
    if (cls === "l") { add("clock", "greyline", "right"); add("rotator", "lookup", "below"); add("recorder", "rotator", "within"); dv.getPanel("rotator").api.setActive(); }
    setTimeout(() => { try { lk.group.api.setSize({ width: cls === "l" ? 400 : 340 }); cl.group.api.setSize({ height: cls === "l" ? 400 : 320 }); bm.group.api.setSize({ width: cls === "l" ? 300 : 260 }); gl.group.api.setSize({ width: cls === "l" ? 520 : 340 });
      if (cls === "l") { dv.getPanel("clock").group.api.setSize({ width: 300 }); dv.getPanel("rotator").group.api.setSize({ height: 330 }); } } catch { } }, 80);
  },
  menus: [
    { label: "Datei", items: [{ label: "Logbücher verwalten …", icon: "i-book", act: logbookManager }, { label: "ADIF importieren …", act: () => adifImport(WW.logbook) }, { label: "ADIF exportieren", act: () => location.href = `/api/adif?${logq()}` },
      { label: "Cabrillo-Export …", act: cabrilloDialog }, "-", { label: "Sicherung jetzt", act: async () => toast("Gesichert: " + (await post("/api/logbooks/backup", { name: WW.logbook })).file) }, { label: "Sicherungen …", act: backupsDialog }, "-",
      { label: "Logbuch drucken", act: () => window.open(`/print/log?${logq()}`, "_blank") }, { label: "QSL-Etiketten drucken (vorgemerkt/ungesendet)", act: () => window.open(`/print/labels?${logq("qsl=to_send")}`, "_blank") }] },
    { label: "Bearbeiten", items: [{ label: "Neuer Eintrag …", key: "Strg+N", act: () => openAle() }, { label: "Spot senden …", act: () => spotDialog() }, "-", { label: "VFO A abstimmen …", icon: "i-tune", act: () => tunePopup("VFOA") }, { label: "VFO B abstimmen …", icon: "i-tune", act: () => tunePopup("VFOB") }] },
    { label: "Ansicht", items: Object.entries({ lookup: "Rufzeichen-Info", favorites: "Favoriten", radiopane: "Gerätestatus", recorder: "Audio-Rekorder", netserver: "Netzwerk", solar30: "30-Tage-Sonnendaten", solarcycle: "Sonnenzyklus", audiomon: "Audio-Monitor", cluster: "DX-Cluster", alert: "Spot-Alarm (FT8)", histogram: "DX-Histogramm", bandmap: "Bandkarte", greyline: "Graulinie", clock: "Uhr", rotator: "Rotor", calendar: "Kalender", programs: "POTA / SOTA / WWFF", awards: "Diplome", qsl: "QSL & Online", stats: "Statistik" })
      .map(([k, l]) => ({ label: l, check: () => panelOpen("log", k), act: () => togglePanel("log", k) })) },
    { label: "QSO & QSL", items: [{ label: "Logbücher verwalten …", icon: "i-book", act: logbookManager }, { label: "QSL & Online-Dienste", act: () => addPanel("log", "qsl") }, { label: "LoTW abgleichen", act: async () => { try { const r = await post("/api/sync/confirmations?" + logq(), { service: "lotw" }); toast(`LoTW: ${r.matched} zugeordnet`); } catch (e) { toast(e.message, true); } } },
      { label: "eQSL abgleichen", act: async () => { try { const r = await post("/api/sync/confirmations?" + logq(), { service: "eqsl" }); toast(`eQSL: ${r.matched} zugeordnet`); } catch (e) { toast(e.message, true); } } }, "-", { label: "Diplome / DXCC-Matrix", act: () => addPanel("log", "awards") }, { label: "Statistik", act: () => addPanel("log", "stats") }, { label: "Länderliste aktualisieren", act: () => toast("Die Länderliste (cty) wird alle 14 Tage automatisch aktualisiert") }] },
    { label: "Werkzeuge", items: [{ label: "Einstellungen …", icon: "i-gear", key: "F8", act: () => openOptions() }, { label: "Stationsprofile …", icon: "i-radio", act: () => stationsDialog() },
      { label: "POTA / SOTA / WWFF", icon: "i-tower", act: () => addPanel("log", "programs") }, { label: "Cluster-Alarme …", act: alarmsDialog }, { label: "Rotor verbinden …", act: () => openRotorConnect() }, "-",
      { label: "Kalender (Contests, DXpeditionen)", act: () => addPanel("log", "calendar") }, { label: "Contest-Kalender (WA7BNM) öffnen", act: () => window.open("https://www.contestcalendar.com/weeklycont.php", "_blank") }, { label: "DX-Kalender (NG3K) öffnen", act: () => window.open("https://www.ng3k.com/Misc/adxo.html", "_blank") }] },
    MENU_WINDOW("log"), MENU_HELP,
  ],
  toolbar: [
    { label: "Logbücher", icon: "i-book", act: logbookManager }, { label: "Neuer Eintrag", icon: "i-plus", title: "Neues QSO (Strg+N)", act: () => openAle() }, "|",
    { label: "DX-Cluster", icon: "i-globe", act: () => togglePanel("log", "cluster"), on: () => panelOpen("log", "cluster") },
    { label: "Spot-Alarm", icon: "i-bell", act: () => togglePanel("log", "alert"), on: () => panelOpen("log", "alert") },
    { label: "QSL & Online", icon: "i-cloud", act: () => togglePanel("log", "qsl"), on: () => panelOpen("log", "qsl") },
    { label: "Diplome", icon: "i-award", act: () => togglePanel("log", "awards"), on: () => panelOpen("log", "awards") }, "|",
    { label: "Einstellungen", icon: "i-gear", act: () => openOptions() }, "->",
    { html: `<div class="ribbon-box rb-stat" title="Klick auf die Frequenz: VFO A abstimmen"><b class="rb-c"></b><span class="rb-f"></span><span class="rb-t"></span></div>`, init: el => {
      const u = () => { el.querySelector(".rb-c").textContent = [WW.settings.callsign || "—", WW.settings.locator].filter(Boolean).join(" · "); el.querySelector(".rb-f").textContent = WW.rig.freq ? `${fmtDots(WW.rig.freq)} ${WW.rig.mode || ""}` : ""; };
      u(); WW.on("settings", u); WW.on("state", u); WW.on("rig", u); el.querySelector(".rb-f").onclick = () => tunePopup("VFOA");
      setInterval(() => { const t = el.querySelector(".rb-t"); if (t) t.textContent = new Date().toISOString().slice(11, 16) + " UTC"; }, 1000); } },
  ],
};
function tunePopup(vfo) {
  const d = dialog({ title: vfo === "VFOA" ? "VFO A abstimmen" : "VFO B abstimmen", icon: "i-tune", buttons: [["Schließen", "close"]], body: `<div class="rc tune-pop"><div class="rc-fine" data-span="20000"><span class="rc-bl">±10 kHz</span><div class="rc-ruler"></div></div><div class="rc-fine" data-span="2400"><span class="rc-bl">Fein</span><div class="rc-ruler"></div></div></div>`,
    onOpen: dd => { if (vfo === "VFOB") act("/api/rig/vfo", { vfo: "VFOB" }); const rc = $(".rc", dd); applyScheme(rc); rc.querySelectorAll(".rc-ruler").forEach(attachRuler); const r = () => renderBars(rc); r(); const off = WW.on("rig", r);
      dd.addEventListener("close", () => { off(); if (vfo === "VFOB") act("/api/rig/vfo", { vfo: "VFOA" }); }); } });
}
