// Shared "perceptually lossless, content-aware" driver for the modern lossy
// codecs (WebP, AVIF). The goal — the same one the JPEG path serves — is the
// SMALLEST encoding that is perceptually indistinguishable from the source.
//
// One setting never fits every input: a photo wants lossy (tiny, visually
// identical); a flat graphic wants lossless (crisp, exact, and usually smaller
// at the quality graphics need). Rather than guess from the extension, classify
// the decoded pixels and then keep the smallest candidate that clears the SSIM
// quality bar — lossless always "passes" (it's exact), lossy must earn it.

import { toLuma } from './ssim.js';
import { searchQuality } from './lossy-search.js';

/**
 * Photographic (continuous tone -> lossy wins) vs graphic (few colours / flat ->
 * lossless wins). A JPEG source is photographic by definition; otherwise sample
 * distinct colours.
 */
export function classify(inputFormat, rawBuf, info, colorCap) {
  const hasAlpha = info.channels === 4;
  if (inputFormat === 'jpeg') return { photographic: true, hasAlpha };

  const px = info.width * info.height;
  const step = Math.max(1, Math.floor(px / 25000)); // sample ~25k pixels
  const seen = new Set();
  for (let i = 0; i < px && seen.size <= colorCap; i += step) {
    const p = i * info.channels;
    seen.add((rawBuf[p] << 16) | (rawBuf[p + 1] << 8) | rawBuf[p + 2]);
  }
  return { photographic: seen.size > colorCap, hasAlpha, colorCount: seen.size };
}

/**
 * @param {object} o
 * @param {string} o.inputFormat
 * @param {Buffer} o.rawBuf
 * @param {{width:number,height:number,channels:number}} o.info
 * @param {number} o.target        perceptual SSIM bar (perceptuallyLossless)
 * @param {boolean} o.downsample
 * @param {number} o.min           lossy quality search floor
 * @param {number} o.max           lossy quality search ceiling
 * @param {number} o.colorCap      distinct-colour threshold for photographic
 * @param {(q:number)=>Promise<Buffer>} o.encodeLossy
 * @param {()=>Promise<Buffer>} o.encodeLossless
 * @returns {Promise<{ data: Buffer, mode: 'lossy'|'lossless', quality: number|null, ssim: number|null }>}
 */
export async function contentAwareEncode(o) {
  const refLuma = toLuma(o.rawBuf, o.info.width, o.info.height, o.info.channels);

  const lossyCandidate = async () => {
    const r = await searchQuality({
      encode: o.encodeLossy,
      refLuma,
      width: o.info.width,
      height: o.info.height,
      min: o.min,
      max: o.max,
      target: o.target,
      downsample: o.downsample,
    });
    return { data: r.data, mode: 'lossy', quality: r.quality, ssim: r.ssim };
  };

  const cls = classify(o.inputFormat, o.rawBuf, o.info, o.colorCap);
  const candidates = [];

  if (cls.photographic) {
    // Continuous tone: lossy is the right tool (lossless would be huge).
    candidates.push(await lossyCandidate());
  } else {
    // Graphic / flat: lossless is usually smallest AND exact. Try a lossy
    // challenger too, but only keep it if it's also perceptually lossless.
    candidates.push({ data: await o.encodeLossless(), mode: 'lossless', quality: null, ssim: 1 });
    const lossy = await lossyCandidate();
    if (lossy.ssim == null || lossy.ssim >= o.target) candidates.push(lossy);
  }

  candidates.sort((a, b) => a.data.length - b.data.length);
  return candidates[0];
}
