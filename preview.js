// preview.js · RoughCut
// M1 preview: scrub one media item onto the draft-scale canvas. CanvasSink
// applies rotation from metadata and lets us cap VRAM with a small pool (L6, §8).
// Latest-wins seeking with rAF coalescing so dragging the scrubber stays smooth.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './mediabunny.js';
import { readMedia, usToS } from './state.js';

// Draft backing-store size for a given project canvas (max edge ~720).
export function draftSize(canvas, maxEdge = 720) {
  const ar = canvas.w / canvas.h;
  let w = maxEdge, h = maxEdge;
  if (ar >= 1) h = Math.round(maxEdge / ar);
  else w = Math.round(maxEdge * ar);
  return { w, h };
}

export class ClipPreview {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.project = null;
    this.media = null;
    this.input = null;
    this.sink = null;
    this.bitmap = null; // for images
    this.draft = { w: canvasEl.width, h: canvasEl.height };
    // scrub coalescing
    this._targetS = 0;
    this._busy = false;
    this._dirty = false;
  }

  _sizeToProject(project) {
    this.draft = draftSize(project.canvas);
    if (this.canvas.width !== this.draft.w) this.canvas.width = this.draft.w;
    if (this.canvas.height !== this.draft.h) this.canvas.height = this.draft.h;
  }

  _clear(bg) {
    this.ctx.fillStyle = bg || '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // contain a frame of size (fw,fh) inside the draft canvas
  _drawContained(source, fw, fh) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.min(cw / fw, ch / fh);
    const dw = Math.round(fw * s), dh = Math.round(fh * s);
    const dx = Math.round((cw - dw) / 2), dy = Math.round((ch - dh) / 2);
    this.ctx.drawImage(source, dx, dy, dw, dh);
  }

  async load(project, media) {
    this.dispose();
    this.project = project;
    this.media = media;
    this._sizeToProject(project);
    this._clear(project.canvas.bg);

    if (media.kind === 'image') {
      const file = await readMedia(project.id, media.opfs);
      this.bitmap = await createImageBitmap(file);
      this._clear(project.canvas.bg);
      this._drawContained(this.bitmap, this.bitmap.width, this.bitmap.height);
      return;
    }
    if (media.kind === 'audio') {
      this._paintAudioPlaceholder();
      return;
    }
    // video
    const file = await readMedia(project.id, media.opfs);
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const vtrack = await this.input.getPrimaryVideoTrack();
    if (!vtrack) { this._paintError('No video track'); return; }
    // Sink sized to the media display box, contained into draft; rotation auto.
    const box = this._frameBox(media);
    this.sink = new CanvasSink(vtrack, { width: box.w, height: box.h, fit: 'contain', poolSize: 2 });
    this._frameW = box.w;
    this._frameH = box.h;
    await this.seek(0, true);
  }

  // Fit the media's display aspect into a draft-sized box (keeps decode cheap).
  _frameBox(media) {
    const mw = media.w || this.draft.w;
    const mh = media.h || this.draft.h;
    const ar = mw / mh;
    let w = this.draft.w, h = this.draft.h;
    if (this.draft.w / this.draft.h > ar) w = Math.round(this.draft.h * ar);
    else h = Math.round(this.draft.w / ar);
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  // Public scrub entry. seconds within the clip. Coalesces to latest.
  async seek(seconds, immediate = false) {
    this._targetS = seconds;
    if (this.media?.kind !== 'video' || !this.sink) return;
    if (this._busy && !immediate) { this._dirty = true; return; }
    this._busy = true;
    try {
      do {
        this._dirty = false;
        const s = Math.max(0, this._targetS);
        let wrapped = null;
        try {
          wrapped = await this.sink.getCanvas(s);
        } catch (e) {
          this._paintError('decode');
          break;
        }
        this._clear(this.project.canvas.bg);
        if (wrapped) this._drawContained(wrapped.canvas, this._frameW, this._frameH);
      } while (this._dirty);
    } finally {
      this._busy = false;
    }
  }

  _paintAudioPlaceholder() {
    const { ctx, canvas } = this;
    this._clear('#1e2128');
    ctx.fillStyle = '#3fae7a';
    const midY = canvas.height / 2;
    const n = 40, step = canvas.width / n;
    for (let i = 0; i < n; i++) {
      const amp = (Math.sin(i * 0.7) * 0.4 + 0.5) * canvas.height * 0.35;
      ctx.fillRect(i * step + step * 0.25, midY - amp / 2, step * 0.5, amp);
    }
    ctx.fillStyle = '#8a8f9a';
    ctx.font = `${Math.round(canvas.height * 0.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('audio', canvas.width / 2, canvas.height * 0.9);
  }

  _paintError(msg) {
    this._clear('#1e2128');
    this.ctx.fillStyle = '#ff4b3e';
    this.ctx.font = `${Math.round(this.canvas.height * 0.05)}px system-ui, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.fillText(msg || 'preview error', this.canvas.width / 2, this.canvas.height / 2);
  }

  durationS() {
    return this.media ? usToS(this.media.durUs) : 0;
  }

  dispose() {
    if (this.input) { try { this.input.dispose(); } catch (_) {} this.input = null; }
    if (this.bitmap) { try { this.bitmap.close?.(); } catch (_) {} this.bitmap = null; }
    this.sink = null;
    this.media = null;
    this._busy = false;
    this._dirty = false;
  }
}
