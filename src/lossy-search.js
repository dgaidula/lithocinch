// Generic "find the smallest acceptable quality" search, shared by the JPEG and
// WebP encoders (and ready for AVIF). Given an encode(quality) function and a
// reference luma plane, it binary-searches the quality band for the lowest
// quality whose SSIM vs the source still clears the target — the core of
// jpeg-recompress-style adaptive, per-file compression.

import sharp from 'sharp';

import { ssim, toLuma } from './ssim.js';

/**
 * @param {object} o
 * @param {(quality:number)=>Promise<Buffer>} o.encode  encode at a given quality
 * @param {Float32Array} o.refLuma  source luma plane
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.min  quality search floor
 * @param {number} o.max  quality search ceiling
 * @param {number} o.target  minimum acceptable SSIM
 * @param {boolean} [o.downsample]  SSIM auto-downsample (faster)
 * @returns {Promise<{ data: Buffer, quality: number, ssim: number }>}
 */
export async function searchQuality({ encode, refLuma, width, height, min, max, target, downsample, decodeOpts = {} }) {
  const cache = new Map();
  const score = async (q) => {
    if (cache.has(q)) return cache.get(q);
    const data = await encode(q);
    // decodeOpts lets animated candidates decode all frames (the strip) so SSIM
    // is measured across the whole animation, not just the first frame.
    const dec = await sharp(data, decodeOpts).raw().toBuffer({ resolveWithObject: true });
    const cand = toLuma(dec.data, dec.info.width, dec.info.height, dec.info.channels);
    const r = { data, ssim: ssim(refLuma, cand, width, height, { downsample }) };
    cache.set(q, r);
    return r;
  };

  let lo = Math.round(min);
  let hi = Math.round(max);
  let best = null;
  let bestQ = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = await score(mid);
    if (r.ssim >= target) {
      best = r;
      bestQ = mid;
      hi = mid - 1; // acceptable — try smaller (smaller file)
    } else {
      lo = mid + 1; // too distorted — need more quality
    }
  }
  if (!best) {
    bestQ = Math.round(max);
    best = await score(bestQ); // nothing met target — use the ceiling
  }
  return { data: best.data, quality: bestQ, ssim: best.ssim };
}

/** SSIM of an already-encoded image buffer vs a reference luma plane. */
export async function ssimOfEncoded(buffer, refLuma, width, height, downsample) {
  const dec = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const cand = toLuma(dec.data, dec.info.width, dec.info.height, dec.info.channels);
  return ssim(refLuma, cand, width, height, { downsample });
}
