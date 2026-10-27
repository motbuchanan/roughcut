// audio.js · RoughCut (M3)
// Draft-preview audio. Decodes each media's audio once (decodeAudioData on the
// OPFS file, which also pulls the audio track out of an MP4), caches the buffers,
// and on play() schedules one AudioBufferSourceNode + GainNode per active clip on
// the Web Audio clock. The AudioContext clock is the playback clock for the whole
// editor: ui.js reads nowUs() to move the playhead, so picture follows sound.
//
// Rules: silence is the resting state (stop() kills every node unconditionally);
// decode lazily on first play; buffers live in an LRU capped by bytes so a
// clip-heavy project cannot run the tab out of memory. Every real cut edge gets a
// short declick ramp (DECLICK_S) in both the preview and the export mix.

import { readMedia, usToS, clipSpeed } from './state.js';
import { mainTrack, clipDurUs, audioTrack } from './timeline.js';

const MAX_CACHE_BYTES = 160 * 1024 * 1024;   // ~9 min of 48k stereo float
const MIN_FADE_S = 0.005;
// Declick: a cut that lands mid-waveform pops. Every real cut edge gets this short
// ramp unless the user set a longer fade there. One number, shared by preview + export.
export const DECLICK_S = 0.03;
const PLAY_RAMP_S = 0.015;   // master ramp when playback starts

// ---- ducking (v0.36) -------------------------------------------------------
// Music on the audio lane can duck under voice. Voice = any unmuted main-track
// clip with audio, plus detached audio clips (they came off a video). Presence is
// measured on a 50 ms grid from the decoded samples; the duck curve holds through
// short gaps between words, attacks a touch early and releases slowly.
export const DUCK = { off: 1, light: 0.5, medium: 0.25, heavy: 0.1 };   // music level under voice
export const DUCK_LABELS = { off: 'Off', light: 'Light', medium: 'Medium', heavy: 'Heavy' };
export const VOICE_WIN_S = 0.05;
const DUCK_ATTACK_S = 0.12, DUCK_RELEASE_S = 0.5, DUCK_HOLD_S = 0.3, DUCK_LEAD_S = 0.06;
export const duckOf = (c) => (c && DUCK[c.duck] != null && c.duck !== 'off') ? c.duck : 'off';

// Which clips count as voice for ducking.
export function voiceClips(project) {
  const media = (id) => project.media.find((m) => m.id === id) || null;
  const out = [];
  for (const c of mainTrack(project).clips) { const m = media(c.mediaId); if (m && m.hasAudio && !c.muted && (c.gain ?? 1) > 0) out.push(c); }
  const at = audioTrack(project);
  for (const c of (at ? at.clips : [])) { const m = media(c.mediaId); if (m && c.detached && !c.muted && (c.gain ?? 1) > 0) out.push(c); }
  return out;
}
// RMS of the voice clips per VOICE_WIN_S window across the timeline -> Float32Array.
// getBuffer(mediaId) returns a decoded AudioBuffer or null (sync; buffers already decoded).
export function voiceLevels(project, totalUs, getBuffer) {
  const n = Math.max(1, Math.ceil(usToS(totalUs) / VOICE_WIN_S));
  const out = new Float32Array(n);
  for (const c of voiceClips(project)) {
    const buf = getBuffer(c.mediaId); if (!buf) continue;
    const ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const sr = buf.sampleRate, sp = clipSpeed(c);
    const tl0 = usToS(c.tlStartUs), tl1 = Math.min(usToS(c.tlStartUs + clipDurUs(c)), usToS(totalUs));
    const w0 = Math.max(0, Math.floor(tl0 / VOICE_WIN_S)), w1 = Math.min(n, Math.ceil(tl1 / VOICE_WIN_S));
    for (let w = w0; w < w1; w++) {
      const tl = w * VOICE_WIN_S;
      const s0 = Math.floor((usToS(c.inUs) + (tl - tl0) * sp) * sr);
      const len = Math.max(1, Math.floor(VOICE_WIN_S * sp * sr));
      const s1 = Math.min(ch0.length, s0 + len);
      if (s0 < 0 || s0 >= s1) continue;
      let acc = 0;
      if (ch1) { for (let i = s0; i < s1; i++) { const v = (ch0[i] + ch1[i]) * 0.5; acc += v * v; } }
      else { for (let i = s0; i < s1; i++) { const v = ch0[i]; acc += v * v; } }
      const rms = Math.sqrt(acc / (s1 - s0));
      if (rms > out[w]) out[w] = rms;
    }
  }
  return out;
}
// Voice present per window: above a floor that adapts to how loud the recording is.
export function voicePresence(levels) {
  const sorted = Array.from(levels).filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;
  const thr = Math.max(0.01, p90 * 0.2);   // 0.01 ~ -40 dBFS
  const pres = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) pres[i] = levels[i] > thr ? 1 : 0;
  // hold through short gaps between words
  const hold = Math.round(DUCK_HOLD_S / VOICE_WIN_S);
  const out = new Uint8Array(levels.length);
  let last = -1e9;
  for (let i = 0; i < pres.length; i++) { if (pres[i]) last = i; out[i] = (i - last <= hold) ? 1 : 0; }
  for (let i = pres.length - 1, next = 1e9; i >= 0; i--) { if (pres[i]) next = i; if (next - i <= hold) out[i] = 1; }
  return out;
}
// Breakpoints [timelineSec, gain] for a music clip at this duck amount. Flat 1 when no voice.
export function duckCurve(presence, amount) {
  const pts = [];
  let i = 0; const n = presence.length;
  while (i < n) {
    if (!presence[i]) { i++; continue; }
    let j = i; while (j < n && presence[j]) j++;
    const ts = Math.max(0, i * VOICE_WIN_S - DUCK_LEAD_S), te = j * VOICE_WIN_S;
    if (pts.length && pts[pts.length - 1][0] >= ts) pts.pop();   // overlapping release: merge
    else pts.push([ts, 1]);
    pts.push([ts + DUCK_ATTACK_S, amount], [te, amount], [te + DUCK_RELEASE_S, 1]);
    i = j;
  }
  return pts;
}
// Piecewise-linear lookup with flat ends.
export function curveAt(pts, t) {
  if (!pts || !pts.length) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) { const [t0, g0] = pts[i - 1], [t1, g1] = pts[i]; return t1 > t0 ? g0 + (g1 - g0) * (t - t0) / (t1 - t0) : g1; }
  }
  return pts[pts.length - 1][1];
}
// Per-clip volume envelope: clip.env = [{ t: 0..1 of the clip's timeline length, v: 0..2 }].
export function envAt(env, frac) {
  if (!env || !env.length) return 1;
  const pts = env;
  if (frac <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (frac <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return b.t > a.t ? a.v + (b.v - a.v) * (frac - a.t) / (b.t - a.t) : b.v; }
  }
  return pts[pts.length - 1].v;
}
export const hasEnv = (c) => !!(c && Array.isArray(c.env) && c.env.length);

const audibleOn = (lane, c, m) => !!m && (lane === 'a' || m.hasAudio) && !c.muted && (c.gain ?? 1) > 0;
// b picks up exactly where a left off: same file, same source position, same level,
// no user fade on the touching edges (a split with nothing trimmed). No ramp wanted.
function joined(a, b) {
  return a.mediaId === b.mediaId && a.outUs === b.inUs && clipSpeed(a) === clipSpeed(b)
    && a.tlStartUs + clipDurUs(a) === b.tlStartUs
    && (a.gain ?? 1) === (b.gain ?? 1)
    && !((a.fadeOutUs || 0) > 0) && !((b.fadeInUs || 0) > 0);
}
// Which edges of each audible clip are real cuts. Map: clipId -> { head, tail }.
// A seamless join (see joined) is false on both touching edges so a split stays sample-continuous.
export function cutEdges(project, totalUs) {
  const media = (id) => project.media.find((m) => m.id === id) || null;
  const out = new Map();
  const lane = (name, clips) => {
    const list = clips.filter((c) => audibleOn(name, c, media(c.mediaId)))
      .slice().sort((a, b) => a.tlStartUs - b.tlStartUs);
    for (let i = 0; i < list.length; i++) {
      const c = list[i], prev = list[i - 1], next = list[i + 1];
      const cutShort = name === 'a' && c.tlStartUs + clipDurUs(c) > totalUs;   // music chopped at the end of the video
      out.set(c.id, { head: !(prev && joined(prev, c)), tail: cutShort || !(next && joined(c, next)) });
    }
  };
  lane('v', mainTrack(project).clips);
  const at = audioTrack(project);
  lane('a', at ? at.clips : []);
  return out;
}
// Fade lengths (seconds) for one clip: the user's fade, else the declick on a cut edge.
function edgeFades(clip, edge) {
  const uf = (us) => { const s = usToS(us || 0); return s > MIN_FADE_S ? s : 0; };
  return {
    fi: Math.max(uf(clip.fadeInUs), edge && edge.head ? DECLICK_S : 0),
    fo: Math.max(uf(clip.fadeOutUs), edge && edge.tail ? DECLICK_S : 0),
  };
}
// Schedule one clip's gain curve. cStart/cEnd are the clip's own start/end on the
// context clock; `when` is where playback actually begins (>= cStart on a mid-clip
// resume), so the curve is entered at the right point instead of jumping to full.
function fadeLevelFn(vol, cStart, cEnd, fi, fo) {
  const len = Math.max(0, cEnd - cStart);
  if (fi + fo > len && fi + fo > 0) { const k = len / (fi + fo); fi *= k; fo *= k; }   // short clip: fades meet, never overlap
  const fiEnd = cStart + fi, foStart = cEnd - fo;
  const level = (t) => {
    if (fi > 0 && t < fiEnd) return vol * Math.max(0, (t - cStart) / fi);
    if (fo > 0 && t > foStart) return vol * Math.max(0, (cEnd - t) / fo);
    return vol;
  };
  return { level, fi, fo, fiEnd, foStart };
}
export function scheduleEnvelope(param, vol, when, cStart, cEnd, fi, fo) {
  let fiEnd, foStart, level;
  ({ level, fi, fo, fiEnd, foStart } = fadeLevelFn(vol, cStart, cEnd, fi, fo));
  param.setValueAtTime(level(when), when);
  if (fi > 0 && when < fiEnd) param.linearRampToValueAtTime(vol, fiEnd);
  if (fo > 0) {
    if (when < foStart) param.setValueAtTime(vol, foStart);
    param.linearRampToValueAtTime(0, cEnd);
  }
}

// Full gain curve for one clip: fades/declick x volume envelope x ducking. Falls
// back to the cheap scheduleEnvelope when the clip has neither envelope nor duck.
// duckPts are in CONTEXT time (caller maps timeline -> context).
export function scheduleGain(param, vol, when, cStart, cEnd, fi, fo, env, duckPts) {
  const useEnv = env && env.length, useDuck = duckPts && duckPts.length;
  if (!useEnv && !useDuck) { scheduleEnvelope(param, vol, when, cStart, cEnd, fi, fo); return 0; }
  const { level, fiEnd, foStart } = fadeLevelFn(vol, cStart, cEnd, fi, fo);
  const len = Math.max(1e-6, cEnd - cStart);
  const g = (t) => level(t) * (useEnv ? envAt(env, (t - cStart) / len) : 1) * (useDuck ? curveAt(duckPts, t) : 1);
  // sample on a 20 ms grid plus every real breakpoint, then keep only the points that bend
  const times = new Set([when, cEnd]);
  for (let t = when; t < cEnd; t += 0.02) times.add(t);
  for (const t of [fiEnd, foStart]) if (t > when && t < cEnd) times.add(t);
  if (useEnv) for (const p of env) { const t = cStart + p.t * len; if (t > when && t < cEnd) times.add(t); }
  if (useDuck) for (const [t] of duckPts) if (t > when && t < cEnd) times.add(t);
  const ts = [...times].sort((a, b) => a - b);
  const samples = ts.map((t) => [t, g(t)]);
  // keep a sample only when the straight line from the last kept point to the
  // next one would miss some sample in between by more than TOL
  const TOL = 0.003;
  const pts = [samples[0]];
  let k = 0;
  for (let i = 2; i < samples.length; i++) {
    const [t0, v0] = samples[k], [t1, v1] = samples[i];
    let fits = true;
    for (let j = k + 1; j < i; j++) {
      const [tj, vj] = samples[j];
      if (Math.abs(v0 + (v1 - v0) * (tj - t0) / (t1 - t0) - vj) > TOL) { fits = false; break; }
    }
    if (!fits) { pts.push(samples[i - 1]); k = i - 1; }
  }
  if (samples.length > 1) pts.push(samples[samples.length - 1]);
  param.setValueAtTime(Math.max(0, pts[0][1]), pts[0][0]);
  for (let i = 1; i < pts.length; i++) param.linearRampToValueAtTime(Math.max(0, pts[i][1]), pts[i][0]);
  return pts.length;
}

// Duck curves (timeline seconds) for every music clip that asks for one, or null.
function duckMap(project, totalUs, getBuffer) {
  const at = audioTrack(project);
  const want = (at ? at.clips : []).filter((c) => !c.detached && duckOf(c) !== 'off');
  if (!want.length) return null;
  const presence = voicePresence(voiceLevels(project, totalUs, getBuffer));
  const byAmount = new Map();
  const map = new Map();
  for (const c of want) {
    const amt = DUCK[duckOf(c)];
    if (!byAmount.has(amt)) byAmount.set(amt, duckCurve(presence, amt));
    map.set(c.id, byAmount.get(amt));
  }
  return map;
}

// Offline render of the whole timeline's audio to one AudioBuffer (export path).
// Mirrors the live schedule: both lanes, per-clip gain/mute, fade in/out, cut declick.
// Returns null when there is no audible audio anywhere.
export async function renderTimelineAudio(project, totalUs, sampleRate = 48000) {
  const media = (id) => project.media.find((m) => m.id === id) || null;
  const jobs = [];
  for (const c of mainTrack(project).clips) {
    const m = media(c.mediaId);
    if (!m || !m.hasAudio || c.muted || (c.gain ?? 1) <= 0) continue;
    jobs.push({ clip: c, media: m, end: c.tlStartUs + clipDurUs(c) });
  }
  const at = audioTrack(project);
  for (const c of (at ? at.clips : [])) {
    const m = media(c.mediaId);
    if (!m || c.muted || (c.gain ?? 1) <= 0) continue;
    jobs.push({ clip: c, media: m, end: Math.min(c.tlStartUs + clipDurUs(c), totalUs) });
  }
  if (!jobs.length) return null;

  const frames = Math.max(1, Math.ceil(usToS(totalUs) * sampleRate));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, frames, sampleRate);
  const decoded = new Map();
  async function bufFor(m) {
    if (decoded.has(m.id)) return decoded.get(m.id);
    const file = await readMedia(project.id, m.opfs);
    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    decoded.set(m.id, buf);
    return buf;
  }
  const edges = cutEdges(project, totalUs);
  for (const { media: m } of jobs) { try { await bufFor(m); } catch (e) { console.warn('export decode skip', m.name, e); } }
  const ducks = duckMap(project, totalUs, (id) => decoded.get(id) || null);
  for (const { clip, media: m, end } of jobs) {
    const buffer = decoded.get(m.id); if (!buffer) continue;
    const startTl = clip.tlStartUs;
    const sp = clipSpeed(clip);
    const offset = usToS(clip.inUs);
    const dur = usToS(end - startTl);          // timeline seconds
    if (dur <= 0 || offset >= buffer.duration) continue;
    const when = usToS(startTl);
    const src = ctx.createBufferSource(); src.buffer = buffer;
    src.playbackRate.value = sp;               // speed changes pitch too (basic slow-mo / fast-mo)
    const g = ctx.createGain();
    const vol = Math.max(0, Math.min(2, clip.gain ?? 1));
    const { fi, fo } = edgeFades(clip, edges.get(clip.id));
    scheduleGain(g.gain, vol, when, when, when + dur, fi, fo, hasEnv(clip) ? clip.env : null, ducks ? ducks.get(clip.id) : null);
    src.connect(g); g.connect(ctx.destination);
    src.start(when, offset, dur * sp);         // start()'s duration is in SOURCE seconds
  }
  return await ctx.startRendering();
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.cache = new Map();      // mediaId -> { buffer, bytes, at }
    this.live = [];              // scheduled { src, gain, clipId }
    this.playing = false;
    this.t0 = 0;                 // ctx.currentTime at start
    this.fromUs = 0;
    this.decoding = new Map();   // mediaId -> Promise
  }

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }
  async resume() {
    const ctx = this._ensureCtx();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (_) {} }
    return ctx;
  }

  // ---- decode + cache ----
  async _decode(project, media) {
    const hit = this.cache.get(media.id);
    if (hit) { hit.at = performance.now(); return hit.buffer; }
    if (this.decoding.has(media.id)) return this.decoding.get(media.id);
    const p = (async () => {
      const ctx = this._ensureCtx();
      const file = await readMedia(project.id, media.opfs);
      const ab = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      this._evict(bytes);
      this.cache.set(media.id, { buffer, bytes, at: performance.now() });
      return buffer;
    })();
    this.decoding.set(media.id, p);
    try { return await p; } finally { this.decoding.delete(media.id); }
  }
  _evict(incoming) {
    let total = incoming;
    for (const v of this.cache.values()) total += v.bytes;
    if (total <= MAX_CACHE_BYTES) return;
    const order = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id, v] of order) {
      this.cache.delete(id); total -= v.bytes;
      if (total <= MAX_CACHE_BYTES) break;
    }
  }
  forget(mediaId) { this.cache.delete(mediaId); }

  // Every clip that will make sound at or after fromUs, on both lanes.
  _audible(project, fromUs, totalUs) {
    const out = [];
    const media = (id) => project.media.find((m) => m.id === id) || null;
    for (const c of mainTrack(project).clips) {
      const m = media(c.mediaId);
      if (!m || !m.hasAudio || c.muted || (c.gain ?? 1) <= 0) continue;
      const end = c.tlStartUs + clipDurUs(c);
      if (end <= fromUs) continue;
      out.push({ clip: c, media: m, lane: 'v' });
    }
    const a = audioTrack(project);
    for (const c of (a ? a.clips : [])) {
      const m = media(c.mediaId);
      if (!m || c.muted || (c.gain ?? 1) <= 0) continue;
      const end = Math.min(c.tlStartUs + clipDurUs(c), totalUs);
      if (end <= fromUs || c.tlStartUs >= totalUs) continue;
      out.push({ clip: c, media: m, lane: 'a' });
    }
    return out;
  }

  // Decode everything the play will need. Returns the count of media decoded.
  async prepare(project, fromUs, totalUs) {
    await this.resume();
    const need = new Map();
    for (const { media } of this._audible(project, fromUs, totalUs)) need.set(media.id, media);
    const at = audioTrack(project);
    if ((at ? at.clips : []).some((c) => !c.detached && duckOf(c) !== 'off')) {
      for (const c of voiceClips(project)) { const m = project.media.find((x) => x.id === c.mediaId); if (m) need.set(m.id, m); }
    }
    let n = 0;
    for (const m of need.values()) {
      try { await this._decode(project, m); n++; }
      catch (e) { console.warn('audio decode failed', m.name, e); }
    }
    return n;
  }

  // Schedule and start. Assumes prepare() ran (missing buffers are skipped silently).
  start(project, fromUs, totalUs) {
    this.stop();
    const ctx = this._ensureCtx();
    const t0 = ctx.currentTime + 0.05;   // small lead so the first nodes start together
    // Pressing play mid-clip starts mid-waveform too: bring the master up over a few ms.
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(0, ctx.currentTime);
    this.master.gain.setValueAtTime(0, t0);
    this.master.gain.linearRampToValueAtTime(1, t0 + PLAY_RAMP_S);
    this.t0 = t0; this.fromUs = fromUs; this.playing = true;
    const edges = cutEdges(project, totalUs);
    const ducksTl = duckMap(project, totalUs, (id) => { const e = this.cache.get(id); return e ? e.buffer : null; });
    const toCtx = (pts) => pts.map(([t, g]) => [t0 + (t - usToS(fromUs)), g]);

    for (const { clip, media, lane } of this._audible(project, fromUs, totalUs)) {
      const entry = this.cache.get(media.id); if (!entry) continue;
      const buffer = entry.buffer;
      const clipEnd = lane === 'a' ? Math.min(clip.tlStartUs + clipDurUs(clip), totalUs) : clip.tlStartUs + clipDurUs(clip);
      const startTl = Math.max(clip.tlStartUs, fromUs);
      const sp = clipSpeed(clip);
      const skipUs = startTl - clip.tlStartUs;         // how far into the clip we begin (timeline)
      const when = t0 + usToS(startTl - fromUs);
      const offset = usToS(clip.inUs + Math.round(skipUs * sp));
      const dur = usToS(clipEnd - startTl);            // timeline seconds
      if (dur <= 0 || offset >= buffer.duration) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = sp;
      const g = ctx.createGain();
      const vol = Math.max(0, Math.min(2, clip.gain ?? 1));
      const { fi, fo } = edgeFades(clip, edges.get(clip.id));
      const cStart = t0 + usToS(clip.tlStartUs - fromUs);   // may be < now if we started mid-clip
      const cEnd = t0 + usToS(clipEnd - fromUs);
      // The curve is anchored to the clip's own start/end, so a mid-clip resume lands
      // at the right point on it (including inside a fade-out).
      g.gain.cancelScheduledValues(0);
      const dk = ducksTl && ducksTl.get(clip.id);
      scheduleGain(g.gain, vol, when, cStart, cEnd, fi, fo, hasEnv(clip) ? clip.env : null, dk ? toCtx(dk) : null);
      src.connect(g); g.connect(this.master);
      src.start(when, offset, dur * sp);   // SOURCE seconds
      this.live.push({ src, gain: g, clipId: clip.id });
    }
  }

  // Live volume tweak while playing (clip sheet slider). Fades are re-applied on next start.
  setClipGainLive(clipId, vol) {
    const ctx = this.ctx; if (!ctx || !this.playing) return;
    for (const n of this.live) if (n.clipId === clipId) {
      n.gain.gain.cancelScheduledValues(ctx.currentTime);
      n.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, vol)), ctx.currentTime, 0.02);
    }
  }

  nowUs() {
    if (!this.playing || !this.ctx) return this.fromUs;
    return this.fromUs + Math.max(0, (this.ctx.currentTime - this.t0)) * 1e6;
  }

  // Silence, unconditionally, before anything else updates.
  stop() {
    this.playing = false;
    if (this.master && this.ctx) {
      try { this.master.gain.cancelScheduledValues(this.ctx.currentTime); this.master.gain.setValueAtTime(0, this.ctx.currentTime); } catch (_) {}
    }
    for (const n of this.live) {
      try { n.src.onended = null; n.src.stop(); } catch (_) {}
      try { n.src.disconnect(); n.gain.disconnect(); } catch (_) {}
    }
    this.live = [];
  }

  dispose() {
    this.stop();
    this.cache.clear();
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
    this.ctx = null; this.master = null;
  }
}
