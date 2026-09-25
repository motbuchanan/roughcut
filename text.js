// text.js · RoughCut (M4)
// Text items: model defaults, undoable commands, and the ONE draw routine that
// both the draft preview and (M5) the export use. Everything is in canvas
// fractions (x, y, size) so the same item renders identically at 405x720 draft
// and 1080x1920 export. No DOM at import time.

import { US, uid } from './state.js';

export const TEXT_DEFAULT_US = 3 * US;
export const TEXT_MIN_US = 300_000;

export const FONTS = [
  { id: 'sans',  label: 'Sans',  css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono',  label: 'Mono',  css: 'ui-monospace, "Roboto Mono", Menlo, monospace' },
  { id: 'hand',  label: 'Hand',  css: '"Dancing Script", "Segoe Script", cursive' },
];
export const SIZES = [
  { id: 's',  label: 'S',  v: 0.035 },
  { id: 'm',  label: 'M',  v: 0.05 },
  { id: 'l',  label: 'L',  v: 0.075 },
  { id: 'xl', label: 'XL', v: 0.11 },
];
export const COLORS = ['#ffffff', '#111111', '#ff7a2f', '#ffd23f', '#3fd0ff', '#ff4b6e', '#6cff8a'];
export const BG_MODES = ['none', 'pill', 'band'];

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
// Generic property set (text, size, color, x, y, tlStartUs, outUs, ...). One undo step.
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
  return { font: `${item.bold ? '700' : '400'} ${px}px ${f.css}`, px };
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

export function drawText(ctx, W, H, item) {
  const L = layoutText(ctx, W, H, item);
  ctx.save();
  ctx.textBaseline = 'top';
  if (item.bg === 'band') {
    ctx.fillStyle = withAlpha(item.bgColor || '#000000', 0.62);
    ctx.fillRect(0, L.top - L.padY, W, L.blockH + L.padY * 2);
  } else if (item.bg === 'pill') {
    ctx.fillStyle = withAlpha(item.bgColor || '#000000', 0.72);
    roundRect(ctx, L.left - L.padX, L.top - L.padY, L.blockW + L.padX * 2, L.blockH + L.padY * 2, Math.round(L.px * 0.35));
    ctx.fill();
  }
  if (item.shadow && item.bg === 'none') {
    ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = Math.round(L.px * 0.18); ctx.shadowOffsetY = Math.round(L.px * 0.06);
  }
  ctx.fillStyle = item.color || '#fff';
  ctx.textAlign = item.align || 'center';
  const ax = item.align === 'left' ? L.left : item.align === 'right' ? L.left + L.blockW : L.left + L.blockW / 2;
  for (let i = 0; i < L.lines.length; i++) ctx.fillText(L.lines[i], ax, L.top + i * L.lineH);
  ctx.restore();
  return L;
}

// Every text item active at tlUs, drawn in track order. Returns hit boxes for the preview's drag.
export function drawTextsAt(ctx, W, H, project, tlUs) {
  const boxes = [];
  for (const it of textsAt(project, tlUs)) {
    const L = drawText(ctx, W, H, it);
    boxes.push({ id: it.id, x0: L.left - L.padX, y0: L.top - L.padY, x1: L.left + L.blockW + L.padX, y1: L.top + L.blockH + L.padY });
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
