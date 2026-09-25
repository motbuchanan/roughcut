// ui.js · RoughCut
// DOM layer: screens, project list CRUD, editor shell, import, media bin, and
// the M2 timeline wiring (command bus + timeline view + timeline-following preview).

import {
  listProjects, createProject, loadProject, renameProject, deleteProject,
  readThumb, scheduleSave, flushSave, CANVAS_PRESETS, loadPrefs, savePrefs,
} from './state.js';
import { importFile } from './media.js';
import { Preview } from './preview.js';
import {
  CommandBus, addClipCmd, addAudioCmd, setClipAudioCmd, detachAudioCmd, findClip, laneOf, clipDurUs,
  makeColorMedia, insertClipCmd, clipIndexAt,
  TimelineView, sourceSecAt, mainTrack, normalize, totalUs, fmtTime,
} from './timeline.js';
import {
  makeText, addTextCmd, setTextCmd, duplicateTextCmd, textTrack, textDurUs,
  FONTS, SIZES, COLORS, TEXT_DEFAULT_US,
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
}
function onPreviewMove(e) {
  if (!pdrag) return;
  const pt = canvasPoint(e);
  const it = findClip(current, pdrag.id); if (!it) return;
  const dx = (pt.x - pdrag.sx) / els.preview.width, dy = (pt.y - pdrag.sy) / els.preview.height;
  if (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005) pdrag.moved = true;
  it.x = Math.max(0.05, Math.min(0.95, pdrag.x0 + dx));
  it.y = Math.max(0.05, Math.min(0.95, pdrag.y0 + dy));
  previewer.repaintOverlay();
}
function onPreviewUp() {
  if (!pdrag) return;
  const d = pdrag; pdrag = null;
  els.preview.classList.remove('dragging');
  const it = findClip(current, d.id); if (!it) return;
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
  els.tlHint.classList.toggle('hidden', has && bus.undoStack.length > 2);
}

function refreshPreview() {
  const { clip, sourceSec } = sourceSecAt(current, view.playheadUs);
  if (!clip) { previewer.renderAt(current, null, 0, view.playheadUs); els.previewHint.style.display = 'flex'; return; }
  els.previewHint.style.display = 'none';
  const media = current.media.find((m) => m.id === clip.mediaId) || null;
  previewer.renderAt(current, media, sourceSec, view.playheadUs);
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

// ---- export (M5) ---------------------------------------------------------
let exp = { job: null, blob: null, name: '', scale: 1, fps: 30, quality: 'high', url: null };
function exportSummary() {
  const W = Math.round(current.canvas.w * exp.scale / 2) * 2;
  const H = Math.round(current.canvas.h * exp.scale / 2) * 2;
  const secs = totalUs(current) / 1e6;
  els.exSummary.textContent = `${W}\u00d7${H} \u00b7 ${exp.fps} fps \u00b7 ${fmtTime(totalUs(current))} \u00b7 H.264 + AAC MP4`;
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
}
async function runExport() {
  showExportPane('progress');
  els.exBar.style.width = '0%'; els.exStatus.className = 'ex-status'; els.exStatus.textContent = 'Starting\u2026';
  const t0 = performance.now();
  exp.job = exportProject(current, {
    fps: exp.fps, quality: exp.quality, scale: exp.scale,
    onProgress: (p) => {
      els.exBar.style.width = (p * 100).toFixed(1) + '%';
      const pct = Math.round(p * 100);
      els.exStatus.textContent = p < 0.12 ? `Mixing audio\u2026 ${pct}%` : `Rendering video\u2026 ${pct}%`;
    },
  });
  try {
    const r = await exp.job.promise;
    exp.blob = r.blob;
    exp.name = (current.name || 'RoughCut').replace(/[^\w\-]+/g, '_') + '.mp4';
    exp.url = URL.createObjectURL(r.blob);
    els.exPlayer.src = exp.url;
    els.exDone.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s \u00b7 ${r.w}\u00d7${r.h} \u00b7 ${fmtBytes(r.blob.size)}`;
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
    capReasons: $('#cap-reasons'),
    editorTitle: $('#editor-title'), canvasBadge: $('#canvas-badge'), backBtn: $('#editor-back'),
    preview: $('#preview'), previewHint: $('#preview-hint'),
    mediaStrip: $('#media-strip'), stripEmpty: $('#strip-empty'),
    importBtn: $('#import-btn'), fileInput: $('#file-input'),
    badge: $('#badge'),
    tlUndo: $('#tl-undo'), tlRedo: $('#tl-redo'), tlSplit: $('#tl-split'), tlDelete: $('#tl-delete'),
    tlZoomOut: $('#tl-zoomout'), tlZoomIn: $('#tl-zoomin'),
    tlScroll: $('#tl-scroll'), tlTrack: $('#tl-track'), tlHint: $('#tl-hint'),
    tpStart: $('#tp-start'), tpPlay: $('#tp-play'), tpEnd: $('#tp-end'), tpTime: $('#tp-time'),
    sheet: $('#clip-sheet'), csName: $('#cs-name'), csVol: $('#cs-vol'), csVolVal: $('#cs-vol-val'),
    csMute: $('#cs-mute'), csFadeIn: $('#cs-fadein'), csFadeOut: $('#cs-fadeout'),
    csTools: $('#cs-tools'), csDetach: $('#cs-detach'), csPull: $('#cs-pull'),
    pullSheet: $('#pull-sheet'), pullClose: $('#pull-close'), pullChips: $('#pull-chips'), pullName: $('#pull-name'),
    pullRange: $('#pull-range'), pullWhole: $('#pull-whole'), pullRun: $('#pull-run'), pullBar: $('#pull-bar'),
    pullStatus: $('#pull-status'), pullResult: $('#pull-result'), pullPlayer: $('#pull-player'),
    pullSave: $('#pull-save'), pullShare: $('#pull-share'), pullAdd: $('#pull-add'),
    tlText: $('#tl-text'), tlTitle: $('#tl-title'),
    textSheet: $('#text-sheet'), tsText: $('#ts-text'), tsSize: $('#ts-size'), tsFont: $('#ts-font'), tsAlign: $('#ts-align'),
    tsBg: $('#ts-bg'), tsBold: $('#ts-bold'), tsColors: $('#ts-colors'), tsDup: $('#ts-dup'), tsRange: $('#ts-range'),
    exportBtn: $('#export-btn'), exportOverlay: $('#export-overlay'), exportClose: $('#export-close'),
    exportSetup: $('#export-setup'), exportProgress: $('#export-progress'), exportResult: $('#export-result'),
    exRes: $('#ex-res'), exFps: $('#ex-fps'), exQuality: $('#ex-quality'), exSummary: $('#ex-summary'),
    exportRun: $('#export-run'), exBar: $('#ex-bar'), exStatus: $('#ex-status'), exportCancel: $('#export-cancel'),
    exPlayer: $('#ex-player'), exDone: $('#ex-done'), exSave: $('#ex-save'), exShare: $('#ex-share'), exAgain: $('#ex-again'),
  };
  // build segmented controls + swatches once
  els.tsSize.innerHTML = SIZES.map((s) => `<button data-v="${s.v}">${s.label}</button>`).join('');
  els.tsFont.innerHTML = FONTS.map((f) => `<button data-v="${f.id}" style="font-family:${f.css}">${f.label}</button>`).join('');
  els.tsColors.innerHTML = COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('');

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
  els.preview.addEventListener('pointerdown', onPreviewDown);
  els.preview.addEventListener('pointermove', onPreviewMove);
  els.preview.addEventListener('pointerup', onPreviewUp);
  els.preview.addEventListener('pointercancel', onPreviewUp);

  els.exportBtn.addEventListener('click', openExport);
  els.exportClose.addEventListener('click', closeExport);
  els.exRes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; exp.scale = parseFloat(b.dataset.scale); paintSeg(els.exRes, [...els.exRes.children].indexOf(b)); exportSummary(); });
  els.exFps.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; exp.fps = parseInt(b.dataset.fps, 10); paintSeg(els.exFps, [...els.exFps.children].indexOf(b)); exportSummary(); });
  els.exQuality.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; exp.quality = b.dataset.q; paintSeg(els.exQuality, [...els.exQuality.children].indexOf(b)); });
  els.exportRun.addEventListener('click', runExport);
  els.exportCancel.addEventListener('click', () => { if (exp.job) exp.job.cancel(); });
  els.exSave.addEventListener('click', saveExport);
  els.exShare.addEventListener('click', shareExport);
  els.exAgain.addEventListener('click', () => { showExportPane('setup'); exportSummary(); });
  els.tpStart.addEventListener('click', () => { pausePlay(); view.setPlayhead(0); });
  els.tpEnd.addEventListener('click', () => { pausePlay(); view.setPlayhead(totalUs(current)); });

  renderList();
  showScreen('list');
}
