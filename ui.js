// ui.js · RoughCut
// DOM layer: screens, project list CRUD, editor shell, import, media bin, and
// the M2 timeline wiring (command bus + timeline view + timeline-following preview).

import {
  listProjects, createProject, loadProject, renameProject, deleteProject,
  readThumb, scheduleSave, flushSave, CANVAS_PRESETS, loadPrefs,
} from './state.js';
import { importFile } from './media.js';
import { Preview } from './preview.js';
import {
  CommandBus, addClipCmd, TimelineView, sourceSecAt, mainTrack, normalize, fmtTime,
} from './timeline.js';

const $ = (sel, root = document) => root.querySelector(sel);

let els = {};
let current = null;     // current project
let previewer = null;   // Preview
let bus = null;         // CommandBus
let view = null;        // TimelineView
const thumbUrls = new Map();

// ---- toasts --------------------------------------------------------------
let toastTimer = null;
export function toast(msg, ms = 1800) {
  const t = els.toast; if (!t) return;
  t.textContent = msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- screens -------------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
}
export function showCapabilityFail(reasons) {
  els.capReasons.innerHTML = '';
  for (const r of reasons) { const li = document.createElement('li'); li.textContent = r; els.capReasons.appendChild(li); }
  showScreen('capability');
}

// ---- project list --------------------------------------------------------
export function renderList() {
  const wrap = els.projectList; wrap.innerHTML = '';
  const projects = listProjects();
  els.emptyList.style.display = projects.length ? 'none' : 'block';
  for (const meta of projects) {
    const card = document.createElement('div'); card.className = 'proj-card';
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
  const name = prompt('Project name', 'Untitled'); if (name == null) return;
  const prefs = loadPrefs();
  const presetKey = prefs.lastCanvas in CANVAS_PRESETS ? prefs.lastCanvas : 'p916';
  const p = await createProject(name.trim() || 'Untitled', presetKey);
  renderList(); await openEditor(p.id);
}
async function onListClick(e) {
  const openBtn = e.target.closest('.proj-open');
  if (openBtn) { await openEditor(openBtn.dataset.id); return; }
  const actBtn = e.target.closest('[data-act]'); if (!actBtn) return;
  const id = actBtn.dataset.id;
  if (actBtn.dataset.act === 'rename') {
    const meta = listProjects().find((m) => m.id === id);
    const name = prompt('Rename project', meta?.name || ''); if (name == null || !name.trim()) return;
    const p = await loadProject(id); await renameProject(p, name.trim()); renderList();
  } else if (actBtn.dataset.act === 'delete') {
    const meta = listProjects().find((m) => m.id === id);
    if (!confirm(`Delete "${meta?.name || 'project'}" and its media? This cannot be undone.`)) return;
    await deleteProject(id); renderList(); toast('Project deleted');
  }
}

// ---- editor --------------------------------------------------------------
async function openEditor(id) {
  current = await loadProject(id);
  normalize(current);
  els.editorTitle.textContent = current.name;
  els.canvasBadge.textContent = `${current.canvas.w}\u00d7${current.canvas.h}`;

  previewer = new Preview(els.preview);
  previewer.sizeToProject(current);
  previewer.clear();

  clearThumbUrls();
  await loadAllThumbs();

  bus = new CommandBus(onBusChange);
  view = new TimelineView({
    scrollEl: els.tlScroll, trackEl: els.tlTrack, playheadEl: els.tlPlayhead, timeEl: els.tlTime,
    project: current, bus,
    getMedia: (mid) => current.media.find((m) => m.id === mid) || null,
    getThumb: (mid) => thumbUrls.get(mid) || null,
    onPlayheadChange: () => refreshPreview(),
    onSelect: () => updateToolbar(),
    toast,
  });

  renderMediaStrip();
  view.render();
  refreshPreview();
  updateToolbar();
  showScreen('editor');
}
async function closeEditor() {
  await flushSave();
  if (previewer) previewer.dispose();
  if (view) { /* view holds no timers */ }
  clearThumbUrls();
  current = null; bus = null; view = null; previewer = null;
  renderList(); showScreen('list');
}

function onBusChange() {
  view.render();
  view.setPlayhead(view.playheadUs);   // reclamp to (possibly new) total, refresh preview
  updateToolbar();
  scheduleSave(current);
}

function updateToolbar() {
  const clips = mainTrack(current).clips.length;
  els.tlUndo.disabled = !bus.canUndo;
  els.tlRedo.disabled = !bus.canRedo;
  els.tlSplit.disabled = clips === 0;
  els.tlDelete.disabled = !view.selectedId;
}

function refreshPreview() {
  const { clip, sourceSec } = sourceSecAt(current, view.playheadUs);
  if (!clip) { previewer.renderAt(current, null); els.previewHint.style.display = 'flex'; return; }
  els.previewHint.style.display = 'none';
  const media = current.media.find((m) => m.id === clip.mediaId) || null;
  previewer.renderAt(current, media, sourceSec);
}

// ---- media bin -----------------------------------------------------------
function clearThumbUrls() {
  for (const url of thumbUrls.values()) { try { URL.revokeObjectURL(url); } catch (_) {} }
  thumbUrls.clear();
}
async function loadAllThumbs() {
  await Promise.all(current.media.filter((m) => m.thumb).map(async (m) => {
    try { const f = await readThumb(current.id, m.id); thumbUrls.set(m.id, URL.createObjectURL(f)); } catch (_) {}
  }));
}
function renderMediaStrip() {
  const strip = els.mediaStrip; strip.innerHTML = '';
  els.stripEmpty.style.display = current.media.length ? 'none' : 'flex';
  for (const m of current.media) {
    const tile = document.createElement('button');
    tile.className = 'media-tile'; tile.dataset.id = m.id;
    const badge = m.kind === 'audio' ? '\u266a' : (m.kind === 'image' ? '\u25a3' : fmtTime(m.durUs));
    tile.innerHTML = `<span class="tile-thumb"></span><span class="tile-badge">${badge}</span>`;
    const host = tile.querySelector('.tile-thumb');
    const url = thumbUrls.get(m.id);
    if (url) host.style.backgroundImage = `url("${url}")`;
    else { host.classList.add('no-thumb'); host.dataset.kind = m.kind; }
    strip.appendChild(tile);
  }
}
async function onStripClick(e) {
  const tile = e.target.closest('.media-tile'); if (!tile) return;
  const m = current.media.find((x) => x.id === tile.dataset.id); if (!m) return;
  if (m.kind === 'audio') { toast('Audio gets its own track in M3'); return; }
  const newId = bus.do(addClipCmd(current, m));
  view.selectClip(newId);
  toast('Added to timeline');
}

// ---- import --------------------------------------------------------------
async function onFilesPicked(fileList) {
  const files = Array.from(fileList || []); if (!files.length) return;
  els.importBtn.disabled = true;
  let done = 0;
  for (const file of files) {
    toast(`Importing ${++done}/${files.length}: ${file.name}`, 4000);
    try {
      const rec = await importFile(current, file);
      current.media.push(rec);
      if (rec.thumb) { try { const f = await readThumb(current.id, rec.id); thumbUrls.set(rec.id, URL.createObjectURL(f)); } catch (_) {} }
      scheduleSave(current);
      renderMediaStrip();
    } catch (e) {
      console.error('import failed', file.name, e);
      toast(`Failed: ${file.name} \u2014 ${e?.message || 'error'}`, 3500);
    }
  }
  els.importBtn.disabled = false;
  await flushSave();
  toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'} \u2014 tap to add to timeline`);
}

// ---- init ----------------------------------------------------------------
export function initUI() {
  els = {
    toast: $('#toast'),
    projectList: $('#project-list'), emptyList: $('#empty-list'), newBtn: $('#new-project'),
    capReasons: $('#cap-reasons'),
    editorTitle: $('#editor-title'), canvasBadge: $('#canvas-badge'), backBtn: $('#editor-back'),
    preview: $('#preview'), previewHint: $('#preview-hint'),
    mediaStrip: $('#media-strip'), stripEmpty: $('#strip-empty'),
    importBtn: $('#import-btn'), fileInput: $('#file-input'),
    badge: $('#badge'),
    tlUndo: $('#tl-undo'), tlRedo: $('#tl-redo'), tlSplit: $('#tl-split'), tlDelete: $('#tl-delete'),
    tlZoomOut: $('#tl-zoomout'), tlZoomIn: $('#tl-zoomin'), tlTime: $('#tl-time'),
    tlScroll: $('#tl-scroll'), tlTrack: $('#tl-track'), tlPlayhead: $('#tl-playhead'),
  };

  els.newBtn.addEventListener('click', newProjectFlow);
  els.projectList.addEventListener('click', onListClick);
  els.backBtn.addEventListener('click', closeEditor);
  els.importBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => { onFilesPicked(e.target.files); e.target.value = ''; });
  els.mediaStrip.addEventListener('click', onStripClick);
  els.badge.addEventListener('click', () => toast(`RoughCut ${els.badge.textContent}`));

  els.tlUndo.addEventListener('click', () => view.undo());
  els.tlRedo.addEventListener('click', () => view.redo());
  els.tlSplit.addEventListener('click', () => view.splitAtPlayhead());
  els.tlDelete.addEventListener('click', () => view.deleteSelected());
  els.tlZoomOut.addEventListener('click', () => view.zoomBy(1 / 1.5));
  els.tlZoomIn.addEventListener('click', () => view.zoomBy(1.5));

  renderList();
  showScreen('list');
}
