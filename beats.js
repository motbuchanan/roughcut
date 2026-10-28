// beats.js · RoughCut (v0.40)
// Beat markers for a music clip. Onset detection (energy flux over a 10 ms hop)
// gives where the sound actually hits; the tempo comes from the autocorrelation
// of that onset curve; the beat grid is then phased onto the real onsets, so a
// marker sits on the kick, not on the file's first sample. Pure, no DOM.
//
// Stored on the clip: clip.beats = { bpm, srcUs: [...] } in SOURCE microseconds,
// so markers ride along when the clip is moved, trimmed or sped up.

import { clipSpeed, clipDurUs } from './state.js';

const US = 1_000_000;
export const HOP_S = 0.010;
export const WIN_S = 0.020;
export const BPM_MIN = 60, BPM_MAX = 200;
const MIN_ONSET_GAP_S = 0.10;

function mono(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}

// Onset strength per hop: half-wave rectified rise in log energy, lightly smoothed.
export function onsetCurve(buffer) {
  const x = mono(buffer), sr = buffer.sampleRate;
  const hop = Math.max(1, Math.round(HOP_S * sr)), win = Math.max(hop, Math.round(WIN_S * sr));
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; const s0 = i * hop; for (let k = 0; k < win; k++) { const v = x[s0 + k]; a += v * v; } e[i] = Math.log(1e-7 + a / win); }
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, e[i] - e[i - 1]);
  // 3-tap smooth
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (flux[Math.max(0, i - 1)] + flux[i] + flux[Math.min(n - 1, i + 1)]) / 3;
  return out;
}

// Peaks above a local adaptive threshold, at least MIN_ONSET_GAP_S apart. Returns seconds.
export function pickOnsets(curve) {
  const n = curve.length, out = [];
  const half = Math.round(0.5 / HOP_S);
  const minGap = Math.round(MIN_ONSET_GAP_S / HOP_S);
  let last = -1e9;
  // global scale so the delta adapts to the recording
  let sum = 0; for (let i = 0; i < n; i++) sum += curve[i];
  const mean = sum / Math.max(1, n);
  for (let i = 1; i < n - 1; i++) {
    const v = curve[i];
    if (v <= curve[i - 1] || v < curve[i + 1]) continue;
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    let m = 0; for (let k = a; k < b; k++) m += curve[k]; m /= (b - a);
    if (v < m * 1.5 + mean * 0.5) continue;
    if (i - last < minGap) { if (curve[last] < v) out[out.length - 1] = i * HOP_S, last = i; continue; }
    out.push(i * HOP_S); last = i;
  }
  return out;
}

// Tempo from the autocorrelation of the onset curve in the 60..200 BPM band.
export function estimateTempo(curve) {
  const n = curve.length;
  const lagMin = Math.round(60 / BPM_MAX / HOP_S), lagMax = Math.round(60 / BPM_MIN / HOP_S);
  if (n < lagMax * 2) return { bpm: 0, lag: 0, score: 0 };
  let mean = 0; for (let i = 0; i < n; i++) mean += curve[i]; mean /= n;
  let best = 0, bestLag = 0;
  const ac = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0; for (let i = lag; i < n; i++) s += (curve[i] - mean) * (curve[i - lag] - mean);
    ac[lag] = s / (n - lag);
  }
  for (let lag = lagMin; lag <= lagMax; lag++) {
    // favour lags whose half and double also correlate (a real pulse, not one hit)
    const v = ac[lag] + 0.5 * (lag * 2 <= lagMax ? ac[lag * 2] : 0) + 0.25 * (Math.round(lag / 2) >= lagMin ? ac[Math.round(lag / 2)] : 0);
    if (v > best) { best = v; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 0, lag: 0, score: 0 };
  // refine the lag with a parabola through the neighbours
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
    const d = (y0 - 2 * y1 + y2); if (d !== 0) lag = bestLag + 0.5 * (y0 - y2) / d;
  }
  return { bpm: 60 / (lag * HOP_S), lag, score: best };
}

// Beat grid at `bpm` phased onto the onset curve (max summed strength under the grid).
export function beatGrid(curve, bpm, durS) {
  if (!(bpm > 0)) return [];
  const period = 60 / bpm;
  const steps = Math.max(1, Math.round(period / HOP_S));
  let bestPhase = 0, best = -1;
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let t = p * HOP_S; t < durS; t += period) { const i = Math.round(t / HOP_S); if (i < curve.length) s += curve[i]; }
    if (s > best) { best = s; bestPhase = p; }
  }
  const out = [];
  for (let t = bestPhase * HOP_S; t < durS; t += period) out.push(Math.round(t * 1000) / 1000);
  return out;
}

// Full analysis of a decoded buffer -> { bpm, beats: [sec], onsets: [sec] }.
export function analyzeBeats(buffer) {
  const curve = onsetCurve(buffer);
  const onsets = pickOnsets(curve);
  const { bpm } = estimateTempo(curve);
  const beats = beatGrid(curve, bpm, buffer.duration);
  // nudge every grid beat onto a real onset when one sits within 40 ms (the hit, not the maths)
  let oi = 0;
  const snapped = beats.map((b) => {
    while (oi < onsets.length && onsets[oi] < b - 0.04) oi++;
    const cand = onsets[oi];
    return (cand != null && Math.abs(cand - b) <= 0.04) ? cand : b;
  });
  return { bpm: Math.round(bpm * 10) / 10, beats: snapped, onsets };
}

// Timeline positions (us) of a clip's beat markers, within the clip's current in/out.
export function clipBeatTlUs(clip) {
  const b = clip && clip.beats; if (!b || !Array.isArray(b.srcUs)) return [];
  const spd = clipSpeed(clip), end = clip.tlStartUs + clipDurUs(clip);
  const out = [];
  for (const s of b.srcUs) {
    if (s < clip.inUs || s > clip.outUs) continue;
    const tl = clip.tlStartUs + Math.round((s - clip.inUs) / spd);
    if (tl <= end) out.push(tl);
  }
  return out;
}

// Every beat marker on the timeline, sorted. Audio lane first, then main-track clips that carry beats.
export function allBeatTlUs(project) {
  const out = [];
  for (const t of project.tracks || []) for (const c of (t.clips || [])) if (c.beats) out.push(...clipBeatTlUs(c));
  return out.sort((a, b) => a - b);
}

export function nearestBeat(beats, us, dir = 0) {
  if (!beats.length) return null;
  if (dir > 0) { for (const b of beats) if (b > us + 1000) return b; return null; }
  if (dir < 0) { for (let i = beats.length - 1; i >= 0; i--) if (beats[i] < us - 1000) return beats[i]; return null; }
  let best = null, bd = Infinity;
  for (const b of beats) { const d = Math.abs(b - us); if (d < bd) { bd = d; best = b; } }
  return best;
}

export const beatsToUs = (secs) => secs.map((s) => Math.round(s * US));
