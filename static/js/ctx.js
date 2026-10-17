"use strict";
// Wellenwerk – Rechtsklick-Menues fuer alle Bereiche. Jeder Eintrag ruft dieselben Funktionen wie Menue/Werkzeugleiste.

// ---------- gemeinsame Bausteine ----------
function latLonToGrid(lat, lon) {   // Maidenhead-Locator (6 Stellen)
  const x = lon + 180, y = lat + 90, A = "ABCDEFGHIJKLMNOPQRSTUVWX";
  return A[Math.floor(x / 20)] + A[Math.floor(y / 10)] + Math.floor((x % 20) / 2) + Math.floor(y % 10) + A[Math.floor((x % 2) * 12)].toLowerCase() + A[Math.floor((y % 1) * 24)].toLowerCase();
}
WW.on("dx", d => { WW.dxCall = d?.call || ""; });
const ctxCall = c => String(c || "").toUpperCase().split(/\s/)[0];
async function ctxBearing(call) { try { return await api(`/api/lookup/${encodeURIComponent(call)}?${logq()}`); } catch { return null; } }
function callItems(call, extra = {}) {    // alles, was man mit einem Rufzeichen tun kann
  call = ctxCall(call); if (!call) return [];
  return [
    call,
    { label: "Neuer Logbuch-Eintrag mit diesem Rufzeichen", icon: "i-plus", act: () => { switchApp("log"); setTimeout(() => openAle({ call, ...(extra.freq ? { freq: fmtMHz(extra.freq) } : {}), ...(extra.mode ? { mode: extra.mode } : {}) }), 100); } },
    { label: "Nachschlagen (Rufzeichen-Info)", icon: "i-search", act: () => { switchApp("log"); WW.emit("dx", { call }); } },
    { label: "Antenne drehen", icon: "i-compass", sub: [
      { label: "kurzer Weg", act: async () => { const r = await ctxBearing(call); if (r?.bearing != null) rotorSet(r.bearing); else toast("Richtung unbekannt", true); } },
      { label: "langer Weg", act: async () => { const r = await ctxBearing(call); if (r?.bearing != null) rotorSet(r.bearing + 180); else toast("Richtung unbekannt", true); } }] },
    { label: "Im Web", icon: "i-globe", sub: [
      { label: "QRZ.com", act: () => window.open(`https://www.qrz.com/db/${encodeURIComponent(call)}`, "_blank") },
      { label: "HamQTH", act: () => window.open(`https://www.hamqth.com/${encodeURIComponent(call)}`, "_blank") },
      { label: "PSK Reporter", act: () => window.open(`https://pskreporter.info/pskmap.html?callsign=${encodeURIComponent(call)}`, "_blank") },
      { label: "DX-Cluster-Suche (dxwatch)", act: () => window.open(`https://dxwatch.com/dxsd1/s.php?s=0&r=50&cdx=${encodeURIComponent(call)}`, "_blank") }] },
    { label: "Spot an den DX-Cluster …", icon: "i-tower", act: () => spotDialog(call) },
    { label: "Alarm für dieses Rufzeichen", icon: "i-bell", check: () => (store.get("alarms", {}).calls || "").split(/[\s,]+/).includes(call),
      act: () => { const al = store.get("alarms", { newdxcc: true, newband: false, calls: "", sound: true }); const set = new Set((al.calls || "").split(/[\s,]+/).filter(Boolean));
        set.has(call) ? set.delete(call) : set.add(call); al.calls = [...set].join(" "); store.set("alarms", al); toast(set.has(call) ? `Alarm für ${call} an` : `Alarm für ${call} aus`); } },
    { label: "Rufzeichen kopieren", icon: "i-copy", act: () => clipCopy(call) },
  ];
}
function freqItems(f, mode) {
  return [{ label: `Abstimmen auf ${fmtMHz(f)} MHz${mode ? " " + mode : ""}`, icon: "i-tune", act: () => { setFreq(f); if (mode) setMode(mode); } },
    { label: "Frequenz kopieren", icon: "i-copy", act: () => clipCopy(fmtMHz(f)) },
    { label: "Als Favorit speichern …", icon: "i-star", act: async () => { await setFreq(f); addFavoriteDialog(); } }];
}
const modeSub = () => modeList().map(m => ({ label: m, check: WW.rig.mode === m, act: () => setMode(m) }));
const stepSub = () => [1, 10, 50, 100, 250, 500, 1000, 5000, 10000].map(s => ({ label: s >= 1000 ? `${s / 1000} kHz` : `${s} Hz`, check: +(store.get("opts", {}).wheel || 100) === s,
  act: () => { const o = store.get("opts", {}); o.wheel = s; store.set("opts", o); toast(`Abstimmschritt ${s} Hz`); } }));

// ---------- Gerätesteuerung ----------
ctxRegister(".rc-freq, .rp-f", () => [
  { label: "Frequenz eingeben …", key: "Enter", icon: "i-edit", act: freqDialog },
  { label: "Frequenz kopieren", icon: "i-copy", act: () => clipCopy(fmtMHz(WW.rig.freq || 0)) },
  { label: "Frequenz aus Zwischenablage", icon: "i-paste", act: async () => { const t = (await clipRead()).replace(",", ".").trim(); const v = parseFloat(t); if (!(v > 0)) return toast("Keine Frequenz in der Zwischenablage", true); setFreq(v < 1000 ? v * 1e6 : v < 1e6 ? v * 1e3 : v); } },
  "-", { label: "Als Favorit speichern …", icon: "i-star", act: () => addFavoriteDialog() }, { label: "Schnellspeicher", icon: "i-save", act: quickSave },
  { label: "Betriebsart", sub: modeSub() }, { label: "Abstimmschritt (Mausrad)", sub: stepSub() },
  "-", { label: "VFO A ⇄ B tauschen", act: () => act("/api/rig/op", { op: "XCHG" }) }, { label: "A = B", act: () => act("/api/rig/op", { op: "CPY" }) },
  { label: "Split", check: !!WW.rig.split, act: () => act("/api/rig/split", { on: !WW.rig.split }) },
  "-", { label: "Funkgerät verbinden …", icon: "i-plug", act: () => openConnect() }, { label: "Geräte-Informationen", icon: "i-info", act: rigInfo }]);
ctxRegister(".rc-mode", () => ["Betriebsart", ...modeSub()]);
ctxRegister(".rc-sub", () => [{ label: `VFO B: ${fmtMHz(WW.rig.vfob_freq || 0)} MHz`, disabled: true }, { label: "VFO A ⇄ B tauschen", act: () => act("/api/rig/op", { op: "XCHG" }) },
  { label: "A = B", act: () => act("/api/rig/op", { op: "CPY" }) }, { label: "Split", check: !!WW.rig.split, act: () => act("/api/rig/split", { on: !WW.rig.split }) },
  { label: "VFO B kopieren", icon: "i-copy", act: () => clipCopy(fmtMHz(WW.rig.vfob_freq || 0)) }]);
ctxRegister(".rc-btn", el => { const k = el.dataset.k, side = RC.layout?.left.includes(k) ? "left" : "right";
  return [{ label: "Auslösen", act: () => pressButton(k, el) }, "-",
    { label: "Taste nach links / rechts verschieben", act: () => { const L = RC.layout; L[side] = L[side].filter(x => x !== k); L[side === "left" ? "right" : "left"].push(k); saveRigLayout(); } },
    { label: "Taste ausblenden", act: () => { const L = RC.layout; L[side] = L[side].filter(x => x !== k); saveRigLayout(); toast("Ausgeblendet – über „Layout anpassen“ wieder einblenden"); } },
    { label: "Oberfläche bearbeiten …", key: "Strg+F8", icon: "i-brush", act: openCustomize }]; });
ctxRegister(".rc-drop", el => [{ label: "Auswahl öffnen", act: () => dropMenu(el.dataset.k, el) }, { label: "Auswahlliste ausblenden", act: () => { RC.layout.drops = RC.layout.drops.filter(x => x !== el.dataset.k); saveRigLayout(); } },
  { label: "Oberfläche bearbeiten …", icon: "i-brush", act: openCustomize }]);
ctxRegister(".rc-bandbtns [data-band]", el => { const b = el.dataset.band, mem = store.get("bandmem", {})[b];
  return [{ label: `${b} wählen`, act: () => el.click() }, { label: mem ? `Letzte Frequenz ${fmtMHz(mem.f)} ${mem.m || ""} vergessen` : "Keine gespeicherte Frequenz", disabled: !mem,
    act: () => { const m = store.get("bandmem", {}); delete m[b]; store.set("bandmem", m); } }, { label: "Bandspreizung für dieses Band", act: () => { RC.bsp = { band: b, w: 50 }; WW.emit("rc-layout"); } },
    "Bandplan", ...PLAN_NAMES.map(p => ({ label: p[1], check: p[0] === currentPlan().key, act: () => { store.set("rc.plan", p[0]); WW.emit("rc-layout"); } }))]; });
ctxRegister(".rc-ruler", (el, e) => {
  const sp = e.target.closest(".sp"), qs = e.target.closest(".qs");
  if (sp) return [...freqItems(+sp.dataset.f), "-", ...callItems(sp.dataset.call, { freq: +sp.dataset.f })];
  const [lo, hi] = rulerRange(el), r = el.getBoundingClientRect(), f = Math.round((lo + (hi - lo) * (e.clientX - r.left) / r.width) / 100) * 100;
  return [...freqItems(f), qs ? { label: "Diese Schnellspeicher-Marke löschen", act: () => { store.set("qs." + WW.current, store.get("qs." + WW.current, []).filter(q => +q.f !== +qs.dataset.f)); WW.emit("quicksave"); } } : null,
    { label: "Alle Schnellspeicher-Marken löschen", act: () => { store.set("qs." + WW.current, []); WW.emit("quicksave"); } }, "-", { label: "Abstimmschritt (Mausrad)", sub: stepSub() },
    { label: "Feinabstimmung 2 zeigen", check: store.get("rc.fine2", false), act: () => { store.set("rc.fine2", !store.get("rc.fine2", false)); WW.emit("rc-layout"); } }].filter(Boolean);
});
ctxRegister(".rc-smeter, .rc-meters", () => [{ label: "S-Meter kalibrieren …", act: () => openOptions("smeter") }, { label: "Außerband-Warnung …", act: () => openOptions("oob") }]);
ctxRegister(".rc-tab", el => { const id = el.dataset.id, p = WW.radios.find(r => r.id === id) || {};
  return [p.name || "Funkgerät", { label: "Aktivieren", act: () => el.click() }, { label: "Verbindung bearbeiten …", icon: "i-edit", act: () => openConnect(id) },
    { label: "Trennen", act: () => act(`/api/radios/${id}/disconnect`) }, { label: "Neues Funkgerät verbinden …", icon: "i-plug", act: () => openConnect() }, { label: "Geräte-Informationen", icon: "i-info", act: rigInfo }]; });
ctxRegister(".hslider", el => { const n = el.dataset.n, mn = +el.dataset.min, mx = +el.dataset.max;
  const setL = v => act("/api/rig/level", { name: n, value: v });
  return [{ label: "Minimum", act: () => setL(mn) }, { label: "Mitte", act: () => setL((mn + mx) / 2) }, { label: "Maximum", act: () => setL(mx) }, "-",
    { label: "Regler-Satz", sub: [0, 1, 2, 3, 4, 5].map(i => ({ label: `Satz ${i + 1}`, check: RC.layout?.sliders?.active === i, act: () => { RC.layout.sliders.active = i; saveRigLayout(); } })) },
    { label: "Regler anpassen …", icon: "i-brush", act: () => openCustomize("sliders") }]; });
// Favoriten-Baum
ctxRegister(".tr-row.item", el => { const id = +el.dataset.id || el.dataset.id, fav = (el.closest(".sel-body")?._favs || []).find(f => String(f.id) === String(id)); if (!fav) return [];
  return [fav.name, ...freqItems(fav.freq, fav.mode).slice(0, 2), "-",
    { label: "Umbenennen …", icon: "i-edit", act: async () => { const n = prompt("Name", fav.name); if (n) { await api(`/api/favorites/${fav.id}`, { method: "PUT", body: { ...fav, name: n } }); WW.emit("favorites"); } } },
    { label: "In Ordner verschieben …", act: async () => { const g = prompt("Ordner (z. B. 20m/DX)", fav.group || ""); if (g !== null) { await api(`/api/favorites/${fav.id}`, { method: "PUT", body: { ...fav, group: g } }); WW.emit("favorites"); } } },
    { label: "Löschen", icon: "i-x", act: async () => { if (confirm(`Favorit „${fav.name}“ löschen?`)) { await api(`/api/favorites/${fav.id}`, { method: "DELETE" }); WW.emit("favorites"); } } }]; });
ctxRegister(".tr-row.folder", el => { const p = el.dataset.p;
  return [p, { label: "Aktuelle Frequenz hier speichern …", icon: "i-star", act: () => addFavoriteDialog(p) },
    { label: "Ordner umbenennen …", icon: "i-edit", act: async () => { const n = prompt("Neuer Ordnername", p); if (!n || n === p) return; const favs = await favList();
      for (const f of favs.filter(f => (f.group || "") === p || (f.group || "").startsWith(p + "/"))) await api(`/api/favorites/${f.id}`, { method: "PUT", body: { ...f, group: n + (f.group || "").slice(p.length) } }); WW.emit("favorites"); } },
    { label: "Ordner mit Inhalt löschen", icon: "i-x", act: async () => { const favs = (await favList()).filter(f => (f.group || "") === p || (f.group || "").startsWith(p + "/"));
      if (!confirm(`Ordner „${p}“ mit ${favs.length} Favorit(en) löschen?`)) return; for (const f of favs) await api(`/api/favorites/${f.id}`, { method: "DELETE" }); WW.emit("favorites"); } }]; });
ctxRegister(".pane-memories tr[data-ch]", el => { const ch = +el.dataset.ch, root = el.closest(".pane-root"); root._op(ch);
  return [`Kanal ${ch}`, { label: "Abrufen (Speicher → VFO)", icon: "i-tune", act: () => root._do("recall") }, { label: "Aktuelle Einstellung hier speichern (VFO → Speicher)", icon: "i-save", act: () => root._do("store") },
    { label: "Kanal löschen", icon: "i-x", act: () => root._do("clear") }, { label: "Als Favorit übernehmen …", icon: "i-star", act: async () => { await root._do("recall"); addFavoriteDialog(); } }]; });
ctxRegister(".pane-swdata tr[data-k]", el => { const khz = +el.dataset.k, st = el.cells[1]?.textContent || ""; return [st, ...freqItems(khz * 1000, "AM")]; });

// ---------- Logbuch ----------
ctxRegister(".pane-logbook tbody tr[data-id]", el => {
  const root = el.closest(".pane-root"), id = +el.dataset.id, call = el.querySelector(".c-call")?.textContent || "";
  if (!LOGB.sel.has(id)) el.click();                            // Rechtsklick waehlt die Zeile (wie gewohnt)
  const tb = a => () => root.querySelector(`.lb-tb [data-a="${a}"]`)?.click(), ids = () => [...LOGB.sel], n = LOGB.sel.size || 1;
  const get = async () => api(`/api/qso/${id}?${logq()}`);
  return [
    { label: "Bearbeiten …", icon: "i-edit", act: tb("edit") },
    { label: n > 1 ? `${n} QSOs löschen` : "Löschen", icon: "i-x", act: tb("delete") },
    { label: "Auswahl ändern (Feld setzen) …", act: tb("bulk") }, "-",
    { label: "Ausschneiden", icon: "i-cut", act: tb("cut") }, { label: "Kopieren (in anderes Logbuch)", icon: "i-copy", act: tb("copy") }, { label: "Einfügen", icon: "i-paste", disabled: !LOGB.clip, act: tb("paste") },
    { label: "Als ADIF in die Zwischenablage", act: async () => { const q = await get(); clipCopy(Object.entries(q).filter(([k, v]) => v !== "" && v != null && !["id", "created", "updated"].includes(k)).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(" ") + " <eor>"); } },
    "-", { label: "QSL", sub: [{ label: "Papier-QSL gesendet", act: () => bulkAct(ids(), "qsl_sent", tb("refresh")) }, { label: "Papier-QSL vormerken", act: () => bulkAct(ids(), "qsl_queue", tb("refresh")) },
      { label: "Papier-QSL erhalten", act: () => bulkAct(ids(), "qsl_rcvd", tb("refresh")) }, "-", { label: "QSL-Etikett drucken", icon: "i-print", act: () => window.open(`/print/labels?log=${encodeURIComponent(WW.logbook)}&ids=${ids().join(",")}&skip=0`, "_blank") }] },
    { label: "Hochladen", icon: "i-upload", sub: [{ label: "LoTW", act: () => upload("lotw", ids()) }, { label: "eQSL", act: () => upload("eqsl", ids()) }, { label: "QRZ.com", act: () => upload("qrz", ids()) }, { label: "Club Log", act: () => upload("clublog", ids()) }] },
    { label: "Auf QSO-Frequenz abstimmen", icon: "i-tune", act: async () => { const q = await get(); const f = Math.round(parseFloat(q.freq) * 1e6); if (f > 0) { setFreq(f); if (q.mode && !/FT8|FT4|PSK|MFSK|OLIVIA/.test(q.mode)) setMode(q.mode === "SSB" ? (f < 10e6 ? "LSB" : "USB") : q.mode); } else toast("Keine Frequenz im QSO", true); } },
    { label: "Filtern", icon: "i-filter", sub: [
      { label: `nur ${call}`, act: () => { root.querySelector(".lb-find").classList.remove("hidden"); const i = root.querySelector(".lb-q"); i.value = call; i.dispatchEvent(new Event("input", { bubbles: true })); } },
      { label: "nur dieses Band", act: async () => { const q = await get(); root.querySelector(".lb-find").classList.remove("hidden"); const s = root.querySelector(".lb-band"); s.value = q.band || ""; s.dispatchEvent(new Event("change", { bubbles: true })); } },
      { label: "Filter aufheben", act: () => root.querySelector(".lb-clear").click() }] },
    "-", ...callItems(call).slice(1)];
});
ctxRegister(".pane-logbook thead th[data-k]", el => { const k = el.dataset.k, cols = store.get("log.cols", LOG_DEFAULT_COLS), root = el.closest(".pane-root");
  return [(LOG_COLS.find(c => c[0] === k) || [k, k])[1], { label: "Aufsteigend sortieren", act: () => { LOGB.sort = [k, 1]; store.set("log.sort", LOGB.sort); root.querySelector('[data-a="refresh"]').click(); } },
    { label: "Absteigend sortieren", act: () => { LOGB.sort = [k, -1]; store.set("log.sort", LOGB.sort); root.querySelector('[data-a="refresh"]').click(); } }, "-",
    { label: "Spalte ausblenden", disabled: k === "call", act: () => { store.set("log.cols", cols.filter(c => c !== k)); WW.emit("log-cols"); } },
    { label: "Spalten einblenden", sub: LOG_COLS.filter(c => !cols.includes(c[0])).slice(0, 40).map(c => ({ label: c[1], act: () => { const i = cols.indexOf(k); const nc = [...cols]; nc.splice(i + 1, 0, c[0]); store.set("log.cols", nc); WW.emit("log-cols"); } })) },
    { label: "Spalten auswählen …", act: () => root.querySelector('[data-a="cols"]').click() }, { label: "Spaltenbreiten anpassen", act: () => root.querySelector('[data-a="width"]').click() },
    { label: "Standardspalten", act: () => { store.set("log.cols", LOG_DEFAULT_COLS); store.set("log.widths", {}); WW.emit("log-cols"); } }]; });
// DX-Cluster, Alert, Kalender, Bandkarte
ctxRegister(".pane-cluster tr[data-call]", el => { const f = +el.dataset.f, call = el.dataset.call;
  return [...freqItems(f), "-", ...callItems(call, { freq: f }), "-", { label: "Spot kopieren", icon: "i-copy", act: () => clipCopy(`${(f / 1000).toFixed(1)} ${call} ${el.dataset.cmt || ""}`.trim()) },
    { label: "Cluster-Alarme …", icon: "i-bell", act: alarmsDialog }]; });
ctxRegister(".pane-alert tr[data-call]", el => { const id = +el.dataset.id, call = el.dataset.call;
  return [{ label: "In WSJT-X anrufen", icon: "i-radio", disabled: !id, act: () => act("/api/wsjtx/reply", { id }) }, { label: "WSJT-X: Senden stoppen", act: () => act("/api/wsjtx/halt", {}) },
    { label: "Nachricht kopieren", icon: "i-copy", act: () => clipCopy(el.querySelector(".msg")?.textContent || "") }, "-", ...callItems(call)]; });
ctxRegister(".pane-programs tr[data-id]", el => { const sp = PRG.spots.find(x => x.id === el.dataset.id); if (!sp) return [];
  return [`${PRG.names[sp.prog]} ${sp.ref} – ${sp.name}`, { label: "Abstimmen und Referenz vormerken", icon: "i-tune", act: () => prgTune(sp) }, { label: "Logbuch-Eintrag mit Referenz", icon: "i-plus", act: () => prgLog(sp) },
    { label: `${PRG.names[sp.prog]}-Seite der Referenz öffnen`, icon: "i-globe", act: () => window.open(prgSite(sp.prog, sp.ref.split(",")[0]), "_blank") }, { label: "Referenz kopieren", icon: "i-copy", act: () => clipCopy(sp.ref) },
    ...(sp.lat != null && WW.home ? [{ label: "Antenne zur Referenz drehen", icon: "i-compass", act: () => { const b = bearingTo(sp.lat, sp.lon); if (b) rotorSet(b.az); } }] : []), "-", ...callItems(sp.call, { freq: sp.freq }).slice(1)]; });
ctxRegister(".pane-calendar tr[data-call]", el => callItems(el.dataset.call.split("/")[0]));
ctxRegister(".pane-bandmap canvas.bm", (el, e) => { const r = el.getBoundingClientRect(), y = e.clientY - r.top, hit = (el._hits || []).reduce((b, h) => Math.abs(h[0] - 5 - y) < Math.abs((b?.[0] ?? 1e9) - 5 - y) ? h : b, null);
  if (hit && Math.abs(hit[0] - 5 - y) < 12) { const s = hit[1]; return [...freqItems(s.freq), "-", ...callItems(s.call, { freq: s.freq })]; }
  return [{ label: "Bandkarte folgt dem Funkgerät", act: () => WW.emit("bm-follow") }]; });
ctxRegister(".pane-lookup", () => callItems(WW.dxCall || ""));

// ---------- Karten (Graulinie, Weltkarte, Rotor-Karte, Satelliten) ----------
ctxRegister(".leaflet-container", (el, e) => { const m = el._wwmap; if (!m) return [];
  const ll = m.mouseEventToLatLng(e), lat = ll.lat, lon = ((ll.lng + 540) % 360) - 180, loc = latLonToGrid(lat, lon);
  const bt = bearingTo(lat, lon), brg = bt ? bt.az : null;
  return [`${loc} · ${lat.toFixed(2)}°, ${lon.toFixed(2)}°${bt ? ` · ${Math.round(bt.az)}° · ${Math.round(bt.km).toLocaleString(I18N.locale)} km` : ""}`,
    { label: "Antenne hierhin drehen (kurzer Weg)", icon: "i-compass", disabled: brg == null, act: () => rotorSet(brg) },
    { label: "Antenne hierhin drehen (langer Weg)", disabled: brg == null, act: () => rotorSet(brg + 180) },
    { label: "Locator kopieren", icon: "i-copy", act: () => clipCopy(loc) }, { label: "Koordinaten kopieren", act: () => clipCopy(`${lat.toFixed(5)}, ${lon.toFixed(5)}`) },
    "-", { label: "Ganze Welt zeigen", act: () => m.setView([20, 0], 1) }]; });
ctxRegister(".earth3d", (el, e) => { const E = el._earth; if (!E) return []; const r = el.getBoundingClientRect(), ll = E.unproj(e.clientX - r.left, e.clientY - r.top); if (!ll) return [];
  const [lat, lon] = ll, loc = latLonToGrid(lat, lon), bt = bearingTo(lat, lon), brg = bt ? bt.az : null;
  return [`${loc} · ${lat.toFixed(2)}°, ${lon.toFixed(2)}°${bt ? ` · ${Math.round(bt.az)}° · ${Math.round(bt.km).toLocaleString(I18N.locale)} km` : ""}`,
    { label: "Antenne hierhin drehen (kurzer Weg)", icon: "i-compass", disabled: brg == null, act: () => rotorSet(brg) },
    { label: "Antenne hierhin drehen (langer Weg)", disabled: brg == null, act: () => rotorSet(brg + 180) },
    { label: "Locator kopieren", icon: "i-copy", act: () => clipCopy(loc) }, { label: "Koordinaten kopieren", act: () => clipCopy(`${lat.toFixed(5)}, ${lon.toFixed(5)}`) },
    "-", { label: "Auf eigenen Standort zentrieren", act: () => E.set({ zoom: 1, center: WW.home ? [WW.home[0], WW.home[1]] : [20, 0] }) }]; });
ctxRegister(".pane-rotator canvas.dial, canvas.d-az", () => [{ label: "Drehen auf … Grad", icon: "i-compass", act: () => { const v = prompt("Richtung in Grad (0–359)"); if (v !== null && v !== "") rotorSet(+v); } },
  { label: "Stopp", act: () => act("/api/rotor/stop", {}) }, { label: "Parken", act: () => act("/api/rotor/park", {}) }, ...[0, 90, 180, 270].map(a => ({ label: `${a}° (${["N", "O", "S", "W"][a / 90]})`, act: () => rotorSet(a) })),
  "-", { label: "Rotor verbinden …", icon: "i-plug", act: openRotorConnect }]);
ctxRegister(".sat-row", el => { const n = +el.dataset.n, s = (SAT.list || []).find(x => x.norad === n) || {};
  return [s.name || "Satellit", { label: "Auswählen und verfolgen", icon: "i-sat", act: () => satSelect(n) },
    { label: "Aus der Auswahl entfernen", act: () => { SAT.chosen.delete(n); store.set("sat.chosen", [...SAT.chosen]); WW.emit("sat-chosen"); } },
    { label: "Infos im Web (SatNOGS)", icon: "i-globe", act: () => window.open(`https://db.satnogs.org/satellite/${n}`, "_blank") }, { label: "NORAD-Nummer kopieren", icon: "i-copy", act: () => clipCopy(n) }]; });

// ---------- Digitalbetrieb ----------
ctxRegister(".dm-wf", (el, e) => { const r = el.getBoundingClientRect(), f = Math.round(dmSnap((e.clientX - r.left) / r.width * WF_MAX));
  return [`${f} Hz`, { label: "Hier empfangen", icon: "i-tune", act: () => dmSetFreq(f) }, { label: "Audiofrequenz kopieren", icon: "i-copy", act: () => clipCopy(f) },
    { label: "HF-Frequenz kopieren", disabled: !WW.rig.freq, act: () => clipCopy(fmtMHz(WW.rig.freq + f * (/LSB/.test(WW.rig.mode) ? -1 : 1))) }, "-",
    { label: "Betriebsart", sub: Object.entries(DM_GROUPS).map(([g, ms]) => ms.length === 1 ? { label: ms[0], check: D.mode === ms[0], act: () => dmSetMode(ms[0]) } : { label: g, sub: ms.map(m => ({ label: m, check: D.mode === m, act: () => dmSetMode(m) })) }) },
    { label: "AFC", check: store.get("dm.afc", true), disabled: !(D.rx instanceof Psk31Rx), act: () => { const v = !store.get("dm.afc", true); store.set("dm.afc", v); if (D.rx) D.rx.afc = v; } },
    { label: "Empfang an/aus", check: D.running, act: () => dmStart(store.get("dm.in", "")) }]; });
ctxRegister(".dm-rx", (el, e) => {
  const sel = getSelection().toString().trim();
  let w = sel; if (!w) { const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null; if (r && r.startContainer.nodeType === 3) { const t = r.startContainer.data, i = r.startOffset; let a = i, b = i; while (a > 0 && /[A-Z0-9/\-+]/i.test(t[a - 1])) a--; while (b < t.length && /[A-Z0-9/\-+]/i.test(t[b])) b++; w = t.slice(a, b); } }
  const isCall = /^([A-Z0-9]{1,3}\/)?[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]{1,4})?$/i.test(w || "");
  return [...(w ? [`„${w}“`, ...(isCall ? [{ label: "als Rufzeichen ins QSO", act: () => dmQsoSet({ call: w.toUpperCase() }) }] : []),
      { label: "als Name", act: () => dmQsoSet({ name: w[0].toUpperCase() + w.slice(1).toLowerCase() }) }, { label: "als QTH", act: () => dmQsoSet({ qth: w }) },
      ...(/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(w) ? [{ label: "als Locator", act: () => dmQsoSet({ grid: w }) }] : []), ...(/^[1-5][1-9][1-9]?$/.test(w) ? [{ label: "als RST empfangen", act: () => dmQsoSet({ rstr: w }) }] : []),
      ...(isCall ? ["-", ...callItems(w).slice(1)] : []), "-"] : []),
    { label: "Kopieren", icon: "i-copy", disabled: !sel, act: () => clipCopy(sel) }, { label: "Gesamten Text kopieren", act: () => clipCopy(el.textContent) },
    { label: "Leeren", icon: "i-x", act: () => el.textContent = "" }];
});
ctxRegister(".dm-mac button[data-i]", el => { const i = +el.dataset.i, m = store.get("dm.macros", DM_MACROS_DEFAULT)[i] || [];
  return [m[0] || "Makro", { label: "Senden", act: () => dmTx(m[1]) }, { label: "In das Sendefeld einfügen", act: () => { const t = document.querySelector(".dm-tx"); if (t) { t.value += dmFill(m[1]); t.focus(); } } },
    { label: "Makros bearbeiten …", icon: "i-edit", act: () => dmMacroEditor(() => WW.emit("dm-macros")) }]; });
ctxRegister(".dm-tx", el => { const ms = store.get("dm.macros", DM_MACROS_DEFAULT), sel = el.value.slice(el.selectionStart, el.selectionEnd);
  return [{ label: "Senden", key: "Strg+Enter", act: () => document.querySelector(".dm-send")?.click() }, "-",
    { label: "Ausschneiden", icon: "i-cut", disabled: !sel, act: () => { clipCopy(sel); el.setRangeText(""); } }, { label: "Kopieren", icon: "i-copy", disabled: !sel, act: () => clipCopy(sel) },
    { label: "Einfügen", icon: "i-paste", act: async () => { const t = await clipRead(); if (t) el.setRangeText(t, el.selectionStart, el.selectionEnd, "end"); } },
    { label: "Makro einfügen", sub: ms.map(([l, t], i) => ({ label: `F${i + 1} ${l}`, act: () => el.setRangeText(dmFill(t), el.selectionStart, el.selectionEnd, "end") })) },
    { label: "Platzhalter einfügen", sub: ["CALL", "NAME", "RST", "QTH", "LOC", "MYCALL", "MYNAME", "MYQTH", "MYLOC", "TIME", "DATE"].map(k => ({ label: `<${k}>`, act: () => el.setRangeText(`<${k}>`, el.selectionStart, el.selectionEnd, "end") })) },
    "-", { label: "Leeren", icon: "i-x", act: () => el.value = "" }]; });
ctxRegister(".pane-sweeper tr[data-f]", el => [{ label: "In den Haupt-Dekoder übernehmen", act: () => el.click() }, { label: "Text kopieren", icon: "i-copy", act: () => clipCopy(el.cells[1]?.textContent || "") }]);
ctxRegister(".ss-cv", () => [{ label: "Bild speichern …", icon: "i-save", disabled: !SSTV.img, act: () => document.querySelector(".ss-save")?.click() },
  { label: "Bild senden …", icon: "i-cam", act: () => sstvSendDialog() }, { label: "Als Hintergrund senden …", disabled: !SSTV.last, act: () => sstvSendDialog(sstvCanvasOf(SSTV.last).toDataURL()) },
  { label: "Empfang an/aus", check: !!D.sstv, act: () => sstvRxOn(!D.sstv) }]);
ctxRegister(".sg-list figure[data-n]", el => { const u = `/api/sstv/${encodeURIComponent(el.dataset.n)}`;
  return [{ label: "Groß anzeigen", act: () => window.open(u, "_blank") }, { label: "Als Bild senden …", icon: "i-cam", act: () => sstvSendDialog(u) }, { label: "In eigenes Bild einfügen …", act: () => sstvSendDialog(null, u) },
    { label: "Löschen", icon: "i-x", act: async () => { await api(u, { method: "DELETE" }); WW.emit("sstv-gallery"); } }]; });

// ---------- Programmrahmen: Fensterreiter, Programmregister, Statuszeile ----------
function panelOfTab(tab) { const dv = SHELL.dv[SHELL.active]; if (!dv) return null; const t = tab.textContent.trim();
  return dv.panels.find(p => p.group?.element?.contains(tab) && (p.title || "").trim() === t) || dv.panels.find(p => p.group?.element?.contains(tab) && t.startsWith((p.title || "").trim())); }
ctxRegister(".dv-tab", el => { const p = panelOfTab(el), dv = SHELL.dv[SHELL.active]; if (!p) return [];
  return [p.title, { label: "Lösen (schwebend)", act: () => dv.addFloatingGroup(p, { width: 520, height: 380, x: 80, y: 80 }) },
    { label: "In eigenes Fenster (zweiter Bildschirm)", act: () => dv.addPopoutGroup(p, { popoutUrl: "/static/popout.html" }) },
    { label: "Maximieren / zurück", act: () => p.group.api.isMaximized() ? p.group.api.exitMaximized() : p.group.api.maximize() }, "-",
    { label: "Schließen", icon: "i-x", act: () => dv.removePanel(p) },
    { label: "Andere in dieser Gruppe schließen", act: () => p.group.panels.filter(x => x !== p).forEach(x => dv.removePanel(x)) }, "-",
    { label: "Alle Fenster andocken", act: () => dockAll() }, { label: "Nebeneinander anordnen", act: () => tileLayout() }, { label: "Standardanordnung", act: () => resetLayout() }]; });
ctxRegister("#apptabs button", el => { const id = el.dataset.app;
  return [{ label: "Öffnen", act: () => switchApp(id) }, { label: "Standardanordnung wiederherstellen", act: () => { switchApp(id); resetLayout(id); } },
    { label: "Layout A laden", act: () => { switchApp(id); loadLayout("A", id); } }, { label: "Layout B laden", act: () => { switchApp(id); loadLayout("B", id); } },
    { label: "Als Layout A speichern", act: () => { switchApp(id); saveLayoutAs("A", id); } }, { label: "Als Layout B speichern", act: () => { switchApp(id); saveLayoutAs("B", id); } }]; });
ctxRegister("#statusbar .st", el => { const t = el.querySelector("b")?.textContent || "";
  if (t === "Funkgerät") return [{ label: "Verbinden …", icon: "i-plug", act: () => openConnect() }, { label: "Gerätesteuerung öffnen", act: () => switchApp("rig") }];
  if (t === "Cluster") return [{ label: "Cluster-Einstellungen …", icon: "i-gear", act: () => openOptions("cluster") }, { label: "DX-Cluster anzeigen", act: () => { switchApp("log"); addPanel("log", "cluster"); } }];
  if (t === "WSJT-X") return [{ label: "WSJT-X-Einstellungen …", icon: "i-gear", act: () => openOptions("wsjtx") }, { label: "Alert (FT8) anzeigen", act: () => { switchApp("log"); addPanel("log", "alert"); } }];
  if (t === "Rotor") return [{ label: "Rotor verbinden …", icon: "i-plug", act: openRotorConnect }, { label: "Rotor öffnen", act: () => switchApp("rot") }];
  return []; });
