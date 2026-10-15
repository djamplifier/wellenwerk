"use strict";
// Wellenwerk – Fehlerprotokoll (mit Bericht per E-Mail) und Aktualisierung

// ---------- Programmoptionen → Fehler & Updates ----------
function supportOptionsHtml(s) {
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(cur) === k ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<div class="grid2">
    <fieldset class="wide"><legend>Fehlerbericht per E-Mail</legend><div class="grid2">
      <label class="chkrow wide"><input type="checkbox" name="err_mail_on" ${s.err_mail_on ? "checked" : ""}> Fehler automatisch per E-Mail melden</label>
      <label>An E-Mail-Adresse<input name="err_mail_to" type="email" value="${esc(s.err_mail_to || "")}" placeholder="name@beispiel.de"></label>
      <label>Höchstens eine Nachricht alle … Minuten<input name="err_mail_interval" type="number" min="5" max="1440" value="${s.err_mail_interval || 30}"></label>
      <label class="chkrow wide"><input type="checkbox" name="err_github" ${s.err_github ? "checked" : ""}> Programmfehler automatisch und ohne persönliche Daten an die Entwickler melden (öffentlich auf GitHub)</label>
      <label class="chkrow wide"><input type="checkbox" name="err_ui" ${s.err_ui !== false ? "checked" : ""}> auch Fehlermeldungen der Oberfläche aufnehmen (z. B. „Verbindung fehlgeschlagen“)</label>
      <p class="hint wide">Gesammelt werden Programmfehler aus Dienst, Oberfläche und Desktop-Programm. Gleiche Fehler werden zusammengefasst, Passwörter und Schlüssel unkenntlich gemacht. Eine Nachricht enthält Version, Betriebssystem und Rufzeichen.</p>
      <label>SMTP-Server (leer = direkt zustellen)<input name="smtp_host" value="${esc(s.smtp_host || "")}" placeholder="z. B. mx.freenet.de, smtp.gmail.com"></label>
      <label>Port<input name="smtp_port" type="number" value="${s.smtp_port || 587}"></label>
      <label>Verschlüsselung${sel("smtp_security", [["starttls", "STARTTLS (Port 587)"], ["ssl", "SSL/TLS (Port 465)"], ["none", "keine"]], s.smtp_security || "starttls")}</label>
      <label>Absender (leer = Benutzername)<input name="smtp_from" value="${esc(s.smtp_from || "")}"></label>
      <label>Benutzername<input name="smtp_user" value="${esc(s.smtp_user || "")}" autocomplete="off"></label>
      <label>Passwort<input name="smtp_pass" type="password" autocomplete="new-password" value="${esc(s.smtp_pass || "")}"></label>
      <p class="hint wide">Ohne SMTP-Server liefert Wellenwerk die Nachricht selbst beim Mailserver der Empfängeradresse ab. Das klappt nur, wenn der Internetanschluss IPv6 hat – über IPv4 lehnen die meisten Mailserver Privatanschlüsse ab. Zuverlässig ist ein eigenes E-Mail-Konto (bei vielen Anbietern muss der Zugang für E-Mail-Programme erst freigeschaltet werden).</p>
      <div class="ctl-row wide"><button type="button" class="sup-test">Testnachricht senden</button><button type="button" class="sup-log">Fehlerprotokoll anzeigen</button><span class="hint sup-st"></span></div></div></fieldset>
    <fieldset class="wide"><legend>Aktualisierung</legend><div class="grid2">
      <label>Neue Versionen${sel("update_mode", [["auto", "beim Start automatisch installieren"], ["ask", "nur melden"], ["off", "nicht prüfen"]], s.update_mode || "auto")}</label><span></span>
      <p class="hint wide upd-st">…</p>
      <div class="ctl-row wide"><button type="button" class="upd-check">Jetzt prüfen</button><button type="button" class="upd-inst hidden">Jetzt installieren</button></div></div></fieldset></div>`;
}
function supportOptionsInit(d) {
  const st = d.querySelector(".sup-st");
  const fields = () => { const b = {}; d.querySelectorAll('[data-t="support"] [name]').forEach(el => b[el.name] = el.type === "checkbox" ? el.checked : el.value.trim()); return b; };
  d.querySelector(".sup-test").onclick = async () => {
    st.textContent = "sende …";
    try { WW.settings = await api("/api/settings", { method: "PUT", body: fields() }); const r = await post("/api/errors/test"); st.textContent = r.result; }
    catch (e) { st.textContent = ""; toast(e.message, true); }
  };
  d.querySelector(".sup-log").onclick = () => showErrorLog();
  const upd = d.querySelector(".upd-st"), inst = d.querySelector(".upd-inst");
  const show = u => { upd.innerHTML = updateText(u); inst.classList.toggle("hidden", !(u.available && canInstall(u))); };
  api("/api/update").then(show).catch(() => { });
  d.querySelector(".upd-check").onclick = async () => { upd.textContent = "prüfe …"; try { show(await post("/api/update/check")); } catch (e) { upd.textContent = e.message; } };
  inst.onclick = () => installUpdate();
}

// ---------- Fehlerprotokoll ----------
async function showErrorLog() {
  let data = { entries: [], mail: {} };
  const d = dialog({ title: "Fehlerprotokoll", wide: true, buttons: [["Schließen", "close"]], body: `
    <div class="ctl-row"><button type="button" class="el-send">Jetzt per E-Mail senden</button><button type="button" class="el-dl">Herunterladen</button><button type="button" class="el-clear">Leeren</button><button type="button" class="el-opts">Einstellungen</button><span class="hint el-st grow"></span></div>
    <div class="el-list" style="max-height:60vh;overflow:auto;margin-top:8px"></div>` });
  const list = d.querySelector(".el-list"), st = d.querySelector(".el-st");
  const fmt = iso => { try { return new Date(iso).toLocaleString(I18N.locale); } catch { return iso; } };
  const SRC = { server: "Dienst", ui: "Oberfläche", desktop: "Desktop-Programm", plugin: "Erweiterung" };
  async function load() {
    data = await api("/api/errors");
    const m = data.mail;
    st.textContent = m.enabled ? `Bericht an ${m.to}${m.pending ? ` · ${m.pending} noch nicht gesendet` : ""}${m.last ? " · zuletzt " + m.last : ""}` : "Bericht per E-Mail ist ausgeschaltet";
    list.innerHTML = data.entries.length ? data.entries.map((e, i) => `<details class="el-e" style="border-bottom:1px solid var(--line,#ccc);padding:4px 0">
      <summary><b>${esc(fmt(e.last))}</b> · ${esc(SRC[e.source] || e.source)}${e.level === "meldung" ? " (Meldung)" : ""}${e.count > 1 ? ` · ${e.count}×` : ""} – <span translate="no">${esc(e.message.split("\n")[0])}</span></summary>
      <pre translate="no" style="white-space:pre-wrap;font-size:11px;margin:6px 0 0">${esc([e.where ? "Ort: " + e.where : "", "Version: " + e.version, "zuerst: " + fmt(e.first), "", e.message, e.detail ? "\n" + e.detail : ""].filter(x => x !== null).join("\n"))}</pre></details>`).join("")
      : `<p class="hint">Keine Fehler aufgezeichnet.</p>`;
  }
  d.querySelector(".el-send").onclick = async () => { try { const r = await post("/api/errors/send"); toast(r.result); load(); } catch (e) { toast(e.message, true); } };
  d.querySelector(".el-clear").onclick = async () => { if (!confirm("Fehlerprotokoll leeren?")) return; await api("/api/errors", { method: "DELETE" }); load(); };
  d.querySelector(".el-opts").onclick = () => { d.close(); openOptions("support"); };
  d.querySelector(".el-dl").onclick = () => {
    const txt = [JSON.stringify(data.system, null, 1), ...data.entries.map(e => `\n=== ${e.last} [${e.source}] ${e.count}×\n${e.message}\n${e.where || ""}\n${e.detail || ""}`)].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" })); a.download = `wellenwerk-fehler-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
  };
  try { await load(); } catch (e) { list.textContent = e.message; }
}

// ---------- Aktualisierung ----------
const desktopUpd = () => window.wwDesktop && window.wwDesktop.update;
function canInstall(u) { return u.mode === "source" || (u.mode === "desktop" && !!desktopUpd()); }
function updateText(u) {
  if (!u) return "";
  const parts = [`<span>Installiert: ${esc(u.current)}</span>`];
  if (u.latest) parts.push(`<span>neueste: ${esc(u.latest)}</span>`);
  if (u.checked) parts.push(`<span>geprüft ${esc(u.checked)}</span>`);
  let t = parts.join(" · ");
  if (u.error) t += `<br><span class="err">${esc(u.error)}</span>`;
  else if (u.available) t += `<br><span>Neue Version verfügbar</span>${u.url ? ` – <a href="${esc(u.url)}" target="_blank">Neuerungen</a>` : ""}` +
    (canInstall(u) ? "" : `<br><span>Bitte das neue Installationspaket herunterladen und installieren.</span>`);
  else if (u.latest) t += "<br><span>Wellenwerk ist aktuell.</span>";
  if (u.busy || u.step) t += `<br>${esc(u.step || "")}`;
  return t;
}
async function installUpdate() {
  const u = await api("/api/update");
  if (u.mode === "desktop" && desktopUpd()) { toast(`Lade Version ${u.latest} …`); try { await desktopUpd().install(); } catch (e) { toast(e.message, true); } return; }
  if (!confirm(`Wellenwerk jetzt auf Version ${u.latest} aktualisieren? Der Dienst startet dabei neu.`)) return;
  try { await post("/api/update/install"); toast(`Aktualisierung auf ${u.latest} läuft – die Seite lädt danach neu`); waitRestart(u.current); }
  catch (e) { toast(e.message, true); }
}
function waitRestart(old) {   // nach dem Neustart des Dienstes die Oberflaeche neu laden
  const t0 = Date.now();
  const poll = async () => {
    try { const r = await api("/api/update"); if (r.current !== old) return location.reload(); } catch { }
    if (Date.now() - t0 < 600000) setTimeout(poll, 3000);
  };
  setTimeout(poll, 5000);
}
async function checkUpdates(verbose = false) {
  let u;
  try { u = await post("/api/update/check"); } catch (e) { if (verbose) toast(e.message, true); return; }
  if (!verbose) { if (u.available) updateHint(u); return; }
  dialog({ title: "Aktualisierung", wide: !!(u.available && u.notes), body: `<p>${updateText(u)}</p>${u.available && u.notes ? `<h3>Neu in Version ${esc(u.latest)}</h3><div class="ww-notes" translate="no">${await notesHtml(u.notes)}</div>` : ""}`, buttons: u.available && canInstall(u) ? [["Später", "close"], ["Jetzt installieren", "inst", "primary"]] : [["OK", "close", "primary"]],
    onOpen: dd => { const b = dd.querySelector('button[value="inst"]'); if (b) b.onclick = e => { e.preventDefault(); dd.close(); installUpdate(); }; } });
}
// Neuerungen (Markdown der Veroeffentlichung) als HTML
async function notesHtml(md) {
  try { await loadScript("/static/vendor/marked.min.js"); } catch { return `<pre style="white-space:pre-wrap">${esc(md)}</pre>`; }
  const t = document.createElement("template"); t.innerHTML = marked.parse(String(md || ""));
  t.content.querySelectorAll("script,style,iframe,object,embed").forEach(x => x.remove());
  t.content.querySelectorAll("*").forEach(x => [...x.attributes].forEach(a => { if (/^on/i.test(a.name) || /^javascript:/i.test(a.value)) x.removeAttribute(a.name); }));
  t.content.querySelectorAll("a").forEach(a => a.target = "_blank");
  return t.innerHTML;
}
// Erster Start einer neuen Version (auch nach automatischer Aktualisierung): zeigen, was sich geaendert hat
WW.on("version", async v => {
  if (!v || showWhatsNew.done) return; showWhatsNew.done = true;
  const last = store.get("seenVersion", ""); store.set("seenVersion", v);
  await alphaNotice(v);
  if (last && last !== v) showWhatsNew(v);
});

// ---------- Hinweis beim Oeffnen: Alpha-Version ----------
const ISSUES = "https://github.com/djamplifier/wellenwerk/issues";
function alphaNotice(v = WW.version, force = false) {
  if (!force && store.get("alphaHidden", "") === v) return Promise.resolve();
  const d = dialog({ title: `Wellenwerk ${v} – Alpha-Version`, icon: "i-info", buttons: [["Problem melden …", "fb"], ["Verstanden", "close", "primary"]], body: `
    <p><b>Wellenwerk ist eine experimentelle Alpha-Version.</b> Vieles funktioniert schon, aber noch nicht alles fehlerfrei – rechne mit Fehlern und ungewohntem Verhalten, besonders beim Senden.</p>
    <p>Jeder Nutzer hilft mit, das Programm zu verbessern: einfach benutzen, ausprobieren und Probleme melden. Über <b>Hilfe → Feedback / Problem melden</b> beschreibst du ein Problem mit eigenen Worten; das Fehlerprotokoll und die Systemdaten können automatisch angehängt werden.</p>
    <p class="hint">Bitte beim Senden immer die Funkvorschriften beachten und die Station beaufsichtigen. Nutzung auf eigene Verantwortung.</p>
    <label class="chkrow ${WW.devReports ? "" : "hidden"}"><input type="checkbox" class="al-gh" ${(WW.settings || {}).err_github ? "checked" : ""}> Programmfehler automatisch und ohne persönliche Daten an die Entwickler melden (erscheinen öffentlich auf GitHub)</label>
    <label class="chkrow"><input type="checkbox" class="al-hide"> Bis zur nächsten Version nicht mehr anzeigen</label>` });
  d.querySelector('button[value="fb"]').addEventListener("click", e => { e.preventDefault(); d.close(); showFeedback(); });
  return new Promise(res => d.addEventListener("close", async () => {
    if (d.querySelector(".al-hide").checked) store.set("alphaHidden", v);
    const gh = d.querySelector(".al-gh").checked;
    if (WW.devReports && gh !== !!(WW.settings || {}).err_github) { try { WW.settings = await api("/api/settings", { method: "PUT", body: { err_github: gh } }); } catch { } }
    res(); }));
}

// ---------- Feedback: Probleme selbst beschreiben und senden ----------
function showFeedback(kind = "Problem") {
  const s = WW.settings || {}, canMail = !!(s.err_mail_to || "").trim() || !!WW.devReports;
  const d = dialog({ title: "Feedback / Problem melden", icon: "i-info", wide: true, buttons: [["Abbrechen", "close"], ["Auf GitHub melden", "gh"], ...(canMail ? [["Abschicken", "send", "primary"]] : [])], body: `
    <div class="grid2">
      <label>Art<select class="fb-kind">${[["Problem", "Problem / Fehler"], ["Vorschlag", "Verbesserungsvorschlag"], ["Frage", "Frage"], ["Lob", "Lob"], ["Sonstiges", "Sonstiges"]].map(([k, l]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Kontakt für Rückfragen (freiwillig, erscheint öffentlich)<input class="fb-contact" value="${esc(store.get("fbContact", "") || s.callsign || "")}"></label>
      <label class="wide">Was ist passiert? Was hast du gemacht, was hast du erwartet?<textarea class="fb-text" rows="9" placeholder="z. B. Empfänger Bremen, 14,175 MHz USB: nach 5 Minuten kein Ton mehr, Wasserfall steht. Seite neu geladen – dann ging es wieder."></textarea></label>
      <label class="chkrow wide"><input type="checkbox" class="fb-attach" checked> Fehlerprotokoll und Systemdaten anhängen (Version, Betriebssystem, Rufzeichen – keine Passwörter)</label>
      <p class="hint wide">${WW.devReports ? `<span>„Abschicken“ schickt die Meldung an die Entwickler – sie erscheint als öffentlicher Eintrag auf GitHub (ohne Rechnernamen und Rufzeichen, außer du gibst es als Kontakt an).</span> ` : ""}${(s.err_mail_to || "").trim() ? `<span>Zusätzlich per E-Mail an ${esc(s.err_mail_to)}.</span> ` : ""}<span>„Auf GitHub melden“ öffnet eine vorausgefüllte Meldung im öffentlichen Projekt (GitHub-Konto nötig) – dort sehen auch andere Nutzer das Problem und die Lösung.</span></p>
      <p class="fb-st hint wide"></p></div>` });
  const val = () => ({ kind: d.querySelector(".fb-kind").value, text: d.querySelector(".fb-text").value, contact: d.querySelector(".fb-contact").value.trim(), attach: d.querySelector(".fb-attach").checked });
  const st = d.querySelector(".fb-st");
  const go = async (send) => {
    const v = val(); store.set("fbContact", v.contact);
    if (v.text.trim().length < 5) { st.textContent = "Bitte das Problem kurz beschreiben."; return null; }
    st.textContent = send ? "sende …" : "";
    try { return await post("/api/feedback", { ...v, send }); } catch (e) { st.textContent = e.message; return null; }
  };
  const sb = d.querySelector('button[value="send"]');
  if (sb) sb.addEventListener("click", async e => { e.preventDefault(); const r = await go(true); if (!r) return;
    if (r.sent) { d.close(); toast("Danke! Deine Meldung wurde gesendet."); if (/fehlgeschlagen/.test(r.result)) setTimeout(() => toast(r.result, true), 2500); } else st.textContent = r.result || "Nicht gesendet – bitte „Auf GitHub melden“ benutzen."; });
  d.querySelector('button[value="gh"]').addEventListener("click", async e => { e.preventDefault(); const r = await go(false); if (!r) return;
    const body = r.text.length > 6000 ? r.text.slice(0, 6000) + "\n… (gekürzt)" : r.text;
    window.open(`${ISSUES}/new?title=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(body)}`, "_blank"); d.close(); toast("Danke! Bitte die Meldung auf GitHub noch absenden."); });
  setTimeout(() => d.querySelector(".fb-text").focus(), 50);
}
async function showWhatsNew(v = WW.version) {
  let n; try { n = await api(`/api/update/notes?version=${encodeURIComponent(v)}`); } catch { return; }
  if (!n.notes) return;
  dialog({ title: `Wellenwerk ${v} – Neuerungen`, wide: true, buttons: [["OK", "close", "primary"]],
    body: `<p>Wellenwerk wurde auf Version ${esc(v)} aktualisiert. Das ist neu oder wurde behoben:</p><div class="ww-notes" translate="no" style="max-height:60vh;overflow:auto">${await notesHtml(n.notes)}</div>${n.url ? `<p class="hint"><a href="${esc(n.url)}" target="_blank">Veröffentlichung auf GitHub</a></p>` : ""}` });
}
function updateHint(u) {
  if (!u || !u.available || updateHint.shown === u.latest) return;
  updateHint.shown = u.latest;
  toast(`Wellenwerk ${u.latest} ist verfügbar – Hilfe → Nach Updates suchen`);
}
WW.on("update", u => { if (u.busy) return; if (u.available) updateHint(u); });
