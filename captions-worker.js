// captions-worker.js · RoughCut (v0.42)
// Runs Whisper (transformers.js + ONNX Runtime WASM) off the main thread so the
// editor stays responsive while a clip is being listened to. Everything it needs
// is already on the phone: the model files come from the on-device model store
// (models.js) through a Cache-API-shaped adapter, and the ONNX Runtime wasm +
// loader come from the same store as blob URLs. No network use once installed.
//
// Messages in:  { type: 'run', jobId, modelId, audio: Float32Array (16 kHz mono), opts }
// Messages out: { type: 'status', jobId, stage, p }   p in 0..1 for the current stage
//               { type: 'done', jobId, words: [{ text, start, end }], text, approx, bpm... }
//               { type: 'error', jobId, message }
// Cancel = terminate the worker (the page does that).

import { modelById, modelFile, makeModelCache, _registerModel } from './models.js';
import { wordsFromChunks } from './captions.js';

let tf = null;          // the transformers.js module, loaded once
let pipe = null, pipeModel = null;
const blobUrls = {};

async function fileBlobUrl(id, path, type) {
  const key = id + '/' + path;
  if (blobUrls[key]) return blobUrls[key];
  const f = await modelFile(id, path);
  const url = URL.createObjectURL(new Blob([await f.arrayBuffer()], { type }));
  blobUrls[key] = url;
  return url;
}

async function setup(modelId, post) {
  const m = modelById(modelId); if (!m) throw new Error('Unknown caption model ' + modelId);
  if (!tf) {
    post({ stage: 'engine', p: 0 });
    tf = await import('./transformers.min.js');
    const env = tf.env;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;             // only reached if a file is missing from the store
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = makeModelCache(['caption-engine', modelId]);
    const wasm = env.backends.onnx.wasm;
    wasm.wasmPaths = {
      mjs: await fileBlobUrl('caption-engine', 'ort-wasm-simd-threaded.mjs', 'text/javascript'),
      wasm: await fileBlobUrl('caption-engine', 'ort-wasm-simd-threaded.wasm', 'application/wasm'),
    };
    wasm.numThreads = 1;                      // GitHub Pages sends no COOP/COEP, so no shared memory anyway
    wasm.proxy = false;
  } else {
    tf.env.customCache = makeModelCache(['caption-engine', modelId]);
  }
  if (pipe && pipeModel === modelId) return pipe;
  if (pipe) { try { await pipe.dispose(); } catch (_) {} pipe = null; }
  post({ stage: 'model', p: 0 });
  const seen = new Map();
  pipe = await tf.pipeline('automatic-speech-recognition', m.repo, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (ev) => {
      if (ev.status === 'progress' && ev.file) { seen.set(ev.file, [ev.loaded || 0, ev.total || 0]); let l = 0, t = 0; for (const [a, b] of seen.values()) { l += a; t += b; } if (t) post({ stage: 'model', p: l / t }); }
    },
  });
  pipeModel = modelId;
  return pipe;
}

async function transcribe(modelId, audio, opts, post) {
  const p = await setup(modelId, post);
  const m = modelById(modelId);
  const sr = 16000;
  const chunkS = opts.chunkS || 30, strideS = opts.strideS || 5;
  const windows = Math.max(1, Math.ceil(audio.length / sr / (chunkS - 2 * strideS)));
  let winDone = 0;
  post({ stage: 'listen', p: 0 });
  const streamer = new tf.WhisperTextStreamer(p.tokenizer, {
    skip_prompt: true,
    on_chunk_start: (t) => post({ stage: 'listen', p: Math.min(0.999, (winDone + Math.min(t, chunkS) / chunkS) / windows) }),
    on_finalize: () => { winDone++; post({ stage: 'listen', p: Math.min(0.999, winDone / windows) }); },
    callback_function: () => {},
  });
  const base = { chunk_length_s: chunkS, stride_length_s: strideS, streamer };
  if (m.multilingual) { base.language = opts.language || 'en'; base.task = 'transcribe'; }
  let out, approx = false;
  try {
    out = await p(audio, { ...base, return_timestamps: 'word' });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (!/alignment_heads|cross attentions|token-level|timestamps/i.test(msg)) throw e;
    // This export has no word timing: fall back to sentence timing spread across the words.
    winDone = 0;
    out = await p(audio, { ...base, return_timestamps: true });
    approx = true;
  }
  const words = wordsFromChunks(out.chunks || [], { approx });
  return { words, text: (out.text || '').trim(), approx };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'run') return;
  if (msg.model) _registerModel(msg.model);   // test harness: a locally served model
  const post = (s) => self.postMessage({ type: 'status', jobId: msg.jobId, ...s });
  try {
    const r = await transcribe(msg.modelId, msg.audio, msg.opts || {}, post);
    self.postMessage({ type: 'done', jobId: msg.jobId, ...r });
  } catch (err) {
    console.error('captions worker', err);
    self.postMessage({ type: 'error', jobId: msg.jobId, message: String(err && err.message || err) });
  }
};
self.postMessage({ type: 'ready' });
