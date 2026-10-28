// bundle.js · RoughCut (v0.39)
// The project file: one ordinary .zip holding project.json, every media file,
// thumbnails and LUT tables, so a cut can leave the phone and come back, or move
// to another device. No lock-in: any unzip tool opens it. Written store-only (no
// compression; video is already compressed) with a tiny zip writer, so no library
// and no extra download. The reader also takes deflated entries, so a zip that
// someone re-saved from a desktop tool still imports.

import { readMedia, writeMedia, readThumb, writeThumb, readLut, writeLut, readTranscript, writeTranscript, uid } from './state.js';

export const BUNDLE_VERSION = 1;
export const BUNDLE_EXT = '.roughcut.zip';

// ---- CRC-32 (zip needs it even for stored entries) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crcUpdate(crc, bytes) { let c = crc ^ 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function crcOfBlob(blob, onBytes) {
  let crc = 0; const reader = blob.stream().getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; crc = crcUpdate(crc, value); if (onBytes) onBytes(value.length); }
  return crc;
}
const enc = new TextEncoder(), dec = new TextDecoder();
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}
function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

// entries: [{ name, blob }] -> Blob (a valid zip, stored entries). Blob parts reference the
// source blobs, so a project with gigabytes of media never gets copied into memory.
export async function writeZip(entries, onProgress) {
  const parts = [], central = [];
  let offset = 0, done = 0;
  const totalBytes = entries.reduce((a, e) => a + e.blob.size, 0) || 1;
  const { time, date } = dosDateTime();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const size = e.blob.size;
    const crc = await crcOfBlob(e.blob, (n) => { done += n; if (onProgress) onProgress(done / totalBytes); });
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, e.blob);
    central.push(new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + size;
  }
  const cdStart = offset;
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]);
  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

// Blob (zip) -> [{ name, size, blob() }] with lazy, per-entry extraction. Stored and deflated entries.
export async function readZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new Uint8Array(await file.slice(file.size - tailLen, file.size).arrayBuffer());
  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { p = i; break; }
  if (p < 0) throw new Error('Not a zip file.');
  const dv = new DataView(tail.buffer);
  const count = dv.getUint16(p + 10, true), cdSize = dv.getUint32(p + 12, true), cdStart = dv.getUint32(p + 16, true);
  if (cdStart === 0xffffffff) throw new Error('Zip64 files are not supported.');
  const cd = new Uint8Array(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
  const cdv = new DataView(cd.buffer);
  const out = []; let o = 0;
  for (let i = 0; i < count; i++) {
    if (cdv.getUint32(o, true) !== 0x02014b50) throw new Error('Bad zip directory.');
    const method = cdv.getUint16(o + 10, true), csize = cdv.getUint32(o + 20, true), usize = cdv.getUint32(o + 24, true);
    const nlen = cdv.getUint16(o + 28, true), xlen = cdv.getUint16(o + 30, true), clen = cdv.getUint16(o + 32, true), lho = cdv.getUint32(o + 42, true);
    const name = dec.decode(cd.subarray(o + 46, o + 46 + nlen));
    o += 46 + nlen + xlen + clen;
    out.push({
      name, size: usize, method,
      async blob() {
        const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
        const dataStart = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(dataStart, dataStart + csize);
        if (method === 0) return raw;
        if (method === 8) {
          if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot unpack compressed entries.');
          return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        }
        throw new Error('Unsupported zip compression (' + method + ').');
      },
    });
  }
  return out;
}

// ---- RoughCut project bundle -------------------------------------------
function lutIds(project) {
  const ids = new Set();
  for (const t of project.tracks || []) for (const c of (t.clips || [])) if (c.look && c.look.lut && c.look.lut.id) ids.add(c.look.lut.id);
  return [...ids];
}
export function bundleName(project) {
  return ((project.name || 'RoughCut').replace(/[^\w\- ]+/g, '').trim() || 'RoughCut') + BUNDLE_EXT;
}
// Build the zip for a project. onProgress(0..1) tracks the CRC pass over the media.
export async function exportBundle(project, onProgress) {
  const entries = [];
  const meta = { app: 'RoughCut', bundle: BUNDLE_VERSION, exported: new Date().toISOString(), project };
  entries.push({ name: 'project.json', blob: new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }) });
  for (const m of project.media || []) {
    if (m.opfs) { try { entries.push({ name: m.opfs, blob: await readMedia(project.id, m.opfs) }); } catch (e) { console.warn('bundle: media missing', m.name, e); } }
    if (m.thumb) { try { entries.push({ name: m.thumb, blob: await readThumb(project.id, m.id) }); } catch (_) {} }
  }
  for (const id of lutIds(project)) {
    try { const data = await readLut(project.id, id); entries.push({ name: `luts/${id}.f32`, blob: new Blob([data.buffer]) }); } catch (e) { console.warn('bundle: LUT missing', id, e); }
  }
  for (const m of project.media || []) {   // v0.42: transcripts travel with the project so captions rebuild without re-listening
    const tr = await readTranscript(project.id, m.id);
    if (tr) entries.push({ name: `transcripts/${m.id}.json`, blob: new Blob([JSON.stringify(tr)], { type: 'application/json' }) });
  }
  return writeZip(entries, onProgress);
}
// Read a bundle and install it as a NEW project (fresh id, media rewritten under it).
// Returns the project object; caller saves it and refreshes the list.
export async function importBundle(file, onProgress) {
  const entries = await readZip(file);
  const pj = entries.find((e) => e.name === 'project.json');
  if (!pj) throw new Error('That zip is not a RoughCut project (no project.json).');
  const meta = JSON.parse(await (await pj.blob()).text());
  const project = meta && meta.project ? meta.project : meta;
  if (!project || !project.tracks || !Array.isArray(project.media)) throw new Error('project.json is not a RoughCut project.');
  const newId = uid('proj');
  const oldId = project.id; project.id = newId;
  project.name = (project.name || 'Imported') + '';
  project.created = project.created || Date.now(); project.modified = Date.now();
  const byName = new Map(entries.map((e) => [e.name, e]));
  let n = 0; const total = Math.max(1, project.media.length * 2 + lutIds(project).length);
  const missing = [];
  for (const m of project.media) {
    const e = m.opfs ? byName.get(m.opfs) : null;
    if (e) {
      const ext = (m.opfs.split('.').pop() || 'bin');
      const blob = await e.blob();
      m.opfs = await writeMedia(newId, m.id, ext, new File([blob], m.name || m.id, { type: blob.type || '' }));
    } else if (m.opfs) { missing.push(m.name || m.id); }
    if (onProgress) onProgress(++n / total);
    const t = m.thumb ? byName.get(m.thumb) : null;
    if (t) { try { m.thumb = await writeThumb(newId, m.id, await t.blob()); } catch (_) {} }
    if (onProgress) onProgress(++n / total);
  }
  for (const id of lutIds(project)) {
    const e = byName.get(`luts/${id}.f32`);
    if (e) { try { await writeLut(newId, id, new Float32Array(await (await e.blob()).arrayBuffer())); } catch (err) { console.warn('bundle: LUT write failed', id, err); } }
    if (onProgress) onProgress(++n / total);
  }
  for (const m of project.media) {
    const e = byName.get(`transcripts/${m.id}.json`);
    if (e) { try { await writeTranscript(newId, m.id, JSON.parse(await (await e.blob()).text())); } catch (err) { console.warn('bundle: transcript skipped', m.id, err); } }
  }
  return { project, missing, oldId };
}
