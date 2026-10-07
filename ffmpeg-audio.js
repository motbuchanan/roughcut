// ffmpeg-audio.js · RoughCut
// Apple-only audio path. iOS/macOS Safari encode valid AAC frames but write a broken
// MP4 audio header (a WebKit bug), so re-encoded exports played silent and the packet
// muxer asserted. The fix: let WebCodecs produce a VIDEO-ONLY MP4 (fast, hardware), then
// mux the mixed audio in with ffmpeg.wasm, which does its own AAC encode AND its own MP4
// muxing, touching nothing Safari gets wrong. ffmpeg loads lazily (first audio export
// only) and is cached by the service worker, so app open stays tiny. Non-Apple platforms
// never load this module.

let _ff = null;
let _loading = null;

// The engine core is 32 MB raw, and GitHub's web uploader refuses any file over 25 MB,
// so it ships gzipped (ffmpeg-core.wasm.gz, about 10 MB) and is unpacked here into a
// blob URL the worker can instantiate. Do NOT swap the raw .wasm back in: it cannot be
// uploaded from a phone. The magic-byte checks cover a server that already unpacked it.
async function wasmBlobUrl(base) {
  const res = await fetch(base + 'ffmpeg-core.wasm.gz');
  if (!res.ok) throw new Error('audio engine download failed (' + res.status + ')');
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack the audio engine');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (!(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) throw new Error('audio engine file is damaged');
  return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
}

async function getFfmpeg(onStatus) {
  if (_ff) return _ff;
  if (_loading) return _loading;
  _loading = (async () => {
    if (onStatus) onStatus('Loading audio engine (first time only)…');
    const { FFmpeg } = await import('./ffmpeg/index.js');
    const ff = new FFmpeg();
    const base = new URL('./ffmpeg/', import.meta.url).href;
    const wasmURL = await wasmBlobUrl(base);
    try {
      await ff.load({
        classWorkerURL: base + 'worker.js',
        coreURL: base + 'ffmpeg-core.js',
        wasmURL,
      });
    } finally { try { URL.revokeObjectURL(wasmURL); } catch (_) {} }
    _ff = ff;
    return ff;
  })();
  try { return await _loading; } finally { _loading = null; }
}

// True once the engine is cached/loaded in this session (so the UI can skip the
// "first time" wording on a second export).
export function ffmpegReady() { return !!_ff; }

// Mux `wavBytes` (PCM WAV) into `videoBlob` (a video-only MP4) as AAC, no video re-encode.
// Returns the final MP4 Blob. Throws on failure (caller falls back to the silent video).
export async function muxAudioWithFfmpeg(videoBlob, wavBytes, bitrate = 160000, onStatus) {
  const ff = await getFfmpeg(onStatus);
  if (onStatus) onStatus('Adding audio…');
  const vbuf = new Uint8Array(await videoBlob.arrayBuffer());
  await ff.writeFile('in.mp4', vbuf);
  await ff.writeFile('in.wav', wavBytes);
  const kbps = Math.max(64, Math.round((bitrate || 160000) / 1000)) + 'k';
  // -c:v copy keeps the hardware-encoded H.264 untouched; only the audio is encoded.
  await ff.exec(['-i', 'in.mp4', '-i', 'in.wav', '-c:v', 'copy', '-c:a', 'aac', '-b:a', kbps, '-shortest', 'out.mp4']);
  const out = await ff.readFile('out.mp4');            // Uint8Array
  try { await ff.deleteFile('in.mp4'); await ff.deleteFile('in.wav'); await ff.deleteFile('out.mp4'); } catch (_) {}
  if (!out || !out.length) throw new Error('ffmpeg produced no output');
  // Copy into a plain ArrayBuffer so the Blob is detached from ffmpeg's heap.
  return new Blob([out.slice ? out.slice() : out], { type: 'video/mp4' });
}

// AudioBuffer -> 16-bit PCM WAV bytes (<=2 channels). Deterministic, no dependency.
export function audioBufferToWav(buf) {
  const numCh = Math.min(buf.numberOfChannels || 1, 2);
  const sr = buf.sampleRate;
  const len = buf.length;
  const blockAlign = numCh * 2;
  const dataLen = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(ab);
  let o = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  const w32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const w16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  wstr('RIFF'); w32(36 + dataLen); wstr('WAVE');
  wstr('fmt '); w32(16); w16(1); w16(numCh); w32(sr); w32(sr * blockAlign); w16(blockAlign); w16(16);
  wstr('data'); w32(dataLen);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
  }
  return new Uint8Array(ab);
}
