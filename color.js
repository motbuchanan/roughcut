// color.js · RoughCut (v0.35)
// Per-clip colour: a look preset, four adjustments, and an optional 3D LUT from a
// .cube file. One grade routine shared by the preview and the export. Runs as a
// WebGL2 shader when the device has it (fast, identical on Android and iPhone),
// and falls back to a plain pixel loop with the same math otherwise.
//
// Stored on the clip: clip.look = { preset, bright, contrast, sat, warm, lift, lut, lutMix }
//   bright/contrast/sat/warm : -1..1 (0 = untouched)      lift : 0..1 lifted blacks (presets only)
//   lut : null | { id, name, size }  -> the table lives in OPFS (state.js luts), cached here
//   lutMix : 0..1 how much of the LUT to apply
// Order of operations: warm -> bright -> contrast -> lift -> sat -> LUT. Clips with no look skip all of it.

export const PRESETS = [
  { id: 'none',    label: 'None',    p: {} },
  { id: 'warm',    label: 'Warm',    p: { warm: 0.35, sat: 0.08 } },
  { id: 'cool',    label: 'Cool',    p: { warm: -0.35, sat: 0.05 } },
  { id: 'punch',   label: 'Punch',   p: { contrast: 0.28, sat: 0.3 } },
  { id: 'fade',    label: 'Fade',    p: { lift: 0.14, contrast: -0.12, sat: -0.15 } },
  { id: 'vintage', label: 'Vintage', p: { warm: 0.3, lift: 0.1, sat: -0.3, contrast: 0.06 } },
  { id: 'mono',    label: 'Mono',    p: { sat: -1 } },
  { id: 'noir',    label: 'Noir',    p: { sat: -1, contrast: 0.35, lift: 0.04 } },
];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEF = { preset: 'none', bright: 0, contrast: 0, sat: 0, warm: 0, lift: 0, lut: null, lutMix: 1 };

export function lookOf(clip) {
  const l = (clip && clip.look) || {};
  return {
    preset: (l.preset === 'custom' || PRESETS.some((p) => p.id === l.preset)) ? l.preset : 'none',
    bright: clamp(Number(l.bright) || 0, -1, 1), contrast: clamp(Number(l.contrast) || 0, -1, 1),
    sat: clamp(Number(l.sat) || 0, -1, 1), warm: clamp(Number(l.warm) || 0, -1, 1),
    lift: clamp(Number(l.lift) || 0, 0, 1),
    lut: (l.lut && l.lut.id) ? { id: l.lut.id, name: l.lut.name || 'LUT', size: Number(l.lut.size) || 0 } : null,
    lutMix: l.lutMix == null ? 1 : clamp(Number(l.lutMix), 0, 1),
  };
}
export function isDefaultLook(clip) {
  const l = lookOf(clip);
  return !l.bright && !l.contrast && !l.sat && !l.warm && !l.lift && !l.lut;
}
// The look a preset produces on top of the user's sliders? No: picking a preset SETS the sliders
// it touches, so presets and sliders are one set of numbers and nothing is hidden.
export function presetValues(id) {
  const p = PRESETS.find((x) => x.id === id);
  return { preset: p ? p.id : 'none', bright: 0, contrast: 0, sat: 0, warm: 0, lift: 0, ...((p && p.p) || {}) };
}

// ---- .cube parsing -------------------------------------------------------
// Returns { size, data: Float32Array(size^3*3), title } for a 3D LUT. Throws with a
// plain-words message on anything else.
export function parseCube(text) {
  let size = 0, title = '', min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('This is a 1D LUT. RoughCut takes 3D .cube files.');
    if (up.startsWith('DOMAIN_MIN')) { min = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { max = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/i.test(line)) continue;   // unknown keyword
    const n = line.split(/\s+/).map(Number);
    if (n.length >= 3 && n.slice(0, 3).every((x) => Number.isFinite(x))) vals.push(n[0], n[1], n[2]);
  }
  if (!(size >= 2 && size <= 65)) throw new Error('No LUT_3D_SIZE found (2 to 65).');
  if (vals.length !== size * size * size * 3) throw new Error(`Expected ${size * size * size} colour rows, found ${vals.length / 3}.`);
  const data = new Float32Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const c = i % 3, span = (max[c] - min[c]) || 1;
    data[i] = clamp((vals[i] - min[c]) / span, 0, 1);
  }
  return { size, data, title };
}

// ---- LUT table cache (id -> { size, data }) --------------------------------
const tables = new Map();
export function registerLut(id, size, data) { tables.set(id, { size, data }); }
export function hasLut(id) { return tables.has(id); }
export function getLut(id) { return tables.get(id) || null; }
export function forgetLut(id) { tables.delete(id); }

// ---- grading -------------------------------------------------------------
// Grade `src` (a canvas / bitmap of w x h) per the clip's look. Returns a canvas
// to draw, or `src` itself when there is nothing to do. The returned canvas is a
// shared scratch, valid until the next call.
let gl2 = null, glFail = false, scratch2d = null, lastPath = 'none';
export function gradeFrame(src, w, h, clip) {
  if (!src || !(w > 0) || !(h > 0) || isDefaultLook(clip)) return src;
  const look = lookOf(clip);
  const lut = look.lut ? getLut(look.lut.id) : null;
  const out = scratchCanvas(w, h);
  if (!glFail) {
    try {
      if (!gl2) gl2 = makeGrader();
      if (gl2 && gl2.grade(src, w, h, look, lut)) { out.getContext('2d').drawImage(gl2.canvas, 0, 0, w, h, 0, 0, w, h); lastPath = 'gpu'; return out; }
    } catch (e) { console.warn('WebGL grade failed, using CPU path', e); glFail = true; }
  }
  lastPath = 'cpu';
  const c = out.getContext('2d');
  c.drawImage(src, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  gradePixels(img.data, look, lut);
  c.putImageData(img, 0, 0);
  return out;
}
function scratchCanvas(w, h) {
  if (!scratch2d) scratch2d = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  if (scratch2d.width !== w) scratch2d.width = w;
  if (scratch2d.height !== h) scratch2d.height = h;
  return scratch2d;
}

// CPU path: same math as the shader, on bytes.
export function gradePixels(d, look, lut) {
  const { bright, contrast, sat, warm, lift, lutMix } = look;
  const cm = 1 + contrast, sm = 1 + sat, mix = lut ? lutMix : 0;
  const N = lut ? lut.size : 0, L = lut ? lut.data : null;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    r += warm * 0.12; b -= warm * 0.12;
    r += bright * 0.4; g += bright * 0.4; b += bright * 0.4;
    r = (r - 0.5) * cm + 0.5; g = (g - 0.5) * cm + 0.5; b = (b - 0.5) * cm + 0.5;
    r = r * (1 - lift) + lift; g = g * (1 - lift) + lift; b = b * (1 - lift) + lift;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * sm; g = y + (g - y) * sm; b = y + (b - y) * sm;
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
    if (mix > 0) {
      const [lr, lg, lb] = sampleLut(L, N, r, g, b);
      r = r + (lr - r) * mix; g = g + (lg - g) * mix; b = b + (lb - b) * mix;
    }
    d[i] = Math.round(r * 255); d[i + 1] = Math.round(g * 255); d[i + 2] = Math.round(b * 255);
  }
}
// Trilinear lookup in a red-fastest cube table.
export function sampleLut(L, N, r, g, b) {
  const m = N - 1;
  const fr = r * m, fg = g * m, fb = b * m;
  const r0 = Math.min(Math.floor(fr), m - 1), g0 = Math.min(Math.floor(fg), m - 1), b0 = Math.min(Math.floor(fb), m - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const at = (ri, gi, bi) => (ri + N * gi + N * N * bi) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = L[at(r0, g0, b0) + c], c100 = L[at(r0 + 1, g0, b0) + c], c010 = L[at(r0, g0 + 1, b0) + c], c110 = L[at(r0 + 1, g0 + 1, b0) + c];
    const c001 = L[at(r0, g0, b0 + 1) + c], c101 = L[at(r0 + 1, g0, b0 + 1) + c], c011 = L[at(r0, g0 + 1, b0 + 1) + c], c111 = L[at(r0 + 1, g0 + 1, b0 + 1) + c];
    const c00 = c000 + (c100 - c000) * tr, c10 = c010 + (c110 - c010) * tr, c01 = c001 + (c101 - c001) * tr, c11 = c011 + (c111 - c011) * tr;
    const c0 = c00 + (c10 - c00) * tg, c1 = c01 + (c11 - c01) * tg;
    out[c] = c0 + (c1 - c0) * tb;
  }
  return out;
}

// WebGL2 path.
const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = vec2(p.x, 1.0 - p.y); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D frame; uniform sampler3D lut;
uniform float bright, contrast, sat, warm, lift, lutMix, lutN;
void main(){
  vec3 c = texture(frame, uv).rgb;
  c.r += warm * 0.12; c.b -= warm * 0.12;
  c += bright * 0.4;
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  c = c * (1.0 - lift) + lift;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = y + (c - y) * (1.0 + sat);
  c = clamp(c, 0.0, 1.0);
  if (lutMix > 0.0) { vec3 l = texture(lut, c * ((lutN - 1.0) / lutN) + 0.5 / lutN).rgb; c = mix(c, l, lutMix); }
  o = vec4(c, 1.0);
}`;
function makeGrader() {
  const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = {}; for (const n of ['bright', 'contrast', 'sat', 'warm', 'lift', 'lutMix', 'lutN', 'frame', 'lut']) u[n] = gl.getUniformLocation(prog, n);
  const frameTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const lutTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 2, 2, 2, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0, 255,0,0, 0,255,0, 255,255,0, 0,0,255, 255,0,255, 0,255,255, 255,255,255]));
  gl.uniform1i(u.frame, 0); gl.uniform1i(u.lut, 1);
  let lutId = null, lutSize = 2;
  return {
    canvas,
    grade(src, w, h, look, lut) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frameTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      if (lut && lut !== lutId) {
        const N = lut.size, bytes = new Uint8Array(N * N * N * 3);
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(clamp(lut.data[i], 0, 1) * 255);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, N, N, N, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
        lutId = lut; lutSize = N;
      }
      gl.uniform1f(u.bright, look.bright); gl.uniform1f(u.contrast, look.contrast); gl.uniform1f(u.sat, look.sat);
      gl.uniform1f(u.warm, look.warm); gl.uniform1f(u.lift, look.lift);
      gl.uniform1f(u.lutMix, lut ? look.lutMix : 0); gl.uniform1f(u.lutN, lut ? lutSize : 2);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    },
  };
}
// Test hook: force the CPU path (used by the parity test).
export function _forceCpu(on) { glFail = !!on; }
export function _lastPath() { return lastPath; }
