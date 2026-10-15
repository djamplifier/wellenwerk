// Wiedergabe von Empfaenger-Ton (PCM-Bloecke beliebiger Abtastrate) mit Ringpuffer und linearer Interpolation.
class WwPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1 << 17); this.w = 0; this.r = 0; this.n = 0; this.rate = 12000; this.pos = 0; this.started = false;
    this.port.onmessage = e => { const { pcm, rate } = e.data; this.rate = rate || this.rate;
      for (let i = 0; i < pcm.length; i++) { this.buf[this.w] = pcm[i]; this.w = (this.w + 1) & (this.buf.length - 1); }
      this.n = Math.min(this.buf.length, this.n + pcm.length);
      const max = this.rate * 1.0;                 // mehr als 1 s Rueckstand: aufholen
      if (this.n > max) { const skip = this.n - this.rate * 0.25; this.r = (this.r + skip) & (this.buf.length - 1); this.n -= skip; } };
  }
  process(_, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    if (!this.started) { if (this.n < this.rate * 0.15) { out.fill(0); return true; } this.started = true; }
    const step = this.rate / sampleRate, M = this.buf.length - 1;
    for (let i = 0; i < out.length; i++) {
      if (this.n < 2) { out[i] = 0; this.started = false; continue; }
      const a = this.buf[this.r], b = this.buf[(this.r + 1) & M];
      out[i] = a + (b - a) * this.pos;
      this.pos += step; while (this.pos >= 1) { this.pos -= 1; this.r = (this.r + 1) & M; this.n--; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("ww-pcm-player", WwPcmPlayer);
