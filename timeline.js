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
//
// v0.7 model: the playhead is a FIXED line at the center of the viewport and the
// strip scrolls underneath it (native horizontal scroll). Scrolling is scrubbing.
// Tap a clip = select. Long-press a clip = lift to reorder. Drag a handle = trim.
// Pinch = zoom. Nothing else on the strip intercepts the finger.
// =========================================================================
const SNAP_PX = 10;
const TAP_SLOP = 14;          // px of wobble still counted as a tap
const TAP_MS = 450;
const LONGPRESS_MS = 340;
const MIN_PPS = 16, MAX_PPS = 320, DEFAULT_PPS = 64;
const EDGE_PX = 48;           // autoscroll zone while reordering
const EDGE_SPEED = 9;         // px per tick

function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }

export class TimelineView {
  constructor(opts) {
    this.scrollEl = opts.scrollEl;       // the horizontal scroller
    this.trackEl = opts.trackEl;         // the wide strip inside it
    this.timeEl = opts.timeEl;
    this.project = opts.project;
    this.bus = opts.bus;
    this.getMedia = opts.getMedia;       // (mediaId) -> media record
    this.getThumb = opts.getThumb;       // (mediaId) -> url | null
    this.onPlayheadChange = opts.onPlayheadChange || (() => {});
    this.onUserScrub = opts.onUserScrub || (() => {});   // finger touched the strip: pause playback
    this.onSelect = opts.onSelect || (() => {});
    this.toast = opts.toast || (() => {});

    this.pps = DEFAULT_PPS;
    this.playheadUs = 0;
    this.selectedId = null;
    this._drag = null;                   // { mode: 'tap' | 'trim' | 'reorder', ... }
    this._press = null;                  // long-press timer
    this._pinch = null;
    this._els = new Map();               // clipId -> element
    this._padPx = 0;

    const s = this.scrollEl, t = this.trackEl;
    s.addEventListener('scroll', () => this._onScroll(), { passive: true });
    s.addEventListener('scrollend', () => this._onScrollEnd());
    s.addEventListener('pointerdown', () => this.onUserScrub(), { passive: true });
    s.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    t.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    t.addEventListener('pointermove', (e) => this._onPointerMove(e));
    t.addEventListener('pointerup', (e) => this._onPointerUp(e));
    t.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
    // Non-passive so a lifted clip can veto the browser's pan once reorder starts.
    t.addEventListener('touchmove', (e) => { if (this._drag && this._drag.mode !== 'tap') e.preventDefault(); }, { passive: false });
    t.addEventListener('contextmenu', (e) => e.preventDefault());

    s.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    s.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    s.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(s);
    }
  }

  setProject(p) { this.project = p; this.selectedId = null; this.playheadUs = 0; this.render(); }
  dispose() { if (this._ro) this._ro.disconnect(); this._stopEdgeScroll(); }

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
  _nearestBoundary(us) {
    let best = null, bestD = Infinity;
    for (const b of this._boundaries()) {
      const d = Math.abs(this._usToPx(us) - this._usToPx(b));
      if (d < bestD) { bestD = d; best = b; }
    }
    return { us: best, px: bestD };
  }
  // strip x (relative to trackEl) for a timeline time
  _tlX(us) { return this._padPx + this._usToPx(us); }
  _contentUs(clientX) {
    const x = clientX - this.trackEl.getBoundingClientRect().left - this._padPx;
    return this._pxToUs(x);
  }

  // ---- render (creates elements) / layout (positions them in place) ----
  render() {
    const t = mainTrack(this.project);
    normalize(this.project);
    this._padPx = Math.round(this.scrollEl.clientWidth / 2);
    // drop elements for clips that no longer exist
    for (const [id, el] of this._els) {
      if (!t.clips.some((c) => c.id === id)) { el.remove(); this._els.delete(id); }
    }
    // ensure an element per clip, in order
    for (const c of t.clips) {
      let el = this._els.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tl-clip';
        el.dataset.id = c.id;
        el.innerHTML = '<div class="tl-clip-thumb"></div><span class="tl-clip-label"></span>'
          + '<div class="tl-handle tl-handle-l" data-handle="l"></div><div class="tl-handle tl-handle-r" data-handle="r"></div>';
        const url = this.getThumb ? this.getThumb(c.mediaId) : null;
        if (url) el.querySelector('.tl-clip-thumb').style.backgroundImage = `url("${url}")`;
        this._els.set(c.id, el);
      }
      this.trackEl.appendChild(el); // appendChild moves existing nodes, so order follows the model
    }
    this._renderRuler();
    this._layout();
  }

  _layout() {
    const t = mainTrack(this.project);
    const total = normalize(this.project);
    this.trackEl.style.width = (this._padPx * 2 + this._usToPx(total)) + 'px';
    for (const c of t.clips) {
      const el = this._els.get(c.id); if (!el) continue;
      el.style.left = this._tlX(c.tlStartUs) + 'px';
      el.style.width = Math.max(8, this._usToPx(clipDurUs(c))) + 'px';
      el.classList.toggle('selected', c.id === this.selectedId);
      el.querySelector('.tl-clip-label').textContent = fmtTime(clipDurUs(c));
    }
    this._layoutRuler(total);
    this._updateTime(total);
  }

  _renderRuler() {
    let r = this.trackEl.querySelector('.tl-ruler');
    if (!r) { r = document.createElement('div'); r.className = 'tl-ruler'; this.trackEl.prepend(r); }
  }
  _layoutRuler(total) {
    const r = this.trackEl.querySelector('.tl-ruler'); if (!r) return;
    r.innerHTML = '';
    const secs = usToS(total);
    // tick every 1s, label every N so labels stay ~>56px apart
    const every = Math.max(1, Math.ceil(56 / this.pps));
    const frag = document.createDocumentFragment();
    for (let s = 0; s <= Math.ceil(secs); s++) {
      const tick = document.createElement('span');
      const major = s % every === 0;
      tick.className = 'tl-tick' + (major ? ' major' : '');
      tick.style.left = this._tlX(sToUs(s)) + 'px';
      if (major) tick.dataset.t = fmtTime(sToUs(s)).replace(/\.\d$/, '');
      frag.appendChild(tick);
    }
    r.appendChild(frag);
  }

  _updateTime(total) {
    if (this.timeEl) this.timeEl.textContent = `${fmtTime(this.playheadUs)} / ${fmtTime(total ?? normalize(this.project))}`;
  }

  // ---- playhead <-> scroll ----
  _onScroll() {
    if (this._pinch) return;
    const total = normalize(this.project);
    const us = Math.max(0, Math.min(this._pxToUs(this.scrollEl.scrollLeft), total));
    if (us === this.playheadUs) return;
    this.playheadUs = us;
    this._updateTime(total);
    this.onPlayheadChange(us);
  }
  _onScrollEnd() {
    if (this._drag || this._pinch || this._playing) return;
    const near = this._nearestBoundary(this.playheadUs);
    if (near.us != null && near.px > 0.5 && near.px <= SNAP_PX) {
      this.scrollEl.scrollTo({ left: this._usToPx(near.us), behavior: 'smooth' });
      haptic(6);
    }
  }
  _onWheel(e) {
    // desktop convenience: vertical wheel scrubs horizontally
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.scrollEl.scrollLeft += e.deltaY; e.preventDefault(); }
  }
  _onResize() {
    const us = this.playheadUs;
    this._padPx = Math.round(this.scrollEl.clientWidth / 2);
    this._layout();
    this.scrollEl.scrollLeft = this._usToPx(us);
  }

  setPlaying(on) { this._playing = !!on; }

  setPlayhead(us) {
    const total = normalize(this.project);
    this.playheadUs = Math.max(0, Math.min(us, total));
    this.scrollEl.scrollLeft = this._usToPx(this.playheadUs);
    this._updateTime(total);
    this.onPlayheadChange(this.playheadUs);
  }

  selectClip(id, { moveHead = false } = {}) {
    this.selectedId = id;
    const c = mainTrack(this.project).clips.find((x) => x.id === id);
    this._layout();
    if (c && moveHead) this.setPlayhead(c.tlStartUs);
    this.onSelect(c || null);
  }

  // ---- toolbar actions ----
  undo() { this.bus.undo(); }
  redo() { this.bus.redo(); }
  zoomBy(factor) { this.setZoom(this.pps * factor); }
  setZoom(pps) {
    const us = this.playheadUs;
    this.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps));
    this._layout();
    this.scrollEl.scrollLeft = this._usToPx(us);
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
    else haptic(8);
  }

  // ---- pointer handling ----
  _onPointerDown(e) {
    if (this._pinch) return;
    const handle = e.target.closest('.tl-handle');
    const clipEl = e.target.closest('.tl-clip');
    this._clearPress();
    if (handle && clipEl && clipEl.classList.contains('selected')) {
      this.trackEl.setPointerCapture(e.pointerId);
      const clip = mainTrack(this.project).clips.find((c) => c.id === clipEl.dataset.id);
      this._drag = { mode: 'trim', side: handle.dataset.handle, id: clip.id, pid: e.pointerId,
        startX: e.clientX, origIn: clip.inUs, origOut: clip.outUs };
      clipEl.classList.add('trimming');
      return;
    }
    if (clipEl) {
      this._drag = { mode: 'tap', id: clipEl.dataset.id, pid: e.pointerId, startX: e.clientX, startY: e.clientY, t0: performance.now() };
      this._press = setTimeout(() => this._liftClip(e), LONGPRESS_MS);
      return;
    }
    // empty strip: a clean tap deselects; drags are native scroll
    this._drag = { mode: 'tap', id: null, pid: e.pointerId, startX: e.clientX, startY: e.clientY, t0: performance.now() };
  }

  _liftClip(e) {
    const d = this._drag; if (!d || d.mode !== 'tap' || !d.id) return;
    this._press = null;
    try { this.trackEl.setPointerCapture(d.pid); } catch (_) {}
    const el = this._els.get(d.id);
    d.mode = 'reorder'; d.el = el; d.lastX = e.clientX;
    d.origLeft = parseFloat(el.style.left) || 0;
    el.classList.add('lifting');
    if (this.selectedId !== d.id) { this.selectedId = d.id; this._layout(); this.onSelect(mainTrack(this.project).clips.find((c) => c.id === d.id) || null); }
    haptic(12);
    this._showInsertion(this._indexForClientX(e.clientX));
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'tap') {
      if (Math.abs(e.clientX - d.startX) > TAP_SLOP || Math.abs(e.clientY - d.startY) > TAP_SLOP) { this._clearPress(); this._drag = null; }
      return;
    }
    if (d.mode === 'trim') {
      const dUs = this._pxToUs(e.clientX - d.startX);
      const clip = mainTrack(this.project).clips.find((c) => c.id === d.id);
      const media = this.getMedia(clip.mediaId);
      const srcMax = (media && media.kind === 'video' && media.durUs) ? media.durUs : Number.MAX_SAFE_INTEGER;
      if (d.side === 'l') clip.inUs = Math.max(0, Math.min(d.origIn + dUs, clip.outUs - MIN_CLIP_US));
      else clip.outUs = Math.min(srcMax, Math.max(d.origOut + dUs, clip.inUs + MIN_CLIP_US));
      this._layout();   // in place: no element churn under the finger
      return;
    }
    if (d.mode === 'reorder') {
      d.lastX = e.clientX;
      d.el.style.transform = `translate(${e.clientX - d.startX}px, -6px) scale(1.04)`;
      this._showInsertion(this._indexForClientX(e.clientX));
      this._edgeScroll(e.clientX);
    }
  }

  _onPointerUp(e) {
    const d = this._drag;
    this._drag = null;
    this._clearPress();
    this._stopEdgeScroll();
    if (!d) return;
    if (d.mode === 'tap') {
      const quick = performance.now() - d.t0 <= TAP_MS;
      const still = Math.abs(e.clientX - d.startX) <= TAP_SLOP && Math.abs(e.clientY - d.startY) <= TAP_SLOP;
      if (!quick || !still) return;
      if (d.id) { this.selectClip(d.id); haptic(5); }
      else if (this.selectedId) { this.selectedId = null; this._layout(); this.onSelect(null); }
      return;
    }
    if (d.mode === 'trim') {
      const el = this._els.get(d.id); if (el) el.classList.remove('trimming');
      const clip = mainTrack(this.project).clips.find((c) => c.id === d.id);
      const newIn = clip.inUs, newOut = clip.outUs;
      clip.inUs = d.origIn; clip.outUs = d.origOut; // revert, then commit as one undoable step
      if (newIn !== d.origIn || newOut !== d.origOut) this.bus.do(trimClipCmd(this.project, d.id, newIn, newOut));
      else this._layout();
      return;
    }
    if (d.mode === 'reorder') {
      d.el.classList.remove('lifting'); d.el.style.transform = '';
      this._clearInsertion();
      const t = mainTrack(this.project);
      const from = t.clips.findIndex((c) => c.id === d.id);
      let target = this._indexForClientX(e.clientX);
      if (target > from) target -= 1;
      if (target !== from && target >= 0) { this.selectedId = d.id; haptic(8); this.bus.do(moveClipCmd(this.project, d.id, target)); }
      else this._layout();
    }
  }
  _onPointerCancel() {
    // the browser took the gesture (native pan). A tap or a not-yet-lifted press just dies.
    const d = this._drag;
    this._clearPress();
    if (d && d.mode === 'reorder') { d.el.classList.remove('lifting'); d.el.style.transform = ''; this._clearInsertion(); this._layout(); }
    if (d && d.mode === 'trim') { const c = mainTrack(this.project).clips.find((x) => x.id === d.id); if (c) { c.inUs = d.origIn; c.outUs = d.origOut; } const el = this._els.get(d.id); if (el) el.classList.remove('trimming'); this._layout(); }
    this._drag = null;
    this._stopEdgeScroll();
  }
  _clearPress() { if (this._press) { clearTimeout(this._press); this._press = null; } }

  _indexForClientX(clientX) {
    const us = this._contentUs(clientX);
    const t = mainTrack(this.project);
    let acc = 0, i = 0;
    for (; i < t.clips.length; i++) {
      const w = clipDurUs(t.clips[i]);
      if (us < acc + w / 2) return i;
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
    bar.style.left = this._tlX(acc) + 'px';
  }
  _clearInsertion() { const b = this.trackEl.querySelector('.tl-insert'); if (b) b.remove(); }

  _edgeScroll(clientX) {
    const r = this.scrollEl.getBoundingClientRect();
    let v = 0;
    if (clientX < r.left + EDGE_PX) v = -EDGE_SPEED;
    else if (clientX > r.right - EDGE_PX) v = EDGE_SPEED;
    if (!v) { this._stopEdgeScroll(); return; }
    if (this._edge) return;
    this._edge = setInterval(() => {
      this.scrollEl.scrollLeft += v;
      const d = this._drag; if (d && d.mode === 'reorder') this._showInsertion(this._indexForClientX(d.lastX));
    }, 16);
  }
  _stopEdgeScroll() { if (this._edge) { clearInterval(this._edge); this._edge = null; } }

  // ---- pinch zoom (touch) ----
  _onTouchStart(e) {
    if (e.touches.length === 2) {
      this._clearPress(); this._drag = null;
      const [a, b] = e.touches;
      this._pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), pps0: this.pps, us: this.playheadUs };
    }
  }
  _onTouchMove(e) {
    if (!this._pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, this._pinch.pps0 * (d / this._pinch.d0)));
    this._layout();
    this.scrollEl.scrollLeft = this._usToPx(this._pinch.us);
  }
  _onTouchEnd(e) {
    if (this._pinch && e.touches.length < 2) { const us = this._pinch.us; this._pinch = null; this.scrollEl.scrollLeft = this._usToPx(us); }
  }
}
