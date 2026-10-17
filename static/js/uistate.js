"use strict";
// Wellenwerk – Zustand der Oberflaeche (Fensteranordnung, Ansichten, Einstellungen im Browser-Speicher) zusaetzlich beim
// Wellenwerk-Dienst sichern. Ist der Browser-Speicher leer (anderer Browser, anderer Port, geloeschte Daten), wird der
// letzte Stand vor dem Start der Oberflaeche zurueckgeholt. Laeuft als erstes Skript.
(function () {
  const KEY = "/api/store/oberflaeche";
  const own = () => { const o = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("ww.")) o[k] = localStorage.getItem(k); } } catch { } return o; };
  try {
    if (!Object.keys(own()).some(k => k !== "ww.alphaHidden" && !k.startsWith("ww.lang"))) {
      const x = new XMLHttpRequest(); x.open("GET", KEY, false); x.send();
      const o = x.status === 200 ? JSON.parse(x.responseText || "null") : null;
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (k.startsWith("ww.") && typeof v === "string" && localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch { }
  let last = JSON.stringify(own());
  const save = keepalive => { const s = JSON.stringify(own()); if (s === last || s === "{}") return; last = s;
    try { fetch(KEY, { method: "PUT", headers: { "Content-Type": "application/json" }, body: s, keepalive: keepalive && s.length < 60000 }).catch(() => { last = ""; }); } catch { } };
  setInterval(() => save(false), 15000);
  addEventListener("pagehide", () => save(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(true); });
})();
