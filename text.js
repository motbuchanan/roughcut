// text.js · RoughCut (M4 + v0.26 text animations / fonts / stroke+glow)
// Text items: model defaults, undoable commands, and the ONE draw routine that
// both the draft preview and the export use. Everything is in canvas fractions
// (x, y, size) so the same item renders identically at 405x720 draft and
// 1080x1920 export. Motion (textAnimAt) is a pure function of local time, applied
// as a canvas transform by the caller, so preview and export animate identically.
// No DOM at import time.

import { US, uid } from './state.js';

export const TEXT_DEFAULT_US = 3 * US;
export const TEXT_MIN_US = 300_000;

// System fonts cost 0 bytes; the display faces are bundled woff2 (SIL OFL) so a
// title looks the same offline on any phone instead of falling back silently.
// `id:'hand'` is kept for back-compat with older projects (now Caveat, a marker face).
export const FONTS = [
  { id: 'sans',   label: 'Sans',   css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif',  label: 'Serif',  css: 'Georgia, "Times New Roman", serif' },
  { id: 'impact', label: 'Impact', css: '"Anton", Impact, system-ui, sans-serif', fixedWeight: '400', bundled: 'Anton' },
  { id: 'tall',   label: 'Tall',   css: '"Bebas Neue", Oswald, system-ui, sans-serif', fixedWeight: '400', bundled: 'Bebas Neue' },
  { id: 'mono',   label: 'Mono',   css: 'ui-monospace, "Roboto Mono", Menlo, monospace' },
  { id: 'hand',   label: 'Marker', css: '"Caveat", "Segoe Script", cursive', fixedWeight: '400', bundled: 'Caveat' },
  { id: 'spook',  label: 'Spooky', css: '"Creepster", system-ui, cursive', fixedWeight: '400', bundled: 'Creepster' },
];

// Load any bundled webfonts before drawing, so the preview and the export both
// render them instead of silently falling back to a system font. Idempotent.
let _fontsReady = null;
export function ensureFonts() {
  if (_fontsReady) return _fontsReady;
  const bundled = [...new Set(FONTS.filter((f) => f.bundled).map((f) => f.bundled))];
  if (typeof document === 'undefined' || !document.fonts || !bundled.length) {
    _fontsReady = Promise.resolve();
    return _fontsReady;
  }
  _fontsReady = Promise.all(
    bundled.map((fam) => document.fonts.load(`400 64px "${fam}"`).catch(() => {}))
  ).then(() => {});
  return _fontsReady;
}

export const SIZES = [
  { id: 's',  label: 'S',  v: 0.035 },
  { id: 'm',  label: 'M',  v: 0.05 },
  { id: 'l',  label: 'L',  v: 0.075 },
  { id: 'xl', label: 'XL', v: 0.11 },
];
export const COLORS = ['#ffffff', '#111111', '#ff7a2f', '#ffd23f', '#3fd0ff', '#ff4b6e', '#6cff8a'];
export const BG_MODES = ['none', 'pill', 'band'];

// ---- animation presets --------------------------------------------------
// One per-item preset drives both an entrance and an exit (CapCut-style). The
// pure textAnimAt() below returns alpha/scale/offset/reveal; the caller applies it.
export const ANIMS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop',  label: 'Pop' },
  { id: 'rise', label: 'Rise' },
  { id: 'type', label: 'Type' },
];
const ANIM_IN_US = 450_000;
const ANIM_OUT_US = 350_000;
const REST = { alpha: 1, scale: 1, dxFrac: 0, dyFrac: 0, reveal: null };

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function easeOutCubic(p) { p = clamp01(p); return 1 - Math.pow(1 - p, 3); }
function easeOutBack(p) { p = clamp01(p); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }

// Visible character count for the typewriter reveal at progress p (0..1).
export function revealCount(item, p) {
  const n = String(item.text || '').length;
  return Math.max(0, Math.min(n, Math.ceil(n * clamp01(p))));
}

// Pure: alpha/scale/offset/reveal for an item at local time (us since its start).
// Offsets are FRACTIONS of canvas W/H so the caller (which knows px size) scales them.
export function textAnimAt(item, tLocalUs) {
  const a = (item && item.anim) || 'none';
  if (a === 'none') return REST;
  const D = Math.max(1, textDurUs(item));
  const tl = Math.max(0, Math.min(D, tLocalUs || 0));
  const inDur = Math.min(ANIM_IN_US, D * 0.45);
  const outDur = Math.min(ANIM_OUT_US, D * 0.45);
  const pin = inDur > 0 ? clamp01(tl / inDur) : 1;
  const pout = outDur > 0 ? clamp01((D - tl) / outDur) : 1;
  const ei = easeOutCubic(pin), eo = easeOutCubic(pout);
  const r = { alpha: 1, scale: 1, dxFrac: 0, dyFrac: 0, reveal: null };
  switch (a) {
    case 'fade': r.alpha = Math.min(ei, eo); break;
    case 'pop':  r.alpha = Math.min(ei, eo); r.scale = easeOutBack(pin); break;
    case 'rise': r.alpha = Math.min(ei, eo); r.dyFrac = (1 - ei) * 0.07; break;  // starts 7% of H low, eases up
    case 'type': r.alpha = eo; r.reveal = revealCount(item, pin); break;
    default: return REST;
  }
  return r;
}

export function textTrack(project) {
  let t = project.tracks.find((x) => x.id === 't1');
  if (!t) { t = { id: 't1', kind: 'text', items: [] }; project.tracks.push(t); }
  if (!t.items) t.items = [];
  return t;
}

export function makeText(tlStartUs, opts = {}) {
  return {
    id: uid('t'), kind: 'text',
    text: opts.text ?? 'Your text',
    tlStartUs: Math.max(0, tlStartUs || 0), inUs: 0, outUs: opts.durUs ?? TEXT_DEFAULT_US,
    x: opts.x ?? 0.5, y: opts.y ?? 0.8,       // anchor: center of the text block, canvas fractions
    size: opts.size ?? 0.05,                   // line height as a fraction of canvas height
    color: opts.color ?? '#ffffff',
    bg: opts.bg ?? 'none',                     // 'none' | 'pill' | 'band'
    bgColor: opts.bgColor ?? '#000000',
    align: opts.align ?? 'center',
    font: opts.font ?? 'sans',
    bold: opts.bold ?? true,
    shadow: opts.shadow ?? true,
    anim: opts.anim ?? 'none',                 // 'none' | 'fade' | 'pop' | 'rise' | 'type'
    outline: opts.outline ?? false,            // black stroke for readability over busy video
    outlineColor: opts.outlineColor ?? '#000000',
    glow: opts.glow ?? false,                  // colored halo
    glowColor: opts.glowColor ?? '#ffffff',
  };
}

export function textDurUs(t) { return Math.max(0, t.outUs - t.inUs); }
export function textsAt(project, tlUs) {
  return textTrack(project).items.filter((t) => tlUs >= t.tlStartUs && tlUs < t.tlStartUs + textDurUs(t));
}
function sortItems(t) { t.items.sort((a, b) => a.tlStartUs - b.tlStartUs); }

// ---- commands ----
export function addTextCmd(project, item) {
  const t = textTrack(project);
  return {
    label: 'Add text',
    do() { t.items.push(item); sortItems(t); return item.id; },
    undo() { const i = t.items.findIndex((x) => x.id === item.id); if (i >= 0) t.items.splice(i, 1); },
  };
}
export function removeTextCmd(project, id) {
  const t = textTrack(project);
  let removed = null, idx = -1;
  return {
    label: 'Remove text',
    do() { idx = t.items.findIndex((x) => x.id === id); if (idx >= 0) removed = t.items.splice(idx, 1)[0]; },
    undo() { if (removed && idx >= 0) t.items.splice(idx, 0, removed); },
  };
}
// Generic property set (text, size, color, x, y, tlStartUs, outUs, anim, outline, ...). One undo step.
export function setTextCmd(project, id, props, label = 'Edit text') {
  const t = textTrack(project);
  let old = null;
  return {
    label,
    do() { const it = t.items.find((x) => x.id === id); if (!it) return; old = {}; for (const k of Object.keys(props)) old[k] = it[k]; Object.assign(it, props); sortItems(t); },
    undo() { const it = t.items.find((x) => x.id === id); if (it && old) { Object.assign(it, old); sortItems(t); } },
  };
}
export function duplicateTextCmd(project, id) {
  const t = textTrack(project);
  let copy = null;
  return {
    label: 'Duplicate text',
    do() {
      const it = t.items.find((x) => x.id === id); if (!it) return null;
      copy = { ...JSON.parse(JSON.stringify(it)), id: uid('t'), tlStartUs: it.tlStartUs + textDurUs(it) };
      t.items.push(copy); sortItems(t); return copy.id;
    },
    undo() { const i = t.items.findIndex((x) => copy && x.id === copy.id); if (i >= 0) t.items.splice(i, 1); },
  };
}

// ---- drawing (shared by preview + export) ----
export function fontCss(item, H) {
  const f = FONTS.find((x) => x.id === item.font) || FONTS[0];
  const px = Math.max(8, Math.round(item.size * H));
  const weight = f.fixedWeight || (item.bold ? '700' : '400');
  return { font: `${weight} ${px}px ${f.css}`, px };
}

// Layout: returns { lines, px, lineH, blockW, blockH, left, top, padX, padY } in canvas px.
export function layoutText(ctx, W, H, item) {
  const { font, px } = fontCss(item, H);
  ctx.font = font;
  const lines = String(item.text || '').split('\n');
  const lineH = Math.round(px * 1.22);
  let blockW = 0;
  for (const l of lines) blockW = Math.max(blockW, ctx.measureText(l || ' ').width);
  const maxW = W * 0.92;
  // soft-wrap any line wider than the canvas (word-based)
  if (blockW > maxW) {
    const out = [];
    for (const l of lines) {
      if (ctx.measureText(l).width <= maxW) { out.push(l); continue; }
      let cur = '';
      for (const w of l.split(' ')) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width <= maxW || !cur) cur = test; else { out.push(cur); cur = w; }
      }
      if (cur) out.push(cur);
    }
    lines.length = 0; lines.push(...out);
    blockW = 0; for (const l of lines) blockW = Math.max(blockW, ctx.measureText(l || ' ').width);
  }
  const blockH = lineH * lines.length;
  const padX = Math.round(px * 0.45), padY = Math.round(px * 0.22);
  const left = Math.round(item.x * W - blockW / 2);
  const top = Math.round(item.y * H - blockH / 2);
  return { lines, px, lineH, blockW, blockH, left, top, padX, padY };
}

// Draw one item. `reveal` (number) truncates the text for the typewriter animation.
export function drawText(ctx, W, H, item, reveal) {
  const useItem = (typeof reveal === 'number')
    ? Object.assign({}, item, { text: String(item.text || '').slice(0, reveal) })
    : item;
  const L = layoutText(ctx, W, H, useItem);
  ctx.save();
  ctx.textBaseline = 'top';
  // background plate
  if (item.bg === 'band') {
    ctx.fillStyle = withAlpha(item.bgColor || '#000000', 0.62);
    ctx.fillRect(0, L.top - L.padY, W, L.blockH + L.padY * 2);
  } else if (item.bg === 'pill') {
    ctx.fillStyle = withAlpha(item.bgColor || '#000000', 0.72);
    roundRect(ctx, L.left - L.padX, L.top - L.padY, L.blockW + L.padX * 2, L.blockH + L.padY * 2, Math.round(L.px * 0.35));
    ctx.fill();
  }
  ctx.textAlign = item.align || 'center';
  const ax = item.align === 'left' ? L.left : item.align === 'right' ? L.left + L.blockW : L.left + L.blockW / 2;
  const outline = !!item.outline;
  const glow = !!item.glow;
  const softDrop = item.shadow && item.bg === 'none' && !outline && !glow;
  const strokeW = Math.max(2, Math.round(L.px * 0.14));
  for (let i = 0; i < L.lines.length; i++) {
    const y = L.top + i * L.lineH;
    // stroke pass first (it carries the glow halo when both are on)
    if (outline) {
      ctx.save();
      if (glow) { ctx.shadowColor = item.glowColor || '#ffffff'; ctx.shadowBlur = Math.round(L.px * 0.55); }
      ctx.lineWidth = strokeW; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.strokeStyle = item.outlineColor || '#000000';
      ctx.strokeText(L.lines[i], ax, y);
      ctx.restore();
    }
    // fill pass
    ctx.save();
    if (glow && !outline) { ctx.shadowColor = item.glowColor || '#ffffff'; ctx.shadowBlur = Math.round(L.px * 0.55); }
    else if (softDrop) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = Math.round(L.px * 0.18); ctx.shadowOffsetY = Math.round(L.px * 0.06); }
    ctx.fillStyle = item.color || '#fff';
    ctx.fillText(L.lines[i], ax, y);
    ctx.restore();
  }
  ctx.restore();
  return L;
}

// Every text item active at tlUs, drawn in track order, with its animation applied.
// opts.staticId: render that one item at rest (used while it is being edited so the
// preview is stable to position/style). Returns resting hit boxes for the drag layer.
export function drawTextsAt(ctx, W, H, project, tlUs, opts = {}) {
  const boxes = [];
  for (const it of textsAt(project, tlUs)) {
    // resting layout = a stable hit box regardless of animation phase
    const L0 = layoutText(ctx, W, H, it);
    boxes.push({ id: it.id, x0: L0.left - L0.padX, y0: L0.top - L0.padY, x1: L0.left + L0.blockW + L0.padX, y1: L0.top + L0.blockH + L0.padY });
    const a = (opts.staticId === it.id) ? REST : textAnimAt(it, tlUs - it.tlStartUs);
    if (a.alpha <= 0.001) continue;              // fully hidden this frame; box stays for dragging
    ctx.save();
    ctx.globalAlpha *= a.alpha;
    if (a.scale !== 1 || a.dxFrac || a.dyFrac) {
      const cx = it.x * W, cy = it.y * H;
      ctx.translate(cx + (a.dxFrac || 0) * W, cy + (a.dyFrac || 0) * H);
      if (a.scale !== 1) ctx.scale(a.scale, a.scale);
      ctx.translate(-cx, -cy);
    }
    drawText(ctx, W, H, it, (typeof a.reveal === 'number') ? a.reveal : undefined);
    ctx.restore();
  }
  return boxes;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
