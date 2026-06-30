// Tests for the animated WebP-vs-GIF shootout. Uses a tiny embedded 2-frame
// animated GIF so the suite is self-contained (no external tools/files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeImageBuffer } from '../src/optimize.js';

// 16x16, 2 frames, looping (built once with gifsicle, embedded as base64).
const ANIM_GIF = Buffer.from(
  'R0lGODlhEAAQAPEAAExpccgoKCgoyAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFHgAAACwAAAAAEAAQAAACDoyPqcvtD6OctNqLsz4FACH5BAUeAAAALAAAAAAQABAAAAIOlI+py+0Po5y02ouzPgUAOw==',
  'base64'
);

test('the test fixture really is a 2-frame animation', async () => {
  const m = await sharp(ANIM_GIF).metadata();
  assert.equal(m.pages, 2);
});

test('animated auto preserves all frames and stays animated', async () => {
  const r = await optimizeImageBuffer(ANIM_GIF, { format: 'auto', maxSize: 0 });
  assert.ok(['webp', 'gif'].includes(r.outputFormat), `unexpected format ${r.outputFormat}`);
  const m = await sharp(r.data).metadata();
  assert.equal(m.pages, 2, 'animation must be preserved');
});

test('forcing --format webp on an animated GIF keeps it animated', async () => {
  const r = await optimizeImageBuffer(ANIM_GIF, { format: 'webp', maxSize: 0 });
  assert.equal(r.outputFormat, 'webp');
  const m = await sharp(r.data).metadata();
  assert.equal(m.pages, 2);
});

test('forcing --format gif keeps it an animated GIF', async () => {
  const r = await optimizeImageBuffer(ANIM_GIF, { format: 'gif', maxSize: 0 });
  assert.equal(r.outputFormat, 'gif');
  const m = await sharp(r.data).metadata();
  assert.equal(m.pages, 2);
});

test('keeping the format never inflates an already-tiny animation', async () => {
  const r = await optimizeImageBuffer(ANIM_GIF, { maxSize: 0 }); // keep format
  assert.ok(r.data.length <= ANIM_GIF.length, `output ${r.data.length} must be <= ${ANIM_GIF.length}`);
  const m = await sharp(r.data).metadata();
  assert.equal(m.pages, 2);
});
