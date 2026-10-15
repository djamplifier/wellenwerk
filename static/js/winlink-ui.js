"use strict";
// Wellenwerk – Winlink: Postfach (Eingang/Ausgang/Gesendet/Archiv), Nachricht lesen und verfassen,
// Verbindung ueber Telnet, ARDOP, VARA oder Packet (AGW) mit Protokoll.
const WL = { folder: "in", sel: null, counts: {}, state: {}, log: [] };
const WL_FOLDERS = [["in", "Eingang"], ["out", "Ausgang"], ["sent", "Gesendet"], ["archive", "Archiv"]];
const WL_METHODS = [["telnet", "Telnet – Winlink-Server (Internet)"], ["p2p", "Telnet – Peer (Station im Netz)"], ["ardop", "ARDOP (Kurzwelle)"], ["vara", "VARA (eigenes VARA-Programm)"], ["packet", "Packet (AGW, z. B. Direwolf)"]];
const wlSize = n => n > 1024 ? (n / 1024).toFixed(1) + " kB" : n + " B";
async function wlRefresh() { const s = await api("/api/winlink/state"); WL.counts = s.counts; WL.state = s; WL.log = s.log; WW.emit("wl-state"); }
WW.on("winlink", m => { if (m.counts) WL.counts = m.counts; if (m.state) WL.state = { ...WL.state, ...m.state }; if (m.line) { WL.log.push(m.line); WL.log = WL.log.slice(-500); WW.emit("wl-line", m.line); }
  WW.emit("wl-state"); if (m.line && /^Nachricht von/.test(m.line.text)) { toast("Winlink: " + m.line.text); WW.emit("wl-folder"); } if (!m.line) WW.emit("wl-folder"); });

function createWlFolders(root) {
  root.innerHTML = `<div class="pane-tb"><button class="wl-new primary">${icon("i-plus")} Neue Nachricht</button></div><div class="wl-fold"></div>`;
  const draw = () => { $(".wl-fold", root).innerHTML = WL_FOLDERS.map(([k, l]) => `<div class="wl-f${k === WL.folder ? " sel" : ""}" data-f="${k}">${icon(k === "in" ? "i-download" : k === "out" ? "i-upload" : k === "sent" ? "i-mail" : "i-db")}<span>${l}</span><b>${k === "in" && WL.counts.unread ? `${WL.counts.unread} neu · ` : ""}${WL.counts[k] ?? ""}</b></div>`).join(""); };
  root.addEventListener("click", e => { const f = e.target.closest("[data-f]"); if (f) { WL.folder = f.dataset.f; WL.sel = null; draw(); WW.emit("wl-folder"); WW.emit("wl-sel"); } if (e.target.closest(".wl-new")) wlCompose(); });
  const offs = [WW.on("wl-state", draw), WW.on("wl-folder", draw)]; wlRefresh().then(draw).catch(() => { }); draw(); return () => offs.forEach(f => f());
}
function createWlList(root) {
  root.innerHTML = `<div class="tablewrap"><table class="grid wl-t"><thead></thead><tbody></tbody></table></div>`;
  let rows = [];
  const load = async () => { rows = await api("/api/winlink/folder/" + WL.folder); const who = WL.folder === "in" ? "Von" : "An";
    $("thead", root).innerHTML = `<tr><th>Datum (UTC)</th><th>${who}</th><th>Betreff</th><th>Größe</th><th></th></tr>`;
    $("tbody", root).innerHTML = rows.map(m => `<tr data-mid="${esc(m.mid)}" class="${m.mid === WL.sel ? "sel" : ""}${m.unread ? " unread" : ""}"><td>${esc(m.date)}</td><td>${esc(WL.folder === "in" ? m.sender : [...m.to, ...m.cc].join(", "))}</td><td>${esc(m.subject)}</td><td>${wlSize(m.size)}</td><td>${m.files.length ? "📎" : ""}</td></tr>`).join("")
      || `<tr><td colspan="5" class="hint">Keine Nachrichten in „${WL_FOLDERS.find(f => f[0] === WL.folder)[1]}“.</td></tr>`; };
  root.addEventListener("click", e => { const tr = e.target.closest("tr[data-mid]"); if (tr) { WL.sel = tr.dataset.mid; $$("tr", root).forEach(r => r.classList.toggle("sel", r === tr)); tr.classList.remove("unread"); WW.emit("wl-sel"); } });
  root.addEventListener("dblclick", e => { if (e.target.closest("tr[data-mid]") && WL.folder === "out") wlCompose(null, WL.sel); });
  const offs = [WW.on("wl-folder", () => load().catch(() => { }))]; load().catch(() => { }); return () => offs.forEach(f => f());
}
function wlMsgMenu(folder, mid) {
  const mv = (dst, l) => ({ label: l, act: async () => { await post("/api/winlink/move", { src: folder, dst, mid }); WL.sel = null; WW.emit("wl-sel"); } });
  return [folder === "in" ? { label: "Antworten", act: () => wlReply(folder, mid, false) } : null, folder === "in" ? { label: "Allen antworten", act: () => wlReply(folder, mid, true) } : null,
    { label: "Weiterleiten", act: () => wlForward(folder, mid) }, folder === "out" ? { label: "Bearbeiten", act: () => wlCompose(null, mid) } : null, "-",
    folder !== "archive" ? mv("archive", "Archivieren") : mv("in", "Zurück in den Eingang"), folder === "sent" ? mv("out", "Erneut senden (in den Ausgang)") : null,
    { label: "Löschen", act: async () => { if (!confirm("Nachricht löschen?")) return; await api(`/api/winlink/msg/${folder}/${mid}`, { method: "DELETE" }); WL.sel = null; WW.emit("wl-sel"); } }].filter(Boolean);
}
function createWlRead(root) {
  root.innerHTML = `<div class="wl-read"><div class="hint">Nachricht auswählen.</div></div>`;
  const show = async () => { const el = $(".wl-read", root); if (!WL.sel) { el.innerHTML = `<div class="hint">Nachricht auswählen.</div>`; return; }
    let m; try { m = await api(`/api/winlink/msg/${WL.folder}/${WL.sel}`); } catch { el.innerHTML = `<div class="hint">Nachricht nicht mehr vorhanden.</div>`; return; }
    el.innerHTML = `<div class="wl-hd"><div class="wl-subj">${esc(m.subject)}</div><div><b>Von</b> ${esc(m.sender)} · <b>An</b> ${esc(m.to.join(", "))}${m.cc.length ? ` · <b>Cc</b> ${esc(m.cc.join(", "))}` : ""}</div><div class="hint">${esc(m.date)} UTC · ${esc(m.mid)} · ${wlSize(m.size)}</div>
      ${m.files.length ? `<div class="wl-att">${m.files.map((f, i) => `<a href="/api/winlink/att/${WL.folder}/${encodeURIComponent(m.mid)}/${i}" download>📎 ${esc(f.name)} (${wlSize(f.size)})</a>`).join("")}</div>` : ""}
      <div class="ctl-row">${wlMsgMenu(WL.folder, m.mid).filter(x => x !== "-").map((x, i) => `<button data-i="${i}">${esc(x.label)}</button>`).join("")}</div></div><pre class="wl-body">${esc(m.text)}</pre>`;
    const acts = wlMsgMenu(WL.folder, m.mid).filter(x => x !== "-"); $$(".ctl-row [data-i]", el).forEach(b => b.onclick = () => acts[+b.dataset.i].act());
    WW.emit("wl-read"); };
  const offs = [WW.on("wl-sel", show)]; show(); return () => offs.forEach(f => f());
}
function createWlConn(root) {
  const st = store.get("wl.conn", { method: "telnet", target: "", freq: "", via: "", host: "", port: "8774", recent: [] });
  root.innerHTML = `<div class="wl-conn"><div class="grid2">
    <label>Verbindungsweg<select class="wc-m">${WL_METHODS.map(([k, l]) => `<option value="${k}" ${k === st.method ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="wc-tl">Gegenstation (RMS oder Rufzeichen)<input class="wc-t" list="wc-recent" value="${esc(st.target)}" placeholder="z. B. DB0XYZ-10"><datalist id="wc-recent">${(st.recent || []).map(r => `<option>${esc(r)}</option>`).join("")}</datalist></label>
    <label class="wc-fl">Frequenz kHz (Anzeige des Funkgeräts, leer = nicht ändern)<input class="wc-f" value="${esc(st.freq)}" placeholder="z. B. 3594.5"></label>
    <label class="wc-vl">über Digipeater (optional)<input class="wc-v" value="${esc(st.via)}" placeholder="z. B. DB0ABC"></label>
    <label class="wc-hl">Host der Peer-Station<input class="wc-h" value="${esc(st.host)}" placeholder="z. B. 192.168.1.20"></label><label class="wc-pl">Port<input class="wc-p" value="${esc(st.port)}"></label>
    <label class="chkrow wide"><input type="checkbox" class="wc-ro"> nur empfangen (Ausgang bleibt liegen)</label></div>
    <div class="ctl-row"><button class="wc-go primary">${icon("i-plug")} Verbinden</button><button class="wc-ab danger">Abbrechen</button><span class="wc-st hint"></span><i class="grow"></i><button class="wc-opt">${icon("i-gear")} Einstellungen</button></div>
    <div class="wl-log"></div></div>`;
  const m = () => $(".wc-m", root).value;
  const vis = () => { const k = m(); $(".wc-tl", root).classList.toggle("hidden", k === "telnet"); $(".wc-fl", root).classList.toggle("hidden", ["telnet", "p2p"].includes(k));
    $(".wc-vl", root).classList.toggle("hidden", k !== "packet"); $(".wc-hl", root).classList.toggle("hidden", k !== "p2p"); $(".wc-pl", root).classList.toggle("hidden", k !== "p2p"); };
  const line = l => `<div class="wl-l ${l.kind}"><span>${esc(l.t)}</span> ${esc(l.text)}</div>`;
  const drawLog = () => { const el = $(".wl-log", root); el.innerHTML = WL.log.map(line).join(""); el.scrollTop = el.scrollHeight; };
  const stat = () => { const s = WL.state || {}; $(".wc-st", root).textContent = s.busy ? `${s.phase || "läuft"} – ${s.target || ""}` : ""; $(".wc-go", root).disabled = !!s.busy; $(".wc-ab", root).disabled = !s.busy; };
  root.addEventListener("change", e => { if (e.target.classList.contains("wc-m")) vis(); });
  $(".wc-go", root).onclick = async () => {
    const k = m(), t = $(".wc-t", root).value.trim().toUpperCase(), rec = [t, ...(st.recent || []).filter(x => x !== t)].filter(Boolean).slice(0, 15);
    Object.assign(st, { method: k, target: t, freq: $(".wc-f", root).value.trim(), via: $(".wc-v", root).value.trim(), host: $(".wc-h", root).value.trim(), port: $(".wc-p", root).value.trim(), recent: rec }); store.set("wl.conn", st);
    const body = { method: k === "p2p" ? "telnet" : k, target: t, receive_only: $(".wc-ro", root).checked };
    if (k === "p2p") { if (!st.host) return toast("Host der Peer-Station fehlt", true); Object.assign(body, { host: st.host, port: +st.port || 8774 }); }
    if (!["telnet", "p2p"].includes(k) && st.freq) body.freq = st.freq.replace(",", ".");
    if (k === "packet" && st.via) body.via = st.via;
    try { WL.state = await post("/api/winlink/connect", body); stat(); } catch (err) { toast(err.message, true); } };
  $(".wc-ab", root).onclick = async () => { try { WL.state = await post("/api/winlink/abort"); stat(); } catch (err) { toast(err.message, true); } };
  $(".wc-opt", root).onclick = () => openOptions("winlink");
  vis(); stat(); drawLog();
  const offs = [WW.on("wl-line", l => { const el = $(".wl-log", root); el.insertAdjacentHTML("beforeend", line(l)); el.scrollTop = el.scrollHeight; }), WW.on("wl-state", stat)];
  wlRefresh().then(() => { drawLog(); stat(); }).catch(() => { }); return () => offs.forEach(f => f());
}

ctxRegister(".wl-t tr[data-mid]", tr => { WL.sel = tr.dataset.mid; $$(".wl-t tr").forEach(r => r.classList.toggle("sel", r === tr)); WW.emit("wl-sel"); return wlMsgMenu(WL.folder, tr.dataset.mid); });
ctxRegister(".wl-f[data-f]", el => [{ label: "Neue Nachricht …", act: () => wlCompose() }, { label: "Ordner öffnen", act: () => el.click() }]);

// ---------- Verfassen ----------
async function wlCompose(pre = null, editMid = null) {
  let p = pre || {};
  if (editMid) { const m = await api(`/api/winlink/msg/out/${editMid}`); p = { to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, text: m.text.replace(/\r\n/g, "\n") }; }
  const files = [];
  const d = dialog({ title: editMid ? "Nachricht bearbeiten" : "Neue Winlink-Nachricht", icon: "i-mail", wide: true, buttons: [["Abbrechen", "close"], ["In den Ausgang", "ok", "primary"]], body: `<div class="grid2 wl-comp">
    <label class="wide">An (Rufzeichen oder E-Mail-Adresse, mehrere mit Komma)<input id="wm-to" value="${esc(p.to || "")}"></label>
    <label class="wide">Cc<input id="wm-cc" value="${esc(p.cc || "")}"></label>
    <label class="wide">Betreff<input id="wm-subj" maxlength="128" value="${esc(p.subject || "")}"></label>
    <label class="wide">Text<textarea id="wm-text" rows="14">${esc(p.text || "")}</textarea></label>
    <label class="wide">Anhänge<input type="file" id="wm-file" multiple></label><div class="wide wm-files hint"></div>
    <p class="hint wide">Über Funk möglichst klein halten (Bilder verkleinern) – jede Nachricht geht komprimiert raus. Gesendet wird bei der nächsten Verbindung.</p><div class="err wide"></div></div>` });
  const showFiles = () => { const tot = files.reduce((a, f) => a + f.size, 0); $(".wm-files", d).innerHTML = files.map((f, i) => `<span class="chip">📎 ${esc(f.name)} (${wlSize(f.size)}) <button type="button" data-rm="${i}">×</button></span>`).join(" ") + (files.length ? ` · gesamt ${wlSize(tot)}${tot > 100000 ? " – groß für Funkbetrieb!" : ""}` : ""); };
  $("#wm-file", d).onchange = async e => { for (const f of e.target.files) { const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); files.push({ name: f.name, size: b.length, data: btoa(s) }); } e.target.value = ""; showFiles(); };
  $(".wm-files", d).onclick = e => { const b = e.target.closest("[data-rm]"); if (b) { files.splice(+b.dataset.rm, 1); showFiles(); } };
  d.querySelector('[value="ok"]').onclick = async e => { e.preventDefault();
    try { await post("/api/winlink/compose", { to: $("#wm-to", d).value, cc: $("#wm-cc", d).value, subject: $("#wm-subj", d).value, text: $("#wm-text", d).value, files });
      if (editMid) await api(`/api/winlink/msg/out/${editMid}`, { method: "DELETE" });
      d.close(); toast("Nachricht liegt im Ausgang"); WW.emit("wl-folder"); }
    catch (err) { $(".err", d).textContent = err.message; } };
  setTimeout(() => $(p.to ? "#wm-text" : "#wm-to", d).focus(), 50);
}
async function wlReply(folder, mid, all) {
  const m = await api(`/api/winlink/msg/${folder}/${mid}`), me = (WW.settings.wl_call || WW.settings.callsign || "").toUpperCase();
  const cc = all ? [...m.to, ...m.cc].filter(a => a.toUpperCase() !== me) : [];
  wlCompose({ to: m.sender, cc: cc.join(", "), subject: /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject, text: `\n\n--- ${m.date} UTC, ${m.sender} schrieb:\n` + m.text.replace(/\r\n/g, "\n").split("\n").map(l => "> " + l).join("\n") });
}
async function wlForward(folder, mid) {
  const m = await api(`/api/winlink/msg/${folder}/${mid}`);
  wlCompose({ subject: /^fw:/i.test(m.subject) ? m.subject : "Fw: " + m.subject, text: `\n\n--- Weitergeleitete Nachricht ---\nVon: ${m.sender}\nAn: ${m.to.join(", ")}\nDatum: ${m.date} UTC\nBetreff: ${m.subject}\n\n` + m.text.replace(/\r\n/g, "\n") });
}

APPS.wl = {
  title: "Winlink", icon: "i-mail",
  panels: { wlfolders: { title: "Ordner", create: createWlFolders }, wllist: { title: "Nachrichten", create: createWlList }, wlread: { title: "Lesen", create: createWlRead }, wlconn: { title: "Verbindung", create: createWlConn } },
  layout(dv) { const f = dv.addPanel({ id: "wlfolders", component: "wlfolders", title: "Ordner" });
    dv.addPanel({ id: "wllist", component: "wllist", title: "Nachrichten", position: { referencePanel: "wlfolders", direction: "right" } });
    dv.addPanel({ id: "wlconn", component: "wlconn", title: "Verbindung", position: { referencePanel: "wllist", direction: "right" } });
    dv.addPanel({ id: "wlread", component: "wlread", title: "Lesen", position: { referencePanel: "wllist", direction: "below" } });
    setTimeout(() => { try { f.group.api.setSize({ width: 200 }); dv.getPanel("wlconn").group.api.setSize({ width: 440 }); dv.getPanel("wllist").group.api.setSize({ height: 300 }); } catch { } }, 60); },
  menus: [{ label: "Datei", items: [{ label: "Neue Nachricht …", icon: "i-plus", act: () => wlCompose() }, { label: "Winlink-Einstellungen …", icon: "i-gear", act: () => openOptions("winlink") }] },
    { label: "Ansicht", items: Object.entries({ wlfolders: "Ordner", wllist: "Nachrichten", wlread: "Lesen", wlconn: "Verbindung" }).map(([k, l]) => ({ label: l, check: () => panelOpen("wl", k), act: () => togglePanel("wl", k) })) },
    MENU_WINDOW("wl"), MENU_HELP],
  toolbar: [{ label: "Neu", icon: "i-plus", act: () => wlCompose() }, { label: "Einstellungen", icon: "i-gear", act: () => openOptions("winlink") }, "|", { label: "Gerätesteuerung", icon: "i-radio", act: () => switchApp("rig") }, { label: "Logbuch", icon: "i-book", act: () => switchApp("log") }, { label: "Vollbild", icon: "i-full", act: fullScreen }],
};
