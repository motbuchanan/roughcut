// ui.js · RoughCut
// DOM layer: screens, project list (create/rename/delete/open), editor shell,
// import, media strip, and the M1 scrubber. Panels toggle by class, not rerender.

import {
  listProjects, createProject, loadProject, renameProject, deleteProject,
  readThumb, scheduleSave, flushSave, CANVAS_PRESETS, loadPrefs, savePrefs, usToS,
} from './state.js';
import { importFile } from './media.js';
import { ClipPreview } from './preview.js';

const $ = (sel, root = document) => root.querySelector(sel);

let els = {};
let current = null;      // current project object
let previewer = null;    // ClipPreview
let selectedMediaId = null;
const thumbUrls = new Map(); // mediaId -> objectURL (revoke on rerender)

// ---- toasts --------------------------------------------------------------
let toastTimer = null;
export function toast(msg, ms = 1800) {
  const t = els.toast;
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- screens -------------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
}

export function showCapabilityFail(reasons) {
  const list = els.capReasons;
  list.innerHTML = '';
  for (const r of reasons) {
    const li = document.createElement('li');
    li.textContent = r;
    list.appendChild(li);
  }
  showScreen('capability');
}

// ---- project list --------------------------------------------------------
export function renderList() {
  const wrap = els.projectList;
  wrap.innerHTML = '';
  const projects = listProjects();
  els.emptyList.style.display = projects.length ? 'none' : 'block';
  for (const meta of projects) {
    const card = document.createElement('div');
    card.className = 'proj-card';
    const preset = Object.values(CANVAS_PRESETS).find((p) => p.w === meta.canvas.w && p.h === meta.canvas.h);
    card.innerHTML = `
      <button class="proj-open" data-id="${meta.id}">
        <span class="proj-name"></span>
        <span class="proj-sub">${meta.canvas.w}\u00d7${meta.canvas.h} \u00b7 ${preset ? preset.label : ''}</span>
      </button>
      <div class="proj-actions">
        <button class="mini" data-act="rename" data-id="${meta.id}">Rename</button>
        <button class="mini danger" data-act="delete" data-id="${meta.id}">Delete</button>
      </div>`;
    card.querySelector('.proj-name').textContent = meta.name;
    wrap.appendChild(card);
  }
}

async function newProjectFlow() {
  const name = prompt('Project name', 'Untitled')?.trim();
  if (name == null) return;
  const prefs = loadPrefs();
  const presetKey = prefs.lastCanvas in CANVAS_PRESETS ? prefs.lastCanvas : 'p916';
  const p = await createProject(name || 'Untitled', presetKey);
  renderList();
  await openEditor(p.id);
}

async function onListClick(e) {
  const openBtn = e.target.closest('.proj-open');
  if (openBtn) { await openEditor(openBtn.dataset.id); return; }
  const actBtn = e.target.closest('[data-act]');
  if (!actBtn) return;
  const id = actBtn.dataset.id;
  if (actBtn.dataset.act === 'rename') {
    const meta = listProjects().find((m) => m.id === id);
    const name = prompt('Rename project', meta?.name || '')?.trim();
    if (!name) return;
    const p = await loadProject(id);
    await renameProject(p, name);
    renderList();
  } else if (actBtn.dataset.act === 'delete') {
    const meta = listProjects().find((m) => m.id === id);
    if (!confirm(`Delete "${meta?.name || 'project'}" and its media? This cannot be undone.`)) return;
    await deleteProject(id);
    renderList();
    toast('Project deleted');
  }
}

// ---- editor --------------------------------------------------------------
async function openEditor(id) {
  current = await loadProject(id);
  selectedMediaId = null;
  els.editorTitle.textContent = current.name;
  els.canvasBadge.textContent = `${current.canvas.w}\u00d7${current.canvas.h}`;
  if (!previewer) previewer = new ClipPreview(els.preview);
  previewer.dispose();
  clearThumbUrls();
  await renderMediaStrip();
  resetScrubber();
  showScreen('editor');
}

async function closeEditor() {
  await flushSave();
  if (previewer) previewer.dispose();
  clearThumbUrls();
  current = null;
  renderList();
  showScreen('list');
}

function clearThumbUrls() {
  for (const url of thumbUrls.values()) { try { URL.revokeObjectURL(url); } catch (_) {} }
  thumbUrls.clear();
}

async function renderMediaStrip() {
  const strip = els.mediaStrip;
  strip.innerHTML = '';
  els.stripEmpty.style.display = current.media.length ? 'none' : 'flex';
  for (const m of current.media) {
    const tile = document.createElement('button');
    tile.className = 'media-tile' + (m.id === selectedMediaId ? ' selected' : '');
    tile.dataset.id = m.id;
    const dur = m.durUs ? fmtTime(usToS(m.durUs)) : '';
    const badge = m.kind === 'audio' ? '\u266a' : (m.kind === 'image' ? '\u25a3' : dur);
    tile.innerHTML = `<span class="tile-thumb"></span><span class="tile-badge">${badge}</span>`;
    const thumbHost = tile.querySelector('.tile-thumb');
    // load thumb async
    if (m.thumb) {
      readThumb(current.id, m.id).then((file) => {
        const url = URL.createObjectURL(file);
        thumbUrls.set(m.id, url);
        thumbHost.style.backgroundImage = `url("${url}")`;
      }).catch(() => { thumbHost.classList.add('no-thumb'); });
    } else {
      thumbHost.classList.add('no-thumb');
      thumbHost.dataset.kind = m.kind;
    }
    strip.appendChild(tile);
  }
}

async function selectMedia(id) {
  const m = current.media.find((x) => x.id === id);
  if (!m) return;
  selectedMediaId = id;
  document.querySelectorAll('.media-tile').forEach((t) => t.classList.toggle('selected', t.dataset.id === id));
  els.scrubWrap.style.display = 'block';
  els.previewHint.style.display = 'none';
  try {
    await previewer.load(current, m);
  } catch (e) {
    console.error(e);
    toast('Could not open that clip');
  }
  const durS = usToS(m.durUs);
  els.scrub.max = String(Math.max(0.001, durS));
  els.scrub.value = '0';
  els.scrub.disabled = m.kind === 'image' || durS <= 0;
  els.scrubTime.textContent = `${fmtTime(0)} / ${fmtTime(durS)}`;
}

function resetScrubber() {
  els.scrubWrap.style.display = 'none';
  els.previewHint.style.display = 'flex';
  if (previewer) { previewer._clear?.(current?.canvas?.bg || '#000'); }
}

function onScrub() {
  const s = parseFloat(els.scrub.value) || 0;
  els.scrubTime.textContent = `${fmtTime(s)} / ${fmtTime(parseFloat(els.scrub.max) || 0)}`;
  previewer?.seek(s);
}

async function onStripClick(e) {
  const tile = e.target.closest('.media-tile');
  if (!tile) return;
  await selectMedia(tile.dataset.id);
}

// ---- import --------------------------------------------------------------
async function onFilesPicked(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let done = 0;
  els.importBtn.disabled = true;
  for (const file of files) {
    toast(`Importing ${++done}/${files.length}: ${file.name}`, 4000);
    try {
      const rec = await importFile(current, file);
      current.media.push(rec);
      scheduleSave(current);
      await renderMediaStrip();
    } catch (e) {
      console.error('import failed', file.name, e);
      toast(`Failed: ${file.name} \u2014 ${e?.message || 'error'}`, 3500);
    }
  }
  els.importBtn.disabled = false;
  await flushSave();
  toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'}`);
  // auto-select the first new clip if nothing selected
  if (!selectedMediaId && current.media.length) await selectMedia(current.media[current.media.length - 1].id);
}

// ---- helpers -------------------------------------------------------------
function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2, '0')}.${cs}`;
}

// ---- init ----------------------------------------------------------------
export function initUI() {
  els = {
    toast: $('#toast'),
    projectList: $('#project-list'),
    emptyList: $('#empty-list'),
    newBtn: $('#new-project'),
    capReasons: $('#cap-reasons'),
    editorTitle: $('#editor-title'),
    canvasBadge: $('#canvas-badge'),
    backBtn: $('#editor-back'),
    preview: $('#preview'),
    previewHint: $('#preview-hint'),
    mediaStrip: $('#media-strip'),
    stripEmpty: $('#strip-empty'),
    importBtn: $('#import-btn'),
    fileInput: $('#file-input'),
    scrub: $('#scrub'),
    scrubWrap: $('#scrub-wrap'),
    scrubTime: $('#scrub-time'),
    badge: $('#badge'),
  };

  els.newBtn.addEventListener('click', newProjectFlow);
  els.projectList.addEventListener('click', onListClick);
  els.backBtn.addEventListener('click', closeEditor);
  els.importBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => { onFilesPicked(e.target.files); e.target.value = ''; });
  els.mediaStrip.addEventListener('click', onStripClick);
  els.scrub.addEventListener('input', onScrub);
  els.badge.addEventListener('click', () => toast(`RoughCut ${els.badge.textContent}`));

  renderList();
  showScreen('list');
}
