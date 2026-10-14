"use strict";
// Wellenwerk – SSTV (Bildfunk): Martin, Scottie, Robot, PD, Wraase, Pasokon.
// Senden aus einem Bild (Canvas), Empfang mit VIS-Erkennung, Zeilen-Sync-Nachfuehrung und automatischer Schraegkorrektur.
// Frequenzen: Sync 1200 Hz, Schwarz 1500 Hz, Weiss 2300 Hz; VIS-Kennung 1100/1300 Hz, Vorlauf 1900 Hz.

// Zeilenvorlage: [Frequenz, ms] = Ton, ["R"|"G"|"B"|"Y"|"Y0"|"Y1"|"U"|"V"|"C", ms] = Bildzeile; tpl(z) liefert die Vorlage fuer Zeilengruppe z
const SSTV_MODES = (() => {
  const M = {};
  const rgb = (name, vis, w, h, tpl) => { M[name] = { name, vis, w, h, rows: 1, tpl: () => tpl }; };
  const martin = (n, vis, sc) => rgb(n, vis, 320, 256, [[1200, 4.862], [1500, 0.572], ["G", sc], [1500, 0.572], ["B", sc], [1500, 0.572], ["R", sc], [1500, 0.572]]);
  martin("Martin M1", 44, 146.432); martin("Martin M2", 40, 73.216);
  const scottie = (n, vis, sc) => rgb(n, vis, 320, 256, [[1500, 1.5], ["G", sc], [1500, 1.5], ["B", sc], [1200, 9], [1500, 1.5], ["R", sc]]);
  scottie("Scottie S1", 60, 138.24); scottie("Scottie S2", 56, 88.064); scottie("Scottie DX", 76, 345.6);
  M["Robot 36"] = { name: "Robot 36", vis: 8, w: 320, h: 240, rows: 1, yuv: true,
    tpl: z => [[1200, 9], [1500, 3], ["Y", 88], [z % 2 ? 2300 : 1500, 4.5], [1900, 1.5], [z % 2 ? "U" : "V", 44]] };
  M["Robot 72"] = { name: "Robot 72", vis: 12, w: 320, h: 240, rows: 1, yuv: true,
    tpl: () => [[1200, 9], [1500, 3], ["Y", 138], [1500, 4.5], [1900, 1.5], ["V", 69], [2300, 4.5], [1900, 1.5], ["U", 69]] };
  const pd = (n, vis, w, h, px) => { M[n] = { name: n, vis, w, h, rows: 2, yuv: true, tpl: () => [[1200, 20], [1500, 2.08], ["Y0", w * px], ["V", w * px], ["U", w * px], ["Y1", w * px]] }; };
  pd("PD 50", 93, 320, 256, 0.286); pd("PD 90", 99, 320, 256, 0.532); pd("PD 120", 95, 640, 496, 0.19); pd("PD 160", 98, 512, 400, 0.382);
  pd("PD 180", 96, 640, 496, 0.286); pd("PD 240", 97, 640, 496, 0.382); pd("PD 290", 94, 800, 616, 0.286);
  rgb("Wraase SC2-180", 55, 320, 256, [[1200, 5.5225], [1500, 0.5], ["R", 235], ["G", 235], ["B", 235]]);
  const pas = (n, vis, tu) => rgb(n, vis, 640, 496, [[1200, 25 * tu], [1500, 5 * tu], ["R", 640 * tu], [1500, 5 * tu], ["G", 640 * tu], [1500, 5 * tu], ["B", 640 * tu], [1500, 5 * tu]]);
  pas("Pasokon P3", 113, 1000 / 4800); pas("Pasokon P5", 114, 1000 / 3200); pas("Pasokon P7", 115, 1000 / 2400);
  for (const m of Object.values(M)) { const t = m.tpl(0); m.lineMs = t.reduce((a, s) => a + s[1], 0);
    let o = 0; m.syncAt = null; for (const [f, ms] of t) { if (f === 1200 && m.syncAt === null) { m.syncAt = o; m.syncMs = ms; } o += ms; } }
  return M;
})();
const SSTV_BY_VIS = Object.fromEntries(Object.values(SSTV_MODES).map(m => [m.vis, m]));
const sstvLines = m => m.h / m.rows;
const v2f = v => 1500 + 800 * Math.max(0, Math.min(255, v)) / 255;

function rgb2yuv(r, g, b) { return [0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b]; }
function yuv2rgb(y, u, v) { const c = x => Math.max(0, Math.min(255, Math.round(x))); u -= 128; v -= 128; return [c(y + 1.402 * v), c(y - 0.344136 * u - 0.714136 * v), c(y + 1.772 * u)]; }

// ---------- Senden ----------
// px: Uint8ClampedArray RGBA (Breite m.w, Hoehe m.h) -> Audio bei sr
function sstvTx(mode, px, sr, opts = {}) {
  const m = SSTV_MODES[mode], seq = [];
  if (opts.vox !== false) for (const f of [1900, 1500, 1900, 1500, 2300, 1500, 2300, 1500]) seq.push([f, 100]);
  seq.push([1900, 300], [1200, 10], [1900, 300], [1200, 30]);
  let ones = 0; for (let b = 0; b < 7; b++) { const bit = (m.vis >> b) & 1; ones += bit; seq.push([bit ? 1100 : 1300, 30]); }
  seq.push([ones % 2 ? 1100 : 1300, 30], [1200, 30]);
  const at = (x, y, c) => px[4 * (y * m.w + x) + c], yuvAt = (x, y) => rgb2yuv(at(x, y, 0), at(x, y, 1), at(x, y, 2));
  for (let z = 0; z < sstvLines(m); z++) {
    for (const [k, ms] of m.tpl(z)) {
      if (typeof k === "number") { seq.push([k, ms]); continue; }
      const pms = ms / m.w, y0 = z * m.rows;
      for (let x = 0; x < m.w; x++) {
        let v;
        if (k === "R" || k === "G" || k === "B") v = at(x, y0, "RGB".indexOf(k));
        else if (k === "Y" || k === "Y0") v = yuvAt(x, y0)[0];
        else if (k === "Y1") v = yuvAt(x, y0 + 1)[0];
        else { const ci = k === "U" ? 1 : 2; v = m.rows === 2 ? (yuvAt(x, y0)[ci] + yuvAt(x, y0 + 1)[ci]) / 2 : yuvAt(x, y0)[ci]; }
        seq.push([v2f(v), pms]);
      }
    }
  }
  const n = Math.ceil(seq.reduce((a, s) => a + s[1], 0) * sr / 1000) + 1, y = new Float32Array(n); let ph = 0, t = 0, k = 0;
  for (const [f, ms] of seq) { t += ms * sr / 1000; const inc = TAU * f / sr; for (; k < t && k < n; k++) { y[k] = 0.7 * Math.sin(ph); ph += inc; if (ph > TAU) ph -= TAU; } }
  return y.subarray(0, k);
}

// ---------- Empfang ----------
class SstvRx {
  // onEvent({type:"start", mode}|{type:"line", y, rgb: Uint8ClampedArray(w*4*rows)}|{type:"done"})
  constructor(onEvent, fixedMode = "") {
    this.onEvent = onEvent; this.fixed = fixedMode; this.nph = 0; this.ninc = TAU * 1900 / DFS;
    const T = 25, cut = 1000 / DFS; this.lp = Float32Array.from({ length: T }, (_, k) => { const m = k - (T - 1) / 2, w = 0.54 - 0.46 * Math.cos(TAU * k / (T - 1)); return (m ? Math.sin(TAU * cut * m) / (Math.PI * m) : 2 * cut) * w; });
    this.hi = new Float32Array(T); this.hq = new Float32Array(T); this.hp = 0; this.pi = 0; this.pq = 0;
    this.f = new Float32Array(DFS * 60); this.cum = new Float64Array(DFS * 60 + 1); this.n = 0;      // Frequenzverlauf + laufende Summe
    this.state = "vis"; this.visScan = 0; this.img = null; this.manual = null;
  }
  // manueller Start ohne VIS (Bild laeuft schon): ab jetzt im gewaehlten Modus
  startManual(mode) { this.begin(SSTV_MODES[mode], this.n); this.manual = true; }
  process(x) {
    const T = this.lp.length;
    for (let i = 0; i < x.length; i++) {
      const c = Math.cos(this.nph), s = Math.sin(this.nph); this.nph += this.ninc; if (this.nph > TAU) this.nph -= TAU;
      this.hi[this.hp] = x[i] * c; this.hq[this.hp] = -x[i] * s; this.hp = (this.hp + 1) % T;
      let re = 0, im = 0; for (let k = 0, j = this.hp; k < T; k++, j = j + 1 === T ? 0 : j + 1) { re += this.hi[j] * this.lp[k]; im += this.hq[j] * this.lp[k]; }
      const dr = re * this.pi + im * this.pq, di = im * this.pi - re * this.pq; this.pi = re; this.pq = im;
      let f = 1900 + Math.atan2(di, dr) * DFS / TAU; if (!(f > 900 && f < 2700)) f = this.n ? this.f[this.n - 1] : 1900;
      if (this.n >= this.f.length) { const g = new Float32Array(this.f.length * 2); g.set(this.f); this.f = g; const h = new Float64Array(g.length + 1); h.set(this.cum); this.cum = h; }
      this.f[this.n] = f; this.cum[this.n + 1] = this.cum[this.n] + f; this.n++;
    }
    if (this.state === "vis") this.findVis(); else this.decodeLines();
  }
  avg(a, b) { a = Math.max(0, Math.round(a)); b = Math.min(this.n, Math.round(b)); if (b <= a) return this.f[Math.max(0, Math.min(this.n - 1, a))]; return (this.cum[b] - this.cum[a]) / (b - a); }
  findVis() {   // Vorlauf 1900 / Trennung 1200 / Vorlauf 1900 / Startbit 1200, dann 8 Bit zu 30 ms
    const ms = DFS / 1000;
    for (; this.visScan + 640 * ms < this.n; this.visScan += 2) {
      const t = this.visScan;   // Kandidat: Beginn des Startbits
      if (Math.abs(this.avg(t + 3 * ms, t + 27 * ms) - 1200) > 70) continue;
      if (Math.abs(this.avg(t - 250 * ms, t - 10 * ms) - 1900) > 70) continue;
      if (Math.abs(this.avg(t - 2 * ms, t) - 1900) > 150) continue;       // Flanke genau treffen
      let vis = 0, ones = 0, ok = true;
      for (let b = 0; b < 8; b++) { const f = this.avg(t + (30 * (b + 1) + 5) * ms, t + (30 * (b + 2) - 5) * ms); if (Math.abs(f - 1100) < 70) { if (b < 7) vis |= 1 << b; ones++; } else if (Math.abs(f - 1300) >= 70) { ok = false; break; } }
      if (!ok || ones % 2) continue;
      if (Math.abs(this.avg(t + 275 * ms, t + 295 * ms) - 1200) > 90) continue;
      const m = this.fixed ? SSTV_MODES[this.fixed] : SSTV_BY_VIS[vis];
      if (!m) { this.onEvent({ type: "unknown", vis }); this.visScan = t + 300 * ms; continue; }
      this.begin(m, t + 300 * ms); return;
    }
    // alten Verlauf verwerfen, solange kein Bild laeuft
    if (this.n > DFS * 30) { const keep = DFS * 5, cut = this.n - keep; this.f.copyWithin(0, cut, this.n); this.n = keep; this.visScan = Math.max(0, this.visScan - cut);
      this.cum[0] = 0; for (let i = 0; i < keep; i++) this.cum[i + 1] = this.cum[i] + this.f[i]; }
  }
  begin(m, t0) {
    this.m = m; this.t0 = t0; this.z = 0; this.state = "img"; this.r36 = this.r36prev = null; this.syncs = []; this.period = m.lineMs * DFS / 1000;
    this.onEvent({ type: "start", mode: m.name, w: m.w, h: m.h });
  }
  findSync(z) {   // Sync-Impuls der Zeile z um die erwartete Lage suchen (Ergebnis: Abweichung in Abtastwerten)
    const m = this.m; if (m.syncAt === null) return null;
    const ms = DFS / 1000, exp = this.t0 + z * this.period + m.syncAt * ms, L = Math.max(4, Math.round(m.syncMs * ms));
    const R = Math.round((this.syncs.length < 3 ? 20 : Math.min(8, m.lineMs * 0.03)) * ms);
    // Mittelwert ueber den Impuls (rauschfest) und Kontrast zur Umgebung (davor/danach nie 1200 Hz)
    let best = null, bv = 1e9;
    for (let d = -R; d <= R; d++) { const a = exp + d; if (a - L < 0 || a + 2 * L >= this.n) continue; const v = Math.abs(this.avg(a, a + L) - 1200); if (v < bv) { bv = v; best = d; } }
    if (best === null || bv > 60) return null;
    const a = exp + best, around = Math.max(Math.abs(this.avg(a - 3 * ms, a) - 1200), Math.abs(this.avg(a + L, a + L + 3 * ms) - 1200));
    return around > 150 ? best : null;      // davor/danach muss deutlich hoeher liegen (sonst kein Sync-Impuls)
  }
  decodeLines() {
    const m = this.m, ms = DFS / 1000, lines = sstvLines(m);
    while (this.z < lines && this.t0 + (this.z + 1) * this.period + 10 * ms < this.n) {
      const z = this.z, d = this.findSync(z);
      if (d !== null) {
        // Ausreisser (Stoerung, Bildinhalt) verwerfen; mehrere gleichartige Abweichungen = echter Versatz -> neu einrasten
        if (this.syncs.length >= 6 && Math.abs(d) > 6) { (this.rej = this.rej || []).push(d);
          if (this.rej.length >= 5) { const r = this.rej.slice().sort((p, q) => p - q), med = r[2]; if (r[4] - r[0] < 8) { this.t0 += med; this.syncs = []; } this.rej = []; } }
        else { this.rej = []; this.syncs.push([z, d]);
          // Schraegkorrektur: Ausgleichsgerade durch die Sync-Abweichungen (Zeitversatz + Taktfehler der Soundkarte)
          if (this.syncs.length >= 6) { const S = this.syncs.slice(-80), n = S.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const [x, y] of S) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
            const den = n * sxx - sx * sx; if (den > 0) { const k = (n * sxy - sx * sy) / den, b0 = (sy - k * sx) / n; if (Math.abs(k) < this.period * 0.01) { this.t0 += b0; this.period += k; this.syncs = this.syncs.map(([x, y]) => [x, y - b0 - k * x]); } } }
          else if (this.syncs.length === 3) { const r = this.syncs.map(q => q[1]).sort((p, q) => p - q); if (r[2] - r[0] <= 6) { this.t0 += r[1]; this.syncs = this.syncs.map(([x, y]) => [x, y - r[1]]); } else this.syncs.shift(); } }
      }
      this.emitLine(z); this.z++;
    }
    if (this.z >= lines) { this.onEvent({ type: "done", mode: m.name }); this.state = "vis"; this.visScan = Math.max(0, this.n - 2 * DFS); this.manual = false; }
  }
  r36out(c, a, b) {
    const m = this.m, out = new Uint8ClampedArray(m.w * 4), miss = c.U ? "V" : "U";
    for (let x = 0; x < m.w; x++) { const n = [a, b].filter(l => l && l[miss]).map(l => l[miss][x]), o = n.length ? n.reduce((p, q) => p + q, 0) / n.length : 128;
      const rgb = yuv2rgb(c.Y[x], c.U ? c.U[x] : o, c.V ? c.V[x] : o); out.set([rgb[0], rgb[1], rgb[2], 255], 4 * x); }
    this.onEvent({ type: "line", y: c.z, rows: 1, w: m.w, rgb: out });
  }
  emitLine(z) {
    const m = this.m, ms = DFS / 1000, tpl = m.tpl(z), ch = {}; let o = this.t0 + z * this.period;
    for (const [k, dur] of tpl) {
      const len = dur * ms * this.period / (m.lineMs * ms);
      if (typeof k !== "number") { const a = new Float32Array(m.w), pw = len / m.w; for (let x = 0; x < m.w; x++) { const f = this.avg(o + x * pw, o + (x + 1) * pw); a[x] = Math.max(0, Math.min(255, (f - 1500) / 800 * 255)); } ch[k] = a; }
      o += len;
    }
    if (m.yuv && m.rows === 1 && !(ch.U && ch.V)) {   // Robot 36: Farbanteile zeilenweise abwechselnd -> fehlenden aus Nachbarzeilen mitteln
      const prev = this.r36; this.r36 = { z, ...ch };
      if (prev) this.r36out(prev, this.r36prev, this.r36);
      this.r36prev = prev; if (z === sstvLines(m) - 1) this.r36out(this.r36, prev, null);
      return;
    }
    const out = new Uint8ClampedArray(m.w * 4 * m.rows);
    for (let r = 0; r < m.rows; r++) for (let x = 0; x < m.w; x++) {
      let rgb;
      if (!m.yuv) rgb = [ch.R[x], ch.G[x], ch.B[x]];
      else if (m.rows === 2) rgb = yuv2rgb((r ? ch.Y1 : ch.Y0)[x], ch.U[x], ch.V[x]);
      else rgb = yuv2rgb(ch.Y[x], ch.U[x], ch.V[x]);
      out.set([rgb[0], rgb[1], rgb[2], 255], 4 * (r * m.w + x));
    }
    this.onEvent({ type: "line", y: z * m.rows, rows: m.rows, w: m.w, rgb: out });
  }
}
