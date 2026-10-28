// tighten.js · RoughCut (v0.40)
// Silence-based auto trim ("Tighten"). Finds the dead air in the speech on the
// main track and cuts it out, leaving a natural breath at every join. Runs on
// the same voice-presence grid that ducking uses, so what it hears as "voice"
// matches what music ducks under. Pure planning here; the apply step is one
// undoable command that rebuilds the main track from the plan.
//
// Rules carried from the editing rules pack:
//   gap >= 0.40 s      clean cut candidate
//   0.15 s .. 0.40 s   usable, only on the punchy setting
//   < 0.15 s           never (that is a breath, not a pause)
//   keep ~0.5 s after the opener so the first line can land
//   report when more than 25% of the cut is being removed

import { VOICE_WIN_S, voiceLevels, voicePresence } from './audio.js';
import { mainTrack, clipDurUs, tlToSrcUs, clipSpeed, normalize, MIN_CLIP_US } from './timeline.js';
import { uid } from './state.js';

const US = 1_000_000;

// minGap: shortest silence worth cutting; keep: breath left in place of it;
// head/tail: silence kept before the first word / after the last.
export const PACING = {
  punchy:     { label: 'Punchy',     minGap: 0.15, keep: 0.12, head: 0.10, tail: 0.25 },
  balanced:   { label: 'Balanced',   minGap: 0.40, keep: 0.25, head: 0.20, tail: 0.40 },
  restrained: { label: 'Restrained', minGap: 0.80, keep: 0.45, head: 0.35, tail: 0.60 },
};
export const PACING_ORDER = ['punchy', 'balanced', 'restrained'];
export const OPENER_KEEP_S = 0.5;     // pause after the first line stays at least this long
export const HEAVY_CUT_FRACTION = 0.25;

// Timeline silences from a presence grid: [{ s, e }] in seconds (half-open).
export function silences(presence) {
  const out = [];
  let i = 0; const n = presence.length;
  while (i < n) {
    if (presence[i]) { i++; continue; }
    let j = i; while (j < n && !presence[j]) j++;
    out.push({ s: i * VOICE_WIN_S, e: j * VOICE_WIN_S });
    i = j;
  }
  return out;
}

// Plan what to remove. getBuffer(mediaId) -> decoded AudioBuffer | null.
// Returns { removals: [{ clipId, tlStartUs, tlEndUs, kind }], removedUs, totalUs, fraction, heavy, gaps }
export function planTighten(project, totalUsIn, getBuffer, pacing = 'balanced') {
  const P = PACING[pacing] || PACING.balanced;
  const total = normalize(project);
  const totalUs = Math.min(totalUsIn || total, total);
  const levels = voiceLevels(project, totalUs, getBuffer);
  const pres = voicePresence(levels, 0);   // no hold here: the minGap rule already ignores the dips inside words
  const hasVoice = pres.some((v) => v);
  const gaps = hasVoice ? silences(pres) : [];
  const removals = [];
  if (!hasVoice) return { removals, removedUs: 0, totalUs, fraction: 0, heavy: false, gaps, noVoice: true };

  // first speech onset -> the gap right after it is the opener pause
  let firstOn = -1; for (let i = 0; i < pres.length; i++) if (pres[i]) { firstOn = i; break; }
  const openerEndS = firstOn * VOICE_WIN_S;
  let openerGapSeen = false;

  const t = mainTrack(project);
  const media = (id) => project.media.find((m) => m.id === id) || null;
  for (const g of gaps) {
    const atHead = g.s <= 0, atTail = g.e * US >= totalUs - VOICE_WIN_S * US;
    let keep = P.keep;
    if (!atHead && !openerGapSeen && g.s >= openerEndS) { openerGapSeen = true; keep = Math.max(keep, OPENER_KEEP_S); }
    // intersect with each main-track clip that carries audio
    for (const c of t.clips) {
      const m = media(c.mediaId); if (!m || !m.hasAudio || c.muted) continue;
      const cs = c.tlStartUs / US, ce = (c.tlStartUs + clipDurUs(c)) / US;
      const s = Math.max(g.s, cs), e = Math.min(g.e, ce);
      if (e - s <= 0) continue;
      const touchesStart = s <= cs + 1e-6, touchesEnd = e >= ce - 1e-6;
      let rs, re, kind;
      if (touchesStart && touchesEnd) continue;                      // a wholly silent clip: leave it alone (b-roll)
      if (atHead && touchesStart) { rs = s; re = e - P.head; kind = 'head'; }
      else if (atTail && touchesEnd) { rs = s + P.tail; re = e; kind = 'tail'; }
      else if (touchesStart) { rs = s; re = e - keep; kind = 'join'; }   // silence that runs over a cut
      else if (touchesEnd) { rs = s + keep; re = e; kind = 'join'; }
      else {
        if (e - s < P.minGap) continue;
        rs = s + keep / 2; re = e - keep / 2; kind = e - s >= 0.40 ? 'clean' : 'usable';
      }
      if (re - rs < 0.05) continue;
      removals.push({ clipId: c.id, tlStartUs: Math.round(rs * US), tlEndUs: Math.round(re * US), kind });
    }
  }
  removals.sort((a, b) => a.tlStartUs - b.tlStartUs);
  const removedUs = removals.reduce((a, r) => a + (r.tlEndUs - r.tlStartUs), 0);
  const fraction = totalUs ? removedUs / totalUs : 0;
  return { removals, removedUs, totalUs, fraction, heavy: fraction > HEAVY_CUT_FRACTION, gaps };
}

// Rebuild a clip's source ranges after removing the timeline spans in `rems`.
function keptRanges(clip, rems) {
  const spd = clipSpeed(clip);
  const ranges = [];
  let cur = clip.inUs;
  for (const r of rems) {
    const a = clip.inUs + Math.round((r.tlStartUs - clip.tlStartUs) * spd);
    const b = clip.inUs + Math.round((r.tlEndUs - clip.tlStartUs) * spd);
    if (a > cur) ranges.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (clip.outUs > cur) ranges.push([cur, clip.outUs]);
  // pieces shorter than the floor fold into their neighbour (the cut just does not happen there)
  const out = [];
  for (const r of ranges) {
    if (r[1] - r[0] < MIN_CLIP_US && out.length) out[out.length - 1][1] = r[1];
    else out.push(r);
  }
  if (out.length && out[0][1] - out[0][0] < MIN_CLIP_US) { if (out.length > 1) { out[1][0] = out[0][0]; out.shift(); } else out[0] = [clip.inUs, clip.outUs]; }
  return out;
}

// One undoable step. Returns the command; result of do() is the number of cuts made.
export function tightenCmd(project, plan) {
  const t = mainTrack(project);
  let before = null, made = 0;
  return {
    label: 'Tighten',
    do() {
      before = t.clips.map((c) => JSON.parse(JSON.stringify(c)));
      normalize(project);
      const byClip = new Map();
      for (const r of plan.removals) { if (!byClip.has(r.clipId)) byClip.set(r.clipId, []); byClip.get(r.clipId).push(r); }
      const next = [];
      made = 0;
      for (const c of t.clips) {
        const rems = byClip.get(c.id);
        if (!rems) { next.push(c); continue; }
        const ranges = keptRanges(c, rems);
        ranges.forEach(([a, b], i) => {
          const piece = i === 0 ? c : JSON.parse(JSON.stringify(c));
          if (i > 0) { piece.id = uid('c'); delete piece.transIn; delete piece.env; }
          piece.inUs = a; piece.outUs = b;
          next.push(piece);
        });
        made += rems.length;
      }
      t.clips.splice(0, t.clips.length, ...next);
      normalize(project);
      return made;
    },
    undo() {
      if (!before) return;
      t.clips.splice(0, t.clips.length, ...before.map((c) => JSON.parse(JSON.stringify(c))));
      normalize(project);
    },
  };
}

export function fmtSec(us) { const s = us / US; return s >= 10 ? Math.round(s) + 's' : s.toFixed(1) + 's'; }
