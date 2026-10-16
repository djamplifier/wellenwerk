"use strict";
// Wellenwerk – Signalerkennung im Hintergrund (Web Worker): die Analyse dauert einige Sekunden und soll die Oberflaeche
// nicht anhalten. Laedt dieselben Dekoder wie der Digitalbetrieb, damit die Probe-Dekodierung moeglich ist.
// FT8/FT4 dekodiert ft8_lib (MIT, als WebAssembly in /static/vendor/ftx.js) – ein lesbares Telegramm ist der sicherste Nachweis.
self.store = { get: (k, d) => d, set() { } };
self.WW = { emit() { }, on() { return () => { }; }, settings: {}, rig: {} };
const V = new URL(self.location.href).searchParams.get("v") || "";
importScripts(...["dsp.js", "dsp2-tables.js", "dsp2.js", "sstv.js", "sigid.js"].map(f => `/static/js/${f}?v=${encodeURIComponent(V)}`));
let FTX = null;
const ftxModule = () => FTX || (FTX = (importScripts(`/static/vendor/ftx.js?v=${encodeURIComponent(V)}`), createFtx()));
// Ton (8 kHz o. a.) dekodieren: [{snr, dt, f, text}]
async function ftxDecode(x, rate, ft4) {
  const M = await ftxModule(), p = M._malloc(x.length * 4), o = M._malloc(16384);
  try { M.HEAPF32.set(x, p >> 2); M._ww_ftx_decode(p, x.length, rate, ft4 ? 1 : 0, o, 16384);
    return M.UTF8ToString(o).split("\n").filter(Boolean).map(l => { const [snr, dt, f, text] = l.split("\t"); return { snr: +snr, dt: +dt, f: +f, text }; }); }
  finally { M._free(p); M._free(o); }
}
self.onmessage = async e => {
  const { id, x, opts, ftx } = e.data;
  try {
    if (ftx) return self.postMessage({ id, res: await ftxDecode(x, ftx.rate || 8000, ftx.ft4) });
    const res = SIGID.analyze(x, opts);
    if (opts.decode !== false) for (const [name, ft4, need] of [["FT8", false, 8000 * 12.7], ["FT4", true, 8000 * 5]]) {
      if (x.length < need) continue;
      const msgs = await ftxDecode(x, 8000, ft4).catch(() => []);
      if (!msgs.length) continue;
      let c = (res.cands || []).find(k => k.id === name);
      if (!c) { c = { id: name, label: name }; (res.cands = res.cands || []).push(c); }
      const f = msgs.reduce((s, m) => s + m.f, 0) / msgs.length;
      Object.assign(c, { score: 0.99, text: msgs.map(m => m.text).join(" · "), textScore: 1, ftx: msgs, center: f, label: `${name} · ${msgs.length} ${msgs.length === 1 ? "Telegramm" : "Telegramme"} gelesen` });
      res.cands.sort((a, b) => b.score - a.score); res.best = res.cands[0];
      break;
    }
    self.postMessage({ id, res });
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
