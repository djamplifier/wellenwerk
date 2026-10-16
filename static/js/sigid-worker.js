"use strict";
// Wellenwerk – Signalerkennung im Hintergrund (Web Worker): die Analyse dauert einige Sekunden und soll die Oberflaeche
// nicht anhalten. Laedt dieselben Dekoder wie der Digitalbetrieb, damit die Probe-Dekodierung moeglich ist.
self.store = { get: (k, d) => d, set() { } };
self.WW = { emit() { }, on() { return () => { }; }, settings: {}, rig: {} };
const V = new URL(self.location.href).searchParams.get("v") || "";
importScripts(...["dsp.js", "dsp2-tables.js", "dsp2.js", "sstv.js", "sigid.js"].map(f => `/static/js/${f}?v=${encodeURIComponent(V)}`));
self.onmessage = e => {
  const { id, x, opts } = e.data;
  try { self.postMessage({ id, res: SIGID.analyze(x, opts) }); }
  catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
