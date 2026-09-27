// transitions.js · RoughCut
// Cut-boundary transitions on the main track (v1). A transition is stored on the
// INCOMING clip as clip.transIn = { type, durUs }, so it "belongs" to the cut
// between the previous clip and this one. It plays CENTERED on that cut: the first
// half tints the outgoing clip toward the transition color, the second half reveals
// the incoming clip back out of that color.
//
// This is the SINGLE-SOURCE family (dip to black / flash to white): at any instant
// exactly one clip is on screen plus a flat color overlay at some opacity. That
// means it needs NO change to the one-clip-at-a-time compositor, NO extra source
// footage, and it does NOT change the timeline's length. The DUAL-SOURCE family
// (crossfade / slide / wipe), which needs both clips decoded across the cut, is a
// later tier; a type this file doesn't know how to dip simply renders as a hard cut.
//
// Pure and DOM-free: shared by the preview and the export exactly like text.js.

export const TRANS_DEFAULT_US = 500_000; // 0.5s

// Catalog. A `color` means it's a dip we can draw right now (single-source family).
export const TRANSITIONS = [
  { id: 'none',     label: 'None' },
  { id: 'dipblack', label: 'Dip black', color: '#000000' },
  { id: 'dipwhite', label: 'Flash',     color: '#ffffff' },
];
export const TRANS_DURS = [
  { id: 'fast', label: '0.3s', us: 300_000 },
  { id: 'med',  label: '0.5s', us: 500_000 },
  { id: 'slow', label: '1.0s', us: 1_000_000 },
];
export const TRANS_MIN_US = 100_000;

export function transColor(type) {
  const t = TRANSITIONS.find((x) => x.id === type);
  return (t && t.color) ? t.color : null;
}
export function transLabel(type) {
  const t = TRANSITIONS.find((x) => x.id === type);
  return t ? t.label : 'None';
}
export function makeTransition(type = 'dipblack', durUs = TRANS_DEFAULT_US) {
  return { type, durUs: Math.max(TRANS_MIN_US, Math.round(durUs) || TRANS_DEFAULT_US) };
}

function dur(c) { return Math.max(0, c.outUs - c.inUs); }
function mainClips(project) {
  const t = project && project.tracks && project.tracks.find((x) => x.id === 'v1');
  return (t && t.clips) ? t.clips : [];
}

// The dip overlay to composite at a given timeline time, or null. Returns
// { color, alpha }. Boundaries are summed from clip order here (not read from
// tlStartUs), so this is correct even if normalize() hasn't been called this frame.
export function transitionColorAt(project, tlUs) {
  const clips = mainClips(project);
  if (clips.length < 2) return null;
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const start = acc;          // this clip's start == the cut before it
    const d = dur(c);
    acc += d;
    if (i === 0) continue;      // first clip has no cut in front of it
    const tr = c.transIn;
    if (!tr || tr.type === 'none') continue;
    const color = transColor(tr.type);
    if (!color) continue;       // dual-source type: nothing to dip (hard cut for now)
    const prevD = dur(clips[i - 1]);
    // Half-window each side of the cut, kept inside HALF of each neighbor so two
    // adjacent transitions on one short middle clip can meet at its midpoint but
    // never overlap.
    const half = Math.min(tr.durUs / 2, prevD / 2, d / 2);
    if (half <= 0) continue;
    if (tlUs >= start - half && tlUs < start + half) {
      const x = (tlUs - (start - half)) / (2 * half);   // 0..1 across the window
      const alpha = 1 - Math.abs(x - 0.5) * 2;          // 0 -> 1 at the cut -> 0
      return { color, alpha: Math.max(0, Math.min(1, alpha)) };
    }
  }
  return null;
}

// Composite the dip over the whole canvas. Shared by preview + export; call it
// AFTER the frame and any text so the dip covers everything on screen.
export function drawTransitionAt(ctx, W, H, project, tlUs) {
  const t = transitionColorAt(project, tlUs);
  if (!t || t.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = t.alpha;
  ctx.fillStyle = t.color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// A clip can carry a transition-in only if something plays before it.
export function canHaveTransIn(project, clipId) {
  const clips = mainClips(project);
  return clips.findIndex((c) => c.id === clipId) > 0;
}
