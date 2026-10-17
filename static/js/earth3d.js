"use strict";
// Wellenwerk – Erde in 3D: fotorealistische Darstellung aus NASA-Satellitenbildern (Blue Marble bei Tag, Black Marble bei Nacht)
// mit Tag-/Nachtgrenze, leuchtender Graulinie, Meeresglanz, Atmosphaere und Sternen – berechnet im WebGL-Shader.
// Drei Ansichten: "globe" (Kugel, ziehen dreht), "flat" (Weltkarte, ziehen verschiebt), "azi" (Peilkarte um den eigenen Standort).
// Darueber eine Leuchtschicht (Canvas 2D) mit Gitter, Grenzen, Punkten, Grosskreisboegen und eigenen Zeichnungen (opts.draw).
//   const E = wwEarth(el, { mode, center: [lat, lon], zoom, terminator, grid: "latlon" | "maiden" | "", borders, hud, modes, onClick, onHover, draw });
//   E.set({ ... }); E.points = [{ lat, lon, color, r, label, data }]; E.arcs = [{ from: [lat, lon], to: [lat, lon], color, flow }]; E.redraw(); E.destroy();
const EARTH = { img: null, loading: null, borders: null };
function earthTextures() {
  if (EARTH.loading) return EARTH.loading;
  const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  EARTH.loading = Promise.all([load("/static/vendor/earth/day.jpg"), load("/static/vendor/earth/night.jpg")]).then(([day, night]) => (EARTH.img = { day, night }));
  return EARTH.loading;
}
async function earthBorders() {
  if (EARTH.borders) return EARTH.borders;
  if (!window.topojson) await loadScript("/static/vendor/topojson-client.min.js");
  const w = await (await fetch("/static/vendor/countries-110m.json")).json();
  const m = topojson.mesh(w, w.objects.countries);           // Grenzen und Kuesten als Linien [lon, lat]
  EARTH.borders = m.coordinates.map(line => line.map(([lon, lat]) => [lat, lon]));
  return EARTH.borders;
}
const EARTH_FS = `precision highp float;
uniform sampler2D uDay, uNight; uniform vec2 uRes; uniform float uMode, uZoom, uTerm, uTime, uPix;
uniform vec3 uE, uN, uF, uSun; uniform vec2 uCenter, uPan;
varying vec2 vUv;
const float PI = 3.14159265;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 space(vec2 fc) {                                          // Sternenhimmel mit leichtem Nebel
  vec2 c = fc / uRes - .5; vec3 col = mix(vec3(.004, .012, .03), vec3(.01, .03, .07), smoothstep(.9, 0., length(c)));
  float h = hash(floor(fc / (1.6 * uPix))); if (h > .9965) col += vec3(.75, .85, 1.) * (h - .9965) * 260. * (.6 + .4 * sin(uTime * 2. + h * 50.));
  return col;
}
vec3 surface(vec3 P, vec3 nView, bool globe) {
  float lat = asin(clamp(P.z, -1., 1.)), lon = atan(P.y, P.x);
  vec2 tc = vec2((lon + PI) / (2. * PI), (PI / 2. - lat) / PI);
  vec3 day = texture2D(uDay, tc).rgb, night = texture2D(uNight, tc).rgb;
  float d = dot(P, uSun);
  float t = uTerm > .5 ? smoothstep(-.1, .1, d) : 1.;
  float lit = globe ? .25 + .85 * clamp(d * 1.4 + .25, 0., 1.) : .55 + .5 * clamp(d * 1.4 + .2, 0., 1.);
  vec3 dcol = pow(day, vec3(.92)) * (uTerm > .5 ? lit : 1.05);
  float lum = dot(night, vec3(.299, .587, .114));
  vec3 ncol = night * .55 + vec3(1., .78, .45) * smoothstep(.22, .7, lum) * 1.4;   // Stadtlichter warm leuchtend
  vec3 col = mix(ncol, dcol, t);
  if (uTerm > .5) col += vec3(1., .5, .18) * exp(-pow(d / .05, 2.)) * .5;           // Graulinie
  if (globe) {
    float water = smoothstep(.04, .18, day.b - max(day.r, day.g));
    vec3 sv = vec3(dot(uSun, uE), dot(uSun, uN), dot(uSun, uF)), h = normalize(sv + vec3(0., 0., 1.));
    col += vec3(.9, .95, 1.) * pow(max(dot(nView, h), 0.), 70.) * water * t * .7;
    float rim = pow(1. - nView.z, 2.6);
    col += vec3(.25, .65, 1.) * rim * (.25 + .9 * clamp(d + .35, 0., 1.)) * .9;
  }
  return mix(col, col * vec3(.86, 1., 1.12), .22);            // leicht kuehler, "holografischer" Ton
}
void main() {
  vec2 fc = vUv * uRes; float asp = uRes.x / uRes.y;
  vec2 p = (vUv * 2. - 1.) * vec2(asp, 1.);
  vec3 col; float a = 1.;
  if (uMode < .5) {                                            // Globus
    float R = .86 * uZoom; vec2 q = p / R; float r2 = dot(q, q);
    if (r2 <= 1.) { vec3 n = vec3(q, sqrt(1. - r2)); vec3 P = n.x * uE + n.y * uN + n.z * uF; col = surface(P, n, true); }
    else { float r = sqrt(r2); vec3 bg = space(fc); float halo = exp(-(r - 1.) * 22.);
      vec2 qn = q / r; vec3 Pe = qn.x * uE + qn.y * uN; float sd = clamp(dot(Pe, uSun) + .4, 0., 1.);
      col = bg + vec3(.25, .62, 1.) * halo * (.25 + .9 * sd) * .85; }
  } else if (uMode < 1.5) {                                    // Weltkarte (plattkarte)
    float k = max(PI / asp, PI / 2.) / uZoom;
    float lon = uCenter.y + uPan.x + p.x * k, lat = uCenter.x + uPan.y + p.y * k;
    if (abs(lat) > PI / 2.) col = space(fc);
    else { lon = mod(lon + PI, 2. * PI) - PI; vec3 P = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)); col = surface(P, vec3(0., 0., 1.), false); }
  } else {                                                     // Peilkarte (mittabstandstreu um den Standort)
    float R = .92 * uZoom; float rho = length(p) / R * PI;
    if (rho > PI) { col = space(fc); float e = exp(-(length(p) / R - 1.) * 40.); col += vec3(.2, .6, 1.) * e * .5; }
    else { float az = atan(p.x, p.y), la0 = uCenter.x, lo0 = uCenter.y;
      float lat = asin(sin(la0) * cos(rho) + cos(la0) * sin(rho) * cos(az));
      float lon = lo0 + atan(sin(az) * sin(rho) * cos(la0), cos(rho) - sin(la0) * sin(lat));
      vec3 P = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)); col = surface(P, vec3(0., 0., 1.), false);
      col *= .82 + .18 * smoothstep(PI, PI * .6, rho); }
  }
  gl_FragColor = vec4(col, a);
}`;
const EARTH_VS = `attribute vec2 aP; varying vec2 vUv; void main() { vUv = aP * .5 + .5; gl_Position = vec4(aP, 0., 1.); }`;
const RAD = Math.PI / 180;
function ecef(lat, lon) { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; }
function gcPoints(a, b, n = 64) {                              // Grosskreis zwischen zwei Punkten
  const A = ecef(a[0], a[1]), Bv = ecef(b[0], b[1]), d = Math.acos(Math.max(-1, Math.min(1, A[0] * Bv[0] + A[1] * Bv[1] + A[2] * Bv[2])));
  if (d < 1e-6) return [a, b];
  const out = []; for (let i = 0; i <= n; i++) { const f = i / n, s1 = Math.sin((1 - f) * d) / Math.sin(d), s2 = Math.sin(f * d) / Math.sin(d);
    const x = s1 * A[0] + s2 * Bv[0], y = s1 * A[1] + s2 * Bv[1], z = s1 * A[2] + s2 * Bv[2]; out.push([Math.asin(z) / RAD, Math.atan2(y, x) / RAD]); }
  return out;
}
function wwEarth(root, opts = {}) {
  const o = { mode: "globe", center: WW.home ? [WW.home[0], WW.home[1]] : [30, 10], zoom: 1, terminator: true, grid: "latlon", borders: true, hud: true, ...opts };
  if (o.mode === "flat") o.center = [0, o.center[1]];          // Weltkarte: Mitte auf dem Aequator
  root.classList.add("earth3d");
  root.innerHTML = `<canvas class="e3-gl"></canvas><canvas class="e3-ov"></canvas><div class="e3-hud"></div><div class="e3-modes"></div><div class="e3-tip hidden"></div>`;
  const gc = $(".e3-gl", root), oc = $(".e3-ov", root), hud = $(".e3-hud", root), tip = $(".e3-tip", root);
  const gl = gc.getContext("webgl", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  const E = { points: [], arcs: [], lines: [], o }; root._earth = E;
  let prog, tex = {}, W = 0, H = 0, dpr = 1, raf = 0, dirty = true, visible = true, alive = true, pan = [0, 0], spin = 0;
  if (!gl) { root.insertAdjacentHTML("beforeend", `<div class="hint e3-nogl">WebGL ist nicht verfügbar – die 3D-Erde braucht eine Grafikbeschleunigung.</div>`); }
  else {
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(x)); return x; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, EARTH_VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, EARTH_FS)); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aP"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    earthTextures().then(img => { if (!alive) return; ["day", "night"].forEach((k, i) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img[k]); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); tex[k] = t; });
      gl.uniform1i(gl.getUniformLocation(prog, "uDay"), 0); gl.uniform1i(gl.getUniformLocation(prog, "uNight"), 1); dirty = true; }).catch(() => hud.textContent = "Erdbilder nicht ladbar");
  }
  if (o.borders) earthBorders().then(() => { dirty = true; }).catch(() => { });
  // ---------- Projektion (gleich wie im Shader) ----------
  const basis = () => { const la = o.center[0] * RAD, lo = o.center[1] * RAD;
    return { e: [-Math.sin(lo), Math.cos(lo), 0], n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], f: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] }; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const toPx = (px, py) => [(px / (W / H) + 1) / 2 * W, (1 - (py + 1) / 2) * H];          // Shader-Koordinate -> CSS-Pixel
  const fromPx = (x, y) => [((x / W) * 2 - 1) * (W / H), 1 - (y / H) * 2];
  E.proj = (lat, lon) => {
    if (o.mode === "globe") { const B = basis(), P = ecef(lat, lon), R = .86 * o.zoom, z = dot(P, B.f); const [x, y] = toPx(dot(P, B.e) * R, dot(P, B.n) * R); return { x, y, vis: z > 0, z }; }
    if (o.mode === "flat") { const k = Math.max(Math.PI / (W / H), Math.PI / 2) / o.zoom; let dl = lon * RAD - (o.center[1] * RAD + pan[0]); dl = ((dl + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const [x, y] = toPx(dl / k, (lat * RAD - (o.center[0] * RAD + pan[1])) / k); return { x, y, vis: true, wrap: dl }; }
    const la0 = o.center[0] * RAD, lo0 = o.center[1] * RAD, la = lat * RAD, lo = lon * RAD, R = .92 * o.zoom;   // Peilkarte
    const c = Math.acos(Math.max(-1, Math.min(1, Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo - lo0))));
    const az = Math.atan2(Math.sin(lo - lo0) * Math.cos(la), Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(lo - lo0));
    const rr = c / Math.PI * R, [x, y] = toPx(Math.sin(az) * rr, Math.cos(az) * rr); return { x, y, vis: c < Math.PI * .995, az: (az / RAD + 360) % 360, km: c * 6371 };
  };
  E.unproj = (x, y) => {
    const [px, py] = fromPx(x, y);
    if (o.mode === "globe") { const R = .86 * o.zoom, qx = px / R, qy = py / R, r2 = qx * qx + qy * qy; if (r2 > 1) return null; const z = Math.sqrt(1 - r2), B = basis();
      const P = [0, 1, 2].map(i => qx * B.e[i] + qy * B.n[i] + z * B.f[i]); return [Math.asin(P[2]) / RAD, Math.atan2(P[1], P[0]) / RAD]; }
    if (o.mode === "flat") { const k = Math.max(Math.PI / (W / H), Math.PI / 2) / o.zoom, lat = (o.center[0] * RAD + pan[1] + py * k) / RAD; if (Math.abs(lat) > 90) return null;
      return [lat, (((o.center[1] * RAD + pan[0] + px * k) / RAD + 540) % 360) - 180]; }
    const R = .92 * o.zoom, rho = Math.hypot(px, py) / R * Math.PI; if (rho > Math.PI) return null; const az = Math.atan2(px, py), la0 = o.center[0] * RAD, lo0 = o.center[1] * RAD;
    const lat = Math.asin(Math.sin(la0) * Math.cos(rho) + Math.cos(la0) * Math.sin(rho) * Math.cos(az));
    return [lat / RAD, (((lo0 + Math.atan2(Math.sin(az) * Math.sin(rho) * Math.cos(la0), Math.cos(rho) - Math.sin(la0) * Math.sin(lat))) / RAD + 540) % 360) - 180];
  };
  E.azCenter = () => toPx(0, 0); E.azRadius = () => .92 * o.zoom * H / 2;
  // Linie aus [lat, lon]-Punkten zeichnen; unterbricht auf der Rueckseite (Globus) bzw. am Kartenrand (Weltkarte)
  E.path = (ctx, pts) => { let pen = false, last = null;
    for (const [la, lo] of pts) { const p = E.proj(la, lo); if (!p.vis || (last && Math.hypot(p.x - last.x, p.y - last.y) > W * .45)) { pen = false; last = p.vis ? p : null; if (!p.vis) continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y); last = p; } };
  // ---------- Leuchtschicht ----------
  const glow = (ctx, color, blur) => { ctx.shadowColor = color; ctx.shadowBlur = blur; };
  const drawOverlay = t => {
    const ctx = oc.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.lineCap = "round";
    if (o.grid) { ctx.save(); ctx.strokeStyle = "rgba(120,200,255,.16)"; ctx.lineWidth = .8; ctx.beginPath();
      const stLo = o.grid === "maiden" ? 20 : 30, stLa = o.grid === "maiden" ? 10 : 30;
      for (let lo = -180; lo < 180; lo += stLo) { const pts = []; for (let la = -90; la <= 90; la += 3) pts.push([la, lo]); E.path(ctx, pts); }
      for (let la = -90 + stLa; la < 90; la += stLa) { const pts = []; for (let lo = -180; lo <= 180; lo += 3) pts.push([la, lo]); E.path(ctx, pts); }
      ctx.stroke();
      if (o.grid === "maiden" && (o.mode === "flat" || o.zoom > 1.4)) { ctx.fillStyle = "rgba(150,215,255,.45)"; ctx.font = "10px 'Share Tech Mono', monospace"; ctx.textAlign = "center";
        for (let lo = -180; lo < 180; lo += 20) for (let la = -90; la < 90; la += 10) { const p = E.proj(la + 5, lo + 10); if (p.vis) ctx.fillText(String.fromCharCode(65 + (lo + 180) / 20) + String.fromCharCode(65 + (la + 90) / 10), p.x, p.y + 3); } }
      ctx.restore(); }
    if (o.borders && EARTH.borders) { ctx.save(); ctx.strokeStyle = "rgba(140,220,255,.32)"; ctx.lineWidth = .7; ctx.beginPath(); EARTH.borders.forEach(l => E.path(ctx, l)); ctx.stroke(); ctx.restore(); }
    if (o.mode === "azi") { const [cx, cy] = E.azCenter(), R = E.azRadius(); ctx.save(); ctx.strokeStyle = "rgba(120,210,255,.28)"; ctx.fillStyle = "rgba(160,225,255,.75)"; ctx.font = "11px 'Share Tech Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const km of [5000, 10000, 15000]) { ctx.beginPath(); ctx.arc(cx, cy, R * km / 20015, 0, 7); ctx.stroke(); ctx.fillText(`${km / 1000}k km`, cx, cy - R * km / 20015 + 9); }
      for (let a = 0; a < 360; a += 30) { const s = Math.sin(a * RAD), c = Math.cos(a * RAD); ctx.beginPath(); ctx.moveTo(cx + s * R * .04, cy - c * R * .04); ctx.lineTo(cx + s * R, cy - c * R); ctx.stroke();
        ctx.fillText(a % 90 === 0 ? { 0: "N", 90: I18N.lang === "de" ? "O" : "E", 180: "S", 270: "W" }[a] : a, cx + s * (R + 14), cy - c * (R + 14)); }
      ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(90,200,255,.7)"; glow(ctx, "#2bb8ff", 10); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke(); ctx.restore(); }
    if (o.draw) { ctx.save(); o.draw(ctx, E, t); ctx.restore(); }
    for (const a of E.arcs) { const pts = gcPoints(a.from, a.to, 96), col = a.color || "#ff4fd8"; ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = a.width || 2; glow(ctx, col, 12); ctx.globalAlpha = .9; if (a.dash) ctx.setLineDash(a.dash);
      ctx.beginPath(); E.path(ctx, pts); ctx.stroke(); ctx.setLineDash([]);
      if (a.flow !== false) { const k = (t / 1800) % 1, i = Math.floor(k * (pts.length - 1)), p = E.proj(pts[i][0], pts[i][1]); if (p.vis) { ctx.fillStyle = "#fff"; glow(ctx, col, 18); ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); } }
      ctx.restore(); }
    for (const l of E.lines) { ctx.save(); ctx.strokeStyle = l.color || "#2bd4ff"; ctx.lineWidth = l.width || 1.5; glow(ctx, l.color || "#2bd4ff", l.glow ?? 8); if (l.dash) ctx.setLineDash(l.dash); ctx.beginPath(); E.path(ctx, l.pts); ctx.stroke(); ctx.restore(); }
    for (const p of E.points) { const q = E.proj(p.lat, p.lon); if (!q.vis) continue; const col = p.color || "#2bd4ff", r = p.r || 3;
      ctx.save(); glow(ctx, col, p.glow ?? 10); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 7); ctx.fill();
      if (p.pulse) { const k = (t / 1400) % 1; ctx.strokeStyle = col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(q.x, q.y, r + 4 + k * 16, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
      if (p.label) { ctx.shadowBlur = 4; ctx.fillStyle = "rgba(220,240,255,.95)"; ctx.font = "11px 'Share Tech Mono', monospace"; ctx.textAlign = "left"; ctx.fillText(p.label, q.x + r + 5, q.y + 4); }
      ctx.restore(); }
    if (o.terminator) { const s = sunPos(), q = E.proj(s.lat, s.lon); if (q.vis) { ctx.save(); const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, 16); g.addColorStop(0, "rgba(255,240,180,1)"); g.addColorStop(.35, "rgba(255,200,90,.7)"); g.addColorStop(1, "rgba(255,170,60,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, 16, 0, 7); ctx.fill(); ctx.restore(); } }
  };
  const hudText = () => { if (!o.hud) { hud.textContent = ""; return; } const s = sunPos(), n = new Date();
    hud.innerHTML = `<b>${n.toISOString().slice(11, 16)} UTC</b><span>${I18N.t("Sonne").toUpperCase()} ${Math.abs(s.lat).toFixed(1)}°${s.lat >= 0 ? "N" : "S"} ${Math.abs(s.lon).toFixed(1)}°${s.lon >= 0 ? (I18N.lang === "de" ? "O" : "E") : "W"}</span>${o.hudExtra ? `<span>${esc(o.hudExtra)}</span>` : ""}`; };
  // ---------- Zeichnen ----------
  const animated = () => E.arcs.some(a => a.flow !== false) || E.points.some(p => p.pulse) || spin;
  let lastT = 0;
  const frame = t => {
    raf = 0; if (!alive) return;
    if (visible && !document.hidden && (dirty || (animated() && t - lastT > 33))) {
      lastT = t; dirty = false;
      if (spin && o.mode === "globe") o.center = [o.center[0], ((o.center[1] + spin + 540) % 360) - 180];
      if (gl && tex.day) { gl.viewport(0, 0, gc.width, gc.height);
        const B = basis(), s = ecef(sunPos().lat, sunPos().lon), U = n => gl.getUniformLocation(prog, n);
        gl.uniform2f(U("uRes"), gc.width, gc.height); gl.uniform1f(U("uMode"), { globe: 0, flat: 1, azi: 2 }[o.mode]); gl.uniform1f(U("uZoom"), o.zoom); gl.uniform1f(U("uTerm"), o.terminator ? 1 : 0);
        gl.uniform1f(U("uTime"), t / 1000); gl.uniform1f(U("uPix"), dpr); gl.uniform3fv(U("uE"), B.e); gl.uniform3fv(U("uN"), B.n); gl.uniform3fv(U("uF"), B.f); gl.uniform3fv(U("uSun"), s);
        gl.uniform2f(U("uCenter"), o.center[0] * RAD, o.center[1] * RAD); gl.uniform2f(U("uPan"), pan[0], pan[1]); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
      drawOverlay(t);
    }
    if (alive) raf = requestAnimationFrame(frame);
  };
  const resize = () => { const r = root.getBoundingClientRect(); W = Math.max(10, r.width); H = Math.max(10, r.height); dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [gc, oc]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + "px"; c.style.height = H + "px"; } dirty = true; };
  const ro = new ResizeObserver(resize); ro.observe(root); resize();
  const io = new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); if (visible) dirty = true; }); io.observe(root);
  raf = requestAnimationFrame(frame);
  const hudT = setInterval(() => { hudText(); dirty = true; }, 30000); hudText();
  // ---------- Bedienung ----------
  let drag = null, moved = false;
  oc.addEventListener("pointerdown", e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, c: [...o.center], pan: [...pan] }; moved = false; oc.setPointerCapture(e.pointerId); spin = 0; });
  oc.addEventListener("pointermove", e => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; if (!moved) return;
      if (o.mode === "globe") { const k = 180 / (Math.PI * .86 * o.zoom * H / 2); o.center = [Math.max(-85, Math.min(85, drag.c[0] + dy * k)), ((drag.c[1] - dx * k + 540) % 360) - 180]; }
      else if (o.mode === "flat") { const k = Math.max(Math.PI / (W / H), Math.PI / 2) / o.zoom * 2 / H; pan = [drag.pan[0] - dx * k, Math.max(-1.2, Math.min(1.2, drag.pan[1] + dy * k))]; }
      dirty = true; return; }
    if (o.onHover || E.points.some(p => p.tip)) { const hit = E.pick(e.offsetX, e.offsetY);
      if (hit && hit.tip) { tip.textContent = hit.tip; tip.style.left = e.offsetX + 14 + "px"; tip.style.top = e.offsetY + 8 + "px"; tip.classList.remove("hidden"); } else tip.classList.add("hidden");
      o.onHover?.(hit, E.unproj(e.offsetX, e.offsetY), e); }
  });
  oc.addEventListener("pointerup", e => { const was = drag; drag = null; if (was && !moved && o.onClick) o.onClick(E.unproj(e.offsetX, e.offsetY), E.pick(e.offsetX, e.offsetY), e); });
  oc.addEventListener("pointerleave", () => tip.classList.add("hidden"));
  oc.addEventListener("wheel", e => { e.preventDefault(); o.zoom = Math.max(o.mode === "azi" ? .9 : .6, Math.min(o.mode === "globe" ? 6 : 12, o.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); dirty = true; }, { passive: false });
  oc.addEventListener("dblclick", () => { if (WW.home) { o.center = [WW.home[0], WW.home[1]]; pan = [0, 0]; dirty = true; } });
  E.pick = (x, y) => { let best = null, bd = 9; for (const p of E.points) { const q = E.proj(p.lat, p.lon); if (!q.vis) continue; const d = Math.hypot(q.x - x, q.y - y) - (p.r || 3); if (d < bd) { bd = d; best = p; } } return best; };
  const modesBar = () => { const box = $(".e3-modes", root); if (!o.modes) { box.innerHTML = ""; return; }
    box.innerHTML = o.modes.map(([m, l]) => `<button type="button" data-m="${m}" class="${m === o.mode ? "on" : ""}">${esc(l)}</button>`).join("");
    box.onclick = e => { const b = e.target.closest("[data-m]"); if (!b) return; E.set({ mode: b.dataset.m }); o.onMode?.(b.dataset.m); }; };
  modesBar();
  E.set = v => { const m0 = o.mode; Object.assign(o, v); if (v.mode && v.mode !== m0) { pan = [0, 0]; if (v.zoom === undefined) o.zoom = 1;
    if (!v.center) o.center = o.mode === "flat" ? [0, (WW.home || o.center)[1]] : WW.home ? [WW.home[0], WW.home[1]] : o.center; }
  else if (v.center && o.mode === "flat") o.center = [0, v.center[1]]; modesBar(); hudText(); dirty = true; };
  E.spin = deg => { spin = deg; dirty = true; };
  E.redraw = () => { dirty = true; };
  E.destroy = () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); clearInterval(hudT); const lose = gl?.getExtension("WEBGL_lose_context"); lose?.loseContext(); root.innerHTML = ""; };
  return E;
}
