// Tests for resolution (density) headers: the header-only rewrite in
// src/density.js, the `--density` option on a normal run, and the
// `lithocinch density` sub-command. Fixtures are built in the tests (sharp for
// pixels, hand-assembled bytes for the header cases sharp can't produce).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import sharp from 'sharp';

import {
  patchJpegDensity,
  patchPngDensity,
  readJpegDensity,
  readPngDensity,
  DensityError,
} from '../src/density.js';
import { resolveConfig, parsePpi } from '../src/config.js';
import { optimizeImageBuffer } from '../src/optimize.js';
import { processDirectory } from '../src/process-dir.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '' });

// ---- fixtures ---------------------------------------------------------------

/** Deterministic noisy pixels, so the JPEG has real entropy-coded data. */
async function noisy(w = 96, h = 72) {
  const px = Buffer.alloc(w * h * 3);
  let seed = 4242;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = (i * 5 + rand() * 90) & 255;
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
}

/** A plain sharp JPEG: no JFIF, no EXIF. */
const bareJpeg = async () => (await noisy()).jpeg({ quality: 90 }).toBuffer();

const splice = (jpeg, ...segments) => Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);

/** A JFIF APP0 segment, assembled by hand (independent of the code under test). */
const jfif = ({ units = 1, x = 300, y = 300 } = {}) =>
  Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, units, x >> 8, x & 255, y >> 8, y & 255, 0, 0]);

/** An EXIF APP1 with IFD0 = XResolution, YResolution, ResolutionUnit, in either byte order. */
function exif({ le = true, x = [300, 1], y = [300, 1], unit = 2, ifdOffset = 8 } = {}) {
  const w16 = (b, v, o) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b, v, o) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const entries = unit == null ? 2 : 3;
  const dataAt = 8 + 2 + entries * 12 + 4;
  const t = Buffer.alloc(dataAt + 16);
  t.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(t, 42, 2);
  w32(t, ifdOffset, 4);
  w16(t, entries, 8);
  const entry = (n, tag, type, value) => {
    const o = 10 + n * 12;
    w16(t, tag, o);
    w16(t, type, o + 2);
    w32(t, 1, o + 4);
    value(o + 8);
  };
  entry(0, 0x011a, 5, (o) => w32(t, dataAt, o));
  entry(1, 0x011b, 5, (o) => w32(t, dataAt + 8, o));
  if (unit != null) entry(2, 0x0128, 3, (o) => w16(t, unit, o));
  w32(t, x[0], dataAt); w32(t, x[1], dataAt + 4);
  w32(t, y[0], dataAt + 8); w32(t, y[1], dataAt + 12);
  const head = Buffer.from([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  head.writeUInt16BE(2 + 6 + t.length, 2);
  return Buffer.concat([head, t]);
}

/** Offset of the first start-of-scan marker, by walking segments. */
function sosOffset(b) {
  let i = 2;
  while (b[i] === 0xff && b[i + 1] !== 0xda) i += 2 + b.readUInt16BE(i + 2);
  return i;
}

const rgba = async (b) => sharp(b).ensureAlpha().raw().toBuffer();

// ---- header rewrite: the cases ----------------------------------------------

test('JFIF only: units, Xdensity and Ydensity are rewritten', async () => {
  const src = splice(await bareJpeg(), jfif({ units: 0, x: 1, y: 1 })); // units 0 = aspect ratio only
  const out = patchJpegDensity(src, 72);
  assert.deepEqual(out.patched, ['JFIF']);
  assert.deepEqual(readJpegDensity(out.data), { jfif: { units: 1, x: 72, y: 72 }, exif: null });
  assert.equal(out.data.length, src.length);
});

for (const le of [true, false]) {
  test(`EXIF only, ${le ? 'little' : 'big'}-endian: rational values and the unit are rewritten, no JFIF is added`, async () => {
    // Stored as 3000000/10000 ppcm-style rationals with the unit set to centimetres:
    // writing a bare 72 without fixing the unit would claim 72 per centimetre.
    const src = splice(await bareJpeg(), exif({ le, x: [3000000, 10000], y: [2400000, 10000], unit: 3 }));
    const out = patchJpegDensity(src, 72);
    assert.deepEqual(out.patched, ['EXIF']);
    assert.deepEqual(readJpegDensity(out.data), { jfif: null, exif: { x: [72, 1], y: [72, 1], unit: 2 } });
    assert.equal(out.data.length, src.length);
  });
}

test('both JFIF and EXIF are rewritten, and the input buffer is not modified', async () => {
  const src = splice(await bareJpeg(), jfif(), exif({ unit: 2 }));
  const copy = Buffer.from(src);
  const out = patchJpegDensity(src, 150);
  assert.deepEqual(out.patched, ['JFIF', 'EXIF']);
  const back = readJpegDensity(out.data);
  assert.deepEqual(back.jfif, { units: 1, x: 150, y: 150 });
  assert.deepEqual(back.exif, { x: [150, 1], y: [150, 1], unit: 2 });
  assert.ok(src.equals(copy));
});

test('neither header: an 18-byte JFIF is inserted after SOI', async () => {
  const src = await bareJpeg();
  const out = patchJpegDensity(src, 72);
  assert.deepEqual(out.patched, ['JFIF (inserted)']);
  assert.equal(out.data.length, src.length + 18);
  assert.deepEqual(readJpegDensity(out.data).jfif, { units: 1, x: 72, y: 72 });
  assert.ok(out.data.subarray(20).equals(src.subarray(2)), 'everything after the inserted segment is the original');
});

test('neither header, and JFIF could change the colours: refused', async () => {
  const bare = await bareJpeg();
  const adobe = splice(bare, Buffer.from([0xff, 0xee, 0, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]));
  assert.throws(() => patchJpegDensity(adobe, 72), (e) => e instanceof DensityError && e.code === 'unsupported' && /Adobe/.test(e.message));
  const rgbLabelled = Buffer.from(bare);
  const sof = rgbLabelled.indexOf(Buffer.from([0xff, 0xc0])) + 10; // first component id
  rgbLabelled.set([0x52, rgbLabelled[sof + 1], rgbLabelled[sof + 2], 0x47, rgbLabelled[sof + 4], rgbLabelled[sof + 5], 0x42], sof);
  assert.throws(() => patchJpegDensity(rgbLabelled, 72), (e) => e instanceof DensityError && /R, G, B/.test(e.message));
});

/** A JPEG segment: marker, length, payload. */
const seg = (marker, payload) => {
  const b = Buffer.alloc(4 + payload.length);
  b[0] = 0xff;
  b[1] = marker;
  b.writeUInt16BE(2 + payload.length, 2);
  payload.copy(b, 4);
  return b;
};

/**
 * A Photoshop APP13 whose 0x03ED ResolutionInfo (300 ppi, display units cm)
 * follows another resource, so finding it depends on walking the 8BIM list
 * (Pascal names padded to an even length, data padded to even).
 */
function app13({ ppi = 300, name = '' } = {}) {
  const res = (id, nm, data) => {
    const pascal = Buffer.concat([Buffer.from([nm.length]), Buffer.from(nm, 'latin1')]);
    const padded = pascal.length % 2 ? Buffer.concat([pascal, Buffer.alloc(1)]) : pascal;
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = data.length % 2 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
    return Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([id >> 8, id & 255]), padded, size, body]);
  };
  const ri = Buffer.alloc(16);
  ri.writeUInt32BE(ppi * 65536, 0); ri.writeUInt16BE(1, 4); ri.writeUInt16BE(2, 6);
  ri.writeUInt32BE(ppi * 65536, 8); ri.writeUInt16BE(1, 12); ri.writeUInt16BE(2, 14);
  return seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res(0x0404, '', Buffer.alloc(5, 7)), res(0x03ed, name, ri)]));
}

/** Read the 0x03ED record back by searching for it (independent of the code under test). */
function readApp13(b) {
  const at = b.indexOf(Buffer.from([0x38, 0x42, 0x49, 0x4d, 0x03, 0xed])); // "8BIM" 0x03ED
  const nameLen = b[at + 6];
  const data = at + 6 + 1 + nameLen + ((1 + nameLen) % 2) + 4;
  return [b.readUInt32BE(data) / 65536, b.readUInt16BE(data + 4), b.readUInt16BE(data + 6), b.readUInt32BE(data + 8) / 65536, b.readUInt16BE(data + 12), b.readUInt16BE(data + 14)];
}

/** An XMP APP1 stating 300 ppi the way Photoshop writes it. */
const xmp = (ppi = 300) =>
  seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:XResolution="${ppi * 10000}/10000" tiff:YResolution="${ppi * 10000}/10000" tiff:ResolutionUnit="2"/></rdf:RDF></x:xmpmeta>`, 'latin1'));

test('Photoshop resolution resource (APP13 0x03ED) is rewritten in place, after a walk of the 8BIM list', async () => {
  for (const name of ['', 'x', 'ab']) {
    const src = splice(await bareJpeg(), jfif(), app13({ name }));
    assert.deepEqual(readApp13(src), [300, 1, 2, 300, 1, 2]);
    const out = patchJpegDensity(src, 72);
    assert.deepEqual(out.patched, ['JFIF', 'Photoshop'], `name "${name}"`);
    assert.deepEqual(out.unpatched, []);
    assert.equal(out.data.length, src.length);
    assert.deepEqual(readApp13(out.data), [72, 1, 2, 72, 1, 2], `name "${name}": display units are kept`);
  }
  // APP13 alone: a JFIF header is inserted in front of it, and the record still lands.
  const only = patchJpegDensity(splice(await bareJpeg(), app13()), 150);
  assert.deepEqual(only.patched, ['JFIF (inserted)', 'Photoshop']);
  assert.deepEqual(readApp13(only.data), [150, 1, 2, 150, 1, 2]);
  assert.deepEqual(readJpegDensity(only.data).jfif, { units: 1, x: 150, y: 150 });
});

test('XMP that cannot be rewritten in place (no padding) is refused; with allowStaleXmp it is reported with its value and who still reads it', async () => {
  const noPadding = splice(await bareJpeg(), xmp());
  assert.throws(() => patchJpegDensity(noPadding, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /still 300 ppi\): no packet padding/.test(e.message));
  const stale = { allowStaleXmp: true };
  const xmpOnly = patchJpegDensity(splice(await bareJpeg(), xmp()), 72, stale);
  assert.equal(xmpOnly.unpatched.length, 1);
  assert.match(xmpOnly.unpatched[0], /^XMP resolution fields \(still 300 ppi; Apple ImageIO \(Preview, Finder\) reads XMP before JFIF\)$/);
  const withExif = patchJpegDensity(splice(await bareJpeg(), jfif(), exif(), xmp(240)), 72, stale);
  assert.match(withExif.unpatched[0], /still 240 ppi; programs that read XMP see it/);
  const element = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<tiff:XResolution>3000000/10000</tiff:XResolution>', 'latin1'));
  assert.match(patchJpegDensity(splice(await bareJpeg(), jfif(), element), 72, stale).unpatched[0], /still 300 ppi/);
});

// ---- XMP rewritten in place ---------------------------------------------------

const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';

/**
 * A Photoshop-style XMP APP1: the <?xpacket?> wrapper, the given attributes
 * and elements on one rdf:Description, then `pad` bytes of trailing padding.
 */
const xmpPacket = ({ attrs = '', elements = '', pad = 2048 } = {}) =>
  seg(0xe1, Buffer.from(
    XMP_HEAD +
      `<?xpacket begin="${String.fromCharCode(0xef, 0xbb, 0xbf)}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      `<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/"${attrs}>${elements}</rdf:Description>` +
      `</rdf:RDF></x:xmpmeta>\n${' '.repeat(pad)}\n<?xpacket end="w"?>`,
    'latin1'
  ));

/** The XMP packet of a JPEG, found by plain search (independent of the code under test). */
function xmpBack(b) {
  const head = b.indexOf(XMP_HEAD);
  const segLen = b.readUInt16BE(head - 2);
  const start = head + XMP_HEAD.length;
  const end = head - 2 + segLen;
  const xml = b.toString('latin1', start, end);
  const get = (q) => {
    const m = new RegExp(`[ \\n]${q}="([^"]*)"|<${q}>([^<]*)</${q}>`).exec(xml);
    return m ? m[1] ?? m[2] : null;
  };
  const padding = /([ \n]*)<\?xpacket end=/.exec(xml)[1].length;
  return { segAt: head - 4, segLen, start, end, xml, padding, x: get('tiff:XResolution'), y: get('tiff:YResolution'), unit: get('tiff:ResolutionUnit'), get };
}

/** Every byte that differs between two equal-length buffers lies inside [from, to). */
const changedOnlyIn = (a, b, from, to) => [...a.keys()].every((i) => a[i] === b[i] || (i >= from && i < to));

test('XMP attribute form, rational: rewritten to n/1, unit inch, the padding grows by what the values shrank, nothing else moves', async () => {
  const bare = await bareJpeg();
  const attrs = ' tiff:XResolution="3000000/10000" tiff:YResolution="3000000/10000" tiff:ResolutionUnit="3" exif:FocalPlaneXResolution="1234/1"';
  const src = splice(bare, jfif(), xmpPacket({ attrs }));
  const out = patchJpegDensity(src, 72);
  assert.deepEqual(out.patched, ['JFIF', 'XMP']);
  assert.deepEqual(out.unpatched, []);
  assert.equal(out.data.length, src.length);
  const before = xmpBack(src);
  const after = xmpBack(out.data);
  assert.deepEqual([after.x, after.y, after.unit], ['72/1', '72/1', '2']);
  assert.equal(after.get('exif:FocalPlaneXResolution'), '1234/1', 'a longer name that ends in XResolution is not touched');
  assert.equal(after.segLen, before.segLen, 'the segment length bytes are unchanged');
  assert.equal(after.padding, before.padding + 18, 'two values 9 bytes shorter: 18 more bytes of padding');
  // Outside the packet only the JFIF fields change; inside it, nothing before the first value.
  const firstValue = src.indexOf('3000000/10000');
  const jfifAt = src.indexOf(Buffer.from('JFIF\0', 'latin1'));
  const outside = [...src.keys()].filter((i) => (i < before.start || i >= before.end) && src[i] !== out.data[i]);
  assert.ok(outside.every((i) => i >= jfifAt + 7 && i < jfifAt + 12), `bytes outside the packet changed: ${outside}`);
  assert.ok(changedOnlyIn(src.subarray(before.start, before.end), out.data.subarray(before.start, before.end), firstValue - before.start, before.end - before.start));
  assert.ok((await rgba(src)).equals(await rgba(out.data)), 'decoded pixels differ');
  assert.deepEqual(readJpegDensity(out.data).xmp, { x: '72/1', y: '72/1', unit: '2' });
});

test('XMP element form, integer: rewritten as an integer, and a longer value takes its bytes from the padding', async () => {
  const elements = '<tiff:XResolution>300</tiff:XResolution><tiff:YResolution>300</tiff:YResolution><tiff:ResolutionUnit>2</tiff:ResolutionUnit>';
  const src = splice(await bareJpeg(), xmpPacket({ elements }));
  const down = patchJpegDensity(src, 72);
  assert.deepEqual(down.patched, ['JFIF (inserted)', 'XMP']);
  const d = xmpBack(down.data);
  assert.deepEqual([d.x, d.y, d.unit], ['72', '72', '2']);
  assert.equal(d.padding, xmpBack(src).padding + 2);
  const up = patchJpegDensity(src, 1200);
  const u = xmpBack(up.data);
  assert.deepEqual([u.x, u.y], ['1200', '1200']);
  assert.equal(u.padding, xmpBack(src).padding - 2);
  assert.equal(u.segLen, xmpBack(src).segLen);
  assert.ok((await rgba(src)).equals(await rgba(up.data)), 'decoded pixels differ');
});

test('XMP under the exif: prefix is rewritten too', async () => {
  const src = splice(await bareJpeg(), jfif(), xmpPacket({ attrs: ' exif:XResolution="300/1" exif:YResolution="300/1"' }));
  const back = xmpBack(patchJpegDensity(src, 72).data);
  assert.deepEqual([back.get('exif:XResolution'), back.get('exif:YResolution')], ['72/1', '72/1']);
});

test('XMP without padding for a longer value is refused, at the exact boundary', async () => {
  const attrs = ' tiff:XResolution="300/1" tiff:YResolution="300/1"'; // 1200/1 is 2 bytes longer in all
  const tooSmall = splice(await bareJpeg(), jfif(), seg(0xe1, Buffer.from(`${XMP_HEAD}<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description${attrs}/></rdf:RDF></x:xmpmeta> <?xpacket end="w"?>`, 'latin1')));
  assert.throws(() => patchJpegDensity(tooSmall, 1200), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /need 2 more bytes than the packet's padding holds \(1\)/.test(e.message));
  const exact = splice(await bareJpeg(), jfif(), seg(0xe1, Buffer.from(`${XMP_HEAD}<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description${attrs}/></rdf:RDF></x:xmpmeta>  <?xpacket end="w"?>`, 'latin1')));
  const ok = patchJpegDensity(exact, 1200);
  assert.ok(ok.patched.includes('XMP'));
  assert.ok(ok.data.toString('latin1').includes('tiff:YResolution="1200/1"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'), 'all of the padding was used');
  // With allowStaleXmp the file is written with the old XMP and reported.
  const stale = patchJpegDensity(tooSmall, 1200, { allowStaleXmp: true });
  assert.deepEqual(stale.patched, ['JFIF']);
  assert.match(stale.unpatched[0], /^XMP resolution fields \(still 300 ppi;/);
  assert.ok(stale.data.subarray(stale.data.indexOf(XMP_HEAD)).equals(tooSmall.subarray(tooSmall.indexOf(XMP_HEAD))), 'the XMP is left exactly as it was');
});

test('XMP forms a narrow rewrite cannot handle safely are refused, never half-edited', async () => {
  for (const [label, props] of [
    ['element with attributes', { elements: '<tiff:XResolution rdf:datatype="x">300/1</tiff:XResolution>' }],
    ['decimal value', { attrs: ' tiff:XResolution="300.5"' }],
    ['entity in the value', { attrs: ' tiff:XResolution="&#51;00/1"' }],
    ['rational unit', { attrs: ' tiff:ResolutionUnit="2/1"' }],
    ['nested markup', { elements: '<tiff:XResolution><rdf:Alt>300/1</rdf:Alt></tiff:XResolution>' }],
    ['mismatched closing tag', { elements: '<tiff:XResolution>300/1</tiff:YResolution>' }],
    ['an element left open elsewhere in the packet', { attrs: ' tiff:XResolution="300/1"', elements: '<rdf:li>' }],
  ]) {
    const src = splice(await bareJpeg(), jfif(), xmpPacket(props));
    assert.throws(() => patchJpegDensity(src, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp', label);
    const stale = patchJpegDensity(src, 72, { allowStaleXmp: true });
    assert.equal(stale.unpatched.length, 1, label);
    const xmpAt = src.indexOf(XMP_HEAD);
    assert.ok(stale.data.subarray(xmpAt).equals(src.subarray(xmpAt)), `${label}: the packet is untouched`);
  }
  // A packet that only mentions other resolution-like names needs nothing.
  const other = patchJpegDensity(splice(await bareJpeg(), jfif(), xmpPacket({ attrs: ' exif:FocalPlaneXResolution="1234/1"' })), 72);
  assert.deepEqual([other.patched, other.unpatched], [['JFIF'], []]);
});

test('Extended XMP (a packet split over several APP1 segments) is refused', async () => {
  const ext = (xml) => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1'), Buffer.from('0123456789ABCDEF0123456789ABCDEF', 'latin1'), Buffer.from([0, 0, 0, xml.length, 0, 0, 0, 0]), Buffer.from(xml, 'latin1')]));
  const main = xmpPacket({ attrs: ' tiff:XResolution="300/1" xmpNote:HasExtendedXMP="0123456789ABCDEF0123456789ABCDEF"' });
  const src = splice(await bareJpeg(), jfif(), main, ext('<x:xmpmeta><rdf:RDF><rdf:Description photoshop:History="..."/></rdf:RDF></x:xmpmeta>'));
  assert.throws(() => patchJpegDensity(src, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /Extended XMP/.test(e.message));
  // The resolution only in the extension: refused as well.
  const inExt = splice(await bareJpeg(), jfif(), xmpPacket(), ext('<rdf:Description tiff:XResolution="300/1"/>'));
  assert.throws(() => patchJpegDensity(inExt, 72), (e) => e.code === 'stale-xmp');
  assert.match(patchJpegDensity(src, 72, { allowStaleXmp: true }).unpatched[0], /^XMP resolution fields \(still 300 ppi/);
});

test('a UTF-16 XMP packet (LE or BE) naming a resolution is refused, never written as if it held none', async () => {
  const text = xmpPacket({ attrs: ' tiff:XResolution="300/1" tiff:YResolution="300/1"' }).subarray(4 + XMP_HEAD.length).toString('latin1');
  const le = Buffer.from(text, 'utf16le');
  for (const [label, body] of [['LE', le], ['BE', Buffer.from(le).swap16()], ['LE with a byte-order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), le])]]) {
    const src = splice(await bareJpeg(), jfif({ x: 72, y: 72 }), seg(0xe1, Buffer.concat([Buffer.from(XMP_HEAD, 'latin1'), body])));
    assert.throws(() => patchJpegDensity(src, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /still 300 ppi\): the packet is UTF-16/.test(e.message), label);
    assert.match(patchJpegDensity(src, 72, { allowStaleXmp: true }).unpatched[0], /^XMP resolution fields \(still 300 ppi;/, label);
  }
  // A UTF-16 packet with no resolution in it needs nothing.
  const other = Buffer.from(xmpPacket({ attrs: ' exif:FocalPlaneXResolution="1/1"' }).subarray(4 + XMP_HEAD.length).toString('latin1'), 'utf16le');
  assert.deepEqual(patchJpegDensity(splice(await bareJpeg(), jfif(), seg(0xe1, Buffer.concat([Buffer.from(XMP_HEAD, 'latin1'), other]))), 72).patched, ['JFIF']);
});

test('an unprefixed (default-namespace) resolution property is refused', async () => {
  for (const elements of ['<XResolution xmlns="http://ns.adobe.com/tiff/1.0/">300/1</XResolution>', '<rdf:Description xmlns="http://ns.adobe.com/tiff/1.0/" XResolution="300/1"/>']) {
    const src = splice(await bareJpeg(), jfif({ x: 72, y: 72 }), xmpPacket({ elements }));
    assert.throws(() => patchJpegDensity(src, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /XResolution has no namespace prefix/.test(e.message), elements);
  }
});

test('ResolutionUnit stored as a word (Inch, Centimeter) is rewritten as Inch, as an element or an attribute', async () => {
  // The element trio a real writer emits, already 72 everywhere.
  const elements = '<exif:XResolution>72</exif:XResolution><exif:YResolution>72</exif:YResolution><exif:ResolutionUnit>Inch</exif:ResolutionUnit>';
  const src = splice(await bareJpeg(), jfif({ x: 72, y: 72 }), exif({ x: [72, 1], y: [72, 1] }), xmpPacket({ elements }));
  for (const ppi of [72, 300]) {
    const out = patchJpegDensity(src, ppi);
    assert.deepEqual(out.patched, ['JFIF', 'EXIF', 'XMP'], `${ppi}`);
    const back = xmpBack(out.data);
    assert.deepEqual([back.get('exif:XResolution'), back.get('exif:YResolution'), back.get('exif:ResolutionUnit')], [String(ppi), String(ppi), 'Inch']);
    assert.equal(back.segLen, xmpBack(src).segLen);
  }
  // Centimeter, as an attribute: becomes Inch, and the 6 bytes go to the padding.
  const cm = splice(await bareJpeg(), jfif(), xmpPacket({ attrs: ' tiff:XResolution="118/1" tiff:YResolution="118/1" tiff:ResolutionUnit="centimeter"' }));
  const out = patchJpegDensity(cm, 72);
  assert.deepEqual([xmpBack(out.data).x, xmpBack(out.data).unit], ['72/1', 'Inch']);
  assert.equal(xmpBack(out.data).padding, xmpBack(cm).padding + 2 + 6);
  const readOnly = Buffer.from(cm.toString('latin1').replace('end="w"', 'end="r"'), 'latin1');
  assert.throws(() => patchJpegDensity(readOnly, 72), (e) => /still 118 per cm/.test(e.message), 'a refusal names the unit the word gave');
  // The sub-command reads it back as written.
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'x.jpg'), src);
    const r = run('density', path.join(dir, 'x.jpg'), '--ppi', '300', '-o', path.join(dir, 'out'), '--brief');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^ok set 300 ppi \(JFIF, EXIF, XMP\) {2}x\.jpg$/m);
  });
});

test('only the image’s own resolution properties are rewritten: not another attribute’s text, a comment, or a nested resource', async () => {
  const label = ' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Label="note tiff:XResolution=\'2400/1\' kept"';
  const comment = '<!-- was tiff:XResolution="2400/1" -->';
  const pantry = '<xmpMM:Pantry><rdf:Bag><rdf:li><rdf:Description xmpMM:InstanceID="placed" tiff:XResolution="2400/1" tiff:YResolution="2400/1"/></rdf:li></rdf:Bag></xmpMM:Pantry>';
  const own = ' tiff:XResolution="300/1" tiff:YResolution="300/1"';
  for (const [shape, props, kept] of [
    ['another attribute', { attrs: label + own }, "tiff:XResolution='2400/1'"],
    ['a comment', { attrs: own, elements: comment }, comment],
    ['a nested resource', { attrs: own, elements: pantry }, 'tiff:XResolution="2400/1" tiff:YResolution="2400/1"'],
  ]) {
    const src = splice(await bareJpeg(), jfif(), xmpPacket(props));
    const out = patchJpegDensity(src, 72);
    assert.deepEqual(out.patched, ['JFIF', 'XMP'], shape);
    const xml = xmpBack(out.data).xml;
    assert.ok(xml.includes(kept), `${shape}: left as it was`);
    assert.ok(xml.includes('tiff:XResolution="72/1" tiff:YResolution="72/1"'), `${shape}: the image's own values rewritten`);
    // With only the other text, there is nothing to rewrite, and XMP is not named.
    const only = patchJpegDensity(splice(await bareJpeg(), jfif(), xmpPacket({ attrs: props.attrs.replace(own, ''), elements: props.elements })), 72);
    assert.deepEqual(only.patched, ['JFIF'], `${shape} only`);
    assert.ok(xmpBack(only.data).xml.includes(kept), `${shape} only: left as it was`);
  }
  // A resolution on an element that is not an rdf:Description is not a property of the image: refused.
  const odd = splice(await bareJpeg(), jfif(), xmpPacket({ elements: '<rdf:Bag tiff:XResolution="300/1"/>' }));
  assert.throws(() => patchJpegDensity(odd, 72), (e) => e.code === 'stale-xmp');
});

test('a read-only XMP packet (end="r") is refused, not rewritten', async () => {
  const src = splice(await bareJpeg(), jfif(), Buffer.from(xmpPacket({ attrs: ' tiff:XResolution="300/1"' }).toString('latin1').replace('end="w"', 'end="r"'), 'latin1'));
  assert.throws(() => patchJpegDensity(src, 72), (e) => e instanceof DensityError && e.code === 'stale-xmp' && /read-only/.test(e.message));
  const stale = patchJpegDensity(src, 72, { allowStaleXmp: true });
  assert.ok(stale.data.subarray(stale.data.indexOf(XMP_HEAD)).equals(src.subarray(src.indexOf(XMP_HEAD))), 'the packet is untouched');
});

test('XMP rewrite edge cases: same length needs no padding, CR counts as padding, every packet is rewritten, a longer name is not a resolution', async () => {
  const bare = await bareJpeg();
  const raw = (xml) => seg(0xe1, Buffer.from(XMP_HEAD + xml, 'latin1'));
  const desc = (attrs) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description${attrs}/></rdf:RDF></x:xmpmeta>`;
  // No <?xpacket end?> at all: fine when the values keep their length (150/1 -> 300/1).
  const same = patchJpegDensity(splice(bare, jfif(), raw(desc(' tiff:XResolution="150/1"'))), 300);
  assert.deepEqual(same.patched, ['JFIF', 'XMP']);
  assert.ok(same.data.toString('latin1').includes('tiff:XResolution="300/1"/>'));
  // Padding made of CR LF pairs absorbs a longer value.
  const crlf = splice(bare, jfif(), raw(`${desc(' tiff:XResolution="300/1" tiff:YResolution="300/1"')}${'\r\n'.repeat(4)}<?xpacket end="w"?>`));
  const grown = patchJpegDensity(crlf, 1200);
  assert.ok(grown.data.toString('latin1').includes('tiff:XResolution="1200/1" tiff:YResolution="1200/1"/>'));
  assert.equal(grown.data.length, crlf.length);
  // Two packets: both are rewritten.
  const two = patchJpegDensity(splice(bare, jfif(), xmpPacket({ attrs: ' tiff:XResolution="300/1"' }), xmpPacket({ attrs: ' tiff:XResolution="240/1"' })), 72);
  const text = two.data.toString('latin1');
  assert.deepEqual([...text.matchAll(/tiff:XResolution="([^"]*)"/g)].map((m) => m[1]), ['72/1', '72/1']);
  // A name that only starts with XResolution is left alone.
  const longer = patchJpegDensity(splice(bare, jfif(), xmpPacket({ attrs: ' tiff:XResolution="300/1" foo:XResolutionNote="keep"' })), 72);
  assert.deepEqual(longer.patched, ['JFIF', 'XMP']);
  assert.equal(xmpBack(longer.data).get('foo:XResolutionNote'), 'keep');
});

test('input that is not a JPEG is refused', async () => {
  const png = await (await noisy(8, 8)).png().toBuffer();
  for (const bad of [png, Buffer.from('hello world'), Buffer.alloc(0)]) {
    assert.throws(() => patchJpegDensity(bad, 72), (e) => e instanceof DensityError && e.code === 'not-jpeg');
  }
});

test('damaged JPEG headers are refused: truncated, overrunning segment, bad EXIF offsets', async () => {
  const good = splice(await bareJpeg(), jfif(), exif());
  const corruptCode = (b) => assert.throws(() => patchJpegDensity(b, 72), (e) => e instanceof DensityError && e.code === 'corrupt', `expected a refusal for ${b.length} bytes`);
  corruptCode(good.subarray(0, 30)); // ends inside the JFIF/EXIF segments
  corruptCode(good.subarray(0, 5)); // ends inside the first segment header
  const overrun = Buffer.from(good);
  overrun.writeUInt16BE(60000, 2 + 2); // JFIF segment claims 60000 bytes
  corruptCode(overrun);
  corruptCode(splice(await bareJpeg(), exif({ ifdOffset: 5000 }))); // IFD0 outside the block
  corruptCode(Buffer.concat([Buffer.from([0xff, 0xd8, 0x12, 0x34]), Buffer.alloc(20)])); // junk where a marker belongs
});

test('damaged headers are refused with a DensityError, never patched past their bounds or thrown as a RangeError', async () => {
  const bare = await bareJpeg();
  const refused = (b, re, label) =>
    assert.throws(() => patchJpegDensity(b, 72), (e) => e instanceof DensityError && e.code === 'corrupt' && re.test(e.message), label);
  // EXIF entries, offsets as built by exif(): IFD0 at 8, entry n at 10 + 12n,
  // XResolution's value offset at 18, the rationals at 50.
  const exifWith = (edit) => {
    const e = exif();
    edit(e.subarray(10)); // the TIFF block
    return splice(bare, e);
  };
  refused(exifWith((t) => t.writeUInt32LE(5000, 18)), /points outside the block/, 'rational past the block');
  refused(exifWith((t) => t.writeUInt16LE(400, 8)), /entry table runs past/, 'IFD0 count past the block');
  refused(exifWith((t) => t.writeUInt32LE(4, 4)), /IFD0 offset is outside/, 'IFD0 inside the TIFF header');
  refused(exifWith((t) => t.writeUInt32LE(2, 14)), /does not have exactly one value/, 'two XResolution values');
  refused(exifWith((t) => t.writeUInt16LE(3, 12)), /is not a RATIONAL/, 'XResolution as a SHORT');
  refused(exifWith((t) => t.writeUInt32LE(10, 18)), /points into the TIFF header or IFD0/, 'rational inside its own entry');
  refused(exifWith((t) => t.writeUInt32LE(0, 18)), /points into the TIFF header or IFD0/, 'rational on the TIFF header');
  // An EXIF segment that claims more bytes than the file holds.
  const cut = splice(bare, exif());
  refused(cut.subarray(0, 2 + 10 + 8), /runs past the end of the file/, 'EXIF cut after its TIFF header');
  // A short JFIF segment (7 bytes, no fixed fields) is not patched into the next segment.
  refused(splice(bare, Buffer.from([0xff, 0xe0, 0, 7, 0x4a, 0x46, 0x49, 0x46, 0]), exif()), /JFIF segment is shorter/, 'short JFIF');
  // Lengths 0 and 1 are impossible; EOI before any scan is not an image.
  refused(splice(bare, Buffer.from([0xff, 0xe2, 0, 0])), /impossible length \(0\)/, 'length 0');
  refused(splice(bare, Buffer.from([0xff, 0xe2, 0, 1])), /impossible length \(1\)/, 'length 1');
  refused(splice(bare, jfif(), Buffer.from([0xff, 0xd9])), /end-of-image marker before any image data/, 'EOI first');
});

test('only the first JFIF segment is rewritten', async () => {
  const src = splice(await bareJpeg(), jfif({ x: 300, y: 300 }), jfif({ x: 200, y: 200 }));
  const out = patchJpegDensity(src, 72).data;
  // Read both segments at their fixed offsets: Xdensity at 2 + 12, then 18 bytes on.
  assert.deepEqual([out[13], out.readUInt16BE(14), out.readUInt16BE(16)], [1, 72, 72]);
  assert.ok(out.subarray(20, 38).equals(src.subarray(20, 38)), 'the second JFIF segment is untouched');
});

test('JFIF is not inserted where the colour model cannot be checked: four components, or no frame header', () => {
  const sof4 = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]));
  const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const eoi = Buffer.from([0, 0xff, 0xd9]);
  const soi = Buffer.from([0xff, 0xd8]);
  assert.throws(() => patchJpegDensity(Buffer.concat([soi, sof4, sos, eoi]), 72), (e) => e.code === 'unsupported' && /4 colour components/.test(e.message));
  assert.throws(() => patchJpegDensity(Buffer.concat([soi, sos, eoi]), 72), (e) => e.code === 'unsupported' && /no frame header/.test(e.message));
});

/** An Adobe APP14 segment: "Adobe", version 100, flags0, flags1, then the transform byte. */
const app14 = (transform) => Buffer.from([0xff, 0xee, 0, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform]);

test('Adobe APP14 transform 1 over three components (Photoshop "Save for Web") takes a JFIF header and decodes the same; every other APP14 is refused', async () => {
  const bare = await bareJpeg();
  const saveForWeb = splice(bare, app14(1));
  const out = patchJpegDensity(saveForWeb, 72);
  assert.deepEqual(out.patched, ['JFIF (inserted)']);
  assert.deepEqual(readJpegDensity(out.data).jfif, { units: 1, x: 72, y: 72 });
  assert.ok(out.data.subarray(20).equals(saveForWeb.subarray(2)), 'everything after the inserted segment is the original');
  const before = await rgba(saveForWeb);
  assert.ok(before.equals(await rgba(out.data)), 'decoded pixels differ after the JFIF insertion');
  assert.ok(before.equals(await rgba(bare)), 'transform 1 decodes as the same YCbCr as no marker at all');

  const refusedAdobe = (e) => e instanceof DensityError && e.code === 'unsupported' && /it has an Adobe APP14 marker, and adding JFIF could change how its colours decode/.test(e.message);
  const sof4 = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]));
  const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const refused = {
    'transform 0 (RGB)': splice(bare, app14(0)),
    'transform 2 (YCCK)': splice(bare, app14(2)),
    'transform 1 over four components (CMYK)': Buffer.concat([Buffer.from([0xff, 0xd8]), app14(1), sof4, sos, Buffer.from([0, 0xff, 0xd9])]),
    'a second APP14 that says transform 0': splice(bare, app14(1), app14(0)),
    'an APP14 too short to hold a transform': splice(bare, Buffer.from([0xff, 0xee, 0, 13, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0])),
    // 11 bytes past its start lies the next segment, with a 1 there that must not be read as transform 1.
    'an APP14 of "Adobe" only, then a segment with 1 where the transform would be': splice(bare, Buffer.from([0xff, 0xee, 0, 7, 0x41, 0x64, 0x6f, 0x62, 0x65]), seg(0xe5, Buffer.from([0, 0, 1, 0]))),
  };
  for (const [name, src] of Object.entries(refused)) assert.throws(() => patchJpegDensity(src, 72), refusedAdobe, name);
});

// ---- pixel identity ---------------------------------------------------------

test('pixel identity: the patched JPEG decodes to the same RGBA and every byte outside the density fields is unchanged', async () => {
  const bare = await bareJpeg();
  const cases = {
    'JFIF + big-endian EXIF': splice(bare, jfif(), exif({ le: false })),
    'EXIF only': splice(bare, exif()),
  };
  for (const [name, src] of Object.entries(cases)) {
    const { data } = patchJpegDensity(src, 72);
    assert.ok((await rgba(src)).equals(await rgba(data)), `${name}: decoded pixels differ`);
    assert.equal(data.length, src.length, name);
    const sos = sosOffset(src);
    assert.ok(data.subarray(sos).equals(src.subarray(sos)), `${name}: entropy-coded data (SOS onward) changed`);
    // Every differing byte sits in a density field: JFIF units/X/Y (5 bytes) or
    // the EXIF rationals and unit, never anywhere else in the header.
    const diffs = [...data.keys()].filter((i) => data[i] !== src[i]);
    const allowed = new Set();
    const jfifAt = src.indexOf(Buffer.from('JFIF\0', 'latin1'));
    if (jfifAt >= 0) for (let k = 7; k < 12; k++) allowed.add(jfifAt + k); // units, Xdensity, Ydensity
    const tiff = src.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6;
    for (let k = 0; k < 16; k++) allowed.add(tiff + 50 + k); // XResolution and YResolution rationals
    allowed.add(tiff + 42); // ResolutionUnit's value, left-justified in its 4 bytes
    allowed.add(tiff + 43);
    const stray = diffs.filter((i) => !allowed.has(i));
    assert.ok(diffs.length > 0 && stray.length === 0, `${name}: changed bytes outside the density fields: ${stray}`);
  }
  // Inserted JFIF: removing the 18 inserted bytes gives back the original file.
  const inserted = patchJpegDensity(bare, 300).data;
  assert.ok(Buffer.concat([inserted.subarray(0, 2), inserted.subarray(20)]).equals(bare));
  assert.ok((await rgba(bare)).equals(await rgba(inserted)), 'inserted JFIF: decoded pixels differ');
});

// ---- PNG --------------------------------------------------------------------

const pngChunks = (b) => {
  const out = [];
  for (let i = 8; i < b.length; i += 12 + b.readUInt32BE(i)) out.push({ type: b.toString('latin1', i + 4, i + 8), at: i, len: b.readUInt32BE(i) });
  return out;
};

// Every chunk's stored CRC must match one computed independently (node:zlib).
// libvips ignores a bad CRC on an ancillary chunk, so decoding alone proves nothing.
const assertPngCrcs = (b, label) => {
  for (const c of pngChunks(b)) {
    const stored = b.readUInt32BE(c.at + 8 + c.len);
    assert.equal(stored, zlib.crc32(b.subarray(c.at + 4, c.at + 8 + c.len)), `${label}: bad CRC on ${c.type}`);
  }
};

test('PNG: an existing pHYs is replaced in place (0 bytes), a missing one is inserted before IDAT (21 bytes)', async () => {
  const png = await (await noisy(40, 30)).png().toBuffer();
  assert.ok(pngChunks(png).some((c) => c.type === 'pHYs'), 'sharp writes a pHYs chunk by default');

  const replaced = patchPngDensity(png, 72);
  assert.equal(replaced.data.length, png.length);
  // pHYs counts pixels per metre, so 72 ppi is stored as 2835 (72.01 ppi back):
  // whole inches are not exactly representable, which the README says.
  const physAt = pngChunks(replaced.data).find((c) => c.type === 'pHYs').at;
  assert.equal(replaced.data.readUInt32BE(physAt + 8), 2835);
  assert.equal(Math.round(readPngDensity(replaced.data).x), 72);

  const chunks = pngChunks(png);
  const phys = chunks.find((c) => c.type === 'pHYs');
  const without = Buffer.concat([png.subarray(0, phys.at), png.subarray(phys.at + 12 + phys.len)]);
  assert.equal(readPngDensity(without), null);
  const inserted = patchPngDensity(without, 300);
  assert.equal(inserted.data.length, without.length + 21);
  assert.deepEqual(readPngDensity(inserted.data), { x: 300, y: 300 });
  const types = pngChunks(inserted.data).map((c) => c.type);
  assert.ok(types.indexOf('pHYs') < types.indexOf('IDAT'));

  // Independent checks: libvips accepts the chunk CRCs and reads the density,
  // and the pixels are the same.
  for (const [out, ppi] of [[replaced.data, 72], [inserted.data, 300]]) {
    assertPngCrcs(out, `${ppi} ppi`);
    const m = await sharp(out, { failOn: 'error' }).metadata();
    assert.equal(Math.round(m.density), ppi);
    assert.ok((await rgba(out)).equals(await rgba(png)));
  }
});

test('PNG: a non-PNG and a truncated PNG are refused', async () => {
  const png = await (await noisy(20, 20)).png().toBuffer();
  const jpeg = await bareJpeg();
  assert.throws(() => patchPngDensity(jpeg, 72), (e) => e.code === 'not-png');
  assert.throws(() => patchPngDensity(png.subarray(0, png.length - 5), 72), (e) => e instanceof DensityError && e.code === 'corrupt');
  // A pHYs chunk that is not 9 bytes is refused, not overwritten with 21 bytes.
  const phys = pngChunks(png).find((c) => c.type === 'pHYs');
  const short = Buffer.concat([png.subarray(0, phys.at), Buffer.from([0, 0, 0, 8]), png.subarray(phys.at + 4, phys.at + 16), Buffer.alloc(4), png.subarray(phys.at + 21)]);
  assert.throws(() => patchPngDensity(short, 72), (e) => e instanceof DensityError && /pHYs chunk is not 9 bytes/.test(e.message));
});

/** IFD0 XResolution, YResolution and ResolutionUnit of a bare TIFF block, read by hand. */
function tiffResolution(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  const out = {};
  for (let e = 0; e < u16(ifd); e++) {
    const at = ifd + 2 + 12 * e;
    const tag = u16(at);
    if (tag === 0x011a || tag === 0x011b) out[tag === 0x011a ? 'x' : 'y'] = [u32(u32(at + 8)), u32(u32(at + 8) + 4)];
    if (tag === 0x0128) out.unit = u16(at + 8);
  }
  return out;
}
const pngExif = (b) => pngChunks(b).filter((c) => c.type === 'eXIf').map((c) => tiffResolution(b.subarray(c.at + 8, c.at + 8 + c.len)));

test('PNG: an eXIf chunk has its resolution rewritten too, with a fresh CRC', async () => {
  const png = await (await noisy(40, 30)).withDensity(300).png().toBuffer();
  const before = pngExif(png);
  assert.equal(before.length, 1, 'sharp withDensity writes an eXIf chunk');
  assert.equal(before[0].x[0] / before[0].x[1], 300);
  const out = patchPngDensity(png, 72);
  assert.deepEqual(out.patched, ['pHYs', 'eXIf']);
  assert.deepEqual(pngExif(out.data), [{ x: [72, 1], y: [72, 1], unit: 2 }]);
  assertPngCrcs(out.data, 'eXIf');
  assert.equal(out.data.length, png.length);
  assert.equal(Math.round((await sharp(out.data, { failOn: 'error' }).metadata()).density), 72);
  assert.ok((await rgba(out.data)).equals(await rgba(png)));
});

// ---- config -----------------------------------------------------------------

test('config: density is off by default, and validated as a whole number of ppi', () => {
  assert.equal(resolveConfig().density, null);
  assert.equal(resolveConfig({ density: '300' }).density, 300);
  for (const bad of ['72.5', '0', '-1', 'abc', '65536', '', NaN, '0x48', '1e2', '72.0', ' 72', '+72', '072', 0, -1, 72.5, 65536]) {
    assert.throws(() => resolveConfig({ density: bad }), /Invalid --density/, String(bad));
  }
  assert.equal(parsePpi(65535), 65535);
});

test('config: density refuses formats that cannot hold it, and narrows --format auto to jpeg/png', () => {
  for (const format of ['webp', 'avif', 'gif', 'tiff']) {
    assert.throws(() => resolveConfig({ density: 72, format }), /cannot be written to --format/, format);
  }
  assert.throws(() => resolveConfig({ density: 72, emit: ['webp'] }), /--emit/);
  assert.doesNotThrow(() => resolveConfig({ density: 72, format: 'jpeg', emit: ['png'] }));
  assert.deepEqual(resolveConfig({ density: 72, format: 'auto' }).formatPool, ['jpeg', 'png']);
  assert.throws(() => resolveConfig({ density: 72, format: 'auto', formatPool: ['avif', 'webp'] }), /needs jpeg or png/);
});

// ---- --density on a normal run ----------------------------------------------

test('optimize --density: JPEG output carries it for the cost of a JFIF header, PNG for nothing', async () => {
  const jpg = await bareJpeg();
  const png = await (await noisy()).png().toBuffer();
  const plainJpg = await optimizeImageBuffer(jpg, { maxSize: 0 });
  const denseJpg = await optimizeImageBuffer(jpg, { maxSize: 0, density: 300 });
  assert.deepEqual(readJpegDensity(denseJpg.data).jfif, { units: 1, x: 300, y: 300 });
  assert.equal(denseJpg.data.length - plainJpg.data.length, 18);
  assert.equal(denseJpg.info.size, denseJpg.data.length);
  assert.equal(denseJpg.density.applied, true);
  assert.ok((await rgba(denseJpg.data)).equals(await rgba(plainJpg.data)), 'density changed the pixels');

  const plainPng = await optimizeImageBuffer(png, { maxSize: 0 });
  const densePng = await optimizeImageBuffer(png, { maxSize: 0, density: 300 });
  assert.deepEqual(readPngDensity(densePng.data), { x: 300, y: 300 });
  assert.equal(densePng.data.length, plainPng.data.length);

  const none = await optimizeImageBuffer(jpg, { maxSize: 0 });
  assert.equal(none.density, undefined, 'no density key when --density is off');
});

test('optimize --density: --keep-metadata EXIF resolution is rewritten too', async () => {
  const src = await (await noisy()).withMetadata({ density: 300 }).jpeg().toBuffer();
  const out = await optimizeImageBuffer(src, { maxSize: 0, keepMetadata: true, density: 72, jpegMode: 'fixed' });
  const back = readJpegDensity(out.data);
  assert.ok(out.density.applied);
  assert.ok(back.jfif || back.exif, 'some density header was written');
  for (const r of [back.exif?.x, back.exif?.y].filter(Boolean)) assert.deepEqual(r, [72, 1]);
});

test('optimize --density: a WebP kept as WebP is reported, not pretended', async () => {
  const webp = await (await noisy()).webp().toBuffer();
  const plain = await optimizeImageBuffer(webp, { maxSize: 0 });
  const out = await optimizeImageBuffer(webp, { maxSize: 0, density: 72 });
  assert.equal(out.density.applied, false);
  assert.match(out.density.reason, /webp/);
  assert.ok(out.data.equals(plain.data), 'the output is left exactly as encoded');
});

test('processDirectory --density: stats count what carries it and name what cannot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lco-density-'));
  try {
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'a.jpg'), await bareJpeg());
    await fs.writeFile(path.join(input, 'b.png'), await (await noisy()).png().toBuffer());
    await fs.writeFile(path.join(input, 'c.webp'), await (await noisy()).webp().toBuffer());
    const warnings = [];
    const stats = await processDirectory(
      { input, output: path.join(dir, 'out'), errorDir: path.join(dir, 'err'), maxSize: 0, density: 72 },
      { logger: { info() {}, warn: (m) => warnings.push(m), error() {} } }
    );
    assert.equal(stats.density.applied, 2);
    assert.equal(stats.density.notApplied, 1);
    assert.equal(stats.density.notAppliedFiles[0].file, 'c.webp');
    assert.match(warnings[0], /c\.webp: density not written/);
    assert.deepEqual(readJpegDensity(await fs.readFile(path.join(dir, 'out', 'a_lco.jpg'))).jfif, { units: 1, x: 72, y: 72 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Run processDirectory over files written into a fresh temp folder; returns stats, warnings, events and the output path. */
async function processFiles(files, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lco-density-'));
  const input = path.join(dir, 'in');
  await fs.mkdir(input);
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(input, name), bytes);
  const warnings = [];
  const events = [];
  const output = path.join(dir, 'out');
  const stats = await processDirectory(
    { input, output, errorDir: path.join(dir, 'err'), maxSize: 0, ...options },
    { logger: { info() {}, warn: (m) => warnings.push(m), error() {} }, onProgress: (e) => events.push(e) }
  );
  return { dir, output, stats, warnings, events };
}

/** A JPEG carrying an XMP 300 ppi; under --format auto the untouched original wins (passthrough). */
const xmpJpeg = async () => splice(await bareJpeg(), xmp());

test('processDirectory --density --keep-metadata --format png: the kept eXIf says the new density too', async () => {
  const src = await (await noisy()).withMetadata({ density: 300 }).jpeg().toBuffer();
  const r = await processFiles({ 'a.jpg': src }, { keepMetadata: true, format: 'png', pngEngine: 'sharp', density: 72 });
  try {
    const out = await fs.readFile(path.join(r.output, 'a_lco.png'));
    const exifs = pngExif(out);
    assert.equal(exifs.length, 1, 'the kept EXIF is an eXIf chunk');
    assert.deepEqual(exifs[0], { x: [72, 1], y: [72, 1], unit: 2 });
    assertPngCrcs(out, 'kept eXIf');
    assert.equal(Math.round(readPngDensity(out).x), 72);
    assert.equal(r.stats.density.applied, 1);
  } finally {
    await fs.rm(r.dir, { recursive: true, force: true });
  }
});

test('processDirectory --density: a passed-through original whose XMP cannot be rewritten is refused, or with allowStaleXmp warned about and counted as stale', async () => {
  const refused = await processFiles({ 'x.jpg': await xmpJpeg() }, { format: 'auto', density: 72 });
  try {
    assert.equal(refused.stats.processed, 0);
    assert.equal(refused.stats.refused, 1);
    assert.equal(refused.stats.refusedFiles[0].file, 'x.jpg');
    assert.match(refused.stats.refusedFiles[0].reason, /^XMP resolution cannot be rewritten in place \(still 300 ppi\)/);
    assert.equal(refused.stats.errors, 0, 'a refusal is not an error: nothing is copied through');
    assert.deepEqual(await fs.readdir(refused.output).catch(() => []), [], 'nothing written');
  } finally {
    await fs.rm(refused.dir, { recursive: true, force: true });
  }
  const r = await processFiles({ 'x.jpg': await xmpJpeg() }, { format: 'auto', density: 72, allowStaleXmp: true });
  try {
    assert.equal(r.events.find((e) => e.type === 'done').engine, 'passthrough', 'the fixture must be passed through');
    assert.equal(r.stats.density.applied, 0);
    assert.equal(r.stats.density.stale, 1);
    assert.deepEqual(r.stats.density.staleFiles, [{ file: 'x.jpg', output: 'x_lco.jpg', fields: ['XMP resolution fields (still 300 ppi; Apple ImageIO (Preview, Finder) reads XMP before JFIF)'] }]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^x\.jpg: density written, but not rewritten in: XMP resolution fields \(still 300 ppi/);
  } finally {
    await fs.rm(r.dir, { recursive: true, force: true });
  }
});

test('processDirectory --density --emit: a JPEG sibling whose kept XMP cannot be rewritten is refused, not written', async () => {
  // A flat JPEG the optimizer cannot shrink, so the sibling is the original, XMP and all.
  const flat = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c85028' } }).jpeg({ quality: 80 }).toBuffer();
  const r = await processFiles({ 'x.jpg': splice(flat, jfif(), xmp()) }, { format: 'png', pngEngine: 'sharp', emit: ['jpeg'], keepMetadata: true, density: 72 });
  try {
    assert.deepEqual(r.stats.refusedFiles.map((f) => [f.file, f.output]), [['x.jpg', 'x_lco.jpg']]);
    assert.match(r.stats.refusedFiles[0].reason, /^XMP resolution cannot be rewritten in place/);
    assert.equal(r.stats.emitted, 0);
    assert.deepEqual(await fs.readdir(r.output), ['x_lco.png'], 'the PNG primary is written, the JPEG sibling is not');
  } finally {
    await fs.rm(r.dir, { recursive: true, force: true });
  }
});

test('processDirectory: collisions are settled in sorted order, not discovery order, and a name known only after encoding (--format auto) is claimed when written', async () => {
  const red = await (await noisy(16, 16)).tint('#f00').png().toBuffer();
  const files = { 'b.png': await (await noisy(16, 16)).tint('#00f').png().toBuffer(), 'a/b.gif': await sharp(red).gif().toBuffer() };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lco-density-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, 'in', name)), { recursive: true });
      await fs.writeFile(path.join(dir, 'in', name), bytes);
    }
    // The glob lists b.png (top folder) before a/b.gif; sorted, a/b.gif comes first and keeps b_lco.jpg.
    const opts = { input: path.join(dir, 'in'), errorDir: path.join(dir, 'err'), flatten: true, maxSize: 0, concurrency: 1 };
    const jpeg = await processDirectory({ ...opts, output: path.join(dir, 'jpeg'), format: 'jpeg' });
    assert.deepEqual(jpeg.refusedFiles.map((f) => f.file), ['b.png']);
    const { channels } = await sharp(path.join(dir, 'jpeg', 'b_lco.jpg')).stats();
    assert.ok(channels[0].mean > channels[2].mean, 'the red a/b.gif was kept');
    // --format auto: two copies of one image in two folders, flattened, encode to the same name.
    await fs.writeFile(path.join(dir, 'in', 'a', 'b.png'), files['b.png']);
    await fs.rm(path.join(dir, 'in', 'a', 'b.gif'));
    const auto = await processDirectory({ ...opts, output: path.join(dir, 'auto'), format: 'auto', concurrency: 2 });
    assert.equal(auto.processed, 1);
    assert.equal(auto.refused, 1);
    assert.match(auto.refusedFiles[0].reason, /writes the same output: b_lco\./);
    assert.equal((await fs.readdir(path.join(dir, 'auto'))).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processDirectory --density --emit: every sibling is counted, and outputs skipped on a re-run are counted as unchecked', async () => {
  const files = { 'a.jpg': await bareJpeg() };
  const r = await processFiles(files, { density: 72, emit: ['png'] });
  try {
    assert.equal(r.stats.density.applied, 2, 'the JPEG and its PNG sibling');
    assert.equal(r.stats.emitted, 1);
    assert.equal(Math.round(readPngDensity(await fs.readFile(path.join(r.output, 'a_lco.png'))).x), 72);
    const again = await processDirectory({ input: path.join(r.dir, 'in'), output: r.output, errorDir: path.join(r.dir, 'err'), maxSize: 0, density: 150, emit: ['png'] });
    assert.equal(again.density.applied, 0);
    assert.equal(again.density.skipped, 2);
  } finally {
    await fs.rm(r.dir, { recursive: true, force: true });
  }
});

// ---- the CLI ----------------------------------------------------------------

test('lithocinch --density with a bad value or a format that cannot hold it is a usage error (exit 2)', () => {
  for (const args of [['--density', '72.5'], ['--density', '72', '--format', 'webp'], ['--density', 'abc']]) {
    const r = run('.', '--dry-run', ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^error: .*--density/m);
  }
});

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lco-density-cli-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('lithocinch --density: the summary line counts written, stale, and skipped-unchecked outputs', async () => {
  await withDir(async (dir) => {
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'a.jpg'), await bareJpeg());
    await fs.writeFile(path.join(input, 'x.jpg'), await xmpJpeg());
    const to = (o) => [input, '-o', path.join(dir, o), '--error-dir', path.join(dir, 'err'), '--max-size', '0', '-q'];
    // --format auto passes x.jpg through with its XMP, which has no padding:
    // refused (exit 1, in --json too), or with --allow-stale-xmp written but stale.
    const refused = run(...to('refused'), '--format', 'auto', '--density', '72');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(plain(refused.stderr), /^ {2}x\.jpg: not written: XMP resolution cannot be rewritten in place/m);
    assert.match(plain(refused.stderr), /^ {2}refused {3}: 1 outputs not written/m);
    const refusedJson = run(...to('refused-json'), '--format', 'auto', '--density', '72', '--json');
    assert.equal(refusedJson.status, 1);
    assert.deepEqual(JSON.parse(refusedJson.stdout).refusedFiles.map((f) => f.file), ['x.jpg']);
    // Written but stale is a warning, and exits 1 (as `lithocinch density` does for a warn), in --json too.
    const auto = run(...to('auto'), '--format', 'auto', '--density', '72', '--allow-stale-xmp');
    assert.equal(auto.status, 1, auto.stderr);
    assert.match(plain(auto.stderr), /^ {2}density {3}: 72 ppi written to 1, not written to 0, 1 written but an older value kept in another field$/m);
    const staleJson = run(...to('auto'), '--format', 'auto', '--density', '72', '--allow-stale-xmp', '--json');
    assert.equal(staleJson.status, 1);
    const json = JSON.parse(staleJson.stdout);
    assert.deepEqual(json.density.staleFiles.map((f) => f.file), ['x.jpg']);
    // Every output refused: the summary says so, not "No images found".
    await fs.mkdir(path.join(dir, 'only'));
    await fs.writeFile(path.join(dir, 'only', 'x.jpg'), await xmpJpeg());
    const allRefused = run(path.join(dir, 'only'), '-o', path.join(dir, 'only-out'), '--error-dir', path.join(dir, 'err'), '--max-size', '0', '-q', '--format', 'auto', '--density', '72');
    assert.equal(allRefused.status, 1);
    assert.doesNotMatch(allRefused.stderr, /No images found/);
    assert.match(plain(allRefused.stderr), /^ {2}refused {3}: 1 outputs not written/m);
    const lone = run(...to('lone'), '--allow-stale-xmp');
    assert.equal(lone.status, 2, 'without --density it is a usage error');
    assert.match(lone.stderr, /^error: --allow-stale-xmp needs --density$/m);
    // A re-run with another density skips the outputs that exist, and says so.
    const first = run(...to('keep'), '--density', '72', '--allow-stale-xmp');
    assert.match(plain(first.stderr), /^ {2}density {3}: 72 ppi written to 2, not written to 0$/m);
    const again = run(...to('keep'), '--density', '150', '--allow-stale-xmp');
    assert.match(plain(again.stderr), /^ {2}density {3}: 150 ppi written to 0, not written to 0, 2 skipped \(density not checked\)$/m);
  });
});

test('density sub-command: writes patched copies to the output folder, leaves the source alone, skips an existing output', async () => {
  await withDir(async (dir) => {
    const src = splice(await bareJpeg(), jfif(), exif());
    await fs.mkdir(path.join(dir, 'in/sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'in/one.jpg'), src);
    await fs.writeFile(path.join(dir, 'in/sub/two.JPEG'), src);
    const out = path.join(dir, 'out');
    const r = run('density', path.join(dir, 'in'), '--ppi', '72', '-o', out, '--json');
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.command, 'density');
    assert.equal(result.effect, 'applied');
    assert.deepEqual(result.summary, { ok: 2, warn: 0, skip: 0, refuse: 0, fail: 0 });
    for (const rel of ['one_lco.jpg', 'sub/two_lco.JPEG']) {
      const got = await fs.readFile(path.join(out, rel));
      assert.deepEqual(readJpegDensity(got).jfif, { units: 1, x: 72, y: 72 });
      assert.ok((await rgba(got)).equals(await rgba(src)));
    }
    assert.ok((await fs.readFile(path.join(dir, 'in/one.jpg'))).equals(src), 'the source is untouched');

    const again = run('density', path.join(dir, 'in'), '--ppi', '72', '-o', out, '--brief');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /^skip output exists {2}one\.jpg {2}\(/m);
    assert.match(again.stdout, /summary: ok=0 warn=0 skip=2 refuse=0 fail=0/);
    const replaced = run('density', path.join(dir, 'in/one.jpg'), '--ppi', '150', '-o', out, '--overwrite', '--brief');
    assert.match(replaced.stdout, /^ok set 150 ppi \(JFIF, EXIF\) {2}one\.jpg$/m);
  });
});

test('density sub-command: --dry-run checks everything and writes nothing; --brief and --quiet are shorter views of the same items', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a.jpg'), await bareJpeg());
    const out = path.join(dir, 'out');
    const dry = run('density', path.join(dir, 'a.jpg'), '--ppi', '300', '-o', out, '--dry-run', '--brief');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^ok would set 300 ppi \(JFIF \(inserted\), \+18 bytes\) {2}a\.jpg$/m);
    assert.match(dry.stdout, /\(dry run: nothing written\)/);
    await assert.rejects(fs.access(out), 'a dry run creates no output folder');
    const quiet = run('density', path.join(dir, 'a.jpg'), '--ppi', '300', '-o', out, '--dry-run', '-q');
    assert.equal(quiet.stdout.trim().split('\n').length, 1);
    const human = run('density', path.join(dir, 'a.jpg'), '--ppi', '300', '-o', out, '--dry-run');
    assert.ok(human.stdout.split('\n').length > dry.stdout.split('\n').length, 'human is longer than brief');
  });
});

test('density sub-command: refuses a non-JPEG, a missing path and a cut-off file; writes nothing for them; exit 1', async () => {
  await withDir(async (dir) => {
    const good = await bareJpeg();
    // Large enough that cutting 10% off lands inside the image data, past a valid header.
    const big = await (await noisy(400, 300)).jpeg({ quality: 90 }).toBuffer();
    await fs.writeFile(path.join(dir, 'cut.jpg'), big.subarray(0, Math.floor(big.length * 0.9)));
    await fs.writeFile(path.join(dir, 'fake.jpg'), await (await noisy(8, 8)).png().toBuffer());
    await fs.writeFile(path.join(dir, 'good.jpg'), good);
    const out = path.join(dir, 'out');
    const r = run('density', ...['cut.jpg', 'fake.jpg', 'gone.jpg', 'good.jpg'].map((f) => path.join(dir, f)), '--ppi', '72', '-o', out, '--brief');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^refuse damaged JPEG {2}cut\.jpg {2}\(.*premature end/m);
    assert.match(r.stdout, /^refuse not a JPEG {2}fake\.jpg/m);
    assert.match(r.stdout, /^refuse no such path {2}.*gone\.jpg/m);
    assert.match(r.stdout, /^ok set 72 ppi .*good\.jpg$/m);
    assert.deepEqual((await fs.readdir(out)).sort(), ['good_lco.jpg'], 'only the good file was written');
  });
});

test('density sub-command: a failed write leaves no temporary or partial file', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a.jpg'), await bareJpeg());
    const out = path.join(dir, 'out');
    await fs.mkdir(path.join(out, 'a_lco.jpg'), { recursive: true }); // the destination is a directory: the rename must fail
    const r = run('density', path.join(dir, 'a.jpg'), '--ppi', '72', '-o', out, '--overwrite', '--brief');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail could not write {2}a\.jpg/m);
    assert.deepEqual(await fs.readdir(out), ['a_lco.jpg'], 'no .tmp file is left behind');
  });
});

test('density sub-command: -o <folder> --suffix "" --overwrite rewrites a file where it is', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'a.jpg');
    const src = splice(await bareJpeg(), jfif());
    await fs.writeFile(file, src);
    const r = run('density', file, '--ppi', '72', '-o', dir, '--suffix', '', '--overwrite', '--brief');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const now = await fs.readFile(file);
    assert.deepEqual(readJpegDensity(now).jfif, { units: 1, x: 72, y: 72 });
    assert.equal(now.length, src.length);
    assert.deepEqual(await fs.readdir(dir), ['a.jpg']);
  });
});

test('density sub-command: usage errors exit 2 with a one-line message and nothing on stdout', () => {
  for (const args of [
    ['density', 'a.jpg'], // no --ppi
    ['density', 'a.jpg', '--ppi', '72.5'],
    ['density', '--ppi', '72'], // no files
    ['density', 'a.jpg', '--ppi', '72', '--json', '--brief'],
    ['density', 'a.jpg', '--ppi', '72', '--bogus'],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  }
  const help = run('density', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: lithocinch density/);
});

test('density sub-command: XMP that cannot be rewritten is refused; with --allow-stale-xmp it is written as a warn; both exit 1', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'x.jpg'), splice(await bareJpeg(), xmp()));
    await fs.writeFile(path.join(dir, 'p.jpg'), splice(await bareJpeg(), jfif(), app13()));
    const out = path.join(dir, 'out');
    const refused = run('density', path.join(dir, 'x.jpg'), '--ppi', '72', '-o', path.join(dir, 'refused'), '--brief');
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /^refuse XMP not rewritable {2}x\.jpg {2}\(XMP resolution cannot be rewritten in place \(still 300 ppi\): no packet padding/m);
    assert.match(JSON.parse(run('density', path.join(dir, 'x.jpg'), '--ppi', '72', '-o', path.join(dir, 'refused'), '--json').stdout).items[0].reason, /; --allow-stale-xmp writes it anyway$/);
    await assert.rejects(fs.access(path.join(dir, 'refused', 'x_lco.jpg')), 'a refused file is not written');
    const r = run('density', path.join(dir, 'x.jpg'), path.join(dir, 'p.jpg'), '--ppi', '72', '-o', out, '--brief', '--allow-stale-xmp');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^warn set 72 ppi \(JFIF \(inserted\), \+18 bytes\) {2}x\.jpg {2}\(also present and not rewritten: XMP resolution fields \(still 300 ppi; Apple ImageIO \(Preview, Finder\) reads XMP before JFIF\)\)$/m);
    assert.match(r.stdout, /^ok set 72 ppi \(JFIF, Photoshop\) {2}p\.jpg$/m);
    assert.match(r.stdout, /summary: ok=1 warn=1 skip=0 refuse=0 fail=0/);
    assert.deepEqual(readApp13(await fs.readFile(path.join(out, 'p_lco.jpg'))), [72, 1, 2, 72, 1, 2]);
    await fs.access(path.join(out, 'x_lco.jpg'));
  });
});

test('density sub-command: two inputs that would write the same output are refused, not overwritten', async () => {
  await withDir(async (dir) => {
    for (const d of ['a', 'b']) {
      await fs.mkdir(path.join(dir, d));
      await fs.writeFile(path.join(dir, d, 'same.jpg'), await bareJpeg());
    }
    const r = run('density', path.join(dir, 'a/same.jpg'), path.join(dir, 'b/same.jpg'), '--ppi', '72', '-o', path.join(dir, 'out'), '--json');
    assert.equal(r.status, 1);
    const items = JSON.parse(r.stdout).items;
    assert.deepEqual(items.map((it) => [it.verdict, it.name]), [['ok', 'same.jpg'], ['refuse', 'same.jpg']]);
    assert.equal(items[1].summary, 'output collides');
    assert.equal(items[1].reason, `would write the same output as ${path.join(dir, 'a/same.jpg')}: ${path.join(dir, 'out', 'same_lco.jpg')}`);
  });
});

test('density sub-command: outputs that differ only in case or Unicode normalization collide where the volume treats them as one file', async () => {
  await withDir(async (dir) => {
    const flat = (c) => sharp({ create: { width: 16, height: 16, channels: 3, background: c } }).jpeg().toBuffer();
    const nfc = 'Café.jpg';
    const nfd = 'café.jpg';
    for (const d of ['a', 'b']) await fs.mkdir(path.join(dir, d));
    await fs.writeFile(path.join(dir, 'a/Same.jpg'), await flat('#c00'));
    await fs.writeFile(path.join(dir, 'b/same.jpg'), await flat('#00c'));
    await fs.writeFile(path.join(dir, 'a', nfc), await flat('#c00'));
    await fs.writeFile(path.join(dir, 'b', nfd), await flat('#00c'));
    // Full case fold (APFS): ß ~ ss, micro sign ~ Greek mu.
    const folds = [['Straße.jpg', 'Strasse.jpg'], ['µ.jpg', 'μ.jpg']];
    for (const [a, b] of folds) {
      await fs.writeFile(path.join(dir, 'a', a), await flat('#c00'));
      await fs.writeFile(path.join(dir, 'b', b), await flat('#00c'));
    }
    // Ask the volume itself, independently of the code under test.
    const caseBlind = await fs.access(path.join(dir, 'a/SAME.JPG')).then(() => true, () => false);
    const formBlind = caseBlind && (await fs.access(path.join(dir, 'a', nfd)).then(() => true, () => false));
    const foldBlind = await Promise.all(folds.map(([, b]) => fs.access(path.join(dir, 'a', b)).then(() => true, () => false)));
    const out = path.join(dir, 'out');
    const args = ['a/Same.jpg', 'b/same.jpg', `a/${nfc}`, `b/${nfd}`, ...folds.flatMap(([a, b]) => [`a/${a}`, `b/${b}`])].map((f) => path.join(dir, f));
    const r = run('density', ...args, '--ppi', '72', '-o', out, '--json');
    const items = JSON.parse(r.stdout).items;
    const red = async (f) => {
      const [rr, , bb] = (await sharp(path.join(out, f)).stats()).channels.map((c) => c.mean);
      return rr > bb;
    };
    if (caseBlind) {
      assert.deepEqual(items.slice(0, 2).map((it) => it.verdict), ['ok', 'refuse']);
      assert.equal(items[1].summary, 'output collides');
      assert.ok(await red('Same_lco.jpg'), 'the first file (red) keeps the output');
      assert.equal(r.status, 1);
    } else {
      assert.deepEqual(items.slice(0, 2).map((it) => it.verdict), ['ok', 'ok']);
    }
    if (formBlind) {
      assert.deepEqual(items.slice(2, 4).map((it) => it.verdict), ['ok', 'refuse']);
      assert.ok(await red('Café_lco.jpg'), 'the first file (red) keeps the output');
    }
    for (const [k, [a]] of folds.entries()) {
      const pair = items.slice(4 + 2 * k, 6 + 2 * k);
      if (foldBlind[k]) {
        assert.deepEqual(pair.map((it) => [it.verdict, it.summary]).slice(1), [['refuse', 'output collides']], a);
        assert.equal(pair[0].verdict, 'ok', a);
        assert.ok(await red(a.replace('.jpg', '_lco.jpg')), `the first file (red) keeps the output: ${a}`);
      } else if (!caseBlind) {
        assert.deepEqual(pair.map((it) => it.verdict), ['ok', 'ok'], a);
      }
    }
    if (caseBlind) assert.equal((await fs.readdir(out)).length, 4, 'one output per pair');
  });
});

test('density sub-command: the Turkish dotless ı is not folded to i, so ılık and ilik are both written where the volume keeps them apart', async () => {
  await withDir(async (dir) => {
    const flat = (c) => sharp({ create: { width: 16, height: 16, channels: 3, background: c } }).jpeg().toBuffer();
    for (const d of ['a', 'b']) await fs.mkdir(path.join(dir, d));
    await fs.writeFile(path.join(dir, 'a', 'ılık.jpg'), await flat('#c00'));
    await fs.writeFile(path.join(dir, 'b', 'ilik.jpg'), await flat('#00c'));
    // Ask the volume itself (APFS keeps them apart, case-sensitive or not).
    const apart = await fs.access(path.join(dir, 'a', 'ilik.jpg')).then(() => false, () => true);
    const out = path.join(dir, 'out');
    const r = run('density', path.join(dir, 'a', 'ılık.jpg'), path.join(dir, 'b', 'ilik.jpg'), '--ppi', '72', '-o', out, '--json');
    const items = JSON.parse(r.stdout).items;
    if (apart) {
      assert.deepEqual(items.map((it) => it.verdict), ['ok', 'ok']);
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual((await fs.readdir(out)).sort(), ['ilik_lco.jpg', 'ılık_lco.jpg']);
    } else {
      assert.deepEqual(items.map((it) => it.verdict), ['ok', 'refuse']);
    }
  });
});

test('density sub-command: ᾴ written precomposed and as ᾳ plus an acute collide where the volume ignores case (normalized before the case fold)', async () => {
  await withDir(async (dir) => {
    const flat = (c) => sharp({ create: { width: 16, height: 16, channels: 3, background: c } }).jpeg().toBuffer();
    const one = 'ᾴ.jpg'; // alpha with oxia and ypogegrammeni
    const two = 'ᾴ.jpg'; // alpha with ypogegrammeni, then a combining acute
    for (const d of ['a', 'b']) await fs.mkdir(path.join(dir, d));
    await fs.writeFile(path.join(dir, 'a', one), await flat('#c00'));
    await fs.writeFile(path.join(dir, 'b', two), await flat('#00c'));
    // Ask the volume itself, independently of the code under test.
    const caseBlind = await fs.access(path.join(dir, 'A')).then(() => true, () => false);
    const same = await fs.access(path.join(dir, 'a', two)).then(() => true, () => false);
    const out = path.join(dir, 'out');
    const r = run('density', path.join(dir, 'a', one), path.join(dir, 'b', two), '--ppi', '72', '-o', out, '--json');
    const items = JSON.parse(r.stdout).items;
    const outputs = await fs.readdir(out);
    if (caseBlind && same) {
      assert.deepEqual(items.map((it) => [it.verdict, it.summary]).slice(1), [['refuse', 'output collides']]);
      assert.equal(items[0].verdict, 'ok');
      assert.equal(outputs.length, 1);
      const [rr, , bb] = (await sharp(path.join(out, outputs[0])).stats()).channels.map((c) => c.mean);
      assert.ok(rr > bb, 'the first file (red) keeps the output');
    } else {
      assert.equal(outputs.length, items.filter((it) => it.verdict === 'ok').length, 'nothing overwritten');
    }
  });
});

test('outputs that differ only in Unicode normalization collide on case-sensitive APFS, which still ignores normalization', { skip: process.platform !== 'darwin' && 'needs macOS hdiutil to make a case-sensitive APFS disk image' }, async () => {
  await withDir(async (dir) => {
    const img = path.join(dir, 'cs.dmg');
    const mnt = path.join(dir, 'mnt');
    const hd = (...args) => spawnSync('hdiutil', args, { encoding: 'utf8' });
    // A temp folder already on a case-sensitive volume is used as it is (an image
    // cannot be attached inside one); otherwise a case-sensitive APFS image is made.
    await fs.writeFile(path.join(dir, 'probe'), '');
    const image = await fs.access(path.join(dir, 'PROBE')).then(() => true, () => false);
    if (image) {
      const made = hd('create', '-fs', 'Case-sensitive APFS', '-size', '20m', '-volname', 'lco-cs', img);
      assert.equal(made.status, 0, made.stderr);
      await fs.mkdir(mnt);
      const attached = hd('attach', '-nobrowse', '-noverify', '-mountpoint', mnt, img);
      assert.equal(attached.status, 0, attached.stderr);
    }
    try {
      // The output folder's parent is not the volume root, so the case probe asks this volume.
      const vol = path.join(image ? mnt : dir, 'vol');
      await fs.mkdir(vol);
      const flat = (c) => sharp({ create: { width: 16, height: 16, channels: 3, background: c } }).jpeg().toBuffer();
      const nfc = 'Café.jpg'.normalize('NFC');
      const nfd = 'Café.jpg'.normalize('NFD');
      // Ask the volume itself: case-sensitive, normalization-insensitive.
      await fs.writeFile(path.join(vol, nfc), '');
      assert.equal(await fs.access(path.join(vol, 'CAFÉ.JPG'.normalize('NFC'))).then(() => true, () => false), false, 'case-sensitive');
      assert.equal(await fs.access(path.join(vol, nfd)).then(() => true, () => false), true, 'normalization-insensitive');
      await fs.rm(path.join(vol, nfc));
      for (const d of ['a', 'b']) await fs.mkdir(path.join(dir, d));
      await fs.writeFile(path.join(dir, 'a', nfc), await flat('#c00'));
      await fs.writeFile(path.join(dir, 'b', nfd), await flat('#00c'));
      const out = path.join(vol, 'out');
      const r = run('density', path.join(dir, 'a', nfc), path.join(dir, 'b', nfd), '--ppi', '72', '-o', out, '--json');
      assert.equal(r.status, 1, r.stdout);
      const items = JSON.parse(r.stdout).items;
      assert.deepEqual(items.map((it) => [it.verdict, it.summary]), [['ok', items[0].summary], ['refuse', 'output collides']]);
      const outputs = await fs.readdir(out);
      assert.equal(outputs.length, 1);
      const [rr, , bb] = (await sharp(path.join(out, outputs[0])).stats()).channels.map((c) => c.mean);
      assert.ok(rr > bb, 'the first file (red) keeps the output');
      // The main command: Café.png and Café.gif (two forms) both become one Café_lco.jpg there.
      const input = path.join(dir, 'in');
      await fs.mkdir(input);
      await fs.writeFile(path.join(input, 'Café.png'.normalize('NFC')), await sharp({ create: { width: 16, height: 16, channels: 3, background: '#c00' } }).png().toBuffer());
      await fs.writeFile(path.join(input, 'Café.gif'.normalize('NFD')), await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00c' } }).gif().toBuffer());
      const main = run(input, '-o', path.join(vol, 'main'), '--error-dir', path.join(dir, 'err'), '--format', 'jpeg', '-q', '--json');
      assert.equal(main.status, 1, main.stderr);
      assert.equal(JSON.parse(main.stdout).refusedFiles.length, 1);
      assert.equal((await fs.readdir(path.join(vol, 'main'))).length, 1);
    } finally {
      if (image && hd('detach', mnt).status !== 0) hd('detach', '-force', mnt);
    }
  });
});

test('density sub-command: an output folder inside the input folder is not read as input; other images are listed as skipped', async () => {
  await withDir(async (dir) => {
    const input = path.join(dir, 'in');
    await fs.mkdir(path.join(input, 'done'), { recursive: true });
    await fs.writeFile(path.join(input, 'a.jpg'), await bareJpeg());
    await fs.writeFile(path.join(input, 'done', 'old_lco.jpg'), await bareJpeg());
    await fs.writeFile(path.join(input, 'b.png'), await (await noisy(8, 8)).png().toBuffer());
    const r = run('density', input, '--ppi', '72', '-o', path.join(input, 'done'), '--json');
    assert.equal(r.status, 0, r.stdout);
    const items = JSON.parse(r.stdout).items.map((it) => `${it.verdict} ${it.summary} ${it.name}`);
    assert.deepEqual(items, ['ok set 72 ppi (JFIF (inserted), +18 bytes) a.jpg', 'skip not a JPEG b.png']);
  });
});

test('density sub-command: a folder with no JPEG lists what it skipped and exits 1', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a.png'), await (await noisy(8, 8)).png().toBuffer());
    const r = run('density', dir, '--ppi', '72', '-o', path.join(dir, 'out'), '--brief');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^skip no JPEG files {2}/m);
    assert.match(r.stdout, /^skip not a JPEG {2}a\.png {2}\(lithocinch density rewrites JPEGs only\)$/m);
  });
});

test('density sub-command: the output keeps the source file mode, and replaces the file by rename (another hard link keeps the old bytes)', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'a.jpg');
    const src = splice(await bareJpeg(), jfif());
    await fs.writeFile(file, src);
    await fs.chmod(file, 0o640);
    const r = run('density', file, '--ppi', '72', '-o', path.join(dir, 'out'), '--brief');
    assert.equal(r.status, 0, r.stdout);
    assert.equal((await fs.stat(path.join(dir, 'out', 'a_lco.jpg'))).mode & 0o777, 0o640);
    // In place: a write into the file would change every link to it; a rename does not.
    await fs.link(file, path.join(dir, 'link.jpg'));
    const inPlace = run('density', file, '--ppi', '72', '-o', dir, '--suffix', '', '--overwrite', '--brief');
    assert.equal(inPlace.status, 0, inPlace.stdout);
    assert.deepEqual(readJpegDensity(await fs.readFile(file)).jfif, { units: 1, x: 72, y: 72 });
    assert.ok((await fs.readFile(path.join(dir, 'link.jpg'))).equals(src), 'the old inode was not written into');
  });
});

test('density sub-command: an unexpected error (not a bad file) ends the run with exit 3 and its own message', async () => {
  await withDir(async (dir) => {
    // Fault injection from outside the code under test: a JPEG of exactly
    // 77777 bytes makes Buffer#readUInt16BE throw a plain Error.
    const jpeg = splice(await bareJpeg(), jfif());
    const file = path.join(dir, 'a.jpg');
    await fs.writeFile(file, Buffer.concat([jpeg, Buffer.alloc(77777 - jpeg.length)]));
    const fault = 'data:text/javascript,' + encodeURIComponent(
      'const r = Buffer.prototype.readUInt16BE; Buffer.prototype.readUInt16BE = function (o) { if (this.length === 77777) throw new Error("injected fault"); return r.call(this, o); };'
    );
    const r = spawnSync(process.execPath, ['--import', fault, CLI, 'density', file, '--ppi', '72', '-o', path.join(dir, 'out'), '--brief'], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^lithocinch density: could not complete: injected fault$/m);
  });
});

test('density sub-command: SIGINT mid-run removes the temporary files in flight and exits 130', async () => {
  await withDir(async (dir) => {
    // Small images with large trailing data (after EOI): cheap to decode, slow
    // enough to write that a batch of eight is still writing when the first lands.
    const jpeg = splice(await bareJpeg(), jfif());
    const body = Buffer.concat([jpeg, Buffer.alloc(6 * 1024 * 1024, 0x5a)]);
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    for (let k = 0; k < 24; k++) await fs.writeFile(path.join(input, `f${String(k).padStart(2, '0')}.jpg`), body);
    const out = path.join(dir, 'out');
    const child = spawn(process.execPath, [CLI, 'density', input, '--ppi', '72', '-o', out, '-q'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    for (let waited = 0; waited < 20000; waited += 2) {
      const names = await fs.readdir(out).catch(() => []);
      if (names.some((n) => n.endsWith('.tmp') || n.endsWith('_lco.jpg'))) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    child.kill('SIGINT');
    const { code, signal } = await exited;
    assert.deepEqual({ code, signal }, { code: 130, signal: null });
    const left = (await fs.readdir(out).catch(() => [])).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(left, [], 'no temporary file is left behind');
  });
});

// ---- XMP end to end -----------------------------------------------------------

/** An XMP-only JPEG at 300 ppi, Photoshop's element form with 2 KB of padding. */
const paddedXmpJpeg = async () =>
  splice(await bareJpeg(), xmpPacket({ elements: '<tiff:XResolution>3000000/10000</tiff:XResolution><tiff:YResolution>3000000/10000</tiff:YResolution><tiff:ResolutionUnit>2</tiff:ResolutionUnit>' }));

const sipsDpi = (file) => {
  const r = spawnSync('sips', ['-g', 'dpiWidth', '-g', 'dpiHeight', file], { encoding: 'utf8' });
  return [...r.stdout.matchAll(/dpi(?:Width|Height): ([\d.]+)/g)].map((m) => Number(m[1]));
};
const hasSips = process.platform === 'darwin' && spawnSync('sips', ['--help'], { encoding: 'utf8' }).status === 0;

test('density sub-command: an XMP with padding is rewritten in place, and the human view shows it before and after', async () => {
  await withDir(async (dir) => {
    const src = await paddedXmpJpeg();
    await fs.writeFile(path.join(dir, 'x.jpg'), src);
    const out = path.join(dir, 'out');
    const r = run('density', path.join(dir, 'x.jpg'), '--ppi', '72', '-o', out);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^ok set 72 ppi \(JFIF \(inserted\), XMP, \+18 bytes\) {2}x\.jpg$/m);
    assert.match(r.stdout, /^ {4}was {3}XMP 3000000\/10000 x 3000000\/10000 in$/m);
    assert.match(r.stdout, /^ {4}now {3}JFIF 72x72 dpi, XMP 72\/1 x 72\/1 in$/m);
    const got = await fs.readFile(path.join(out, 'x_lco.jpg'));
    assert.deepEqual([xmpBack(got).x, xmpBack(got).y], ['72/1', '72/1']);
    assert.ok((await rgba(got)).equals(await rgba(src)));
  });
});

test('processDirectory --density: a passed-through original with padded XMP carries the new value there too', async () => {
  const r = await processFiles({ 'x.jpg': await paddedXmpJpeg() }, { format: 'auto', density: 72 });
  try {
    assert.equal(r.events.find((e) => e.type === 'done').engine, 'passthrough', 'the fixture must be passed through');
    assert.deepEqual([r.stats.density.applied, r.stats.density.stale, r.stats.refused], [1, 0, 0]);
    const got = await fs.readFile(path.join(r.output, 'x_lco.jpg'));
    assert.deepEqual([xmpBack(got).x, xmpBack(got).y, xmpBack(got).unit], ['72/1', '72/1', '2']);
  } finally {
    await fs.rm(r.dir, { recursive: true, force: true });
  }
});

test('Apple ImageIO (sips) reads the rewritten XMP as the new ppi', { skip: !hasSips && 'sips is macOS only' }, async () => {
  await withDir(async (dir) => {
    const src = await paddedXmpJpeg();
    const file = path.join(dir, 'x.jpg');
    await fs.writeFile(file, src);
    assert.deepEqual(sipsDpi(file), [300, 300], 'the fixture reads 300 before');
    const r = run('density', file, '--ppi', '72', '-o', path.join(dir, 'out'), '-q');
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(sipsDpi(path.join(dir, 'out', 'x_lco.jpg')), [72, 72]);
    // The same file with only the JFIF patched still reads 300 there: XMP is what ImageIO used.
    const jfifOnly = path.join(dir, 'jfif-only.jpg');
    await fs.writeFile(jfifOnly, patchJpegDensity(splice(await bareJpeg(), xmp()), 72, { allowStaleXmp: true }).data);
    assert.deepEqual(sipsDpi(jfifOnly), [300, 300]);
  });
});
