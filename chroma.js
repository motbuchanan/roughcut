// chroma.js · RoughCut (v0.46)
// Chroma key ("green screen") for PiP overlays. Pixels close to the key colour
// become transparent; a soft edge band fades between; spill suppression pulls
// the key colour's tint out of what is left (green fringes on hair and edges).
// Distance is measured in chroma (CbCr) only, so shadows and highlights on the
// screen key out together. WebGL2 shader with an identical CPU fallback; one
// routine shared by the preview and the export. No DOM at import time.
//
// Stored on the overlay clip: clip.key = { on, color: '#rrggbb', tol, soft, spill }
//   tol   : 0..1  how far from the key colour still counts as screen (strength)
//   soft  : 0..1  width of the fade band after tol (edge softness)
//   spill : 0..1  how much key tint to remove from the kept pixels

export const KEY_DEFAULT = { on: false, color: '#00b140', tol: 0.22, soft: 0.1, spill: 0.6 };
export const keyOf = (clip) => ({ ...KEY_DEFAULT, ...((clip && clip.key) || {}) });
export const keyOn = (clip) => !!(clip && clip.key && clip.key.on);

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0x00b140;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(r, g, b) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
// BT.601 chroma, scaled so pure green sits about 0.5 from neutral
const cb = (r, g, b) => -0.168736 * r - 0.331264 * g + 0.5 * b;
const cr = (r, g, b) => 0.5 * r - 0.418688 * g - 0.081312 * b;

// Guess the screen colour from a frame: the most common saturated colour along the border.
export function guessKeyColor(img, w, h) {
  const c = document.createElement('canvas'); const S = 64;
  c.width = S; c.height = Math.max(8, Math.round(S * h / w));
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
  const bins = new Map();
  const add = (px, py) => {
    const i = (py * W + px) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 40) return;   // skip greys
    const k = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);
    const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; e.n++; e.r += r; e.g += g; e.b += b; bins.set(k, e);
  };
  for (let px = 0; px < W; px++) { add(px, 0); add(px, 1); add(px, H - 1); add(px, H - 2); }
  for (let py = 0; py < H; py++) { add(0, py); add(1, py); add(W - 1, py); add(W - 2, py); }
  let best = null; for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  return best ? rgbToHex(best.r / best.n, best.g / best.n, best.b / best.n) : KEY_DEFAULT.color;
}

// ---- WebGL2 path ----
let gl = null, glCanvas = null, prog = null, tex = null, uni = null, glFailed = false;
export let _forceCpu = false;
export function _setForceCpu(v) { _forceCpu = !!v; }
export let _lastPath = '';
const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = vec2((p.x+1.)*.5, 1.-(p.y+1.)*.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision mediump float; in vec2 uv; out vec4 o; uniform sampler2D t;
uniform vec2 key; uniform float tol, soft, spill;
void main(){
  vec3 c = texture(t, uv).rgb;
  vec2 cc = vec2(-0.168736*c.r - 0.331264*c.g + 0.5*c.b, 0.5*c.r - 0.418688*c.g - 0.081312*c.b);
  float d = distance(cc, key);
  float a = smoothstep(tol, tol + max(soft, 0.001), d);
  float kl = length(key);
  if (kl > 0.0001 && spill > 0.0) {
    vec2 kd = key / kl;
    float along = max(0.0, dot(cc, kd));
    vec2 nc = cc - kd * along * spill;
    float y = 0.299*c.r + 0.587*c.g + 0.114*c.b;
    c = clamp(vec3(y + 1.402*nc.y, y - 0.344136*nc.x - 0.714136*nc.y, y + 1.772*nc.x), 0.0, 1.0);
  }
  o = vec4(c * a, a);
}`;
function initGl() {
  if (gl || glFailed) return !!gl;
  try {
    glCanvas = document.createElement('canvas');
    gl = glCanvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no webgl2');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    uni = { key: gl.getUniformLocation(prog, 'key'), tol: gl.getUniformLocation(prog, 'tol'), soft: gl.getUniformLocation(prog, 'soft'), spill: gl.getUniformLocation(prog, 'spill') };
    glCanvas.addEventListener('webglcontextlost', () => { gl = null; glFailed = false; });
    return true;
  } catch (e) { console.warn('chroma: WebGL2 unavailable, using CPU', e); gl = null; glFailed = true; return false; }
}

// ---- CPU path (identical maths) ----
let cpuCanvas = null;
function keyCpu(src, w, h, k, kc) {
  if (!cpuCanvas) cpuCanvas = document.createElement('canvas');
  if (cpuCanvas.width !== w || cpuCanvas.height !== h) { cpuCanvas.width = w; cpuCanvas.height = h; }
  const x = cpuCanvas.getContext('2d', { willReadFrequently: true });
  x.clearRect(0, 0, w, h); x.drawImage(src, 0, 0, w, h);
  const im = x.getImageData(0, 0, w, h), d = im.data;
  const kl = Math.hypot(kc[0], kc[1]), kdx = kl ? kc[0] / kl : 0, kdy = kl ? kc[1] / kl : 0;
  const t0 = k.tol, t1 = k.tol + Math.max(k.soft, 0.001);
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const x0 = cb(r, g, b), y0 = cr(r, g, b);
    const dist = Math.hypot(x0 - kc[0], y0 - kc[1]);
    let a = Math.max(0, Math.min(1, (dist - t0) / (t1 - t0))); a = a * a * (3 - 2 * a);
    if (kl > 0.0001 && k.spill > 0) {
      const along = Math.max(0, x0 * kdx + y0 * kdy);
      const nx = x0 - kdx * along * k.spill, ny = y0 - kdy * along * k.spill;
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      r = yy + 1.402 * ny; g = yy - 0.344136 * nx - 0.714136 * ny; b = yy + 1.772 * nx;
    }
    d[i] = Math.max(0, Math.min(255, r * 255)); d[i + 1] = Math.max(0, Math.min(255, g * 255)); d[i + 2] = Math.max(0, Math.min(255, b * 255)); d[i + 3] = Math.round(a * 255);
  }
  x.putImageData(im, 0, 0);
  return cpuCanvas;
}

// Key one frame. Returns a canvas (shared; draw it before the next call) with transparency.
export function keyFrame(src, w, h, clip) {
  const k = keyOf(clip);
  const [r, g, b] = hexToRgb(k.color), kc = [cb(r, g, b), cr(r, g, b)];
  if (!_forceCpu && initGl()) {
    try {
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform2f(uni.key, kc[0], kc[1]); gl.uniform1f(uni.tol, k.tol); gl.uniform1f(uni.soft, k.soft); gl.uniform1f(uni.spill, k.spill);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      _lastPath = 'gpu';
      return glCanvas;
    } catch (e) { console.warn('chroma: GPU pass failed, CPU from now on', e); glFailed = true; gl = null; }
  }
  _lastPath = 'cpu';
  return keyCpu(src, w, h, k, kc);
}

// Colour of the source picture under a point given as a fraction of the picture (for the picker).
export function sampleColor(img, w, h, fx, fy) {
  const c = document.createElement('canvas'); c.width = 5; c.height = 5;
  const x = c.getContext('2d', { willReadFrequently: true });
  const sx = Math.max(0, Math.min(w - 5, Math.round(fx * w) - 2)), sy = Math.max(0, Math.min(h - 5, Math.round(fy * h) - 2));
  x.drawImage(img, sx, sy, 5, 5, 0, 0, 5, 5);
  const d = x.getImageData(0, 0, 5, 5).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return rgbToHex(r / 25, g / 25, b / 25);
}
