// Content-aware WebP encoding. See content-aware.js for the strategy; this file
// just supplies the WebP-specific encoders and config. `auto` keeps the smallest
// candidate that is perceptually lossless (lossy for photos, lossless for
// graphics — decided by measurement, not by the source extension).

import sharp from 'sharp';

import { contentAwareEncode } from './content-aware.js';

const clampEffort = (v) => Math.min(6, Math.max(0, Math.round(v)));

function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, { raw: { width: info.width, height: info.height, channels: info.channels } });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

const encodeLossy = (rawBuf, info, cfg, quality) =>
  fromRaw(rawBuf, info, cfg)
    .webp({ quality, alphaQuality: cfg.webpAlphaQuality, effort: clampEffort(cfg.webpEffort), smartSubsample: true })
    .toBuffer();

const encodeLossless = (rawBuf, info, cfg) =>
  fromRaw(rawBuf, info, cfg).webp({ lossless: true, effort: clampEffort(cfg.webpEffort), quality: cfg.webpQuality }).toBuffer();

const encodeNearLossless = (rawBuf, info, cfg) =>
  fromRaw(rawBuf, info, cfg).webp({ nearLossless: true, quality: cfg.webpNearLosslessQuality, effort: clampEffort(cfg.webpEffort) }).toBuffer();

/** @returns {Promise<{ data: Buffer, mode: string, quality: number|null, ssim: number|null }>} */
export async function encodeWebp(rawBuf, info, cfg, ctx) {
  if (cfg.webpMode === 'lossless') {
    return { data: await encodeLossless(rawBuf, info, cfg), mode: 'lossless', quality: null, ssim: 1 };
  }
  if (cfg.webpMode === 'near-lossless') {
    return { data: await encodeNearLossless(rawBuf, info, cfg), mode: 'near-lossless', quality: cfg.webpNearLosslessQuality, ssim: null };
  }
  if (cfg.webpMode === 'lossy') {
    return contentAwareEncode({
      inputFormat: 'jpeg', // force the photographic/lossy-only branch
      rawBuf,
      info,
      target: cfg.webpTargetSsim,
      downsample: cfg.webpSsimDownsample,
      min: cfg.webpMin,
      max: cfg.webpMax,
      colorCap: cfg.webpGraphicColorCap,
      encodeLossy: (q) => encodeLossy(rawBuf, info, cfg, q),
      encodeLossless: () => encodeLossless(rawBuf, info, cfg),
    });
  }

  return contentAwareEncode({
    inputFormat: ctx.inputFormat,
    rawBuf,
    info,
    target: cfg.webpTargetSsim,
    downsample: cfg.webpSsimDownsample,
    min: cfg.webpMin,
    max: cfg.webpMax,
    colorCap: cfg.webpGraphicColorCap,
    encodeLossy: (q) => encodeLossy(rawBuf, info, cfg, q),
    encodeLossless: () => encodeLossless(rawBuf, info, cfg),
  });
}
