// transitions.js · RoughCut
// Cut-boundary transitions on the main track (v1). A transition is stored on the
// INCOMING clip as clip.transIn = { type, durUs, dir? }, so it belongs to the cut
// between the previous clip and this one. Every type plays CENTERED on that cut:
// the window straddles the boundary and the timeline's length never changes.
//
// Two families:
//  - SINGLE-SOURCE dips (dipblack / dipwhite): one clip on screen plus a flat color
//    overlay. Nothing extra to decode.
//  - DUAL-SOURCE (cross / slide / wipe / zoom): BOTH clips are on screen across the
//    window. The outgoing clip keeps playing past its out point and the incoming
//    clip starts before its in point, using the spare footage beyond each trim
//    ("handles", like any NLE). If a clip has no spare footage there, its edge frame
//    is held instead, so the transition always completes.
//
// Pure and DOM-free: the preview and the export share every function here.

export const TRANS_DEFAULT_US = 500_000; // 0.5s
export const TRANS_MIN_US = 100_000;

// Catalog. `color` => single-source dip. `dual` => needs both clips' frames.
export const TRANSITIONS = [
  { id: 'none',     label: 'None' },
  { id: 'dipblack', label: 'Dip',   color: '#000000' },
  { id: 'dipwhite', label: 'Flash', color: '#ffffff' },
  { id: 'cross',    label: 'Cross', dual: true },
  { id: 'slide',    label: 'Slide', dual: true, dirs: true },
  { id: 'wipe',     label: 'Wipe',  dual: true, dirs: true },
  { id: 'zoom',     label: 'Zoom',  dual: true },
];
export const TRANS_DURS = [
  { id: 'fast', label: '0.3s', us: 300_000 },
  { id: 'med',  label: '0.5s', us: 500_000 },
  { id: 'slow', label: '1.0s', us: 1_000_000 },
];
export const TRANS_DIRS = ['L', 'R', 'U', 'D'];       // direction of motion
export const DIR_GLYPH = { L: '←', R: '→', U: '↑', D: '↓' };

export function transDef(type) { return TRANSITIONS.find((x) => x.id === type) || null; }
export function transColor(type) { const t = transDef(type); return (t && t.color) ? t.color : null; }
export function transLabel(type) { const t = transDef(type); return t ? t.label : 'None'; }
export function isDual(type) { const t = transDef(type); return !!(t && t.dual); }
export function hasDirs(type) { const t = transDef(type); return !!(t && t.dirs); }
export function makeTransition(type = 'dipblack', durUs = TRANS_DEFAULT_US, dir = 'L') {
  const t = { type, durUs: Math.max(TRANS_MIN_US, Math.round(durUs) || TRANS_DEFAULT_US) };
  if (hasDirs(type)) t.dir = TRANS_DIRS.includes(dir) ? dir : 'L';
  return t;
}

function dur(c) { return Math.max(0, c.outUs - c.inUs); }
function mainClips(project) {
  const t = project && project.tracks && project.tracks.find((x) => x.id === 'v1');
  return (t && t.clips) ? t.clips : [];
}

// Walk the cuts. For each incoming clip i (>0) with a transition, yield its window.
// Boundaries are summed from clip order, so this is right even before normalize().
function* windows(project) {
  const clips = mainClips(project);
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const start = acc, d = dur(c);
    acc += d;
    if (i === 0) continue;
    const tr = c.transIn;
    if (!tr || tr.type === 'none' || !transDef(tr.type)) continue;
    const prev = clips[i - 1], prevD = dur(prev);
    // half-window each side, kept inside HALF of each neighbor so two transitions
    // on one short middle clip can meet at its midpoint but never overlap.
    const half = Math.min(tr.durUs / 2, prevD / 2, d / 2);
    if (half <= 0) continue;
    yield { i, tr, start, half, a: prev, b: c, aStart: start - prevD, aDur: prevD, bDur: d };
  }
}

// ---- single-source dips (unchanged behaviour) ----
export function transitionColorAt(project, tlUs) {
  for (const w of windows(project)) {
    const color = transColor(w.tr.type);
    if (!color) continue;
    if (tlUs >= w.start - w.half && tlUs < w.start + w.half) {
      const x = (tlUs - (w.start - w.half)) / (2 * w.half);
      const alpha = 1 - Math.abs(x - 0.5) * 2;   // 0 -> 1 at the cut -> 0
      return { color, alpha: Math.max(0, Math.min(1, alpha)) };
    }
  }
  return null;
}
export function drawTransitionAt(ctx, W, H, project, tlUs) {
  const t = transitionColorAt(project, tlUs);
  if (!t || t.alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = t.alpha; ctx.fillStyle = t.color; ctx.fillRect(0, 0, W, H); ctx.restore();
}

// ---- dual-source ----
// Source times for the outgoing (A) and incoming (B) clips at timeline time tlUs.
// A runs on past its out point; B starts before its in point. Callers clamp to
// what the media actually has (see clampSrc), which turns a missing handle into a
// held edge frame.
export function dualSourceUs(w, tlUs) {
  const srcA = w.a.inUs + (tlUs - w.aStart);        // > a.outUs once past the cut
  const srcB = w.b.inUs + (tlUs - w.start);         // < b.inUs before the cut
  return { srcA, srcB };
}
export function clampSrc(us, media) {
  const max = (media && media.kind === 'video' && media.durUs) ? Math.max(0, media.durUs - 1) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(us, max));
}

// The dual transition active at tlUs, or null:
// { type, dir, x, ai, bi, a, b, srcA, srcB }  (x = 0..1 progress, ai/bi = clip indexes)
export function transitionAt(project, tlUs) {
  for (const w of windows(project)) {
    if (!isDual(w.tr.type)) continue;
    if (tlUs >= w.start - w.half && tlUs < w.start + w.half) {
      const x = (tlUs - (w.start - w.half)) / (2 * w.half);
      const { srcA, srcB } = dualSourceUs(w, tlUs);
      return { type: w.tr.type, dir: w.tr.dir || 'L', x: Math.max(0, Math.min(1, x)), ai: w.i - 1, bi: w.i, a: w.a, b: w.b, srcA, srcB };
    }
  }
  return null;
}

// Export planner. Given every output frame's timeline time, group consecutive frames
// into segments: { kind:'solo', ci, idx:[frame indexes] } or
// { kind:'dual', ai, bi, type, dir, idx:[...], xs:[...], srcA:[us...], srcB:[us...] }.
export function planFrames(project, frameTimesUs) {
  const clips = mainClips(project);
  const bounds = []; let acc = 0;
  for (const c of clips) { bounds.push(acc); acc += dur(c); }
  const total = acc;
  const soloAt = (t) => {
    for (let i = clips.length - 1; i >= 0; i--) if (t >= bounds[i]) return i;
    return clips.length ? 0 : -1;
  };
  const segs = [];
  let cur = null;
  for (let i = 0; i < frameTimesUs.length; i++) {
    const t = Math.min(frameTimesUs[i], Math.max(0, total - 1));
    const tr = transitionAt(project, t);
    if (tr) {
      const key = 'd' + tr.bi;
      if (!cur || cur.key !== key) { cur = { key, kind: 'dual', ai: tr.ai, bi: tr.bi, type: tr.type, dir: tr.dir, idx: [], xs: [], srcA: [], srcB: [] }; segs.push(cur); }
      cur.idx.push(i); cur.xs.push(tr.x); cur.srcA.push(tr.srcA); cur.srcB.push(tr.srcB);
    } else {
      const ci = soloAt(t);
      const key = 's' + ci;
      if (!cur || cur.key !== key) { cur = { key, kind: 'solo', ci, idx: [], src: [] }; segs.push(cur); }
      cur.idx.push(i);
      cur.src.push(ci >= 0 ? clips[ci].inUs + (t - bounds[ci]) : 0);
    }
  }
  return segs;
}

// ---- compositor (shared by preview + export) ----
// canvasA / canvasB are W x H canvases already holding each clip's frame
// (contain-fit, background filled). x = 0..1. Draws the blended result onto ctx.
export function drawDualTransition(ctx, W, H, type, dir, x, canvasA, canvasB) {
  x = Math.max(0, Math.min(1, x));
  const e = easeInOut(x);
  ctx.save();
  if (type === 'cross') {
    ctx.drawImage(canvasA, 0, 0);
    ctx.globalAlpha = e;
    ctx.drawImage(canvasB, 0, 0);
  } else if (type === 'slide') {
    // push: A moves out in `dir`, B follows it in from the opposite edge
    const [dx, dy] = dirVec(dir);
    const ox = Math.round(dx * e * W), oy = Math.round(dy * e * H);
    ctx.drawImage(canvasA, ox, oy);
    ctx.drawImage(canvasB, ox - dx * W, oy - dy * H);
  } else if (type === 'wipe') {
    // B is revealed behind a straight edge that travels in `dir`
    ctx.drawImage(canvasA, 0, 0);
    ctx.beginPath();
    if (dir === 'L') ctx.rect(Math.round(W * (1 - e)), 0, W, H);
    else if (dir === 'R') ctx.rect(0, 0, Math.round(W * e), H);
    else if (dir === 'U') ctx.rect(0, Math.round(H * (1 - e)), W, H);
    else ctx.rect(0, 0, W, Math.round(H * e));
    ctx.clip();
    ctx.drawImage(canvasB, 0, 0);
  } else if (type === 'zoom') {
    // cross-zoom: A grows and fades out while B settles in from slightly large
    const sA = 1 + 0.25 * e, sB = 1.25 - 0.25 * e;
    ctx.globalAlpha = 1;
    drawScaled(ctx, canvasA, W, H, sA);
    ctx.globalAlpha = e;
    drawScaled(ctx, canvasB, W, H, sB);
  } else {
    ctx.drawImage(canvasB, 0, 0);
  }
  ctx.restore();
}
function drawScaled(ctx, cv, W, H, s) {
  const dw = W * s, dh = H * s;
  ctx.drawImage(cv, Math.round((W - dw) / 2), Math.round((H - dh) / 2), Math.round(dw), Math.round(dh));
}
function dirVec(dir) { return dir === 'L' ? [-1, 0] : dir === 'R' ? [1, 0] : dir === 'U' ? [0, -1] : [0, 1]; }
function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

// A clip can carry a transition-in only if something plays before it.
export function canHaveTransIn(project, clipId) {
  return mainClips(project).findIndex((c) => c.id === clipId) > 0;
}
