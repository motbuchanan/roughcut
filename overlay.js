// overlay.js · RoughCut (v0.45)
// Picture-in-picture: a second video or a still laid over the main picture, on
// its own lane (track 'o1'). Free-positioned on the timeline like music. Each
// overlay has a base look `ov` and optional keyframes `kf` (x, y, s, o) so it
// can slide in, grow or fade over time. One draw routine for preview + export.
// Overlays are silent (their own sound is not mixed). Pure; no DOM at import.
//
//   ov = { x, y, s, o, round, fade }
//     x, y  : centre, as a fraction of canvas width / height
//     s     : width as a fraction of canvas width
//     o     : opacity 0..1
//     round : rounded corners (default on)
//     fade  : 0.3 s fade in and out at the overlay's ends (default off)

import { uid, clipDurUs } from './state.js';
import { valuesAt, OV_KEYS, getLive, hasKeys } from './keyframes.js';

export const OV_DEFAULT = { x: 0.7, y: 0.27, s: 0.42, o: 1, round: true, fade: false };
export const OV_FADE_US = 300_000;
export const S_MIN = 0.1, S_MAX = 1;
export const DEFAULT_STILL_US = 4_000_000;

export function overlayTrack(project) {
  let t = project.tracks.find((x) => x.id === 'o1');
  if (!t) { t = { id: 'o1', kind: 'overlay', clips: [] }; project.tracks.push(t); }
  if (!t.clips) t.clips = [];
  return t;
}
export const ovOf = (clip) => ({ ...OV_DEFAULT, ...((clip && clip.ov) || {}) });

export function makeOverlayClip(media, tlStartUs) {
  const dur = media.kind === 'image' ? DEFAULT_STILL_US : (media.durUs || DEFAULT_STILL_US);
  return { id: uid('o'), mediaId: media.id, tlStartUs: Math.max(0, tlStartUs || 0), inUs: 0, outUs: dur, speed: 1, ov: { ...OV_DEFAULT } };
}
export function addOverlayCmd(project, media, atUs) {
  const t = overlayTrack(project);
  const clip = makeOverlayClip(media, atUs);
  return {
    label: 'Add overlay',
    do() { t.clips.push(clip); t.clips.sort((a, b) => a.tlStartUs - b.tlStartUs); return clip.id; },
    undo() { const i = t.clips.findIndex((c) => c.id === clip.id); if (i >= 0) t.clips.splice(i, 1); },
  };
}

// Overlays on screen at timeline time tlUs (in lane order; later ones draw on top).
export function overlaysAt(project, tlUs, totalUs = Infinity) {
  const t = project.tracks.find((x) => x.id === 'o1');
  if (!t || !t.clips || tlUs >= totalUs) return [];
  return t.clips.filter((c) => tlUs >= c.tlStartUs && tlUs < c.tlStartUs + clipDurUs(c));
}
export const ovSrcUs = (clip, tlUs) => clip.inUs + Math.round((tlUs - clip.tlStartUs) * (clip.speed || 1));

// Resolved look at timeline time: base -> keys -> live edit -> end fades.
export function ovStateAt(clip, tlUs) {
  const base = ovOf(clip);
  const src = ovSrcUs(clip, tlUs);
  const v = hasKeys(clip) ? valuesAt(clip.kf, src, base, OV_KEYS) : { x: base.x, y: base.y, s: base.s, o: base.o };
  const lv = getLive(clip.id); if (lv) Object.assign(v, lv);
  let o = Math.max(0, Math.min(1, v.o));
  if (base.fade) {
    const local = tlUs - clip.tlStartUs, left = clip.tlStartUs + clipDurUs(clip) - tlUs;
    o *= Math.min(1, local / OV_FADE_US, left / OV_FADE_US);
  }
  return { x: v.x, y: v.y, s: Math.max(S_MIN, Math.min(S_MAX, v.s)), o: Math.max(0, o), round: base.round, src };
}

// Box on a W x H canvas for a fw x fh picture at state st.
export function ovRect(W, H, fw, fh, st) {
  const w = st.s * W, h = w * (fh > 0 && fw > 0 ? fh / fw : 9 / 16);
  return { x: st.x * W - w / 2, y: st.y * H - h / 2, w, h };
}
function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
// Draw one overlay picture. Returns its box (canvas px) for tap/drag hit tests.
export function drawOverlay(ctx, W, H, img, fw, fh, st, keyed = false) {
  const r = ovRect(W, H, fw, fh, st);
  if (!img || st.o <= 0.001) return r;
  if (keyed) {   // green-screened: just the cut-out, no box, no corners (v0.46)
    ctx.save(); ctx.globalAlpha *= st.o; ctx.drawImage(img, r.x, r.y, r.w, r.h); ctx.restore();
    return r;
  }
  const rad = st.round ? Math.min(r.w, r.h) * 0.08 : 0;
  ctx.save();
  ctx.globalAlpha *= st.o;
  // soft shadow so the inset reads against busy footage
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = Math.round(W * 0.02); ctx.shadowOffsetY = Math.round(W * 0.006);
  ctx.fillStyle = '#000';
  if (rad) { roundedPath(ctx, r.x, r.y, r.w, r.h, rad); ctx.fill(); } else ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.shadowColor = 'transparent';
  if (rad) { roundedPath(ctx, r.x, r.y, r.w, r.h, rad); ctx.clip(); }
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.restore();
  return r;
}
