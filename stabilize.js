// stabilize.js · RoughCut (v0.47)
// Smooths shaky handheld video. No download: motion is measured right here on
// small grey copies of the frames, then each frame is nudged and turned so the
// camera follows a smooth path instead of the jittery one, with a slight
// constant zoom so the moving edges never show.
//
//  1. ANALYSE (once per clip, stored on the clip): decode the clip at ~30 fps,
//     ~200 px wide. For each pair of frames: a coarse whole-frame search finds
//     the rough shift, then ~48 textured blocks refine it; a robust fit of the
//     block moves gives shift (x, y) and roll (angle). Moving people and cars
//     are outvoted by the background.
//  2. SMOOTH (instant, per strength): Gaussian-smooth the cumulative path.
//  3. DRAW: correction = smooth - raw, applied inside the frame (frame.js),
//     so the preview and the export match and keys/zoom still work on top.
//
// clip.stab = { on, strength: 'light'|'medium'|'strong', t0, step, n,
//               x: [..], y: [..], a: [..] }   x/y as fractions of frame size,
// a in radians, cumulative from the first analysed frame, SOURCE time.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './mediabunny.js';

export const STRENGTHS = { light: 0.35, medium: 0.9, strong: 1.8 };   // smoothing sigma, seconds
export const STRENGTH_LABELS = { light: 'Light', medium: 'Medium', strong: 'Strong' };
export const ANALYSE_FPS = 30;
export const ZOOM_CAP = 1.25;
const AW = 256;   // analysis width (long edge)

// ---- motion between two grey frames ----
function sad(a, b, W, H, x0, y0, w, h, dx, dy) {
  let s = 0;
  for (let y = y0; y < y0 + h; y++) {
    const ra = y * W, rb = (y + dy) * W + dx;
    for (let x = x0; x < x0 + w; x++) { const d = a[ra + x] - b[rb + x]; s += d < 0 ? -d : d; }
  }
  return s;
}
function half(g, W, H) {
  const w = W >> 1, h = H >> 1, o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = 2 * y * W + 2 * x; o[y * w + x] = (g[i] + g[i + 1] + g[i + W] + g[i + W + 1]) * 0.25; }
  return { g: o, w, h };
}
// Returns { dx, dy, da } in analysis pixels / radians: how far content moved from a to b.
export function estimateMotion(a, b, W, H) {
  // coarse: whole-centre search at half resolution
  const A = half(a, W, H), B = half(b, W, H);
  const R = 10, mx = R + 2, my = R + 2;
  let best = Infinity, gx = 0, gy = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const s = sad(A.g, B.g, A.w, A.h, mx, my, A.w - 2 * mx, A.h - 2 * my, dx, dy);
    if (s < best) { best = s; gx = dx; gy = dy; }
  }
  gx *= 2; gy *= 2;
  // fine: textured blocks, small search around the coarse shift
  const BS = 12, r = 3, pad = 2 * r + Math.max(Math.abs(gx), Math.abs(gy)) + 4;
  const cols = 8, rows = 5, moves = [];
  const cw = (W - 2 * pad) / cols, ch = (H - 2 * pad) / rows;
  if (cw < BS || ch < BS) return { dx: gx, dy: gy, da: 0 };
  if (pad + BS + r >= W / 2 || pad + BS + r >= H / 2) return { dx: gx, dy: gy, da: 0 };
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = Math.round(pad + cx * cw + (cw - BS) / 2), y0 = Math.round(pad + cy * ch + (ch - BS) / 2);
    // texture check: skip flat sky and walls (they match anywhere)
    let e = 0; for (let y = y0; y < y0 + BS; y++) for (let x = x0; x < x0 + BS - 1; x++) { const i = y * W + x; e += Math.abs(a[i] - a[i + 1]) + Math.abs(a[i] - a[i + W]); }
    if (e < BS * BS * 4) continue;
    let bs = Infinity, bx = 0, by = 0;
    const grid = new Map();
    for (let dy = gy - r; dy <= gy + r; dy++) for (let dx = gx - r; dx <= gx + r; dx++) {
      const s = sad(a, b, W, H, x0, y0, BS, BS, dx, dy); grid.set(dx + ',' + dy, s); if (s < bs) { bs = s; bx = dx; by = dy; }
    }
    // sub-pixel: fit a parabola through the best score and its neighbours on each axis
    const sub = (m, c, p) => { const d = m - 2 * c + p; return (m != null && p != null && d > 0) ? Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / d)) : 0; };
    const fx = sub(grid.get((bx - 1) + ',' + by), bs, grid.get((bx + 1) + ',' + by));
    const fy = sub(grid.get(bx + ',' + (by - 1)), bs, grid.get(bx + ',' + (by + 1)));
    moves.push({ x: x0 + BS / 2 - W / 2, y: y0 + BS / 2 - H / 2, dx: bx + fx, dy: by + fy });
  }
  if (moves.length < 6) return { dx: gx, dy: gy, da: 0 };
  // robust similarity fit (shift + small roll): fit, drop outliers, refit
  const fit = (ms) => {
    let tx = 0, ty = 0; for (const m of ms) { tx += m.dx; ty += m.dy; } tx /= ms.length; ty /= ms.length;
    let num = 0, den = 0; for (const m of ms) { num += m.x * (m.dy - ty) - m.y * (m.dx - tx); den += m.x * m.x + m.y * m.y; }
    return { tx, ty, a: den ? num / den : 0 };
  };
  let f = fit(moves);
  const res = (m) => Math.hypot(m.dx - (f.tx - f.a * m.y), m.dy - (f.ty + f.a * m.x));
  const kept = moves.filter((m) => res(m) <= 1.0);
  if (kept.length >= 6) f = fit(kept);
  return { dx: f.tx, dy: f.ty, da: f.a };
}

function grey(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

// Analyse a clip's source range. file: Blob. Returns the stab record (without on/strength).
// onProgress(0..1); isCancelled() -> true to stop (throws AbortError).
export async function analyseClip(file, media, inUs, outUs, onProgress, isCancelled) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('This clip has no video to steady.');
    const mw = media.w || 16, mh = media.h || 9;
    const W = mw >= mh ? AW : Math.max(32, Math.round(AW * mw / mh)) & ~1, H = mw >= mh ? Math.max(32, Math.round(AW * mh / mw)) & ~1 : AW;
    const sink = new CanvasSink(vt, { width: W, height: H, fit: 'fill' });
    // Every real frame in the range, with its own timestamp: the correction for a frame must
    // be looked up by the same frame the decoder will hand the renderer, never a neighbour.
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d', { willReadFrequently: true });
    const tus = [], xs = [], ys = [], as = [];
    const span = Math.max(1, outUs - inUs);
    let prev = null, k = 0, px = 0, py = 0, pa = 0;
    for await (const wrapped of sink.canvases(inUs / 1e6, outUs / 1e6)) {
      if (isCancelled && isCancelled()) throw new DOMException('Stabilize cancelled', 'AbortError');
      cx.drawImage(wrapped.canvas, 0, 0, W, H);
      const g = grey(cx, W, H);
      if (prev) { const m = estimateMotion(prev, g, W, H); px += m.dx; py += m.dy; pa += m.da; }
      tus.push(Math.round(wrapped.timestamp * 1e6)); xs.push(+(px / W).toFixed(5)); ys.push(+(py / H).toFixed(5)); as.push(+pa.toFixed(5));
      prev = g; k++;
      if (onProgress && k % 5 === 0) { onProgress(Math.min(1, (wrapped.timestamp * 1e6 - inUs) / span)); await new Promise((r) => setTimeout(r, 0)); }
    }
    if (!tus.length) throw new Error('No frames could be read from this clip.');
    const step = tus.length > 1 ? Math.round((tus[tus.length - 1] - tus[0]) / (tus.length - 1)) : Math.round(1e6 / ANALYSE_FPS);
    return { t0: tus[0], step, n: xs.length, ts: tus, x: xs, y: ys, a: as };
  } finally { try { input.dispose(); } catch (_) {} }
}

// ---- smoothing + correction ----
const smoothCache = new WeakMap();   // stab record -> { [strength]: { cx, cy, ca, zoom } }
function gaussSmooth(arr, sigmaSamples) {
  const n = arr.length, out = new Float64Array(n);
  const r = Math.max(1, Math.ceil(sigmaSamples * 3)), w = [];
  for (let i = -r; i <= r; i++) w.push(Math.exp(-(i * i) / (2 * sigmaSamples * sigmaSamples)));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) { const k = Math.min(n - 1, Math.max(0, i + j)); s += arr[k] * w[j + r]; ws += w[j + r]; }   // clamp at ends: no drift-in
    out[i] = s / ws;
  }
  return out;
}
export function corrections(stab) {
  const key = stab.strength || 'medium';
  let entry = smoothCache.get(stab); if (!entry) { entry = {}; smoothCache.set(stab, entry); }
  if (entry[key]) return entry[key];
  const sig = (STRENGTHS[key] || STRENGTHS.medium) * 1e6 / stab.step;
  const sx = gaussSmooth(stab.x, sig), sy = gaussSmooth(stab.y, sig), sa = gaussSmooth(stab.a, sig);
  const n = stab.n, cx = new Float32Array(n), cy = new Float32Array(n), ca = new Float32Array(n);
  const need = [];
  for (let i = 0; i < n; i++) {
    cx[i] = sx[i] - stab.x[i]; cy[i] = sy[i] - stab.y[i]; ca[i] = sa[i] - stab.a[i];
    // zoom that hides the edges for this frame's shift + turn (aspect-agnostic, a little generous)
    need.push(1 + 2 * Math.max(Math.abs(cx[i]), Math.abs(cy[i])) + 1.2 * Math.abs(ca[i]));
  }
  need.sort((p, q) => p - q);
  const zoom = Math.min(ZOOM_CAP, need.length ? need[Math.floor((need.length - 1) * 0.98)] : 1);   // ignore the worst 2%
  entry[key] = { cx, cy, ca, zoom };
  return entry[key];
}
// Correction at source time srcUs: { x, y, a, z } (fractions of frame / radians / zoom), or null.
export function stabAt(stab, srcUs, exact = false) {
  if (!stab || !stab.on || !stab.n || !stab.x) return null;
  const c = corrections(stab);
  // the frame on screen at srcUs is the last one starting at or before it
  let i;
  if (Array.isArray(stab.ts)) {
    const ts = stab.ts, t = srcUs + (exact ? 1500 : 500);
    let lo = 0, hi = ts.length - 1;
    if (t <= ts[0]) i = 0; else if (t >= ts[hi]) i = hi;
    else { while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; } i = lo; }
  } else i = Math.max(0, Math.min(stab.n - 1, Math.round((srcUs - stab.t0) / stab.step)));
  return { x: c.cx[i], y: c.cy[i], a: c.ca[i], z: c.zoom };
}
// Does the analysis cover the clip's current range? (trimmed wider after analysing = re-analyse)
export function stabCovers(stab, clip) {
  if (!stab || !stab.n) return false;
  return clip.inUs >= stab.t0 - stab.step && clip.outUs <= stab.t0 + stab.step * (stab.n + 1);
}
