"use strict";
// Wellenwerk – SSTV im Digitalbetrieb: Empfangsbild, Sendedialog mit Vorlage (Text, Bild der Gegenstation), Bildergalerie

const SSTV = { rx: null, last: null, img: null, mode: "", busy: false };

function sstvRxOn(on) {
  if (!on) { D.sstv = null; WW.emit("sstv-state"); return; }
  const fixed = store.get("sstv.mode", "");
  D.sstv = new SstvRx(sstvEvent, fixed); store.set("dm.logmode", "SSTV");
  if (!D.running) dmStart(store.get("dm.in", ""));
  WW.emit("sstv-state");
}
function sstvEvent(e) {
  if (e.type === "start") { SSTV.img = { mode: e.mode, w: e.w, h: e.h, px: new Uint8ClampedArray(e.w * e.h * 4).fill(0), lines: 0, t: new Date() }; SSTV.busy = true; WW.emit("sstv-start", SSTV.img); }
  else if (e.type === "line" && SSTV.img) { SSTV.img.px.set(e.rgb, e.y * SSTV.img.w * 4); SSTV.img.lines = e.y + e.rows; WW.emit("sstv-line", e); }
  else if (e.type === "done" && SSTV.img) { SSTV.busy = false; SSTV.last = SSTV.img; WW.emit("sstv-done", SSTV.img); sstvSave(SSTV.img); }
  else if (e.type === "unknown") toast(`SSTV: unbekannte VIS-Kennung ${e.vis}`, true);
}
function sstvCanvasOf(img) { const c = document.createElement("canvas"); c.width = img.w; c.height = img.h; c.getContext("2d").putImageData(new ImageData(img.px, img.w, img.h), 0, 0); return c; }
async function sstvSave(img) {
  try { await post("/api/sstv", { mode: img.mode, png: sstvCanvasOf(img).toDataURL("image/png") }); WW.emit("sstv-gallery"); }
  catch (e) { toast("SSTV-Bild speichern: " + e.message, true); }
}

function createSstv(root) {
  root.innerHTML = `<div class="pane-tb"><label class="chk"><input type="checkbox" class="ss-on"> Empfang</label>
    <label class="chk">Modus <select class="ss-mode"><option value="">automatisch (VIS)</option>${Object.keys(SSTV_MODES).map(m => `<option ${m === store.get("sstv.mode", "") ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <button class="ss-now" title="Bild läuft schon: ab jetzt im gewählten Modus empfangen">Jetzt starten</button>
    <button class="ss-tx primary">Bild senden …</button><button class="ss-save">Speichern</button><span class="hint ss-st"></span></div>
    <div class="ss-wrap"><canvas class="ss-cv" width="320" height="256"></canvas></div>`;
  const cv = $(".ss-cv", root), st = $(".ss-st", root);
  const status = () => { const i = SSTV.img; st.textContent = !D.sstv ? "Empfang aus" : SSTV.busy && i ? `${i.mode}: Zeile ${i.lines} / ${i.h}` : i ? `fertig: ${i.mode}, ${i.t.toLocaleTimeString("de-DE")}` : "warte auf Bild (VIS) …";
    $(".ss-on", root).checked = !!D.sstv; };
  const show = i => { if (!i) return; if (cv.width !== i.w || cv.height !== i.h) { cv.width = i.w; cv.height = i.h; } cv.getContext("2d").putImageData(new ImageData(i.px, i.w, i.h), 0, 0); };
  $(".ss-on", root).onchange = e => sstvRxOn(e.target.checked);
  $(".ss-mode", root).onchange = e => { store.set("sstv.mode", e.target.value); if (D.sstv) sstvRxOn(true); };
  $(".ss-now", root).onclick = () => { const m = $(".ss-mode", root).value; if (!m) return toast("Erst einen Modus wählen", true); if (!D.sstv) sstvRxOn(true); D.sstv.startManual(m); };
  $(".ss-tx", root).onclick = () => sstvSendDialog();
  $(".ss-save", root).onclick = () => { const i = SSTV.img; if (!i) return; const a = document.createElement("a"); a.href = sstvCanvasOf(i).toDataURL("image/png"); a.download = `sstv_${i.mode.replace(/\W/g, "")}_${i.t.toISOString().slice(0, 19).replace(/\D/g, "")}.png`; a.click(); };
  let raf = 0; const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; show(SSTV.img); status(); }); };
  const offs = [WW.on("sstv-start", redraw), WW.on("sstv-line", redraw), WW.on("sstv-done", redraw), WW.on("sstv-state", status)];
  show(SSTV.img); status(); return () => offs.forEach(f => f());
}

function createSstvGallery(root) {
  root.innerHTML = `<div class="pane-tb"><button class="sg-ref">Aktualisieren</button><span class="hint">Empfangene Bilder (werden automatisch gespeichert). Klick: groß anzeigen · als Vorlage senden</span></div><div class="sg-list"></div>`;
  const load = async () => { try { const r = await api("/api/sstv");
    $(".sg-list", root).innerHTML = r.images.map(i => `<figure data-n="${esc(i.name)}"><img src="/api/sstv/${encodeURIComponent(i.name)}" loading="lazy" alt=""><figcaption>${esc(i.mode)}<br>${esc(i.time)}</figcaption></figure>`).join("") || '<p class="hint">Noch keine Bilder empfangen.</p>'; } catch (e) { toast(e.message, true); } };
  root.addEventListener("click", e => { const f = e.target.closest("figure[data-n]"); if (!f) return; const n = f.dataset.n;
    popupMenu(f, [{ label: "Groß anzeigen", act: () => window.open(`/api/sstv/${encodeURIComponent(n)}`, "_blank") }, { label: "Als Bild senden …", act: () => sstvSendDialog(`/api/sstv/${encodeURIComponent(n)}`) },
      { label: "In eigenes Bild einfügen (Gegenstation) …", act: () => sstvSendDialog(null, `/api/sstv/${encodeURIComponent(n)}`) },
      { label: "Löschen", act: async () => { await api(`/api/sstv/${encodeURIComponent(n)}`, { method: "DELETE" }); load(); } }]); });
  $(".sg-ref", root).onclick = load; const off = WW.on("sstv-gallery", load); load(); return off;
}

// ---------- Senden: Vorlage aus Hintergrund, Text und optional dem empfangenen Bild der Gegenstation ----------
function sstvSendDialog(bgUrl = null, insetUrl = null) {
  const T = store.get("sstv.tpl", { mode: "Martin M1", l1: "<CALL> de <MYCALL>", l2: "ur <RST>", l3: "<MYLOC>", color: "#ffff00", inset: !!insetUrl, pos: "unten" });
  const d = dialog({ title: "SSTV-Bild senden", icon: "i-cam", wide: true, buttons: [["Schließen", "close"], ["Senden", "send", "primary"]], body: `
    <div class="ss-send"><div><canvas class="ss-prev" width="320" height="256"></canvas><div class="hint ss-dur"></div></div><div class="grid2">
      <label>Modus<select name="mode">${Object.keys(SSTV_MODES).map(m => `<option ${m === T.mode ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label>Hintergrund<select name="bg"><option value="test">Testbild</option><option value="file">Bilddatei …</option><option value="last">zuletzt empfangenes Bild</option>${bgUrl ? '<option value="url" selected>gewähltes Bild</option>' : ""}</select></label>
      <input type="file" accept="image/*" class="ss-file hidden">
      <label class="wide">Zeile 1<input name="l1" value="${esc(T.l1)}"></label><label class="wide">Zeile 2<input name="l2" value="${esc(T.l2)}"></label><label class="wide">Zeile 3<input name="l3" value="${esc(T.l3)}"></label>
      <label>Textfarbe<input type="color" name="color" value="${esc(T.color)}"></label><label>Textlage<select name="pos">${["oben", "mitte", "unten"].map(p => `<option ${p === T.pos ? "selected" : ""}>${p}</option>`).join("")}</select></label>
      <label class="wide chkrow"><input type="checkbox" name="inset" ${T.inset ? "checked" : ""}> Empfangenes Bild der Gegenstation klein einfügen </label>
      <p class="hint wide">Platzhalter wie bei den Makros: &lt;CALL&gt; &lt;RST&gt; &lt;NAME&gt; &lt;MYCALL&gt; &lt;MYLOC&gt; &lt;DATE&gt; &lt;TIME&gt;. RST bei SSTV z. B. 595.</p></div></div>` });
  const F = n => d.querySelector(`[name="${n}"]`), prev = $(".ss-prev", d);
  let bg = null, inset = null;
  const loadImg = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Bild nicht lesbar")); im.src = src; });
  const getBg = async () => { const v = F("bg").value;
    if (v === "url" && bgUrl) return loadImg(bgUrl); if (v === "last" && SSTV.last) return sstvCanvasOf(SSTV.last);
    if (v === "file" && bg) return bg; return null; };
  const render = async () => {
    const m = SSTV_MODES[F("mode").value]; prev.width = m.w; prev.height = m.h; const g = prev.getContext("2d");
    const b = await getBg().catch(() => null);
    if (b) g.drawImage(b, 0, 0, m.w, m.h); else { const gr = g.createLinearGradient(0, 0, m.w, m.h); gr.addColorStop(0, "#1d4e89"); gr.addColorStop(1, "#5bc0eb"); g.fillStyle = gr; g.fillRect(0, 0, m.w, m.h);
      const bars = ["#fff", "#ff0", "#0ff", "#0f0", "#f0f", "#f00", "#00f", "#000"]; bars.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * m.w / 8, m.h * 0.08, m.w / 8, m.h * 0.12); }); }
    if (F("inset").checked) { const src = insetUrl ? await loadImg(insetUrl).catch(() => null) : SSTV.last ? sstvCanvasOf(SSTV.last) : null;
      if (src) { const iw = m.w * 0.36, ih = m.h * 0.36; g.fillStyle = "#000"; g.fillRect(m.w - iw - 8, 6, iw + 4, ih + 4); g.drawImage(src, m.w - iw - 6, 8, iw, ih); } }
    const lines = ["l1", "l2", "l3"].map(n => dmFill(F(n).value)).filter(Boolean), fs = Math.round(m.h / 9);
    g.font = `bold ${fs}px sans-serif`; g.textAlign = "center"; g.lineWidth = Math.max(2, fs / 8); g.strokeStyle = "#000"; g.fillStyle = F("color").value;
    const y0 = F("pos").value === "oben" ? fs * 1.2 : F("pos").value === "mitte" ? m.h / 2 - (lines.length - 1) * fs * 0.55 : m.h - (lines.length - 0.2) * fs * 1.1;
    lines.forEach((t, i) => { const y = y0 + i * fs * 1.1; g.strokeText(t, m.w / 2, y, m.w - 10); g.fillText(t, m.w / 2, y, m.w - 10); });
    const lines2 = m.h / m.rows; $(".ss-dur", d).textContent = `${m.w} × ${m.h} Bildpunkte · Sendedauer ${Math.round((lines2 * m.lineMs + 2610) / 1000)} s`;
  };
  d.addEventListener("input", render); d.addEventListener("change", e => { if (e.target.name === "bg" && e.target.value === "file") $(".ss-file", d).click(); render(); });
  $(".ss-file", d).onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = async () => { bg = await loadImg(r.result); render(); }; r.readAsDataURL(f); };
  d.querySelector('button[value="send"]').addEventListener("click", async e => { e.preventDefault();
    store.set("sstv.tpl", { mode: F("mode").value, l1: F("l1").value, l2: F("l2").value, l3: F("l3").value, color: F("color").value, inset: F("inset").checked, pos: F("pos").value });
    if (D.txSrc) return toast("Es wird bereits gesendet", true);
    const m = SSTV_MODES[F("mode").value], px = prev.getContext("2d").getImageData(0, 0, m.w, m.h).data;
    D.txCtx = D.txCtx || new AudioContext(); const audio = sstvTx(m.name, px, D.txCtx.sampleRate);
    d.close(); toast(`SSTV ${m.name} wird gesendet (${Math.round(audio.length / D.txCtx.sampleRate)} s)`);
    store.set("dm.logmode", "SSTV"); await dmPlay(audio);
  });
  render();
}
