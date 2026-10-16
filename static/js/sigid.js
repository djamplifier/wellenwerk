"use strict";
// Wellenwerk – Signalerkennung: bestimmt aus einigen Sekunden Ton (8 kHz) um eine Tonfrequenz, welche Betriebsart dort
// laeuft – Traeger, CW, Hellschreiber, PSK/QPSK, FT8/FT4, RTTY und andere FSK, MFSK/Olivia/DominoEX, WSPR/JT, SSTV,
// Wetterfax, MT63/OFDM, Sprache, AM. Vorgehen: Merkmale messen (Bandbreite, Spektrallinien, Huellkurve, Tonraster,
// Synchronmuster), passende Betriebsarten bewerten und – wo Wellenwerk einen Dekoder hat – probehalber dekodieren;
// lesbarer Text bestaetigt die Erkennung. Kein Zugriff auf die Oberflaeche (auch in Node testbar).
const SIGID = (() => {
  const FS = 8000, TAU = 2 * Math.PI;

  // ---------- Grundbausteine ----------
  const tw = new Map();
  function fft(re, im) {   // komplexe FFT an Ort und Stelle, Laenge Zweierpotenz
    const n = re.length; let T = tw.get(n);
    if (!T) { const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n), c = new Float64Array(n / 2), s = new Float64Array(n / 2);
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
      for (let i = 0; i < n / 2; i++) { c[i] = Math.cos(TAU * i / n); s[i] = -Math.sin(TAU * i / n); } tw.set(n, T = { rev, c, s }); }
    const { rev, c, s } = T;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size *= 2) { const h = size / 2, st = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < h; j++) { const k = j * st, a = i + j, b = a + h;
        const tr = re[b] * c[k] - im[b] * s[k], ti = re[b] * s[k] + im[b] * c[k]; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  const pow2 = n => 1 << Math.ceil(Math.log2(Math.max(2, n)));
  const hann = n => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(TAU * (i + 0.5) / n); return w; };
  const pct = (a, p) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] : 0; };
  const mean = a => { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : 0; };
  const near = (v, ref, tol) => Math.abs(v - ref) <= ref * tol;
  const db = v => 10 * Math.log10(Math.max(v, 1e-30));

  // Leistungsdichte (Welch, Hann, 75 % Ueberlappung) eines reellen Signals: mittlere Leistung je Bin (N/2 Werte)
  function psd(x, N) {
    const w = hann(N), re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2); let k = 0;
    const frame = a => { for (let i = 0; i < N; i++) { re[i] = (x[a + i] || 0) * w[i]; im[i] = 0; } fft(re, im); for (let i = 0; i < N / 2; i++) P[i] += re[i] * re[i] + im[i] * im[i]; k++; };
    for (let a = 0; a + N <= x.length; a += N / 4) frame(a);
    if (!k) frame(0);
    for (let i = 0; i < N / 2; i++) P[i] /= k;
    return P;
  }
  const smooth = (P, r) => { const o = new Float64Array(P.length); const n = P.length;
    for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { a += P[k]; c++; } o[i] = a / c; } return o; };

  // Komplexes Basisband um fc (±half Hz): mischen, Tiefpass (Blackman-sinc), dezimieren um M
  let bbCache = null;   // je Analyse: gleiche Mitte/Breite nur einmal filtern
  function baseband(x, fc, half, M) {
    const key = `${Math.round(fc * 10)}|${Math.round(half)}|${M || 0}`; if (bbCache && bbCache.x === x && bbCache.m.has(key)) return bbCache.m.get(key);
    const r = baseband0(x, fc, half, M); if (bbCache && bbCache.x === x) bbCache.m.set(key, r); return r;
  }
  function baseband0(x, fc, half, M) {
    M = M || Math.max(1, Math.floor(FS / (2.6 * half)));
    const tr = Math.max(10, half * 0.35), L = Math.min(4001, (Math.ceil(5.5 * FS / tr) | 1)), h = new Float64Array(L), mid = (L - 1) / 2, fcut = (half + tr / 2) / FS;
    let hs = 0; for (let i = 0; i < L; i++) { const m = i - mid, s = m === 0 ? 2 * fcut : Math.sin(TAU * fcut * m) / (Math.PI * m);
      h[i] = s * (0.42 - 0.5 * Math.cos(TAU * i / (L - 1)) + 0.08 * Math.cos(2 * TAU * i / (L - 1))); hs += h[i]; }
    for (let i = 0; i < L; i++) h[i] /= hs;
    const n = x.length, mr = new Float32Array(n), mi = new Float32Array(n), w = TAU * fc / FS;
    for (let i = 0; i < n; i++) { mr[i] = x[i] * Math.cos(w * i); mi[i] = -x[i] * Math.sin(w * i); }
    const out = Math.max(0, Math.floor((n - L) / M) + 1), re = new Float32Array(out), im = new Float32Array(out);
    for (let o = 0; o < out; o++) { let a = 0, b = 0; const s = o * M; for (let k = 0; k < L; k++) { a += h[k] * mr[s + k]; b += h[k] * mi[s + k]; } re[o] = 2 * a; im[o] = 2 * b; }
    return { re, im, fs: FS / M, fc, t0: mid / FS };
  }

  // Spektrallinie von z^p (p=1 Traeger, 2 BPSK, 4 QPSK): Anteil der staerksten Linie an der Gesamtleistung
  function line(bb, p) {
    const n = Math.min(pow2(bb.re.length), 1 << 16), re = new Float64Array(n), im = new Float64Array(n), w = hann(Math.min(n, bb.re.length));
    for (let i = 0; i < Math.min(n, bb.re.length); i++) { let a = bb.re[i], b = bb.im[i]; const m = Math.hypot(a, b) || 1e-12;
      for (let k = 1; k < p; k++) { const t = a * bb.re[i] - b * bb.im[i]; b = a * bb.im[i] + b * bb.re[i]; a = t; }
      const sc = Math.pow(m, 1 - p); re[i] = a * sc * w[i]; im[i] = b * sc * w[i]; }
    fft(re, im); let tot = 0, mx = 0, mi = 0; const P = new Float64Array(n);
    for (let i = 0; i < n; i++) { P[i] = re[i] * re[i] + im[i] * im[i]; tot += P[i]; if (P[i] > mx) { mx = P[i]; mi = i; } }
    let pk = 0; for (let d = -3; d <= 3; d++) pk += P[(mi + d + n) % n];
    const f = (mi < n / 2 ? mi : mi - n) * bb.fs / n / p;
    return { ratio: pk / (tot || 1), f };
  }

  // Huellkurve (Betrag des Basisbands), leicht geglaettet
  function envelope(bb, ms = 2) {
    const n = bb.re.length, e = new Float32Array(n), L = Math.max(1, Math.round(bb.fs * ms / 1000)); let s = 0; const q = new Float32Array(L);
    for (let i = 0; i < n; i++) { const v = Math.hypot(bb.re[i], bb.im[i]); s += v - q[i % L]; q[i % L] = v; e[i] = s / Math.min(i + 1, L); }
    return e;
  }

  // Leistung je Rahmen bei gegebenen Frequenzen (relativ zur Basisbandmitte): Array [Rahmen][Frequenz]
  function tonePowers(bb, freqs, W, hop) {
    const n = bb.re.length, frames = [], cs = freqs.map(f => { const c = new Float64Array(W), s = new Float64Array(W); for (let k = 0; k < W; k++) { c[k] = Math.cos(TAU * f * k / bb.fs); s[k] = -Math.sin(TAU * f * k / bb.fs); } return [c, s]; });
    for (let a = 0; a + W <= n; a += hop) {
      const row = new Float64Array(freqs.length);
      for (let j = 0; j < freqs.length; j++) { const [c, s] = cs[j]; let r = 0, i = 0;
        for (let k = 0; k < W; k++) { const x = bb.re[a + k], y = bb.im[a + k]; r += x * c[k] - y * s[k]; i += x * s[k] + y * c[k]; }
        row[j] = r * r + i * i; }
      frames.push(row);
    }
    return frames;
  }

  // ---------- 1. Signal und Bandbreite ----------
  function occupancy(x, fc) {
    const N = 8192, df = FS / N, P = psd(x, N), Ps = smooth(P, 3);
    const b = f => Math.max(1, Math.min(N / 2 - 2, Math.round(f / df)));
    // nur den Durchlassbereich des Empfaengers werten: ausserhalb (Filterflanken) ist der Ton fast stumm und wuerde den Rauschboden verfaelschen
    const all = []; for (let i = b(200); i < b(3700); i++) all.push(Ps[i]); const deep = pct(all, 0.5) / 300, passTh = all.filter(v => v < deep).length > all.length * 0.05 ? deep : 0;   // Sperrbereich: >25 dB unter dem Median
    const inPass = i => Ps[i] > passTh, band = all.filter(v => v > passTh);
    // Rauschboden: 20 % ueber die Frequenz – oder, wenn das Signal das Band fuellt (Sprache), die leisesten Momente je Frequenz
    const N2 = 1024, w2 = hann(N2), re = new Float64Array(N2), im = new Float64Array(N2), cols = [];
    for (let a = 0; a + N2 <= x.length; a += N2 / 2) { for (let i = 0; i < N2; i++) { re[i] = x[a + i] * w2[i]; im[i] = 0; } fft(re, im); const row = new Float64Array(N2 / 2); for (let i = 0; i < N2 / 2; i++) row[i] = re[i] * re[i] + im[i] * im[i]; cols.push(row); }
    let floorT = Infinity;
    if (cols.length >= 20) { const lows = []; for (let i = Math.round(250 / (FS / N2)); i < Math.round(3600 / (FS / N2)); i++) if (inPass(Math.round(i * (FS / N2) / df))) lows.push(pct(cols.map(r => r[i]), 0.1) / 0.105); if (lows.length > 10) floorT = pct(lows, 0.5) * N / N2; }
    const floor = Math.min(pct(band, 0.2), floorT) || 1e-12;
    // Spitze nahe dem Klick; liegt dort nichts Deutliches (Klick zwischen FSK-Toenen, neben dem Traeger, Sprache), weiter suchen
    const argmax = (f0, f1) => { let m = b(f0); for (let i = b(f0); i <= b(f1); i++) if (Ps[i] > Ps[m]) m = i; return m; };
    let pk = argmax(fc - 45, fc + 45);
    for (const r of [150, 700]) { if (db(Ps[pk] / floor) >= 12) break; const p2 = argmax(fc - r, fc + r); if (Ps[p2] > Ps[pk] * 4) pk = p2; }
    const snr = db(Ps[pk] / floor), thr = Math.max(floor * 4, Ps[pk] * 0.003);
    const edge = dir => { let i = pk, last = pk, gap = 0; while (i > 1 && i < N / 2 - 2 && Math.abs(i - pk) * df < 1400) { i += dir; if (Ps[i] > thr) { last = i; gap = 0; } else if (++gap * df > 35) break; } return last; };
    let lo = edge(-1) * df, hi = edge(1) * df;
    // Sehr schmale Signale (WSPR, JT9, Traeger): Breite mit feinerer Aufloesung nachmessen
    if (hi - lo < 40 && x.length >= 3 * 32768) { const Pf = psd(x, 32768), d2 = FS / 32768, c = Math.round(pk * df / d2); let m = c; for (let i = c - 40; i <= c + 40; i++) if (Pf[i] > Pf[m]) m = i;
      const th = Math.max(Pf[m] * 0.02, floor / 4 * 1.5); let a = m, z = m; while (a > 1 && Pf[a - 1] > th) a--; while (z < Pf.length - 2 && Pf[z + 1] > th) z++; lo = a * d2; hi = z * d2; }
    // Breite Belegung: stark geglaettet, schwache, aber flaechige Anhebung (Sprache, MT63, SSTV bei viel Rauschen)
    const Pw = smooth(P, Math.round(25 / df)), thrW = floor * 1.6;
    let cw = b(fc); if (Pw[cw] <= thrW) { cw = argmax(fc - 700, fc + 700); for (let i = b(fc - 700); i <= b(fc + 700); i++) if (Pw[i] > Pw[cw]) cw = i; }
    const edgeW = dir => { let i = cw, last = cw, gap = 0; while (i > 1 && i < N / 2 - 2 && Math.abs(i - cw) * df < 1600) { i += dir; if (Pw[i] > thrW) { last = i; gap = 0; } else if (++gap * df > 60) break; } return last; };
    const wlo = edgeW(-1) * df, whi = edgeW(1) * df; let ws = 0; for (let i = b(wlo); i <= b(whi); i++) ws += Pw[i];
    const wide = { lo: wlo, hi: whi, bw: whi - wlo, center: (wlo + whi) / 2, excess: Pw[cw] > thrW ? db(ws / (b(whi) - b(wlo) + 1) / floor) : 0 };
    const occ = { P, Ps, df, floor, peak: pk * df, snr, lo, hi, bw: hi - lo, center: (lo + hi) / 2, wide };
    if (wide.bw > 150 && wide.excess > 2 && (snr < 10 || wide.bw > 3 * (hi - lo) && snr < 20)) Object.assign(occ, { lo: wlo, hi: whi, bw: wide.bw, center: wide.center, usedWide: true });
    return occ;
  }

  // ---------- 2. Traeger, CW, Hell, PSK ----------
  function keyed(bb, ms = 2) {   // An/Aus-Tastung: Pegelverhaeltnis, Tastgrad, kuerzestes Element
    const e = envelope(bb, ms), lo = pct(e, 0.1), hi = pct(e, 0.9), th = Math.sqrt(Math.max(lo, hi * 0.02) * hi);
    let on = 0, runs = [], offRuns = [], cur = e[0] > th, len = 0, ec = 0, es = 0, ne = 0; const px = 1000 / 122.5;
    e.forEach((v, i) => { const s = v > th; if (s) on++; if (s === cur) len++; else { (cur ? runs : offRuns).push(len / bb.fs * 1000); if (s) { const t = i / bb.fs * 1000; ec += Math.cos(TAU * t / px); es += Math.sin(TAU * t / px); ne++; } cur = s; len = 1; } });
    runs = runs.filter(r => r > 1.5); offRuns = offRuns.filter(r => r > 1.5);
    const typ = runs.length ? pct(runs, 0.6) : 0, real = runs.filter(r => r >= Math.max(2, typ * 0.25));   // Scheinpulse aus Rauschspitzen ignorieren
    const dot = real.length >= 3 ? pct(real, 0.25) : 0;
    const quant = ne ? Math.hypot(ec, es) / ne : 0;   // Einschaltflanken im Hell-Pixeltakt (8,16 ms)?
    return { ratio: hi / Math.max(lo, 1e-9), duty: on / e.length, dot, nOn: real.length, quant, cv: (() => { const m = mean(e); let s = 0; for (const v of e) s += (v - m) ** 2; return Math.sqrt(s / e.length) / (m || 1); })() };
  }
  function envRate(bb, rates) {   // Linie im Spektrum der Huellkurve bei einer der Symbolraten (PSK: Phasenspruenge)
    const e = envelope(bb, 0.5), n = Math.min(pow2(e.length), 1 << 16), re = new Float64Array(n), im = new Float64Array(n), m = mean(e);
    for (let i = 0; i < Math.min(n, e.length); i++) re[i] = (e[i] - m);
    fft(re, im); const P = new Float64Array(n / 2); for (let i = 0; i < n / 2; i++) P[i] = re[i] * re[i] + im[i] * im[i];
    const df = bb.fs / n, ref = pct(P.subarray(Math.round(5 / df), Math.round(Math.min(bb.fs / 2 - 1, 400) / df)), 0.5) || 1e-12;
    let best = null;
    for (const r of rates) { if (r >= bb.fs / 2) continue; let mx = 0; for (let i = Math.round(r * 0.97 / df); i <= Math.round(r * 1.03 / df); i++) mx = Math.max(mx, P[i] || 0);
      const v = mx / ref; if (!best || v > best.v) best = { r, v }; }
    return best || { r: 0, v: 0 };
  }

  // ---------- 3. FT8 / FT4: Costas-Synchronmuster ----------
  const FT = {
    FT8: { M: 32, sym: 40, sp: 6.25, n: 8, arrays: [[3, 1, 4, 0, 6, 5, 2]], at: [0, 36, 72], nsym: 79 },
    FT4: { M: 16, sym: 24, sp: 20.833, n: 4, arrays: [[0, 1, 3, 2], [1, 0, 2, 3], [2, 3, 1, 0], [3, 2, 0, 1]], at: [0, 33, 66, 99], nsym: 103 },
  };
  function costas(x, fc, name, inverted) {
    const S = FT[name], bb = baseband(x, fc, S.n * S.sp + 70, S.M), fs = bb.fs, q = S.sym / 4, nb = S.sym;   // DFT ueber ein Symbol: Bins im Tonabstand
    const frames = Math.floor((bb.re.length - S.sym) / q) + 1; if (frames < S.arrays[0].length * 4) return { r: 0 };
    // Spektrum je Viertelsymbol, zwei Halbbin-Lagen
    const spec = [0, 1].map(h => { const out = []; for (let t = 0; t < frames; t++) { const a = t * q, row = new Float64Array(nb);
      for (let k = 0; k < nb; k++) { let r = 0, i = 0; const f = (k < nb / 2 ? k : k - nb) + h / 2;
        for (let m = 0; m < S.sym; m++) { const ph = -TAU * f * m / S.sym, c = Math.cos(ph), s = Math.sin(ph), xr = bb.re[a + m], xi = bb.im[a + m]; r += xr * c - xi * s; i += xr * s + xi * c; }
        row[k] = r * r + i * i; } out.push(row); } return out; });
    const binOf = (k) => ((k % nb) + nb) % nb;
    const fmax = Math.round(60 / S.sp), best = { r: 0, hits: 0, q: 0 };
    for (let h = 0; h < 2; h++) for (let b0 = -fmax - S.n; b0 <= fmax; b0++) for (let t0 = -S.at[S.at.length - 1] * 4; t0 < frames; t0++) {
      let on = 0, all = 0, used = 0, hits = 0, arrays = 0, outside = 0;
      S.at.forEach((p, ai) => { const arr = S.arrays[ai % S.arrays.length]; let ok = true;
        for (let i = 0; i < arr.length; i++) { const t = t0 + (p + i) * 4; if (t < 0 || t >= frames) { ok = false; continue; } const row = spec[h][t];
          const tone = inverted ? S.n - 1 - arr[i] : arr[i]; let sum = 0, mx = 0, mk = 0;
          for (let k = 0; k < S.n; k++) { const v = row[binOf(b0 + k)]; sum += v; if (v > mx) { mx = v; mk = k; } }
          on += row[binOf(b0 + tone)]; all += sum / S.n; used++; if (mk === tone) hits++;
          for (const k of [-3, -2, S.n + 1, S.n + 2]) outside += row[binOf(b0 + k)] / 4; }
        if (ok) arrays++; });
      if (used < S.arrays[0].length) continue;
      const hf = hits / used, qual = hf * Math.min(1, used / (2 * S.arrays[0].length));   // mind. zwei Synchronbloecke fuer volle Wertung
      if (qual > best.q || (qual === best.q && on / all > best.r)) Object.assign(best, { q: qual, r: on / (all || 1e-12), conf: all / (outside || 1e-12), hits: hf, used, arrays, f: fc + (b0 + h / 2) * S.sp, dt: t0 * q / fs });
    }
    return best;
  }

  // ---------- 4. FSK: Tonraster, Symbolrate ----------
  // Zwei-Ton-FSK (RTTY u. a.): Shift aus den beiden Haeufungen der Momentanfrequenz, Baud aus der haeufigsten Lauflaenge
  // (bei Zufallsdaten ist ein einzelnes Bit am haeufigsten; Stoppbits von 1,5 Einheiten stoeren so nicht)
  function fsk2(x, occ) {   // Fenster um die staerkste Spitze, weit genug fuer 850-Hz-Shift, auch wenn der Klick auf einem der Toene lag
    const c0 = Math.max(1000, Math.min(3000, occ.peak)), half = Math.min(950, c0 - 50, 3950 - c0), bb = baseband(x, c0, half), fs = bb.fs;
    const W = Math.max(6, Math.round(fs * 0.011)), hop = Math.max(1, Math.round(fs * 0.0015)), step = 8;
    const freqs = []; for (let f = -half; f <= half; f += step) freqs.push(f);
    const fr = tonePowers(bb, freqs, W, hop), en = fr.map(r => r.reduce((a, b) => a + b, 0)), eth = pct(en, 0.35);
    const pk = fr.map(r => { let m = 1; for (let i = 1; i < r.length - 1; i++) if (r[i] > r[m]) m = i; const a = r[m - 1], b = r[m], c = r[m + 1], d = a - 2 * b + c;
      return freqs[m] + (d ? 0.5 * (a - c) / d : 0) * step; });
    const hw = 5, nb = Math.ceil(2 * half / hw) + 1, hist = new Float64Array(nb); let tot = 0;
    pk.forEach((f, i) => { if (en[i] > eth) { hist[Math.max(0, Math.min(nb - 1, Math.round((f + half) / hw)))]++; tot++; } });
    const hs = smooth(hist, 2), fAt = i => -half + i * hw;
    let a = 0; for (let i = 1; i < nb; i++) if (hs[i] > hs[a]) a = i;
    let b = -1; for (let i = 0; i < nb; i++) if (Math.abs(i - a) * hw >= 60 && (b < 0 || hs[i] > hs[b])) b = i;
    if (b < 0 || hs[b] < hs[a] * 0.2 || !tot) return null;
    let fa = fAt(a), fb = fAt(b); const lim = Math.max(15, Math.abs(fa - fb) * 0.25);
    let inA = 0, inB = 0, sa = 0, sb = 0; pk.forEach((f, i) => { if (en[i] <= eth) return; if (Math.abs(f - fa) < lim) { inA++; sa += f; } else if (Math.abs(f - fb) < lim) { inB++; sb += f; } });
    if (inA) fa = sa / inA; if (inB) fb = sb / inB;   // Schwerpunkt der Haeufungen
    const shift = Math.abs(fa - fb), mid = (fa + fb) / 2;
    const share = (inA + inB) / tot, balance = Math.min(inA, inB) / Math.max(1, Math.max(inA, inB));
    // Lauflaengen der Toene (Stoerspitzen unter 1,5 ms ueberbruecken)
    const runs = []; let cur = -1, len = 0;
    pk.forEach((f, i) => { const st = en[i] <= eth ? -1 : (f > mid ? 1 : 0); if (st === cur || st < 0) { len++; return; } if (cur >= 0) runs.push(len); cur = st; len = 1; });
    const rl = runs.map(r => r * hop / fs * 1000).filter(r => r >= 1.5);   // Lauflaengen in ms
    let baud = 0;
    if (rl.length > 20) { const h = new Float64Array(400); rl.forEach(r => { if (r < 200) h[Math.round(r * 2)]++; }); const hh = smooth(h, 2); let m = 3; for (let i = 3; i < 400; i++) if (hh[i] > hh[m]) m = i;
      const T = m / 2, near1 = rl.filter(r => r > T * 0.7 && r < T * 1.35); baud = 1000 / (near1.length ? mean(near1) : T); }
    return { shift, share, balance, baud, lowTone: c0 + Math.min(fa, fb), highTone: c0 + Math.max(fa, fb) };
  }

  // Bekannte Mehrton-Verfahren: n Toene im Abstand sp, Symbolrate baud
  const MFSK = (() => {
    const L = [["WSPR", 4, 1.4648, 1.4648], ["JT9", 9, 1.736, 1.736], ["JT65", 66, 2.6917, 2.6917], ["FT8", 8, 6.25, 6.25], ["FT4", 4, 20.833, 20.833],
      ["MFSK8", 32, 7.8125, 7.8125], ["MFSK16", 16, 15.625, 15.625], ["MFSK32", 16, 31.25, 31.25], ["ALE", 8, 250, 125]];
    for (const [t, b] of [[4, 125], [4, 250], [8, 250], [8, 500], [16, 500], [32, 1000], [8, 1000], [16, 1000], [32, 2000], [64, 2000]]) L.push([`Olivia ${t}/${b}`, t, b / t, b / t]);
    for (const [s, v] of Object.entries({ 4: [2048, 2, 8000], 5: [2048, 2, 11025], 8: [1024, 2, 8000], 11: [1024, 1, 11025], 16: [512, 1, 8000], 22: [512, 1, 11025] }))
      L.push([`DominoEX ${s}`, 18, v[2] * v[1] / v[0], v[2] / v[0], true]);
    return L.map(([id, n, sp, baud, ifk]) => ({ id, n, sp, baud, ifk: !!ifk }));
  })();
  function mfskScore(x, occ, H) {
    const span = H.n * H.sp, half = span / 2 + H.sp * 1.5 + 20, bb = baseband(x, occ.center, half), fs = bb.fs;
    const W = Math.max(4, Math.round(fs / H.baud)), hop = Math.max(1, Math.round(W / 2));
    let best = null;
    for (let o = 0; o < 4; o++) {
      const d = (o / 4 - 0.5) * H.sp, on = [], off = [];
      for (let k = 0; k < H.n; k++) on.push(d + (k - (H.n - 1) / 2) * H.sp);
      for (let k = 0; k < H.n - 1; k++) off.push(d + (k - (H.n - 2) / 2) * H.sp);
      const fr = tonePowers(bb, [...on, ...off], W, hop); if (fr.length < 8) return null;
      let g = 0, dm = 0, wsum = 0; const use = new Float64Array(H.n); let rep = 0, prev = -1, cnt = 0;
      const en = fr.map(r => r.reduce((a, b) => a + b, 0)), eth = pct(en, 0.4);
      fr.forEach((r, i) => { if (en[i] < eth) return; let so = 0, sf = 0, mx = 0, mk = 0; for (let k = 0; k < H.n; k++) { so += r[k]; if (r[k] > mx) { mx = r[k]; mk = k; } } for (let k = H.n; k < r.length; k++) sf += r[k];
        const wgt = en[i]; g += wgt * so / (so + sf * H.n / Math.max(1, H.n - 1) + 1e-12); dm += wgt * mx / (so || 1); wsum += wgt; use[mk]++;
        if (i % 2 === 0) { if (prev >= 0) { cnt++; if (mk === prev) rep++; } prev = mk; } });
      const used = [...use].filter(u => u > (wsum ? fr.length * 0.15 / H.n : 0)).length;
      const r = { grid: g / (wsum || 1), dom: dm / (wsum || 1), used, rep: cnt ? rep / cnt : 0, offset: d };
      if (!best || r.grid * r.dom > best.grid * best.dom) best = r;
    }
    const bwFit = Math.min(occ.bw, span) / Math.max(occ.bw, span);
    best.score = best.grid * best.dom * Math.sqrt(bwFit) * Math.min(1, best.used / (H.n * 0.6));
    return best;
  }

  // ---------- 5. Breite Signale ----------
  // Momentanfrequenz (FM-Diskriminator) im Bereich um die Mitte
  function instFreq(x, center, half) {
    const bb = baseband(x, center, half), n = bb.re.length, f = new Float32Array(n), a = new Float32Array(n);
    for (let i = 1; i < n; i++) { const r = bb.re[i] * bb.re[i - 1] + bb.im[i] * bb.im[i - 1], q = bb.im[i] * bb.re[i - 1] - bb.re[i] * bb.im[i - 1]; f[i] = center + Math.atan2(q, r) * bb.fs / TAU; a[i] = Math.hypot(bb.re[i], bb.im[i]); }
    f[0] = f[1] || center;
    const L = Math.max(1, Math.round(bb.fs * 0.0015)), g = new Float32Array(n); let s = 0;   // 1,5 ms glaetten
    for (let i = 0; i < n; i++) { s += f[i] - (i >= L ? f[i - L] : 0); g[i] = s / Math.min(i + 1, L); }
    return { f: g, a, fs: bb.fs };
  }
  // Periodizitaet eines 0/1-Verlaufs bei Periode P (s): Anteil der Treffer im besten Phasenfenster
  function fold(ind, fs, P, win) {
    const bins = Math.max(8, Math.round(P / win)), h = new Float64Array(bins); let tot = 0;
    for (let i = 0; i < ind.length; i++) if (ind[i]) { h[Math.floor((i / fs % P) / P * bins) % bins]++; tot++; }
    let mx = 0; for (let i = 0; i < bins; i++) mx = Math.max(mx, h[i] + h[(i + 1) % bins]);
    return tot ? mx / tot : 0;
  }
  function sstv(x, occ, inverted) {   // Synchronpulse (tiefster Ton, ~300 Hz unter Schwarz) kehren im Zeilentakt eines SSTV-Modus wieder
    const c = Math.max(1700, occ.center), I = instFreq(x, c, 1000), ds = 4, fs = I.fs / ds, n = Math.floor(I.f.length / ds), ath = pct(I.a, 0.5) * 0.3;
    const f = new Float32Array(n); let valid = []; for (let i = 0; i < n; i++) { const a = I.a[i * ds]; f[i] = a > ath ? (inverted ? 2 * c - I.f[i * ds] : I.f[i * ds]) : NaN; if (a > ath) valid.push(f[i]); }
    if (valid.length < 2000) return null;
    const fmin = pct(valid, 0.003), fmed = pct(valid, 0.5); valid = null;
    const modes = typeof SSTV_MODES !== "undefined" ? Object.values(SSTV_MODES).map(m => ({ id: m.name, P: m.lineMs / 1000, sync: (m.syncMs || 5) / 1000 }))
      : [["Martin M1", 446.446, 4.862], ["Scottie S1", 428.22, 9], ["Robot 36", 150, 9], ["PD 120", 508.48, 20]].map(([id, ms, sy]) => ({ id, P: ms / 1000, sync: sy / 1000 }));
    let best = { score: 0 }; const ind = new Uint8Array(n);
    for (let sf = fmin - 50; sf <= Math.min(fmin + 450, fmed - 150); sf += 25) {
      let hits = 0; for (let i = 0; i < n; i++) { ind[i] = Math.abs(f[i] - sf) < 70 ? 1 : 0; hits += ind[i]; }
      const h = hits / n; if (h < 0.004 || h > 0.3) continue;
      for (const m of modes) { const v = fold(ind, fs, m.P, Math.max(m.sync, 0.004)), ref = Math.max(0.03, Math.min(0.5, 2 * m.sync / m.P)), sc = (v - ref) / (1 - ref);
        if (sc > best.score) best = { score: sc, mode: m.id, P: m.P, syncF: sf }; }
    }
    if (best.syncF) best.offset = best.syncF - 1200;
    return best;
  }
  function fax(x, occ) {   // Wetterfax: FM 1500..2300 Hz ohne Synchronton, Zeilen wiederholen sich (60/90/120/240 U/min)
    const I = instFreq(x, 1900, 600), ds = 16, fs = I.fs / ds, v = []; for (let i = 0; i < I.f.length; i += ds) v.push(I.f[i]);
    const m = mean(v); let best = { score: 0 };
    for (const lpm of [60, 90, 120, 240]) { const L = Math.round(fs * 60 / lpm); if (L * 3 > v.length) continue;
      const ac = lag => { let s = 0, a = 0, b = 0; for (let i = 0; i + lag < v.length; i++) { const p = v[i] - m, q = v[i + lag] - m; s += p * q; a += p * p; b += q * q; } return s / Math.sqrt(a * b || 1); };
      const r = ac(L), r2 = ac(Math.round(L * 0.83)), sc = r - Math.max(0, r2);
      if (sc > best.score) best = { score: sc, lpm, r }; }
    return best;
  }
  function dominance(x, occ) {   // Anteil des staerksten Spektralanteils je 32-ms-Rahmen: hoch bei Ein-Ton-Verfahren, niedrig bei Mehrtraeger/Rauschen
    const half = Math.max(30, occ.bw / 2 + 10), bb = baseband(x, occ.center, half), fs = bb.fs, W = pow2(Math.round(fs * 0.032)), w = hann(W);
    const re = new Float64Array(W), im = new Float64Array(W), rows = [];
    for (let a = 0; a + W <= bb.re.length; a += W / 2) { for (let i = 0; i < W; i++) { re[i] = bb.re[a + i] * w[i]; im[i] = bb.im[a + i] * w[i]; } fft(re, im);
      let sum = 0, mx = 0; for (let k = 0; k < W; k++) { const f = (k < W / 2 ? k : k - W) * fs / W; if (Math.abs(f) > half) continue; const p = re[k] * re[k] + im[k] * im[k]; sum += p;
        const p3 = p + (re[(k + 1) % W] ** 2 + im[(k + 1) % W] ** 2); if (p3 > mx) mx = p3; } rows.push([sum, mx / (sum || 1)]); }
    const th = pct(rows.map(r => r[0]), 0.4); let a = 0, c = 0; for (const [e, d] of rows) if (e >= th) { a += d; c++; } return c ? a / c : 0;
  }
  function edges6(occ) {   // Kanten eines flachen Blocks: −6 dB unter dem mittleren Pegel im Block (genauer als die Rauschschwelle)
    const { Ps, df } = occ, i0 = Math.max(1, Math.round(occ.lo / df)), i1 = Math.round(occ.hi / df), ic = Math.round(occ.center / df);
    const m = pct(Array.from(Ps.subarray(i0, i1 + 1)), 0.5) / 4;
    let a = i0, b = i1; while (a < ic && Ps[a] <= m) a++; while (b > ic && Ps[b] <= m) b--;   // von aussen nach innen (Dellen im Block stoeren nicht)
    const lo = (a - (Ps[a] - m) / ((Ps[a] - Ps[a - 1]) || 1)) * df, hi = (b + (Ps[b] - m) / ((Ps[b] - Ps[b + 1]) || 1)) * df;   // linear zwischen den Bins
    return { lo, hi, center: (lo + hi) / 2 };
  }
  function flatness(occ) {   // spektrale Flachheit im inneren Teil des belegten Bandes (1 = ganz flach)
    const { Ps, df } = occ, i0 = Math.round((occ.lo + occ.bw * 0.12) / df), i1 = Math.round((occ.hi - occ.bw * 0.12) / df); if (i1 - i0 < 10) return 0;
    let lg = 0, ar = 0; for (let i = i0; i <= i1; i++) { lg += Math.log(Ps[i] + 1e-30); ar += Ps[i]; } const n = i1 - i0 + 1; return Math.exp(lg / n) / (ar / n);
  }
  function comb(occ) {   // regelmaessige Spektrallinien im belegten Band (OFDM, Mehrton): Abstand und Deutlichkeit
    const { P, df } = occ, i0 = Math.round(occ.lo / df), i1 = Math.round(occ.hi / df); if (i1 - i0 < 60) return { v: 0 };
    const v = []; for (let i = i0; i <= i1; i++) v.push(db(P[i]));
    const R = Math.round(20 / df), d = v.map((x, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - R); k <= Math.min(v.length - 1, i + R); k++) { s += v[k]; c++; } return x - s / c; });   // Verlauf entfernen
    const e0 = d.reduce((s, x) => s + x * x, 0) || 1, ac = lag => { let s = 0; for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag]; return s / e0; };
    let best = { v: 0 };
    for (let lag = Math.max(4, Math.round(6 / df)); lag < Math.min(d.length / 4, Math.round(120 / df)); lag++) {
      const r = ac(lag); if (r <= best.v || r < ac(lag - 1) || r < ac(lag + 1)) continue;
      const r2 = ac(2 * lag); if (r2 < r * 0.4) continue;            // echtes Raster wiederholt sich
      best = { v: r, sp: lag * df, v2: r2 }; }
    if (best.sp) { let a = 0, c = 0; for (let k = -2; k <= 2; k++) { const lag = Math.round(best.sp / df) + k, r = Math.max(0, ac(lag)); a += r * lag; c += r; } if (c) best.sp = a / c * df; }
    return best;
  }
  function combAt(occ, sp) {   // Deutlichkeit eines Linienrasters mit Abstand sp (Hz) im belegten Band
    const { P, df } = occ, i0 = Math.round(occ.lo / df), i1 = Math.round(occ.hi / df); if (i1 - i0 < 3 * sp / df) return 0;
    const v = []; for (let i = i0; i <= i1; i++) v.push(db(P[i])); const R = Math.round(sp / 2 / df);
    const d = v.map((x, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - R); k <= Math.min(v.length - 1, i + R); k++) { s += v[k]; c++; } return x - s / c; });
    const e0 = d.reduce((s, x) => s + x * x, 0) || 1, ac = lag => { let s = 0; for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag]; return s / e0; };
    const L = Math.round(sp / df); let m = -1; for (let k = -2; k <= 2; k++) m = Math.max(m, ac(L + k));
    return m - Math.max(0, ac(Math.round(L / 2)));   // Peak beim Rasterabstand, nicht schon beim halben
  }
  function speechShape(occ) {   // Sprache faellt mit der Frequenz ab; steigt sie, ist das Seitenband vertauscht
    const { P, df } = occ, third = (occ.hi - occ.lo) / 3; let a = 0, b = 0;
    for (let f = occ.lo; f < occ.lo + third; f += df) a += P[Math.round(f / df)]; for (let f = occ.hi - third; f < occ.hi; f += df) b += P[Math.round(f / df)];
    return db(a / (b || 1e-12));
  }
  // Stimmhaftigkeit: Obertonreihe im Abstand der Stimmhoehe (90..320 Hz) in kurzen Spektren, Tonhoehe wandert.
  // Unabhaengig von der Empfaenger-Regelung (AGC) und von der Seitenbandlage (Spektral-Autokorrelation, kein fester Grundton).
  function voicing(x) {
    const N = 512, F = 2048, w = hann(N), re = new Float64Array(F), im = new Float64Array(F), df = FS / F, i0 = Math.round(250 / df), i1 = Math.round(2800 / df), f0s = [];
    let frames = 0, en = [];
    for (let a = 0; a + N <= x.length; a += N / 2) { let e = 0; for (let i = 0; i < N; i++) e += x[a + i] * x[a + i]; en.push(e); }
    const eth = pct(en, 0.3) * 1.5; let fi = 0;
    for (let a = 0; a + N <= x.length; a += N / 2, fi++) {
      if (en[fi] < eth) continue; frames++;
      re.fill(0); im.fill(0); for (let i = 0; i < N; i++) re[i] = x[a + i] * w[i]; fft(re, im);
      const v = []; for (let i = i0; i <= i1; i++) v.push(db(re[i] * re[i] + im[i] * im[i]));
      const R = Math.round(60 / df), d = v.map((q, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - R); k <= Math.min(v.length - 1, i + R); k++) { s += v[k]; c++; } return q - s / c; });
      const e0 = d.reduce((s2, q) => s2 + q * q, 0) || 1; let best = 0, bl = 0;
      for (let lag = Math.round(90 / df); lag <= Math.round(320 / df); lag++) { let s2 = 0; for (let i = 0; i + lag < d.length; i++) s2 += d[i] * d[i + lag]; const r = s2 / e0; if (r > best) { best = r; bl = lag; } }
      if (best > 0.3) { let s2 = 0; for (let i = 0; i + 2 * bl < d.length; i++) s2 += d[i] * d[i + 2 * bl]; if (s2 / e0 > 0.12) f0s.push(bl * df); }   // auch beim doppelten Abstand: echte Obertonreihe
    }
    if (!frames) return { frac: 0, sd: 0, f0: 0 };
    const m = mean(f0s); let v2 = 0; for (const f of f0s) v2 += (f - m) ** 2;
    return { frac: f0s.length / frames, sd: f0s.length > 2 ? Math.sqrt(v2 / f0s.length) : 0, f0: m, n: f0s.length };
  }
  function syllabic(x, occ) {   // Silbenrhythmus 2..8 Hz in der Huellkurve (20-ms-Rahmen)
    const fr = 160, e = []; for (let a = 0; a + fr <= x.length; a += fr) { let s = 0; for (let i = 0; i < fr; i++) s += x[a + i] * x[a + i]; e.push(Math.sqrt(s / fr)); }
    if (e.length < 64) return { cv: 0, mod: 0 };
    const m = mean(e); let v = 0; for (const q of e) v += (q - m) ** 2; const cv = Math.sqrt(v / e.length) / (m || 1);
    const n = pow2(e.length), re = new Float64Array(n), im = new Float64Array(n); e.forEach((q, i) => re[i] = q - m); fft(re, im);
    let lo = 0, all = 0; for (let i = 1; i < n / 2; i++) { const f = i * 50 / n, p = re[i] * re[i] + im[i] * im[i]; all += p; if (f >= 1.5 && f <= 9) lo += p; }
    return { cv, mod: lo / (all || 1) };
  }

  // ---------- 6. Probe-Dekodierung ----------
  // Wie sehr sieht ein dekodierter Text nach echtem Text aus (0..1)? Rauschen liefert zufaellige Zeichen: Woerter ohne Vokale,
  // lange Konsonantenketten, wilde Gross/Klein-Mischung, viele Einzelbuchstaben, bei CW fast nur Punkt-Zeichen (E, I, S, H).
  const KEYW = /^(CQ|DE|K|KN|SK|AR|BK|73|88|RST|TU|QSL|QTH|QRZ|QRL|QSB|QRM|QRN|NAME|TNX|TKS|UR|PSE|BTU|5NN|599|579|TEST|HW|GM|GA|GE|OP|ANT|RIG|WX|ES|FB|OM|YL|DX|PWR|LOC|DOK|ZCZC|NNNN)$/i;
  function textScore(s) {
    s = (s || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim(); const L = s.length; if (L < 4) return 0;
    const words = s.split(" ").filter(Boolean); let good = 0, all = 0, singles = 0, bonus = 0;
    for (const w of words) {
      all += w.length;
      if (w.length === 1) { singles++; if (/^[Kk?]$/.test(w)) good++; continue; }
      const letters = w.replace(/[^A-Za-z]/g, ""), vow = (letters.match(/[aeiouy]/gi) || []).length;
      const consRun = Math.max(0, ...(letters.toLowerCase().match(/[^aeiouy]+/g) || [""]).map(x => x.length));
      const call = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]{1,4})?$/i.test(w), num = /^[0-9]{1,8}[a-z]?[.,:!?]?$/i.test(w) || /^[0-9]+[.,:\/][0-9]+$/.test(w);
      const caseOk = /^[A-Z0-9\/.,?!=+'-]+$/.test(w) || /^[A-Za-z][a-z0-9.,?!'-]*$/.test(w), clean = /^[A-Za-z0-9\/.,?!'=+-]+$/.test(w);
      if (KEYW.test(w.replace(/[.,?!]$/, "")) || call) bonus++;
      if (call || num || KEYW.test(w.replace(/[.,?!]$/, "")) || (clean && caseOk && w.length <= 14 && (letters.length <= 3 ? letters.length < 3 || vow > 0 || /^[A-Z]+$/.test(letters) : vow / letters.length >= 0.2 && consRun <= 4))) good += w.length;
    }
    let sc = good / (all || 1) * (1 - Math.max(0, singles / words.length - 0.15) * 1.5);
    const up = s.replace(/[^A-Za-z]/g, "").toUpperCase(); if (up.length > 10 && (up.match(/[EISHT]/g) || []).length / up.length > 0.6) sc *= 0.35;
    return Math.max(0, Math.min(1, sc * Math.min(1, L / 25) + 0.08 * Math.min(4, bonus)));
  }
  function decodeTrial(x, mk) {   // mk(onChar) -> Dekoder mit process(); Rueckgabe: Text
    let out = ""; let rx; try { rx = mk(c => { if (typeof c === "string") out += c; }); } catch { return ""; }
    if (!rx || !rx.process) return "";
    if ("sql" in rx) rx.sql = 0.05; if ("sqlv" in rx) rx.sqlv = 0.05;
    try { for (let a = 0; a < x.length; a += 512) rx.process(x.subarray(a, Math.min(x.length, a + 512))); } catch { }
    return out;
  }
  // Dekoder aus dsp.js/dsp2.js, falls geladen (im Browser globale Klassen; ohne sie entfaellt die Probe-Dekodierung)
  const get = n => ({ Psk31Rx: typeof Psk31Rx !== "undefined" ? Psk31Rx : null, QpskRx: typeof QpskRx !== "undefined" ? QpskRx : null,
    CwRx: typeof CwRx !== "undefined" ? CwRx : null, RttyRx: typeof RttyRx !== "undefined" ? RttyRx : null,
    DIGI_MODES: typeof DIGI_MODES !== "undefined" ? DIGI_MODES : null })[n];
  const trials = {
    PSK31: f => [get("Psk31Rx") && (on => new (get("Psk31Rx"))(f, on, 31.25))],
    PSK63: f => [get("Psk31Rx") && (on => new (get("Psk31Rx"))(f, on, 62.5))],
    PSK125: f => [get("Psk31Rx") && (on => new (get("Psk31Rx"))(f, on, 125))],
    QPSK31: f => [get("QpskRx") && (on => new (get("QpskRx"))(f, on, 31.25))],
    QPSK63: f => [get("QpskRx") && (on => new (get("QpskRx"))(f, on, 62.5))],
    QPSK125: f => [get("QpskRx") && (on => new (get("QpskRx"))(f, on, 125))],
    CW: f => [get("CwRx") && (on => new (get("CwRx"))(f, on))],
  };
  const digi = id => { const M = get("DIGI_MODES"); return M && M[id] ? [on => M[id].rx(trialF, on)] : []; };
  let trialF = 1500;
  function tryDecode(x, id, f, extra = {}) {
    trialF = f;
    let makers = trials[id] ? trials[id](f).filter(Boolean) : [];
    if (id === "RTTY" && get("RttyRx")) makers = [true, false].map(mh => on => Object.assign(new (get("RttyRx"))(f, on, mh, extra.baud || 45.45, extra.shift || 170), { usos: true }));
    if (!makers.length && /^MT63-/.test(id) && !/[LS]$/.test(id)) makers = digi(id + "L").concat(digi(id + "S"));
    if (!makers.length) makers = digi(id);
    let names = null;
    if (/^Olivia /.test(id)) { names = [id, id.replace("Olivia", "Contestia")]; makers = names.flatMap(digi); }
    if (/^DominoEX /.test(id)) { names = [id, id.replace("DominoEX", "THOR")]; makers = names.flatMap(digi); }
    let best = { text: "", score: 0 };
    // Dekoder geben vor dem Einrasten Zeichensalat aus: das beste Stueck (40 Zeichen) zaehlt
    const bestPart = t => { t = t.replace(/\s+/g, " ").trim(); if (t.length <= 40) return { s: textScore(t), part: t };
      let r = { s: 0, part: "" }; for (let a = 0; a + 40 <= t.length; a += 10) { const p = t.slice(a, a + 40), v = textScore(p); if (v > r.s) r = { s: v, part: p }; } return r; };
    makers.forEach((mk, i) => { const t = decodeTrial(x, mk), b = bestPart(t); if (b.s > best.score || (!best.text && t)) best = { text: t, part: b.part, score: b.s, name: names ? names[i] : null }; });
    if (best.score < 0.6 && /^(MFSK|Olivia|Contestia)/.test(id) && !extra.retry)   // Mitte nicht genau getroffen? leicht verschoben nochmal
      for (const d of [-4, 4]) { const r = tryDecode(x, id, f + d, { ...extra, retry: true }); if (r.score > best.score) best = r; }
    return best;
  }

  // ---------- 7. Bandplan (Hinweis, kein Beweis) ----------
  const PLAN = (() => {
    const k = v => v * 1000, P = [];
    for (const f of [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 50323, 144174]) P.push(["FT8", k(f) + 100, k(f) + 3200]);
    for (const f of [3575.5, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318, 144170]) P.push(["FT4", k(f) + 100, k(f) + 3200]);
    for (const f of [474.2, 1836.6, 3568.6, 5287.2, 7038.6, 10138.7, 14095.6, 18104.6, 21094.6, 24924.6, 28124.6, 50293]) P.push(["WSPR", k(f) + 1350, k(f) + 1650]);
    for (const f of [7076, 14076, 21076, 28076]) P.push(["JT65", k(f) + 100, k(f) + 3000]);
    for (const f of [3580, 7040, 7070, 10142, 14070, 18100, 21070, 24920, 28120]) P.push(["PSK31", k(f), k(f) + 3000]);
    for (const f of [3735, 7165, 7171, 14230, 14233, 21340, 28680]) P.push(["SSTV", k(f) - 6000, k(f) + 6000]);
    for (const f of [147.3, 4583, 7646, 10100.8, 11039, 14467.3]) P.push(["RTTY", k(f) - 800, k(f) + 800, "DWD-Wetterdienst"]);
    for (const f of [490, 518, 4209.5]) P.push(["NAVTEX", k(f) - 600, k(f) + 600]);
    for (const f of [3855, 7880, 13882.5, 2618.5, 4610, 8040, 11086.5, 12750]) P.push(["FAX", k(f) - 2500, k(f) + 2500]);
    for (const f of [14100, 18110, 21150, 24930, 28200]) P.push(["CW", k(f) - 300, k(f) + 300, "NCDXF/IARU-Bake"]);
    P.push(["RTTY", k(14080), k(14099.5)], ["RTTY", k(7040), k(7050)], ["RTTY", k(3580), k(3600)], ["RTTY", k(21080), k(21100)]);
    return P.map(([id, lo, hi, note]) => ({ id, lo, hi, note }));
  })();
  const planFor = rf => rf ? PLAN.filter(p => rf >= p.lo && rf <= p.hi) : [];

  // ---------- Gesamtbewertung ----------
  const RTTY_TAB = [["RTTY", 45.45, 170, "RTTY 45 Bd / 170 Hz"], ["RTTY", 50, 450, "RTTY 50 Bd / 450 Hz (Wetterdienst)"], ["RTTY", 50, 425, "RTTY 50 Bd / 425 Hz"], ["RTTY", 50, 85, "RTTY 50 Bd / 85 Hz"],
    ["RTTY", 75, 170, "RTTY 75 Bd / 170 Hz"], ["RTTY", 50, 170, "RTTY 50 Bd / 170 Hz"], ["NAVTEX", 100, 170, "SITOR-B / NAVTEX 100 Bd"], ["RTTY", 75, 850, "RTTY 75 Bd / 850 Hz"],
    ["PACTOR", 100, 200, "PACTOR-I 100 Bd / 200 Hz"], ["PACTOR", 200, 200, "PACTOR-I 200 Bd / 200 Hz"], ["PACKET", 300, 200, "HF-Packet 300 Bd / 200 Hz"], ["PACKET", 1200, 1000, "Packet/APRS 1200 Bd (AFSK)"],
    ["RTTY", 45.45, 425, "RTTY 45 Bd / 425 Hz"], ["RTTY", 45.45, 850, "RTTY 45 Bd / 850 Hz"]];
  const NAMES = { CARRIER: "Träger (unmoduliert)", CW: "CW (Morse)", HELL: "Hellschreiber", PSK31: "PSK31", PSK63: "PSK63", PSK125: "PSK125", QPSK31: "QPSK31", QPSK63: "QPSK63", QPSK125: "QPSK125",
    FT8: "FT8", FT4: "FT4", WSPR: "WSPR", JT9: "JT9", JT65: "JT65", SSTV: "SSTV", FAX: "Wetterfax (HF-FAX)", VOICE: "Sprache (SSB)", VOICE_INV: "Sprache – anderes Seitenband", FREEDV: "FreeDV (digitale Sprache)",
    AM: "AM (Träger + Seitenband)", OFDM: "Mehrträger-Digital (OFDM)", NOISE: "kein Signal erkennbar", UNKNOWN: "unbekanntes Signal", ALE: "ALE (2G, 8-FSK)" };

  // Sprache (SSB): unterste und oberste belegte Tonfrequenz – daraus ergibt sich die Lage des unterdrueckten Traegers
  // (Seitenband liegt etwa 300..2700 Hz neben dem Traeger; die Mitte des Signals ist bei SSB nicht der Abstimmpunkt)
  function voiceEdges(occ) {   // Schwelle: 20 dB unter dem Sprachpegel (mind. 5 dB ueber dem Rauschen)
    const { P, df, floor } = occ, Pw = smooth(P, Math.round(40 / df)), mid = [];
    for (let i = Math.round(300 / df); i < Math.round(3300 / df); i++) mid.push(Pw[i]);
    const thr = Math.max(floor * 3, pct(mid, 0.9) * 0.01), run = Math.round(60 / df), i0 = Math.round(80 / df), i1 = Math.round(3800 / df);
    let lo = 0, hi = 0;
    for (let i = i0; i <= i1 - run; i++) { let k = 0; while (k < run && Pw[i + k] > thr) k++; if (k === run) { lo = i * df; break; } }
    for (let i = i1; i >= i0 + run; i--) { let k = 0; while (k < run && Pw[i - k] > thr) k++; if (k === run) { hi = i * df; break; } }
    return lo && hi > lo ? { vlo: Math.round(lo), vhi: Math.round(hi) } : {};
  }
  // x: Float32Array (8 kHz), opts: { fc: Tonfrequenz des Signals, inverted: LSB-Lage, rf: Hochfrequenz des Signals (Hz), decode: true }
  function analyze(x, opts = {}) {
    const t0 = Date.now(), fc = opts.fc || 1500, secs = x.length / FS, C = []; bbCache = { x, m: new Map() };
    const add = (id, label, score, extra = {}) => C.push({ id, label: label || NAMES[id] || id, score: Math.max(0, Math.min(1, score)), ...extra });
    const occ = occupancy(x, fc);
    const res = { secs, center: occ.center, bw: occ.bw, snr: occ.snr, peak: occ.peak };
    if (occ.snr < 6 && !(occ.wide.excess > 2 && occ.wide.bw > 150)) { add("NOISE", null, 1); return finish(); }
    // Schmale Traegersignale
    const narrowHalf = Math.max(60, Math.min(400, occ.bw / 2 + 40));
    const bbN = baseband(x, occ.peak, narrowHalf);
    const L1 = line(bbN, 1), L2 = line(bbN, 2), L4 = line(bbN, 4), K0 = keyed(bbN);
    const K = occ.bw < 120 && K0.ratio < 8 ? (() => { const k2 = keyed(baseband(x, occ.peak + L1.f, 25), 4); return k2.ratio > K0.ratio ? k2 : K0; })() : K0;   // schwaches CW: schmaler filtern
    Object.assign(res, { l1: L1.ratio, l2: L2.ratio, l4: L4.ratio, keyRatio: K.ratio, duty: K.duty, dot: K.dot });
    const sidebands = occ.wide.bw > 400 && occ.wide.excess > 1 && occ.wide.lo < occ.peak - 150 && occ.wide.hi > occ.peak + 150;
    if (L1.ratio > 0.55 && K.ratio < 2.5 && occ.bw < 60) {
      if (sidebands) add("AM", "AM (Träger + Seitenbänder)", 0.6 + Math.min(0.3, L1.ratio * 0.3), { center: occ.peak + L1.f });
      else add("CARRIER", null, 0.6 + L1.ratio * 0.4, { center: occ.peak + L1.f }); }
    if (K.ratio > 4 && K.duty > 0.08 && K.duty < 0.85 && K.nOn >= 4 && occ.bw < 400) {
      if (K.dot >= 5 && K.dot < 16 && K.quant > 0.35 && occ.bw > 100 && occ.bw < 450 && K.nOn > secs * 6) add("HELL", "Hellschreiber (Feld-Hell)", 0.55 + Math.min(0.3, K.nOn / 400), { center: occ.peak, decode: "Hell" });
      else if (K.dot >= 14 && occ.bw < 200) { const wpm = Math.round(1200 / K.dot); add("CW", `CW (Morse) · ca. ${wpm} WPM`, 0.55 + Math.min(0.35, (K.ratio - 4) / 40) + (L2.ratio > 0.3 ? 0.05 : 0), { center: occ.peak + L1.f, wpm, decode: "CW" }); }
    }
    if (occ.bw < 450) {
      const er = envRate(bbN, [31.25, 62.5, 125, 250]);
      if (L2.ratio > 0.25 && L2.ratio > L1.ratio * 1.2) {
        const id = { 31.25: "PSK31", 62.5: "PSK63", 125: "PSK125", 250: "PSK250" }[er.r] || "PSK";
        add(id, er.v > 6 ? id : "BPSK", 0.45 + Math.min(0.35, L2.ratio * 0.5) + (er.v > 6 ? 0.1 : 0), { center: occ.peak + L2.f, baud: er.r, decode: er.v > 6 ? id : null });
        const qid = { 31.25: "QPSK31", 62.5: "QPSK63", 125: "QPSK125" }[er.r];   // QPSK sendet im Leerlauf dasselbe Muster wie BPSK
        if (qid && er.v > 6) add(qid, null, 0.4 + Math.min(0.3, L2.ratio * 0.4), { center: occ.peak + L2.f, baud: er.r, decode: qid });
      } else if (L4.ratio > 0.2 && L4.ratio > L2.ratio * 2) {
        const id = { 31.25: "QPSK31", 62.5: "QPSK63", 125: "QPSK125" }[er.r] || "QPSK";
        add(id, null, 0.45 + Math.min(0.3, L4.ratio * 0.5) + (er.v > 6 ? 0.1 : 0), { center: occ.peak + L4.f, baud: er.r, decode: er.v > 6 ? id : null });
      }
    }
    // FT8 / FT4
    if (secs >= 4) for (const name of ["FT8", "FT4"]) {
      const c = costas(x, fc, name, !!opts.inverted);
      res["sync" + name] = c;
      const need = name === "FT8" ? 0.62 : 0.8;   // Zufall: 1/8 bzw. 1/4 Treffer; dazu Energie auf den Block begrenzt
      if (c.q > need && c.r > 2.5 && c.conf > 1.5) add(name, null, Math.min(0.98, 0.55 + (c.q - need) * 0.8 + Math.min(0.1, (c.r - 2.5) * 0.03)), { center: c.f + FT[name].sp * (FT[name].n - 1) / 2, dt: c.dt, arrays: c.arrays });
    }
    // Zwei-Ton-FSK
    let twoTone = false;
    {
      const F = fsk2(x, occ);
      if (F && F.share > 0.78 && F.balance > 0.3) { twoTone = true;
        res.fsk = F; let best = null;
        for (const [id, b, s, label] of RTTY_TAB) { const e = Math.abs(Math.log(F.shift / s)) * 2 + (F.baud ? Math.abs(Math.log(F.baud / b)) : 0.3); if (!best || e < best.e) best = { id, b, s, label, e }; }
        const ok = best && Math.abs(F.shift - best.s) / best.s < 0.18 && F.baud && Math.abs(F.baud - best.b) / best.b < 0.12;
        const label = ok ? best.label : `FSK · Shift ${Math.round(F.shift)} Hz · ${F.baud ? Math.round(F.baud * 10) / 10 + " Bd" : "Baud ?"}`;
        add(ok ? best.id : "FSK", label, 0.5 + Math.min(0.3, (F.share - 0.78) * 1.5) + (ok ? 0.12 : 0),
          { center: (F.lowTone + F.highTone) / 2, shift: ok ? best.s : Math.round(F.shift), baud: ok ? best.b : F.baud, decode: ok && best.id === "RTTY" ? "RTTY" : null });
      }
    }
    // Mehrton-FSK
    if (occ.bw > 3 && occ.bw < 2300 && secs >= 3) {
      const mc = occ.bw > 60 ? edges6(occ).center : occ.center;   // Blockmitte: Olivia/MFSK-Dekoder brauchen sie auf ±5 Hz
      for (const H of MFSK) { if (H.id === "FT8" || H.id === "FT4") continue; const span = H.n * H.sp;
        if (span > occ.bw * 1.7 + 20 || span < occ.bw * 0.5 - 20) continue; if (1 / H.baud > secs / 6) continue;
        const s = mfskScore(x, occ, H); if (!s) continue;
        let sc = s.score; if (H.ifk && s.rep > 0.15) sc *= 0.5; if (H.ifk && s.rep < 0.03 && s.used >= 12) sc *= 1.4;
        if (sc > 0.18) add(H.id, H.id.startsWith("Olivia") ? H.id.replace("Olivia", "Olivia/Contestia") : null, 0.25 + sc * 0.8,
          { center: mc, decode: /^(MFSK|Olivia|DominoEX)/.test(H.id) ? H.id : null, mfsk: s });
      }
    }
    // Breite Signale
    if (occ.bw > 500) {
      const dom = dominance(x, occ), flat = flatness(occ), vo = voicing(x); Object.assign(res, { dom, flat, voice: vo });
      const S = dom > 0.3 && !twoTone ? sstv(x, occ, !!opts.inverted) : null;   // SSTV/Fax: ein einzelner FM-Ton (nicht zwei feste Toene wie RTTY)
      if (S && S.score > 0.25) add("SSTV", `SSTV${S.mode ? " · " + S.mode : ""}`, 0.5 + Math.min(0.45, S.score * 0.6), { sstvMode: S.mode, offset: S.offset });
      const F = dom > 0.3 && !twoTone ? fax(x, occ) : { score: 0 };
      if (F.score > 0.35) add("FAX", `Wetterfax · ${F.lpm} U/min`, 0.45 + Math.min(0.4, F.score * 0.5), { lpm: F.lpm });
      const cb = comb(occ), sy = syllabic(x, occ);
      Object.assign(res, { comb: cb, syl: sy });
      if (dom < 0.25 && flat > 0.3 && sy.cv < 0.45 && !(vo.frac > 0.2 && vo.sd > 8)) {   // viele Traeger gleichzeitig, flaches Spektrum, ruhige Huellkurve
        const e6 = edges6(occ), bw6 = e6.hi - e6.lo; res.e6bw = bw6;
        const c31 = combAt(occ, 31.25), c62 = combAt(occ, 62.5), c75 = combAt(occ, 75); Object.assign(res, { c31, c62, c75 });
        // FreeDV: Linienraster (700D: 31,25/62,5 Hz; 700E: 75 und 62,5 Hz; 1600: 75 Hz); MT63: ohne Raster, sehr flach
        const fd = bw6 > 600 && bw6 < 1800 && (c31 > 0.25 && c62 > 0.2 ? "700D" : c75 > 0.4 && c62 > 0.4 ? "700E" : c75 > 0.4 ? "1600" : null);
        const mt = !fd && flat >= 0.8 && [[500, "MT63-500"], [1000, "MT63-1K"], [2000, "MT63-2K"]].find(([bw]) => near(bw6, bw, 0.045));
        if (mt) add("MT63", mt[1], 0.55 + Math.min(0.25, flat * 0.25), { decode: mt[1], center: e6.center });
        if (fd) add("FREEDV", "FreeDV " + fd, 0.7, { center: e6.center, freedv: fd });
        if (bw6 < 2400) add("OFDM", `Mehrträger-Digital (OFDM) · ${Math.round(bw6)} Hz`, (mt || fd ? 0.4 : 0.45) + Math.min(0.2, flat * 0.2), { center: e6.center });
      }
      const shape = speechShape(occ); res.shape = shape;
      const voiced = vo.frac > 0.15 && vo.frac < 0.95 && vo.sd > 8 && vo.n >= 8;   // Sprache: stimmhafte Abschnitte mit wandernder Tonhoehe
      if (occ.bw > 600 && dom < 0.5 && (voiced || (sy.cv > 0.45 && sy.mod > 0.12 && occ.bw > 800))) add(shape < -6 ? "VOICE_INV" : "VOICE", null, 0.5 + (voiced ? Math.min(0.3, vo.frac * 0.6) : 0) + Math.min(0.15, sy.mod * 0.3), { shape, f0: Math.round(vo.f0), ...voiceEdges(occ) });
      if (L1.ratio > 0.4 && K.ratio < 2.5) add("AM", "AM (Träger + Seitenbänder)", 0.5 + Math.min(0.35, L1.ratio * 0.4), { center: occ.peak + L1.f });
    }
    return finish();

    function finish() {
      // Bandplan als Zusatz
      const plan = planFor(opts.rf); res.plan = plan.map(p => p.id + (p.note ? " (" + p.note + ")" : ""));
      for (const c of C) if (plan.some(p => p.id === c.id || (p.id === "PSK31" && /PSK/.test(c.id)))) { c.score = Math.min(1, c.score + 0.08); c.planOk = true; }
      C.sort((a, b) => b.score - a.score);
      // Probe-Dekodierung der besten Textkandidaten
      if (opts.decode !== false) {
        const fam = c => c.decode.replace(/[ -].*$/, ""), seen = new Set(), pick = [];
        for (const c of C) if (c.decode && c.score >= 0.3 && !seen.has(fam(c))) { seen.add(fam(c)); pick.push(c); }
        const per = {}; pick.forEach(c => per[fam(c)] = 1);
        for (const c of C) if (c.decode && c.score >= 0.3 && !pick.includes(c) && pick.length < 7 && (per[fam(c)] || 0) < (fam(c) === "Olivia" ? 4 : 3)) { pick.push(c); per[fam(c)] = (per[fam(c)] || 0) + 1; }
        for (const c of pick.slice(0, 7)) {
          const f = c.center || occ.center, r = tryDecode(x, c.decode, f, { baud: c.baud, shift: c.shift });
          c.text = (r.score > 0.6 ? r.part : r.text.replace(/\s+/g, " ").trim().slice(-160)) || ""; c.textScore = r.score;
          if (r.name && r.score > 0.6) { c.id = r.name; c.label = r.name; c.decode = r.name; }   // z. B. Contestia statt Olivia, THOR statt DominoEX
          const long = c.text.length >= 15;
          if (r.score > 0.75 && long) c.score = Math.min(1, c.score + 0.3); else if (r.score > 0.6 && long) c.score = Math.min(1, c.score + 0.15);
          else if (c.mfsk || r.text.length > 20) c.score *= c.mfsk ? 0.75 : 0.85; }   // Mehrton-Vermutung ohne lesbaren Text: abwerten
        C.sort((a, b) => b.score - a.score);
      }
      if (!C.length || C[0].score < 0.4) C.unshift({ id: "UNKNOWN", label: `${NAMES.UNKNOWN} · ${Math.round(occ.bw)} Hz breit`, score: 0.3 });
      Object.assign(res, { best: C[0], cands: C.slice(0, 5), ms: Date.now() - t0 });
      return res;
    }
  }
  // Analoges FM (Ton nach dem FM-Demodulator): CTCSS-Unterton (Goertzel ueber die 50 Normtoene), Pegel, Rauschanteil.
  // Die Art des Inhalts (Sprache, Packet, Daten) bestimmt analyze() wie bei Kurzwelle.
  const CTCSS = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 150.0,
    151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
  function fmTones(x) {
    const n = Math.min(x.length, FS * 6), g = f => { const w = 2 * Math.cos(2 * Math.PI * f / FS); let s1 = 0, s2 = 0; for (let i = 0; i < n; i++) { const s0 = x[i] + w * s1 - s2; s2 = s1; s1 = s0; } return (s1 * s1 + s2 * s2 - w * s1 * s2) / n / n; };
    let e = 0; for (let i = 0; i < n; i++) e += x[i] * x[i]; const rms = Math.sqrt(e / (n || 1));
    // Unterton: deutlich ueber den Nachbarfrequenzen (+-4 Hz, ausserhalb der Normtoene) und ueber dem Grundpegel des Bereichs 60..260 Hz
    let best = null;
    for (const f of CTCSS) { const p = g(f), side = (g(f - 3.1) + g(f + 3.1)) / 2; const r = p / (side || 1e-20); if (r > 12 && p > e / n * 0.0005 && (!best || p > best.p)) best = { f, p, r }; }
    return { rms, ctcss: best ? best.f : null, ctcssDb: best ? Math.round(10 * Math.log10(best.r)) : 0 };
  }
  return { analyze, fmTones, CTCSS, fft, textScore, psd, baseband, costas, occupancy, FS, MFSK, PLAN, planFor };
})();
if (typeof module !== "undefined") module.exports = SIGID;
