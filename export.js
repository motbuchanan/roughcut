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
  canEncodeVideo, canEncodeAudio, getEncodableAudioCodecs, QUALITY_HIGH, QUALITY_MEDIUM,
} from './mediabunny.js';
import { readMedia, usToS, US } from './state.js';
import { mainTrack, normalize } from './timeline.js';
import { drawTextsAt, ensureFonts } from './text.js';
import { drawTransitionAt, planFrames, drawDualTransition, clampSrc } from './transitions.js';
import { renderTimelineAudio } from './audio.js';

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

    // Audio: mix offline first (0..12% of progress), then add it using the best
    // codec THIS device can actually encode into an MP4. iOS Safari is why this is
    // defensive: older iOS has no AudioEncoder at all, and some iOS builds encode
    // AAC but hand back a broken config, so a naive "assume AAC" path exported
    // silent videos with no explanation. We pick a codec, and ALWAYS record what
    // happened (audioInfo) so a silent export is never a mystery again.
    let audioSource = null;
    const audioInfo = { included: false, codec: null, reason: '', encodable: [] };
    onProgress(0.02);
    let mix = null;
    try { mix = await renderTimelineAudio(project, total, 48000); }
    catch (e) { console.warn('audio mix failed, exporting silent', e); audioInfo.reason = 'could not mix the audio on this device'; }
    if (cancelled) throw cancelErr();
    if (mix) {
      try { audioInfo.encodable = (await getEncodableAudioCodecs()) || []; } catch (_) {}
      // MP4-friendly and iOS-playable, in order of preference.
      let pick = null;
      for (const c of ['aac', 'mp3', 'alac']) { try { if (await canEncodeAudio(c)) { pick = c; break; } } catch (_) {} }
      if (pick) {
        try {
          audioSource = new AudioBufferSource({ codec: pick, bitrate: quality });
          output.addAudioTrack(audioSource);
          audioInfo.included = true; audioInfo.codec = pick;
        } catch (e) { audioSource = null; audioInfo.included = false; audioInfo.reason = 'the audio encoder would not start (' + (e?.message || e) + ')'; }
      } else {
        audioInfo.reason = 'this browser can’t encode audio for MP4' +
          (audioInfo.encodable.length ? ' (it can encode: ' + audioInfo.encodable.join(', ') + ')' : ' (it reports no audio encoders)');
      }
    } else if (!audioInfo.reason) {
      audioInfo.reason = 'there was no audio on the timeline';
    }

    await output.start();

    // feed audio in <=10s chunks so the encoder queue stays bounded
    if (audioSource && mix) {
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
    onProgress(1);
    // Disk-backed File; the browser streams it for preview/save/share.
    const blob = await fileHandle.getFile();

    // Verify the audio actually muxed. If we added a track but re-opening the file
    // finds none, the encoder silently failed (the iOS Safari AAC case), so say so
    // instead of handing back a file the user will think is fine until it plays mute.
    if (audioInfo.included) {
      try {
        const probe = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
        const atrk = await probe.getPrimaryAudioTrack();
        if (!atrk) { audioInfo.included = false; audioInfo.reason = 'the audio track did not mux (known iOS Safari AAC bug)'; }
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
