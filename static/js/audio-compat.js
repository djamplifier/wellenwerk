"use strict";
// Wellenwerk – Audio ohne sichere Verbindung. Browser stellen AudioWorklet nur ueber https oder localhost bereit;
// wird Wellenwerk im Heimnetz ueber http://rechner:8090 geoeffnet, fehlt es. Dann laufen dieselben Worklet-Module
// (sdr-worklet.js, digi-worklet.js) hier im Hauptthread in einem ScriptProcessorNode – Empfang, Wasserfall,
// Digitalbetrieb und Wiedergabe funktionieren damit auch ohne https (nur Mikrofon/Soundkarte brauchen weiter https).
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || (window.AudioWorkletNode && "audioWorklet" in AC.prototype)) return;
  const scopes = new WeakMap();   // AudioContext → { procs: Map(name → Klasse), loaded: Map(url → Promise) }
  const scope = ctx => { let s = scopes.get(ctx); if (!s) scopes.set(ctx, s = { procs: new Map(), loaded: new Map() }); return s; };
  class Port {
    constructor() { this.onmessage = null; this.other = null; }
    postMessage(data) { const o = this.other; queueMicrotask(() => o && o.onmessage && o.onmessage({ data })); }
    start() { } close() { }
  }
  const pair = () => { const a = new Port(), b = new Port(); a.other = b; b.other = a; return [a, b]; };
  let pendingPort = null;
  class Processor { constructor() { this.port = pendingPort; } }
  Object.defineProperty(AC.prototype, "audioWorklet", { configurable: true, get() {
    const ctx = this;
    return { addModule(url) {
      const s = scope(ctx);
      if (!s.loaded.has(url)) s.loaded.set(url, fetch(url).then(r => { if (!r.ok) throw new Error("Laden fehlgeschlagen: " + url); return r.text(); }).then(src => {
        new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentTime", src)(
          Processor, (name, cls) => s.procs.set(name, cls), ctx.sampleRate, 0);
      }));
      return s.loaded.get(url);
    } };
  } });
  window.AudioWorkletNode = function AudioWorkletNode(ctx, name, opts = {}) {
    const cls = scope(ctx).procs.get(name);
    if (!cls) throw new Error(`AudioWorklet „${name}“ nicht geladen`);
    const inCh = opts.channelCount || 2, outCh = (opts.outputChannelCount && opts.outputChannelCount[0]) || 2;
    const sp = ctx.createScriptProcessor(2048, inCh, outCh);
    const [mainPort, procPort] = pair();
    pendingPort = procPort;
    const proc = new cls({ processorOptions: opts.processorOptions || {}, numberOfInputs: 1, numberOfOutputs: 1 });
    pendingPort = null;
    proc.port = proc.port || procPort;
    sp.port = mainPort;
    let alive = true;
    sp.onaudioprocess = e => {
      if (!alive) return;
      const ins = [], outs = [];
      for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) ins.push(e.inputBuffer.getChannelData(c));
      for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) { const o = e.outputBuffer.getChannelData(c); o.fill(0); outs.push(o); }
      try { alive = proc.process([ins], [outs], {}) !== false; } catch (err) { console.error(name, err); alive = false; }
    };
    // ScriptProcessor laeuft nur, wenn er (direkt oder indirekt) an den Ausgang angeschlossen ist – stumm anhaengen
    const mute = ctx.createGain(); mute.gain.value = 0; sp.connect(mute).connect(ctx.destination);
    return sp;
  };
  window.WW_AUDIO_COMPAT = true;
})();
