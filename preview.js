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
    this.tlUs = 0;
    this._scratch = null; // [canvasA, canvasB] for dual composites
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

  // Paint one source's frame (bg-filled, contain-fit) into ctx c. Returns false on decode error.
  async _paint(c, st, sourceSec) {
    if (st.kind === 'color') { this.clear(st.color, c); return true; }
    if (st.kind === 'image') { this.clear(undefined, c); this._drawContained(c, st.bitmap, st.bitmap.width, st.bitmap.height); return true; }
    if (!st.sink) { this.clear(undefined, c); return true; }
    let wrapped = null;
    try { wrapped = await st.sink.getCanvas(Math.max(0, sourceSec)); } catch (e) { return false; }
    this.clear(undefined, c);
    if (wrapped) this._drawContained(c, wrapped.canvas, st.frameW, st.frameH);
    return true;
  }

  // Public entry: render `media` at `sourceSec`. Coalesces to latest.
  renderAt(project, media, sourceSec, tlUs = 0) {
    this.project = project;
    this.tlUs = tlUs;
    if (!media) { this._target = null; this._dropAux(); this.clear(); this._overlay(); return; }
    this._target = { media, sourceSec, tlUs };
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
  _overlay() {
    if (!this.project) { this.hitBoxes = []; return; }
    this.hitBoxes = drawTextsAt(this.ctx, this.canvas.width, this.canvas.height, this.project, this.tlUs);
    // dip/flash sits on top of everything, so titles dip with the picture
    drawTransitionAt(this.ctx, this.canvas.width, this.canvas.height, this.project, this.tlUs);
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
          const okA = await this._paint(ca, this.cur, t.srcA);
          const okB = await this._paint(cb, this.aux, t.srcB);
          if (!okA && !okB) { this._paintError('decode'); continue; }
          drawDualTransition(this.ctx, this.canvas.width, this.canvas.height, t.tr.type, t.tr.dir, t.tr.x, sa, sb);
        } else {
          this._dropAux();
          try { await this._ensure(t.media); }
          catch (e) { this._paintError('Media offline'); break; }
          const ok = await this._paint(this.ctx, this.cur, t.sourceSec);
          if (!ok) { this._paintError('decode'); continue; }
        }
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
    this._dropAux();
    this._target = null;
    this._busy = false;
    this._dirty = false;
  }
}
