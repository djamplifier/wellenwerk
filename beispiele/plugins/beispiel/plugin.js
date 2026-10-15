// Oberflaechen-Teil der Beispiel-Erweiterung: Fenster „Beispiel“ im Logbuch und ein Menuepunkt.
Wellenwerk.register("beispiel", {
  start(ctx) {
    ctx.addPanel("log", "info", {
      title: "Beispiel",
      create(root) {
        let n = "–", letzte = [];
        const farbe = () => ({ blau: "#2f6fc4", grün: "#1f9d3c", rot: "#d62828" })[ctx.settings.farbe] || "#2f6fc4";
        const draw = () => {
          const s = ctx.station();
          root.innerHTML = `<div style="padding:10px;display:flex;flex-direction:column;gap:6px">
            <div style="font-size:20px;font-weight:700;color:${farbe()}">${ctx.esc(s.callsign || "–")} · ${ctx.esc(s.locator || "")}</div>
            <div>${ctx.esc(ctx.settings.gruss || "")}</div>
            <div class="hint">Profil: ${ctx.esc(s.profile || "Standard")} · Leistung ${ctx.esc(s.tx_pwr || "–")} W · QSOs seit Start: <b>${n}</b></div>
            <div><b>Letzte QSOs</b><br>${letzte.map(q => ctx.esc(`${q.call} ${q.band || ""} ${q.mode || ""}`)).join("<br>") || "–"}</div></div>`;
        };
        ctx.api("hallo").then(r => { n = r.qsos; draw(); }).catch(() => draw());
        ctx.on("station", draw);
        ctx.on("plugin-settings", draw);
        ctx.on("qso", q => { letzte = [q, ...letzte].slice(0, 5); draw(); });
        ctx.on("beispiel_zaehler", m => { n = m.n; draw(); });
        draw();
      },
    });
    ctx.addMenuItem("Beispiel: Gruß vom Server", async () => { const r = await ctx.api("hallo"); ctx.toast(`${r.gruss} (${r.rufzeichen})`); });
  },
  stop() {},
});
