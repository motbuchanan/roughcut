// export.js · RoughCut (M5)
// Renders the whole timeline to an H.264 + AAC MP4, entirely on-device, using
// Mediabunny's CanvasSource (video) and AudioBufferSource (audio) feeding one
// Output/BufferTarget. The frame compositor reuses the SAME text draw routine as
// the preview, so the export matches what was on screen.
//
// Pipeline (spec section 8):
//  - audio: OfflineAudioContext mix of the whole timeline -> AudioBufferSource
//  - video: step tUs by 1e6/fps; per frame pull the active clip's frame at the
//    nearest sample, composite at full canvas res, draw text, add() the canvas.
//    add() is awaited so the encoder queue provides backpressure.
//  - close/dispose every sink at the end.

import {
  Input, BlobSource, ALL_FORMATS, Output, BufferTarget,
  Mp4OutputFormat, CanvasSink, CanvasSource, AudioBufferSource,
  canEncodeVideo, canEncodeAudio, QUALITY_HIGH, QUALITY_MEDIUM,
} from './mediabunny.js';
import { readMedia, usToS, US } from './state.js';
import { mainTrack, clipDurUs, normalize } from './timeline.js';
import { drawTextsAt } from './text.js';
import { renderTimelineAudio } from './audio.js';

export async function canExport() {
  const reasons = [];
  try { if (!(await canEncodeVideo('avc'))) reasons.push('This browser can’t encode H.264 video.'); }
  catch (e) { reasons.push('H.264 check failed.'); }
  return { ok: reasons.length === 0, reasons };
}

function drawContain(ctx, src, sw, sh, W, H) {
  const s = Math.min(W / sw, H / sh);
  const dw = Math.round(sw * s), dh = Math.round(sh * s);
  ctx.drawImage(src, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
}

// opts: { fps, quality: 'high'|'medium', scale: 1|0.5, onProgress, signal }
export function exportProject(project, opts = {}) {
  const fps = opts.fps || project.canvas.fps || 30;
  const quality = opts.quality === 'medium' ? QUALITY_MEDIUM : QUALITY_HIGH;
  const scale = opts.scale || 1;
  const onProgress = opts.onProgress || (() => {});
  let cancelled = false;
  let output = null;

  const promise = (async () => {
    const total = normalize(project);
    if (total <= 0) throw new Error('Nothing on the timeline to export.');
    const cap = await canExport();
    if (!cap.ok) throw new Error(cap.reasons.join(' '));

    // even dimensions (H.264 requires even width/height)
    const W = Math.max(2, Math.round(project.canvas.w * scale / 2) * 2);
    const H = Math.max(2, Math.round(project.canvas.h * scale / 2) * 2);
    const bg = project.canvas.bg || '#000000';

    const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false });

    const target = new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: quality });
    output.addVideoTrack(videoSource, { frameRate: fps });

    // Audio: mix offline first (0..12% of progress), add if present + encodable.
    let audioSource = null;
    onProgress(0.02);
    let mix = null;
    try { mix = await renderTimelineAudio(project, total, 48000); } catch (e) { console.warn('audio mix failed, exporting silent', e); }
    if (cancelled) throw cancelErr();
    let aacOk = false;
    if (mix) { try { aacOk = await canEncodeAudio('aac'); } catch (_) {} }
    if (mix && aacOk) {
      audioSource = new AudioBufferSource({ codec: 'aac', bitrate: quality });
      output.addAudioTrack(audioSource);
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

    // Video: walk clips in timeline order, decoding each clip's frames in ONE
    // sequential pass (canvasesAtTimestamps) instead of a precise seek per output
    // frame. Seeking per frame re-decoded from the nearest keyframe every time,
    // which was the ~50x slowdown. Sequential reading decodes each source frame once.
    const dtUs = US / fps;
    const frameDur = 1 / fps;
    const totalFrames = Math.max(1, Math.round(usToS(total) * fps));
    const frameTimesUs = [];
    for (let i = 0; i < totalFrames; i++) frameTimesUs.push(Math.min(i * dtUs, total - 1));

    const paintOverlays = (i) => drawTextsAt(ctx, W, H, project, frameTimesUs[i]);
    const emit = async (i) => { await videoSource.add(i / fps, frameDur); if (i % 4 === 0) onProgress(0.12 + 0.86 * (i / totalFrames)); };

    let gi = 0; // global output-frame cursor; clips are contiguous so this covers 0..totalFrames-1
    for (const clip of mainTrack(project).clips) {
      if (cancelled) throw cancelErr();
      const cs = clip.tlStartUs, ce = cs + clipDurUs(clip);
      const idxs = [];
      while (gi < totalFrames && frameTimesUs[gi] < ce) { idxs.push(gi); gi++; }
      if (!idxs.length) continue;
      const m = project.media.find((x) => x.id === clip.mediaId);

      if (m && m.kind === 'video') {
        const f = await readMedia(project.id, m.opfs);
        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(f) });
        try {
          const vtrack = await input.getPrimaryVideoTrack();
          if (vtrack) {
            const sink = new CanvasSink(vtrack, { width: W, height: H, fit: 'contain', poolSize: 2 });
            const tss = idxs.map((i) => usToS(clip.inUs) + usToS(frameTimesUs[i] - cs));
            let k = 0;
            for await (const wrapped of sink.canvasesAtTimestamps(tss)) {
              if (cancelled) throw cancelErr();
              const i = idxs[k++];
              ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
              if (wrapped && wrapped.canvas) ctx.drawImage(wrapped.canvas, 0, 0, W, H);
              paintOverlays(i);
              await emit(i);
            }
            while (k < idxs.length) { const i = idxs[k++]; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); paintOverlays(i); await emit(i); }
          } else {
            for (const i of idxs) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); paintOverlays(i); await emit(i); }
          }
        } finally { try { input.dispose(); } catch (_) {} }
      } else if (m && m.kind === 'image') {
        const f = await readMedia(project.id, m.opfs);
        let bmp = null;
        try { bmp = await createImageBitmap(f); } catch (_) {}
        try {
          for (const i of idxs) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); if (bmp) drawContain(ctx, bmp, bmp.width, bmp.height, W, H); paintOverlays(i); await emit(i); }
        } finally { if (bmp) bmp.close?.(); }
      } else {
        const col = (m && m.kind === 'color') ? (m.color || '#000') : bg;
        for (const i of idxs) { ctx.fillStyle = col; ctx.fillRect(0, 0, W, H); paintOverlays(i); await emit(i); }
      }
    }
    // any trailing frames with no clip (shouldn't happen with contiguous clips)
    while (gi < totalFrames) { const i = gi++; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); paintOverlays(i); await emit(i); }
    onProgress(0.98);
    await output.finalize();
    if (cancelled) throw cancelErr();
    onProgress(1);
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', mime: 'video/mp4', w: W, h: H, fps };
  })();

  return {
    promise,
    cancel() { cancelled = true; if (output) { try { output.cancel(); } catch (_) {} } },
  };
}

function cancelErr() { return Object.assign(new Error('Cancelled'), { name: 'ExportCanceledError' }); }
