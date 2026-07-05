// media.js · RoughCut
// Capability gate (§5) and the import pipeline: file -> OPFS copy -> Mediabunny
// metadata (duration, dimensions, rotation) -> thumbnail. M1 is the risk killer.

import { Input, BlobSource, ALL_FORMATS, CanvasSink, canEncodeVideo, canEncodeAudio } from './mediabunny.js';
import { uid, sToUs, writeMedia, writeThumb, opfsSupported } from './state.js';

// ---- capability check ----------------------------------------------------
// Honest gate: WebCodecs + OPFS present, and the browser can actually encode
// H.264 + AAC. Desktop Linux and all Firefox lack AAC encode -> fail clearly.
export async function checkCapability() {
  const reasons = [];
  const has = (n) => typeof globalThis[n] === 'function';

  if (!has('VideoEncoder') || !has('VideoDecoder')) reasons.push('WebCodecs video (VideoEncoder/Decoder) is missing.');
  if (!has('AudioEncoder')) reasons.push('WebCodecs audio (AudioEncoder) is missing.');
  if (!opfsSupported()) reasons.push('Origin Private File System (OPFS) is unavailable.');

  // Only probe codecs if the encoders exist at all.
  if (has('VideoEncoder')) {
    try {
      const okV = await canEncodeVideo('avc', { width: 1920, height: 1080 });
      if (!okV) reasons.push('This browser cannot encode H.264 video.');
    } catch (e) {
      reasons.push('H.264 encode check failed: ' + (e?.message || e));
    }
  }
  if (has('AudioEncoder')) {
    try {
      const okA = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 160000 });
      if (!okA) reasons.push('This browser cannot encode AAC audio (Firefox and desktop Linux lack this).');
    } catch (e) {
      reasons.push('AAC encode check failed: ' + (e?.message || e));
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- kind detection ------------------------------------------------------
function kindFor(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  // fall back to extension
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'].includes(ext)) return 'audio';
  return 'video';
}
function extOf(file) {
  const e = (file.name.split('.').pop() || '').toLowerCase();
  return e && e.length <= 5 ? e : 'bin';
}

// ---- thumbnail helpers ---------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function canvasToJpeg(canvas, quality = 0.72) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/jpeg', quality);
  });
}
// Draw a source (canvas or bitmap) contained inside a thumb of max edge `max`.
function drawContained(srcW, srcH, max) {
  const ar = srcW / srcH;
  let w = max, h = max;
  if (ar >= 1) h = Math.round(max / ar);
  else w = Math.round(max * ar);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  return { canvas: c, ctx, w, h };
}

// ---- probes --------------------------------------------------------------
async function probeVideo(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    if (!vtrack) throw new Error('No video track found in file.');
    const [dispW, dispH, rotation, durSec, atrack] = await Promise.all([
      vtrack.getDisplayWidth(),
      vtrack.getDisplayHeight(),
      vtrack.getRotation(),
      input.computeDuration(),
      input.getPrimaryAudioTrack(),
    ]);
    // thumbnail at the midpoint; CanvasSink applies rotation from metadata.
    const thumb = drawContained(dispW, dispH, 240);
    const sink = new CanvasSink(vtrack, { width: thumb.w, height: thumb.h, fit: 'contain', poolSize: 1 });
    const wrapped = await sink.getCanvas(Math.min(Math.max(durSec * 0.25, 0), durSec));
    if (wrapped) thumb.ctx.drawImage(wrapped.canvas, 0, 0, thumb.w, thumb.h);
    const thumbBlob = await canvasToJpeg(thumb.canvas);
    return {
      kind: 'video',
      w: dispW, h: dispH, rotation: Number(rotation) || 0,
      durUs: sToUs(durSec), hasAudio: !!atrack, thumbBlob,
    };
  } finally {
    input.dispose();
  }
}

async function probeImage(file) {
  const bmp = await createImageBitmap(file);
  try {
    const t = drawContained(bmp.width, bmp.height, 240);
    t.ctx.drawImage(bmp, 0, 0, t.w, t.h);
    const thumbBlob = await canvasToJpeg(t.canvas);
    return { kind: 'image', w: bmp.width, h: bmp.height, rotation: 0, durUs: 0, hasAudio: false, thumbBlob };
  } finally {
    bmp.close?.();
  }
}

async function probeAudio(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const atrack = await input.getPrimaryAudioTrack();
    if (!atrack) throw new Error('No audio track found in file.');
    const durSec = await input.computeDuration();
    return { kind: 'audio', w: 0, h: 0, rotation: 0, durUs: sToUs(durSec), hasAudio: true, thumbBlob: null };
  } finally {
    input.dispose();
  }
}

// ---- public: import one file into a project ------------------------------
// Returns the media record (also pushed onto project.media by the caller-side
// via the returned record; caller persists).
export async function importFile(project, file) {
  const kind = kindFor(file);
  const id = uid('m');
  const ext = extOf(file);

  // 1) copy into OPFS first so the project stays openable after gallery cleanup (L5)
  const opfsPath = await writeMedia(project.id, id, ext, file);

  // 2) probe metadata + build thumbnail
  let probe;
  if (kind === 'image') probe = await probeImage(file);
  else if (kind === 'audio') probe = await probeAudio(file);
  else probe = await probeVideo(file);

  // 3) persist thumbnail if we made one
  let thumbPath = null;
  if (probe.thumbBlob) thumbPath = await writeThumb(project.id, id, probe.thumbBlob);

  const record = {
    id,
    name: file.name,
    kind: probe.kind,
    opfs: opfsPath,
    durUs: probe.durUs,
    w: probe.w,
    h: probe.h,
    rotation: probe.rotation,
    hasAudio: probe.hasAudio,
    thumb: thumbPath,
    bytes: file.size,
  };
  return record;
}
