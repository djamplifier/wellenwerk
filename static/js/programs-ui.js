"use strict";
// Wellenwerk – POTA / SOTA / WWFF: Spots (Jaeger), Aktivierung (Zaehler, Selbst-Spot, Export), Statistik; Stationsprofile

const PRG = { names: { pota: "POTA", sota: "SOTA", wwff: "WWFF" }, spots: [], pending: null, stations: { active: "", list: [] } };
const prgSite = (p, ref) => p === "pota" ? `https://pota.app/#/park/${encodeURIComponent(ref)}` : p === "sota" ? `https://www.sotadata.org.uk/en/summit/${encodeURIComponent(ref)}` : `https://wwff.co/directory/?showRef=${encodeURIComponent(ref)}`;
const prgMode = m => { m = (m || "").toUpperCase(); return m === "SSB" ? null : ["CW", "FM", "AM"].includes(m) ? m : null; };

// Abstimmen auf einen Programm-Spot; die Referenz wird fuer den naechsten Logbuch-Eintrag vorgemerkt
function prgTune(s) {
  setFreq(s.freq); const m = prgMode(s.mode) || (s.mode === "SSB" ? (s.freq < 10e6 ? "LSB" : "USB") : null); if (m) setMode(m);
  PRG.pending = { call: s.call, prog: s.prog, ref: s.ref, freq: s.freq, mode: s.mode === "SSB" || !s.mode ? "SSB" : s.mode, t: Date.now() };
  toast(`${s.call} · ${PRG.names[s.prog]} ${s.ref} – wird beim nächsten Eintrag übernommen`);
}
function prgLog(s) { prgTune(s); switchApp("log"); setTimeout(() => { openAle(); setTimeout(() => WW.emit("prefill", { call: s.call, freq: s.freq, mode: PRG.pending.mode, [s.prog]: s.ref }), 150); }, 100); }

// Referenzsuche mit Vorschlagsliste an einem Eingabefeld
function prgRefInput(inp, prog) {
  let box = null, t = 0;
  const close = () => { box?.remove(); box = null; };
  inp.addEventListener("input", () => { clearTimeout(t); const q = inp.value.trim(); if (q.length < 2) return close();
    t = setTimeout(async () => { try { const r = await api(`/api/programs/refs?prog=${prog}&q=${encodeURIComponent(q.split(/[,\s]+/).pop())}`); close(); if (!r.refs.length) return;
      box = document.createElement("div"); box.className = "prg-suggest"; const Z = uiZ(), rc = inp.getBoundingClientRect(); box.style.left = rc.left / Z + "px"; box.style.top = rc.bottom / Z + 2 + "px"; box.style.minWidth = Math.max(rc.width / Z, 320) + "px";
      box.innerHTML = r.refs.map(x => `<button type="button" data-r="${esc(x.ref)}"><b>${esc(x.ref)}</b> ${esc(x.name)} <small>${esc(x.loc || "")}${x.active === false ? " · inaktiv" : ""}</small></button>`).join("");
      box.onmousedown = e => { const b = e.target.closest("[data-r]"); if (!b) return; e.preventDefault(); const parts = inp.value.split(/,\s*/); parts[parts.length - 1] = b.dataset.r; inp.value = parts.join(", "); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); close(); };
      document.body.appendChild(box); } catch { } }, 250); });
  inp.addEventListener("blur", () => setTimeout(close, 150));
}

function createPrograms(root) {
  const p0 = store.get("prg.filter", { pota: true, sota: true, wwff: true, onlyNew: false, band: "", mode: "" });
  root.innerHTML = `<div class="pane-tb"><span class="seg2"><button data-v="spots" class="on">Spots</button><button data-v="act">Aktivierung</button><button data-v="stat">Statistik</button></span>
    <span class="prg-f">${["pota", "sota", "wwff"].map(p => `<label class="chk"><input type="checkbox" data-p="${p}" ${p0[p] ? "checked" : ""}> ${PRG.names[p]}</label>`).join("")}
    <select class="prg-band"><option value="">alle Bänder</option>${WW.bands.map(b => `<option ${b.name === p0.band ? "selected" : ""}>${b.name}</option>`).join("")}</select>
    <select class="prg-mode"><option value="">alle Modes</option>${["SSB", "CW", "FT8", "FT4", "FM", "DATA"].map(m => `<option ${m === p0.mode ? "selected" : ""}>${m}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" class="prg-new" ${p0.onlyNew ? "checked" : ""}> nur neue Referenzen</label></span><button class="prg-ref" title="Aktualisieren">${icon("i-refresh")}</button><span class="hint prg-st"></span></div>
    <div class="prg-view" data-v="spots"><div class="tablewrap"><table class="grid prg-t"><thead><tr><th>Zeit</th><th>Prog.</th><th>Rufzeichen</th><th>Referenz</th><th>Name</th><th>Frequenz</th><th>Mode</th><th>Kommentar</th></tr></thead><tbody></tbody></table></div></div>
    <div class="prg-view hidden" data-v="act"></div><div class="prg-view hidden" data-v="stat"></div>`;
  const st = t => $(".prg-st", root).textContent = t;
  const filt = () => { const f = { onlyNew: $(".prg-new", root).checked, band: $(".prg-band", root).value, mode: $(".prg-mode", root).value }; for (const p of ["pota", "sota", "wwff"]) f[p] = root.querySelector(`[data-p="${p}"]`).checked; store.set("prg.filter", f); return f; };
  const age = t => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`; };
  const draw = () => { const f = filt(), mm = m => !f.mode || (f.mode === "DATA" ? !["SSB", "CW", "FM", "AM"].includes(m) : m === f.mode);
    const rows = PRG.spots.filter(s => f[s.prog] && (!f.band || s.band === f.band) && mm(s.mode) && (!f.onlyNew || !s.worked_ref));
    $(".prg-t tbody", root).innerHTML = rows.map(s => `<tr data-id="${esc(s.id)}" class="${!s.worked_ref ? "st-new_dxcc" : s.worked_call ? "st-worked" : ""}" title="Klick: abstimmen · Doppelklick: Logbuch-Eintrag">
      <td class="nowrap">${age(s.time)}</td><td>${PRG.names[s.prog]}</td><td class="call">${esc(s.call)}</td><td class="mono">${esc(s.ref)}</td><td>${esc(s.name)}${s.loc ? ` <small>${esc(s.loc)}</small>` : ""}</td>
      <td class="mono">${fmtMHz(s.freq)}</td><td>${esc(s.mode)}</td><td class="msg">${esc(s.comment)}</td></tr>`).join("") || `<tr><td colspan="8" class="hint">Keine Spots für diesen Filter.</td></tr>`;
    st(`${rows.length} von ${PRG.spots.length} Spots · rot = noch nicht gearbeitete Referenz`); };
  const load = async () => { try { const r = await api("/api/programs/spots"); PRG.spots = r.spots; draw(); } catch (e) { st(e.message); } };
  const byId = id => PRG.spots.find(s => s.id === id);
  root.addEventListener("click", e => { const v = e.target.closest(".seg2 [data-v]"); if (v) { root.querySelectorAll(".seg2 [data-v]").forEach(b => b.classList.toggle("on", b === v)); root.querySelectorAll(".prg-view").forEach(x => x.classList.toggle("hidden", x.dataset.v !== v.dataset.v)); $(".prg-f", root).classList.toggle("hidden", v.dataset.v !== "spots");
      if (v.dataset.v === "act") drawAct(); if (v.dataset.v === "stat") drawStat(); return; }
    const tr = e.target.closest(".prg-t tr[data-id]"); if (tr) prgTune(byId(tr.dataset.id)); });
  root.addEventListener("dblclick", e => { const tr = e.target.closest(".prg-t tr[data-id]"); if (tr) prgLog(byId(tr.dataset.id)); });
  root.addEventListener("change", e => { if (e.target.closest(".prg-f")) draw(); });
  $(".prg-ref", root).onclick = load;
  // ---- Aktivierung ----
  const actEl = $('.prg-view[data-v="act"]', root);
  const drawAct = async () => {
    const S = await api("/api/stations").catch(() => ({ active: "", list: [] })); PRG.stations = S; const cur = S.list.find(x => x.id === S.active);
    const refs = cur ? ["pota", "sota", "wwff"].filter(p => cur[`my_${p}_ref`]).map(p => [p, cur[`my_${p}_ref`]]) : [];
    actEl.innerHTML = `<div class="prg-act"><div class="ctl-row"><label>Stationsprofil <select class="pa-st"><option value="">– Heimstation (Programmoptionen) –</option>${S.list.map(x => `<option value="${esc(x.id)}" ${x.id === S.active ? "selected" : ""}>${esc(x.name || x.callsign)}</option>`).join("")}</select></label>
      <button class="pa-edit">${icon("i-edit")} Profile bearbeiten …</button></div>
      ${cur ? `<p>Aktiv: <b>${esc(cur.callsign || WW.settings.callsign)}</b> · ${esc(cur.locator || "")} ${refs.map(([p, r]) => `· <b>${PRG.names[p]} ${esc(r)}</b>`).join(" ")} – wird in jeden neuen Logbuch-Eintrag übernommen.</p>` : `<p class="hint">Für eine Aktivierung ein Stationsprofil mit eigener Park-, Gipfel- oder WWFF-Referenz anlegen und auswählen.</p>`}
      <div class="prg-cnt">${refs.map(([p, r]) => `<div class="cnt" data-p="${p}" data-r="${esc(r)}"><b>${PRG.names[p]} ${esc(r)}</b><span class="n">…</span></div>`).join("")}</div>
      ${refs.some(([p]) => p === "pota") ? `<fieldset><legend>Selbst-Spot auf pota.app</legend><div class="ctl-row"><label>Frequenz kHz <input class="ss-f" value="${WW.rig.freq ? (WW.rig.freq / 1000).toFixed(1) : ""}" style="width:90px"></label>
        <label>Mode <select class="ss-m">${["SSB", "CW", "FT8", "FT4", "FM", "AM", "RTTY", "PSK31"].map(m => `<option>${m}</option>`).join("")}</select></label><label class="grow">Kommentar <input class="ss-c" placeholder="z. B. QRV, QRT 15 min"></label>
        <button class="primary ss-go">Spot senden</button></div><p class="hint">Der Spot ist für alle Jäger auf pota.app sichtbar.</p></fieldset>` : ""}
      <fieldset><legend>Log für das Portal exportieren</legend><div class="ctl-row"><select class="ex-p">${["pota", "sota", "wwff"].map(p => `<option value="${p}">${PRG.names[p]}</option>`).join("")}</select>
        <input class="ex-r" placeholder="Referenz" value="${esc(refs[0]?.[1] || "")}" style="width:120px"><input class="ex-d" type="date" value="${new Date().toISOString().slice(0, 10)}"><button class="ex-go">${icon("i-download")} Exportieren</button></div>
        <p class="hint">POTA/WWFF: ADIF mit MY_SIG/SIG-Feldern wie von den Portalen erwartet (Dateiname Rufzeichen@Park-Datum). SOTA: CSV-Format der SOTA-Datenbank.</p></fieldset></div>`;
    actEl.querySelectorAll(".cnt").forEach(async c => { const r = await api(`/api/programs/activation?prog=${c.dataset.p}&ref=${encodeURIComponent(c.dataset.r)}`).catch(() => null); if (!r) return;
      c.querySelector(".n").innerHTML = `${r.unique} / ${r.need} QSOs heute${r.valid ? ' <span class="badge worked">gültig ✓</span>' : ""}${r.p2p ? ` · ${r.p2p}× Park-zu-Park` : ""}${r.dupes ? ` · ${r.dupes} doppelt` : ""}`; c.classList.toggle("ok", r.valid); });
    const mm = (WW.rig.mode || "").replace(/^(USB|LSB)$/, "SSB").replace(/^PKT.*/, "FT8"); if ($(".ss-m", actEl) && [...$(".ss-m", actEl).options].some(o => o.value === mm)) $(".ss-m", actEl).value = mm;
    const exP = $(".ex-p", actEl), exR = $(".ex-r", actEl); if (refs[0]) exP.value = refs[0][0]; exP.onchange = () => { const x = refs.find(([p]) => p === exP.value); exR.value = x ? x[1] : ""; };
    $(".pa-st", actEl).onchange = async e => { await api("/api/stations", { method: "PUT", body: { ...PRG.stations, active: e.target.value } }); drawAct(); };
    $(".pa-edit", actEl).onclick = () => stationsDialog(drawAct);
    $(".ss-go", actEl)?.addEventListener("click", async () => { const ref = refs.find(([p]) => p === "pota")[1], f = parseFloat($(".ss-f", actEl).value.replace(",", ".")) * 1000;
      if (!confirm(`POTA-Spot senden: ${cur.callsign || WW.settings.callsign} in ${ref} auf ${$(".ss-f", actEl).value} kHz ${$(".ss-m", actEl).value}?`)) return;
      if (await act2("/api/programs/selfspot", { ref, freq: f, mode: $(".ss-m", actEl).value, comment: $(".ss-c", actEl).value, call: cur.callsign })) toast("Spot gesendet"); });
    $(".ex-go", actEl).onclick = () => { if (!exR.value.trim()) return toast("Referenz fehlt", true); location.href = `/api/programs/export?prog=${exP.value}&ref=${encodeURIComponent(exR.value.trim())}&date=${$(".ex-d", actEl).value.replaceAll("-", "")}`; };
  };
  const act2 = (p, b) => window.act(p, b);
  // ---- Statistik ----
  const stat = $('.prg-view[data-v="stat"]', root);
  const drawStat = async () => { const s = await api("/api/programs/stats").catch(e => { stat.innerHTML = `<div class="err">${esc(e.message)}</div>`; });
    if (!s) return;
    stat.innerHTML = `<div class="prg-stat">${["pota", "sota", "wwff"].map(p => `<div><h3>${PRG.names[p]}</h3><p><b>${s[p].hunted}</b> Referenzen gearbeitet (${s[p].qsos} QSOs) · <b>${s[p].p2p}</b> ${p === "sota" ? "Gipfel-zu-Gipfel" : "Park-zu-Park"}<br>
      <b>${s[p].activations.filter(a => a.valid).length}</b> gültige Aktivierungen von ${s[p].activations.length}</p>
      ${s[p].activations.length ? `<table class="mini"><tr><th>Datum</th><th>Referenz</th><th>QSOs</th><th></th></tr>${s[p].activations.slice(0, 15).map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.ref)}</td><td>${a.qsos}</td><td>${a.valid ? "✓" : ""}</td></tr>`).join("")}</table>` : ""}</div>`).join("")}</div>`; };
  load(); const tm = setInterval(() => { if (!root.querySelector('.prg-view[data-v="spots"]').classList.contains("hidden")) load(); }, 60000);
  const offs = [WW.on("qso", () => setTimeout(load, 500)), WW.on("stations", () => { if (!actEl.classList.contains("hidden")) drawAct(); })];
  return () => { clearInterval(tm); offs.forEach(f => f()); };
}

// ---------- Stationsprofile ----------
async function stationsDialog(cb) {
  const S = await api("/api/stations").catch(() => ({ active: "", list: [] }));
  const row = (x = {}) => `<tr><td><input data-k="name" value="${esc(x.name || "")}" placeholder="z. B. Park DE-0001"></td><td><input data-k="callsign" value="${esc(x.callsign || "")}" placeholder="${esc(WW.settings.callsign || "")}/P" style="width:100px"></td>
    <td><input data-k="locator" value="${esc(x.locator || "")}" style="width:80px"></td><td><input data-k="my_pota_ref" value="${esc(x.my_pota_ref || "")}" placeholder="DE-0001" style="width:110px"></td>
    <td><input data-k="my_sota_ref" value="${esc(x.my_sota_ref || "")}" placeholder="DM/BW-001" style="width:100px"></td><td><input data-k="my_wwff_ref" value="${esc(x.my_wwff_ref || "")}" placeholder="DLFF-0001" style="width:100px"></td>
    <td><input data-k="tx_pwr" value="${esc(x.tx_pwr || "")}" style="width:50px"></td><td><input data-k="operator" value="${esc(x.operator || "")}" style="width:80px"></td><td><input type="hidden" data-k="id" value="${esc(x.id || "")}"><button type="button" class="danger st-del">×</button></td></tr>`;
  const d = dialog({ title: "Stationsprofile", icon: "i-radio", wide: true, buttons: [["Abbrechen", "close"], ["Speichern", "ok", "primary"]], body: `
    <p class="hint">Ein Profil je Standort (Heimstation, Park, Gipfel, Urlaub). Rufzeichen, Locator, Leistung und eigene Referenzen werden in jeden neuen Eintrag übernommen. Mehrere Parks gleichzeitig (N-fer): mit Komma trennen.</p>
    <table class="mini st-t"><thead><tr><th>Name</th><th>Rufzeichen</th><th>Locator</th><th>POTA-Park</th><th>SOTA-Gipfel</th><th>WWFF</th><th>W</th><th>Operator</th><th></th></tr></thead><tbody>${S.list.map(row).join("")}</tbody></table>
    <div class="ctl-row"><button type="button" class="st-add">+ Profil</button><label>Aktiv <select class="st-act"><option value="">– Heimstation –</option>${S.list.map(x => `<option value="${esc(x.id)}" ${x.id === S.active ? "selected" : ""}>${esc(x.name || x.callsign)}</option>`).join("")}</select></label></div>` });
  const tb = $(".st-t tbody", d);
  const wire = tr => { prgRefInput(tr.querySelector('[data-k="my_pota_ref"]'), "pota"); prgRefInput(tr.querySelector('[data-k="my_sota_ref"]'), "sota"); prgRefInput(tr.querySelector('[data-k="my_wwff_ref"]'), "wwff");
    // Park gewaehlt -> Locator und Name vorschlagen
    tr.querySelector('[data-k="my_pota_ref"]').addEventListener("change", async e => { const r = await api(`/api/programs/ref/pota/${encodeURIComponent(e.target.value.split(",")[0].trim())}`).catch(() => null);
      if (r) { const loc = tr.querySelector('[data-k="locator"]'), nm = tr.querySelector('[data-k="name"]'); if (!loc.value && r.grid) loc.value = r.grid; if (!nm.value) nm.value = `${r.ref} ${r.name}`; } }); };
  [...tb.rows].forEach(wire);
  $(".st-add", d).onclick = () => { tb.insertAdjacentHTML("beforeend", row()); wire(tb.lastElementChild); };
  tb.onclick = e => { if (e.target.closest(".st-del")) e.target.closest("tr").remove(); };
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault();
    const list = [...tb.rows].map(tr => Object.fromEntries([...tr.querySelectorAll("[data-k]")].map(i => [i.dataset.k, i.value.trim()]))).filter(x => x.name || x.callsign || x.my_pota_ref || x.my_sota_ref || x.my_wwff_ref);
    try { await api("/api/stations", { method: "PUT", body: { active: $(".st-act", d).value, list } }); d.close(); toast("Stationsprofile gespeichert"); cb && cb(); } catch (err) { toast(err.message, true); } };
}

// Stationsprofile beim Start laden (fuer den Eintrags-Dialog)
fetch("/api/stations").then(r => r.ok ? r.json() : null).then(s => { if (s) { PRG.stations = s; WW.emit("stations", s); } }).catch(() => { });
