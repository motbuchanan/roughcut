// preview.js · RoughCut
// Draft-scale preview that follows the timeline playhead. Given the media + a
// source time, it decodes and draws one frame. CanvasSink applies rotation from
// metadata and caps VRAM with a small pool. One media is kept open at a time,
// plus a second ("aux") reader while the playhead sits inside a dual-source
// transition window, so crossfades/slides/wipes preview live with both clips.
// Latest-wins pump so dragging the playhead never queues stale frames.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './mediabunny.js';
import { readMedia } from './state.js';
import { drawTextsAt, ensureFonts } from './text.js';
import { drawTransitionAt, drawDualTransition } from './transitions.js';
import { drawFrame, drawSafeZones } from './frame.js';
import { gradeFrame, lookOf, hasLut, registerLut } from './color.js';
import { readLut } from './state.js';
import { clipAt } from './keyframes.js';
import { overlaysAt, ovStateAt, drawOverlay } from './overlay.js';
import { keyOn, keyFrame } from './chroma.js';
import { cutOn, cutFrame } from './cutout.js';
import { normalize } from './timeline.js';
import { fitBox } from './frame.js';

export function draftSize(canvas, maxEdge = 720) {
  const ar = canvas.w / canvas.h;
  let w = maxEdge, h = maxEdge;
  if (ar >= 1) h = Math.round(maxEdge / ar);
  else w = Math.round(maxEdge * ar);
  return { w, h };
}

export class Preview {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.project = null;
    this.cur = null;      // { id, kind, input, sink, bitmap, frameW, frameH }
    this.aux = null;      // second reader for the other clip of a transition
    this.draft = { w: canvasEl.width, h: canvasEl.height };
    this._target = null;  // { media, sourceSec, tlUs } | { dual, mediaA, srcA, mediaB, srcB, tr, tlUs }
    this._busy = false;
    this._dirty = false;
    this.hitBoxes = [];   // text hit boxes from the last paint (canvas px)
    this.staticTextId = null; // a text being edited renders at rest (no animation) so it is stable to place
    this.tlUs = 0;
    this.showSafe = false;  // preview-only safe-zone guide
    this._scratch = null; // [canvasA, canvasB] for dual composites
    this.ovReaders = new Map();   // overlay clipId -> source state (v0.45)
    this.ovBoxes = [];            // overlay hit boxes from the last paint (canvas px)
    // once bundled fonts (Creepster) load, repaint so a spooky title stops
    // showing in the fallback font.
    ensureFonts().then(() => this.repaintOverlay());
  }

  sizeToProject(project) {
    this.project = project;
    this.draft = draftSize(project.canvas);
    if (this.canvas.width !== this.draft.w) this.canvas.width = this.draft.w;
    if (this.canvas.height !== this.draft.h) this.canvas.height = this.draft.h;
    this._scratch = null;
  }

  clear(bg, c = this.ctx) {
    c.fillStyle = bg || (this.project?.canvas?.bg) || '#000';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _drawContained(c, source, fw, fh) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.min(cw / fw, ch / fh);
    const dw = Math.round(fw * s), dh = Math.round(fh * s);
    c.drawImage(source, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
  }

  _frameBox(media) {
    const mw = media.w || this.draft.w, mh = media.h || this.draft.h;
    const ar = mw / mh;
    let w = this.draft.w, h = this.draft.h;
    if (this.draft.w / this.draft.h > ar) w = Math.round(this.draft.h * ar);
    else h = Math.round(this.draft.w / ar);
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  // Open a source state for `media`. Always a fresh Input (a split clip is the same
  // file twice, and two readers can't share one decoder position).
  async _open(media) {
    if (media.kind === 'color') return { id: media.id, kind: 'color', color: media.color || '#000000' };
    if (media.kind === 'image') {
      const file = await readMedia(this.project.id, media.opfs);
      return { id: media.id, kind: 'image', bitmap: await createImageBitmap(file) };
    }
    const file = await readMedia(this.project.id, media.opfs);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const vtrack = await input.getPrimaryVideoTrack();
    const box = this._frameBox(media);
    const sink = vtrack ? new CanvasSink(vtrack, { width: box.w, height: box.h, fit: 'contain', poolSize: 2 }) : null;
    return { id: media.id, kind: 'video', input, sink, frameW: box.w, frameH: box.h };
  }
  _close(st) {
    if (!st) return;
    if (st.input) { try { st.input.dispose(); } catch (_) {} }
    if (st.bitmap) { try { st.bitmap.close?.(); } catch (_) {} }
  }
  async _ensure(media) {
    if (this.cur && this.cur.id === media.id) return;
    this._close(this.cur); this.cur = null;
    this.cur = await this._open(media);
  }
  async _ensureAux(media) {
    if (this.aux && this.aux.id === media.id) return;
    this._close(this.aux); this.aux = null;
    this.aux = await this._open(media);
  }
  _dropAux() { if (this.aux) { this._close(this.aux); this.aux = null; } }

  // Paint one source's frame into ctx c, framed per the clip (fit/fill/zoom/pan/rot).
  // Returns false on decode error. The decoded frame is cached per source position
  // so repaints while dragging text or reframing never re-decode.
  async _paint(c, st, sourceSec, clip) {
    const W = this.canvas.width, H = this.canvas.height;
    const clipIn = clip;
    if (st.kind === 'color') { this.clear(st.color, c); return true; }
    await this._ensureLut(clip);
    if (st.kind === 'image') { const kc = clipAt(clipIn, Math.round(Math.max(0, sourceSec) * 1e6)); this.clear(undefined, c); drawFrame(c, W, H, gradeFrame(st.bitmap, st.bitmap.width, st.bitmap.height, clip), st.bitmap.width, st.bitmap.height, kc); return true; }
    if (!st.sink) { this.clear(undefined, c); return true; }
    const sec = Math.max(0, sourceSec);
    if (!(st.cache && st.cacheSec === sec)) {
      let wrapped = null;
      try { wrapped = await st.sink.getCanvas(sec); } catch (e) { return false; }
      if (wrapped) {
        if (!st.cache || st.cache.width !== st.frameW || st.cache.height !== st.frameH) {
          st.cache = document.createElement('canvas'); st.cache.width = st.frameW; st.cache.height = st.frameH;
        }
        const cc = st.cache.getContext('2d'); cc.clearRect(0, 0, st.frameW, st.frameH); cc.drawImage(wrapped.canvas, 0, 0, st.frameW, st.frameH);
        st.cacheSec = sec; st.cacheTs = Math.round(wrapped.timestamp * 1e6);
      } else st.cacheSec = -1;
    }
    clip = clipAt(clipIn, Math.round(sec * 1e6), st.cacheTs != null ? st.cacheTs : null);   // keys (v0.45) + steady (v0.47, by the frame actually shown)
    this.clear(undefined, c);
    if (st.cache && st.cacheSec === sec) drawFrame(c, W, H, gradeFrame(st.cache, st.frameW, st.frameH, clip), st.frameW, st.frameH, clip);
    return true;
  }
  // A clip's LUT table must be in memory before it can grade; load it from OPFS once.
  async _ensureLut(clip) {
    const lut = lookOf(clip).lut; if (!lut || hasLut(lut.id) || !this.project) return;
    try { registerLut(lut.id, lut.size, await readLut(this.project.id, lut.id)); } catch (e) { console.warn('LUT missing', lut.id, e); }
  }
  // Native size of the frame currently on screen (for pan limits), or null.
  currentFrameDims() {
    const st = this.cur; if (!st) return null;
    if (st.kind === 'image' && st.bitmap) return { fw: st.bitmap.width, fh: st.bitmap.height };
    if (st.kind === 'video') return { fw: st.frameW, fh: st.frameH };
    return null;
  }

  // Public entry: render `media` at `sourceSec`. Coalesces to latest.
  renderAt(project, media, sourceSec, tlUs = 0, clip = null) {
    this.project = project;
    this.tlUs = tlUs;
    if (!media) { this._target = null; this._dropAux(); this.clear(); this._overlay(); return; }
    this._target = { media, sourceSec, tlUs, clip };
    if (this._busy) { this._dirty = true; return; }
    this._pump();
  }
  // Render a dual-source transition frame: clip A at srcA blended with clip B at srcB.
  renderTransition(project, mediaA, srcA, mediaB, srcB, tr, tlUs = 0) {
    this.project = project;
    this.tlUs = tlUs;
    this._target = { dual: true, mediaA, srcA, mediaB, srcB, tr, tlUs };
    if (this._busy) { this._dirty = true; return; }
    this._pump();
  }

  // Re-draw only the overlay layer on top of the last frame (cheap; used while dragging text).
  repaintOverlay() {
    if (this._busy) { this._dirty = true; return; }
    if (this._target) this._pump(); else { this.clear(); this._overlay(); }
  }
  // PiP overlays (v0.45): each overlay clip keeps its own reader and last frame.
  async _paintOverlays(tlUs) {
    this.ovBoxes = [];
    if (!this.project) return;
    const total = normalize(this.project);
    const active = overlaysAt(this.project, tlUs, total);
    const keep = new Set(active.map((c) => c.id));
    for (const [id, st] of this.ovReaders) if (!keep.has(id)) { this._close(st); this.ovReaders.delete(id); }
    const W = this.canvas.width, H = this.canvas.height;
    for (const clip of active) {
      const media = this.project.media.find((m) => m.id === clip.mediaId); if (!media) continue;
      let st = this.ovReaders.get(clip.id);
      if (!st || st.mediaId !== media.id) {
        if (st) this._close(st);
        try { st = await this._openOverlay(media); } catch (e) { continue; }
        this.ovReaders.set(clip.id, st);
      }
      const ovs = ovStateAt(clip, tlUs);
      let img = null, fw = 0, fh = 0;
      if (st.kind === 'image') { img = st.bitmap; fw = img.width; fh = img.height; }
      else if (st.kind === 'video' && st.sink) {
        const sec = Math.max(0, ovs.src / 1e6);
        if (!(st.cache && st.cacheSec === sec)) {
          let wrapped = null;
          try { wrapped = await st.sink.getCanvas(sec); } catch (_) { wrapped = null; }
          if (wrapped) {
            if (!st.cache) { st.cache = document.createElement('canvas'); st.cache.width = st.frameW; st.cache.height = st.frameH; }
            const cc = st.cache.getContext('2d'); cc.clearRect(0, 0, st.frameW, st.frameH); cc.drawImage(wrapped.canvas, 0, 0, st.frameW, st.frameH);
            st.cacheSec = sec;
          }
        }
        if (st.cache) { img = st.cache; fw = st.frameW; fh = st.frameH; }
      }
      if (!img) continue;
      st.raw = img; st.rawW = fw; st.rawH = fh;   // unkeyed frame, for the colour picker
      let cut = false;
      if (cutOn(clip)) {   // cut out person (v0.48); the cut frame is cached so repaints while dragging don't re-run the model
        const key = (st.kind === 'image' ? 'img' : st.cacheSec) + ':' + JSON.stringify(clip.cut);
        if (st.cutKey !== key) {
          try {
            const out = await cutFrame(img, fw, fh, clip);
            if (!st.cutCanvas) st.cutCanvas = document.createElement('canvas');
            st.cutCanvas.width = fw; st.cutCanvas.height = fh;
            const cx = st.cutCanvas.getContext('2d'); cx.clearRect(0, 0, fw, fh); cx.drawImage(out, 0, 0);
            st.cutKey = key; this.cutError = null;
          } catch (e) { this.cutError = e; st.cutKey = null; }
        }
        if (st.cutKey === key) { img = st.cutCanvas; cut = true; }
      }
      else if (keyOn(clip)) img = keyFrame(img, fw, fh, clip);   // green screen (v0.46)
      const r = drawOverlay(this.ctx, W, H, img, fw, fh, ovs, cut || keyOn(clip));
      this.ovBoxes.push({ id: clip.id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    }
  }
  async _openOverlay(media) {
    const file = await readMedia(this.project.id, media.opfs);
    if (media.kind === 'image') return { kind: 'image', mediaId: media.id, bitmap: await createImageBitmap(file) };
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const vtrack = await input.getPrimaryVideoTrack();
    const box = fitBox(media.w, media.h, this.draft.w, this.draft.h);
    const sink = vtrack ? new CanvasSink(vtrack, { width: box.w, height: box.h, fit: 'contain', poolSize: 2 }) : null;
    return { kind: 'video', mediaId: media.id, input, sink, frameW: box.w, frameH: box.h };
  }
  // Unkeyed picture of an overlay as last drawn: { img, w, h } or null (colour picker).
  overlayRaw(clipId) { const st = this.ovReaders.get(clipId); return st && st.raw ? { img: st.raw, w: st.rawW, h: st.rawH } : null; }
  _overlay() {
    if (!this.project) { this.hitBoxes = []; return; }
    this.hitBoxes = drawTextsAt(this.ctx, this.canvas.width, this.canvas.height, this.project, this.tlUs, { staticId: this.staticTextId });
    // dip/flash sits on top of everything, so titles dip with the picture
    drawTransitionAt(this.ctx, this.canvas.width, this.canvas.height, this.project, this.tlUs);
    if (this.showSafe) drawSafeZones(this.ctx, this.canvas.width, this.canvas.height);
  }
  _scratchPair() {
    const W = this.canvas.width, H = this.canvas.height;
    if (!this._scratch || this._scratch[0].width !== W || this._scratch[0].height !== H) {
      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
      this._scratch = [mk(), mk()];
    }
    return this._scratch;
  }

  async _pump() {
    this._busy = true;
    try {
      do {
        this._dirty = false;
        const t = this._target;
        if (!t) break;
        this.tlUs = t.tlUs ?? this.tlUs;
        if (t.dual) {
          try { await this._ensure(t.mediaA); await this._ensureAux(t.mediaB); }
          catch (e) { this._paintError('Media offline'); break; }
          const [sa, sb] = this._scratchPair();
          const ca = sa.getContext('2d'), cb = sb.getContext('2d');
          const okA = await this._paint(ca, this.cur, t.srcA, t.tr.a);
          const okB = await this._paint(cb, this.aux, t.srcB, t.tr.b);
          if (!okA && !okB) { this._paintError('decode'); continue; }
          drawDualTransition(this.ctx, this.canvas.width, this.canvas.height, t.tr.type, t.tr.dir, t.tr.x, sa, sb);
        } else {
          this._dropAux();
          try { await this._ensure(t.media); }
          catch (e) { this._paintError('Media offline'); break; }
          const ok = await this._paint(this.ctx, this.cur, t.sourceSec, t.clip);
          if (!ok) { this._paintError('decode'); continue; }
        }
        await this._paintOverlays(this.tlUs);
        this._overlay();
      } while (this._dirty);
    } finally {
      this._busy = false;
    }
  }

  _paintError(msg) {
    this.clear('#1e2128');
    this.ctx.fillStyle = '#ff4b3e';
    this.ctx.font = `${Math.round(this.canvas.height * 0.05)}px system-ui, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.fillText(msg || 'preview error', this.canvas.width / 2, this.canvas.height / 2);
  }

  dispose() {
    this._close(this.cur); this.cur = null;
    for (const st of this.ovReaders.values()) this._close(st);
    this.ovReaders.clear();
    this._dropAux();
    this._target = null;
    this._busy = false;
    this._dirty = false;
  }
}
