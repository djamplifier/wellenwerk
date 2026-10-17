"use strict";
// Wellenwerk – Senden mit sendefaehigen SDRs (HackRF One, Hermes Lite 2): Sendeton geht ueber /ws/tx an den Dienst, der
// moduliert und an das Geraet gibt. Bei gedrueckter PTT das Mikrofon, bei Digimodes/SSTV deren erzeugter Ton.
const SDRTX = { ws: null, wsId: "", mic: null, ext: 0, stopT: 0 };
function sdrTxOn() { const r = (WW.radios || []).find(x => x.id === WW.current); return isSdr(r) && !!WW.caps?.tx; }
function sdrTxWs() {
  if (SDRTX.ws && SDRTX.ws.readyState < 2 && SDRTX.wsId === WW.current) return SDRTX.ws;
  try { SDRTX.ws?.close(); } catch { }
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}/ws/tx?radio=${encodeURIComponent(WW.current || "")}`);
  ws.binaryType = "arraybuffer"; SDRTX.ws = ws; SDRTX.wsId = WW.current; return ws;
}
function sdrTxSend(f, rate) {
  const ws = sdrTxWs(), buf = new ArrayBuffer(4 + f.length * 2), dv = new DataView(buf), g = store.get("tx.lvl", 1);
  dv.setUint32(0, rate, true); for (let i = 0; i < f.length; i++) dv.setInt16(4 + 2 * i, Math.max(-32767, Math.min(32767, f[i] * g * 32767)), true);
  if (ws.readyState === 1) ws.send(buf); else ws.addEventListener("open", () => ws.send(buf), { once: true });
}
// Knoten, der alles, was hineingeht, in Echtzeit an den Dienst schickt (Digimodes, SSTV, Abstimmton)
function sdrTxNode(ctx) {
  const sp = ctx.createScriptProcessor(2048, 1, 1), m = ctx.createGain(); m.gain.value = 0;
  sp.onaudioprocess = e => sdrTxSend(Float32Array.from(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
  sp.connect(m).connect(ctx.destination); return sp;
}
async function sdrMicStart() {
  clearTimeout(SDRTX.stopT); if (SDRTX.mic) return;
  if (!navigator.mediaDevices?.getUserMedia) { toast("Mikrofon nur im Desktop-Programm, über localhost oder https", true); return; }
  const dev = store.get("tx.mic", "");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), node = sdrTxNode(ctx); src.connect(node);
    SDRTX.mic = { stream, ctx, node };
  } catch (e) { toast("Mikrofon: " + e.message, true); }
}
function sdrMicStop() { const m = SDRTX.mic; if (!m) return; SDRTX.mic = null; try { m.node.disconnect(); m.stream.getTracks().forEach(t => t.stop()); m.ctx.close(); } catch { } }
// PTT des SDR: Mikrofon an (ausser Digimodes senden gerade selbst), nach dem Loslassen bald wieder frei
let sdrPttWas = false;
WW.on("rig", () => {
  const on = !!WW.rig?.ptt && sdrTxOn();
  if (on && !sdrPttWas && !SDRTX.ext) sdrMicStart();
  if (!on && sdrPttWas) { clearTimeout(SDRTX.stopT); SDRTX.stopT = setTimeout(sdrMicStop, 400); }
  sdrPttWas = on;
});
