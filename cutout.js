// cutout.js · RoughCut (v0.48)
// "Cut out person": background removal for PiP overlays without a green screen.
// A small person-segmentation network (MediaPipe's selfie segmentation, Apache-2.0,
// converted to ONNX and served from RoughCut's own site, ~0.5 MB) runs on the same
// on-device AI engine as captions (ONNX Runtime, WASM). Each frame: shrink to
// 256 x 256, get a 0..1 "person here" map, soften it, and use it as the alpha of
// the full-size frame. Nothing leaves the phone. Shared by preview and export.
//
// Stored on the overlay clip: clip.cut = { on, edge }   edge: 0..1 extra feathering

import { modelFile } from './models.js';

export const CUT_DEFAULT = { on: false, edge: 0.35 };
export const cutOf = (clip) => ({ ...CUT_DEFAULT, ...((clip && clip.cut) || {}) });
export const cutOn = (clip) => !!(clip && clip.cut && clip.cut.on);
export const CUT_MODEL_ID = 'cutout-person';
const S = 256;

let ort = null, session = null, loading = null, inName = '', outName = '', layout = 'nhwc';
const blobUrls = {};
async function engineUrl(path, type) {
  if (blobUrls[path]) return blobUrls[path];
  const f = await modelFile('caption-engine', path);
  blobUrls[path] = URL.createObjectURL(new Blob([await f.arrayBuffer()], { type }));
  return blobUrls[path];
}
// Load once. Throws with a plain message when the engine or model is not on the phone.
export function loadCutout() {
  if (session) return Promise.resolve(session);
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!ort) {
        ort = await import('./ort-web.min.js');
        ort.env.wasm.wasmPaths = {
          mjs: await engineUrl('ort-wasm-simd-threaded.mjs', 'text/javascript'),
          wasm: await engineUrl('ort-wasm-simd-threaded.wasm', 'application/wasm'),
        };
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      }
      const bytes = new Uint8Array(await (await modelFile(CUT_MODEL_ID, 'selfie.onnx')).arrayBuffer());
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      inName = session.inputNames[0]; outName = session.outputNames[0];
      const meta = session.inputMetadata && session.inputMetadata[0];
      const dims = meta && meta.shape;
      layout = (Array.isArray(dims) && dims[1] === 3) ? 'nchw' : 'nhwc';
      return session;
    } catch (e) { loading = null; throw e; }
  })();
  return loading;
}
export const cutoutReady = () => !!session;

let inCanvas = null, maskCanvas = null, outCanvas = null;
function canvas(w, h, reuse) {
  const c = reuse || document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
// Person probability map for one frame -> a S x S canvas whose alpha is the mask.
export async function personMask(img, fw, fh, edge = CUT_DEFAULT.edge) {
  await loadCutout();
  inCanvas = canvas(S, S, inCanvas);
  const ix = inCanvas.getContext('2d', { willReadFrequently: true });
  ix.drawImage(img, 0, 0, fw, fh, 0, 0, S, S);
  const px = ix.getImageData(0, 0, S, S).data;
  const data = new Float32Array(S * S * 3);
  if (layout === 'nchw') {
    for (let i = 0, j = 0; j < S * S; i += 4, j++) { data[j] = px[i] / 255; data[S * S + j] = px[i + 1] / 255; data[2 * S * S + j] = px[i + 2] / 255; }
  } else {
    for (let i = 0, j = 0; j < S * S * 3; i += 4, j += 3) { data[j] = px[i] / 255; data[j + 1] = px[i + 1] / 255; data[j + 2] = px[i + 2] / 255; }
  }
  const shape = layout === 'nchw' ? [1, 3, S, S] : [1, S, S, 3];
  const res = await session.run({ [inName]: new ort.Tensor('float32', data, shape) });
  const prob = res[outName].data;   // S*S values, 0..1
  maskCanvas = canvas(S, S, maskCanvas);
  const mx = maskCanvas.getContext('2d');
  const im = mx.createImageData(S, S), d = im.data;
  const lo = 0.5 - 0.15 - edge * 0.25, hi = 0.5 + 0.15 + edge * 0.1;   // soft threshold band
  for (let j = 0, i = 0; j < S * S; j++, i += 4) {
    let a = (prob[j] - lo) / (hi - lo); a = a < 0 ? 0 : a > 1 ? 1 : a; a = a * a * (3 - 2 * a);
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
  }
  mx.putImageData(im, 0, 0);
  return maskCanvas;
}
// The frame with everything but the person made transparent (a shared canvas: draw it before the next call).
export async function cutFrame(img, fw, fh, clip) {
  const m = await personMask(img, fw, fh, cutOf(clip).edge);
  outCanvas = canvas(fw, fh, outCanvas);
  const ox = outCanvas.getContext('2d');
  ox.globalCompositeOperation = 'copy';
  ox.drawImage(img, 0, 0, fw, fh);
  ox.globalCompositeOperation = 'destination-in';
  ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
  const blur = Math.round(Math.max(fw, fh) / S * (0.6 + cutOf(clip).edge * 1.6));
  if (blur > 0 && 'filter' in ox) ox.filter = `blur(${blur}px)`;
  ox.drawImage(m, 0, 0, S, S, 0, 0, fw, fh);
  ox.filter = 'none';
  ox.globalCompositeOperation = 'source-over';
  return outCanvas;
}
