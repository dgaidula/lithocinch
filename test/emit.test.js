// Tests for --emit (also-write sibling formats for <picture> fallbacks),
// exercised through processDirectory against a temp tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { processDirectory } from '../src/process-dir.js';

async function tmpTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-emit-'));
  const input = path.join(root, 'in');
  const output = path.join(root, 'out');
  await fs.mkdir(input, { recursive: true });
  // one photographic-ish jpeg, one svg
  const px = Buffer.alloc(300 * 200 * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7) & 255;
  await sharp(px, { raw: { width: 300, height: 200, channels: 3 } }).jpeg().toFile(path.join(input, 'photo.jpg'));
  await fs.writeFile(path.join(input, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
  return { root, input, output };
}

const exists = (p) => fs.access(p).then(() => true).catch(() => false);

test('emit writes sibling formats next to the primary, skipping svg', async () => {
  const { root, input, output } = await tmpTree();
  try {
    const stats = await processDirectory({ input, output, suffix: '_opt', emit: ['webp', 'avif'], maxSize: 0 });
    assert.equal(stats.emitted, 2, 'one webp + one avif for the single raster');
    assert.ok(await exists(path.join(output, 'photo_opt.jpg')), 'primary jpg');
    assert.ok(await exists(path.join(output, 'photo_opt.webp')), 'webp sibling');
    assert.ok(await exists(path.join(output, 'photo_opt.avif')), 'avif sibling');
    // svg gets no raster siblings
    assert.ok(!(await exists(path.join(output, 'icon_opt.webp'))));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('emit de-duplicates the primary format', async () => {
  const { root, input, output } = await tmpTree();
  try {
    // primary forced to webp; emitting webp must NOT double-write it
    const stats = await processDirectory({ input, output, suffix: '_opt', format: 'webp', emit: ['webp', 'avif'], maxSize: 0 });
    assert.ok(await exists(path.join(output, 'photo_opt.webp')), 'primary webp');
    assert.ok(await exists(path.join(output, 'photo_opt.avif')), 'avif sibling');
    assert.equal(stats.emitted, 1, 'only avif emitted; webp == primary');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('emit fills in a missing sibling even when the primary is already present', async () => {
  const { root, input, output } = await tmpTree();
  try {
    await processDirectory({ input, output, suffix: '_opt', emit: ['webp', 'avif'], maxSize: 0 });
    await fs.rm(path.join(output, 'photo_opt.webp')); // delete one sibling
    const stats = await processDirectory({ input, output, suffix: '_opt', emit: ['webp', 'avif'], maxSize: 0 });
    assert.equal(stats.processed, 0, 'primary already present -> skipped');
    assert.equal(stats.emitted, 1, 'only the missing webp re-emitted');
    assert.ok(await exists(path.join(output, 'photo_opt.webp')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
