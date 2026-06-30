// Tests for --format auto (pick the smallest format per image).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeImageBuffer } from '../src/optimize.js';

async function photoPng(w = 500, h = 400) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = Math.sin(x / 24) * 12 + Math.cos(y / 19) * 12;
      px[i] = Math.max(0, Math.min(255, 150 - (x / w) * 100 + t));
      px[i + 1] = Math.max(0, Math.min(255, 110 + (y / h) * 90 + t));
      px[i + 2] = Math.max(0, Math.min(255, 90 + ((x + y) / (w + h)) * 110));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

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

test('auto converts a photographic PNG away from PNG (and shrinks hugely)', async () => {
  const src = await photoPng();
  const r = await optimizeImageBuffer(src, { format: 'auto', maxSize: 0 });
  assert.notEqual(r.outputFormat, 'png', 'a photo should not stay PNG');
  assert.ok(['avif', 'webp', 'jpeg'].includes(r.outputFormat));
  assert.ok(r.data.length < src.length / 2, `expected big shrink, got ${r.data.length} from ${src.length}`);
});

test('auto keeps an image with alpha out of JPEG', async () => {
  const src = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const r = await optimizeImageBuffer(src, { format: 'auto', maxSize: 0 });
  assert.notEqual(r.outputFormat, 'jpeg', 'alpha image must not become JPEG');
  const meta = await sharp(r.data).metadata();
  assert.ok(meta.hasAlpha, 'alpha must be preserved');
});

test('--format-pool restricts candidates (drop avif -> photo picks webp/jpeg)', async () => {
  const src = await photoPng();
  const r = await optimizeImageBuffer(src, { format: 'auto', maxSize: 0, formatPool: ['webp', 'jpeg', 'png'] });
  assert.notEqual(r.outputFormat, 'avif', 'avif was excluded from the pool');
  assert.ok(['webp', 'jpeg'].includes(r.outputFormat));
});

test('tie-break prefers the more compatible format within tolerance', async () => {
  // Flat graphic: webp-lossless and avif may be close; webp must win (more compatible).
  const src = await graphicPng();
  const r = await optimizeImageBuffer(src, { format: 'auto', maxSize: 0, formatTolerance: 0.25 });
  assert.ok(['webp', 'png'].includes(r.outputFormat), `expected a compatible format, got ${r.outputFormat}`);
});

test('auto never inflates: a tiny already-optimal image is not grown', async () => {
  const src = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
  const r = await optimizeImageBuffer(src, { format: 'auto', maxSize: 0 });
  assert.ok(r.data.length <= src.length, `auto output ${r.data.length} must be <= ${src.length}`);
});
