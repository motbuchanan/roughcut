// export.js · RoughCut (M5, transitions v0.24)
// Renders the whole timeline to an H.264 + AAC MP4, entirely on-device, using
// Mediabunny's CanvasSource (video) and AudioBufferSource (audio) feeding one
// Output streamed to disk. The frame compositor reuses the SAME text, dip and
// transition draw routines as the preview, so the export matches what was on screen.
//
// Pipeline:
//  - audio: OfflineAudioContext mix of the whole timeline -> AudioBufferSource
//  - video: the output frames are planned into SEGMENTS (transitions.js planFrames):
//      solo  = one clip on screen, decoded in ONE sequential pass per segment
//      dual  = a crossfade/slide/wipe/zoom window: both clips decoded in lockstep
//              and blended per frame
//    Each frame gets text, then the dip overlay, then goes to the encoder.
//  - close/dispose every sink at the end.

import {
  Input, BlobSource, ALL_FORMATS, Output, StreamTarget,
  Mp4OutputFormat, CanvasSink, CanvasSource, AudioBufferSource,
  EncodedPacketSink, EncodedAudioPacketSource, EncodedPacket,
  canEncodeVideo, canEncodeAudio, getEncodableAudioCodecs, QUALITY_HIGH, QUALITY_MEDIUM,
} from './mediabunny.js';
import { readMedia, usToS, US } from './state.js';
import { mainTrack, audioTrack, clipDurUs, normalize } from './timeline.js';

// iOS and macOS Safari share a WebCodecs AAC bug: the ENCODED audio frames are valid,
// but the AudioEncoder reports a malformed decoder-config description (an esds-wrapped
// blob instead of the bare 2-byte AudioSpecificConfig). Mediabunny trusts that blob and
// writes a broken MP4 audio track, so re-encoded exports played silent. On these browsers
// we encode the mixed audio ourselves and hand Mediabunny a CORRECT, hand-built ASC, which
// bypasses the one thing Safari gets wrong. Other browsers keep the proven AudioBufferSource.
const IS_APPLE_WEBKIT = (() => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '', plat = navigator.platform || '', vendor = navigator.vendor || '';
  const iOS = /iP(hone|ad|od)/.test(ua) || /iP(hone|ad|od)/.test(plat) || (/\bMac/.test(plat) && (navigator.maxTouchPoints || 0) > 1);
  const safari = /Safari/.test(ua) && !/Chrome|CriOS|Chromium|Edg|Android|FxiOS/.test(ua);
  return iOS || (safari && /Apple/.test(vendor));
})();

// Audio COPY (passthrough) and SELF-ENCODE are DISABLED pending a verified iOS path.
// On a real iPhone they crashed the MP4 muxer with "Assertion failed." (unreproducible
// in this environment, which lacks AAC/MP4 encode). Until the ffmpeg.wasm audio route
// lands, every platform re-encodes audio via AudioBufferSource: full audio on Android
// and desktop, completes-but-silent on iOS. Re-enable only with on-device verification.
const ENABLE_AUDIO_COPY = false;
const ENABLE_SELF_ENCODE = false;

// Build the 2-byte AAC-LC AudioSpecificConfig for a sample rate + channel count.
// 5 bits objectType(2=AAC-LC), 4 bits sampleRateIndex, 4 bits channelConfig, 3 bits zero.
// e.g. 48k mono -> 0x11,0x88 ; 48k stereo -> 0x11,0x90 (matches Chrome's correct output).
function buildAacAsc(sampleRate, channels) {
  const FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = FREQ.indexOf(sampleRate); if (idx < 0) idx = 4;   // default 44100
  const chan = Math.max(1, Math.min(channels, 7));
  const bits = (2 << 11) | (idx << 7) | (chan << 3);
  return new Uint8Array([(bits >>> 8) & 0xff, bits & 0xff]);
}

// Encode a mixed AudioBuffer to AAC with our own AudioEncoder, writing a correct ASC, and
// feed the packets to an EncodedAudioPacketSource. Used only on Apple WebKit.
async function encodeMixToAac(src, mix, bitrate, isCancelled) {
  const sampleRate = mix.sampleRate;
  const channels = Math.min(mix.numberOfChannels, 2);
  const decoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, description: buildAacAsc(sampleRate, channels) };
  const chunks = [];
  let encErr = null;
  const encoder = new AudioEncoder({
    output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push({ data: b, ts: chunk.timestamp, dur: chunk.duration, type: chunk.type || 'key' }); },
    error: (e) => { encErr = e; },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate });
  const block = sampleRate; // 1s of samples per AudioData
  for (let off = 0; off < mix.length; off += block) {
    if (isCancelled()) throw cancelErr();
    if (encErr) throw encErr;
    const len = Math.min(block, mix.length - off);
    const planar = new Float32Array(len * channels);
    for (let c = 0; c < channels; c++) planar.set(mix.getChannelData(c).subarray(off, off + len), c * len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: len, numberOfChannels: channels, timestamp: Math.round((off / sampleRate) * 1e6), data: planar });
    encoder.encode(ad); ad.close();
  }
  await encoder.flush();
  try { encoder.close(); } catch (_) {}
  if (encErr) throw encErr;
  if (!chunks.length) throw new Error('no audio chunks produced');
  let first = true;
  for (const c of chunks) {
    if (isCancelled()) throw cancelErr();
    await src.add(new EncodedPacket(c.data, c.type, c.ts / 1e6, (c.dur || 0) / 1e6), first ? { decoderConfig } : undefined);
    first = false;
  }
}
import { drawTextsAt, ensureFonts } from './text.js';
import { drawTransitionAt, planFrames, drawDualTransition, clampSrc } from './transitions.js';
import { renderTimelineAudio } from './audio.js';
import { muxAudioWithFfmpeg, audioBufferToWav } from './ffmpeg-audio.js';

export async function canExport(codec = 'avc') {
  const reasons = [];
  try { if (!(await canEncodeVideo(codec))) reasons.push('This browser can’t encode H.264 video.'); }
  catch (e) { reasons.push('H.264 check failed.'); }
  return { ok: reasons.length === 0, reasons };
}

function drawContain(ctx, src, sw, sh, W, H) {
  const s = Math.min(W / sw, H / sh);
  const dw = Math.round(sw * s), dh = Math.round(sh * s);
  ctx.drawImage(src, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
}
function makeCanvas(W, H) {
  return (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
}

// opts: { fps, quality: 'high'|'medium', scale: 1|0.6667, codec?: 'avc', onProgress, signal }
export function exportProject(project, opts = {}) {
  const fps = opts.fps || project.canvas.fps || 30;
  const quality = opts.quality === 'medium' ? QUALITY_MEDIUM : QUALITY_HIGH;
  const scale = opts.scale || 1;
  const codec = opts.codec || 'avc';
  const onProgress = opts.onProgress || (() => {});
  let cancelled = false;
  let output = null;

  const promise = (async () => {
    const total = normalize(project);
    if (total <= 0) throw new Error('Nothing on the timeline to export.');
    const cap = await canExport(codec);
    if (!cap.ok) throw new Error(cap.reasons.join(' '));

    // even dimensions (H.264 requires even width/height)
    const W = Math.max(2, Math.round(project.canvas.w * scale / 2) * 2);
    const H = Math.max(2, Math.round(project.canvas.h * scale / 2) * 2);
    const bg = project.canvas.bg || '#000000';

    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });

    // Stream the encoded MP4 straight to an OPFS file instead of holding it in
    // memory: a BufferTarget ran a phone tab out of memory partway through long
    // exports. fastStart:false writes the index at the end (no second in-memory copy).
    const opfsRoot = await navigator.storage.getDirectory();
    const tmpName = 'roughcut-export.tmp.mp4';
    try { await opfsRoot.removeEntry(tmpName); } catch (_) {}
    const fileHandle = await opfsRoot.getFileHandle(tmpName, { create: true });
    const writable = await fileHandle.createWritable();
    const target = new StreamTarget(writable);
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const videoSource = new CanvasSource(canvas, { codec, bitrate: quality });
    output.addVideoTrack(videoSource, { frameRate: fps });

    // ---- audio passthrough helpers ----
    const mediaById = (id) => project.media.find((x) => x.id === id) || null;
    function descKey(d) {
      if (!d) return 'none';
      try { const u = new Uint8Array(d.buffer ? d.buffer : d); return u.length + ':' + Array.from(u.subarray(0, 8)).join(','); }
      catch (_) { return 'x'; }
    }
    function disposeOpened(list) { for (const o of (list || [])) { try { o.input.dispose(); } catch (_) {} } }
    // Decide whether we can copy source audio instead of re-encoding. Returns a plan or null.
    async function planPassthrough() {
      const main = mainTrack(project).clips;
      if (!main.length) return null;
      const at = audioTrack(project);
      const musicAudible = !!(at && at.clips && at.clips.some((c) => { const m = mediaById(c.mediaId); return m && !c.muted && (c.gain ?? 1) > 0; }));
      if (musicAudible) return null;                       // two lanes -> must mix, so encode
      const contrib = [];
      for (const c of main) {
        const m = mediaById(c.mediaId);
        if (!m) return null;                               // unknown media -> be safe, encode
        if (c.muted || !m.hasAudio) continue;              // intentional/absent audio -> silent span, fine
        if ((c.gain ?? 1) !== 1) return null;              // volume change -> encode
        if ((c.fadeInUs || 0) > 0 || (c.fadeOutUs || 0) > 0) return null;  // fades -> encode
        if (m.kind !== 'video' && m.kind !== 'audio') continue;
        contrib.push({ clip: c, media: m });
      }
      if (!contrib.length) return null;                    // nothing copyable -> encode path reports it
      let codec = null, decoderConfig = null, key = null;
      const opened = [];
      try {
        for (const { clip, media: m } of contrib) {
          const file = await readMedia(project.id, m.opfs);
          const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
          const track = await input.getPrimaryAudioTrack();
          if (!track) { try { input.dispose(); } catch (_) {} disposeOpened(opened); return null; }
          const [c2, dc] = await Promise.all([track.getCodec(), track.getDecoderConfig()]);
          if (!c2 || !dc) { try { input.dispose(); } catch (_) {} disposeOpened(opened); return null; }
          const k = c2 + '|' + dc.sampleRate + '|' + dc.numberOfChannels + '|' + descKey(dc.description);
          if (codec === null) { codec = c2; decoderConfig = dc; key = k; }
          else if (k !== key) { try { input.dispose(); } catch (_) {} disposeOpened(opened); return null; }  // mixed configs -> encode
          opened.push({ clip, input, track });
        }
      } catch (e) { disposeOpened(opened); return null; }
      return { codec, decoderConfig, opened };
    }
    // Copy each clip's source audio packets onto the output track, retimed to the timeline.
    async function feedPassthrough(src, plan) {
      let first = true, lastTs = -Infinity;
      for (const { clip, track } of plan.opened) {
        if (cancelled) throw cancelErr();
        const sink = new EncodedPacketSink(track);
        const inSec = usToS(clip.inUs || 0);
        const endSec = inSec + usToS(clipDurUs(clip));
        const tlSec = usToS(clip.tlStartUs);
        let pkt = await sink.getPacket(inSec, {});
        if (!pkt) pkt = await sink.getFirstPacket({});
        while (pkt) {
          if (cancelled) throw cancelErr();
          if (pkt.timestamp >= endSec) break;
          if (pkt.timestamp + (pkt.duration || 0) > inSec) {   // packet overlaps the kept range
            let newTs = (pkt.timestamp - inSec) + tlSec;
            if (newTs <= lastTs) newTs = lastTs + 1e-6;         // keep timestamps strictly increasing
            await src.add(pkt.clone({ timestamp: newTs }), first ? { decoderConfig: plan.decoderConfig } : undefined);
            lastTs = newTs; first = false;
          }
          pkt = await sink.getNextPacket(pkt, {});
        }
      }
      if (first) throw new Error('no audio packets were copied');
    }

    // ===== AUDIO =====
    // Preferred path: COPY the source clips' own encoded audio with NO re-encoding
    // (passthrough). This is the iOS Safari fix: Safari's AAC encoder writes a broken
    // track header, so re-encoded exports played silent. Copying uses the source file's
    // valid config and original packets, so the audio plays everywhere and needs no
    // AudioEncoder at all. We can only copy when the timeline audio is "simple": one
    // lane, full volume, no fades, and all source clips share one audio config.
    // Anything else (music overlay, volume, fades, mixed configs) falls back to the
    // mix + encode path, which still works on Android. Passthrough fails SAFE: any
    // error drops to the encode path, so the worst case is exactly the old behavior.
    let audioSource = null;      // AudioBufferSource (encode path)
    let audioPacket = null;      // EncodedAudioPacketSource (copy path, or self-encode on Apple)
    let selfEncodeAac = false;   // Apple WebKit: encode the mix ourselves with a correct header
    let useFfmpegAudio = false;  // Apple WebKit: mux audio with ffmpeg.wasm after a video-only render
    let ptPlan = null;
    let mix = null;
    const aacBitrate = (opts.quality === 'medium') ? 96000 : 160000;
    const audioInfo = { included: false, codec: null, mode: 'none', reason: '', encodable: [] };
    onProgress(0.02);

    try { ptPlan = ENABLE_AUDIO_COPY ? await planPassthrough() : null; } catch (e) { console.warn('passthrough plan failed', e); ptPlan = null; }
    if (ptPlan) {
      try {
        audioPacket = new EncodedAudioPacketSource(ptPlan.codec);
        output.addAudioTrack(audioPacket);
        audioInfo.included = true; audioInfo.codec = ptPlan.codec; audioInfo.mode = 'copy';
      } catch (e) { console.warn('passthrough add failed, will encode', e); audioPacket = null; disposeOpened(ptPlan.opened); ptPlan = null; }
    }
    if (!ptPlan) {
      try { mix = await renderTimelineAudio(project, total, 48000); }
      catch (e) { console.warn('audio mix failed, exporting silent', e); audioInfo.reason = 'could not mix the audio on this device'; }
      if (cancelled) throw cancelErr();
      if (mix) {
        if (IS_APPLE_WEBKIT) {
          // Apple: don't add an audio track here (Safari's MP4 audio muxing is broken).
          // Render video-only now, then mux the mixed audio in with ffmpeg.wasm after finalize.
          useFfmpegAudio = true; audioInfo.included = true; audioInfo.codec = 'aac'; audioInfo.mode = 'ffmpeg';
        } else {
          try { audioInfo.encodable = (await getEncodableAudioCodecs()) || []; } catch (_) {}
          let pick = null;
          for (const c of ['aac', 'mp3', 'alac']) { try { if (await canEncodeAudio(c)) { pick = c; break; } } catch (_) {} }
          if (pick) {
            try {
              audioSource = new AudioBufferSource({ codec: pick, bitrate: quality });
              output.addAudioTrack(audioSource);
              audioInfo.included = true; audioInfo.codec = pick; audioInfo.mode = 'encode';
            } catch (e) { audioSource = null; audioInfo.included = false; audioInfo.reason = 'the audio encoder would not start (' + (e?.message || e) + ')'; }
          } else {
            audioInfo.reason = 'this browser can’t encode audio for MP4' +
              (audioInfo.encodable.length ? ' (it can encode: ' + audioInfo.encodable.join(', ') + ')' : ' (it reports no audio encoders)');
          }
        }
      } else if (!audioInfo.reason) {
        audioInfo.reason = 'there was no audio on the timeline';
      }
    }

    await output.start();

    // feed audio
    if (ptPlan && audioPacket) {
      try { await feedPassthrough(audioPacket, ptPlan); }
      catch (e) {
        console.warn('passthrough feed failed', e);
        audioInfo.included = false; audioInfo.mode = 'none';
        audioInfo.reason = 'copying the original audio failed (' + (e?.message || e) + ')';
      }
    } else if (selfEncodeAac && audioPacket && mix) {
      try { await encodeMixToAac(audioPacket, mix, aacBitrate, () => cancelled); }
      catch (e) {
        console.warn('self-encode failed', e);
        audioInfo.included = false; audioInfo.mode = 'none';
        audioInfo.reason = 'encoding the mixed audio failed (' + (e?.message || e) + ')';
      }
    } else if (audioSource && mix) {
      // feed audio in <=10s chunks so the encoder queue stays bounded
      const sr = mix.sampleRate, ch = mix.numberOfChannels, chunk = sr * 10;
      for (let off = 0; off < mix.length; off += chunk) {
        if (cancelled) throw cancelErr();
        const len = Math.min(chunk, mix.length - off);
        const part = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
        for (let c = 0; c < ch; c++) part.copyToChannel(mix.getChannelData(c).subarray(off, off + len), c);
        await audioSource.add(part);
        onProgress(0.02 + 0.10 * (off / mix.length));
      }
    }
    if (ptPlan) disposeOpened(ptPlan.opened);   // audio copied; free the source readers before the video loop
    onProgress(0.12);

    // Bundled display fonts (Creepster) must be loaded before any text is drawn.
    await ensureFonts();

    // ---- video ----
    const dtUs = US / fps;
    const frameDur = 1 / fps;
    const totalFrames = Math.max(1, Math.round(usToS(total) * fps));
    const frameTimesUs = [];
    for (let i = 0; i < totalFrames; i++) frameTimesUs.push(Math.min(i * dtUs, total - 1));

    const paintOverlays = (i) => {
      drawTextsAt(ctx, W, H, project, frameTimesUs[i]);
      drawTransitionAt(ctx, W, H, project, frameTimesUs[i]);
    };
    // Encoder pipeline with a SMALL window: Mediabunny's encoder self-caps its queue
    // at 4 frames; bigger windows only piled up unencoded frames and OOM'd phones.
    const MAX_INFLIGHT = 2;
    const inflight = [];
    const emit = async (i) => {
      const p = videoSource.add(i / fps, frameDur);
      inflight.push(p);
      if (inflight.length >= MAX_INFLIGHT) await inflight.shift();
      if (i % 4 === 0) onProgress(0.12 + 0.86 * (i / totalFrames));
    };

    const clips = mainTrack(project).clips;
    const mediaOf = (clip) => project.media.find((x) => x.id === clip.mediaId) || null;

    // One frame source per CLIP (not per media: a split clip is the same file twice,
    // and a dual segment needs two independent readers on it).
    //   { kind:'video', input, sink } | { kind:'image', bmp } | { kind:'color', color } | { kind:'none' }
    const sources = new Map();
    async function sourceFor(ci) {
      if (sources.has(ci)) return sources.get(ci);
      const clip = clips[ci], m = mediaOf(clip);
      let src = { kind: 'none' };
      try {
        if (m && m.kind === 'video') {
          const f = await readMedia(project.id, m.opfs);
          const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(f) });
          const vtrack = await input.getPrimaryVideoTrack();
          if (vtrack) src = { kind: 'video', input, sink: new CanvasSink(vtrack, { width: W, height: H, fit: 'contain', poolSize: 2 }), media: m };
          else { try { input.dispose(); } catch (_) {} }
        } else if (m && m.kind === 'image') {
          const f = await readMedia(project.id, m.opfs);
          src = { kind: 'image', bmp: await createImageBitmap(f) };
        } else if (m && m.kind === 'color') {
          src = { kind: 'color', color: m.color || '#000' };
        }
      } catch (_) { src = { kind: 'none' }; }   // media offline -> background only
      sources.set(ci, src);
      return src;
    }
    function disposeSource(ci) {
      const s = sources.get(ci); if (!s) return;
      if (s.input) { try { s.input.dispose(); } catch (_) {} }
      if (s.bmp) { try { s.bmp.close?.(); } catch (_) {} }
      sources.delete(ci);
    }
    // Last segment index that touches each clip, so readers close as soon as they're done.
    const segs = planFrames(project, frameTimesUs);
    const lastUse = new Map();
    segs.forEach((s, k) => { if (s.kind === 'solo') lastUse.set(s.ci, k); else { lastUse.set(s.ai, k); lastUse.set(s.bi, k); } });

    // Draw a static (image/color/none) source, or a decoded frame canvas, into a ctx.
    const paintStatic = (c, src, frame) => {
      c.fillStyle = (src.kind === 'color') ? src.color : bg; c.fillRect(0, 0, W, H);
      if (src.kind === 'image' && src.bmp) drawContain(c, src.bmp, src.bmp.width, src.bmp.height, W, H);
      else if (frame) c.drawImage(frame, 0, 0, W, H);
    };
    // Sequential frame iterator for a source over a list of source times (us).
    // Non-video sources yield null every frame (paintStatic handles them).
    async function* framesOf(src, srcUsList) {
      if (src.kind !== 'video') { for (let k = 0; k < srcUsList.length; k++) yield null; return; }
      const tss = srcUsList.map((us) => usToS(clampSrc(us, src.media)));
      let k = 0;
      try {
        for await (const wrapped of src.sink.canvasesAtTimestamps(tss)) { k++; yield (wrapped && wrapped.canvas) || undefined; }
      } catch (err) {
        // A hardware decoder can error on a frame (older phones at higher fps/res).
        // Don't throw a multi-minute render away: hold the last good frame.
        if (err && err.name === 'ExportCanceledError') throw err;
        console.warn('export: decode fell back at frame', k, 'of', tss.length, err);
      }
      for (; k < srcUsList.length; k++) yield undefined;   // undefined = "reuse last"
    }

    const scratchA = makeCanvas(W, H), scratchB = makeCanvas(W, H);
    const ctxA = scratchA.getContext('2d', { alpha: false }), ctxB = scratchB.getContext('2d', { alpha: false });

    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx];
      if (cancelled) throw cancelErr();

      if (seg.kind === 'solo') {
        const src = seg.ci >= 0 ? await sourceFor(seg.ci) : { kind: 'none' };
        let last = null;
        const it = framesOf(src, seg.src);
        for (let k = 0; k < seg.idx.length; k++) {
          if (cancelled) throw cancelErr();
          const i = seg.idx[k];
          const r = await it.next();
          const frame = r.value === undefined ? last : r.value;
          if (frame !== undefined) last = frame;
          paintStatic(ctx, src, frame);
          paintOverlays(i);
          await emit(i);
        }
      } else {
        const srcA = await sourceFor(seg.ai), srcB = await sourceFor(seg.bi);
        const itA = framesOf(srcA, seg.srcA), itB = framesOf(srcB, seg.srcB);
        let lastA = null, lastB = null;
        for (let k = 0; k < seg.idx.length; k++) {
          if (cancelled) throw cancelErr();
          const i = seg.idx[k];
          const [ra, rb] = await Promise.all([itA.next(), itB.next()]);
          const fa = ra.value === undefined ? lastA : ra.value; if (fa !== undefined) lastA = fa;
          const fb = rb.value === undefined ? lastB : rb.value; if (fb !== undefined) lastB = fb;
          paintStatic(ctxA, srcA, fa);
          paintStatic(ctxB, srcB, fb);
          drawDualTransition(ctx, W, H, seg.type, seg.dir, seg.xs[k], scratchA, scratchB);
          paintOverlays(i);
          await emit(i);
        }
      }
      // close readers whose clips are finished
      for (const [ci, k] of lastUse) if (k === sIdx) disposeSource(ci);
    }
    for (const ci of [...sources.keys()]) disposeSource(ci);

    await Promise.all(inflight);   // drain the encoder queue before finalizing
    onProgress(0.98);
    await output.finalize();       // flushes + closes the OPFS writable
    if (cancelled) throw cancelErr();
    onProgress(useFfmpegAudio ? 0.9 : 1);
    // Disk-backed File; the browser streams it for preview/save/share.
    const blob = await fileHandle.getFile();

    // Apple audio: the video is finished (video-only MP4); mux the mixed audio in with
    // ffmpeg.wasm (its own AAC encode + MP4 mux, so Safari's broken path is never used).
    if (useFfmpegAudio && mix && !cancelled) {
      try {
        const wav = audioBufferToWav(mix);
        const finalBlob = await muxAudioWithFfmpeg(blob, wav, aacBitrate, (msg) => onProgress(0.95, msg));
        onProgress(1);
        audioInfo.included = true;
        return { blob: finalBlob, ext: 'mp4', mime: 'video/mp4', w: W, h: H, fps, audio: audioInfo };
      } catch (e) {
        console.warn('ffmpeg audio mux failed; returning silent video', e);
        audioInfo.included = false; audioInfo.mode = 'none';
        audioInfo.reason = 'adding audio failed (' + (e?.message || e) + ')';
        onProgress(1);
        return { blob, ext: 'mp4', mime: 'video/mp4', w: W, h: H, fps, audio: audioInfo };
      }
    }

    // Verify the audio actually muxed. If we added a track but re-opening the file
    // finds none, the encoder silently failed (the iOS Safari AAC case), so say so
    // instead of handing back a file the user will think is fine until it plays mute.
    if (audioInfo.included) {
      try {
        const probe = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
        const atrk = await probe.getPrimaryAudioTrack();
        if (!atrk) { audioInfo.included = false; audioInfo.reason = (audioInfo.mode === 'copy') ? 'the copied audio track did not write' : 'the audio track did not mux (iOS Safari AAC bug)'; }
        try { probe.dispose(); } catch (_) {}
      } catch (_) { /* verify is best-effort; don't fail a good export over it */ }
    }

    return { blob, ext: 'mp4', mime: 'video/mp4', w: W, h: H, fps, audio: audioInfo };
  })();

  return {
    promise,
    async cancel() {
      cancelled = true;
      if (output) { try { await output.cancel(); } catch (_) {} }
      try { const r = await navigator.storage.getDirectory(); await r.removeEntry('roughcut-export.tmp.mp4'); } catch (_) {}
    },
  };
}

function cancelErr() { return Object.assign(new Error('Cancelled'), { name: 'ExportCanceledError' }); }
