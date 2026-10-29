// keyframes.js · RoughCut (v0.45)
// Values that change over time. A clip may carry `kf`: a list of keys
//   [{ t, ...values }]   t = SOURCE microseconds (like beat markers), so keys stay
// on the same moment of the footage when the clip is trimmed, moved or sped up.
// Between keys the value eases (cubic in-out; never linear, per the editing rules).
// Before the first key / after the last, the end key holds.
//
// Main-track clips key the framing: x, y, scale (zoom). Overlay (PiP) clips key
// x, y, s (size) and o (opacity). Pure; no DOM.

import { stabAt } from './stabilize.js';

export const MAIN_KEYS = ['x', 'y', 'scale'];
export const OV_KEYS = ['x', 'y', 's', 'o'];
export const KEY_SNAP_US = 50_000;   // a key within 50 ms of the playhead is "the key here"

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const hasKeys = (c) => !!(c && Array.isArray(c.kf) && c.kf.length);

// Interpolated values at source time srcUs. base supplies any prop a key lacks.
export function valuesAt(kf, srcUs, base, props) {
  const out = {}; for (const p of props) out[p] = base[p];
  if (!Array.isArray(kf) || !kf.length) return out;
  const keys = kf;   // kept sorted by t
  const pick = (k) => { for (const p of props) if (k[p] != null) out[p] = k[p]; };
  if (srcUs <= keys[0].t) { pick(keys[0]); return out; }
  const last = keys[keys.length - 1];
  if (srcUs >= last.t) { pick(last); return out; }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (srcUs >= a.t && srcUs <= b.t) {
      const f = easeInOut(b.t > a.t ? (srcUs - a.t) / (b.t - a.t) : 1);
      for (const p of props) {
        const va = a[p] != null ? a[p] : base[p], vb = b[p] != null ? b[p] : base[p];
        out[p] = va + (vb - va) * f;
      }
      return out;
    }
  }
  return out;
}

export function keyIndexNear(kf, srcUs, tolUs = KEY_SNAP_US) {
  if (!Array.isArray(kf)) return -1;
  let best = -1, bd = Infinity;
  kf.forEach((k, i) => { const d = Math.abs(k.t - srcUs); if (d <= tolUs && d < bd) { bd = d; best = i; } });
  return best;
}
// Returns a NEW sorted array with a key at srcUs set to vals (merging into one already there).
export function upsertKey(kf, srcUs, vals, tolUs = KEY_SNAP_US) {
  const arr = Array.isArray(kf) ? kf.map((k) => ({ ...k })) : [];
  const i = keyIndexNear(arr, srcUs, tolUs);
  if (i >= 0) Object.assign(arr[i], vals);
  else arr.push({ t: Math.round(srcUs), ...vals });
  arr.sort((a, b) => a.t - b.t);
  return arr;
}
export function removeKeyAt(kf, srcUs, tolUs = KEY_SNAP_US) {
  const i = keyIndexNear(kf, srcUs, tolUs); if (i < 0) return kf;
  const arr = kf.slice(); arr.splice(i, 1);
  return arr;
}
// Neighbouring key times (source us) for prev/next stepping.
export function nextKeyT(kf, srcUs, dir) {
  if (!Array.isArray(kf) || !kf.length) return null;
  if (dir > 0) { for (const k of kf) if (k.t > srcUs + 1000) return k.t; return null; }
  for (let i = kf.length - 1; i >= 0; i--) if (kf[i].t < srcUs - 1000) return kf[i].t;
  return null;
}

// ---- live (uncommitted) overrides while a finger or slider is moving ----
// Kept outside the project so nothing half-finished is ever saved.
const live = new Map();   // clipId -> partial values
export function setLive(id, vals) { live.set(id, { ...(live.get(id) || {}), ...vals }); }
export function getLive(id) { return live.get(id) || null; }
export function clearLive(id) { live.delete(id); }

// Main-track clip as it should draw at source time srcUs: xf with keyed x/y/scale + live edits.
export function clipAt(clip, srcUs, frameUs = null) {   // frameUs: timestamp of the decoded frame actually drawn (stabilise)
  if (!clip) return clip;
  const lv = live.get(clip.id);
  const st = clip.stab && clip.stab.on ? stabAt(clip.stab, frameUs != null ? frameUs : srcUs, frameUs != null) : null;   // v0.47
  if (!hasKeys(clip) && !lv) return st ? { ...clip, _stab: st } : clip;
  const xf = { x: 0, y: 0, scale: 1, rot: 0, ...(clip.xf || {}) };
  const v = hasKeys(clip) ? valuesAt(clip.kf, srcUs, xf, MAIN_KEYS) : { x: xf.x, y: xf.y, scale: xf.scale };
  if (lv) Object.assign(v, lv);
  return { ...clip, xf: { ...xf, x: v.x, y: v.y, scale: v.scale }, ...(st ? { _stab: st } : {}) };
}

// Local timeline offset (us) of a key on its clip, for drawing diamonds.
export function keyTlUs(clip, k) { const sp = clip.speed || 1; return clip.tlStartUs + Math.round((k.t - clip.inUs) / sp); }
