// Unit tests for the pure core. Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeImageBuffer } from '../src/optimize.js';
import { optimizeBytes } from '../src/transform.js';
import { optimizeSvg } from '../src/svg.js';
import { buildOutputName, extNoDot } from '../src/naming.js';
import { resolveConfig, parseColor } from '../src/config.js';

// --- helpers -------------------------------------------------------------
const makePng = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } } })
    .png()
    .toBuffer();

// --- naming --------------------------------------------------------------
test('buildOutputName inserts suffix before extension', () => {
  assert.equal(buildOutputName('photo.jpg', { suffix: '_opt' }), 'photo_opt.jpg');
});

test('buildOutputName rewrites extension on format change', () => {
  assert.equal(
    buildOutputName('a/b/pic.png', { suffix: '_opt', outputFormat: 'jpeg' }),
    'a/b/pic_opt.jpg'
  );
});

test('buildOutputName lowercases extension and replaces ALL spaces', () => {
  assert.equal(
    buildOutputName('My Cool Photo.JPG', { suffix: '_x', lowercaseExt: true, spaceChar: '_' }),
    'My_Cool_Photo_x.jpg'
  );
});

test('extNoDot returns lowercase ext without dot', () => {
  assert.equal(extNoDot('FOO.JPEG'), 'jpeg');
  assert.equal(extNoDot('noext'), '');
});

// --- config --------------------------------------------------------------
test('parseColor handles hex and rgb', () => {
  assert.deepEqual(parseColor('#ff0000'), { r: 255, g: 0, b: 0, alpha: 1 });
  assert.deepEqual(parseColor('#f00'), { r: 255, g: 0, b: 0, alpha: 1 });
  assert.deepEqual(parseColor('10,20,30'), { r: 10, g: 20, b: 30, alpha: 1 });
  assert.deepEqual(parseColor('10,20,30,0.5'), { r: 10, g: 20, b: 30, alpha: 0.5 });
});

test('resolveConfig normalizes format aliases and rejects bad ones', () => {
  assert.equal(resolveConfig({ format: 'jpg' }).format, 'jpeg');
  assert.equal(resolveConfig({ format: 'keep' }).format, null);
  assert.throws(() => resolveConfig({ format: 'bmp' }), /Invalid --format/);
});

// --- raster optimize -----------------------------------------------------
test('optimizeImageBuffer resizes images above maxSize', async () => {
  const big = await makePng(4000, 3000);
  const { info, resized } = await optimizeImageBuffer(big, { maxSize: 2560 });
  assert.equal(resized, true);
  assert.ok(info.width <= 2560 && info.height <= 2560);
});

test('optimizeImageBuffer leaves small images unresized', async () => {
  const small = await makePng(800, 600);
  const { info, resized } = await optimizeImageBuffer(small, { maxSize: 2560 });
  assert.equal(resized, false);
  assert.equal(info.width, 800);
});

test('maxSize 0 disables resizing', async () => {
  const big = await makePng(4000, 3000);
  const { info } = await optimizeImageBuffer(big, { maxSize: 0 });
  assert.equal(info.width, 4000);
});

test('square pads to a maxSize x maxSize canvas', async () => {
  const wide = await makePng(2000, 500);
  const { info } = await optimizeImageBuffer(wide, { maxSize: 1024, square: true });
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
});

test('format override converts png to jpeg (no alpha in output)', async () => {
  const png = await makePng(300, 300);
  const { data, outputFormat } = await optimizeImageBuffer(png, { format: 'jpeg' });
  assert.equal(outputFormat, 'jpeg');
  const meta = await sharp(data).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('optimizeBytes derives svg output name and shrinks markup', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <!-- a comment -->   <rect x="0" y="0" width="10" height="10" fill="#ff0000"/>
  </svg>`;
  const res = await optimizeBytes(svg, 'icon.svg', { suffix: '_opt' });
  assert.equal(res.kind, 'svg');
  assert.equal(res.outName, 'icon_opt.svg');
  assert.ok(res.data.length < Buffer.byteLength(svg));
  assert.ok(res.data.toString().includes('viewBox')); // viewBox preserved by default
});

test('optimizeBytes rejects unsupported extensions', async () => {
  await assert.rejects(() => optimizeBytes(Buffer.from('x'), 'file.bmp'), /Unsupported/);
});

test('optimizeSvg can be told to drop viewBox', () => {
  // svgo only drops viewBox when width+height are present (so it can be reconstructed)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const out = optimizeSvg(svg, { svgRemoveViewBox: true });
  assert.ok(!out.includes('viewBox'));
});
