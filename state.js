// state.js · RoughCut
// Guarded storage, OPFS media/project persistence, project CRUD, debounced autosave.
// No DOM, no Mediabunny. Time base is integer microseconds everywhere (L12).

export const US = 1_000_000; // microseconds per second
export const sToUs = (s) => Math.round(s * US);
export const usToS = (us) => us / US;

// ---- guarded localStorage (in-memory fallback) ---------------------------
function makeStore() {
  let backing;
  try {
    const k = '__rc_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    backing = localStorage;
  } catch (_) {
    const mem = new Map();
    backing = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  return {
    getJSON(key, fallback) {
      try {
        const raw = backing.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    setJSON(key, val) {
      try {
        backing.setItem(key, JSON.stringify(val));
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}
const store = makeStore();

const INDEX_KEY = 'rc_index_v1';
const PREFS_KEY = 'rc_prefs_v1';

// ---- prefs ---------------------------------------------------------------
const DEFAULT_PREFS = { lastCanvas: 'p916', draftPreview: true };
export function loadPrefs() {
  return { ...DEFAULT_PREFS, ...store.getJSON(PREFS_KEY, {}) };
}
export function savePrefs(p) {
  store.setJSON(PREFS_KEY, p);
}

// ---- canvas presets ------------------------------------------------------
export const CANVAS_PRESETS = {
  p916: { w: 1080, h: 1920, label: '9:16' },
  l169: { w: 1920, h: 1080, label: '16:9' },
  s11: { w: 1080, h: 1080, label: '1:1' },
  p45: { w: 1080, h: 1350, label: '4:5' },
};

// ---- project index (metadata only) --------------------------------------
export function listProjects() {
  const idx = store.getJSON(INDEX_KEY, []);
  return Array.isArray(idx) ? idx.slice().sort((a, b) => b.modified - a.modified) : [];
}
function writeIndex(idx) {
  store.setJSON(INDEX_KEY, idx);
}
function upsertIndex(meta) {
  const idx = store.getJSON(INDEX_KEY, []);
  const i = idx.findIndex((m) => m.id === meta.id);
  if (i === -1) idx.push(meta);
  else idx[i] = meta;
  writeIndex(idx);
}
function removeIndex(id) {
  writeIndex(store.getJSON(INDEX_KEY, []).filter((m) => m.id !== id));
}

// ---- ids -----------------------------------------------------------------
export function uid(prefix = 'id') {
  const r = (crypto?.getRandomValues
    ? [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 14));
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

// ---- default project schema (§6) ----------------------------------------
export function defaultProject(name, presetKey) {
  const preset = CANVAS_PRESETS[presetKey] || CANVAS_PRESETS.p916;
  const now = Date.now();
  return {
    v: 1,
    id: uid('proj'),
    name: name || 'Untitled',
    created: now,
    modified: now,
    canvas: { w: preset.w, h: preset.h, fps: 30, bg: '#000000' },
    media: [],
    tracks: [
      { id: 'v1', kind: 'video', clips: [] },
      { id: 'v2', kind: 'overlay', clips: [] },
      { id: 't1', kind: 'text', items: [] },
      { id: 'a1', kind: 'audio', clips: [] },
    ],
  };
}
export function projectMeta(p) {
  return { id: p.id, name: p.name, created: p.created, modified: p.modified, canvas: p.canvas };
}

// ---- OPFS ----------------------------------------------------------------
export function opfsSupported() {
  return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
}
async function opfsRoot() {
  if (!opfsSupported()) throw new Error('OPFS unavailable');
  return navigator.storage.getDirectory();
}
async function projectsDir(create = true) {
  const root = await opfsRoot();
  return root.getDirectoryHandle('projects', { create });
}
async function projectDir(id, create = true) {
  const pd = await projectsDir(create);
  return pd.getDirectoryHandle(id, { create });
}
async function subDir(id, name, create = true) {
  const pd = await projectDir(id, create);
  return pd.getDirectoryHandle(name, { create });
}

async function writeFileHandle(handle, data) {
  const writable = await handle.createWritable();
  // Stream Blobs/Files so large media never buffers whole in memory.
  // pipeTo() closes the destination on success; write() path closes explicitly.
  if (data instanceof Blob && typeof data.stream === 'function') {
    try {
      await data.stream().pipeTo(writable);
      return;
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      throw e;
    }
  }
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch (_) {}
    throw e;
  }
}

// ---- project.json read / write ------------------------------------------
export async function saveProjectNow(p) {
  p.modified = Date.now();
  const dir = await projectDir(p.id, true);
  const fh = await dir.getFileHandle('project.json', { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([JSON.stringify(p)], { type: 'application/json' }));
  await w.close();
  upsertIndex(projectMeta(p));
  return p;
}

let saveTimer = null;
let savePending = null;
export function scheduleSave(p, delay = 400) {
  savePending = p;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const target = savePending;
    savePending = null;
    saveProjectNow(target).catch((e) => console.error('autosave failed', e));
  }, delay);
}
export async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (savePending) {
    const t = savePending; savePending = null;
    await saveProjectNow(t);
  }
}

export async function createProject(name, presetKey) {
  const p = defaultProject(name, presetKey);
  await saveProjectNow(p);
  return p;
}

export async function loadProject(id) {
  const dir = await projectDir(id, false);
  const fh = await dir.getFileHandle('project.json', { create: false });
  const file = await fh.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

export async function renameProject(p, name) {
  p.name = name;
  await saveProjectNow(p);
  return p;
}

export async function deleteProject(id) {
  removeIndex(id);
  try {
    const pd = await projectsDir(false);
    await pd.removeEntry(id, { recursive: true });
  } catch (e) {
    // index already cleared; folder may not exist
    console.warn('purge skipped', e?.name || e);
  }
}

// ---- media file storage --------------------------------------------------
export async function writeMedia(projectId, mediaId, ext, file) {
  const md = await subDir(projectId, 'media', true);
  const fh = await md.getFileHandle(`${mediaId}.${ext}`, { create: true });
  await writeFileHandle(fh, file);
  return `media/${mediaId}.${ext}`;
}
export async function readMedia(projectId, relPath) {
  const name = relPath.split('/').pop();
  const md = await subDir(projectId, 'media', false);
  const fh = await md.getFileHandle(name, { create: false });
  return fh.getFile();
}
export async function writeThumb(projectId, mediaId, blob) {
  const td = await subDir(projectId, 'thumbs', true);
  const fh = await td.getFileHandle(`${mediaId}.jpg`, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return `thumbs/${mediaId}.jpg`;
}
export async function readThumb(projectId, mediaId) {
  const td = await subDir(projectId, 'thumbs', false);
  const fh = await td.getFileHandle(`${mediaId}.jpg`, { create: false });
  return fh.getFile();
}

// ---- storage estimate (M6 uses this; expose now) -------------------------
export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch (_) {
    return { usage: 0, quota: 0 };
  }
}
