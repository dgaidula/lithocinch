// Tests for the transform API + HTTP daemon (the CMS-plugin / Lambda backbone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { runTransform, handleJsonRequest } from '../src/transform-api.js';
import { startServer } from '../src/server.js';

async function photoJpeg(w = 1000, h = 800) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = Math.sin(x / 30) * 10 + Math.cos(y / 25) * 10;
      px[i] = Math.max(0, Math.min(255, 160 - (x / w) * 110 + t));
      px[i + 1] = Math.max(0, Math.min(255, 120 + (y / h) * 90 + t));
      px[i + 2] = Math.max(0, Math.min(255, 90 + ((x + y) / (w + h)) * 110));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

test('runTransform resizes to exact cover dimensions', async () => {
  const img = await photoJpeg();
  const [out] = await runTransform(img, { ops: { width: 640, height: 480, fit: 'cover' }, format: 'webp' });
  assert.equal(out.format, 'webp');
  assert.equal(out.width, 640);
  assert.equal(out.height, 480);
  assert.ok(Buffer.isBuffer(out.data));
});

test('runTransform "inside" fit preserves aspect ratio', async () => {
  const img = await photoJpeg(1000, 800); // 5:4
  const [out] = await runTransform(img, { ops: { width: 500, height: 500, fit: 'inside' }, format: 'webp' });
  assert.equal(out.width, 500);
  assert.equal(out.height, 400); // aspect kept, not cropped to 500x500
});

test('focal-point cover crop produces the requested size', async () => {
  const img = await photoJpeg();
  const [out] = await runTransform(img, {
    ops: { width: 400, height: 400, fit: 'cover', focal: { x: 0.2, y: 0.8 } },
    format: 'webp',
  });
  assert.equal(out.width, 400);
  assert.equal(out.height, 400);
});

test('batch yields one output per item (the <picture> case)', async () => {
  const img = await photoJpeg();
  const outs = await runTransform(img, {
    defaults: { maxSize: 1200 },
    batch: [
      { ops: { width: 800 }, format: 'avif' },
      { ops: { width: 800 }, format: 'webp' },
      { ops: { width: 800 }, format: 'auto' },
    ],
  });
  assert.equal(outs.length, 3);
  assert.equal(outs[0].format, 'avif');
  assert.equal(outs[1].format, 'webp');
});

test('handleJsonRequest round-trips base64 in and out', async () => {
  const img = await photoJpeg(300, 200);
  const res = await handleJsonRequest({ image: img.toString('base64'), ops: { width: 150 }, format: 'webp' });
  assert.equal(res.outputs.length, 1);
  assert.equal(typeof res.outputs[0].data, 'string'); // base64
  const decoded = Buffer.from(res.outputs[0].data, 'base64');
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 150);
});

test('HTTP daemon: health, auth, and transform', async () => {
  const { server, port, host } = await startServer({ version: 'test', token: 'sekret' });
  try {
    const base = `http://${host}:${port}`;
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.deepEqual(health, { ok: true, version: 'test' });

    const img = (await photoJpeg(200, 200)).toString('base64');
    const unauth = await fetch(`${base}/transform`, { method: 'POST', body: JSON.stringify({ image: img }) });
    assert.equal(unauth.status, 401);

    const ok = await fetch(`${base}/transform`, {
      method: 'POST',
      headers: { authorization: 'Bearer sekret', 'content-type': 'application/json' },
      body: JSON.stringify({ image: img, ops: { width: 100 }, format: 'webp' }),
    }).then((r) => r.json());
    assert.equal(ok.ok, true);
    assert.equal(ok.outputs[0].width, 100);
  } finally {
    server.close();
  }
});

test('daemon rejects invalid JSON with 400', async () => {
  const { server, port, host } = await startServer({ version: 'test' });
  try {
    const r = await fetch(`http://${host}:${port}/transform`, { method: 'POST', body: 'not json' });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});
