// timeline.js · RoughCut
// Main-track (v1) model, the undo/redo command bus, undoable edit commands,
// and the touch timeline view. Logic (top half) is DOM-free and headless-testable;
// the view (bottom half) reads the DOM only when instantiated, never at import.

import { US, uid, usToS, sToUs } from './state.js';

export const DEFAULT_IMAGE_US = 5 * US;   // an image clip's default length
export const MIN_CLIP_US = 100_000;       // 0.1s floor so clips never vanish

// ---- model helpers (pure) ------------------------------------------------
export function mainTrack(project) { return project.tracks.find((t) => t.id === 'v1'); }
export function clipDurUs(clip) { return Math.max(0, clip.outUs - clip.inUs); } // speed=1 in M2

// Recompute contiguous tlStartUs from clip order. Single source of truth = order.
export function normalize(project) {
  const t = mainTrack(project);
  let acc = 0;
  for (const c of t.clips) { c.tlStartUs = acc; acc += clipDurUs(c); }
  return acc; // total duration in us
}
export function totalUs(project) { return normalize(project); }

export function clipIndexAt(project, tlUs) {
  const t = mainTrack(project);
  normalize(project);
  for (let i = 0; i < t.clips.length; i++) {
    const c = t.clips[i];
    if (tlUs >= c.tlStartUs && tlUs < c.tlStartUs + clipDurUs(c)) return i;
  }
  return t.clips.length ? t.clips.length - 1 : -1; // clamp to last
}
export function activeClipAt(project, tlUs) {
  const i = clipIndexAt(project, tlUs);
  return i < 0 ? null : mainTrack(project).clips[i];
}
// Map a timeline position to source seconds within its clip (speed=1).
export function sourceSecAt(project, tlUs) {
  const c = activeClipAt(project, tlUs);
  if (!c) return { clip: null, sourceSec: 0 };
  const local = Math.max(0, Math.min(tlUs - c.tlStartUs, clipDurUs(c)));
  return { clip: c, sourceSec: usToS(c.inUs + local) };
}

export function makeClip(media) {
  const isImg = media.kind === 'image';
  return {
    id: uid('c'), mediaId: media.id, tlStartUs: 0,
    inUs: 0, outUs: isImg ? DEFAULT_IMAGE_US : (media.durUs || DEFAULT_IMAGE_US),
    speed: 1, gain: 1, muted: false, fadeInUs: 0, fadeOutUs: 0,
    xf: { x: 0, y: 0, scale: 1, rot: 0, opacity: 1 }, fx: [],
  };
}
const cloneClip = (c) => JSON.parse(JSON.stringify(c));

// ---- commands (each returns { label, do, undo }) -------------------------
export function addClipCmd(project, media) {
  const t = mainTrack(project);
  const clip = makeClip(media);
  return {
    label: 'Add clip',
    do() { t.clips.push(clip); normalize(project); return clip.id; },
    undo() { const i = t.clips.findIndex((c) => c.id === clip.id); if (i >= 0) t.clips.splice(i, 1); normalize(project); },
  };
}
export function removeClipCmd(project, clipId) {
  const t = mainTrack(project);
  let idx = -1, removed = null;
  return {
    label: 'Delete clip',
    do() { idx = t.clips.findIndex((c) => c.id === clipId); if (idx >= 0) removed = t.clips.splice(idx, 1)[0]; normalize(project); },
    undo() { if (removed && idx >= 0) { t.clips.splice(idx, 0, removed); normalize(project); } },
  };
}
export function moveClipCmd(project, clipId, toIndex) {
  const t = mainTrack(project);
  let fromIndex = -1;
  return {
    label: 'Reorder',
    do() {
      fromIndex = t.clips.findIndex((c) => c.id === clipId);
      if (fromIndex < 0) return;
      const [c] = t.clips.splice(fromIndex, 1);
      const ti = Math.max(0, Math.min(toIndex, t.clips.length));
      t.clips.splice(ti, 0, c);
      normalize(project);
    },
    undo() {
      const cur = t.clips.findIndex((c) => c.id === clipId);
      if (cur < 0 || fromIndex < 0) return;
      const [c] = t.clips.splice(cur, 1);
      t.clips.splice(fromIndex, 0, c);
      normalize(project);
    },
  };
}
export function trimClipCmd(project, clipId, newInUs, newOutUs) {
  const t = mainTrack(project);
  const c = t.clips.find((x) => x.id === clipId);
  let oldIn = 0, oldOut = 0;
  return {
    label: 'Trim',
    do() { if (!c) return; oldIn = c.inUs; oldOut = c.outUs; c.inUs = newInUs; c.outUs = newOutUs; normalize(project); },
    undo() { if (!c) return; c.inUs = oldIn; c.outUs = oldOut; normalize(project); },
  };
}
export function splitClipCmd(project, clipId, atTlUs) {
  const t = mainTrack(project);
  let idx = -1, right = null, origOut = 0, ok = false;
  return {
    label: 'Split',
    do() {
      idx = t.clips.findIndex((c) => c.id === clipId);
      if (idx < 0) return;
      const orig = t.clips[idx];
      normalize(project);
      const cut = orig.inUs + (atTlUs - orig.tlStartUs); // source us (speed 1)
      if (cut <= orig.inUs + MIN_CLIP_US || cut >= orig.outUs - MIN_CLIP_US) { ok = false; return; }
      origOut = orig.outUs;
      right = cloneClip(orig);
      right.id = uid('c');
      right.inUs = cut;
      right.outUs = orig.outUs;
      orig.outUs = cut;
      t.clips.splice(idx + 1, 0, right);
      normalize(project);
      ok = true;
    },
    undo() {
      if (!ok || !right) return;
      const ri = t.clips.findIndex((c) => c.id === right.id);
      if (ri >= 0) t.clips.splice(ri, 1);
      const orig = t.clips[idx];
      if (orig) orig.outUs = origOut;
      normalize(project);
    },
  };
}

// ---- command bus ---------------------------------------------------------
export class CommandBus {
  constructor(onChange) { this.onChange = onChange; this.undoStack = []; this.redoStack = []; }
  do(cmd) { const r = cmd.do(); this.undoStack.push(cmd); this.redoStack.length = 0; this._changed(); return r; }
  undo() { const c = this.undoStack.pop(); if (!c) return false; c.undo(); this.redoStack.push(c); this._changed(); return true; }
  redo() { const c = this.redoStack.pop(); if (!c) return false; c.do(); this.undoStack.push(c); this._changed(); return true; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  _changed() { if (this.onChange) this.onChange(); }
}

// ---- fmt helper ----------------------------------------------------------
export function fmtTime(us) {
  const s = Math.max(0, usToS(us || 0));
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), cs = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2, '0')}.${cs}`;
}

// =========================================================================
// Timeline view (DOM). Instantiated by ui.js. No DOM access at import time.
// =========================================================================
const SNAP_PX = 8;
const DRAG_THRESH = 8;
const MIN_PPS = 20, MAX_PPS = 240, DEFAULT_PPS = 60;

export class TimelineView {
  constructor(opts) {
    this.scrollEl = opts.scrollEl;
    this.trackEl = opts.trackEl;
    this.playheadEl = opts.playheadEl;
    this.timeEl = opts.timeEl;
    this.project = opts.project;
    this.bus = opts.bus;
    this.getMedia = opts.getMedia;       // (mediaId) -> media record
    this.getThumb = opts.getThumb;       // (mediaId) -> url | null
    this.onPlayheadChange = opts.onPlayheadChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.toast = opts.toast || (() => {});

    this.pps = DEFAULT_PPS;              // pixels per second (zoom)
    this.playheadUs = 0;
    this.selectedId = null;
    this._drag = null;

    this.trackEl.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.trackEl.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.trackEl.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.trackEl.addEventListener('pointercancel', (e) => this._onPointerUp(e));
  }

  setProject(p) { this.project = p; this.selectedId = null; this.playheadUs = 0; this.render(); }

  // ---- geometry ----
  _pxToUs(px) { return sToUs(px / this.pps); }
  _usToPx(us) { return usToS(us) * this.pps; }
  _boundaries() {
    const t = mainTrack(this.project);
    const bs = [0];
    let acc = 0;
    for (const c of t.clips) { acc += clipDurUs(c); bs.push(acc); }
    return bs;
  }
  _snapUs(us) {
    for (const b of this._boundaries()) {
      if (Math.abs(this._usToPx(us) - this._usToPx(b)) <= SNAP_PX) return b;
    }
    return us;
  }
  _contentX(clientX) { return clientX - this.trackEl.getBoundingClientRect().left; }

  // ---- render ----
  render() {
    const t = mainTrack(this.project);
    const total = normalize(this.project);
    // clear clip blocks (keep the playhead element)
    [...this.trackEl.querySelectorAll('.tl-clip')].forEach((n) => n.remove());
    const trackW = Math.max(this._usToPx(total) + 40, this.scrollEl.clientWidth);
    this.trackEl.style.width = trackW + 'px';

    for (const c of t.clips) {
      const el = document.createElement('div');
      el.className = 'tl-clip' + (c.id === this.selectedId ? ' selected' : '');
      el.dataset.id = c.id;
      el.style.left = this._usToPx(c.tlStartUs) + 'px';
      el.style.width = Math.max(6, this._usToPx(clipDurUs(c))) + 'px';
      const url = this.getThumb ? this.getThumb(c.mediaId) : null;
      if (url) el.style.backgroundImage = `url("${url}")`;
      const label = document.createElement('span');
      label.className = 'tl-clip-label';
      label.textContent = fmtTime(clipDurUs(c));
      el.appendChild(label);
      if (c.id === this.selectedId) {
        const hl = document.createElement('div'); hl.className = 'tl-handle tl-handle-l'; hl.dataset.handle = 'l';
        const hr = document.createElement('div'); hr.className = 'tl-handle tl-handle-r'; hr.dataset.handle = 'r';
        el.appendChild(hl); el.appendChild(hr);
      }
      this.trackEl.appendChild(el);
    }
    this._renderPlayhead();
    if (this.timeEl) this.timeEl.textContent = `${fmtTime(this.playheadUs)} / ${fmtTime(total)}`;
  }
  _renderPlayhead() {
    this.playheadEl.style.left = this._usToPx(this.playheadUs) + 'px';
  }

  setPlayhead(us, { scroll = false } = {}) {
    const total = normalize(this.project);
    this.playheadUs = Math.max(0, Math.min(us, total));
    this._renderPlayhead();
    if (this.timeEl) this.timeEl.textContent = `${fmtTime(this.playheadUs)} / ${fmtTime(total)}`;
    if (scroll) {
      const x = this._usToPx(this.playheadUs);
      const view = this.scrollEl.scrollLeft, w = this.scrollEl.clientWidth;
      if (x < view + 20 || x > view + w - 20) this.scrollEl.scrollLeft = Math.max(0, x - w / 2);
    }
    this.onPlayheadChange(this.playheadUs);
  }

  selectClip(id, { moveHead = true } = {}) {
    this.selectedId = id;
    const c = mainTrack(this.project).clips.find((x) => x.id === id);
    this.render();
    if (c && moveHead) this.setPlayhead(c.tlStartUs, { scroll: true });
    this.onSelect(c || null);
  }

  // ---- toolbar actions ----
  undo() { this.bus.undo(); }
  redo() { this.bus.redo(); }
  zoomBy(factor) {
    this.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, this.pps * factor));
    this.render();
  }
  deleteSelected() {
    if (!this.selectedId) { this.toast('Tap a clip first'); return; }
    const id = this.selectedId;
    this.selectedId = null;
    this.bus.do(removeClipCmd(this.project, id));
  }
  splitAtPlayhead() {
    const idx = clipIndexAt(this.project, this.playheadUs);
    if (idx < 0) { this.toast('Nothing to split'); return; }
    const clip = mainTrack(this.project).clips[idx];
    const before = mainTrack(this.project).clips.length;
    this.bus.do(splitClipCmd(this.project, clip.id, this.playheadUs));
    if (mainTrack(this.project).clips.length === before) this.toast('Move the playhead into the clip');
  }

  // ---- pointer handling ----
  _onPointerDown(e) {
    const handle = e.target.closest('.tl-handle');
    const clipEl = e.target.closest('.tl-clip');
    if (handle && clipEl) {
      this.trackEl.setPointerCapture(e.pointerId);
      const clip = mainTrack(this.project).clips.find((c) => c.id === clipEl.dataset.id);
      this._drag = { mode: 'trim', side: handle.dataset.handle, id: clip.id,
        startX: e.clientX, origIn: clip.inUs, origOut: clip.outUs };
      return;
    }
    if (clipEl) {
      this.trackEl.setPointerCapture(e.pointerId);
      this._drag = { mode: 'clip', id: clipEl.dataset.id, startX: e.clientX, moved: false };
      return;
    }
    // empty track -> set playhead on tap; leave native horizontal scroll for drags
    this._drag = { mode: 'scrub' };
    this.setPlayhead(this._snapUs(this._pxToUs(this._contentX(e.clientX))));
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'scrub') {
      this.setPlayhead(this._snapUs(this._pxToUs(this._contentX(e.clientX))));
      return;
    }
    if (d.mode === 'trim') {
      const dUs = this._pxToUs(e.clientX - d.startX);
      const clip = mainTrack(this.project).clips.find((c) => c.id === d.id);
      const media = this.getMedia(clip.mediaId);
      const srcMax = (media && media.kind === 'video' && media.durUs) ? media.durUs : Number.MAX_SAFE_INTEGER;
      if (d.side === 'l') {
        clip.inUs = Math.max(0, Math.min(d.origIn + dUs, clip.outUs - MIN_CLIP_US));
      } else {
        clip.outUs = Math.min(srcMax, Math.max(d.origOut + dUs, clip.inUs + MIN_CLIP_US));
      }
      this.render();
      return;
    }
    if (d.mode === 'clip') {
      if (Math.abs(e.clientX - d.startX) > DRAG_THRESH) d.moved = true;
      if (d.moved) {
        const idx = this._indexForX(e.clientX);
        this._showInsertion(idx);
      }
    }
  }

  _onPointerUp(e) {
    const d = this._drag;
    this._drag = null;
    this._clearInsertion();
    if (!d) return;
    if (d.mode === 'trim') {
      const clip = mainTrack(this.project).clips.find((c) => c.id === d.id);
      const newIn = clip.inUs, newOut = clip.outUs;
      clip.inUs = d.origIn; clip.outUs = d.origOut; // revert, then commit as one undoable step
      if (newIn !== d.origIn || newOut !== d.origOut) this.bus.do(trimClipCmd(this.project, d.id, newIn, newOut));
      else this.render();
      return;
    }
    if (d.mode === 'clip') {
      if (!d.moved) { this.selectClip(d.id); return; }
      const t = mainTrack(this.project);
      const from = t.clips.findIndex((c) => c.id === d.id);
      let target = this._indexForX(e.clientX);
      if (target > from) target -= 1; // account for removal shift
      if (target !== from && target >= 0) { this.selectedId = d.id; this.bus.do(moveClipCmd(this.project, d.id, target)); }
      else this.render();
      return;
    }
  }

  _indexForX(clientX) {
    const cx = this._contentX(clientX) + this.scrollEl.scrollLeft * 0; // content coords already track-relative
    const t = mainTrack(this.project);
    let acc = 0, i = 0;
    for (; i < t.clips.length; i++) {
      const w = this._usToPx(clipDurUs(t.clips[i]));
      if (cx < acc + w / 2) return i;
      acc += w;
    }
    return t.clips.length;
  }
  _showInsertion(idx) {
    let bar = this.trackEl.querySelector('.tl-insert');
    if (!bar) { bar = document.createElement('div'); bar.className = 'tl-insert'; this.trackEl.appendChild(bar); }
    const t = mainTrack(this.project);
    let acc = 0;
    for (let i = 0; i < idx && i < t.clips.length; i++) acc += clipDurUs(t.clips[i]);
    bar.style.left = this._usToPx(acc) + 'px';
  }
  _clearInsertion() { const b = this.trackEl.querySelector('.tl-insert'); if (b) b.remove(); }
}
