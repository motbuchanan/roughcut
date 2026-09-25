// extract.js · RoughCut (v0.9)
// Pull the audio out of a media file (AudioPull, folded in). Runs Mediabunny's
// Conversion with the video track discarded. 'copy' remuxes the source codec
// untouched into a container that can hold it; 'm4a' and 'wav' re-encode.
// Returns { blob, ext, mime }. Nothing leaves the device.

import {
  Input, BlobSource, ALL_FORMATS, Output, BufferTarget, Conversion,
  Mp4OutputFormat, OggOutputFormat, Mp3OutputFormat, WavOutputFormat, FlacOutputFormat,
  canEncodeAudio, QUALITY_HIGH,
} from './mediabunny.js';
import { readMedia, usToS } from './state.js';

let _aac = null;
export async function canMakeM4a() {
  if (_aac === null) { try { _aac = await canEncodeAudio('aac'); } catch (_) { _aac = false; } }
  return _aac;
}

// Which container can carry this codec without re-encoding.
export function copyPlanFor(codec) {
  const c = codec || '';
  if (c === 'aac') return { format: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'm4a', mime: 'audio/mp4', label: 'AAC copy' };
  if (c === 'opus') return { format: () => new OggOutputFormat(), ext: 'opus', mime: 'audio/ogg', label: 'Opus copy' };
  if (c === 'vorbis') return { format: () => new OggOutputFormat(), ext: 'ogg', mime: 'audio/ogg', label: 'Vorbis copy' };
  if (c === 'mp3') return { format: () => new Mp3OutputFormat(), ext: 'mp3', mime: 'audio/mpeg', label: 'MP3 copy' };
  if (c === 'flac') return { format: () => new FlacOutputFormat(), ext: 'flac', mime: 'audio/flac', label: 'FLAC copy' };
  if (c.startsWith('pcm-')) return { format: () => new WavOutputFormat(), ext: 'wav', mime: 'audio/wav', label: 'PCM copy', audio: { codec: 'pcm-s16' } };
  return null;
}

// Probe just the audio codec so the UI can say whether 'copy' is possible.
export async function probeAudioCodec(project, media) {
  const file = await readMedia(project.id, media.opfs);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const t = await input.getPrimaryAudioTrack();
    return t ? (t.codec || null) : null;
  } finally { input.dispose(); }
}

// fmt: 'copy' | 'm4a' | 'wav'. startUs/endUs optional (source time).
// Returns a handle: { promise, cancel() }.
export function extractAudio(project, media, { fmt = 'm4a', startUs = null, endUs = null, onProgress = null } = {}) {
  let conv = null, cancelled = false;
  const promise = (async () => {
    const file = await readMedia(project.id, media.opfs);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error('No audio track in this file.');
      let plan;
      if (fmt === 'copy') {
        plan = copyPlanFor(track.codec);
        if (!plan) throw new Error(`Can’t copy ${String(track.codec || 'this codec').toUpperCase()} as-is. Use M4A or WAV.`);
      } else if (fmt === 'm4a') {
        plan = { format: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'm4a', mime: 'audio/mp4', audio: { codec: 'aac', quality: QUALITY_HIGH, forceTranscode: true } };
      } else {
        plan = { format: () => new WavOutputFormat(), ext: 'wav', mime: 'audio/wav', audio: { codec: 'pcm-s16', forceTranscode: true } };
      }
      const trim = {};
      if (startUs != null && startUs > 0) trim.start = usToS(startUs);
      if (endUs != null && endUs > 0) trim.end = usToS(endUs);
      const target = new BufferTarget();
      const output = new Output({ format: plan.format(), target });
      conv = await Conversion.init({
        input, output,
        video: { discard: true },
        audio: plan.audio || {},
        trim: Object.keys(trim).length ? trim : undefined,
        showWarnings: false,
      });
      if (!conv.isValid) {
        const reasons = (conv.discardedTracks || []).filter((d) => d.track && d.track.type === 'audio').map((d) => d.reason);
        if (reasons.includes('undecodable_source_codec')) throw new Error(`This browser can’t decode ${String(track.codec || 'this codec').toUpperCase()}. Try Original.`);
        if (reasons.includes('no_encodable_target_codec')) throw new Error('This browser can’t encode that format. Try WAV or Original.');
        throw new Error('Can’t build that output (' + (reasons.join(', ') || 'unknown') + ').');
      }
      if (cancelled) throw Object.assign(new Error('Cancelled'), { name: 'ConversionCanceledError' });
      if (onProgress) conv.onProgress = (p) => onProgress(p);
      await conv.execute();
      return { blob: new Blob([target.buffer], { type: plan.mime }), ext: plan.ext, mime: plan.mime };
    } finally {
      input.dispose();
    }
  })();
  return {
    promise,
    cancel() { cancelled = true; if (conv) { try { conv.cancel(); } catch (_) {} } },
  };
}

export function baseName(n) { return String(n || 'audio').replace(/\.[^.]+$/, ''); }
export function fmtBytes(n) { return n < 1e6 ? (n / 1e3).toFixed(0) + ' KB' : n < 1e9 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e9).toFixed(2) + ' GB'; }
