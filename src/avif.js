// Content-aware AVIF encoding — same perceptually-lossless strategy as WebP
// (see content-aware.js), supplying AVIF-specific encoders. AVIF is delivered by
// libvips through libheif/AV1; it's available in the prebuilt sharp binary
// (unlike JPEG XL), so it works on a bare Lambda too.
//
// AVIF typically beats WebP at the same perceptual quality, especially on photos,
// but is slower to encode — hence its own effort knob.

import sharp from 'sharp';

import { contentAwareEncode } from './content-aware.js';

const clampEffort = (v) => Math.min(9, Math.max(0, Math.round(v)));

function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, { raw: { width: info.width, height: info.height, channels: info.channels } });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

const encodeLossy = (rawBuf, info, cfg, quality) =>
  fromRaw(rawBuf, info, cfg).avif({ quality, effort: clampEffort(cfg.avifEffort) }).toBuffer();

const encodeLossless = (rawBuf, info, cfg) =>
  fromRaw(rawBuf, info, cfg).avif({ lossless: true, effort: clampEffort(cfg.avifEffort) }).toBuffer();

/** @returns {Promise<{ data: Buffer, mode: string, quality: number|null, ssim: number|null }>} */
export async function encodeAvif(rawBuf, info, cfg, ctx) {
  if (cfg.avifMode === 'lossless') {
    return { data: await encodeLossless(rawBuf, info, cfg), mode: 'lossless', quality: null, ssim: 1 };
  }
  if (cfg.avifMode === 'lossy') {
    return contentAwareEncode({
      inputFormat: 'jpeg', // force lossy-only branch
      rawBuf,
      info,
      target: cfg.avifTargetSsim,
      downsample: cfg.avifSsimDownsample,
      min: cfg.avifMin,
      max: cfg.avifMax,
      colorCap: cfg.avifGraphicColorCap,
      encodeLossy: (q) => encodeLossy(rawBuf, info, cfg, q),
      encodeLossless: () => encodeLossless(rawBuf, info, cfg),
    });
  }

  return contentAwareEncode({
    inputFormat: ctx.inputFormat,
    rawBuf,
    info,
    target: cfg.avifTargetSsim,
    downsample: cfg.avifSsimDownsample,
    min: cfg.avifMin,
    max: cfg.avifMax,
    colorCap: cfg.avifGraphicColorCap,
    encodeLossy: (q) => encodeLossy(rawBuf, info, cfg, q),
    encodeLossless: () => encodeLossless(rawBuf, info, cfg),
  });
}
