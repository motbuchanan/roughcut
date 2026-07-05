// preview.js · RoughCut
// Draft-scale preview that follows the timeline playhead. Given the media + a
// source time, it decodes and draws one frame. CanvasSink applies rotation from
// metadata and caps VRAM with a small pool (L6, §8). One media is kept open at a
// time; crossing into a different clip's media reopens (fine for draft scrubbing).
// Latest-wins pump so dragging the playhead never queues stale frames.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './mediabunny.js';
import { readMedia } from './state.js';

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
    this.draft = { w: canvasEl.width, h: canvasEl.height };
    this._target = null;  // { media, sourceSec }
    this._busy = false;
    this._dirty = false;
  }

  sizeToProject(project) {
    this.project = project;
    this.draft = draftSize(project.canvas);
    if (this.canvas.width !== this.draft.w) this.canvas.width = this.draft.w;
    if (this.canvas.height !== this.draft.h) this.canvas.height = this.draft.h;
  }

  clear(bg) {
    this.ctx.fillStyle = bg || (this.project?.canvas?.bg) || '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _drawContained(source, fw, fh) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.min(cw / fw, ch / fh);
    const dw = Math.round(fw * s), dh = Math.round(fh * s);
    this.ctx.drawImage(source, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
  }

  _frameBox(media) {
    const mw = media.w || this.draft.w, mh = media.h || this.draft.h;
    const ar = mw / mh;
    let w = this.draft.w, h = this.draft.h;
    if (this.draft.w / this.draft.h > ar) w = Math.round(this.draft.h * ar);
    else h = Math.round(this.draft.w / ar);
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  async _ensure(media) {
    if (this.cur && this.cur.id === media.id) return;
    this._disposeCur();
    if (media.kind === 'image') {
      const file = await readMedia(this.project.id, media.opfs);
      const bitmap = await createImageBitmap(file);
      this.cur = { id: media.id, kind: 'image', bitmap };
      return;
    }
    // video
    const file = await readMedia(this.project.id, media.opfs);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const vtrack = await input.getPrimaryVideoTrack();
    const box = this._frameBox(media);
    const sink = vtrack ? new CanvasSink(vtrack, { width: box.w, height: box.h, fit: 'contain', poolSize: 2 }) : null;
    this.cur = { id: media.id, kind: 'video', input, sink, frameW: box.w, frameH: box.h };
  }

  // Public entry: render `media` at `sourceSec`. Coalesces to latest.
  renderAt(project, media, sourceSec) {
    this.project = project;
    if (!media) { this._target = null; this.clear(); return; }
    this._target = { media, sourceSec };
    if (this._busy) { this._dirty = true; return; }
    this._pump();
  }

  async _pump() {
    this._busy = true;
    try {
      do {
        this._dirty = false;
        const t = this._target;
        if (!t) break;
        try {
          await this._ensure(t.media);
        } catch (e) { this._paintError('open'); break; }
        if (this.cur.kind === 'image') {
          this.clear();
          this._drawContained(this.cur.bitmap, this.cur.bitmap.width, this.cur.bitmap.height);
        } else if (this.cur.sink) {
          let wrapped = null;
          try { wrapped = await this.cur.sink.getCanvas(Math.max(0, t.sourceSec)); }
          catch (e) { this._paintError('decode'); continue; }
          this.clear();
          if (wrapped) this._drawContained(wrapped.canvas, this.cur.frameW, this.cur.frameH);
        } else {
          this._paintError('no video track');
        }
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

  _disposeCur() {
    if (!this.cur) return;
    if (this.cur.input) { try { this.cur.input.dispose(); } catch (_) {} }
    if (this.cur.bitmap) { try { this.cur.bitmap.close?.(); } catch (_) {} }
    this.cur = null;
  }

  dispose() {
    this._disposeCur();
    this._target = null;
    this._busy = false;
    this._dirty = false;
  }
}
