// Tests for the content-aware WebP encoder and the shared quality search.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { searchQuality } from '../src/lossy-search.js';
import { toLuma } from '../src/ssim.js';
import { optimizeImageBuffer } from '../src/optimize.js';

const rawOf = async (buf) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { raw: data, info, luma: toLuma(data, info.width, info.height, info.channels) };
};

// A photographic source: smooth gradients + texture.
async function photoJpeg(w = 600, h = 400) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = Math.sin(x / 30) * 10 + Math.cos(y / 25) * 10;
      px[i] = Math.max(0, Math.min(255, 180 - (x / w) * 120 + t));
      px[i + 1] = Math.max(0, Math.min(255, 120 + (y / h) * 100 + t));
      px[i + 2] = Math.max(0, Math.min(255, 90 + ((x + y) / (w + h)) * 120));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// A graphic source: a few flat color blocks.
async function graphicPng(w = 400, h = 300) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const c = (((x / 80) | 0) + ((y / 60) | 0)) % 3;
      px[i] = c === 0 ? 220 : 40;
      px[i + 1] = c === 1 ? 200 : 60;
      px[i + 2] = c === 2 ? 180 : 80;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// --- shared quality search ----------------------------------------------
test('searchQuality returns a quality within the band', async () => {
  const src = await photoJpeg();
  const { raw, info, luma } = await rawOf(src);
  const encode = (q) => sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels } }).webp({ quality: q }).toBuffer();
  const r = await searchQuality({ encode, refLuma: luma, width: info.width, height: info.height, min: 40, max: 90, target: 0.99 });
  assert.ok(r.quality >= 40 && r.quality <= 90);
  assert.ok(r.data.length > 0);
});

test('searchQuality picks a higher quality for a stricter target', async () => {
  const src = await photoJpeg();
  const { raw, info, luma } = await rawOf(src);
  const encode = (q) => sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels } }).webp({ quality: q }).toBuffer();
  const loose = await searchQuality({ encode, refLuma: luma, width: info.width, height: info.height, min: 20, max: 95, target: 0.95 });
  const strict = await searchQuality({ encode, refLuma: luma, width: info.width, height: info.height, min: 20, max: 95, target: 0.999 });
  assert.ok(strict.quality >= loose.quality, `strict ${strict.quality} >= loose ${loose.quality}`);
});

// --- content-aware auto -------------------------------------------------
test('webp auto chooses LOSSY for a photographic (jpeg) source', async () => {
  const r = await optimizeImageBuffer(await photoJpeg(), { format: 'webp', maxSize: 0 });
  assert.equal(r.outputFormat, 'webp');
  assert.equal(r.engine, 'webp-lossy');
});

test('webp auto chooses LOSSLESS for a flat graphic source', async () => {
  const r = await optimizeImageBuffer(await graphicPng(), { format: 'webp', maxSize: 0 });
  assert.equal(r.engine, 'webp-lossless');
});

test('webp lossless mode is pixel-identical to the source', async () => {
  const src = await graphicPng();
  const r = await optimizeImageBuffer(src, { format: 'webp', maxSize: 0, webpMode: 'lossless' });
  const a = await sharp(src).raw().toBuffer();
  const b = await sharp(r.data).raw().toBuffer();
  assert.ok(a.equals(b), 'lossless webp must decode to identical pixels');
});

test('webp auto beats the source size on a photo', async () => {
  const src = await photoJpeg();
  const r = await optimizeImageBuffer(src, { format: 'webp', maxSize: 0 });
  assert.ok(r.data.length < src.length, `${r.data.length} < ${src.length}`);
});
