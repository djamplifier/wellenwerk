"use strict";
// Wellenwerk – APRS / Packet-Radio selbst dekodieren: AFSK 1200 Bd (Bell 202, 1200/2200 Hz) im FM-Ton, HDLC, AX.25, APRS.
// Drei Pegelgewichtungen Mark/Space parallel (FM-Deemphasis und Funkgeraete daempfen 2200 Hz unterschiedlich stark), jede mit
// eigenem Takt und HDLC-Rahmen; doppelte Rahmen werden zusammengefasst. Laeuft im Browser auf dem Ton jeder Quelle.
const APRS = (() => {
  // ---------- CRC-16 (X.25 / HDLC FCS) ----------
  function fcs(b, n) { let c = 0xffff; for (let i = 0; i < n; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; } return (c ^ 0xffff) & 0xffff; }

  // ---------- Demodulator ----------
  function Demod(fs, onFrame, opt = {}) {
    const L = Math.max(4, Math.round(fs / 1200 * (opt.win || 1))), wm = 2 * Math.PI * 1200 / fs, ws = 2 * Math.PI * 2200 / fs;
    const buf = { mr: new Float64Array(L), mi: new Float64Array(L), sr: new Float64Array(L), si: new Float64Array(L) };
    let n = 0, smr = 0, smi = 0, ssr = 0, ssi = 0, agc = 1e-6;
    const slicers = (opt.gains || [0.5, 1, 2]).map(g => ({ g, lp: 0, ph: 0, last: 0, prev: 0, sh: 0, ones: 0, bits: [], inFrame: false }));
    const seen = new Map();
    function bit(s, b) {                                    // NRZI-dekodiertes Bit in den HDLC-Rahmen
      s.sh = ((s.sh << 1) | b) & 0xff;
      if (s.sh === 0x7e) {                                  // Flagge: Rahmen abschliessen, neuen beginnen
        if (s.inFrame && s.bits.length >= 8 * 18) frame(s.bits.slice(0, s.bits.length - 7));
        s.bits = []; s.ones = 0; s.inFrame = true; return;
      }
      if (!s.inFrame) return;
      if (b) { if (++s.ones > 6) { s.inFrame = false; s.bits = []; return; } s.bits.push(1); }   // mehr als 6 Einsen: Abbruch
      else { if (s.ones === 5) { s.ones = 0; return; } s.ones = 0; s.bits.push(0); }          // nach 5 Einsen eingefuegte Null weglassen
      if (s.bits.length > 8 * 340) { s.inFrame = false; s.bits = []; }
    }
    function frame(bits) {
      const nb = bits.length >> 3; if (nb < 18) return;
      const b = new Uint8Array(nb); for (let i = 0; i < nb; i++) { let v = 0; for (let k = 0; k < 8; k++) v |= bits[i * 8 + k] << k; b[i] = v; }
      if (fcs(b, nb - 2) !== (b[nb - 2] | (b[nb - 1] << 8))) return;
      const key = Array.from(b.subarray(0, nb - 2)).join(","), now = n;
      if (seen.has(key) && now - seen.get(key) < fs * 2) return;   // dieselbe Aussendung aus mehreren Zweigen
      seen.set(key, now); if (seen.size > 50) seen.delete(seen.keys().next().value);
      onFrame(b.subarray(0, nb - 2));
    }
    return {
      process(x) {
        for (let i = 0; i < x.length; i++, n++) {
          const v = x[i], k = n % L;
          const a = v * Math.cos(wm * n), c = -v * Math.sin(wm * n), d = v * Math.cos(ws * n), e = -v * Math.sin(ws * n);
          smr += a - buf.mr[k]; smi += c - buf.mi[k]; ssr += d - buf.sr[k]; ssi += e - buf.si[k];
          buf.mr[k] = a; buf.mi[k] = c; buf.sr[k] = d; buf.si[k] = e;
          const em = smr * smr + smi * smi, es = ssr * ssr + ssi * ssi;
          agc = Math.max(agc * 0.9995, em + es, 1e-9);
          for (const s of slicers) {
            s.lp += (opt.lp || 0.5) * ((em - s.g * es) / agc - s.lp);
            const sym = s.lp > 0 ? 1 : 0;
            if (sym !== s.last) { s.ph += (0.5 - s.ph) * (opt.pll || 0.4); s.last = sym; }     // Wechsel gehoeren in die Bitmitte des Taktes -> Abtasten in der Mitte des Bits
            s.ph += 1200 / fs;
            if (s.ph >= 1) { s.ph -= 1; bit(s, sym === s.prev ? 1 : 0); s.prev = sym; }                     // NRZI
          }
        }
      },
    };
  }

  // ---------- AX.25 ----------
  function addr(b, o) { let c = ""; for (let i = 0; i < 6; i++) c += String.fromCharCode(b[o + i] >> 1); c = c.trim(); const ssid = (b[o + 6] >> 1) & 15; return { call: ssid ? `${c}-${ssid}` : c, last: b[o + 6] & 1, h: (b[o + 6] & 0x80) !== 0 }; }
  function ax25(b) {
    const dst = addr(b, 0), src = addr(b, 7), path = []; let o = 14, last = src.last;
    while (!last && o + 7 <= b.length && path.length < 8) { const a = addr(b, o); path.push(a.call + (a.h ? "*" : "")); last = a.last; o += 7; }
    if (o + 2 > b.length) return null;
    const ctl = b[o], pid = b[o + 1]; o += 2;
    let info = ""; for (let i = o; i < b.length; i++) info += String.fromCharCode(b[i]);
    return { source: src.call, destination: dst.call, path, ctl, pid, info };
  }

  // ---------- APRS ----------
  const b91 = s => { let v = 0; for (const ch of s) v = v * 91 + (ch.charCodeAt(0) - 33); return v; };
  function uncompressed(s) {   // "4903.50N/07201.75W>"
    const m = /^(\d{2})([\d ]{2}\.[\d ]{2})([NS])(.)(\d{3})([\d ]{2}\.[\d ]{2})([EW])(.)/.exec(s); if (!m) return null;
    const lat = (+m[1] + parseFloat(m[2].replace(/ /g, "0")) / 60) * (m[3] === "S" ? -1 : 1), lon = (+m[5] + parseFloat(m[6].replace(/ /g, "0")) / 60) * (m[7] === "W" ? -1 : 1);
    return { lat, lon, symbol: m[4] + m[8], rest: s.slice(19) };
  }
  function compressed(s) {     // "/5L!!<*e7>7P[" Symboltabelle, 4+4 Base91, Symbol
    if (s.length < 13 || !/^[\/\\A-Za-j0-9]/.test(s)) return null;
    const lat = 90 - b91(s.slice(1, 5)) / 380926, lon = -180 + b91(s.slice(5, 9)) / 190463;
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return { lat, lon, symbol: s[0] + s[9], rest: s.slice(13) };
  }
  function micE(dst, info) {   // Breite im Ziel-Rufzeichen, Laenge in den Info-Bytes 1..3
    const d = dst.split("-")[0].padEnd(6, " "); if (d.length < 6) return null;
    const dig = c => /[0-9]/.test(c) ? +c : /[A-J]/.test(c) ? c.charCodeAt(0) - 65 : /[P-Y]/.test(c) ? c.charCodeAt(0) - 80 : (c === "K" || c === "L" || c === "Z") ? 0 : null;
    const ds = [...d.slice(0, 6)].map(dig); if (ds.some(v => v == null)) return null;
    let lat = ds[0] * 10 + ds[1] + (ds[2] * 10 + ds[3] + (ds[4] * 10 + ds[5]) / 100) / 60;
    if (!/[P-Z]/.test(d[3])) lat = -lat;                                  // Nord/Sued
    const off = /[P-Z]/.test(d[4]) ? 100 : 0, west = /[P-Z]/.test(d[5]);
    let lon = info.charCodeAt(1) - 28 + off; if (lon >= 180 && lon <= 189) lon -= 80; else if (lon >= 190 && lon <= 199) lon -= 190;
    let mm = info.charCodeAt(2) - 28; if (mm >= 60) mm -= 60;
    const hh = info.charCodeAt(3) - 28;
    lon = (lon + (mm + hh / 100) / 60) * (west ? -1 : 1);
    const sp = (info.charCodeAt(4) - 28) * 10 + Math.floor((info.charCodeAt(5) - 28) / 10), cs = ((info.charCodeAt(5) - 28) % 10) * 100 + info.charCodeAt(6) - 28;
    return { lat, lon, symbol: info[8] + info[7], speed: sp >= 800 ? sp - 800 : sp, course: cs >= 400 ? cs - 400 : cs, rest: info.slice(9) };
  }
  function aprs(f) {
    const o = { source: f.source, destination: f.destination, path: f.path.join(","), raw: f.info };
    let s = f.info, p = null; const t = s[0];
    if (t === "!" || t === "=") p = uncompressed(s.slice(1)) || compressed(s.slice(1));
    else if (t === "/" || t === "@") p = uncompressed(s.slice(8)) || compressed(s.slice(8));
    else if (t === "`" || t === "'") p = micE(f.destination, s);
    else if (t === ";") { o.object = s.slice(1, 10).trim(); p = uncompressed(s.slice(18)) || compressed(s.slice(18)); }
    else if (t === ")") { const m = /^\)([^!_]{3,9})[!_](.*)$/.exec(s); if (m) { o.object = m[1]; p = uncompressed(m[2]) || compressed(m[2]); } }
    else if (t === ":") { const m = /^:([^:]{9}):(.*)$/.exec(s); if (m) { o.to = m[1].trim(); o.message = m[2]; } }
    else if (t === ">") o.status = s.slice(1);
    else if (t === "_") o.weather = s.slice(1);
    if (p) { Object.assign(o, { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), symbol: p.symbol }); if (p.speed != null) Object.assign(o, { speed: p.speed, course: p.course }); o.comment = (p.rest || "").replace(/[\x00-\x1f]/g, " ").trim(); }
    else if (!o.message && !o.status && !o.weather) o.comment = s.replace(/[\x00-\x1f]/g, " ").trim();
    // Wetterdaten im Kommentar (Wind _ccc/sss gGGG tTTT rRRR hHH bBBBBB)
    const w = /(\d{3})\/(\d{3})g(\d{3})t(-?\d{2,3})(?:r(\d{3}))?.*?(?:h(\d{2}))?(?:b(\d{5}))?/.exec(o.comment || o.weather || "");
    if (w) Object.assign(o, { wind_dir: +w[1], wind_mph: +w[2], gust_mph: +w[3], temperature_C: +((+w[4] - 32) * 5 / 9).toFixed(1), humidity: w[6] != null ? +w[6] || 100 : undefined, pressure_hPa: w[7] ? +w[7] / 10 : undefined });
    return o;
  }

  // Empfaenger: Ton (beliebige Rate) -> Meldungen {source, destination, path, lat, lon, comment, message ...}
  function Rx(fs, onPacket, opt) { return Demod(fs, b => { const f = ax25(b); if (f && f.ctl === 0x03) onPacket(aprs(f)); else if (f) onPacket({ source: f.source, destination: f.destination, path: f.path.join(","), comment: f.info.replace(/[\x00-\x1f]/g, " ").trim() }); }, opt); }

  // Sender (fuer Tests): AX.25-UI-Rahmen -> AFSK-Ton
  function encode(src, dst, path, info, fs = 8000) {
    const ad = (c, last) => { const [cs, ss] = c.split("-"); const o = []; for (let i = 0; i < 6; i++) o.push((cs.charCodeAt(i) || 32) << 1); o.push(0x60 | ((+ss || 0) << 1) | (last ? 1 : 0)); return o; };
    const all = [dst, src, ...path], bytes = []; all.forEach((c, i) => bytes.push(...ad(c, i === all.length - 1)));
    bytes.push(0x03, 0xf0); for (const ch of info) bytes.push(ch.charCodeAt(0) & 0xff);
    const crc = fcs(Uint8Array.from(bytes), bytes.length); bytes.push(crc & 0xff, crc >> 8);
    const bits = []; const flag = () => { for (let k = 0; k < 8; k++) bits.push((0x7e >> k) & 1); };
    for (let i = 0; i < 25; i++) flag();
    let ones = 0; for (const b of bytes) for (let k = 0; k < 8; k++) { const v = (b >> k) & 1; bits.push(v); if (v) { if (++ones === 5) { bits.push(0); ones = 0; } } else ones = 0; }
    for (let i = 0; i < 3; i++) flag();
    let tone = 1, ph = 0; const out = [], spb = fs / 1200; let acc = 0;
    for (const v of bits) { if (!v) tone ^= 1; acc += spb; const ns = Math.round(acc); acc -= ns; for (let i = 0; i < ns; i++) { ph += 2 * Math.PI * (tone ? 1200 : 2200) / fs; out.push(0.5 * Math.sin(ph)); } }
    return Float32Array.from(out);
  }
  return { Rx, Demod, ax25, aprs, encode, fcs };
})();
if (typeof module !== "undefined") module.exports = APRS;
