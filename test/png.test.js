// Tests for the PNG / lossless / never-inflate behavior — verifying parity with
// 2.9's imagemin-pngquant({ quality:[0.5,0.6], speed:1 }) intent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeImageBuffer } from '../src/optimize.js';
import { encodePng } from '../src/png.js';

// A >256-color image (gradient + noise) so palette quantization actually engages.
async function richPng(w = 600, h = 400) {
  const px = Buffer.alloc(w * h * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (x * 255 / w + rnd() * 8) & 255;
      px[i + 1] = (y * 255 / h + rnd() * 8) & 255;
      px[i + 2] = ((x + y) * 255 / (w + h)) & 255;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

test('default PNG path quantizes to a palette and shrinks the file', async () => {
  const src = await richPng();
  const { data, outputFormat } = await optimizeImageBuffer(src, { maxSize: 0 });
  assert.equal(outputFormat, 'png');
  assert.ok(data.length < src.length, `expected ${data.length} < ${src.length}`);
  const meta = await sharp(data).metadata();
  assert.equal(meta.format, 'png');
});

test('PNG palette output uses <= 256 distinct colors', async () => {
  const src = await richPng(); // source has thousands of colors
  const { data } = await optimizeImageBuffer(src, { maxSize: 0 });
  const { data: px, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const colors = new Set();
  for (let i = 0; i < px.length; i += info.channels) {
    colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (colors.size > 256) break;
  }
  assert.ok(colors.size <= 256, `palette has ${colors.size} colors, expected <= 256`);
});

test('higher png effort is equal-or-better (no larger) than lower effort', async () => {
  const src = await richPng();
  const hi = await optimizeImageBuffer(src, { maxSize: 0, pngEffort: 10 });
  const lo = await optimizeImageBuffer(src, { maxSize: 0, pngEffort: 1 });
  assert.ok(hi.data.length <= lo.data.length, `effort10 ${hi.data.length} should be <= effort1 ${lo.data.length}`);
});

test('lossless PNG is pixel-identical to the source', async () => {
  const src = await richPng(256, 256);
  const { data } = await optimizeImageBuffer(src, { maxSize: 0, pngLossless: true });
  const a = await sharp(src).raw().toBuffer();
  const b = await sharp(data).raw().toBuffer();
  assert.ok(a.equals(b), 'lossless output must decode to identical pixels');
});

test('never-inflate: an already-tiny PNG is passed through unchanged', async () => {
  // A tiny, already-minimal PNG that re-encoding cannot beat.
  const tiny = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png({ palette: true, compressionLevel: 9 })
    .toBuffer();
  const { data, engine } = await optimizeImageBuffer(tiny, { maxSize: 0 });
  assert.ok(data.length <= tiny.length, `output ${data.length} must be <= input ${tiny.length}`);
  if (data.length === tiny.length) assert.equal(engine, 'passthrough');
});

// The SSIM gate: the portable replacement for pngquant's min-quality bail.
async function rawOf(buf) {
  const { data, info } = await sharp(buf).toColorspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { raw: data, info };
}
const gateCfg = (over) => ({
  pngEngine: 'sharp', pngQuality: 80, pngEffort: 10, pngColors: 256, pngDither: 1,
  pngLossless: false, pngSsimDownsample: false, keepMetadata: false, ...over,
});

test('gate falls back to lossless when palettization is too lossy', async () => {
  // Smooth, wide-gamut sinusoidal gradients band badly at 256 colors — the real
  // worst case for palettization (and what pngquant would bail on).
  const w = 400, h = 400, px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (128 + 120 * Math.sin(x / 9)) & 255;
      px[i + 1] = (128 + 120 * Math.cos(y / 7)) & 255;
      px[i + 2] = (128 + 120 * Math.sin((x + y) / 11)) & 255;
    }
  }
  const src = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const { raw, info } = await rawOf(src);
  const strict = await encodePng(raw, info, gateCfg({ pngMinSsim: 0.95 }));
  const off = await encodePng(raw, info, gateCfg({ pngMinSsim: 0 }));
  assert.equal(strict.mode, 'lossless-fallback', `gate should trip; got ${strict.mode} ssim ${strict.ssim}`);
  assert.equal(off.mode, 'palette');
});

test('gate passes a simple image straight to palette', async () => {
  const src = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 140, b: 90 } },
  }).png().toBuffer();
  const { raw, info } = await rawOf(src);
  const r = await encodePng(raw, info, gateCfg({ pngMinSsim: 0.85 }));
  assert.equal(r.mode, 'palette');
  assert.ok(r.ssim >= 0.85);
});

test('resizing disables passthrough even if output is larger', async () => {
  // Force a resize so transformed=true; guard must not short-circuit.
  const src = await richPng(800, 800);
  const { resized } = await optimizeImageBuffer(src, { maxSize: 400 });
  assert.equal(resized, true);
});
