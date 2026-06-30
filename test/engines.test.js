// Tests for the opinionated `auto` engines (gif/png). Binary-dependent
// assertions are skipped when the external tool isn't installed, so the suite
// passes anywhere (including CI/Lambda) while still verifying the wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { hasBinary } from '../src/bin.js';
import { finalizeGif } from '../src/gif.js';
import { optimizeImageBuffer } from '../src/optimize.js';

const staticGif = () =>
  sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .gif()
    .toBuffer();

test('gif engine "sharp" returns the input untouched', async () => {
  const gif = await staticGif();
  const r = await finalizeGif(gif, { gifEngine: 'sharp' });
  assert.equal(r.engine, 'sharp');
  assert.ok(r.data.equals(gif));
});

test('gif engine "gifsicle" never grows the file', async (t) => {
  if (!(await hasBinary('gifsicle'))) return t.skip('gifsicle not installed');
  const gif = await staticGif();
  const r = await finalizeGif(gif, { gifEngine: 'gifsicle', gifsicleOptimize: 3, gifsicleLossy: 0 });
  assert.ok(r.data.length <= gif.length);
});

test('gif engine "gifsicle" throws a helpful error when the binary is missing', async (t) => {
  if (await hasBinary('gifsicle')) return t.skip('gifsicle is installed; missing-binary path not exercised here');
  const gif = await staticGif();
  await assert.rejects(() => finalizeGif(gif, { gifEngine: 'gifsicle' }), /not found on PATH/);
});

test('png auto is never larger than the sharp engine alone', async (t) => {
  if (!(await hasBinary('pngquant'))) return t.skip('pngquant not installed');
  // A simple flat PNG is exactly where pngquant beats libvips on bytes.
  const src = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 120, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const sharpOnly = await optimizeImageBuffer(src, { maxSize: 0, pngEngine: 'sharp' });
  const auto = await optimizeImageBuffer(src, { maxSize: 0, pngEngine: 'auto' });
  assert.ok(auto.data.length <= sharpOnly.data.length, `auto ${auto.data.length} <= sharp ${sharpOnly.data.length}`);
});

test('png auto keeps quality-safe output (decodes to a valid PNG)', async (t) => {
  if (!(await hasBinary('pngquant'))) return t.skip('pngquant not installed');
  const src = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
  const auto = await optimizeImageBuffer(src, { maxSize: 0, pngEngine: 'auto' });
  const meta = await sharp(auto.data).metadata();
  assert.equal(meta.format, 'png');
});
