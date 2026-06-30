// Tests for the adaptive JPEG path + SSIM metric — the behavior that has to
// match (or closely approximate) 2.9's jpeg-recompress pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { ssim, toLuma } from '../src/ssim.js';
import { optimizeImageBuffer } from '../src/optimize.js';

// A detailed, noisy image so JPEG quality actually affects SSIM (flat colors
// compress perfectly at any quality and wouldn't exercise the search).
async function noisyJpeg(w = 1024, h = 1024) {
  const px = Buffer.alloc(w * h * 3);
  // Deterministic pseudo-noise + gradient so there's real high-frequency detail.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const base = ((x ^ y) & 255);
      px[i] = (base + rand() * 120) & 255;
      px[i + 1] = (((x * 2) & 255) + rand() * 120) & 255;
      px[i + 2] = (((y * 2) & 255) + rand() * 120) & 255;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

const lumaOf = async (buf) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { luma: toLuma(data, info.width, info.height, info.channels), w: info.width, h: info.height };
};

test('ssim of an image with itself is 1', async () => {
  const a = await lumaOf(await noisyJpeg(512, 512));
  assert.ok(Math.abs(ssim(a.luma, a.luma, a.w, a.h) - 1) < 1e-6);
});

test('ssim decreases as JPEG quality drops', async () => {
  const ref = await lumaOf(await noisyJpeg(512, 512));
  const src = await noisyJpeg(512, 512);
  const q80 = await lumaOf(await sharp(src).jpeg({ quality: 80 }).toBuffer());
  const q20 = await lumaOf(await sharp(src).jpeg({ quality: 20 }).toBuffer());
  const s80 = ssim(ref.luma, q80.luma, ref.w, ref.h);
  const s20 = ssim(ref.luma, q20.luma, ref.w, ref.h);
  assert.ok(s80 > s20, `expected ssim(q80)=${s80} > ssim(q20)=${s20}`);
  assert.ok(s80 <= 1 && s20 >= 0);
});

test('recompress picks a quality inside the configured band', async () => {
  const src = await noisyJpeg(768, 768);
  const { quality, outputFormat, engine } = await optimizeImageBuffer(src, {
    jpegMin: 30,
    jpegMax: 60,
    jpegTarget: 0.999,
    maxSize: 0,
  });
  assert.equal(outputFormat, 'jpeg');
  assert.equal(engine, 'sharp-ssim');
  assert.ok(quality >= 30 && quality <= 60, `quality ${quality} outside [30,60]`);
});

test('a looser SSIM target yields a quality <= a stricter target', async () => {
  const src = await noisyJpeg(768, 768);
  const loose = await optimizeImageBuffer(src, { jpegTarget: 0.97, jpegMin: 20, jpegMax: 90, maxSize: 0 });
  const strict = await optimizeImageBuffer(src, { jpegTarget: 0.999, jpegMin: 20, jpegMax: 90, maxSize: 0 });
  assert.ok(
    loose.quality <= strict.quality,
    `loose q${loose.quality} should be <= strict q${strict.quality}`
  );
});

test('recompress beats a fixed high quality on size for the same image', async () => {
  const src = await noisyJpeg(768, 768);
  const adaptive = await optimizeImageBuffer(src, { jpegTarget: 0.999, jpegMin: 30, jpegMax: 60, maxSize: 0 });
  const fixedHi = await optimizeImageBuffer(src, { jpegMode: 'fixed', jpegQuality: 90, maxSize: 0 });
  assert.ok(
    adaptive.data.length < fixedHi.data.length,
    `adaptive ${adaptive.data.length} should be < fixed-q90 ${fixedHi.data.length}`
  );
});

test('fixed mode honors the requested quality', async () => {
  const src = await noisyJpeg(256, 256);
  const r = await optimizeImageBuffer(src, { jpegMode: 'fixed', jpegQuality: 42, maxSize: 0 });
  assert.equal(r.quality, 42);
  assert.equal(r.engine, 'sharp-fixed');
});
