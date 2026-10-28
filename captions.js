// captions.js · RoughCut (v0.42)
// Auto captions: turn a per-source transcript (words with source-time onsets)
// into caption text items on the text track. Pure logic here; the listening
// happens in captions-worker.js and the buttons live in ui.js.
//
// Rules carried from the editing rules pack:
//   caption start = word onset + 0.08 s (late by a hair is invisible, early reads broken)
//   2 to 3 words per caption, 4 is the ceiling; break on punctuation, then a
//   pause of 0.35 s or more, then word count; anything under 0.4 s merges
//   caption times are timeline times derived from the clip that is being
//   captioned (source time, then in-point, then speed); re-cut = re-time
//   corrections list (names, product words) is applied before chunking
//
// A caption is an ordinary text item with a `cap` field:
//   cap: { mediaId, clipId, srcStartUs, srcEndUs }
// so it can be restyled or retyped like any text, and re-timed from its clip.

import { makeText, textTrack } from './text.js';
import { mainTrack, clipDurUs, clipSpeed } from './timeline.js';
import { uid } from './state.js';

const US = 1_000_000;
export const CAPTION_LEAD_S = 0.08;
export const PAUSE_BREAK_S = 0.35;
export const MIN_SHOW_S = 0.4;
export const MAX_WORDS = 3;          // 4 only to finish a sentence
export const HOLD_GAP_S = 0.6;       // hold a caption up to the next one when the gap is short
export const TAIL_S = 0.25;          // otherwise linger this long after the last word

// Default look: heavy outline + soft dark glow, no box, lower centre above the feed's bottom band.
export const CAPTION_STYLE = {
  font: 'impact', size: 0.05, color: '#ffffff', bold: true, shadow: true,
  outline: true, outlineColor: '#000000', glow: true, glowColor: '#000000',
  bg: 'none', align: 'center', anim: 'none', x: 0.5, y: 0.68,
};

export const isCaption = (it) => !!(it && it.cap);

// ---- corrections ("fix words") ----------------------------------------------
// Text form, one per line: `wrong -> right` (also `wrong = right` or `wrong: right`).
export function parseFixes(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = /^(.+?)\s*(?:->|=>|=|:)\s*(.+)$/.exec(line); if (!m) continue;
    const from = m[1].trim(), to = m[2].trim();
    if (from && to && from !== to) out.push({ from, to });   // a case change (yanke -> Yanke) is a real fix
  }
  return out;
}
export function fixesToText(fixes) { return (fixes || []).map((f) => `${f.from} -> ${f.to}`).join('\n'); }
// Apply to a word list (keeps timing; multi-word `from` matches across consecutive words).
export function applyFixes(words, fixes) {
  if (!fixes || !fixes.length || !words.length) return words;
  const norm = (s) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const out = words.map((w) => ({ ...w }));
  for (const f of fixes) {
    const parts = f.from.split(/\s+/).map(norm).filter(Boolean); if (!parts.length) continue;
    for (let i = 0; i + parts.length <= out.length; i++) {
      let ok = true;
      for (let k = 0; k < parts.length; k++) if (norm(out[i + k].text) !== parts[k]) { ok = false; break; }
      if (!ok) continue;
      const last = out[i + parts.length - 1].text;
      const trail = /[^\p{L}\p{N}]+$/u.exec(last); const lead = /^[^\p{L}\p{N}]+/u.exec(out[i].text);
      const merged = { text: (lead ? lead[0] : '') + f.to + (trail ? trail[0] : ''), start: out[i].start, end: out[i + parts.length - 1].end };
      out.splice(i, parts.length, merged);
    }
  }
  return out;
}

// ---- chunking --------------------------------------------------------------
const endsSentence = (t) => /[.!?]["')\]]*$/.test(t);
const endsClause = (t) => /[.,;:!?]["')\]]*$/.test(t);

// words: [{ text, start, end }] seconds, in order. -> [{ text, start, end, n }]
export function chunkWords(words) {
  const ws = words.filter((w) => w && w.text && w.text.trim());
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], next = ws[i + 1];
    cur.push(w);
    if (!next) break;
    const pause = next.start - w.end;
    if (endsSentence(w.text) && pause >= PAUSE_BREAK_S) { flush(); continue; }   // a sentence end with a real pause always breaks
    if (cur.length >= 2 && (endsClause(w.text) || pause >= PAUSE_BREAK_S)) { flush(); continue; }
    if (cur.length >= MAX_WORDS) {
      if (cur.length === MAX_WORDS && endsSentence(next.text)) { cur.push(next); i++; }   // a 4th word only to close the sentence
      flush();
    }
  }
  flush();
  // merge blink-length chunks into a neighbour (prefer the previous one)
  const dur = (c) => c[c.length - 1].end - c[0].start;
  for (let i = 0; i < chunks.length; i++) {
    if (dur(chunks[i]) >= MIN_SHOW_S || chunks.length === 1) continue;
    if (i > 0 && chunks[i - 1].length + chunks[i].length <= MAX_WORDS + 1) { chunks[i - 1] = chunks[i - 1].concat(chunks[i]); chunks.splice(i, 1); i--; continue; }
    if (i < chunks.length - 1 && chunks[i].length + chunks[i + 1].length <= MAX_WORDS + 1) { chunks[i + 1] = chunks[i].concat(chunks[i + 1]); chunks.splice(i, 1); i--; continue; }
  }
  return chunks.map((c) => ({ text: c.map((w) => w.text.trim()).join(' '), start: c[0].start, end: c[c.length - 1].end, n: c.length }));
}

// On-screen window per chunk: onset + lead, held to the next caption when the gap is short.
export function timeChunks(chunks) {
  return chunks.map((c, i) => {
    const start = c.start + CAPTION_LEAD_S;
    const next = chunks[i + 1];
    let end = c.end + TAIL_S;
    if (next) {
      const nextStart = next.start + CAPTION_LEAD_S;
      end = (nextStart - c.end <= HOLD_GAP_S) ? nextStart : Math.min(end, nextStart);
    }
    end = Math.max(end, start + MIN_SHOW_S);
    if (next) end = Math.min(end, next.start + CAPTION_LEAD_S);
    return { ...c, showStart: start, showEnd: Math.max(end, start + 0.1) };
  });
}

// ---- building caption items for the timeline -------------------------------
// transcripts: Map(mediaId -> { words: [{text,start,end}] })  (seconds, source time)
// Returns new text items (not yet on the track).
export function buildCaptionItems(project, transcripts, fixes, style = {}) {
  const items = [];
  const st = { ...CAPTION_STYLE, ...style };
  for (const c of mainTrack(project).clips) {
    const tr = transcripts.get ? transcripts.get(c.mediaId) : transcripts[c.mediaId];
    if (!tr || !tr.words || !tr.words.length) continue;
    const in_ = c.inUs / US, out_ = c.outUs / US;
    const words = applyFixes(tr.words.filter((w) => w.start >= in_ - 0.02 && w.start < out_), fixes);
    if (!words.length) continue;
    const chunks = timeChunks(chunkWords(words));
    for (const ch of chunks) {
      const srcStartUs = Math.round(ch.showStart * US), srcEndUs = Math.round(Math.min(ch.showEnd, out_) * US);
      if (srcEndUs - srcStartUs < 50_000) continue;
      const it = makeText(0, { text: ch.text, ...st });
      it.id = uid('t');
      it.cap = { mediaId: c.mediaId, clipId: c.id, srcStartUs, srcEndUs };
      placeCaption(it, c);
      items.push(it);
    }
  }
  return items;
}
// Timeline position from the clip's current in/out/speed/start. Outside the clip: collapsed (hidden).
export function placeCaption(it, clip) {
  if (!clip) { it.outUs = 0; return it; }
  const sp = clipSpeed(clip);
  const s = Math.max(it.cap.srcStartUs, clip.inUs), e = Math.min(it.cap.srcEndUs, clip.outUs);
  // the words must start inside the clip; a caption whose first words were trimmed away hides rather than flashing its tail
  if (it.cap.srcStartUs < clip.inUs - 20_000 || it.cap.srcStartUs >= clip.outUs || e <= s) { it.outUs = 0; it.tlStartUs = clip.tlStartUs; return it; }
  it.tlStartUs = clip.tlStartUs + Math.round((s - clip.inUs) / sp);
  it.inUs = 0; it.outUs = Math.max(0, Math.round((e - s) / sp));
  return it;
}
// Keep every caption in step with its clip after any edit. Returns true if anything moved.
export function retimeCaptions(project) {
  const t = textTrack(project);
  const clips = new Map(); for (const c of mainTrack(project).clips) clips.set(c.id, c);
  let moved = false;
  for (const it of t.items) {
    if (!it.cap) continue;
    const before = it.tlStartUs + ':' + it.outUs;
    placeCaption(it, clips.get(it.cap.clipId) || null);
    if (before !== it.tlStartUs + ':' + it.outUs) moved = true;
  }
  if (moved) t.items.sort((a, b) => a.tlStartUs - b.tlStartUs);
  return moved;
}
export function captionItems(project) { return textTrack(project).items.filter(isCaption); }
export function captionCount(project) { return captionItems(project).filter((it) => it.outUs > 0).length; }

// Replace all caption items (or only those of the given media ids) with `items`. One undo step.
export function setCaptionsCmd(project, items, mediaIds = null) {
  const t = textTrack(project);
  let removed = null;
  const keep = mediaIds ? new Set(mediaIds) : null;
  return {
    label: 'Captions',
    do() {
      removed = t.items.filter((it) => it.cap && (!keep || keep.has(it.cap.mediaId)));
      t.items = t.items.filter((it) => !removed.includes(it));
      t.items.push(...items);
      t.items.sort((a, b) => a.tlStartUs - b.tlStartUs);
      return items.length;
    },
    undo() {
      t.items = t.items.filter((it) => !items.includes(it));
      if (removed) t.items.push(...removed);
      t.items.sort((a, b) => a.tlStartUs - b.tlStartUs);
    },
  };
}

// ---- transcript post-processing (worker output -> words) -------------------
// transformers.js chunks: [{ text: ' Hello', timestamp: [s, e] }]. Word mode gives one per
// word; segment mode gives sentences, which we split evenly across their words (approx).
export function wordsFromChunks(chunks, { approx = false } = {}) {
  const out = [];
  let lastEnd = 0;
  for (const ch of chunks || []) {
    const text = (ch.text || '').trim(); if (!text) continue;
    let [s, e] = ch.timestamp || [null, null];
    if (s == null || !isFinite(s)) s = lastEnd;
    if (e == null || !isFinite(e) || e < s) e = s + Math.max(0.2, text.split(/\s+/).length * 0.3);
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 1 && !approx) { out.push({ text: parts[0], start: s, end: e }); lastEnd = e; continue; }
    // spread evenly by character count (long words take longer)
    const total = parts.reduce((a, p) => a + p.length + 1, 0);
    let t = s;
    for (const p of parts) { const d = (e - s) * ((p.length + 1) / total); out.push({ text: p, start: t, end: t + d }); t += d; }
    lastEnd = e;
  }
  return out;
}

export function fmtClock(s) { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
