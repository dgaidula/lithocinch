// Tests for AVIF (content-aware, perceptually-lossless) and the unified target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeImageBuffer } from '../src/optimize.js';
import { resolveConfig } from '../src/config.js';

async function photoJpeg(w = 500, h = 400) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = Math.sin(x / 28) * 10 + Math.cos(y / 22) * 10;
      px[i] = Math.max(0, Math.min(255, 170 - (x / w) * 110 + t));
      px[i + 1] = Math.max(0, Math.min(255, 120 + (y / h) * 90 + t));
      px[i + 2] = Math.max(0, Math.min(255, 100 + ((x + y) / (w + h)) * 110));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

test('avif auto chooses lossy for a photographic source and shrinks it', async () => {
  const src = await photoJpeg();
  const r = await optimizeImageBuffer(src, { format: 'avif', maxSize: 0 });
  assert.equal(r.outputFormat, 'avif');
  assert.equal(r.engine, 'avif-lossy');
  assert.ok(r.data.length < src.length);
  const meta = await sharp(r.data).metadata();
  assert.equal(meta.format, 'heif'); // AVIF is reported as heif by sharp
});

test('avif lossy clears the perceptual target', async () => {
  const src = await photoJpeg();
  const r = await optimizeImageBuffer(src, { format: 'avif', maxSize: 0, perceptualTarget: 0.98 });
  assert.ok(r.ssim >= 0.98, `ssim ${r.ssim} should clear 0.98`);
});

test('a stricter perceptual target never picks a lower quality', async () => {
  // Detailed noise so quality actually moves SSIM.
  const w = 480, h = 360, px = Buffer.alloc(w * h * 3);
  let s = 5;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = ((i * 11) + rnd() * 90) & 255;
  const src = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const loose = await optimizeImageBuffer(src, { format: 'avif', maxSize: 0, perceptualTarget: 0.95, avifMin: 20, avifMax: 70 });
  const strict = await optimizeImageBuffer(src, { format: 'avif', maxSize: 0, perceptualTarget: 0.999, avifMin: 20, avifMax: 70 });
  assert.ok(strict.quality >= loose.quality, `strict q${strict.quality} >= loose q${loose.quality}`);
});

test('per-codec target overrides the unified perceptualTarget', () => {
  const cfg = resolveConfig({ perceptualTarget: 0.98, avifTargetSsim: 0.995 });
  assert.equal(cfg.avifTargetSsim, 0.995);
  assert.equal(cfg.webpTargetSsim, 0.98); // falls back to perceptualTarget
});
