// Tests for resolution (density) headers: the header-only rewrite in
// src/density.js, the `--density` option on a normal run, and the
// `lithocinch density` sub-command. Fixtures are built in the tests (sharp for
// pixels, hand-assembled bytes for the header cases sharp can't produce).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('density fields that are present but not rewritten are reported (Photoshop resource, XMP)', async () => {
  // 8BIM resource 0x03ED (resolution info), empty name, 16 bytes of data.
  const irb = Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('8BIM', 'latin1'), Buffer.from([0x03, 0xed, 0, 0, 0, 0, 0, 16]), Buffer.alloc(16)]);
  const app13 = Buffer.concat([Buffer.from([0xff, 0xed, 0, 0]), irb]);
  app13.writeUInt16BE(2 + irb.length, 2);
  const xmpBody = Buffer.from('http://ns.adobe.com/xap/1.0/\0<tiff:XResolution>3000000/10000</tiff:XResolution>', 'latin1');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), xmpBody]);
  app1.writeUInt16BE(2 + xmpBody.length, 2);
  const out = patchJpegDensity(splice(await bareJpeg(), jfif(), app13, app1), 72);
  assert.deepEqual(out.unpatched, ['Photoshop resolution resource (APP13)', 'XMP resolution fields']);
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
});

// ---- config -----------------------------------------------------------------

test('config: density is off by default, and validated as a whole number of ppi', () => {
  assert.equal(resolveConfig().density, null);
  assert.equal(resolveConfig({ density: '300' }).density, 300);
  for (const bad of ['72.5', '0', '-1', 'abc', '65536', '', NaN]) {
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
