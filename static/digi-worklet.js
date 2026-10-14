// Wellenwerk: Audio-Abgriff im Audio-Thread, Abtastrate auf 8 kHz herabsetzen (vorher Tiefpass im Audiograph)
class WwTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000;
    this.acc = 0; this.sum = 0; this.n = 0; this.peak = 0;
    this.out = new Float32Array(512); this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.acc += 1;
      const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.out[this.len++] = this.sum / this.n; this.sum = 0; this.n = 0;
        if (this.len === this.out.length) {
          this.port.postMessage({ samples: this.out.slice(0), peak: this.peak });
          this.len = 0; this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("ww-tap", WwTap);

// IQ-Abgriff (Stereo: links = I, rechts = Q) fuer den Panadapter ueber eine SDR-/IQ-Soundkarte
class WwIq extends AudioWorkletProcessor {
  constructor(opt) { super(); this.n = (opt.processorOptions && opt.processorOptions.n) || 2048; this.i = new Float32Array(this.n); this.q = new Float32Array(this.n); this.len = 0; this.skip = 0; }
  process(inputs) {
    const inp = inputs[0]; if (!inp || !inp[0]) return true;
    const L = inp[0], R = inp[1] || inp[0];
    for (let k = 0; k < L.length; k++) {
      if (this.skip > 0) { this.skip--; continue; }
      this.i[this.len] = L[k]; this.q[this.len] = R[k];
      if (++this.len === this.n) { this.port.postMessage({ i: this.i.slice(0), q: this.q.slice(0), sr: sampleRate }); this.len = 0; this.skip = Math.round(sampleRate / 15) - this.n; }   // ~15 Spektren/s
    }
    return true;
  }
}
registerProcessor("ww-iq", WwIq);
