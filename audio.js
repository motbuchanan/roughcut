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

import { readMedia, usToS } from './state.js';
import { mainTrack, clipDurUs, audioTrack } from './timeline.js';

const MAX_CACHE_BYTES = 160 * 1024 * 1024;   // ~9 min of 48k stereo float
const MIN_FADE_S = 0.005;
// Declick: a cut that lands mid-waveform pops. Every real cut edge gets this short
// ramp unless the user set a longer fade there. One number, shared by preview + export.
export const DECLICK_S = 0.03;
const PLAY_RAMP_S = 0.015;   // master ramp when playback starts

const audibleOn = (lane, c, m) => !!m && (lane === 'a' || m.hasAudio) && !c.muted && (c.gain ?? 1) > 0;
// b picks up exactly where a left off: same file, same source position, same level,
// no user fade on the touching edges (a split with nothing trimmed). No ramp wanted.
function joined(a, b) {
  return a.mediaId === b.mediaId && a.outUs === b.inUs
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
export function scheduleEnvelope(param, vol, when, cStart, cEnd, fi, fo) {
  const len = Math.max(0, cEnd - cStart);
  if (fi + fo > len && fi + fo > 0) { const k = len / (fi + fo); fi *= k; fo *= k; }   // short clip: fades meet, never overlap
  const fiEnd = cStart + fi, foStart = cEnd - fo;
  const level = (t) => {
    if (fi > 0 && t < fiEnd) return vol * Math.max(0, (t - cStart) / fi);
    if (fo > 0 && t > foStart) return vol * Math.max(0, (cEnd - t) / fo);
    return vol;
  };
  param.setValueAtTime(level(when), when);
  if (fi > 0 && when < fiEnd) param.linearRampToValueAtTime(vol, fiEnd);
  if (fo > 0) {
    if (when < foStart) param.setValueAtTime(vol, foStart);
    param.linearRampToValueAtTime(0, cEnd);
  }
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
  for (const { clip, media: m, end } of jobs) {
    let buffer;
    try { buffer = await bufFor(m); } catch (e) { console.warn('export decode skip', m.name, e); continue; }
    const startTl = clip.tlStartUs;
    const offset = usToS(clip.inUs);
    const dur = usToS(end - startTl);
    if (dur <= 0 || offset >= buffer.duration) continue;
    const when = usToS(startTl);
    const src = ctx.createBufferSource(); src.buffer = buffer;
    const g = ctx.createGain();
    const vol = Math.max(0, Math.min(2, clip.gain ?? 1));
    const { fi, fo } = edgeFades(clip, edges.get(clip.id));
    scheduleEnvelope(g.gain, vol, when, when, when + dur, fi, fo);
    src.connect(g); g.connect(ctx.destination);
    src.start(when, offset, dur);
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

    for (const { clip, media, lane } of this._audible(project, fromUs, totalUs)) {
      const entry = this.cache.get(media.id); if (!entry) continue;
      const buffer = entry.buffer;
      const clipEnd = lane === 'a' ? Math.min(clip.tlStartUs + clipDurUs(clip), totalUs) : clip.tlStartUs + clipDurUs(clip);
      const startTl = Math.max(clip.tlStartUs, fromUs);
      const skipUs = startTl - clip.tlStartUs;         // how far into the clip we begin
      const when = t0 + usToS(startTl - fromUs);
      const offset = usToS(clip.inUs + skipUs);
      const dur = usToS(clipEnd - startTl);
      if (dur <= 0 || offset >= buffer.duration) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      const vol = Math.max(0, Math.min(2, clip.gain ?? 1));
      const { fi, fo } = edgeFades(clip, edges.get(clip.id));
      const cStart = t0 + usToS(clip.tlStartUs - fromUs);   // may be < now if we started mid-clip
      const cEnd = t0 + usToS(clipEnd - fromUs);
      // The curve is anchored to the clip's own start/end, so a mid-clip resume lands
      // at the right point on it (including inside a fade-out).
      g.gain.cancelScheduledValues(0);
      scheduleEnvelope(g.gain, vol, when, cStart, cEnd, fi, fo);
      src.connect(g); g.connect(this.master);
      src.start(when, offset, dur);
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
