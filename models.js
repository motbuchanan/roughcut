// models.js · RoughCut (v0.41)
// On-device model manager. The AI features (captions first) need model files
// that are far too big to ship with the app, so they download ONCE, opt-in,
// with the size shown up front, into this phone's private storage (OPFS),
// and can be deleted any time. Footage never goes the other way: nothing is
// uploaded, the model comes to the video. Pure storage + fetch; no DOM.
//
// Layout in OPFS:  models/<id>/manifest.json   { id, version, bytes, files: [{ path, bytes }] }
//                  models/<id>/<path with "/" as "__">
// A model counts as installed only when its manifest exists; the manifest is
// written last, so an interrupted download never looks finished.

const HF = 'https://huggingface.co/';
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';   // the onnxruntime-web build transformers.js 4.3.2 was built against
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// The "_timestamped" exports carry cross-attention outputs, which is what gives
// word-level timing (a caption starts when the word is actually said).
const WHISPER_FILES = [
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'normalizer.json', 'vocab.json', 'merges.txt',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];
function whisper(repo) { return WHISPER_FILES.map((p) => ({ path: p, url: `${HF}${repo}/resolve/main/${p}` })); }

// Sizes are the published ones (rounded); the real total is measured as it downloads.
export const MODELS = [
  {
    id: 'caption-engine', kind: 'engine', label: 'AI engine', detail: 'ONNX Runtime (runs captions and cut-outs on this phone)',
    bytes: 14.4e6, version: ORT_VERSION, license: 'MIT', source: 'onnxruntime-web via jsDelivr',
    files: [
      { path: 'ort-wasm-simd-threaded.mjs', url: ORT_BASE + 'ort-wasm-simd-threaded.mjs' },
      { path: 'ort-wasm-simd-threaded.wasm', url: ORT_BASE + 'ort-wasm-simd-threaded.wasm' },
    ],
  },
  {
    id: 'whisper-tiny-en', kind: 'captions', label: 'Captions · Small (English)', detail: 'Whisper tiny · fastest, good for clear speech',
    bytes: 45e6, version: 'onnx-community/whisper-tiny.en_timestamped', license: 'MIT', source: 'huggingface.co', needs: ['caption-engine'],
    repo: 'onnx-community/whisper-tiny.en_timestamped', multilingual: false, files: whisper('onnx-community/whisper-tiny.en_timestamped'),
  },
  {
    id: 'whisper-base-en', kind: 'captions', label: 'Captions · Better (English)', detail: 'Whisper base · more accurate, about twice as slow',
    bytes: 81e6, version: 'onnx-community/whisper-base.en_timestamped', license: 'MIT', source: 'huggingface.co', needs: ['caption-engine'],
    repo: 'onnx-community/whisper-base.en_timestamped', multilingual: false, files: whisper('onnx-community/whisper-base.en_timestamped'),
  },
  {
    id: 'cutout-person', kind: 'cutout', label: 'Cut out person', detail: 'MediaPipe selfie segmentation · removes the background behind people',
    bytes: 0.5e6, version: 'selfie-onnx-1', license: 'Apache-2.0', source: 'motbuchanan.com', needs: ['caption-engine'],
    files: [{ path: 'selfie.onnx', url: new URL('selfie.onnx', import.meta.url).href }],   // served from RoughCut's own repo
  },
];
export const modelById = (id) => MODELS.find((m) => m.id === id) || null;
export const captionModels = () => MODELS.filter((m) => m.kind === 'captions');
// Test hook: register an extra model (the harness adds a locally served one).
export function _registerModel(m) { if (!modelById(m.id)) MODELS.push(m); }
// Test hook: rewrite every download URL through a function (the harness points it at a local server).
export let _rewriteUrl = null;
export function _setUrlRewrite(fn) { _rewriteUrl = fn; }

const fname = (p) => p.replace(/\//g, '__');
async function modelsDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('models', { create });
}
async function dirFor(id, create) {
  const md = await modelsDir(create);
  return md.getDirectoryHandle(id, { create });
}
async function readManifest(id) {
  try { const d = await dirFor(id, false); const fh = await d.getFileHandle('manifest.json'); return JSON.parse(await (await fh.getFile()).text()); }
  catch (_) { return null; }
}

// { installed, bytes, version } for one model; bytes is the measured on-disk total when installed.
export async function modelStatus(id) {
  const m = modelById(id); if (!m) return { installed: false, bytes: 0 };
  const man = await readManifest(id);
  if (!man || man.version !== m.version) return { installed: false, bytes: m.bytes, stale: !!man };
  return { installed: true, bytes: man.bytes || m.bytes, version: man.version, installedAt: man.installedAt };
}
export async function allStatus() {
  const out = {};
  for (const m of MODELS) out[m.id] = await modelStatus(m.id);
  return out;
}
export async function installedBytes() {
  let n = 0; const st = await allStatus();
  for (const s of Object.values(st)) if (s.installed) n += s.bytes;
  return n;
}
// Everything a feature needs, deps first, including the model itself.
export function closure(id) {
  const out = [], seen = new Set();
  const walk = (x) => { const m = modelById(x); if (!m || seen.has(x)) return; seen.add(x); for (const d of (m.needs || [])) walk(d); out.push(m); };
  walk(id);
  return out;
}
export function bytesToGet(id, status) {
  return closure(id).filter((m) => !(status[m.id] && status[m.id].installed)).reduce((a, m) => a + m.bytes, 0);
}

// Download one model (not its deps; callers walk closure()). onProgress({ id, done, total, file }).
export async function downloadModel(id, onProgress, signal) {
  const m = modelById(id); if (!m) throw new Error('Unknown model ' + id);
  if (!navigator.onLine) throw new Error('No connection. Models download once, then stay on this phone.');
  const dir = await dirFor(id, true);
  try { await dir.removeEntry('manifest.json'); } catch (_) {}
  let done = 0, total = m.bytes;
  const files = [];
  for (const f of m.files) {
    if (signal && signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    const url = _rewriteUrl ? _rewriteUrl(f.url, m, f) : f.url;
    const res = await fetch(url, { signal, mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error(`${f.path}: server said ${res.status}`);
    const len = Number(res.headers.get('content-length')) || 0;
    const fh = await dir.getFileHandle(fname(f.path), { create: true });
    const w = await fh.createWritable();
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        await w.write(value); got += value.length;
        if (onProgress) onProgress({ id, done: done + got, total, file: f.path });
      }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
    // v0.44: a CDN may send the file compressed, so content-length is the SMALLER compressed size and the
    // unpacked body is bigger. Only fewer bytes than promised means the download really was cut short.
    if (len && got < len) throw new Error(`${f.path}: download cut short (${got} of ${len} bytes)`);
    done += got;
    files.push({ path: f.path, bytes: got });
    if (onProgress) onProgress({ id, done, total, file: f.path });
  }
  const man = { id, version: m.version, bytes: done, files, installedAt: Date.now() };
  const mh = await dir.getFileHandle('manifest.json', { create: true });
  const mw = await mh.createWritable(); await mw.write(JSON.stringify(man)); await mw.close();
  return man;
}
export async function deleteModel(id) {
  try { const md = await modelsDir(false); await md.removeEntry(id, { recursive: true }); } catch (_) {}
}
export async function deleteAllModels() {
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry('models', { recursive: true }); } catch (_) {}
}
// A File for one stored model file (path as listed in MODELS).
export async function modelFile(id, path) {
  const d = await dirFor(id, false);
  const fh = await d.getFileHandle(fname(path));
  return fh.getFile();
}

// A Cache-API-shaped adapter for transformers.js (env.customCache): match() answers from the
// installed files for the given models, put() stores anything it fetched itself so the next
// run is offline too. Keys arrive as URLs or "repo/resolve/main/file" style strings.
export function makeModelCache(ids) {
  const models = ids.map(modelById).filter(Boolean);
  function locate(key) {
    const k = String(key instanceof Request ? key.url : key);
    for (const m of models) {
      for (const f of m.files) {
        if (k === f.url) return { m, path: f.path };
        if (m.repo && k.includes(m.repo) && k.endsWith('/' + f.path)) return { m, path: f.path };
        if (!m.repo && k.endsWith('/' + f.path)) return { m, path: f.path };
      }
      if (m.repo && k.includes(m.repo)) { const i = k.indexOf('/resolve/'); if (i > 0) { const rest = k.slice(i + 9).replace(/^[^/]+\//, ''); return { m, path: rest, extra: true }; } }
    }
    return null;
  }
  return {
    async match(key) {
      const hit = locate(key); if (!hit) return undefined;
      try { const file = await modelFile(hit.m.id, hit.path); return new Response(file, { status: 200, headers: { 'Content-Length': String(file.size) } }); }
      catch (_) { return undefined; }
    },
    async put(key, response) {
      const hit = locate(key); if (!hit) return;
      try {
        const d = await dirFor(hit.m.id, true);
        const fh = await d.getFileHandle(fname(hit.path), { create: true });
        const w = await fh.createWritable(); await response.clone().body.pipeTo(w);
      } catch (e) { console.warn('model cache put failed', key, e); }
    },
    async delete() { return false; },
  };
}

export function fmtMB(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1e6;
  return mb >= 100 ? Math.round(mb) + ' MB' : mb >= 10 ? mb.toFixed(0) + ' MB' : mb.toFixed(1) + ' MB';
}
