"use strict";
// Wellenwerk – weitere Digitalmodi : Hellschreiber, MFSK, DominoEX, THOR, Throb, Olivia, Contestia, MT63, SSTV.
// Eigene Umsetzung nach den veroeffentlichten Protokollbeschreibungen; Kompatibilitaet wird gegen fldigi geprueft.
// Gemeinsame Schnittstelle (DIGI_MODES): rx(f, onChar) -> Objekt mit process(x @ 8 kHz), freq, sql; tx(text, f, sr) -> Float32Array.

// ---------- Grundbausteine ----------
// Hochwertige Abtastraten-Wandlung 8 kHz -> Soundkarte (gefenstertes sinc), damit keine Spiegelfrequenzen entstehen
function resampleFrom8k(x, sr) {
  if (sr === DFS) return x;
  const ratio = sr / DFS, n = Math.floor(x.length * ratio), y = new Float32Array(n), H = 16, fc = 0.45;
  for (let i = 0; i < n; i++) {
    const t = i / ratio, c = Math.floor(t); let s = 0;
    for (let k = c - H + 1; k <= c + H; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = t - k, w = 0.5 + 0.5 * Math.cos(Math.PI * d / H);
      s += x[k] * (d === 0 ? 2 * fc : Math.sin(TAU * fc * d) / (Math.PI * d)) * w;
    }
    y[i] = s;
  }
  return y;
}
// phasenstetige Tonfolge: [[Frequenz, Dauer in Abtastwerten @ 8 kHz], ...]
function toneSeq(seq, amp = 0.7) {
  const n = seq.reduce((a, s) => a + s[1], 0), y = new Float32Array(Math.ceil(n) + 1); let ph = 0, k = 0, acc = 0;
  for (const [f, d] of seq) { acc += d; const inc = TAU * f / DFS; for (; k < acc; k++) { y[k] = amp * Math.cos(ph); ph += inc; if (ph > TAU) ph -= TAU; } }
  // weiches Ein- und Ausblenden (5 ms)
  const r = 40; for (let i = 0; i < r && i < k; i++) { const g = 0.5 - 0.5 * Math.cos(Math.PI * i / r); y[i] *= g; y[k - 1 - i] *= g; }
  return y.subarray(0, k);
}
const gray = x => x ^ (x >> 1);
const ungray = x => { let y = x; for (let s = x >> 1; s; s >>= 1) y ^= s; return y; };
const parity = x => { let p = 0; while (x) { p ^= x & 1; x >>= 1; } return p; };

// Faltungscode K=7 (0x6d, 0x4f) wie MFSK/THOR: Bit 0 = Polynom 1 wird zuerst gesendet
class ConvEnc { constructor(k = 7, p1 = 0x6d, p2 = 0x4f) { this.mask = (1 << k) - 1; this.p1 = p1; this.p2 = p2; this.sh = 0; }
  enc(b) { this.sh = ((this.sh << 1) | (b ? 1 : 0)) & this.mask; return [parity(this.sh & this.p1), parity(this.sh & this.p2)]; } }
// Viterbi-Dekoder mit weichen Werten 0..255 (128 = unbekannt), feste Entscheidungsverzoegerung
class Viterbi {
  constructor(k = 7, p1 = 0x6d, p2 = 0x4f, depth = 45) {
    this.ns = 1 << (k - 1); this.depth = depth; this.out = new Uint8Array(1 << k);
    for (let i = 0; i < (1 << k); i++) this.out[i] = parity(i & p1) | (parity(i & p2) << 1);
    this.m = new Float64Array(this.ns); this.hist = []; }
  // liefert ein Bit (oder -1, solange die Verzoegerung noch nicht erreicht ist) und die Pfadguete
  dec(s0, s1) {
    const ns = this.ns, met = [0, 0, 0, 0];
    for (let o = 0; o < 4; o++) met[o] = ((o & 1) ? s0 - 128 : 128 - s0) + ((o & 2) ? s1 - 128 : 128 - s1);
    const nm = new Float64Array(ns), h = new Uint8Array(ns);
    for (let n = 0; n < ns; n++) {
      // Zustand n entsteht aus p = n>>1 (+ ns/2) mit neuem Bit n&1
      const b = n & 1, pA = n >> 1, pB = (n >> 1) + (ns >> 1);
      const mA = this.m[pA] + met[this.out[(pA << 1) | b]], mB = this.m[pB] + met[this.out[(pB << 1) | b]];
      if (mA >= mB) { nm[n] = mA; h[n] = 0; } else { nm[n] = mB; h[n] = 1; }
    }
    let best = 0; for (let n = 1; n < ns; n++) if (nm[n] > nm[best]) best = n;
    const top = nm[best]; for (let n = 0; n < ns; n++) nm[n] -= top;
    this.qual = 0.97 * (this.qual || 0) + 0.03 * top;        // Zuwachs des besten Pfads: 254 = fehlerfrei, ~0 = Rauschen
    this.m = nm; this.hist.push(h); if (this.hist.length <= this.depth) return [-1, 0];
    let s = best; for (let i = this.hist.length - 1; i > 0; i--) s = this.hist[i][s] ? (s >> 1) + (ns >> 1) : s >> 1;
    const bit = s & 1; this.hist.shift();
    return [bit, this.qual];
  }
}
// Diagonal-Interleaver (IZ8BLY): size Bits je Symbol, depth Bloecke; dir 1 = senden, -1 = empfangen
class Interleaver {
  constructor(size, depth, dir) { this.size = size; this.depth = depth; this.dir = dir; this.t = new Uint8Array(size * size * depth).fill(dir > 0 ? 0 : 128); }
  symbols(p) { const S = this.size, t = this.t;
    for (let k = 0; k < this.depth; k++) { const b = S * S * k;
      for (let i = 0; i < S; i++) { for (let j = 0; j < S - 1; j++) t[b + S * i + j] = t[b + S * i + j + 1]; t[b + S * i + S - 1] = p[i]; }
      for (let i = 0; i < S; i++) p[i] = this.dir > 0 ? t[b + S * i + S - i - 1] : t[b + S * i + i]; }
    return p; }
  bits(v) { const S = this.size, p = new Uint8Array(S); for (let i = 0; i < S; i++) p[i] = (v >> (S - i - 1)) & 1; this.symbols(p); let r = 0; for (let i = 0; i < S; i++) r = (r << 1) | p[i]; return r; }
}
// Varicode-Schieberegister fuer MFSK/THOR: Zeichengrenze bei "001"
const MFSK_DEC = new Map(MFSK_VARI.map((c, i) => [parseInt(c, 2), i]));
const THOR_DEC = new Map(THOR_SEC.map((c, i) => [parseInt(c, 2), 0x100 + 32 + i]));
class VariShift { constructor(map2) { this.r = 1; this.map2 = map2; }
  bit(b) { this.r = ((this.r << 1) | b) >>> 0; if ((this.r & 7) === 1) { const v = this.r >>> 1, c = MFSK_DEC.has(v) ? MFSK_DEC.get(v) : this.map2 && this.map2.has(v) ? this.map2.get(v) : -1; this.r = 1; return c; } if (this.r > 0x3fffffff) this.r = 1; return -1; } }

// Tonfilterbank: gleitende DFT ueber ein Symbol fuer jeden Ton, Symboltakt aus der Energie (16 Phasen)
class ToneBank {
  constructor(freqs, N, onSym, slots = 16) {
    this.N = Math.round(N); this.slots = slots; this.step = this.N / slots; this.onSym = onSym; this.setFreqs(freqs);
    this.n = 0; this.next = this.step; this.slot = 0; this.E = new Float32Array(slots); this.best = 0; this.cnt = 0; this.last = -1e9; }
  setFreqs(freqs) { const K = freqs.length, N = this.N; this.K = K; this.f = freqs.slice();
    this.ph = new Float64Array(K); this.inc = Float64Array.from(freqs, f => TAU * f / DFS);
    this.bi = new Float32Array(K * N); this.bq = new Float32Array(K * N); this.si = new Float64Array(K); this.sq = new Float64Array(K); this.p = 0; }
  process(x) {
    const K = this.K, N = this.N;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], o = this.p;
      for (let k = 0; k < K; k++) {
        const ph = this.ph[k], re = v * Math.cos(ph), im = -v * Math.sin(ph), j = k * N + o;
        this.si[k] += re - this.bi[j]; this.sq[k] += im - this.bq[j]; this.bi[j] = re; this.bq[j] = im;
        let np = ph + this.inc[k]; if (np > TAU) np -= TAU; this.ph[k] = np;
      }
      this.p = (o + 1) % N; this.n++;
      if (this.n >= this.next) { this.next += this.step; this.tick(); }
    }
  }
  tick() {
    const K = this.K, mag = new Float32Array(K); let mx = 0, sum = 0;
    for (let k = 0; k < K; k++) { mag[k] = Math.hypot(this.si[k], this.sq[k]); sum += mag[k]; if (mag[k] > mx) mx = mag[k]; }
    const s = this.slot; this.slot = (s + 1) % this.slots; this.cnt++;
    const q = sum > 0 ? mx / sum : 0, a = this.cnt < this.slots * 12 ? 0.15 : 0.05;
    this.E[s] = (1 - a) * this.E[s] + a * q;
    if (s === 0) { let b = 0; for (let k = 1; k < this.slots; k++) if (this.E[k] > this.E[b]) b = k; this.best = b; }
    if (s !== this.best || this.cnt - this.last < this.slots * 0.75) return;
    this.last = this.cnt; this.onSym(mag, q);
  }
}
const argmax = a => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; };
function makeChar(c, on) { if (c === 10 || c === 13) on(c === 13 ? "\n" : ""); else if (c === 8) on("\b"); else if (c >= 32 && c < 256) on(String.fromCharCode(c)); }

// ---------- MFSK (IZ8BLY): MFSK16, MFSK8, MFSK32 ----------
// Ton = inverse Gray-Abbildung der Bits (fldigi nennt diese Funktion „grayencode“)
const MFSK_P = { MFSK16: { N: 512, bits: 4, tones: 16, depth: 10 }, MFSK8: { N: 1024, bits: 5, tones: 32, depth: 5 }, MFSK32: { N: 256, bits: 4, tones: 16, depth: 10 } };
function mfskTx(mode, text, f, sr) {
  const P = MFSK_P[mode], sp = DFS / P.N, f0 = f - (P.tones - 1) * sp / 2, enc = new ConvEnc(), il = new Interleaver(P.bits, P.depth, 1), seq = [];
  let sh = 0, st = 0;
  const bit = b => { for (const d of enc.enc(b)) { sh = (sh << 1) | d; if (++st === P.bits) { const s = ungray(il.bits(sh) & (P.tones - 1)); seq.push([f0 + s * sp, P.N]); sh = 0; st = 0; } } };
  const ch = c => { for (const b of MFSK_VARI[c & 255]) bit(+b); };
  for (let i = 0; i < 107 / 3; i++) bit(0);
  [13, 2, 13].forEach(ch); for (const c of text) ch(c.charCodeAt(0) & 255); [13, 4, 13].forEach(ch);
  bit(1); for (let i = 0; i < 107; i++) bit(0);
  return resampleFrom8k(toneSeq(seq), sr);
}
class MfskRx {
  constructor(mode, f, onChar) { this.P = MFSK_P[mode]; this.onChar = onChar; this.sql = 0.25; this.il = new Interleaver(this.P.bits, this.P.depth, -1);
    // bei ungerader Bitzahl je Symbol ist die Paargrenze unbekannt: zwei Dekoder, der bessere gewinnt
    this.dec = [0, 1].map(o => ({ vd: new Viterbi(), vs: new VariShift(), pair: [], q: 0 })); this.nbit = 0; this.q = 0; this.bank = null; this.freq = f; }
  get freq() { return this._f; }
  set freq(f) { this._f = f; const P = this.P, sp = DFS / P.N, f0 = f - (P.tones - 1) * sp / 2;
    this.bank = new ToneBank(Array.from({ length: P.tones }, (_, i) => f0 + i * sp), P.N, (m, q) => this.sym(m, q)); }
  process(x) { this.bank.process(x); }
  sym(mag, q) {
    const P = this.P; this.q = 0.9 * this.q + 0.1 * q * P.tones / 4;
    const soft = new Uint8Array(P.bits);
    for (let b = 0; b < P.bits; b++) { let p1 = 1e-9, p0 = 1e-9; const bitpos = P.bits - 1 - b;
      for (let t = 0; t < P.tones; t++) { const v = (gray(t) >> bitpos) & 1; if (v) p1 = Math.max(p1, mag[t]); else p0 = Math.max(p0, mag[t]); }
      soft[b] = Math.round(128 + 127 * (p1 - p0) / (p1 + p0)); }
    this.il.symbols(soft);
    for (const s of soft) {
      this.nbit++;
      this.dec.forEach((d, i) => { if (!d.pair.length && (this.nbit & 1) !== i) return; d.pair.push(s); if (d.pair.length < 2) return;
        const [b, qv] = d.vd.dec(d.pair[0], d.pair[1]); d.pair = []; d.q = qv;
        if (b >= 0) { const c = d.vs.bit(b), other = this.dec[1 - i]; if (c > 0 && this.q >= this.sql && (P.bits % 2 === 0 ? i === 1 : d.q >= other.q)) makeChar(c, this.onChar); } });
    }
  }
}

// ---------- DominoEX und THOR (IFK+, 18 Toene) ----------
const IFK_P = { 4: [2048, 2, 8000], 5: [2048, 2, 11025], 8: [1024, 2, 8000], 11: [1024, 1, 11025], 16: [512, 1, 8000], 22: [512, 1, 11025] };
function ifkParams(speed) { const [symlen, ds, rate] = IFK_P[speed]; const sp = rate * ds / symlen; return { N: symlen * DFS / rate, sp, bw: 18 * sp }; }
function ifkTones(syms, f, P) { let prev = 0; return syms.map(s => { prev = (prev + 2 + s) % 18; return [(prev + 0.5) * P.sp + f - P.bw / 2, P.N]; }); }
const DOMINO_DEC = new Map(DOMINO_VARI.map((c, i) => [c.join(","), i]));
function dominoTx(speed, text, f, sr) {
  const P = ifkParams(speed), syms = [];
  const ch = (c, sec) => { const code = DOMINO_VARI[(c & 255) + (sec ? 256 : 0)]; syms.push(code[0]); for (let i = 1; i < 3; i++) { if (code[i] & 8) syms.push(code[i]); else break; } };
  ch(0, 1); ch(13); ch(2); ch(13); for (const c of text) ch(c.charCodeAt(0) & 255); ch(13); ch(4); ch(13); for (let i = 0; i < 4; i++) ch(0, 1);
  return resampleFrom8k(toneSeq(ifkTones(syms, f, P)), sr);
}
class IfkRx {   // gemeinsamer Empfang: Ton -> Nibble (Differenz zum Vorgaenger)
  constructor(speed, f, onNib) { this.P = ifkParams(speed); this.onNib = onNib; this.prev = -1; this.q = 0; this.freq = f; }
  get freq() { return this._f; }
  set freq(f) { this._f = f; const P = this.P; this.bank = new ToneBank(Array.from({ length: 18 }, (_, i) => (i + 0.5) * P.sp + f - P.bw / 2), P.N, (m, q) => this.sym(m, q)); }
  process(x) { this.bank.process(x); }
  sym(mag, q) { const t = argmax(mag); this.q = 0.9 * this.q + 0.1 * q * 4.5; if (this.prev >= 0) this.onNib(((t - this.prev - 2) % 18 + 18) % 18, this.q); this.prev = t; }
}
class DominoRx {
  constructor(speed, f, onChar) { this.onChar = onChar; this.sql = 0.25; this.code = []; this.rx = new IfkRx(speed, f, (n, q) => this.nib(n, q)); }
  get freq() { return this.rx.freq; } set freq(f) { this.rx.freq = f; }
  process(x) { this.rx.process(x); }
  nib(n, q) {
    if (n > 15) { this.code = []; return; }
    if (!(n & 8) && this.code.length) { const k = [...this.code, 0, 0].slice(0, 3).join(","), c = DOMINO_DEC.get(k); if (c !== undefined && c < 256 && q >= this.sql) makeChar(c, this.onChar); this.code = []; }
    if (!(n & 8) || this.code.length) this.code.push(n); if (this.code.length > 3) this.code = [];
  }
}
function thorTx(speed, text, f, sr) {
  const P = ifkParams(speed), enc = new ConvEnc(), il = new Interleaver(4, 10, 1), syms = [];
  let sh = 0, st = 0;
  const code = c => { for (const b of (c < 0x100 ? MFSK_VARI[c] : THOR_SEC[c - 0x100 - 32])) for (const d of enc.enc(+b)) { sh = (sh << 1) | d; if (++st === 4) { syms.push(il.bits(sh)); sh = 0; st = 0; } } };
  for (let i = 0; i < 16; i++) syms.push(0);
  code(0); [13, 2, 13].forEach(code); for (const c of text) code(c.charCodeAt(0) & 255); [13, 4, 13].forEach(code); for (let i = 0; i < 12; i++) code(0);   // Interleaver/Dekoder der Gegenstelle ganz leeren
  return resampleFrom8k(toneSeq(ifkTones(syms, f, P)), sr);
}
class ThorRx {
  constructor(speed, f, onChar) { this.onChar = onChar; this.sql = 0.25; this.vd = new Viterbi(); this.il = new Interleaver(4, 10, -1); this.vs = new VariShift(THOR_DEC); this.pair = [];
    this.rx = new IfkRx(speed, f, (n, q) => this.nib(n, q)); }
  get freq() { return this.rx.freq; } set freq(f) { this.rx.freq = f; }
  process(x) { this.rx.process(x); }
  nib(n, q) {
    const s = n > 15 ? [128, 128, 128, 128] : [3, 2, 1, 0].map(b => (n >> b) & 1 ? 255 : 0);
    this.il.symbols(s);
    for (const v of s) { this.pair.push(v); if (this.pair.length === 2) { const [b] = this.vd.dec(this.pair[0], this.pair[1]); this.pair = [];
      if (b >= 0) { const c = this.vs.bit(b); if (c > 0 && c < 0x100 && q >= this.sql) makeChar(c, this.onChar); } } }
  }
}

// ---------- Olivia und Contestia (Hadamard-Code, verwuerfelt, Gray-kodierte MFSK-Toene mit Hann-Form) ----------
function fhtFwd(d) { const L = d.length; for (let st = 1; st < L; st *= 2) for (let p = 0; p < L; p += 2 * st) for (let q = p; q - p < st; q++) { const a = d[q], b = d[q + st]; d[q] = b + a; d[q + st] = b - a; } return d; }
function fhtInv(d) { const L = d.length; for (let st = L / 2; st >= 1; st /= 2) for (let p = 0; p < L; p += 2 * st) for (let q = p; q - p < st; q++) { const a = d[q], b = d[q + st]; d[q] = a - b; d[q + st] = a + b; } return d; }
function oliviaCfg(tones, bw, contestia) {
  const bits = Math.log2(tones), L = 1 << (bits + 7 - Math.log2(bw / 125)), spb = contestia ? 32 : 64;
  return { tones, bw, bits, L, spb, contestia, code: contestia ? 0xEDB88320n : 0xE257E6D0291574ECn, shift: contestia ? 5 : 13 };
}
function oliviaFirst(C, f) { const off = C.bw * (1 - 0.5 / C.tones) / 2; return Math.floor((C.L / 16) * ((f - off) / 500)) + 1; }
function contestiaChar(c) { if (c >= 97 && c <= 122) c -= 32; if (c === 32) return 59; if (c === 13) return 60; if (c === 10 || c === 0) return 0; if (c >= 33 && c <= 90) return c - 32; if (c === 8) return 61; return 63 - 32; }
function oliviaBlock(C, chars) {   // BitsPerSymbol Zeichen -> spb Symbole
  const out = new Uint8Array(C.spb), wrap = C.spb - 1;
  for (let fb = 0; fb < C.bits; fb++) {
    let ch = chars[fb] || 0; ch = C.contestia ? contestiaChar(ch) : ch & (2 * C.spb - 1);
    const v = new Float64Array(C.spb); if (ch < C.spb) v[ch] = 1; else v[ch - C.spb] = -1; fhtInv(v);
    let cb = (fb * C.shift) & wrap; for (let t = 0; t < C.spb; t++) { if ((C.code >> BigInt(cb)) & 1n) v[t] = -v[t]; cb = (cb + 1) & wrap; }
    let rot = 0; for (let t = 0; t < C.spb; t++) { if (v[t] < 0) { let b = fb + rot; if (b >= C.bits) b -= C.bits; out[t] |= 1 << b; } if (++rot >= C.bits) rot -= C.bits; }
  }
  return out;
}
function oliviaTx(C, text, f, sr) {
  const L = C.L, first = oliviaFirst(C, f), chars = [0];
  for (const c of text) { const k = c.charCodeAt(0); if (k > 127 && !C.contestia) chars.push(127, k & 127); else chars.push(k & 255); }
  chars.push(13); while (chars.length % C.bits) chars.push(0); for (let i = 0; i < 2 * C.bits; i++) chars.push(0);
  const syms = []; for (let i = 0; i < chars.length; i += C.bits) syms.push(...oliviaBlock(C, chars.slice(i, i + C.bits)));
  const y = new Float32Array((syms.length + 2) * L / 2 + L); let ph = 0, pos = 0;
  for (const s of syms) {
    const fr = first + 2 * gray(s);
    ph = ((ph + fr * (-L / 4)) % L + L) % L;
    for (let t = 0; t < L; t++) y[pos + t] += 0.35 * Math.cos(TAU * ((ph + fr * t) % L) / L) * (1 - Math.cos(TAU * t / L));
    ph = (ph + fr * (3 * L / 4) + (Math.random() < 0.5 ? L / 4 : -L / 4)) % L; ph = (ph + L) % L;
    pos += L / 2;
  }
  return resampleFrom8k(y.subarray(0, pos + L), sr);
}
class OliviaRx {
  constructor(C, f, onChar) { this.C = C; this.onChar = onChar; this.sql = 0.25; this.q = 0; this.hist = []; this.n = 0; this.score = new Float32Array(C.spb); this.freq = f;
    this.buf = new Float32Array(C.L); this.bp = 0; this.cnt = 0; this.slots = 8; this.step = C.L / 2 / this.slots;   // 8 Taktlagen je Symbol
    this.next = this.step; this.slot = 0; this.E = new Float32Array(this.slots); this.best = 0; this.ticks = 0; this.lastEmit = -1e9; this.pend = null;
    this.win = Float32Array.from({ length: C.L }, (_, t) => 0.5 - 0.5 * Math.cos(TAU * t / C.L)); }
  get freq() { return this._f; }
  set freq(f) { this._f = f; const C = this.C, first = oliviaFirst(C, f); this.bins = Array.from({ length: C.tones }, (_, k) => first + 2 * k);
    this.cs = this.bins.map(b => Float32Array.from({ length: C.L }, (_, t) => Math.cos(TAU * b * t / C.L))); this.sn = this.bins.map(b => Float32Array.from({ length: C.L }, (_, t) => Math.sin(TAU * b * t / C.L))); }
  process(x) { for (let i = 0; i < x.length; i++) { this.buf[this.bp] = x[i]; this.bp = (this.bp + 1) % this.C.L; if (++this.cnt >= this.next) { this.next += this.step; this.tick(); } } }
  tick() {   // alle Taktlagen parallel auswerten; Taktlage und Blockgrenze waehlt die Guete der Dekodierung
    const C = this.C, L = C.L, mag = new Float32Array(C.tones);
    for (let k = 0; k < C.tones; k++) { let re = 0, im = 0; const c = this.cs[k], s = this.sn[k];
      for (let t = 0, j = this.bp; t < L; t++, j = j + 1 === L ? 0 : j + 1) { const v = this.buf[j] * this.win[t]; re += v * c[t]; im += v * s[t]; }
      mag[k] = Math.hypot(re, im); }
    const sl = this.slot; this.slot = (sl + 1) % this.slots; this.ticks++;
    const soft = new Float32Array(C.bits);
    for (let b = 0; b < C.bits; b++) { let p1 = 1e-9, p0 = 1e-9; for (let t = 0; t < C.tones; t++) { if ((ungray(t) >> b) & 1) p1 = Math.max(p1, mag[t]); else p0 = Math.max(p0, mag[t]); } soft[b] = (p0 - p1) / (p0 + p1); }
    const st = this.streams || (this.streams = Array.from({ length: this.slots }, () => ({ hist: [], n: 0, score: new Float32Array(C.spb) })));
    const S = st[sl]; S.hist.push(soft); if (S.hist.length > C.spb) S.hist.shift(); S.n++;
    if (S.hist.length < C.spb) return;
    this.hist = S.hist; const r = this.decode(), W = C.spb * this.slots;
    // Kandidat merken; innerhalb eines halben Blocks gewinnt die beste Takt-/Blocklage, danach Ausgabe
    if (r.q > 0.05 && this.ticks - this.lastEmit > W * 0.6) {
      if (!this.pend) this.pend = { ...r, t: this.ticks }; else if (r.q > this.pend.q) this.pend = { ...r, t: this.pend.t, at: this.ticks };
    }
    if (this.pend && this.ticks - this.pend.t >= W / 2) {
      const p = this.pend; this.pend = null; this.lastEmit = p.at || p.t; this.q = p.q;
      if (this.q >= this.sql) for (const c of p.chars) { if (C.contestia) { if (c) makeChar(c, this.onChar); } else if (c === 127) this.hi = true; else if (c) { makeChar(this.hi ? c + 128 : c, this.onChar); this.hi = false; } }
    }
  }
  decode() {
    const C = this.C, wrap = C.spb - 1, chars = []; let q = 0;
    for (let fb = 0; fb < C.bits; fb++) {
      const v = new Float64Array(C.spb); let rot = fb, cb = (fb * C.shift) & wrap;
      for (let t = 0; t < C.spb; t++) { let b = this.hist[t][rot]; if ((C.code >> BigInt(cb)) & 1n) b = -b; v[t] = b; cb = (cb + 1) & wrap; if (++rot >= C.bits) rot -= C.bits; }
      fhtFwd(v); let pk = 0, pos = 0, sq = 0; for (let t = 0; t < C.spb; t++) { sq += v[t] * v[t]; if (Math.abs(v[t]) > Math.abs(pk)) { pk = v[t]; pos = t; } }
      let ch = pos + (pk < 0 ? C.spb : 0);
      if (C.contestia && ch > 0) ch = ch === 59 ? 32 : ch === 60 ? 13 : ch === 61 ? 8 : ch + 32;
      chars.push(ch); const noise = (sq - pk * pk) / (C.spb - 1); q += Math.abs(pk) / Math.sqrt(noise * C.spb + 1e-9) / C.bits;
    }
    return { chars, q: Math.max(0, Math.min(1, (q - 1.5) / 4)) };
  }
}

// ---------- Throb (1, 2, 4 Baud): je Zeichen ein Tonpaar aus 9 Toenen ----------
const THROB_PAIRS = [[5,5],[4,5],[1,2],[1,3],[1,4],[4,6],[1,5],[1,6],[1,7],[3,7],[1,8],[2,3],[2,4],[2,8],[2,5],[5,6],[2,6],[2,9],[3,4],[3,5],[1,9],[3,6],[8,9],[3,8],[3,3],[2,2],[1,1],[3,9],[4,7],[4,8],[4,9],[5,7],[5,8],[5,9],[6,7],[6,8],[6,9],[7,8],[7,9],[8,8],[7,7],[6,6],[4,4],[9,9],[2,7]];
const THROB_CHARS = "\0ABCD\0FGHIJKLMNOPQRSTUVWXYZ1234567890,.'/)(E ";
const THROB_SHIFT = { "?": 20, "@": 13, "-": 9, "\n": 0 }, THROB_UNSHIFT = { 20: "?", 13: "@", 9: "-", 0: "\n" };
const THROB_P = { 1: { N: 8192, wide: false, semi: true }, 2: { N: 4096, wide: false, semi: true }, 4: { N: 2048, wide: true, semi: false } };
const throbFreqs = (P, f) => Array.from({ length: 9 }, (_, i) => f + (i - 4) * (P.wide ? 16 : 8));
function throbTx(speed, text, f, sr) {
  const P = THROB_P[speed], fr = throbFreqs(P, f), N = P.N, syms = [0, 0, 0, 0];
  for (let c of text.toUpperCase()) { if (c === "\r") continue; if (c in THROB_SHIFT) { syms.push(5, THROB_SHIFT[c]); continue; } const k = THROB_CHARS.indexOf(c); if (k > 0 && k !== 5) syms.push(k); }
  syms.push(0, 0);
  const pulse = i => P.semi ? (i < N / 5 ? 0.5 * (1 - Math.cos(Math.PI * i / (N / 5))) : i >= N * 4 / 5 ? 0.5 * (1 + Math.cos(Math.PI * (i - N * 4 / 5) / (N / 5))) : 1) : 0.5 * (1 - Math.cos(TAU * i / N));
  const y = new Float32Array(syms.length * N);
  syms.forEach((s, k) => { const [a, b] = THROB_PAIRS[s], w1 = TAU * fr[a - 1] / DFS, w2 = TAU * fr[b - 1] / DFS; for (let i = 0; i < N; i++) y[k * N + i] = 0.7 * pulse(i) * (Math.sin(w1 * i) + Math.sin(w2 * i)) / 2; });
  return resampleFrom8k(y, sr);
}
class ThrobRx {   // Filter im halben Tonabstand ueber ±2 Toene: das Tonraster wird automatisch gefunden (Klick daneben, andere Programme)
  constructor(speed, f, onChar) { this.P = THROB_P[speed]; this.onChar = onChar; this.sql = 0.25; this.q = 0; this.shift = false; this.sc = new Float32Array(9); this.freq = f; }
  get freq() { return this._f; }
  set freq(f) { this._f = f; const st = this.P.wide ? 16 : 8; this.bank = new ToneBank(Array.from({ length: 25 }, (_, i) => f + (i - 12) * st / 2), this.P.N, m => this.sym(m), 16); }
  process(x) { this.bank.process(x); }
  pairOf(m, o) { const v = Array.from({ length: 9 }, (_, t) => m[o + 2 * t]), ord = [...v.keys()].sort((x, y) => v[y] - v[x]); let a = ord[0] + 1, b = (v[ord[1]] > 0.45 * v[ord[0]] ? ord[1] : ord[0]) + 1; if (a > b) [a, b] = [b, a];
    const e = v[ord[0]] + (a !== b ? v[ord[1]] : 0), tot = m.reduce((x, y) => x + y, 0); return { k: THROB_PAIRS.findIndex(p => p[0] === a && p[1] === b), e: e / (tot || 1) }; }
  sym(mag) {
    const m = Array.from(mag); let best = 4;
    for (let o = 0; o < 9; o++) { const r = this.pairOf(m, o); this.sc[o] = 0.85 * this.sc[o] + 0.15 * (r.k >= 0 ? r.e : 0); if (this.sc[o] > this.sc[best]) best = o; }
    const r = this.pairOf(m, best); this.q = 0.8 * this.q + 0.2 * Math.min(1, (r.e - 0.25) * 2);
    const k = r.k; if (k < 0 || this.q < this.sql) return;
    if (this.shift) { this.shift = false; if (k in THROB_UNSHIFT) this.onChar(THROB_UNSHIFT[k]); return; }
    if (k === 5) { this.shift = true; return; } if (k > 0) this.onChar(THROB_CHARS[k]);
  }
}

// ---------- QPSK31/63/125 (Faltungscode K=5, 0x17/0x19, wie PSK31-Spezifikation G3PLX) ----------
const QPSK_DPHI = [Math.PI, -Math.PI / 2, 0, Math.PI / 2];      // Codewort 0..3 -> Phasensprung (Drehsinn wie fldigi im oberen Seitenband)
function qpskTx(text, f, sr, baud) {
  const enc = new ConvEnc(5, 0x17, 0x19), d = [];
  const bit = b => { const [p1, p2] = enc.enc(b); d.push(QPSK_DPHI[p1 | (p2 << 1)]); };
  for (let i = 0; i < 64; i++) d.push(Math.PI);
  for (const ch of text) { const c = ch.charCodeAt(0); if (c < 128) { for (const b of VARICODE[c]) bit(+b); bit(0); bit(0); } }
  for (let i = 0; i < 32; i++) bit(0);
  for (let i = 0; i < 16; i++) d.push(0);
  const T = DFS / baud, y = new Float32Array(Math.ceil((d.length + 1) * T)); let pr = 1, pi = 0, n = 0;
  for (const ph of d) { const cr = pr * Math.cos(ph) - pi * Math.sin(ph), ci = pr * Math.sin(ph) + pi * Math.cos(ph);
    for (let t = 0; t < T; t++, n++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * t / T), re = pr * (1 - w) + cr * w, im = pi * (1 - w) + ci * w, a = TAU * f * n / DFS; y[n] = 0.7 * (re * Math.cos(a) - im * Math.sin(a)); }
    pr = cr; pi = ci; }
  for (let t = 0; t < T; t++, n++) { const g = 0.5 + 0.5 * Math.cos(Math.PI * t / T), a = TAU * f * n / DFS; y[n] = 0.7 * g * (pr * Math.cos(a) - pi * Math.sin(a)); }
  return resampleFrom8k(y.subarray(0, n), sr);
}
class QpskRx extends Psk31Rx {
  constructor(f, onChar, baud) { super(f, onChar, baud); this.vd = new Viterbi(5, 0x17, 0x19, 30); this.afc = true; }
  decide(dr, di) {
    const m = Math.abs(dr) + Math.abs(di) || 1e-9;
    // Qualitaet und AFC aus der vierten Potenz (Modulation entfernt)
    const ph4 = 4 * Math.atan2(di, dr); this.q = 0.92 * this.q + 0.08 * Math.cos(ph4);
    if (this.afc) { const err = Math.atan2(Math.sin(ph4), Math.cos(ph4)) / 4 / (TAU / this.baud); this.nco.set(this.nco.f + Math.max(-1.5, Math.min(1.5, err * (this.q > 0.5 ? 0.03 : 0.1) * 31.25 / this.baud))); if (this.freqCb) this.freqCb(this.nco.f); }
    const s0 = Math.round(128 + 127 * (Math.abs(di) - Math.abs(dr)) / m), s1 = Math.round(128 + 127 * (dr + di) / m);
    const [b] = this.vd.dec(s0, s1); if (b >= 0) this.bit(b);
  }
}

// ---------- MT63 (500/1000/2000 Hz, kurzes/langes Interleave): 64 Traeger, differentielle BPSK, Walsh-64-Code ----------
// ungerade Traeger sind um ein halbes Symbol versetzt; je Symbolzeit wird ein Zeichen gesendet (zeitlich ueber 32/64 Symbole verteilt)
const MT63_SHORT = Array.from({ length: 64 }, (_, i) => 4 + (i & 3)), MT63_LONG = Array.from({ length: 64 }, (_, i) => (i + 1) & 63);
function mt63Cfg(bw, long) {
  const D = { 500: 8, 1000: 4, 2000: 2 }[bw], R = DFS / D, N = 512, S = 200, L = long ? 64 : 32, pat = long ? MT63_LONG : MT63_SHORT;
  const P = []; let p = 0; for (let i = 0; i < 64; i++) { P.push(p); p += pat[i]; if (p >= L) p -= L; }
  return { bw, long, D, R, N, S, L, delay: P.map(x => x ? L - x : 0) };
}
function mt63Carriers(C, f) { const fdc = Math.floor((f - C.bw / 2) * C.N / C.R + 0.5); return Array.from({ length: 64 }, (_, i) => (fdc + 4 * i) * C.R / C.N); }
function walshInv(d) { return fhtInv(d); }
function walshFwd(d) { const L = d.length; for (let st = 1; st < L; st *= 2) for (let p = 0; p < L; p += 2 * st) for (let q = p; q - p < st; q++) { const a = d[q], b = d[q + st]; d[q] = a + b; d[q + st] = b - a; } return d; }
function mt63Tx(C, text, f, sr) {
  const fr = mt63Carriers(C, f), chars = [];
  for (let i = 0; i < C.L; i++) chars.push(0);
  for (const ch of text) { const c = ch.charCodeAt(0); if (c > 127) chars.push(127, c & 127); else chars.push(c); }
  for (let i = 0; i < C.L; i++) chars.push(0);
  // Kodierer mit Interleave-Puffer (mit Zufallsbits vorgefuellt wie das Original)
  const pipe = []; for (let k = 0; k < C.L; k++) pipe.push(Uint8Array.from({ length: 64 }, () => Math.random() < 0.5 ? 1 : 0));
  const bits = chars.map((c, k) => { const w = new Float64Array(64); c &= 127; if (c < 64) w[c] = 1; else w[c - 64] = -1; walshInv(w);
    pipe.push(Uint8Array.from(w, v => v < 0 ? 1 : 0)); return Uint8Array.from({ length: 64 }, (_, i) => pipe[pipe.length - 1 - C.delay[i]][i]); });
  const spS = C.S * C.D, len = Math.ceil((bits.length + 3) * spS + C.N * C.D), y = new Float32Array(len), win = C.N * C.D;
  const ph = Array.from({ length: 64 }, (_, i) => { let p = 0, st = 0; for (let k = 0; k < i; k++) { st++; p = (p + st) & 511; } return TAU * p / 512; });
  bits.forEach((b, k) => { for (let i = 0; i < 64; i++) {
    if (!b[i]) ph[i] += Math.PI;
    const t0 = Math.round(k * spS + ((i & 1) ? spS / 2 : 0)), w0 = TAU * fr[i] / DFS;
    for (let n = 0; n < win; n++) { const a = MT63_SHAPE[Math.floor(n / C.D)]; if (a) y[t0 + n] += a * Math.cos(w0 * (t0 + n) + ph[i]); }
  } });
  let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < y.length; i++) y[i] *= 0.7 / pk;
  return resampleFrom8k(y, sr);
}
class Mt63Rx {
  constructor(C, f, onChar) { this.C = C; this.onChar = onChar; this.sql = 0.25; this.q = 0; this.freq = f; }
  get freq() { return this._f; }
  set freq(f) {
    const C = this.C; this._f = f; const fr = mt63Carriers(C, f); this.fc = (fr[0] + fr[63]) / 2;
    this.rel = fr.map(x => x - this.fc);                     // Traeger relativ zur Bandmitte (Basisband)
    // Tiefpass fuer die komplexe Dezimierung auf R
    const taps = 8 * C.D + 1, cut = (C.bw / 2 + 60) / DFS; this.lp = Float32Array.from({ length: taps }, (_, k) => { const m = k - (taps - 1) / 2, w = 0.54 - 0.46 * Math.cos(TAU * k / (taps - 1)); return (m ? Math.sin(TAU * cut * m) / (Math.PI * m) : 2 * cut) * w; });
    this.hi = new Float32Array(taps); this.hq = new Float32Array(taps); this.hp = 0; this.dc = 0; this.nph = 0; this.ninc = TAU * this.fc / DFS;
    this.bi = new Float32Array(C.N); this.bq = new Float32Array(C.N); this.bp = 0; this.cnt = 0; this.tick = 0;
    this.cs = this.rel.map(r => { const w = TAU * r / C.R; return [Float32Array.from({ length: C.N }, (_, n) => Math.cos(w * n)), Float32Array.from({ length: C.N }, (_, n) => Math.sin(w * n))]; });
    this.Z = []; this.ph = Array.from({ length: 8 }, () => ({ hist: [], q: 0, theta: 0, flip: 0, score: [0, 0] })); this.best = 0; this.n = 0;
  }
  process(x) {
    const C = this.C, taps = this.lp.length;
    for (let i = 0; i < x.length; i++) {
      const c = Math.cos(this.nph), s = Math.sin(this.nph); this.nph += this.ninc; if (this.nph > TAU) this.nph -= TAU;
      this.hi[this.hp] = x[i] * c; this.hq[this.hp] = -x[i] * s; this.hp = (this.hp + 1) % taps;
      if (++this.dc < C.D) continue; this.dc = 0;
      let re = 0, im = 0; for (let k = 0, j = this.hp; k < taps; k++, j = j + 1 === taps ? 0 : j + 1) { re += this.hi[j] * this.lp[k]; im += this.hq[j] * this.lp[k]; }
      this.bi[this.bp] = re; this.bq[this.bp] = im; this.bp = (this.bp + 1) % C.N;
      if (++this.cnt >= C.S / 8) { this.cnt = 0; this.analyse(); }
    }
  }
  analyse() {   // Fenster-DFT an allen 64 Traegern, Zeitbezug absolut (Phase stetig ueber die Fenster)
    const C = this.C, N = C.N, z = new Float32Array(128), t0 = this.tick * C.S / 8;
    for (let i = 0; i < 64; i++) { const [cs, sn] = this.cs[i]; let re = 0, im = 0;
      for (let n = 0, j = this.bp; n < N; n++, j = j + 1 === N ? 0 : j + 1) { const w = MT63_SHAPE[n], a = this.bi[j] * w, b = this.bq[j] * w; re += a * cs[n] + b * sn[n]; im += b * cs[n] - a * sn[n]; }
      const ab = TAU * this.rel[i] * t0 / C.R, ca = Math.cos(ab), sa = Math.sin(ab); z[2 * i] = re * ca + im * sa; z[2 * i + 1] = im * ca - re * sa; }
    this.Z.push(z); if (this.Z.length > 13) this.Z.shift(); this.tick++;
    if (this.Z.length < 13) return;
    // Symbol der Taktlage (tick-4) mod 8: gerade Traeger aus Z[-5]/Z[-13], ungerade aus Z[-1]/Z[-9]
    const P = this.ph[(this.tick - 4) % 8], Z = this.Z, soft = new Float32Array(64); let sr = 0, si = 0;
    const d = new Float32Array(128);
    for (let i = 0; i < 64; i++) { const a = (i & 1) ? Z[12] : Z[8], b = (i & 1) ? Z[4] : Z[0]; const ar = a[2 * i], ai = a[2 * i + 1], br = b[2 * i], bi = b[2 * i + 1];
      const dr = ar * br + ai * bi, di = ai * br - ar * bi, m = Math.hypot(dr, di) || 1e-12; d[2 * i] = dr / m; d[2 * i + 1] = di / m;
      sr += d[2 * i] * d[2 * i] - d[2 * i + 1] * d[2 * i + 1]; si += 2 * d[2 * i] * d[2 * i + 1]; }
    // Frequenzablage: Drehung je Symbol aus der quadrierten Differenz, stetig nachgefuehrt (Mehrdeutigkeit pi ueber die Textplausibilitaet)
    let th = Math.atan2(si, sr) / 2; while (th - P.theta > Math.PI / 2) th -= Math.PI; while (th - P.theta < -Math.PI / 2) th += Math.PI; P.theta = 0.7 * P.theta + 0.3 * th;
    const ct = Math.cos(P.theta), st = Math.sin(P.theta);
    for (let i = 0; i < 64; i++) soft[i] = d[2 * i] * ct + d[2 * i + 1] * st;
    P.hist.push(soft); if (P.hist.length > C.L) P.hist.shift(); if (P.hist.length < C.L) return;
    // Zeichen m = aeltestes Symbol; Bit i liegt delay[i] Symbole spaeter
    const v = new Float64Array(64); for (let i = 0; i < 64; i++) v[i] = -P.hist[C.delay[i]][i];
    walshFwd(v); let pk = 0, pos = 0, sq = 0; for (let i = 0; i < 64; i++) { sq += v[i] * v[i]; if (Math.abs(v[i]) > Math.abs(pk)) { pk = v[i]; pos = i; } }
    const q = Math.abs(pk) / Math.sqrt((sq - pk * pk) / 63 + 1e-9); P.q = 0.8 * P.q + 0.2 * Math.min(1, Math.max(0, (q - 2) / 6));
    let ch = pos + (pk < 0 ? 64 : 0), alt = ch ^ 64;
    // Vorzeichen (Mehrdeutigkeit pi): Fuellzeichen NUL erscheinen im falschen Zweig als '@' – nur dieses Merkmal zaehlt
    if (q > 3) P.flip = 0.93 * P.flip + (ch === 64 ? 1 : ch === 0 ? -1 : 0);
    if (P.flip > 2.5) { P.theta += Math.PI; P.flip = 0; [ch, alt] = [alt, ch]; for (const h of P.hist) for (let i = 0; i < 64; i++) h[i] = -h[i]; }
    // beste Taktlage mit Hysterese; je Symbolzeit hoechstens ein Zeichen
    let b = this.best; for (let k = 0; k < 8; k++) if (this.ph[k].q > this.ph[b].q + 0.08) b = k;
    this.best = b; if (this.ph[b] !== P || this.tick - (this.lastOut || -99) < 6) return;
    this.lastOut = this.tick; this.q = P.q; if (this.q < this.sql) return;
    if (ch === 127) { this.hiFlag = true; return; }
    if (ch) { makeChar(this.hiFlag ? ch + 128 : ch, this.onChar); this.hiFlag = false; }
  }
}

// ---------- Hellschreiber (Feld-Hell): 17,5 Spalten/s, 14 Bildpunkte je Spalte, unten beginnend ----------
// eigener 5x7-Zeichensatz, Spalten von links, Bit 0 = oberste Zeile
const HELL_FONT = { A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36], C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c], E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01], G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f], I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40], M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f], O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06], Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46], S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f], W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63], Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43], 0: [0x3e, 0x51, 0x49, 0x45, 0x3e], 1: [0x00, 0x42, 0x7f, 0x40, 0x00], 2: [0x42, 0x61, 0x51, 0x49, 0x46], 3: [0x21, 0x41, 0x45, 0x4b, 0x31],
  4: [0x18, 0x14, 0x12, 0x7f, 0x10], 5: [0x27, 0x45, 0x45, 0x45, 0x39], 6: [0x3c, 0x4a, 0x49, 0x49, 0x30], 7: [0x01, 0x71, 0x09, 0x05, 0x03], 8: [0x36, 0x49, 0x49, 0x49, 0x36],
  9: [0x06, 0x49, 0x49, 0x29, 0x1e], ".": [0x00, 0x60, 0x60, 0x00, 0x00], ",": [0x00, 0x50, 0x30, 0x00, 0x00], "?": [0x02, 0x01, 0x51, 0x09, 0x06], "/": [0x20, 0x10, 0x08, 0x04, 0x02],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08], "=": [0x14, 0x14, 0x14, 0x14, 0x14], "+": [0x08, 0x08, 0x3e, 0x08, 0x08], ":": [0x00, 0x36, 0x36, 0x00, 0x00], "!": [0x00, 0x00, 0x5f, 0x00, 0x00],
  "'": [0x00, 0x05, 0x03, 0x00, 0x00], "(": [0x00, 0x1c, 0x22, 0x41, 0x00], ")": [0x00, 0x41, 0x22, 0x1c, 0x00], "@": [0x32, 0x49, 0x79, 0x41, 0x3e], "#": [0x14, 0x7f, 0x14, 0x7f, 0x14] };
const HELL_COLS = 17.5, HELL_PIX = 14;
function hellTx(text, f, sr) {
  const pix = DFS / (HELL_COLS * HELL_PIX), cols = [];
  const blank = () => cols.push(0);
  blank(); blank();
  for (const ch of text.toUpperCase()) {
    if (ch === " ") { blank(); blank(); blank(); blank(); continue; }
    const g = HELL_FONT[ch] || HELL_FONT["?"];
    blank(); for (const c of g) { let v = 0; for (let r = 0; r < 7; r++) if (c & (1 << r)) v |= 3 << (2 * (6 - r)); cols.push(v); } blank();   // jede Zeile doppelt hoch, unten zuerst
  }
  blank(); blank();
  const env = new Float32Array(Math.ceil(cols.length * HELL_PIX * pix)); let n = 0;
  cols.forEach((v, ci) => { for (let r = 0; r < HELL_PIX; r++) { const end = Math.round((ci * HELL_PIX + r + 1) * pix); for (; n < end; n++) env[n] = (v >> r) & 1; } });
  // Flankenformung 2 ms (wie fldigi Standard) gegen Tastklicks
  const L = 16, sm = new Float32Array(env.length); let acc = 0; const w = Array.from({ length: L }, (_, i) => 0.5 - 0.5 * Math.cos(TAU * (i + 0.5) / L)), ws = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < env.length; i++) { acc = 0; for (let k = 0; k < L; k++) { const j = i - k + L / 2; if (j >= 0 && j < env.length) acc += env[j] * w[k]; } sm[i] = acc / ws; }
  const y = new Float32Array(sm.length); const inc = TAU * f / DFS; for (let i = 0; i < y.length; i++) y[i] = 0.7 * sm[i] * Math.cos(inc * i);
  return resampleFrom8k(y, sr);
}
// Empfang: Hellschreiben wird nicht dekodiert, sondern als Bild geschrieben (das Auge liest)
class HellRx {
  constructor(f, onColumn) { this.onColumn = onColumn; this.nco = new Nco(f); this.sql = 0; this.pix = DFS / (HELL_COLS * HELL_PIX);
    const L = Math.max(4, Math.round(this.pix * 0.9)); this.bi = new Boxcar(L); this.bq = new Boxcar(L); this.acc = 0; this.col = []; this.peak = 1e-4; this.mx = 0; }
  get freq() { return this.nco.f; } set freq(f) { this.nco.set(f); }
  process(x) {
    for (let i = 0; i < x.length; i++) {
      const [c, s] = this.nco.step(), m = Math.hypot(this.bi.push(x[i] * c), this.bq.push(x[i] * s));
      if (m > this.mx) this.mx = m;
      if (++this.acc >= this.pix) { this.acc -= this.pix; const v = this.mx; this.mx = 0; this.peak = Math.max(v, this.peak * (1 - 0.02 / HELL_PIX));
        this.col.push(Math.min(1, v / this.peak)); if (this.col.length === HELL_PIX) { this.onColumn(Float32Array.from(this.col)); this.col = []; } }
    }
  }
}

// ---------- Verzeichnis ----------
const DIGI_MODES = {};
for (const m of ["MFSK16", "MFSK8", "MFSK32"]) DIGI_MODES[m] = { group: "MFSK", bw: MFSK_P[m].tones * DFS / MFSK_P[m].N, rx: (f, on) => new MfskRx(m, f, on), tx: (t, f, sr) => mfskTx(m, t, f, sr) };
for (const s of [4, 5, 8, 11, 16, 22]) {
  DIGI_MODES["DominoEX " + s] = { group: "DominoEX", bw: ifkParams(s).bw, rx: (f, on) => new DominoRx(s, f, on), tx: (t, f, sr) => dominoTx(s, t, f, sr) };
  DIGI_MODES["THOR " + s] = { group: "THOR", bw: ifkParams(s).bw, rx: (f, on) => new ThorRx(s, f, on), tx: (t, f, sr) => thorTx(s, t, f, sr) };
}
for (const [t, b] of [[4, 125], [4, 250], [8, 250], [8, 500], [16, 500], [32, 1000], [8, 1000], [16, 1000], [32, 2000], [64, 2000]]) {
  for (const ct of [false, true]) { const C = oliviaCfg(t, b, ct), name = `${ct ? "Contestia" : "Olivia"} ${t}/${b}`;
    DIGI_MODES[name] = { group: ct ? "Contestia" : "Olivia", bw: b, rx: (f, on) => new OliviaRx(C, f, on), tx: (x, f, sr) => oliviaTx(C, x, f, sr) }; }
}
for (const sp of [1, 2, 4]) DIGI_MODES["Throb " + sp] = { group: "Throb", bw: THROB_P[sp].wide ? 144 : 72, rx: (f, on) => new ThrobRx(sp, f, on), tx: (t, f, sr) => throbTx(sp, t, f, sr) };
for (const [n, b] of [["QPSK31", 31.25], ["QPSK63", 62.5], ["QPSK125", 125]]) DIGI_MODES[n] = { group: "PSK", bw: 2 * b, rx: (f, on) => new QpskRx(f, on, b), tx: (t, f, sr) => qpskTx(t, f, sr, b) };
for (const bw of [500, 1000, 2000]) for (const lg of [false, true]) { const C = mt63Cfg(bw, lg), n = `MT63-${bw >= 1000 ? bw / 1000 + "K" : bw}${lg ? "L" : "S"}`;
  DIGI_MODES[n] = { group: "MT63", bw, rx: (f, on) => new Mt63Rx(C, f, on), tx: (t, f, sr) => mt63Tx(C, t, f, sr) }; }
DIGI_MODES["Hell"] = { group: "Hellschreiber", bw: 245, image: "hell", rx: (f, on) => new HellRx(f, on), tx: (t, f, sr) => hellTx(t, f, sr) };
