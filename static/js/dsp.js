"use strict";
// (aus digi.js ausgelagert: reine Signalverarbeitung, ohne Oberflaeche)
// Wellenwerk – Digitalmodi: Wasserfall, Dekoder und Sender fuer PSK31, RTTY (45,45 Bd / 170 Hz) und CW.
// Alles laeuft im Browser an der Soundkarte, an der das Funkgeraet haengt. Abtastrate intern 8 kHz.
const DFS = 8000;
const TAU = 2 * Math.PI;

// ---------- Zeichentabellen ----------
const VARICODE = ["1010101011", "1011011011", "1011101101", "1101110111", "1011101011", "1101011111", "1011101111", "1011111101",
  "1011111111", "11101111", "11101", "1101101111", "1011011101", "11111", "1101110101", "1110101011", "1011110111", "1011110101",
  "1110101101", "1110101111", "1101011011", "1101101011", "1101101101", "1101010111", "1101111011", "1101111101", "1110110111",
  "1101010101", "1101011101", "1110111011", "1011111011", "1101111111", "1", "111111111", "101011111", "111110101", "111011011",
  "1011010101", "1010111011", "101111111", "11111011", "11110111", "101101111", "111011111", "1110101", "110101", "1010111",
  "110101111", "10110111", "10111101", "11101101", "11111111", "101110111", "101011011", "101101011", "110101101", "110101011",
  "110110111", "11110101", "110111101", "111101101", "1010101", "111010111", "1010101111", "1010111101", "1111101", "11101011",
  "10101101", "10110101", "1110111", "11011011", "11111101", "101010101", "1111111", "111111101", "101111101", "11010111",
  "10111011", "11011101", "10101011", "11010101", "111011101", "10101111", "1101111", "1101101", "101010111", "110110101",
  "101011101", "101110101", "101111011", "1010101101", "111110111", "111101111", "111111011", "1010111111", "101101101",
  "1011011111", "1011", "1011111", "101111", "101101", "11", "111101", "1011011", "101011", "1101", "111101011", "10111111",
  "11011", "111011", "1111", "111", "111111", "110111111", "10101", "10111", "101", "110111", "1111011", "1101011", "11011111",
  "1011101", "111010101", "1010110111", "110111011", "1010110101", "1011010111", "1110110101"];
const VARI_DEC = Object.fromEntries(VARICODE.map((v, i) => [v, i]));
// ITA2 / US-Fernschreibcode, Index = Codewert (erstes gesendetes Bit = Bit 0)
const BAUDOT_LTRS = ["", "E", "\n", "A", " ", "S", "I", "U", "\r", "D", "R", "J", "N", "F", "C", "K", "T", "Z", "L", "W", "H", "Y", "P", "Q", "O", "B", "G", "\x0f", "M", "X", "V", "\x0e"];
const BAUDOT_FIGS = ["", "3", "\n", "-", " ", "'", "8", "7", "\r", "$", "4", "\x07", ",", "!", ":", "(", "5", "\"", ")", "2", "#", "6", "0", "1", "9", "?", "&", "\x0f", ".", "/", ";", "\x0e"];
const BAUDOT_LTRS_CODE = 31, BAUDOT_FIGS_CODE = 27;
const MORSE = { ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E", "..-.": "F", "--.": "G", "....": "H", "..": "I", ".---": "J", "-.-": "K",
  ".-..": "L", "--": "M", "-.": "N", "---": "O", ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T", "..-": "U", "...-": "V", ".--": "W",
  "-..-": "X", "-.--": "Y", "--..": "Z", "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5", "-....": "6",
  "--...": "7", "---..": "8", "----.": "9", ".-.-.-": ".", "--..--": ",", "..--..": "?", "-..-.": "/", "-...-": "=", ".-.-.": "+", "-....-": "-",
  ".--.-.": "@", "...-.-": "<SK>", "-.--.": "(", "-.--.-": ")", ".-...": "<AS>", "-.-.-": "<KA>", "...-.": "<SN>" };

// ---------- FFT fuer den Wasserfall ----------
class FFT {
  constructor(n) {
    this.n = n; this.re = new Float32Array(n); this.im = new Float32Array(n);
    this.rev = new Uint32Array(n); const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(TAU * i / n); this.sin[i] = -Math.sin(TAU * i / n); }
    this.win = new Float32Array(n); for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (n - 1));
  }
  power(x) {   // x: Float32Array Laenge n -> Leistung je Bin (n/2) in dB
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = x[i] * this.win[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
        const k = j * step, tr = re[i + j + half] * this.cos[k] - im[i + j + half] * this.sin[k], ti = re[i + j + half] * this.sin[k] + im[i + j + half] * this.cos[k];
        re[i + j + half] = re[i + j] - tr; im[i + j + half] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
      }
    }
    const out = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) out[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
    return out;
  }
  // komplexes Spektrum aus I/Q, Mitte = 0 Hz (negative Frequenzen links); Ergebnis n Werte in dB
  powerIQ(I, Q, swap = false) {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = (swap ? Q[i] : I[i]) * this.win[i]; im[rev[i]] = (swap ? I[i] : Q[i]) * this.win[i]; }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
        const k = j * step, tr = re[i + j + half] * this.cos[k] - im[i + j + half] * this.sin[k], ti = re[i + j + half] * this.sin[k] + im[i + j + half] * this.cos[k];
        re[i + j + half] = re[i + j] - tr; im[i + j + half] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
      }
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const k = (i + n / 2) % n; out[i] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12); }
    return out;
  }
}

// ---------- Hilfen ----------
class Nco { constructor(f) { this.ph = 0; this.set(f); } set(f) { this.f = f; this.inc = TAU * f / DFS; }
  step() { const c = Math.cos(this.ph), s = Math.sin(this.ph); this.ph += this.inc; if (this.ph > TAU) this.ph -= TAU; return [c, s]; } }
class Boxcar { constructor(n) { this.n = n; this.buf = new Float32Array(n); this.i = 0; this.sum = 0; }
  push(x) { this.sum += x - this.buf[this.i]; this.buf[this.i] = x; this.i = (this.i + 1) % this.n; return this.sum / this.n; } }

// ---------- PSK31 ----------
class Psk31Rx {
  constructor(f, onChar, baud = 31.25) { this.onChar = onChar; this.nco = new Nco(f); this.decI = 0; this.decQ = 0; this.decN = 0;
    this.baud = baud; this.dec = Math.round(DFS / (baud * 16));        // 16 Werte je Symbol: PSK31 /16, PSK63 /8, PSK125 /4
    // Matched Filter ueber genau ein Symbol (16 Werte bei 500 Hz): zwischen zwei Phasenwechseln bleibt das Vorzeichen gleich
    this.hist = []; this.h = Array.from({ length: 16 }, (_, k) => Math.sin(Math.PI * (k + 0.5) / 16) ** 2);
    this.n = 0; this.best = 0; this.E = new Float32Array(16); this.prev = null; this.reg = ""; this.q = 0; this.afc = true; this.sql = 0.25; this.freqCb = null; }
  get freq() { return this.nco.f; } set freq(f) { this.nco.set(f); }
  process(x) {
    for (let i = 0; i < x.length; i++) {
      const [c, s] = this.nco.step(); this.decI += x[i] * c; this.decQ -= x[i] * s;
      if (++this.decN === this.dec) { this.sample500(this.decI / this.dec, this.decQ / this.dec); this.decI = this.decQ = 0; this.decN = 0; }
    }
  }
  sample500(i, q) {
    this.hist.push([i, q]); if (this.hist.length > 16) this.hist.shift(); if (this.hist.length < 16) return;
    let zi = 0, zq = 0; for (let k = 0; k < 16; k++) { zi += this.hist[k][0] * this.h[k]; zq += this.hist[k][1] * this.h[k]; }
    const p = this.n % 16; this.n++;
    const a = this.n < 16 * 40 ? 0.12 : 0.03;              // am Anfang schneller einrasten
    this.E[p] = (1 - a) * this.E[p] + a * Math.hypot(zi, zq);
    // Abtastzeitpunkt nur einmal je Symbol neu festlegen und genau einmal je Symbol entscheiden
    if (p === 0) { let b = 0; for (let k = 1; k < 16; k++) if (this.E[k] > this.E[b]) b = k; this.best = b; }
    if (p !== this.best) return;
    if (this.n - (this.lastDec || -99) < 12) return;
    this.lastDec = this.n;
    if (this.prev) {
      const [pi, pq] = this.prev, dr = zi * pi + zq * pq, di = zq * pi - zi * pq;
      if (this.decide) { this.decide(dr, di); this.prev = [zi, zq]; return; }     // QPSK (dsp2.js)
      const dphi = Math.atan2(di, dr), bit = dr > 0 ? 1 : 0;
      this.q = 0.92 * this.q + 0.08 * Math.cos(2 * dphi);
      // AFC: Frequenzfehler aus dem Phasenrest (BPSK-Modulation durch Verdopplung entfernt); nur bei vorhandenem Signal
      let emax = 0, esum = 0; for (let k = 0; k < 16; k++) { emax = Math.max(emax, this.E[k]); esum += this.E[k]; }
      if (this.afc && emax > 1.25 * esum / 16) {
        const err = Math.atan2(Math.sin(2 * dphi), Math.cos(2 * dphi)) / 2 / (TAU / this.baud);
        this.nco.set(this.nco.f + Math.max(-1.5, Math.min(1.5, err * (this.q > 0.5 ? 0.05 : 0.2))));
        if (this.freqCb) this.freqCb(this.nco.f);
      }
      this.bit(bit);
    }
    this.prev = [zi, zq];
  }
  bit(b) {
    this.reg += b;
    if (this.reg.endsWith("00")) {
      const code = this.reg.slice(0, -2).replace(/^0+/, ""); this.reg = "";      // Varicode beginnt immer mit 1
      if (code && this.q >= this.sql && code in VARI_DEC) { const c = VARI_DEC[code]; if (c === 10 || c === 13 || c >= 32) this.onChar(c === 13 ? "" : String.fromCharCode(c)); }
    } else if (this.reg.length > 14) this.reg = "";
  }
}
function psk31Tx(text, f, sr, baud = 31.25) {
  let bits = "0".repeat(64);
  for (const ch of text) { const c = ch.charCodeAt(0); if (c < 128) bits += VARICODE[c] + "00"; }
  bits += "1".repeat(24);
  const T = sr / baud, out = new Float32Array(Math.ceil(bits.length * T + T)), w = TAU * f / sr;
  let sign = 1, n = 0;
  for (const b of bits) {
    for (let t = 0; t < T; t++, n++) { const a = b === "0" ? sign * Math.cos(Math.PI * t / T) : sign; out[n] = 0.7 * a * Math.sin(w * n); }
    if (b === "0") sign = -sign;
  }
  for (let t = 0; t < T && n < out.length; t++, n++) out[n] = 0.7 * sign * Math.cos(Math.PI / 2 * t / T) * Math.sin(w * n);   // sanft aus
  return out.subarray(0, n);
}

// ---------- RTTY ----------
class RttyRx {
  constructor(f, onChar, markHigh = true) { this.onChar = onChar; this.baud = 45.45; this.shift = 170; this.markHigh = markHigh; this.setFreq(f);
    const L = Math.round(DFS / this.baud); this.bl = DFS / this.baud;
    this.f = [new Boxcar(L), new Boxcar(L), new Boxcar(L), new Boxcar(L)]; this.state = 0; this.t = 0; this.prevD = 0; this.code = 0; this.figs = false; this.q = 0; this.sql = 0.3; }
  get freq() { return this.center; }
  set freq(f) { this.setFreq(f); }
  setFreq(f) { this.center = f; const m = this.markHigh ? f + this.shift / 2 : f - this.shift / 2, s = this.markHigh ? f - this.shift / 2 : f + this.shift / 2;
    this.mark = new Nco(m); this.space = new Nco(s); }
  process(x) {
    for (let i = 0; i < x.length; i++) {
      const [mc, ms] = this.mark.step(), [sc, ss] = this.space.step();
      const mi = this.f[0].push(x[i] * mc), mq = this.f[1].push(x[i] * ms), si = this.f[2].push(x[i] * sc), sq = this.f[3].push(x[i] * ss);
      const m = Math.hypot(mi, mq), s = Math.hypot(si, sq), d = (m - s) / (m + s + 1e-9);
      this.uart(d);
    }
  }
  uart(d) {
    const bl = this.bl;
    if (this.state === 0) { if (this.prevD > 0 && d <= 0) { this.state = 1; this.t = 0; this.code = 0; this.qsum = 0; } }
    else {
      this.t++;
      if (this.state === 1 && this.t >= bl * 0.5) { if (d < 0) this.state = 2; else this.state = 0; this.qsum += Math.abs(d); }
      else if (this.state === 2) {
        const k = Math.round((this.t - bl * 1.5) / bl);               // Mitte von Datenbit k
        if (k >= 0 && k < 5 && Math.abs(this.t - (bl * (1.5 + k))) < 0.5) { if (d > 0) this.code |= 1 << k; this.qsum += Math.abs(d); }
        if (this.t >= bl * 6.25) {
          if (d > 0) { this.q = this.qsum / 7; this.emit(this.code); }
          this.state = 0;
        }
      }
    }
    this.prevD = d;
  }
  emit(c) {
    if (c === BAUDOT_LTRS_CODE) { this.figs = false; return; }
    if (c === BAUDOT_FIGS_CODE) { this.figs = true; return; }
    if (this.q < this.sql) return;
    const ch = (this.figs ? BAUDOT_FIGS : BAUDOT_LTRS)[c];
    if (c === 4) this.figs = false;                 // Unshift on Space (USOS)
    if (ch && ch !== "\r" && ch !== "\x07") this.onChar(ch);
  }
}
function rttyTx(text, f, sr, markHigh = true) {
  const mark = markHigh ? f + 85 : f - 85, space = markHigh ? f - 85 : f + 85, bl = sr / 45.45;
  const codes = []; let figs = null;
  const lt = new Map(BAUDOT_LTRS.map((c, i) => [c, i])), fg = new Map(BAUDOT_FIGS.map((c, i) => [c, i]));
  codes.push(BAUDOT_LTRS_CODE, BAUDOT_LTRS_CODE); figs = false;
  for (const raw of text.toUpperCase().replace(/\n/g, "\r\n")) {
    const ch = raw === "\x0e" || raw === "\x0f" ? "" : raw;
    if (lt.has(ch) && ch !== "" && (!figs || ch === " " || ch === "\r" || ch === "\n")) { codes.push(lt.get(ch)); if (ch === " ") figs = false; continue; }
    if (fg.has(ch) && ch !== "") { if (!figs) { codes.push(BAUDOT_FIGS_CODE); figs = true; } codes.push(fg.get(ch)); continue; }
    if (lt.has(ch) && ch !== "") { codes.push(BAUDOT_LTRS_CODE); figs = false; codes.push(lt.get(ch)); }
  }
  codes.push(BAUDOT_LTRS_CODE);
  const bits = [];
  for (let i = 0; i < Math.round(0.4 * 45.45); i++) bits.push(1);              // Vorlauf Mark
  for (const c of codes) { bits.push(0); for (let k = 0; k < 5; k++) bits.push((c >> k) & 1); bits.push(1, 1.5); }
  for (let i = 0; i < 8; i++) bits.push(1);
  let len = 0; for (const b of bits) len += b === 1.5 ? bl * 0.5 : bl;
  const out = new Float32Array(Math.ceil(len)); let n = 0, ph = 0;
  for (const b of bits) {
    const dur = b === 1.5 ? bl * 0.5 : bl, f0 = b ? mark : space, inc = TAU * f0 / sr, end = Math.round(n + dur);
    for (; n < end && n < out.length; n++) { out[n] = 0.7 * Math.sin(ph); ph += inc; }
  }
  return out.subarray(0, n);
}

// ---------- CW ----------
class CwRx {
  constructor(f, onChar) { this.onChar = onChar; this.nco = new Nco(f); this.bi = new Boxcar(64); this.bq = new Boxcar(64); this.k = 0;
    this.peak = 1e-6; this.floor = 1e-6; this.down = false; this.dur = 0; this.dit = 60; this.sym = ""; this.wordSent = true; this.sql = 0.25; }
  get freq() { return this.nco.f; } set freq(f) { this.nco.set(f); }
  get wpm() { return Math.round(1200 / this.dit); }
  process(x) {
    for (let i = 0; i < x.length; i++) {
      const [c, s] = this.nco.step(), ei = this.bi.push(x[i] * c), eq = this.bq.push(x[i] * s);
      if (++this.k % 8) continue;                               // 1 kHz Takt fuer die Auswertung
      const env = Math.hypot(ei, eq);
      this.peak = Math.max(env, this.peak * 0.9993);
      this.floor = env < this.floor ? env : this.floor + (env - this.floor) * 0.0008;
      const snrOk = this.peak > this.floor * 4 && this.peak > this.sql * 0.01;
      const thr = this.floor + (this.down ? 0.35 : 0.5) * (this.peak - this.floor);
      const key = snrOk && env > thr;
      this.dur++;
      if (key !== this.down) { this.edge(this.down, this.dur); this.down = key; this.dur = 0; }
      else if (!key) this.gap(this.dur);
    }
  }
  edge(wasDown, ms) {
    if (wasDown) {
      if (ms < 12) return;                                       // Stoerspitze
      if (ms < 2 * this.dit) { this.sym += "."; this.dit = 0.85 * this.dit + 0.15 * ms; }
      else { this.sym += "-"; this.dit = 0.85 * this.dit + 0.15 * ms / 3; }
      this.dit = Math.max(20, Math.min(240, this.dit));
      this.wordSent = false;
    }
  }
  gap(ms) {
    if (this.sym && ms > 2.2 * this.dit) { this.onChar(MORSE[this.sym] || "_"); this.sym = ""; }
    if (!this.wordSent && !this.sym && ms > 5.5 * this.dit) { this.onChar(" "); this.wordSent = true; }
  }
}


// Selbsttest ohne Soundkarte: Sender -> (Rauschen) -> Dekoder
function digiSelfTest(mode, text, f = 1500, snr = 0.3) {
  let out = "";
  const rx = mode === "PSK31" ? new Psk31Rx(f + 3, c => out += c) : mode === "RTTY" ? new RttyRx(f, c => out += c, true) : new CwRx(f, c => out += c);
  rx.sql = 0;
  let sig;
  if (mode === "PSK31") sig = psk31Tx(text, f, DFS);
  else if (mode === "RTTY") sig = rttyTx(text, f, DFS, true);
  else { // CW-Testsignal 20 WpM
    const dit = 0.06 * DFS, parts = []; const inv = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
    for (const ch of text.toUpperCase()) { if (ch === " ") { parts.push([0, 4 * dit]); continue; } const m = inv[ch]; if (!m) continue; for (const s of m) { parts.push([1, s === "." ? dit : 3 * dit], [0, dit]); } parts.push([0, 2 * dit]); }
    parts.push([0, 10 * dit]);
    const len = parts.reduce((a, p) => a + p[1], 0); sig = new Float32Array(Math.ceil(len)); let n = 0;
    for (const [on, d] of parts) for (let i = 0; i < d; i++, n++) sig[n] = on ? 0.6 * Math.sin(TAU * f * n / DFS) : 0;
  }
  const lead = new Float32Array(DFS / 2), x = new Float32Array(lead.length + sig.length + DFS / 2); x.set(sig, lead.length);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < x.length; i++) x[i] += snr * (rnd() + rnd() + rnd() - 1.5);
  for (let i = 0; i < x.length; i += 512) rx.process(x.subarray(i, i + 512));
  return out;
}
