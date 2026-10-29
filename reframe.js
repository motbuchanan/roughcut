// reframe.js · RoughCut (v0.49)
// Follow person: turn wide footage into a tall frame (or any narrower one) by
// keeping the person in shot. Uses the same on-device person model as "Cut out
// person" (cutout.js), so there is nothing new to download. Samples the clip a
// few times a second, finds the main person, steadies that path, and writes
// ordinary position keyframes on the clip (framing set to Fill). The result is
// editable like any keys: drag the picture at a moment to fix it.
//
// Editing rules applied: hold, don't ride (the frame only moves when the person
// leaves a dead zone, then eases across); head near the top third line.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './mediabunny.js';
import { personMask } from './cutout.js';
import { frameScale, fitBox, frameOf } from './frame.js';

export const SAMPLE_FPS = 3;
export const DEAD_ZONE = 0.12;     // share of the visible width the person may drift before the frame follows
export const MOVE_S = 0.7;         // how long one re-frame move takes
export const HEAD_Y = 0.14;        // top of the head sits this far down the frame
const S = 256;

// The selfie model wants the person big in a square picture, so a wide (or tall) frame is
// looked at as overlapping squares along its long side and the masks are merged.
let wide = null, tile = null;
export async function personMap(img, fw, fh) {
  const long = Math.max(fw, fh), short = Math.min(fw, fh), across = fw >= fh;
  const ratio = long / short;
  const n = ratio < 1.1 ? 1 : Math.ceil(ratio) + 1;
  const MW = across ? Math.round(S * ratio) : S, MH = across ? S : Math.round(S * ratio);
  wide = wide || document.createElement('canvas');
  if (wide.width !== MW || wide.height !== MH) { wide.width = MW; wide.height = MH; }
  const wx = wide.getContext('2d', { willReadFrequently: true });
  wx.globalCompositeOperation = 'source-over'; wx.clearRect(0, 0, MW, MH);
  tile = tile || document.createElement('canvas');
  if (tile.width !== short) { tile.width = short; tile.height = short; }
  const tx = tile.getContext('2d');
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? (long - short) / 2 : (long - short) * i / (n - 1);
    tx.clearRect(0, 0, short, short);
    if (across) tx.drawImage(img, off, 0, short, short, 0, 0, short, short); else tx.drawImage(img, 0, off, short, short, 0, 0, short, short);
    const m = await personMask(tile, short, short, 0);
    wx.globalCompositeOperation = 'lighter';
    const o = off / short * S;
    if (across) wx.drawImage(m, o, 0, S, S); else wx.drawImage(m, 0, o, S, S);
  }
  wx.globalCompositeOperation = 'source-over';
  return wide;
}

// Where is the main person in this mask? -> { cx, top } as 0..1 fractions of the frame, or null.
// Several people: the biggest one wins (column runs of the mask), and its head sets x.
export function locate(maskCanvas) {
  const W = maskCanvas.width, H = maskCanvas.height;
  const d = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const A = (x, y) => d[(y * W + x) * 4 + 3] / 255;
  const col = new Float32Array(W);
  let total = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = A(x, y); if (a > 0.3) { col[x] += a; total += a; } }
  if (total < W * H * 0.006) return null;
  // contiguous column runs; keep the heaviest
  const thr = H * 0.02;
  let best = null, run = null;
  for (let x = 0; x <= W; x++) {
    const on = x < W && col[x] > thr;
    if (on) { if (!run) run = { a: x, b: x, m: 0 }; run.b = x; run.m += col[x]; }
    else if (run) { if (!best || run.m > best.m) best = run; run = null; }
  }
  if (!best) return null;
  // head: the first rows of that run with real coverage, centre of the top 18% of the body
  const rows = new Float32Array(H);
  for (let y = 0; y < H; y++) for (let x = best.a; x <= best.b; x++) { const a = A(x, y); if (a > 0.3) rows[y] += a; }
  let top = -1; for (let y = 0; y < H; y++) if (rows[y] > 2) { top = y; break; }
  if (top < 0) return null;
  let bottom = H - 1; for (let y = H - 1; y >= 0; y--) if (rows[y] > 2) { bottom = y; break; }
  const band = Math.max(4, Math.round((bottom - top) * 0.18));
  let m = 0, sx = 0;
  for (let y = top; y < Math.min(H, top + band); y++) for (let x = best.a; x <= best.b; x++) { const a = A(x, y); if (a > 0.3) { m += a; sx += a * (x + 0.5); } }
  return { cx: m ? sx / m / W : (best.a + best.b + 1) / 2 / W, top: top / H };
}

// Pure planning from located samples -> keys. Exported for tests.
// pts: [{ t, loc }] (loc may be null); geometry from framing(). Returns [{ t, x, y }].
export function planKeys(pts, g, outUs) {
  if (!pts.length) return [];
  let last = null;
  for (const p of pts) { if (p.loc) last = p.loc; else if (last) p.loc = last; }
  last = null;
  for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].loc) last = pts[i].loc; else if (last) pts[i].loc = last; }
  for (const p of pts) if (!p.loc) p.loc = { cx: 0.5, top: 0.2 };
  // a 3-sample median removes one-off jumps (a raised arm, someone walking past)
  const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
  const win = (i, f) => med(pts.slice(Math.max(0, i - 1), i + 2).map((q) => f(q.loc)));
  const cxs = pts.map((p, i) => win(i, (l) => l.cx));
  const tops = pts.map((p, i) => win(i, (l) => l.top));
  const y = g.toY(med(tops));   // head height barely changes; one height for the clip keeps it calm
  const keys = [];
  let cur = cxs[0];
  keys.push({ t: pts[0].t, x: g.toX(cur), y });
  const still = 0.012;   // per-sample change below this counts as standing still
  let lastIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(cxs[i] - cur) <= DEAD_ZONE * g.visW) continue;
    // the move starts when they started walking, and ends when they settle
    let b = i; while (b - 1 > lastIdx && Math.abs(cxs[b - 1] - cxs[b - 2 >= 0 ? b - 2 : 0]) > still) b--;
    b = Math.max(lastIdx, b - 1);
    let e = i; while (e + 2 < pts.length && !(Math.abs(cxs[e + 1] - cxs[e]) < still && Math.abs(cxs[e + 2] - cxs[e + 1]) < still)) e++;
    if (e + 2 >= pts.length) e = pts.length - 1;
    const target = cxs[e];
    const prev = keys[keys.length - 1];
    const t0 = Math.max(prev.t + 1000, pts[b].t);
    if (t0 - prev.t > 150_000) keys.push({ t: Math.round(t0), x: g.toX(cur), y });   // hold until the move starts
    const t1 = Math.round(Math.min(outUs, Math.max(pts[e].t, t0 + MOVE_S * 1e6)));
    if (t1 > keys[keys.length - 1].t + 1000) keys.push({ t: t1, x: g.toX(target), y });
    cur = target; lastIdx = e;
    while (i + 1 < pts.length && pts[i + 1].t <= t1) i++;
  }
  // drop keys that change nothing (a hold at the same spot as the key before)
  const out = [];
  for (const k of keys) {
    const r = { t: k.t, x: +k.x.toFixed(4), y: +k.y.toFixed(4) };
    const p = out[out.length - 1], pp = out[out.length - 2];
    if (p && pp && p.x === r.x && pp.x === r.x && p.y === r.y) { p.t = r.t; continue; }
    out.push(r);
  }
  if (out.length === 2 && out[0].x === out[1].x && out[0].y === out[1].y) out.pop();
  return out;
}

// Geometry for a source of mw x mh, Fill-framed on W x H with the clip's zoom.
export function framing(mw, mh, W, H, clip) {
  const f = frameOf(clip);
  const box = fitBox(mw, mh, W, H);
  const { s, rw, rh } = frameScale(W, H, box.w, box.h, { fit: 'fill', xf: { scale: f.scale, rot: f.rot } });
  const imgW = rw * s, imgH = rh * s;
  const limX = Math.max(0, (imgW - W) / 2 / W), limY = Math.max(0, (imgH - H) / 2 / H);
  const flip = f.rot === 180 ? -1 : 1;
  const clamp = (v, l) => Math.max(-l, Math.min(l, v));
  return {
    visW: Math.min(1, W / imgW), limX, limY,
    toX: (cx) => clamp(flip * (0.5 - cx) * imgW / W, limX),
    // picture top on canvas = H/2 + yH - imgH/2; want the head at HEAD_Y * H
    toY: (top) => clamp((HEAD_Y * H - H / 2 + imgH / 2 - (flip > 0 ? top : 1 - top) * imgH) / H, limY),
  };
}

export const reframeUseful = (mw, mh, W, H) => Math.abs(mw / mh - W / H) > 0.05;

// Measure one main-track clip. Returns { kf, found, samples }; found = share of samples with a person.
export async function analyseReframe(file, media, clip, W, H, onProgress, isCancelled) {
  const f = frameOf(clip);
  if (f.rot === 90 || f.rot === 270) throw new Error('Turn the clip upright first, then follow the person.');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('This clip has no video to follow.');
    const mw = media.w || vt.displayWidth || 1920, mh = media.h || vt.displayHeight || 1080;
    const aw = mw >= mh ? Math.round(S * mw / mh) : S, ah = mw >= mh ? S : Math.round(S * mh / mw);
    const sink = new CanvasSink(vt, { width: aw, height: ah, fit: 'fill' });
    const step = 1e6 / SAMPLE_FPS;
    const ts = []; for (let t = clip.inUs; t < clip.outUs - 1000; t += step) ts.push(t);
    if (!ts.length) ts.push(clip.inUs);
    const pts = [];
    let k = 0;
    for await (const wr of sink.canvasesAtTimestamps(ts.map((t) => t / 1e6))) {
      if (isCancelled && isCancelled()) throw new DOMException('Follow person cancelled', 'AbortError');
      const loc = wr ? locate(await personMap(wr.canvas, aw, ah)) : null;
      pts.push({ t: ts[k], loc });
      k++;
      if (onProgress) onProgress(k / ts.length);
      if (k >= ts.length) break;
    }
    const found = pts.filter((p) => p.loc).length / Math.max(1, pts.length);
    const kf = planKeys(pts, framing(mw, mh, W, H, clip), clip.outUs);
    return { kf, found, samples: pts.length };
  } finally { try { input.dispose(); } catch (_) {} }
}
