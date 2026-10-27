// ui.js · RoughCut
// DOM layer: screens, project list CRUD, editor shell, import, media bin, and
// the M2 timeline wiring (command bus + timeline view + timeline-following preview).

import {
  listProjects, createProject, loadProject, renameProject, deleteProject,
  readThumb, scheduleSave, flushSave, CANVAS_PRESETS, loadPrefs, savePrefs, storageEstimate,
} from './state.js';
import { importFile } from './media.js';
import { frameOf, isDefaultFrame, clampPan, ZOOM_MIN, ZOOM_MAX } from './frame.js';
import { DUCK, DUCK_LABELS, duckOf, envAt, hasEnv } from './audio.js';
import { PRESETS, lookOf, presetValues, parseCube, registerLut } from './color.js';
import { writeLut, uid } from './state.js';
import { Preview } from './preview.js';
import {
  CommandBus, addClipCmd, addAudioCmd, setClipAudioCmd, detachAudioCmd, findClip, laneOf, clipDurUs, trimClipCmd, trimAudioCmd, tlToSrcUs, MIN_CLIP_US,
  makeColorMedia, insertClipCmd, clipIndexAt, setClipTransitionCmd, setClipSpeedCmd, clipSpeed, SPEEDS, setClipFrameCmd, setClipLookCmd,
  TimelineView, sourceSecAt, mainTrack, normalize, totalUs, fmtTime,
} from './timeline.js';
import { TRANSITIONS, TRANS_DURS, TRANS_DIRS, DIR_GLYPH, makeTransition, canHaveTransIn, transitionAt, hasDirs, clampSrc } from './transitions.js';
import { usToS } from './state.js';
import {
  makeText, addTextCmd, setTextCmd, duplicateTextCmd, textTrack, textDurUs,
  FONTS, SIZES, COLORS, ANIMS, TEXT_DEFAULT_US,
} from './text.js';
import { exportProject, canExport } from './export.js';
import { AudioEngine } from './audio.js';
import { extractAudio, probeAudioCodec, copyPlanFor, canMakeM4a, baseName, fmtBytes } from './extract.js';

const $ = (sel, root = document) => root.querySelector(sel);

let els = {};
let current = null;     // current project
let previewer = null;   // Preview
let bus = null;         // CommandBus
let view = null;        // TimelineView
let engine = null;      // AudioEngine (M3)
let playTimer = null, playToken = 0;
const FADE_STEPS_US = [0, 500_000, 1_000_000, 2_000_000];
let volBefore = null;
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
  renderStorageMeter();
}
async function renderStorageMeter() {
  const el = els.storageMeter; if (!el) return;
  try {
    const { usage, quota } = await storageEstimate();
    if (!quota) { el.hidden = true; return; }
    const mb = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB';
    const pct = Math.min(100, Math.round((usage / quota) * 100));
    els.smFill.style.width = pct + '%';
    els.smFill.style.background = pct >= 90 ? 'var(--danger)' : 'var(--accent)';
    els.smText.textContent = `Storage: ${mb(usage)} used of ${mb(quota)} (${pct}%). Delete projects to free space.`;
    el.hidden = false;
  } catch (_) { el.hidden = true; }
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
  if (openBtn) {
    // Never let a failed open be a silent dead tap: surface it so the user (and we)
    // can see why instead of nothing happening.
    try { await openEditor(openBtn.dataset.id); }
    catch (err) { console.error('open project failed', err); toast('Could not open project: ' + (err?.message || err), 4000); }
    return;
  }
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
  // Fully reset any previous editor first, so one project's clips, preview, or pending
  // save can never bleed into the next (iOS bug: a brand-new project showed the old
  // project's clip in the timeline and it could not be deleted).
  pausePlay();
  try { await flushSave(); } catch (_) {}
  if (previewer) { try { previewer.dispose(); } catch (_) {} previewer = null; }
  if (view) { try { view.dispose(); } catch (_) {} view = null; }
  if (engine) { try { engine.dispose(); } catch (_) {} engine = null; }
  if (els.tlTrack) els.tlTrack.innerHTML = '';   // drop stale clip/lane/ruler nodes from a prior project
  clearThumbUrls();

  current = await loadProject(id);
  normalize(current);
  els.editorTitle.textContent = current.name;
  els.canvasBadge.textContent = `${current.canvas.w}\u00d7${current.canvas.h}`;

  previewer = new Preview(els.preview);
  previewer.sizeToProject(current);
  previewer.showSafe = !!loadPrefs().safeZones;
  els.safeBtn.setAttribute('aria-pressed', String(previewer.showSafe));
  previewer.clear();

  clearThumbUrls();
  await loadAllThumbs();

  bus = new CommandBus(onBusChange);
  if (view) view.dispose();
  if (engine) engine.dispose();
  engine = new AudioEngine();
  view = new TimelineView({
    scrollEl: els.tlScroll, trackEl: els.tlTrack, timeEl: els.tpTime,
    project: current, bus,
    getMedia: (mid) => current.media.find((m) => m.id === mid) || null,
    getThumb: (mid) => thumbUrls.get(mid) || null,
    onPlayheadChange: (us) => onPlayheadMoved(us),
    onUserScrub: () => pausePlay(),
    onSelect: () => { updateToolbar(); renderSheet(); },
    toast,
  });

  renderMediaStrip();
  view.render();
  onPlayheadMoved(0);
  updateToolbar();
  renderSheet();
  showScreen('editor');
}
async function closeEditor() {
  pausePlay();
  commitTyping();
  closePull();
  closeExport();
  closeSettings();
  await flushSave();
  if (previewer) previewer.dispose();
  if (view) view.dispose();
  if (engine) engine.dispose();
  clearThumbUrls();
  current = null; bus = null; view = null; previewer = null; engine = null;
  renderList(); showScreen('list');
}

function onBusChange() {
  pausePlay();
  view.render();
  view.setPlayhead(view.playheadUs);   // reclamp to (possibly new) total, refresh preview
  updateToolbar();
  renderSheet();
  scheduleSave(current);
}

// ---- clip sheet (volume / mute / fades for the selected clip, either lane) ----
function selectedClip() { return view && view.selectedId ? findClip(current, view.selectedId) : null; }
function fadeLabel(us) { return us ? `${(us / 1e6).toFixed(us % 1e6 ? 1 : 0)}s` : 'off'; }
function renderSheet() {
  const c = selectedClip();
  const isText = !!(c && laneOf(current, c.id) === 't');
  // While a text is selected and we are not playing, render it at rest so it is
  // stable to place/style; playback and export animate it.
  if (previewer) previewer.staticTextId = (isText && !playTimer) ? c.id : null;
  els.textSheet.classList.toggle('hidden', !isText);
  els.sheet.classList.toggle('hidden', !c || isText);
  if (isText) { renderTextSheet(c); return; }
  if (!c) return;
  const m = current.media.find((x) => x.id === c.mediaId);
  const lane = laneOf(current, c.id);
  const silent = lane === 'v' && !(m && m.hasAudio);
  els.csName.textContent = (lane === 'a' ? '\u266a ' : '') + (m ? m.name.replace(/\.[^.]+$/, '') : 'clip') + ' \u00b7 ' + fmtTime(clipDurUs(c));
  els.csVol.value = Math.round((c.gain ?? 1) * 100);
  els.csVolVal.textContent = silent ? 'no audio' : `${Math.round((c.gain ?? 1) * 100)}%`;
  els.csMute.textContent = c.muted ? 'Unmute' : 'Mute';
  els.csMute.classList.toggle('on', !!c.muted);
  els.csFadeIn.textContent = `Fade in ${fadeLabel(c.fadeInUs || 0)}`;
  els.csFadeOut.textContent = `Fade out ${fadeLabel(c.fadeOutUs || 0)}`;
  for (const b of [els.csVol, els.csMute, els.csFadeIn, els.csFadeOut]) b.disabled = silent;
  const canPull = !!(m && m.hasAudio) && (lane === 'v' || m.kind === 'video');
  els.csTools.classList.toggle('hidden', !canPull);
  els.csDetach.classList.toggle('hidden', lane !== 'v');
  if (!canPull) closePull();
  applyTab();
  renderEnvRow(c, m, lane, silent);
  renderDuckRow(c, lane);
  renderTrimRow(c, lane);
  renderSpeedRow(c, m, lane);
  renderFrameRows(c, m, lane);
  renderLookRows(c, m, lane);
  renderTransSheet(c);
}

// ---- colour: look presets, four sliders, .cube LUT (main-track picture clips) ----
const ADJ = ['bright', 'contrast', 'sat', 'warm'];
function renderLookRows(c, m, lane) {
  const show = lane === 'v' && !!(m && (m.kind === 'video' || m.kind === 'image'));
  for (const el of [els.csLookRow, els.csAdjRow, els.csLutRow]) el.classList.toggle('hidden', !show);
  if (!show) return;
  const l = lookOf(c);
  [...els.csLook.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === l.preset)));
  for (const k of ADJ) { els.adj[k].value = Math.round(l[k] * 100); els.adjVal[k].textContent = String(Math.round(l[k] * 100)); }
  els.csLutName.textContent = l.lut ? l.lut.name : '';
  els.csLutMix.classList.toggle('hidden', !l.lut); els.csLutClear.classList.toggle('hidden', !l.lut);
  els.csLutImport.classList.toggle('hidden', !!l.lut);
  if (l.lut) els.csLutMix.value = Math.round(l.lutMix * 100);
}
function pickLook(id) {
  const c = selectedClip(); if (!c) return;
  bus.do(setClipLookCmd(current, c.id, presetValues(id), id === 'none' ? 'Clear look' : 'Look: ' + id));
}
let adjBefore = null;
function onAdjStart(k) { const c = selectedClip(); adjBefore = c ? { k, v: lookOf(c)[k] } : null; }
function onAdjInput(k) {
  const c = selectedClip(); if (!c) return;
  const v = Math.max(-1, Math.min(1, Number(els.adj[k].value) / 100));
  c.look = { ...(c.look || {}), [k]: v };          // live, uncommitted; sliders detach from the preset name
  els.adjVal[k].textContent = String(Math.round(v * 100));
  refreshPreview();
}
function onAdjChange(k) {
  const c = selectedClip(); if (!c) return;
  const v = Math.max(-1, Math.min(1, Number(els.adj[k].value) / 100));
  const before = adjBefore && adjBefore.k === k ? adjBefore.v : lookOf(c)[k];
  c.look = { ...(c.look || {}), [k]: before };     // revert, then commit as one undo step
  if (v !== before) bus.do(setClipLookCmd(current, c.id, { [k]: v, preset: 'custom' }, 'Adjust ' + k));
  adjBefore = null;
}
async function onLutPicked(fileList) {
  const file = fileList && fileList[0]; const c = selectedClip(); if (!file || !c) return;
  try {
    const parsed = parseCube(await file.text());
    const id = uid('lut');
    await writeLut(current.id, id, parsed.data);
    registerLut(id, parsed.size, parsed.data);
    const name = (parsed.title || file.name.replace(/\.cube$/i, '')).slice(0, 40);
    bus.do(setClipLookCmd(current, c.id, { lut: { id, name, size: parsed.size }, lutMix: 1 }, 'LUT: ' + name));
    toast(`LUT loaded: ${name} (${parsed.size}\u00b3)`, 2200);
  } catch (e) { toast('Could not read that .cube: ' + (e && e.message ? e.message : e), 4000); }
}
let lutMixBefore = null;
function onLutMixStart() { const c = selectedClip(); lutMixBefore = c ? lookOf(c).lutMix : null; }
function onLutMixInput() { const c = selectedClip(); if (!c) return; c.look = { ...(c.look || {}), lutMix: Number(els.csLutMix.value) / 100 }; refreshPreview(); }
function onLutMixChange() {
  const c = selectedClip(); if (!c) return;
  const v = Number(els.csLutMix.value) / 100;
  if (lutMixBefore != null) c.look = { ...(c.look || {}), lutMix: lutMixBefore };
  if (v !== lutMixBefore) bus.do(setClipLookCmd(current, c.id, { lutMix: v }, 'LUT strength'));
  lutMixBefore = null;
}
function clearLut() { const c = selectedClip(); if (!c) return; bus.do(setClipLookCmd(current, c.id, { lut: null }, 'Remove LUT')); }

// ---- framing: fit / fill, rotate, zoom, drag-to-reposition (main-track picture clips) ----
const fmtZoom = (s) => (s % 1 ? s.toFixed(2).replace(/0$/, '') : s.toFixed(1)) + '\u00d7';
function renderFrameRows(c, m, lane) {
  const show = lane === 'v' && !!(m && (m.kind === 'video' || m.kind === 'image'));
  els.csFrameRow.classList.toggle('hidden', !show);
  els.csZoomRow.classList.toggle('hidden', !show);
  if (!show) return;
  const f = frameOf(c);
  [...els.csFit.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f.fit)));
  els.csRot.innerHTML = '&#8635; ' + f.rot + '&deg;';
  els.csZoom.value = Math.round(f.scale * 100);
  els.csZoomVal.textContent = fmtZoom(f.scale);
  els.csFrameReset.disabled = isDefaultFrame(c);
}
function pickFit(fit) {
  const c = selectedClip(); if (!c || frameOf(c).fit === fit) return;
  bus.do(setClipFrameCmd(current, c.id, { fit }, fit === 'fill' ? 'Fill frame' : 'Fit frame'));
  if (fit === 'fill') toast('Drag the picture to choose what stays in frame', 2200);
}
function rotateClip() {
  const c = selectedClip(); if (!c) return;
  bus.do(setClipFrameCmd(current, c.id, { rot: (frameOf(c).rot + 90) % 360 }, 'Rotate'));
}
function resetFrame() {
  const c = selectedClip(); if (!c) return;
  bus.do(setClipFrameCmd(current, c.id, { fit: 'fit', x: 0, y: 0, scale: 1, rot: 0 }, 'Reset framing'));
}
let zoomBefore = null;
function onZoomStart() { const c = selectedClip(); zoomBefore = c ? frameOf(c).scale : null; }
function onZoomInput() {
  const c = selectedClip(); if (!c) return;
  const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(els.csZoom.value) / 100));
  c.xf = { x: 0, y: 0, scale: 1, rot: 0, opacity: 1, ...(c.xf || {}), scale: s };   // live, uncommitted
  const d = previewer.currentFrameDims();
  if (d) { const p = clampPan(els.preview.width, els.preview.height, d.fw, d.fh, c, c.xf.x, c.xf.y); c.xf.x = p.x; c.xf.y = p.y; }
  els.csZoomVal.textContent = fmtZoom(s);
  refreshPreview();
}
function onZoomChange() {
  const c = selectedClip(); if (!c) return;
  const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(els.csZoom.value) / 100));
  const nx = c.xf ? c.xf.x : 0, ny = c.xf ? c.xf.y : 0;
  if (zoomBefore != null) c.xf = { ...(c.xf || {}), scale: zoomBefore };   // revert, then commit as one undo step
  if (s !== zoomBefore) bus.do(setClipFrameCmd(current, c.id, { scale: s, x: nx, y: ny }, 'Zoom'));
  zoomBefore = null;
}

// ---- clip-sheet tabs: Audio / Picture / Color / Cut (the sheet outgrew one scroll) ----
let csTab = loadPrefs().csTab || 'audio';
function applyTab() {
  [...els.csTabs.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === csTab)));
  els.sheet.querySelectorAll('.cs-row[data-tab]').forEach((row) => row.classList.toggle('tab-off', row.dataset.tab !== csTab));
}
function pickTab(t) { csTab = t; const p = loadPrefs(); p.csTab = t; savePrefs(p); applyTab(); const c = selectedClip(); if (c) renderSheet(); }

// ---- level envelope (any clip with audio): tap to add a point, drag to move it,
// drag it off the bottom to delete. Points are fractions of the clip's timeline length.
const ENV_MAX = 2, ENV_PAD = 10;
let envDrag = null;
function renderEnvRow(c, m, lane, silent) {
  const show = !silent && (lane === 'a' || (lane === 'v' && !!(m && m.hasAudio)));
  els.csEnvRow.classList.toggle('hidden', !show);
  if (!show) return;
  els.csEnvClear.disabled = !hasEnv(c);
  paintEnv(c);
}
function envGeom() {
  const cv = els.csEnv, W = cv.width, H = cv.height;
  return { W, H, x0: ENV_PAD, x1: W - ENV_PAD, y0: ENV_PAD, y1: H - ENV_PAD };
}
function envToXY(p) { const g = envGeom(); return { x: g.x0 + p.t * (g.x1 - g.x0), y: g.y1 - (p.v / ENV_MAX) * (g.y1 - g.y0) }; }
function xyToEnv(x, y) { const g = envGeom(); return { t: Math.max(0, Math.min(1, (x - g.x0) / (g.x1 - g.x0))), v: Math.max(0, Math.min(ENV_MAX, (g.y1 - y) / (g.y1 - g.y0) * ENV_MAX)) }; }
function paintEnv(c) {
  const cv = els.csEnv, ctx = cv.getContext('2d'), g = envGeom();
  ctx.clearRect(0, 0, g.W, g.H);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f59847';
  // reference line at 100%
  const y100 = g.y1 - (1 / ENV_MAX) * (g.y1 - g.y0);
  ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(g.x0, y100 + 0.5); ctx.lineTo(g.x1, y100 + 0.5); ctx.stroke(); ctx.setLineDash([]);
  // curve
  const env = hasEnv(c) ? c.env : [{ t: 0, v: 1 }, { t: 1, v: 1 }];
  ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.beginPath();
  const first = envToXY({ t: 0, v: envAt(env, 0) }); ctx.moveTo(first.x, first.y);
  for (const p of env) { const q = envToXY(p); ctx.lineTo(q.x, q.y); }
  const last = envToXY({ t: 1, v: envAt(env, 1) }); ctx.lineTo(last.x, last.y); ctx.stroke();
  // playhead inside this clip
  const dur = clipDurUs(c); const f = dur > 0 ? (view.playheadUs - c.tlStartUs) / dur : -1;
  if (f >= 0 && f <= 1) { const x = g.x0 + f * (g.x1 - g.x0); ctx.strokeStyle = 'rgba(76,240,224,.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, g.y0 - 6); ctx.lineTo(x, g.y1 + 6); ctx.stroke(); }
  // points
  if (hasEnv(c)) for (const p of c.env) { const q = envToXY(p); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); }
  const pct = Math.round(envAt(env, Math.max(0, Math.min(1, f))) * 100);
  if (f >= 0 && f <= 1) { ctx.font = '600 15px system-ui, sans-serif'; ctx.textAlign = 'right'; const label = pct + '%'; const tw = ctx.measureText(label).width + 10; ctx.fillStyle = 'rgba(13,15,19,.85)'; ctx.fillRect(g.x1 - tw, g.y1 - 16, tw, 20); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillText(label, g.x1 - 5, g.y1 - 1); }
}
function envPoint(e) { const r = els.csEnv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (els.csEnv.width / r.width), y: (e.clientY - r.top) * (els.csEnv.height / r.height) }; }
function onEnvDown(e) {
  const c = selectedClip(); if (!c) return;
  pausePlay();
  const pt = envPoint(e);
  const env = (c.env || []).map((p) => ({ ...p }));
  let idx = -1, best = 20;
  env.forEach((p, i) => { const q = envToXY(p); const d = Math.hypot(q.x - pt.x, q.y - pt.y); if (d < best) { best = d; idx = i; } });
  if (idx < 0) { env.push(xyToEnv(pt.x, pt.y)); env.sort((a, b) => a.t - b.t); idx = env.findIndex((p) => p.t === xyToEnv(pt.x, pt.y).t); }
  envDrag = { before: c.env ? c.env.map((p) => ({ ...p })) : undefined, env, idx, id: c.id, remove: false };
  c.env = env;
  els.csEnv.setPointerCapture(e.pointerId);
  paintEnv(c); e.preventDefault();
}
function onEnvMove(e) {
  const d = envDrag; if (!d) return;
  const c = findClip(current, d.id); if (!c) return;
  const pt = envPoint(e); const g = envGeom();
  d.remove = pt.y > g.y1 + 28;
  const np = xyToEnv(pt.x, pt.y);
  const lo = d.idx > 0 ? d.env[d.idx - 1].t + 0.005 : 0, hi = d.idx < d.env.length - 1 ? d.env[d.idx + 1].t - 0.005 : 1;
  d.env[d.idx] = { t: Math.max(lo, Math.min(hi, np.t)), v: d.remove ? d.env[d.idx].v : np.v };
  c.env = d.env;
  paintEnv(c);
}
function onEnvUp() {
  const d = envDrag; envDrag = null; if (!d) return;
  const c = findClip(current, d.id); if (!c) return;
  let env = d.env.map((p) => ({ t: +p.t.toFixed(4), v: +p.v.toFixed(3) }));
  if (d.remove) env.splice(d.idx, 1);
  if (d.before === undefined) delete c.env; else c.env = d.before;     // revert, then commit as one undo step
  const changed = JSON.stringify(env) !== JSON.stringify(d.before || []);
  if (changed) bus.do(setClipAudioCmd(current, c.id, { env: env.length ? env : undefined }));
  else paintEnv(c);
}
function clearEnv() { const c = selectedClip(); if (!c || !hasEnv(c)) return; bus.do(setClipAudioCmd(current, c.id, { env: undefined })); }

// ---- ducking (music clips on the audio lane) ----
function renderDuckRow(c, lane) {
  const show = lane === 'a' && !c.detached;
  els.csDuckRow.classList.toggle('hidden', !show);
  if (!show) return;
  const cur = duckOf(c);
  [...els.csDuck.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.d === cur)));
}
function pickDuck(d) {
  const c = selectedClip(); if (!c || duckOf(c) === d) return;
  bus.do(setClipAudioCmd(current, c.id, { duck: d === 'off' ? undefined : d }));
  if (d !== 'off') toast('Music drops under the voice on the video track and comes back in the gaps', 2600);
}

// ---- frame-step trimming (v0.37): one project frame at a time, or snap an edge to the playhead ----
const frameUs = () => Math.max(1000, Math.round(1e6 / ((current && current.canvas && current.canvas.fps) || 30)));
function renderTrimRow(c, lane) {
  const show = lane === 'v' || lane === 'a';
  els.csTrimRow.classList.toggle('hidden', !show);
}
function stepFrame(dir) {
  if (!current) return;
  pausePlay();
  const fps = (current.canvas && current.canvas.fps) || 30;
  const frame = Math.round(view.playheadUs * fps / 1e6) + dir;          // step by frame INDEX so 15 steps = exactly 0.5s
  view.setPlayhead(Math.max(0, Math.min(totalUs(current), Math.round(frame * 1e6 / fps))), true);
}
// Move one edge by `dSrcUs` source microseconds (already speed-scaled), or to an absolute source position.
function trimEdge(edge, newSrcUs) {
  const c = selectedClip(); if (!c) return;
  const lane = laneOf(current, c.id); if (lane !== 'v' && lane !== 'a') return;
  const m = current.media.find((x) => x.id === c.mediaId);
  const srcMax = (m && m.kind !== 'image' && m.durUs) ? m.durUs : Number.MAX_SAFE_INTEGER;
  let newIn = c.inUs, newOut = c.outUs;
  if (edge === 'in') newIn = Math.max(0, Math.min(newSrcUs, c.outUs - MIN_CLIP_US));
  else newOut = Math.min(srcMax, Math.max(newSrcUs, c.inUs + MIN_CLIP_US));
  if (newIn === c.inUs && newOut === c.outUs) { toast(edge === 'in' ? 'In point is at its limit' : 'Out point is at its limit', 1400); return; }
  pausePlay();
  if (lane === 'a') {
    const newStart = Math.max(0, c.tlStartUs + Math.round((newIn - c.inUs) / clipSpeed(c)));   // music keeps its place
    bus.do(trimAudioCmd(current, c.id, newIn, newOut, newStart));
  } else bus.do(trimClipCmd(current, c.id, newIn, newOut));
}
function nudgeEdge(edge, dir) {
  const c = selectedClip(); if (!c) return;
  const d = Math.round(frameUs() * clipSpeed(c)) * dir;
  trimEdge(edge, (edge === 'in' ? c.inUs : c.outUs) + d);
}
function edgeToPlayhead(edge) {
  const c = selectedClip(); if (!c) return;
  const local = Math.max(0, Math.min(view.playheadUs - c.tlStartUs, clipDurUs(c)));
  trimEdge(edge, tlToSrcUs(c, local));
}

// ---- speed (main-track video clips) ----
function renderSpeedRow(c, m, lane) {
  const show = lane === 'v' && !!(m && m.kind === 'video');
  els.csSpeedRow.classList.toggle('hidden', !show);
  if (!show) return;
  const cur = clipSpeed(c);
  [...els.csSpeed.children].forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.s) === cur)));
}
function pickSpeed(speed) {
  const c = selectedClip(); if (!c) return;
  if (clipSpeed(c) === speed) return;
  bus.do(setClipSpeedCmd(current, c.id, speed));
  toast(speed === 1 ? 'Normal speed' : (speed < 1 ? `Slow-mo ${speed}\u00d7 (pitch drops with it)` : `${speed}\u00d7 faster`), 1600);
}

// ---- transitions (dip / flash at the cut in front of a main-track clip) ----
let transDurUs = 500_000;   // seeds a newly-added transition; follows the user's last duration pick
function renderTransSheet(c) {
  const show = laneOf(current, c.id) === 'v' && canHaveTransIn(current, c.id);
  els.csTrans.classList.toggle('hidden', !show);
  if (!show) return;
  const cur = (c.transIn && c.transIn.type) ? c.transIn.type : 'none';
  [...els.csTransType.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === cur)));
  const active = cur !== 'none';
  const us = active ? (c.transIn.durUs || transDurUs) : transDurUs;
  els.csTransDur.textContent = (us / 1e6).toFixed(us % 1e6 ? 1 : 0) + 's';
  els.csTransDur.disabled = !active;
  const dirs = active && hasDirs(cur);
  els.csTransDir.classList.toggle('hidden', !dirs);
  if (dirs) els.csTransDir.textContent = DIR_GLYPH[c.transIn.dir || 'L'];
}
function setTransType(type) {
  const c = selectedClip();
  if (!c || laneOf(current, c.id) !== 'v' || !canHaveTransIn(current, c.id)) return;
  if (type === 'none') { bus.do(setClipTransitionCmd(current, c.id, null)); return; }
  const us = (c.transIn && c.transIn.durUs) ? c.transIn.durUs : transDurUs;
  const dir = (c.transIn && c.transIn.dir) || 'L';
  bus.do(setClipTransitionCmd(current, c.id, makeTransition(type, us, dir)));
  // park the playhead on the cut so the transition shows in the preview right away
  view.setPlayhead(c.tlStartUs);
}
function cycleTransDur() {
  const c = selectedClip();
  if (!c || !c.transIn || c.transIn.type === 'none') return;
  const durs = TRANS_DURS.map((d) => d.us);
  const i = durs.indexOf(c.transIn.durUs);
  const next = durs[(i + 1) % durs.length];
  transDurUs = next;
  bus.do(setClipTransitionCmd(current, c.id, makeTransition(c.transIn.type, next, c.transIn.dir)));
}
function cycleTransDir() {
  const c = selectedClip();
  if (!c || !c.transIn || !hasDirs(c.transIn.type)) return;
  const i = TRANS_DIRS.indexOf(c.transIn.dir || 'L');
  const next = TRANS_DIRS[(i + 1) % TRANS_DIRS.length];
  bus.do(setClipTransitionCmd(current, c.id, makeTransition(c.transIn.type, c.transIn.durUs, next)));
  view.setPlayhead(c.tlStartUs);
}

// ---- text (M4) ----------------------------------------------------------
function addTextAtPlayhead() {
  if (!mainTrack(current).clips.length) { toast('Add a clip first so the text has something to sit on'); return; }
  const total = totalUs(current);
  const start = Math.min(view.playheadUs, Math.max(0, total - TEXT_DEFAULT_US));
  const item = makeText(start, { text: 'Your text', y: 0.8 });
  const id = bus.do(addTextCmd(current, item));
  view.selectClip(id);
  els.tsText.focus(); els.tsText.select();
}
// Title card: a 3s color card inserted in front of the clip under the playhead, plus centered text on it.
function addTitleCard() {
  const idx = mainTrack(current).clips.length ? Math.max(0, clipIndexAt(current, view.playheadUs)) : 0;
  const media = makeColorMedia('#000000');
  current.media.push(media);
  const cid = bus.do(insertClipCmd(current, media, idx, 3_000_000));
  const clip = findClip(current, cid);
  const item = makeText(clip.tlStartUs, { text: 'Title', y: 0.5, size: 0.11, durUs: 3_000_000 });
  const tid = bus.do(addTextCmd(current, item));
  view.selectClip(tid, { moveHead: true });
  els.tsText.focus(); els.tsText.select();
  toast('Title card added. Type your title.');
}
function renderTextSheet(it) {
  if (document.activeElement !== els.tsText) els.tsText.value = it.text || '';
  paintSeg(els.tsSize, SIZES.findIndex((s) => Math.abs(s.v - it.size) < 1e-6));
  paintSeg(els.tsFont, FONTS.findIndex((f) => f.id === it.font));
  paintSeg(els.tsAlign, ['left', 'center', 'right'].indexOf(it.align || 'center'));
  paintSeg(els.tsBg, ['none', 'pill', 'band'].indexOf(it.bg || 'none'));
  els.tsBold.setAttribute('aria-pressed', String(!!it.bold));
  els.tsColors.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === (it.color || '#ffffff'))));
  paintSeg(els.tsAnim, ANIMS.findIndex((a) => a.id === (it.anim || 'none')));
  els.tsOutline.textContent = it.outline ? 'Outline on' : 'Outline off';
  els.tsOutline.classList.toggle('on', !!it.outline);
  els.tsGlow.textContent = it.glow ? 'Glow on' : 'Glow off';
  els.tsGlow.classList.toggle('on', !!it.glow);
  els.tsRange.textContent = `${fmtTime(it.tlStartUs)} for ${fmtTime(textDurUs(it))}`;
}
function paintSeg(host, idx) { [...host.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === idx))); }
function setText(props, label) {
  const it = selectedClip(); if (!it || laneOf(current, it.id) !== 't') return;
  bus.do(setTextCmd(current, it.id, props, label));
}
let textTyping = null;
function onTextInput() {
  const it = selectedClip(); if (!it || laneOf(current, it.id) !== 't') return;
  it.text = els.tsText.value;                 // live, uncommitted
  previewer.repaintOverlay(); view.render();
  clearTimeout(textTyping);
  textTyping = setTimeout(commitTyping, 600);
}
let textBefore = null;
function onTextFocus() { const it = selectedClip(); textBefore = it ? it.text : null; }
function commitTyping() {
  clearTimeout(textTyping); textTyping = null;
  const it = selectedClip(); if (!it || laneOf(current, it.id) !== 't' || textBefore === null) return;
  const now = els.tsText.value;
  if (now === textBefore) return;
  it.text = textBefore;
  bus.do(setTextCmd(current, it.id, { text: now }, 'Edit text'));
  textBefore = now;
}
function duplicateText() {
  const it = selectedClip(); if (!it || laneOf(current, it.id) !== 't') return;
  const id = bus.do(duplicateTextCmd(current, it.id));
  if (id) view.selectClip(id, { moveHead: true });
}

// drag text on the preview canvas
let pdrag = null;
function canvasPoint(e) {
  const r = els.preview.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (els.preview.width / r.width), y: (e.clientY - r.top) * (els.preview.height / r.height) };
}
function onPreviewDown(e) {
  const pt = canvasPoint(e);
  const boxes = previewer.hitBoxes || [];
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1) {
      const it = findClip(current, b.id); if (!it) return;
      pausePlay();
      els.preview.setPointerCapture(e.pointerId);
      pdrag = { id: it.id, x0: it.x, y0: it.y, sx: pt.x, sy: pt.y, moved: false };
      if (view.selectedId !== it.id) view.selectClip(it.id);
      els.preview.classList.add('dragging');
      e.preventDefault();
      return;
    }
  }
  // No text under the finger: drag the selected picture clip to reposition it,
  // when that clip is the one on screen right now.
  const sel = selectedClip();
  if (!sel || laneOf(current, sel.id) !== 'v') return;
  const onScreen = sourceSecAt(current, view.playheadUs).clip;
  if (!onScreen || onScreen.id !== sel.id) return;
  const m = current.media.find((x) => x.id === sel.mediaId);
  if (!m || (m.kind !== 'video' && m.kind !== 'image')) return;
  pausePlay();
  els.preview.setPointerCapture(e.pointerId);
  const f = frameOf(sel);
  pdrag = { kind: 'frame', id: sel.id, x0: f.x, y0: f.y, sx: pt.x, sy: pt.y, moved: false };
  els.preview.classList.add('panning');
  e.preventDefault();
}
function onPreviewMove(e) {
  if (!pdrag) return;
  const pt = canvasPoint(e);
  const it = findClip(current, pdrag.id); if (!it) return;
  const dx = (pt.x - pdrag.sx) / els.preview.width, dy = (pt.y - pdrag.sy) / els.preview.height;
  if (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005) pdrag.moved = true;
  if (pdrag.kind === 'frame') {
    const d = previewer.currentFrameDims();
    let nx = pdrag.x0 + dx, ny = pdrag.y0 + dy;
    if (d) ({ x: nx, y: ny } = clampPan(els.preview.width, els.preview.height, d.fw, d.fh, it, nx, ny));
    it.xf = { x: 0, y: 0, scale: 1, rot: 0, opacity: 1, ...(it.xf || {}), x: nx, y: ny };   // live, uncommitted
    refreshPreview();
    return;
  }
  it.x = Math.max(0.05, Math.min(0.95, pdrag.x0 + dx));
  it.y = Math.max(0.05, Math.min(0.95, pdrag.y0 + dy));
  previewer.repaintOverlay();
}
function onPreviewUp() {
  if (!pdrag) return;
  const d = pdrag; pdrag = null;
  els.preview.classList.remove('dragging'); els.preview.classList.remove('panning');
  const it = findClip(current, d.id); if (!it) return;
  if (d.kind === 'frame') {
    const nx = it.xf ? it.xf.x : 0, ny = it.xf ? it.xf.y : 0;
    it.xf = { ...(it.xf || {}), x: d.x0, y: d.y0 };   // revert, then commit as one undo step
    if (d.moved) bus.do(setClipFrameCmd(current, d.id, { x: nx, y: ny }, 'Reposition'));
    else refreshPreview();
    return;
  }
  const nx = it.x, ny = it.y;
  it.x = d.x0; it.y = d.y0;
  if (d.moved) bus.do(setTextCmd(current, d.id, { x: nx, y: ny }, 'Move text'));
  else previewer.repaintOverlay();
}

// ---- detach audio (video clip -> music lane, video muted) ----
function detachAudio() {
  const c = selectedClip(); if (!c) return;
  const m = current.media.find((x) => x.id === c.mediaId);
  if (!m || !m.hasAudio) { toast('This clip has no audio'); return; }
  const id = bus.do(detachAudioCmd(current, c.id, m));
  if (id) { view.selectClip(id); toast('Audio detached to the music lane; video muted'); }
}

// ---- pull audio to a file (AudioPull) ----
let pull = { media: null, clip: null, job: null, blob: null, name: '', fmt: loadPrefs().pullFmt || 'm4a', copyPlan: null };
async function openPull() {
  const c = selectedClip(); if (!c) return;
  const m = current.media.find((x) => x.id === c.mediaId); if (!m || !m.hasAudio) return;
  pausePlay();
  resetPullResult();
  pull.media = m; pull.clip = c; pull.copyPlan = null;
  els.pullName.value = baseName(m.name) + (clipDurUs(c) < (m.durUs || 0) ? '-cut' : '');
  els.pullRange.textContent = `${fmtTime(c.inUs)} \u2013 ${fmtTime(c.outUs)} of ${fmtTime(m.durUs || 0)}`;
  els.pullWhole.checked = false;
  els.pullSheet.classList.remove('hidden');
  els.pullStatus.textContent = '';
  // codec probe decides whether Original is offered
  const copyChip = els.pullChips.querySelector('[data-fmt="copy"]');
  copyChip.disabled = true; copyChip.querySelector('small').textContent = 'checking\u2026';
  const m4aChip = els.pullChips.querySelector('[data-fmt="m4a"]');
  if (!(await canMakeM4a())) { m4aChip.disabled = true; m4aChip.querySelector('small').textContent = 'not supported here'; if (pull.fmt === 'm4a') pull.fmt = 'wav'; }
  try {
    const codec = await probeAudioCodec(current, m);
    pull.copyPlan = copyPlanFor(codec);
    if (pull.copyPlan) { copyChip.disabled = false; copyChip.querySelector('small').textContent = `${pull.copyPlan.label}, no re-encode \u00b7 .${pull.copyPlan.ext}`; }
    else { copyChip.querySelector('small').textContent = `${String(codec || 'codec').toUpperCase()} can\u2019t be copied as-is`; if (pull.fmt === 'copy') pull.fmt = m4aChip.disabled ? 'wav' : 'm4a'; }
  } catch (_) { copyChip.querySelector('small').textContent = 'unknown codec'; if (pull.fmt === 'copy') pull.fmt = 'm4a'; }
  paintPullChips();
  els.pullSheet.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closePull() {
  if (pull.job) { pull.job.cancel(); pull.job = null; }
  resetPullResult();
  els.pullSheet.classList.add('hidden');
}
function paintPullChips() {
  els.pullChips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.fmt === pull.fmt)));
}
function resetPullResult() {
  if (els.pullPlayer.src) { try { URL.revokeObjectURL(els.pullPlayer.src); } catch (_) {} els.pullPlayer.removeAttribute('src'); }
  pull.blob = null; pull.name = '';
  els.pullResult.classList.add('hidden');
  els.pullBar.style.width = '0%';
  els.pullRun.textContent = 'Pull audio';
}
async function runPull() {
  if (pull.job) { pull.job.cancel(); return; }
  const m = pull.media, c = pull.clip; if (!m || !c) return;
  resetPullResult();
  const whole = els.pullWhole.checked;
  const opts = { fmt: pull.fmt, onProgress: (p) => { els.pullBar.style.width = (p * 100).toFixed(1) + '%'; els.pullStatus.textContent = `Pulling\u2026 ${Math.round(p * 100)}%`; } };
  if (!whole) { opts.startUs = c.inUs; opts.endUs = c.outUs; }
  els.pullRun.textContent = 'Cancel';
  els.pullStatus.className = 'pull-status';
  els.pullStatus.textContent = 'Starting\u2026';
  const t0 = performance.now();
  pull.job = extractAudio(current, m, opts);
  try {
    const { blob, ext, mime } = await pull.job.promise;
    pull.blob = blob;
    pull.name = ((els.pullName.value || baseName(m.name)).trim() || 'audio') + '.' + ext;
    els.pullBar.style.width = '100%';
    els.pullStatus.className = 'pull-status ok';
    els.pullStatus.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s \u00b7 ${fmtBytes(blob.size)} \u00b7 ${pull.name}`;
    els.pullPlayer.src = URL.createObjectURL(blob);
    els.pullResult.classList.remove('hidden');
    let shareable = false;
    try { shareable = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], pull.name, { type: mime })] })); } catch (_) {}
    els.pullShare.disabled = !shareable;
  } catch (e) {
    els.pullBar.style.width = '0%';
    const cancelled = e && e.name === 'ConversionCanceledError';
    els.pullStatus.className = 'pull-status' + (cancelled ? '' : ' bad');
    els.pullStatus.textContent = cancelled ? 'Cancelled.' : (e?.message || String(e));
  } finally {
    pull.job = null;
    els.pullRun.textContent = 'Pull audio';
  }
}
function savePull() {
  if (!pull.blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pull.blob); a.download = pull.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saving ' + pull.name);
}
async function sharePull() {
  if (!pull.blob) return;
  const f = new File([pull.blob], pull.name, { type: pull.blob.type });
  try { await navigator.share({ files: [f], title: pull.name }); }
  catch (e) { if (e.name !== 'AbortError') toast('Share failed; use Save instead.'); }
}
async function addPullToProject() {
  if (!pull.blob) return;
  const f = new File([pull.blob], pull.name, { type: pull.blob.type });
  await onFilesPicked([f]);
}
function onVolInput() {
  const c = selectedClip(); if (!c) return;
  const v = parseInt(els.csVol.value, 10) / 100;
  c.gain = v;                                    // live, uncommitted
  els.csVolVal.textContent = `${Math.round(v * 100)}%`;
  engine.setClipGainLive(c.id, c.muted ? 0 : v);
}
function onVolChange() {
  const c = selectedClip(); if (!c) return;
  const v = parseInt(els.csVol.value, 10) / 100;
  c.gain = volBefore ?? v;                       // revert live edit, commit as one undo step
  volBefore = null;
  bus.do(setClipAudioCmd(current, c.id, { gain: v }));
}
function onVolStart() { const c = selectedClip(); volBefore = c ? (c.gain ?? 1) : null; }
function cycleFade(key) {
  const c = selectedClip(); if (!c) return;
  const cur = c[key] || 0;
  const i = FADE_STEPS_US.indexOf(cur);
  let next = FADE_STEPS_US[(i + 1) % FADE_STEPS_US.length];
  const half = Math.floor(clipDurUs(c) / 2);
  if (next > half) next = 0;                     // never let fades overlap on a short clip
  bus.do(setClipAudioCmd(current, c.id, { [key]: next }));
}
function toggleMute() {
  const c = selectedClip(); if (!c) return;
  bus.do(setClipAudioCmd(current, c.id, { muted: !c.muted }));
}

function updateToolbar() {
  const clips = mainTrack(current).clips.length;
  els.tlUndo.disabled = !bus.canUndo;
  els.tlRedo.disabled = !bus.canRedo;
  els.tlSplit.disabled = clips === 0;
  els.tlDelete.disabled = !view.selectedId;
  els.tlText.disabled = clips === 0;
  const has = clips > 0;
  els.tpPlay.disabled = !has;
  els.tpStart.disabled = !has;
  els.tpEnd.disabled = !has;
  els.tpPrevF.disabled = !has;
  els.tpNextF.disabled = !has;
  els.tlHint.classList.toggle('hidden', has && bus.undoStack.length > 2);
}

function refreshPreview() {
  { const sc = selectedClip(); if (sc && els.csEnvRow && !els.csEnvRow.classList.contains('hidden') && !envDrag) paintEnv(sc); }
  const { clip, sourceSec } = sourceSecAt(current, view.playheadUs);
  if (!clip) { previewer.renderAt(current, null, 0, view.playheadUs); els.previewHint.style.display = 'flex'; return; }
  els.previewHint.style.display = 'none';
  // inside a crossfade/slide/wipe/zoom window: both clips, blended live
  const tr = transitionAt(current, view.playheadUs);
  if (tr) {
    const mA = current.media.find((m) => m.id === tr.a.mediaId) || null;
    const mB = current.media.find((m) => m.id === tr.b.mediaId) || null;
    if (mA && mB) {
      previewer.renderTransition(current, mA, usToS(clampSrc(tr.srcA, mA)), mB, usToS(clampSrc(tr.srcB, mB)), tr, view.playheadUs);
      return;
    }
  }
  const media = current.media.find((m) => m.id === clip.mediaId) || null;
  previewer.renderAt(current, media, sourceSec, view.playheadUs, clip);
}

// single funnel for every playhead move (strip scroll, play loop, select, edit)
function onPlayheadMoved(us) { refreshPreview(); }

// Playback clock is the AudioContext clock (M3): the playhead reads engine.nowUs()
// every tick, so picture follows sound and battery-saver rAF throttling is irrelevant.
// The tick itself is a setTimeout, not rAF, for the same reason.
async function startPlay() {
  const total = totalUs(current);
  if (total <= 0) return;
  if (view.playheadUs >= total - 1000) view.setPlayhead(0);
  const token = ++playToken;
  const fromUs = view.playheadUs;
  els.tpPlay.innerHTML = '&#8987;'; // hourglass while audio decodes
  els.tpPlay.disabled = true;
  const slow = setTimeout(() => toast('Preparing audio\u2026', 2500), 400);
  try { await engine.prepare(current, fromUs, total); }
  catch (e) { console.warn(e); }
  clearTimeout(slow);
  els.tpPlay.disabled = false;
  if (token !== playToken || !current) { els.tpPlay.innerHTML = '&#9654;'; return; }
  engine.start(current, fromUs, total);
  els.tpPlay.innerHTML = '&#10073;&#10073;'; // pause glyph
  view.setPlaying(true);
  if (previewer) previewer.staticTextId = null;   // let text animate live during playback
  const step = () => {
    if (!playTimer || token !== playToken) return;
    const us = engine.nowUs();
    if (us >= total) { view.setPlayhead(total); pausePlay(); return; }
    view.setPlayhead(us);
    playTimer = setTimeout(step, 16);
  };
  playTimer = setTimeout(step, 16);
}
function pausePlay() {
  playToken++;
  if (engine) engine.stop();                      // silence first, always
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  if (view) view.setPlaying(false);
  if (els.tpPlay) { els.tpPlay.innerHTML = '&#9654;'; els.tpPlay.disabled = mainTrack(current || { tracks: [{ id: 'v1', clips: [] }] }).clips.length === 0; }
  // back to rest for the text being edited, if any
  if (previewer && current && view) {
    const sc = view.selectedId ? findClip(current, view.selectedId) : null;
    previewer.staticTextId = (sc && laneOf(current, sc.id) === 't') ? sc.id : null;
    previewer.repaintOverlay();
  }
}
function togglePlay() { if (playTimer) pausePlay(); else startPlay(); }

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
  els.stripEmpty.style.display = current.media.some((m) => m.kind !== 'color') ? 'none' : 'flex';
  for (const m of current.media) {
    if (m.kind === 'color') continue;
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
  if (m.kind === 'audio') {
    if (!mainTrack(current).clips.length) { toast('Add a video clip first, then music goes under it'); return; }
    const newId = bus.do(addAudioCmd(current, m, view.playheadUs));
    view.selectClip(newId, { moveHead: true });
    const c = findClip(current, newId);
    if (c.tlStartUs + clipDurUs(c) > totalUs(current)) toast('Music runs past the end of the cut; it stops where the video ends', 2600);
    else toast('Music added under the cut');
    return;
  }
  const newId = bus.do(addClipCmd(current, m));
  view.selectClip(newId, { moveHead: true });
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

// ---- project settings (M6): aspect + background ---------------------------
const SET_BG = ['#000000', '#ffffff', '#0b1a20', '#4cf0e0', '#f59847', '#7be495'];
function openSettings() {
  if (!current) return;
  pausePlay(); commitTyping();
  if (!els.setBg.childElementCount) els.setBg.innerHTML = SET_BG.map((c) => `<button class="swatch" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('');
  renderSettings();
  els.settingsOverlay.classList.remove('hidden');
}
function closeSettings() { els.settingsOverlay.classList.add('hidden'); }
function renderSettings() {
  const cur = current.canvas;
  const keys = Object.keys(CANVAS_PRESETS);
  [...els.setAspect.children].forEach((b) => {
    const p = CANVAS_PRESETS[b.dataset.k];
    b.setAttribute('aria-pressed', String(!!p && p.w === cur.w && p.h === cur.h));
  });
  els.setBg.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.c || '').toLowerCase() === (cur.bg || '#000000').toLowerCase())));
  els.setSummary.textContent = `${cur.w}\u00d7${cur.h}`;
}
function applyCanvas() {
  previewer.sizeToProject(current);
  els.canvasBadge.textContent = `${current.canvas.w}\u00d7${current.canvas.h}`;
  refreshPreview();
  scheduleSave(current);
  renderSettings();
}
function setAspect(k) {
  const p = CANVAS_PRESETS[k]; if (!p) return;
  current.canvas.w = p.w; current.canvas.h = p.h;
  const prefs = loadPrefs(); prefs.lastCanvas = k; savePrefs(prefs);
  applyCanvas();
}
function setBg(hex) { current.canvas.bg = hex; applyCanvas(); }

// ---- export (M5) ---------------------------------------------------------
// Default to 720p (scale 0.6667 of a 1080-wide project): full 1080p in-browser
// export holds the whole MP4 in memory and can exhaust a phone tab on longer clips.
let exp = { job: null, blob: null, name: '', scale: 0.6667, fps: 24, quality: 'high', url: null };
{ const p = loadPrefs(); if (p.exScale) exp.scale = p.exScale; if (p.exFps) exp.fps = p.exFps; if (p.exQuality) exp.quality = p.exQuality; }
function saveExportPrefs() { const p = loadPrefs(); p.exScale = exp.scale; p.exFps = exp.fps; p.exQuality = exp.quality; savePrefs(p); }
function paintExportSegs() {
  const sel = (seg, pred) => [...seg.children].forEach((b) => b.setAttribute('aria-pressed', String(pred(b))));
  sel(els.exRes, (b) => Math.abs(parseFloat(b.dataset.scale) - exp.scale) < 0.001);
  sel(els.exFps, (b) => parseInt(b.dataset.fps, 10) === exp.fps);
  sel(els.exQuality, (b) => String(b.dataset.q) === String(exp.quality));
}
function exportSummary() {
  const W = Math.round(current.canvas.w * exp.scale / 2) * 2;
  const H = Math.round(current.canvas.h * exp.scale / 2) * 2;
  const full = exp.scale >= 0.999;
  const secs = usToS(totalUs(current));
  const vbr = Number(exp.quality);
  const est = vbr > 0 ? ` \u00b7 about ${fmtBytes((vbr + 160000) * secs / 8)}` : '';
  els.exSummary.textContent = `${W}\u00d7${H} \u00b7 ${exp.fps} fps \u00b7 ${fmtTime(totalUs(current))}${est} \u00b7 H.264 + AAC MP4`;
  // Honest heads-up: full-res, 60 fps, or a long clip at Full can exceed an older phone's encoder.
  const longFull = full && secs > 45;
  const heavy = full || exp.fps >= 60;
  els.exSummary.style.color = longFull ? 'var(--danger)' : '';
  if (longFull) els.exSummary.textContent += '. A long clip at Full may not finish on a phone; 720p is safer.';
  else if (heavy) els.exSummary.textContent += exp.fps >= 60 ? '. 60 fps is heavy; older phones may fail or drop frames.' : '. Full is heavier on phones.';
}
async function openExport() {
  if (!mainTrack(current).clips.length) { toast('Add clips to the timeline first'); return; }
  pausePlay(); commitTyping();
  const cap = await canExport();
  els.exportOverlay.classList.remove('hidden');
  showExportPane('setup');
  if (!cap.ok) { toast(cap.reasons.join(' ')); }
  exportSummary();
}
function showExportPane(which) {
  els.exportSetup.classList.toggle('hidden', which !== 'setup');
  els.exportProgress.classList.toggle('hidden', which !== 'progress');
  els.exportResult.classList.toggle('hidden', which !== 'result');
}
function closeExport() {
  if (exp.job) { exp.job.cancel(); exp.job = null; }
  if (exp.url) { try { URL.revokeObjectURL(exp.url); } catch (_) {} exp.url = null; }
  els.exPlayer.removeAttribute('src');
  exp.blob = null;
  els.exportOverlay.classList.add('hidden');
  try { navigator.storage.getDirectory().then((r) => r.removeEntry('roughcut-export.tmp.mp4').catch(() => {})); } catch (_) {}
}
let lastAudioInfo = null;   // last export's audio result, for the tap-to-diagnose line
async function runExport() {
  showExportPane('progress');
  els.exBar.style.width = '0%'; els.exStatus.className = 'ex-status'; els.exStatus.textContent = 'Starting\u2026';
  const t0 = performance.now();
  exp.job = exportProject(current, {
    fps: exp.fps, quality: exp.quality, scale: exp.scale,
    onProgress: (p, msg) => {
      els.exBar.style.width = (p * 100).toFixed(1) + '%';
      const pct = Math.round(p * 100);
      els.exStatus.textContent = msg ? msg : (p < 0.12 ? `Mixing audio\u2026 ${pct}%` : `Rendering video\u2026 ${pct}%`);
    },
  });
  try {
    const r = await exp.job.promise;
    exp.blob = r.blob;
    exp.name = (current.name || 'RoughCut').replace(/[^\w\-]+/g, '_') + '.mp4';
    exp.url = URL.createObjectURL(r.blob);
    els.exPlayer.src = exp.url;
    els.exDone.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s \u00b7 ${r.w}\u00d7${r.h} \u00b7 ${fmtBytes(r.blob.size)}`;
    const au = r.audio || {};
    lastAudioInfo = au;
    if (au.included) { const tag = au.mode === 'copy' ? ', original copy' : (au.mode === 'encode-fix' || au.mode === 'ffmpeg') ? ', mixed' : ''; els.exAudio.className = 'ex-status ok'; els.exAudio.textContent = `Audio included (${au.codec}${tag}) \u00b7 tap for details`; }
    else { els.exAudio.className = 'ex-status bad'; els.exAudio.textContent = `No audio \u2014 ${au.reason || 'unknown reason'} \u00b7 tap for details`; }
    let shareable = false;
    try { shareable = !!(navigator.canShare && navigator.canShare({ files: [new File([r.blob], exp.name, { type: 'video/mp4' })] })); } catch (_) {}
    els.exShare.disabled = !shareable;
    showExportPane('result');
  } catch (e) {
    if (e && e.name === 'ExportCanceledError') { showExportPane('setup'); return; }
    console.error(e);
    els.exStatus.className = 'ex-status bad';
    els.exStatus.textContent = e?.message || String(e);
  } finally {
    exp.job = null;
  }
}
function saveExport() {
  if (!exp.blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(exp.blob); a.download = exp.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saving ' + exp.name);
}
async function shareExport() {
  if (!exp.blob) return;
  try { await navigator.share({ files: [new File([exp.blob], exp.name, { type: 'video/mp4' })], title: exp.name }); }
  catch (e) { if (e.name !== 'AbortError') toast('Share failed; use Save instead.'); }
}

// ---- init ----------------------------------------------------------------
export function initUI() {
  els = {
    toast: $('#toast'),
    projectList: $('#project-list'), emptyList: $('#empty-list'), newBtn: $('#new-project'),
    storageMeter: $('#storage-meter'), smFill: $('#sm-fill'), smText: $('#sm-text'),
    capReasons: $('#cap-reasons'),
    editorTitle: $('#editor-title'), canvasBadge: $('#canvas-badge'), backBtn: $('#editor-back'),
    preview: $('#preview'), previewHint: $('#preview-hint'),
    mediaStrip: $('#media-strip'), stripEmpty: $('#strip-empty'),
    importBtn: $('#import-btn'), fileInput: $('#file-input'),
    badge: $('#badge'),
    tlUndo: $('#tl-undo'), tlRedo: $('#tl-redo'), tlSplit: $('#tl-split'), tlDelete: $('#tl-delete'),
    tlZoomOut: $('#tl-zoomout'), tlZoomIn: $('#tl-zoomin'),
    tlScroll: $('#tl-scroll'), tlTrack: $('#tl-track'), tlHint: $('#tl-hint'),
    tpStart: $('#tp-start'), tpPlay: $('#tp-play'), tpEnd: $('#tp-end'), tpTime: $('#tp-time'), tpPrevF: $('#tp-prevf'), tpNextF: $('#tp-nextf'),
    csTrimRow: $('#cs-trim-row'),
    sheet: $('#clip-sheet'), csName: $('#cs-name'), csVol: $('#cs-vol'), csVolVal: $('#cs-vol-val'),
    csMute: $('#cs-mute'), csFadeIn: $('#cs-fadein'), csFadeOut: $('#cs-fadeout'),
    csTools: $('#cs-tools'), csDetach: $('#cs-detach'), csPull: $('#cs-pull'),
    csTrans: $('#cs-trans'), csTransType: $('#cs-trans-type'), csTransDur: $('#cs-trans-dur'), csTransDir: $('#cs-trans-dir'),
    csSpeedRow: $('#cs-speed-row'), csSpeed: $('#cs-speed'),
    csTabs: $('#cs-tabs'), csEnvRow: $('#cs-env-row'), csEnv: $('#cs-env'), csEnvClear: $('#cs-env-clear'), csDuckRow: $('#cs-duck-row'), csDuck: $('#cs-duck'),
    csFrameRow: $('#cs-frame-row'), csFit: $('#cs-fit'), csRot: $('#cs-rot'), csFrameReset: $('#cs-frame-reset'),
    csZoomRow: $('#cs-zoom-row'), csZoom: $('#cs-zoom'), csZoomVal: $('#cs-zoom-val'), safeBtn: $('#safe-btn'),
    csLookRow: $('#cs-look-row'), csLook: $('#cs-look'), csAdjRow: $('#cs-adj-row'), csLutRow: $('#cs-lut-row'),
    csLutImport: $('#cs-lut-import'), csLutName: $('#cs-lut-name'), csLutMix: $('#cs-lut-mix'), csLutClear: $('#cs-lut-clear'), lutInput: $('#lut-input'),
    adj: { bright: $('#cs-bright'), contrast: $('#cs-contrast'), sat: $('#cs-sat'), warm: $('#cs-warm') },
    adjVal: { bright: $('#cs-bright-val'), contrast: $('#cs-contrast-val'), sat: $('#cs-sat-val'), warm: $('#cs-warm-val') },
    pullSheet: $('#pull-sheet'), pullClose: $('#pull-close'), pullChips: $('#pull-chips'), pullName: $('#pull-name'),
    pullRange: $('#pull-range'), pullWhole: $('#pull-whole'), pullRun: $('#pull-run'), pullBar: $('#pull-bar'),
    pullStatus: $('#pull-status'), pullResult: $('#pull-result'), pullPlayer: $('#pull-player'),
    pullSave: $('#pull-save'), pullShare: $('#pull-share'), pullAdd: $('#pull-add'),
    tlText: $('#tl-text'), tlTitle: $('#tl-title'),
    textSheet: $('#text-sheet'), tsText: $('#ts-text'), tsSize: $('#ts-size'), tsFont: $('#ts-font'), tsAlign: $('#ts-align'),
    tsBg: $('#ts-bg'), tsBold: $('#ts-bold'), tsColors: $('#ts-colors'), tsDup: $('#ts-dup'), tsRange: $('#ts-range'),
    tsAnim: $('#ts-anim'), tsOutline: $('#ts-outline'), tsGlow: $('#ts-glow'),
    exportBtn: $('#export-btn'), exportOverlay: $('#export-overlay'), exportClose: $('#export-close'),
    exportSetup: $('#export-setup'), exportProgress: $('#export-progress'), exportResult: $('#export-result'),
    exRes: $('#ex-res'), exFps: $('#ex-fps'), exQuality: $('#ex-quality'), exSummary: $('#ex-summary'),
    exportRun: $('#export-run'), exBar: $('#ex-bar'), exStatus: $('#ex-status'), exportCancel: $('#export-cancel'),
    exPlayer: $('#ex-player'), exDone: $('#ex-done'), exAudio: $('#ex-audio'), exSave: $('#ex-save'), exShare: $('#ex-share'), exAgain: $('#ex-again'),
    settingsBtn: $('#settings-btn'), settingsOverlay: $('#settings-overlay'), settingsClose: $('#settings-close'), settingsDone: $('#settings-done'),
    setAspect: $('#set-aspect'), setBg: $('#set-bg'), setSummary: $('#set-summary'),
  };
  // build segmented controls + swatches once
  els.tsSize.innerHTML = SIZES.map((s) => `<button data-v="${s.v}">${s.label}</button>`).join('');
  els.tsFont.innerHTML = FONTS.map((f) => `<button data-v="${f.id}" style="font-family:${f.css}">${f.label}</button>`).join('');
  els.tsAnim.innerHTML = ANIMS.map((a) => `<button data-v="${a.id}">${a.label}</button>`).join('');
  els.tsColors.innerHTML = COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('');
  els.csTransType.innerHTML = TRANSITIONS.map((t) => `<button data-t="${t.id}" aria-pressed="false">${t.label}</button>`).join('');
  els.csSpeed.innerHTML = SPEEDS.map((s) => `<button data-s="${s}" aria-pressed="false">${s}\u00d7</button>`).join('');
  els.csSpeed.addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) pickSpeed(Number(b.dataset.s)); });
  els.csFit.addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) pickFit(b.dataset.f); });
  els.csTabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) pickTab(b.dataset.tab); });
  els.csEnv.addEventListener('pointerdown', onEnvDown);
  els.csEnv.addEventListener('pointermove', onEnvMove);
  els.csEnv.addEventListener('pointerup', onEnvUp);
  els.csEnv.addEventListener('pointercancel', onEnvUp);
  els.csEnvClear.addEventListener('click', clearEnv);
  els.csDuck.innerHTML = Object.keys(DUCK).map((k) => `<button data-d="${k}" aria-pressed="false">${DUCK_LABELS[k]}</button>`).join('');
  els.csDuck.addEventListener('click', (e) => { const b = e.target.closest('button[data-d]'); if (b) pickDuck(b.dataset.d); });
  els.csLook.innerHTML = PRESETS.map((p) => `<button data-p="${p.id}" aria-pressed="false">${p.label}</button>`).join('');
  els.csLook.addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) pickLook(b.dataset.p); });
  for (const k of ['bright', 'contrast', 'sat', 'warm']) {
    els.adj[k].addEventListener('pointerdown', () => onAdjStart(k));
    els.adj[k].addEventListener('keydown', () => onAdjStart(k));
    els.adj[k].addEventListener('input', () => onAdjInput(k));
    els.adj[k].addEventListener('change', () => onAdjChange(k));
  }
  els.csLutImport.addEventListener('click', () => els.lutInput.click());
  els.lutInput.addEventListener('change', (e) => { onLutPicked(e.target.files); e.target.value = ''; });
  els.csLutMix.addEventListener('pointerdown', onLutMixStart);
  els.csLutMix.addEventListener('keydown', onLutMixStart);
  els.csLutMix.addEventListener('input', onLutMixInput);
  els.csLutMix.addEventListener('change', onLutMixChange);
  els.csLutClear.addEventListener('click', clearLut);
  els.csRot.addEventListener('click', rotateClip);
  els.csFrameReset.addEventListener('click', resetFrame);
  els.csZoom.addEventListener('pointerdown', onZoomStart);
  els.csZoom.addEventListener('keydown', onZoomStart);
  els.csZoom.addEventListener('input', onZoomInput);
  els.csZoom.addEventListener('change', onZoomChange);
  els.safeBtn.addEventListener('click', () => {
    const on = !previewer.showSafe; previewer.showSafe = on;
    els.safeBtn.setAttribute('aria-pressed', String(on));
    const p = loadPrefs(); p.safeZones = on; savePrefs(p);
    previewer.repaintOverlay();
    if (on) toast('Shaded = covered by the app. Dashed = what the feed shows at 4:5. Preview only.', 3200);
  });


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

  els.tpPlay.addEventListener('click', togglePlay);
  els.csVol.addEventListener('pointerdown', onVolStart);
  els.csVol.addEventListener('input', onVolInput);
  els.csVol.addEventListener('change', onVolChange);
  els.csMute.addEventListener('click', toggleMute);
  els.csFadeIn.addEventListener('click', () => cycleFade('fadeInUs'));
  els.csFadeOut.addEventListener('click', () => cycleFade('fadeOutUs'));
  els.csDetach.addEventListener('click', detachAudio);
  els.csPull.addEventListener('click', openPull);
  els.csTransType.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTransType(b.dataset.t); });
  els.csTransDur.addEventListener('click', cycleTransDur);
  els.csTransDir.addEventListener('click', cycleTransDir);
  els.pullClose.addEventListener('click', closePull);
  els.pullChips.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c || c.disabled) return;
    pull.fmt = c.dataset.fmt; const p = loadPrefs(); p.pullFmt = pull.fmt; savePrefs(p); paintPullChips();
  });
  els.pullRun.addEventListener('click', runPull);
  els.pullSave.addEventListener('click', savePull);
  els.pullShare.addEventListener('click', sharePull);
  els.pullAdd.addEventListener('click', addPullToProject);

  els.tlText.addEventListener('click', addTextAtPlayhead);
  els.tlTitle.addEventListener('click', addTitleCard);
  els.tsText.addEventListener('focus', onTextFocus);
  els.tsText.addEventListener('input', onTextInput);
  els.tsText.addEventListener('blur', commitTyping);
  els.tsSize.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setText({ size: parseFloat(b.dataset.v) }, 'Text size'); });
  els.tsFont.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setText({ font: b.dataset.v }, 'Text font'); });
  els.tsAlign.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setText({ align: b.dataset.v }, 'Text align'); });
  els.tsBg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setText({ bg: b.dataset.v }, 'Text background'); });
  els.tsBold.addEventListener('click', () => { const it = selectedClip(); if (it) setText({ bold: !it.bold }, 'Text weight'); });
  els.tsColors.addEventListener('click', (e) => { const b = e.target.closest('.swatch'); if (b) setText({ color: b.dataset.color }, 'Text color'); });
  els.tsDup.addEventListener('click', duplicateText);
  els.tsAnim.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setText({ anim: b.dataset.v }, 'Text animation'); });
  els.tsOutline.addEventListener('click', () => { const it = selectedClip(); if (it) setText({ outline: !it.outline }, 'Text outline'); });
  els.tsGlow.addEventListener('click', () => { const it = selectedClip(); if (it) setText({ glow: !it.glow }, 'Text glow'); });
  els.preview.addEventListener('pointerdown', onPreviewDown);
  els.preview.addEventListener('pointermove', onPreviewMove);
  els.preview.addEventListener('pointerup', onPreviewUp);
  els.preview.addEventListener('pointercancel', onPreviewUp);

  els.exportBtn.addEventListener('click', openExport);
  els.exportClose.addEventListener('click', closeExport);
  els.exRes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; exp.scale = parseFloat(b.dataset.scale); paintExportSegs(); saveExportPrefs(); exportSummary(); });
  els.exFps.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; exp.fps = parseInt(b.dataset.fps, 10); paintExportSegs(); saveExportPrefs(); exportSummary(); });
  els.exQuality.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const q = b.dataset.q; exp.quality = /^\d+$/.test(q) ? Number(q) : q; paintExportSegs(); saveExportPrefs(); exportSummary(); });
  paintExportSegs();
  els.exportRun.addEventListener('click', runExport);
  els.exportCancel.addEventListener('click', () => { if (exp.job) exp.job.cancel(); });
  els.exSave.addEventListener('click', saveExport);
  els.exShare.addEventListener('click', shareExport);
  els.exAgain.addEventListener('click', () => { showExportPane('setup'); exportSummary(); });
  els.exAudio.addEventListener('click', () => {
    const a = lastAudioInfo; if (!a) return;
    const state = a.included ? `in as ${a.codec}${a.mode === 'copy' ? ' (copied, no re-encode)' : ' (re-encoded)'}` : `left out (${a.reason})`;
    toast(`Audio ${state}. This device can encode: ${(a.encodable && a.encodable.length) ? a.encodable.join(', ') : 'not checked'}`, 7000);
  });
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsDone.addEventListener('click', closeSettings);
  els.setAspect.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setAspect(b.dataset.k); });
  els.setBg.addEventListener('click', (e) => { const b = e.target.closest('.swatch'); if (b) setBg(b.dataset.c); });
  els.tpStart.addEventListener('click', () => { pausePlay(); view.setPlayhead(0); });
  els.tpPrevF.addEventListener('click', () => stepFrame(-1));
  els.tpNextF.addEventListener('click', () => stepFrame(1));
  els.sheet.querySelector('#cs-in-prev').addEventListener('click', () => nudgeEdge('in', -1));
  els.sheet.querySelector('#cs-in-next').addEventListener('click', () => nudgeEdge('in', 1));
  els.sheet.querySelector('#cs-out-prev').addEventListener('click', () => nudgeEdge('out', -1));
  els.sheet.querySelector('#cs-out-next').addEventListener('click', () => nudgeEdge('out', 1));
  els.sheet.querySelector('#cs-in-here').addEventListener('click', () => edgeToPlayhead('in'));
  els.sheet.querySelector('#cs-out-here').addEventListener('click', () => edgeToPlayhead('out'));
  els.tpEnd.addEventListener('click', () => { pausePlay(); view.setPlayhead(totalUs(current)); });

  renderList();
  showScreen('list');
}
