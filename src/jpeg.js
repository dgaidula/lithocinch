// Adaptive JPEG encoding — the heart of the tool's compression quality.
//
// 2.9 leaned on `imagemin-jpeg-recompress` (min:30, max:60, quality:"low"),
// which binary-searches JPEG quality per file and keeps the SMALLEST encoding
// whose SSIM vs the source still clears a perceptual target (~0.999 for "low").
// A fixed quality can't match that: a flat graphic and a detailed photo want
// very different quality numbers for the same visual result. This module
// reproduces that adaptive search in-process using sharp/mozjpeg to encode
// candidates and our own SSIM to score them — so it runs anywhere sharp does
// (including Lambda), with no native jpeg-recompress binary required.
//
// An opt-in `jpegEngine: 'jpeg-recompress'` path shells out to the real binary
// for byte-exact parity with 2.9 when it's available locally.

import { spawn } from 'node:child_process';
import sharp from 'sharp';

import { ssim, toLuma } from './ssim.js';

/** Build a sharp instance from a raw pixel buffer, re-attaching sRGB metadata if requested. */
function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

const encodeAt = (rawBuf, info, cfg, quality) =>
  fromRaw(rawBuf, info, cfg).jpeg({ quality, mozjpeg: cfg.mozjpeg }).toBuffer();

/**
 * Encode a JPEG from raw pixels using the configured engine/mode.
 *
 * @param {Buffer} rawBuf  raw, interleaved pixels (post resize/color/flatten)
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} cfg  resolved config
 * @param {{ inputBytes:number, inputFormat:string }} ctx
 * @returns {Promise<{ data: Buffer, quality: number|null, ssim: number|null, engine: string }>}
 */
export async function encodeJpeg(rawBuf, info, cfg, ctx) {
  if (cfg.jpegEngine === 'jpeg-recompress') {
    return recompressBinary(rawBuf, info, cfg);
  }
  if (cfg.jpegMode === 'fixed') {
    const data = await encodeAt(rawBuf, info, cfg, cfg.jpegQuality);
    return { data, quality: cfg.jpegQuality, ssim: null, engine: 'sharp-fixed' };
  }
  return recompressSSIM(rawBuf, info, cfg, ctx);
}

/**
 * Adaptive SSIM-guided search (the portable jpeg-recompress replacement).
 * Finds the lowest quality in [jpegMin, jpegMax] whose SSIM >= jpegTarget.
 */
async function recompressSSIM(rawBuf, info, cfg, ctx) {
  const ref = toLuma(rawBuf, info.width, info.height, info.channels);
  const dsOpt = { downsample: cfg.jpegSsimDownsample };

  const scoreCache = new Map();
  const score = async (q) => {
    if (scoreCache.has(q)) return scoreCache.get(q);
    const data = await encodeAt(rawBuf, info, cfg, q);
    const dec = await sharp(data).raw().toBuffer({ resolveWithObject: true });
    const cand = toLuma(dec.data, dec.info.width, dec.info.height, dec.info.channels);
    const result = { data, ssim: ssim(ref, cand, info.width, info.height, dsOpt) };
    scoreCache.set(q, result);
    return result;
  };

  // Binary search for the smallest acceptable quality (size grows with quality,
  // so the smallest acceptable quality is the smallest acceptable file).
  let lo = Math.round(cfg.jpegMin);
  let hi = Math.round(cfg.jpegMax);
  let best = null;
  let bestQ = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = await score(mid);
    if (r.ssim >= cfg.jpegTarget) {
      best = r;
      bestQ = mid;
      hi = mid - 1; // acceptable — try to go smaller
    } else {
      lo = mid + 1; // too distorted — need more quality
    }
  }
  if (!best) {
    // Nothing in the band met the target; use the max-quality encoding available.
    best = await score(Math.round(cfg.jpegMax));
    bestQ = Math.round(cfg.jpegMax);
  }

  let outData = best.data;
  let outQ = bestQ;
  let outSsim = best.ssim;
  let engine = 'sharp-ssim';

  // "Larger than input" handling (2.9's behavior, hardened). Only meaningful when
  // the source was itself a JPEG. If our best encoding isn't smaller than the
  // original, try a fixed mozjpeg quality and keep whichever is smaller...
  if (ctx.inputFormat === 'jpeg' && outData.length >= ctx.inputBytes) {
    const fb = await encodeAt(rawBuf, info, cfg, cfg.jpegFallbackQuality);
    if (fb.length < outData.length) {
      outData = fb;
      outQ = cfg.jpegFallbackQuality;
      outSsim = null;
    }
    // ...and never INFLATE: if the untouched original is still smaller and the
    // pixels weren't transformed (no resize/trim/square), pass it straight
    // through. 2.9 would have written the larger re-encode here.
    if (!ctx.transformed && ctx.inputBuffer && ctx.inputBuffer.length <= outData.length) {
      outData = ctx.inputBuffer;
      outQ = null;
      outSsim = null;
      engine = 'passthrough';
    }
  }

  return { data: outData, quality: outQ, ssim: outSsim, engine };
}

/**
 * Byte-exact parity path: pipe a high-quality intermediate JPEG through the real
 * `jpeg-recompress` binary (no temp files — stdin/stdout via "-"). Requires the
 * binary on PATH; throws a clear hint otherwise.
 */
async function recompressBinary(rawBuf, info, cfg) {
  // jpeg-recompress operates on a JPEG, so feed it a high-quality intermediate.
  const intermediate = await encodeAt(rawBuf, info, cfg, cfg.jpegRecompressIntermediate);
  const args = [
    '--quality',
    cfg.jpegRecompressPreset,
    '--min',
    String(Math.round(cfg.jpegMin)),
    '--max',
    String(Math.round(cfg.jpegMax)),
    '--method',
    cfg.jpegRecompressMethod,
    '-',
    '-',
  ];
  const data = await runBinary('jpeg-recompress', args, intermediate);
  return { data, quality: null, ssim: null, engine: 'jpeg-recompress' };
}

function runBinary(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return reject(binHint(bin, err));
    }
    const out = [];
    const errOut = [];
    child.on('error', (err) => reject(binHint(bin, err)));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errOut.push(d));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(errOut).toString().trim()}`));
    });
    child.stdin.on('error', () => {}); // ignore EPIPE if the child bails early
    child.stdin.end(input);
  });
}

function binHint(bin, err) {
  if (err && err.code === 'ENOENT') {
    return new Error(
      `"${bin}" not found on PATH. Install JPEG-Archive (brew install jpeg-archive) ` +
        `or drop --jpeg-engine jpeg-recompress to use the built-in sharp-ssim engine.`
    );
  }
  return err;
}
