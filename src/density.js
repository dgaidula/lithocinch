// Resolution (density) headers, written without touching the pixels.
//
// A JPEG or PNG records "pixels per inch" in a few header bytes that no decoder
// reads when it builds the image. This module rewrites exactly those bytes and
// copies every other byte of the file unchanged, so the compressed data is
// identical and the result decodes to the same pixels. Two callers use it:
//   - `--density <ppi>` on a normal optimize run patches each encoded output;
//   - `lithocinch density` (density-cli.js) patches existing JPEGs on their own.
//
// JPEG carries a density in up to three places, and each is rewritten when it
// exists:
//   - the JFIF APP0 segment: units (1 = per inch), Xdensity, Ydensity;
//   - EXIF IFD0: XResolution and YResolution (RATIONAL), ResolutionUnit (SHORT,
//     set to 2 = inch, so a file saved in centimetres is not left saying so);
//   - Photoshop's resolution resource (APP13, 8BIM 0x03ED): a fixed 16-byte
//     record, rewritten in place.
// A JPEG with neither JFIF nor EXIF (what sharp itself writes) gets a JFIF APP0
// inserted right after SOI: 18 bytes, and only where doing so cannot change how
// a decoder reads the colour (see canInsertJfif). XMP resolution values are not
// rewritten (the packet is text and may change length); they are reported, with
// the value they still hold, rather than left to mislead. EXIF IFD1 (the
// thumbnail's) is neither rewritten nor reported: readers take IFD0.
//
// PNG carries it in the pHYs chunk (pixels per metre, so 300 ppi is stored as
// 11811 and reads back as 299.9994 before rounding). An existing pHYs is
// replaced in place; a missing one is inserted before the first IDAT (21 bytes).
// An eXIf chunk (kept EXIF) has its IFD0 resolution rewritten too, and its CRC
// recomputed, because readers such as libvips and Apple ImageIO prefer it.
//
// Everything here is Buffer in, Buffer out, no filesystem: it works in the CLI,
// as a library call and in the Lambda.

import { parsePpi } from './config.js';

/** A file this module will not rewrite, with a machine-readable reason. */
export class DensityError extends Error {
  /** @param {string} message  @param {'not-jpeg'|'not-png'|'corrupt'|'unsupported'} code */
  constructor(message, code) {
    super(message);
    this.name = 'DensityError';
    this.code = code;
  }
}

const corrupt = (why, fmt = 'JPEG') => new DensityError(`corrupt ${fmt}: ${why}`, 'corrupt');

const TAG_XRES = 0x011a;
const TAG_YRES = 0x011b;
const TAG_RES_UNIT = 0x0128;
const TYPE_SHORT = 3;
const TYPE_RATIONAL = 5;

const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * Walk the JPEG's header segments (everything before the first scan) and note
 * where each density field lives. Pure reads; throws DensityError on anything
 * that does not hold together, so a damaged header is never patched.
 */
function scanJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new DensityError('not a JPEG: no start-of-image marker', 'not-jpeg');
  }
  const found = {
    jfif: null, // offset of the JFIF payload (after "JFIF\0")
    exif: [], // {pos, kind:'rational'|'unit', le}
    exifPresent: false,
    adobe: false,
    components: null, // [ids] from the SOF segment
    xmpResolution: false,
    xmpValue: null, // what the XMP XResolution says, for the warning ("300 ppi")
    photoshopResolution: false, // a 0x03ED resource that cannot be rewritten
    photoshop: [], // offsets of 16-byte 0x03ED records to rewrite
  };
  let i = 2;
  for (;;) {
    if (i + 1 >= buf.length) throw corrupt('the file ends before the image data starts');
    if (buf[i] !== 0xff) throw corrupt(`expected a marker at byte ${i}`);
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers with no length
    if (m === 0xd9) throw corrupt('end-of-image marker before any image data');
    if (i + 4 > buf.length) throw corrupt('the file ends inside a segment header');
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw corrupt(len < 2 ? `the segment at byte ${i} has an impossible length (${len})` : `the segment at byte ${i} runs past the end of the file`);
    const seg = i + 4;
    const text = (n) => buf.toString('latin1', seg, Math.min(seg + n, end));

    if (m === 0xe0 && text(5) === 'JFIF\0') {
      if (len < 16) throw corrupt('JFIF segment is shorter than its fixed fields');
      found.jfif ??= seg + 5;
    } else if (m === 0xe1 && text(6) === 'Exif\0\0') {
      found.exifPresent = true;
      scanExif(buf, seg + 6, end, found);
    } else if (m === 0xe1 && text(29) === 'http://ns.adobe.com/xap/1.0/\0') {
      if (/[XY]Resolution/.test(buf.toString('latin1', seg + 29, end))) found.xmpResolution = true;
      found.xmpValue ??= xmpResolutionValue(buf.toString('latin1', seg + 29, end));
    } else if (m === 0xed && text(14) === 'Photoshop 3.0\0') {
      const at = hasPhotoshopResolution(buf, seg + 14, end);
      if (at === -1) found.photoshopResolution = true;
      else if (at != null) found.photoshop.push(at);
    } else if (m === 0xee && text(5) === 'Adobe') {
      found.adobe = true;
    } else if (isSof(m) && !found.components) {
      const n = buf[seg + 5];
      if (len < 8 + 3 * n) throw corrupt('SOF segment is shorter than its component list');
      found.components = Array.from({ length: n }, (_, k) => buf[seg + 6 + 3 * k]);
    } else if (m === 0xda) {
      found.sos = i;
      return found;
    }
    i = end;
  }
}

/** Locate IFD0's resolution entries inside one EXIF block (a bare TIFF header) [t, end). */
function scanExif(buf, t, end, found, fmt = 'JPEG') {
  const size = end - t;
  const bad = (why) => corrupt(`EXIF ${why}`, fmt);
  if (size < 8) throw bad('block is shorter than a TIFF header');
  const order = buf.toString('latin1', t, t + 2);
  if (order !== 'II' && order !== 'MM') throw bad('byte order mark is neither II nor MM');
  const le = order === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(t + 2) !== 42) throw bad('TIFF magic number is not 42');
  const ifd = u32(t + 4);
  if (ifd < 8 || ifd + 2 > size) throw bad('IFD0 offset is outside the block');
  const count = u16(t + ifd);
  if (ifd + 2 + count * 12 > size) throw bad('IFD0 entry table runs past the end of the block');
  for (let e = 0; e < count; e++) {
    const at = t + ifd + 2 + e * 12;
    const tag = u16(at);
    if (tag !== TAG_XRES && tag !== TAG_YRES && tag !== TAG_RES_UNIT) continue;
    const type = u16(at + 2);
    if (u32(at + 4) !== 1) throw bad(`tag 0x${tag.toString(16)} does not have exactly one value`);
    if (tag === TAG_RES_UNIT) {
      if (type !== TYPE_SHORT) throw bad('ResolutionUnit is not a SHORT');
      found.exif.push({ pos: at + 8, kind: 'unit', le });
    } else {
      if (type !== TYPE_RATIONAL) throw bad(`tag 0x${tag.toString(16)} is not a RATIONAL`);
      const off = u32(at + 8);
      if (off + 8 > size) throw bad(`tag 0x${tag.toString(16)} points outside the block`);
      // The value must not sit in the TIFF header or in IFD0's own entry table
      // (entries, then the 4-byte next-IFD offset): writing it would destroy them.
      if (off < 8 || (off < ifd + 2 + count * 12 + 4 && off + 8 > ifd)) {
        throw bad(`tag 0x${tag.toString(16)} points into the TIFF header or IFD0 itself`);
      }
      found.exif.push({ pos: t + off, kind: 'rational', tag, le });
    }
  }
}

/**
 * Does this Photoshop image-resources block hold resource 0x03ED (resolution)?
 * Returns the offset of its 16-byte ResolutionInfo record, -1 when the resource
 * is there but not the expected 16 bytes inside the block, or null when absent.
 */
function hasPhotoshopResolution(buf, from, end) {
  let o = from;
  while (o + 12 <= end && buf.toString('latin1', o, o + 4) === '8BIM') {
    const id = buf.readUInt16BE(o + 4);
    const nameLen = buf[o + 6];
    const sizeAt = o + 6 + (1 + nameLen + ((1 + nameLen) % 2));
    if (sizeAt + 4 > end) return null;
    const size = buf.readUInt32BE(sizeAt);
    if (id === 0x03ed) return size === 16 && sizeAt + 4 + 16 <= end ? sizeAt + 4 : -1;
    o = sizeAt + 4 + size + (size % 2);
  }
  return null;
}

/** The XResolution an XMP packet states, as text for a warning ("300 ppi"), or null. */
function xmpResolutionValue(xml) {
  const v = /XResolution(?:\s*=\s*["']|>)\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/.exec(xml);
  if (!v) return null;
  const value = Math.round((Number(v[1]) / (v[2] ? Number(v[2]) : 1)) * 100) / 100;
  if (!Number.isFinite(value)) return null;
  const unit = /ResolutionUnit(?:\s*=\s*["']|>)\s*(\d)/.exec(xml)?.[1];
  return `${value} ${unit === '3' ? 'per cm' : 'ppi'}`;
}

/**
 * A JFIF segment makes a decoder read three components as YCbCr and one as
 * grey. Insert one only where the decoder would have decided that anyway, so
 * the pixels cannot change: no Adobe marker, one or three components, and
 * three component ids that are not the letters R, G, B (which mean RGB).
 */
function canInsertJfif(found) {
  if (found.adobe) return 'it has an Adobe APP14 marker, and adding JFIF could change how its colours decode';
  const c = found.components;
  if (!c) return 'it has no frame header to check its colour model against';
  if (c.length !== 1 && c.length !== 3) return `it has ${c.length} colour components, and JFIF is for 1 or 3`;
  if (c.length === 3 && c[0] === 0x52 && c[1] === 0x47 && c[2] === 0x42) {
    return 'its components are labelled R, G, B, and adding JFIF would make decoders read them as YCbCr';
  }
  return null;
}

const jfifSegment = (ppi) => {
  const s = Buffer.alloc(18);
  s.writeUInt16BE(0xffe0, 0);
  s.writeUInt16BE(16, 2);
  s.write('JFIF\0', 4, 'latin1');
  s[9] = 1; // version 1.01
  s[10] = 1;
  s[11] = 1; // units: pixels per inch
  s.writeUInt16BE(ppi, 12);
  s.writeUInt16BE(ppi, 14);
  return s;
};

/**
 * Rewrite a JPEG's density header fields to `ppi` pixels per inch, leaving the
 * image data byte-for-byte alone.
 *
 * Checks the header segments only; whether the compressed data itself is
 * complete is for the caller to confirm (the CLI decodes the file once).
 *
 * @param {Buffer|Uint8Array} input
 * @param {number|string} ppi  whole number, 1-65535
 * @returns {{ data: Buffer, patched: string[], unpatched: string[] }}
 *   `patched` names what was written ('JFIF', 'EXIF', 'JFIF (inserted)');
 *   `unpatched` names density-bearing fields present but not rewritten.
 * @throws {DensityError} not a JPEG, a damaged header, or no way to carry a density
 */
export function patchJpegDensity(input, ppi) {
  const n = parsePpi(ppi, 'ppi');
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const found = scanJpeg(src);
  const patched = [];
  let out = Buffer.from(src); // a copy: the caller's buffer is never modified

  if (found.jfif != null) {
    out[found.jfif + 2] = 1; // units: per inch
    out.writeUInt16BE(n, found.jfif + 3); // Xdensity
    out.writeUInt16BE(n, found.jfif + 5); // Ydensity
    patched.push('JFIF');
  }
  if (found.exif.length) {
    writeExif(out, found.exif, n);
    patched.push('EXIF');
  }
  if (!patched.length) {
    const why = canInsertJfif(found);
    if (why) {
      throw new DensityError(
        `no JFIF header or EXIF resolution to rewrite, and a JFIF header cannot be added: ${why}`,
        'unsupported'
      );
    }
    out = Buffer.concat([out.subarray(0, 2), jfifSegment(n), out.subarray(2)]);
    patched.push('JFIF (inserted)');
  }
  if (found.photoshop.length) {
    const shift = out.length - src.length; // 18 when a JFIF header was inserted before it
    for (const at of found.photoshop) {
      // ResolutionInfo: hRes (16.16 fixed), hResUnit (1 = per inch), widthUnit,
      // vRes, vResUnit, heightUnit. The display units are left as they are.
      out.writeUInt32BE(n * 0x10000, shift + at);
      out.writeUInt16BE(1, shift + at + 4);
      out.writeUInt32BE(n * 0x10000, shift + at + 8);
      out.writeUInt16BE(1, shift + at + 12);
    }
    patched.push('Photoshop');
  }

  const unpatched = [];
  if (found.photoshopResolution) unpatched.push('Photoshop resolution resource (APP13)');
  if (found.xmpResolution) {
    // Apple ImageIO (Preview, Finder) reads XMP before JFIF, though after EXIF.
    const still = found.xmpValue ? `still ${found.xmpValue}` : 'still the old value';
    const reader = found.exif.length ? 'programs that read XMP see it' : 'Apple ImageIO (Preview, Finder) reads XMP before JFIF';
    unpatched.push(`XMP resolution fields (${still}; ${reader})`);
  }
  return { data: out, patched, unpatched };
}

/** Write `n` per inch into EXIF IFD0 resolution fields found by scanExif. */
function writeExif(out, fields, n) {
  for (const f of fields) {
    const w16 = f.le ? 'writeUInt16LE' : 'writeUInt16BE';
    const w32 = f.le ? 'writeUInt32LE' : 'writeUInt32BE';
    if (f.kind === 'unit') out[w16](2, f.pos); // 2 = inch (the field is a SHORT left-justified in its 4 bytes)
    else {
      out[w32](n, f.pos); // numerator
      out[w32](1, f.pos + 4); // denominator
    }
  }
}

/**
 * Read back a JPEG's density fields (for reporting and tests).
 * @param {Buffer} input
 * @returns {{ jfif: {units:number,x:number,y:number}|null,
 *             exif: {x:[number,number]|null,y:[number,number]|null,unit:number|null}|null }}
 */
export function readJpegDensity(input) {
  const found = scanJpeg(input);
  const jfif = found.jfif == null ? null : {
    units: input[found.jfif + 2],
    x: input.readUInt16BE(found.jfif + 3),
    y: input.readUInt16BE(found.jfif + 5),
  };
  let exif = null;
  if (found.exif.length) {
    exif = { x: null, y: null, unit: null };
    for (const f of found.exif) {
      const r16 = f.le ? 'readUInt16LE' : 'readUInt16BE';
      const r32 = f.le ? 'readUInt32LE' : 'readUInt32BE';
      if (f.kind === 'unit') exif.unit = input[r16](f.pos);
      else exif[f.tag === TAG_XRES ? 'x' : 'y'] = [input[r32](f.pos), input[r32](f.pos + 4)];
    }
  }
  return { jfif, exif };
}

// ---------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (the PNG spec's), table built once.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function scanPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new DensityError('not a PNG: no PNG signature', 'not-png');
  }
  const chunks = [];
  let o = 8;
  while (o < buf.length) {
    if (o + 12 > buf.length) throw new DensityError('corrupt PNG: the file ends inside a chunk header', 'corrupt');
    const len = buf.readUInt32BE(o);
    const end = o + 12 + len;
    if (end > buf.length) throw new DensityError(`corrupt PNG: the chunk at byte ${o} runs past the end of the file`, 'corrupt');
    chunks.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, len });
    o = end;
  }
  if (!chunks.length || chunks[0].type !== 'IHDR') throw new DensityError('corrupt PNG: IHDR is not the first chunk', 'corrupt');
  if (chunks[chunks.length - 1].type !== 'IEND') throw new DensityError('corrupt PNG: no IEND chunk at the end', 'corrupt');
  return chunks;
}

function physChunk(ppi) {
  const ppm = Math.round(ppi / 0.0254);
  const c = Buffer.alloc(21);
  c.writeUInt32BE(9, 0);
  c.write('pHYs', 4, 'latin1');
  c.writeUInt32BE(ppm, 8);
  c.writeUInt32BE(ppm, 12);
  c[16] = 1; // unit: metre
  c.writeUInt32BE(crc32(c.subarray(4, 17)), 17);
  return c;
}

/**
 * Set a PNG's density to `ppi` by replacing (or adding) its pHYs chunk, and by
 * rewriting the IFD0 resolution in any eXIf chunk (its CRC is recomputed).
 * @param {Buffer|Uint8Array} input
 * @param {number|string} ppi
 * @returns {{ data: Buffer, patched: string[], unpatched: string[] }}
 * @throws {DensityError}
 */
export function patchPngDensity(input, ppi) {
  const n = parsePpi(ppi, 'ppi');
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const chunks = scanPng(src);
  const phys = physChunk(n);
  const have = chunks.find((c) => c.type === 'pHYs');
  let data;
  let patched;
  if (have) {
    if (have.len !== 9) throw new DensityError('corrupt PNG: pHYs chunk is not 9 bytes', 'corrupt');
    data = Buffer.from(src);
    phys.copy(data, have.start);
    patched = ['pHYs'];
  } else {
    const idat = chunks.find((c) => c.type === 'IDAT');
    if (!idat) throw new DensityError('corrupt PNG: no IDAT chunk', 'corrupt');
    data = Buffer.concat([src.subarray(0, idat.start), phys, src.subarray(idat.start)]);
    patched = ['pHYs (inserted)'];
  }
  // eXIf data is a bare TIFF header. Re-scan the result, as an insertion may
  // have moved the chunks.
  let exifPatched = false;
  for (const c of scanPng(data).filter((c) => c.type === 'eXIf')) {
    const found = { exif: [] };
    scanExif(data, c.start + 8, c.start + 8 + c.len, found, 'PNG');
    if (!found.exif.length) continue;
    writeExif(data, found.exif, n);
    data.writeUInt32BE(crc32(data.subarray(c.start + 4, c.start + 8 + c.len)), c.start + 8 + c.len);
    exifPatched = true;
  }
  if (exifPatched) patched.push('eXIf');
  return { data, patched, unpatched: [] };
}

/**
 * Read a PNG's pHYs density as pixels per inch (null when the file has no pHYs
 * or records only an aspect ratio).
 * @param {Buffer} input
 * @returns {{ x:number, y:number }|null}
 */
export function readPngDensity(input) {
  const p = scanPng(input).find((c) => c.type === 'pHYs');
  if (!p || p.len !== 9 || input[p.start + 16] !== 1) return null;
  const inch = (ppm) => Math.round(ppm * 0.0254 * 100) / 100;
  return { x: inch(input.readUInt32BE(p.start + 8)), y: inch(input.readUInt32BE(p.start + 12)) };
}

// ---------------------------------------------------------------------------

/**
 * Write a density into already-encoded output of a known format.
 * @param {Buffer} data
 * @param {string} format  sharp format name ('jpeg', 'png', ...)
 * @param {number} ppi
 * @returns {{ data: Buffer, applied: boolean, ppi: number, patched?: string[], unpatched?: string[], reason?: string }}
 *   applied:false carries a `reason`; the data is returned unchanged.
 */
export function applyDensity(data, format, ppi) {
  try {
    if (format === 'jpeg') return { ...patchJpegDensity(data, ppi), applied: true, ppi };
    if (format === 'png') return { ...patchPngDensity(data, ppi), applied: true, ppi };
  } catch (err) {
    if (!(err instanceof DensityError)) throw err;
    return { data, applied: false, ppi, reason: err.message };
  }
  return { data, applied: false, ppi, reason: `${format} output has no resolution header lithocinch can write` };
}
