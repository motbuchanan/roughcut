// frame.js · RoughCut (v0.34)
// How a clip's picture sits in the canvas: fit (letterbox) or fill (crop to
// cover), zoom, position, and 90-degree rotation. One draw routine shared by the
// preview and the export, so what you see is what renders. Pure, no DOM.
//
// Stored on the clip: clip.fit = 'fit' | 'fill', clip.xf = { x, y, scale, rot }.
//   x / y   : offset as a fraction of the canvas width / height (0 = centred)
//   scale   : extra zoom on top of the fit (1 = none, up to ZOOM_MAX)
//   rot     : 0 / 90 / 180 / 270, applied after the file's own rotation metadata
// Old projects have none of this and draw exactly as before (fit, centred).

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;
export const FITS = ['fit', 'fill'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function frameOf(clip) {
  const xf = (clip && clip.xf) || {};
  const rot = ((Math.round((Number(xf.rot) || 0) / 90) * 90) % 360 + 360) % 360;
  return {
    fit: clip && clip.fit === 'fill' ? 'fill' : 'fit',
    scale: clamp(Number(xf.scale) || 1, ZOOM_MIN, ZOOM_MAX),
    x: Number(xf.x) || 0,
    y: Number(xf.y) || 0,
    rot,
  };
}
export function isDefaultFrame(clip) {
  const f = frameOf(clip);
  return f.fit === 'fit' && f.scale === 1 && f.x === 0 && f.y === 0 && f.rot === 0;
}

// The box a (rotation-corrected) source of mw x mh gets when contained in W x H.
// Decoders render into this box so the frame arrives at its own aspect, no bars.
export function fitBox(mw, mh, W, H) {
  const ar = (mw > 0 && mh > 0) ? mw / mh : W / H;
  let w = W, h = H;
  if (W / H > ar) w = Math.round(H * ar); else h = Math.round(W / ar);
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

// Scale applied to a fw x fh frame for this clip on a W x H canvas.
export function frameScale(W, H, fw, fh, clip) {
  const f = frameOf(clip);
  const swap = f.rot === 90 || f.rot === 270;
  const rw = swap ? fh : fw, rh = swap ? fw : fh;
  const base = f.fit === 'fill' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
  return { s: base * f.scale, rw, rh, f };
}

// Draw the frame per the clip's framing. Caller fills the background first.
export function drawFrame(ctx, W, H, img, fw, fh, clip) {
  if (!img || !(fw > 0) || !(fh > 0)) return;
  const { s, f } = frameScale(W, H, fw, fh, clip);
  ctx.save();
  ctx.translate(W / 2 + f.x * W, H / 2 + f.y * H);
  if (f.rot) ctx.rotate(f.rot * Math.PI / 180);
  ctx.scale(s, s);
  ctx.drawImage(img, -fw / 2, -fh / 2, fw, fh);
  ctx.restore();
}

// How far (fraction of W / H) the picture may be dragged on each axis before its
// edge would leave the canvas: half the overhang when it is bigger than the
// canvas, half the gap when it is smaller.
export function panLimits(W, H, fw, fh, clip) {
  const { s, rw, rh } = frameScale(W, H, fw, fh, clip);
  return { x: Math.abs(rw * s - W) / 2 / W, y: Math.abs(rh * s - H) / 2 / H };
}
export function clampPan(W, H, fw, fh, clip, x, y) {
  const l = panLimits(W, H, fw, fh, clip);
  return { x: clamp(x, -l.x, l.x), y: clamp(y, -l.y, l.y) };
}

// Preview-only guide. Never exported. Portrait canvases get the short-form
// feed zones (header, caption/controls, side buttons) and the 4:5 feed crop;
// everything else gets a 5% action-safe inset.
export function drawSafeZones(ctx, W, H) {
  ctx.save();
  ctx.lineWidth = Math.max(1, Math.round(W / 360));
  if (H > W) {
    ctx.fillStyle = 'rgba(255, 70, 50, 0.24)';
    ctx.fillRect(0, 0, W, Math.round(H * 0.15));                              // platform header
    ctx.fillRect(0, Math.round(H * 0.75), W, H - Math.round(H * 0.75));       // caption, audio, controls
    ctx.fillRect(Math.round(W * 0.85), Math.round(H * 0.15), W - Math.round(W * 0.85), Math.round(H * 0.60)); // like / share column
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(76, 240, 224, 0.9)';
    const ch = Math.round(W * 5 / 4), cy = Math.round((H - ch) / 2);
    ctx.strokeRect(0.5, cy + 0.5, W - 1, ch - 1);                             // 4:5 feed crop
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${Math.max(10, Math.round(W / 30))}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('keep text above here', Math.round(W * 0.03), Math.round(H * 0.73) - 4);
  } else {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(76, 240, 224, 0.9)';
    ctx.strokeRect(Math.round(W * 0.05) + 0.5, Math.round(H * 0.05) + 0.5, Math.round(W * 0.9) - 1, Math.round(H * 0.9) - 1);
  }
  ctx.restore();
}
