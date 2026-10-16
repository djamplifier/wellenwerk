"use strict";
// Wellenwerk – Wasserfall-Fenster: 2D (Spektrum + Wasserfall, Zoom, Verschieben, Klick stimmt ab) und
// 3D (WebGL-Landschaft der letzten Zeilen, mit der Maus drehbar). Quelle: Spektrumzeilen eines Geraets/Empfaengers.
const WF_PALETTES = {
  klassisch: [[0, 8, 24, 48], [0.35, 20, 60, 200], [0.6, 40, 200, 220], [0.8, 250, 230, 60], [1, 255, 60, 30]],
  feuer: [[0, 0, 0, 0], [0.3, 90, 0, 20], [0.55, 210, 40, 0], [0.8, 255, 190, 30], [1, 255, 255, 220]],
  grau: [[0, 0, 0, 0], [1, 255, 255, 255]],
  meer: [[0, 5, 10, 40], [0.4, 0, 90, 140], [0.7, 60, 200, 170], [1, 230, 255, 200]],
  nacht: [[0, 0, 0, 0], [0.5, 120, 0, 0], [1, 255, 90, 60]],
};
function wfOpts() { return Object.assign({ palette: "klassisch", auto: true, lo: 0.15, hi: 0.95, depth: 160, speed: 1, height: 1, sig: true, sigsecs: 15 }, store.get("opts", {}).wf || {}); }
function wfLut(name) { const st = WF_PALETTES[name] || WF_PALETTES.klassisch, lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { const v = i / 255; let k = 1; while (k < st.length - 1 && v > st[k][0]) k++; const a = st[k - 1], b = st[k], t = Math.max(0, Math.min(1, (v - a[0]) / ((b[0] - a[0]) || 1)));
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * t); lut[i * 4 + 3] = 255; } return lut; }

function createWfPanel(root) {
  const o = wfOpts(), st = store.get("wf.view", { mode: "2d", src: "", rx: 0.62, ry: 0.0, dist: 1.55 });
  if (!(st.rx > 0)) Object.assign(st, { rx: 0.62, ry: 0, dist: 1.55 });
  root.innerHTML = `<div class="pane-tb wf-tb"><select class="wf-src" title="Quelle"></select><div class="seg2"><button data-m="2d">2D</button><button data-m="3d">3D</button></div>
    <button class="wf-zr" title="ganzer Bereich">⤢</button><span class="hint wf-info"></span><i class="grow"></i><button class="wf-opt" title="Einstellungen">${icon("i-gear")}</button></div>
    <div class="wf-area"><canvas class="wf-spec"></canvas><canvas class="wf-fall"></canvas><canvas class="wf-3d hidden"></canvas></div>`;
  const spec = $(".wf-spec", root), fall = $(".wf-fall", root), c3 = $(".wf-3d", root);
  let lut = wfLut(o.palette), last = null, view = null, rows = 0, gl = null, g3 = null, nLevel = [0, 255];
  const src = () => $(".wf-src", root).value || WW.current;
  const fillSrc = () => { const cur = st.src; $(".wf-src", root).innerHTML = `<option value="">aktuelles Gerät</option>` + (WW.radios || []).filter(r => r.connected).map(r => `<option value="${esc(r.id)}" ${r.id === cur ? "selected" : ""}>${esc(r.name)}</option>`).join(""); };
  const setMode = m => { st.mode = m; store.set("wf.view", st); $$(".seg2 button", root).forEach(b => b.classList.toggle("on", b.dataset.m === m));
    spec.classList.toggle("hidden", m === "3d"); fall.classList.toggle("hidden", m === "3d"); c3.classList.toggle("hidden", m !== "3d"); if (m === "3d") init3d(); };
  const radioState = () => (WW.radios || []).find(r => r.id === src())?.state || WW.rig || {};
  // Pegel: automatisch (Rauschboden .. Spitzen) oder fest
  const level = d => { if (!o.auto) return [o.lo * 255, o.hi * 255]; const s = [...d].sort((a, b) => a - b); const lo = s[Math.floor(s.length * 0.2)], hi = s[Math.floor(s.length * 0.995)];
    nLevel = [nLevel[0] * 0.9 + lo * 0.1, nLevel[1] * 0.9 + Math.max(hi, lo + 25) * 0.1]; return nLevel; };
  const norm = (v, L) => Math.max(0, Math.min(255, Math.round((v - L[0]) / ((L[1] - L[0]) || 1) * 255)));
  const fx = (f, W) => (f - view[0]) / (view[1] - view[0]) * W;
  // ---------- 2D ----------
  const draw2d = (l, L) => {
    const W = spec.clientWidth, H = spec.clientHeight, FH = fall.clientHeight; if (!W || !H) return;
    if (spec.width !== W || spec.height !== H) { spec.width = W; spec.height = H; } if (fall.width !== W || fall.height !== FH) { fall.width = W; fall.height = FH; }
    const c = spec.getContext("2d"), n = l.data.length, s = radioState();
    c.fillStyle = "#08121c"; c.fillRect(0, 0, W, H);
    const i0 = (view[0] - l.low) / (l.high - l.low) * n, i1 = (view[1] - l.low) / (l.high - l.low) * n;
    const val = x => l.data[Math.max(0, Math.min(n - 1, Math.floor(i0 + x / W * (i1 - i0))))];
    // Durchlassbereich
    if (s.freq && s.passband !== undefined) { const pb = wfPass(s); c.fillStyle = "rgba(255,255,255,.08)"; c.fillRect(fx(s.freq + pb[0], W), 0, fx(s.freq + pb[1], W) - fx(s.freq + pb[0], W), H); }
    c.strokeStyle = "#5cd0ff"; c.beginPath(); for (let x = 0; x < W; x++) { const y = H - norm(val(x), L) / 255 * (H - 14) - 2; x ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke();
    c.fillStyle = "rgba(255,255,255,.6)"; c.font = "10px sans-serif"; const stp = niceStep((view[1] - view[0]) / 7);
    for (let f = Math.ceil(view[0] / stp) * stp; f < view[1]; f += stp) { const x = fx(f, W); c.fillRect(x, 0, 1, 5); c.fillText((f / 1e6).toFixed(stp < 1000 ? 4 : 3), x + 2, 11); }
    if (s.freq) { c.fillStyle = "rgba(255,80,80,.9)"; c.fillRect(fx(s.freq, W), 0, 1.5, H); }
    for (const t of SIG.tags) { if (t.until < Date.now() || t.rf < view[0] || t.rf > view[1]) continue; const x = fx(t.rf, W), w = c.measureText(t.label).width + 8;   // erkannte Signale
      c.fillStyle = "rgba(20,30,40,.8)"; c.fillRect(x - w / 2, 14, w, 14); c.fillStyle = "#ffd166"; c.fillText(t.label, x - w / 2 + 4, 25); c.fillRect(x, 28, 1, 6); }
    if (!FH) return; const g = fall.getContext("2d");
    const row = new Uint8ClampedArray(W * 4); for (let x = 0; x < W; x++) { const k = norm(val(x), L) * 4; row[x * 4] = lut[k]; row[x * 4 + 1] = lut[k + 1]; row[x * 4 + 2] = lut[k + 2]; row[x * 4 + 3] = 255; }
    wfPush(g, W, FH, row, wfRows("wf:" + l.radio));
  };
  // ---------- 3D (WebGL2) ----------
  const COLS = 512;
  function init3d() {
    if (g3) return; gl = c3.getContext("webgl2", { antialias: true }); if (!gl) { toast("3D-Wasserfall braucht WebGL 2", true); setMode("2d"); return; }
    const D = o.depth;
    const vs = `#version 300 es
      in vec2 p; uniform sampler2D h; uniform float head, hs; uniform mat4 mvp; out float lv; out float z;
      void main(){ float v = texture(h, vec2(p.x, fract(head - (1.0 - p.y)))).r; lv = v; z = p.y; gl_Position = mvp * vec4((p.x - 0.5) * 1.7, v * 0.45 * hs, (p.y - 0.5) * 1.1, 1.0); }`;
    const fs = `#version 300 es
      precision highp float; in float lv; in float z; uniform sampler2D pal; out vec4 o;
      void main(){ vec3 c = texture(pal, vec2(pow(lv, 0.75), 0.5)).rgb; o = vec4(mix(c, vec3(0.03,0.07,0.11), (1.0 - z) * (1.0 - z) * 0.5), 1.0); }`;
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
    const pts = new Float32Array(COLS * D * 2); for (let z = 0; z < D; z++) for (let x = 0; x < COLS; x++) { pts[(z * COLS + x) * 2] = x / (COLS - 1); pts[(z * COLS + x) * 2 + 1] = z / (D - 1); }
    const idx = new Uint32Array((COLS - 1) * (D - 1) * 6); let k = 0;
    for (let z = 0; z < D - 1; z++) for (let x = 0; x < COLS - 1; x++) { const a = z * COLS + x, b = a + 1, c = a + COLS, d = c + 1; idx.set([a, c, b, b, c, d], k); k += 6; }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const tex = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT); return t; };
    const th = tex(0); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, COLS, D, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(COLS * D));
    const tp = tex(1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.uniform1i(gl.getUniformLocation(pr, "h"), 0); gl.uniform1i(gl.getUniformLocation(pr, "pal"), 1);
    g3 = { pr, th, tp, D, head: 0, n: idx.length, u: { head: gl.getUniformLocation(pr, "head"), hs: gl.getUniformLocation(pr, "hs"), mvp: gl.getUniformLocation(pr, "mvp") } };
    gl.enable(gl.DEPTH_TEST);
  }
  const row3d = (l, L) => { if (!g3) return; const n = l.data.length, i0 = (view[0] - l.low) / (l.high - l.low) * n, i1 = (view[1] - l.low) / (l.high - l.low) * n, r = new Uint8Array(COLS);
    for (let x = 0; x < COLS; x++) r[x] = norm(l.data[Math.max(0, Math.min(n - 1, Math.floor(i0 + x / COLS * (i1 - i0))))], L);
    g3.head = (g3.head + 1) % g3.D; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g3.th); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, g3.head, COLS, 1, gl.RED, gl.UNSIGNED_BYTE, r); render3d(); };
  function render3d() {
    if (!g3) return; const W = c3.clientWidth, H = c3.clientHeight; if (!W || !H) return; const dpr = devicePixelRatio || 1;
    if (c3.width !== W * dpr || c3.height !== H * dpr) { c3.width = W * dpr; c3.height = H * dpr; } gl.viewport(0, 0, c3.width, c3.height);
    gl.clearColor(0.03, 0.07, 0.11, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(g3.u.head, (g3.head + 0.5) / g3.D); gl.uniform1f(g3.u.hs, o.height);
    gl.uniformMatrix4fv(g3.u.mvp, false, mvp(W / H)); gl.drawElements(gl.TRIANGLES, g3.n, gl.UNSIGNED_INT, 0);
  }
  function mvp(asp) { // Perspektive * Kamera (Drehung um X und Y, Abstand)
    const f = 1 / Math.tan(0.45), n = 0.05, fa = 20, P = [f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
    const cx = Math.cos(st.rx), sx = Math.sin(st.rx), cy = Math.cos(st.ry), sy = Math.sin(st.ry);
    const R = [cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, 0, 0, -st.dist, 1];
    const M = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += P[k * 4 + j] * R[i * 4 + k]; M[i * 4 + j] = s; } return M; }
  // ---------- Daten ----------
  let skip = 0;
  const onLine = l => { if (l.radio !== src()) return; if (++skip % Math.max(1, o.speed) !== 0) return;
    if (!view || view[0] < l.low - 1 || view[1] > l.high + 1 || st._full) { view = [l.low, l.high]; st._full = false; }
    last = l; rows++; const L = level(l.data);
    $(".wf-info", root).textContent = `${((view[1] - view[0]) / 1000).toFixed(1)} kHz · ${l.name || ""}`;
    st.mode === "3d" ? row3d(l, L) : draw2d(l, L); };
  // ---------- Bedienung ----------
  const tune = hz => { const id = src(); (id && id !== WW.current ? api(`/api/radios/${id}/rig/freq`, { method: "POST", body: { hz } }) : post("/api/rig/freq", { hz })).catch(e => toast(e.message, true)); };
  [spec, fall].forEach(cv => {
    cv.addEventListener("click", e => { if (!view || cv._dragged) return; const r = cv.getBoundingClientRect(), f = Math.round((view[0] + (e.clientX - r.left) / r.width * (view[1] - view[0])) / 10) * 10;
      if (!sigOnClick(src(), f, e)) tune(f); });
    cv.addEventListener("wheel", e => { if (!view || !last) return; e.preventDefault(); const r = cv.getBoundingClientRect(), at = view[0] + (e.clientX - r.left) / r.width * (view[1] - view[0]), k = e.deltaY > 0 ? 1.25 : 0.8;
      let a = at - (at - view[0]) * k, b = at + (view[1] - at) * k; if (b - a > last.high - last.low) [a, b] = [last.low, last.high]; if (b - a < 500) return;
      if (a < last.low) { b += last.low - a; a = last.low; } if (b > last.high) { a -= b - last.high; b = last.high; } view = [a, b]; }, { passive: false });
    cv.addEventListener("pointerdown", e => { if (!view) return; const x0 = e.clientX, v0 = view.slice(), w = cv.getBoundingClientRect().width; cv._dragged = false;
      const mv = ev => { const df = (ev.clientX - x0) / w * (v0[1] - v0[0]); if (Math.abs(ev.clientX - x0) > 3) cv._dragged = true; let a = v0[0] - df, b = v0[1] - df;
        if (last) { if (a < last.low) { b += last.low - a; a = last.low; } if (b > last.high) { a -= b - last.high; b = last.high; } } view = [a, b]; };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); setTimeout(() => cv._dragged = false, 0); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); });
  });
  c3.addEventListener("pointerdown", e => { const x0 = e.clientX, y0 = e.clientY, a = st.ry, b = st.rx;
    const mv = ev => { st.ry = a + (ev.clientX - x0) / 200; st.rx = Math.max(0.05, Math.min(1.5, b + (ev.clientY - y0) / 200)); render3d(); };
    const up = () => { store.set("wf.view", st); window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); });
  c3.addEventListener("wheel", e => { e.preventDefault(); st.dist = Math.max(0.8, Math.min(6, st.dist * (e.deltaY > 0 ? 1.1 : 0.9))); store.set("wf.view", st); render3d(); }, { passive: false });
  root.addEventListener("click", e => { const b = e.target.closest(".seg2 button"); if (b) setMode(b.dataset.m); if (e.target.closest(".wf-zr")) st._full = true; if (e.target.closest(".wf-opt")) openOptions("wf"); });
  $(".wf-src", root).onchange = e => { st.src = e.target.value; store.set("wf.view", st); view = null; };
  fillSrc(); setMode(st.mode);
  const offs = [WW.on("spectrum", onLine), WW.on("radios", fillSrc), WW.on("settings", () => { Object.assign(o, wfOpts()); lut = wfLut(o.palette);
    if (g3) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g3.tp); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut); } })];
  const ro = new ResizeObserver(() => { if (st.mode === "3d") render3d(); }); ro.observe(root);
  return () => { offs.forEach(f => f()); ro.disconnect(); };
}
function wfPass(s) { const m = s.mode, pb = +s.passband || 0;
  if (m === "LSB" || m === "PKTLSB") return [-(pb || 2700), -100]; if (m === "CW") return [500 - (pb || 500) / 2, 500 + (pb || 500) / 2];
  if (m === "AM" || m === "SAM" || m === "FM") return [-(pb || 9000) / 2, (pb || 9000) / 2]; return [100, pb || 2700]; }
APPS.rig.panels.waterfall = { title: "Wasserfall", create: createWfPanel, dock: { ref: "face", dir: "below" }, size: { height: 340 } };
