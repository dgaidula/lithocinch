// Content-aware WebP encoding.
//
// The hard part of "just add WebP" is that one setting never fits all inputs:
//   - a photo (or a JPEG source) wants *lossy* WebP — tiny, visually identical;
//   - a flat graphic / screenshot / logo (often a PNG) wants *lossless* (or
//     near-lossless) WebP — crisp edges, no ringing, and frequently smaller than
//     lossy at the high quality those images need to look right.
// Picking wrong gives you either blurry graphics or bloated photos.
//
// Instead of guessing from the file extension, the `auto` mode here:
//   1. classifies the decoded pixels as photographic vs graphic (with a hint
//      from the source format), then
//   2. encodes the candidate modes that make sense for that class and keeps the
//      SMALLEST output that still clears an SSIM quality bar.
// Lossless always "passes" (it's exact), so for graphics it wins only when it's
// actually smaller; for photos the quality-searched lossy candidate wins.

import sharp from 'sharp';

import { toLuma } from './ssim.js';
import { searchQuality } from './lossy-search.js';

const clampWebpEffort = (v) => Math.min(6, Math.max(0, Math.round(v)));

function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

/**
 * Classify the decoded image. Photographic = many distinct colours / continuous
 * tone (lossy wins); graphic = limited palette / flat regions (lossless wins).
 */
function classify(inputFormat, rawBuf, info, cfg) {
  const hasAlpha = info.channels === 4;
  // A JPEG source is, by definition, continuous-tone photographic content.
  if (inputFormat === 'jpeg') return { photographic: true, hasAlpha };

  // Otherwise sample distinct colours. Few colours => graphic.
  const px = info.width * info.height;
  const step = Math.max(1, Math.floor(px / 25000)); // sample ~25k pixels
  const cap = cfg.webpGraphicColorCap;
  const seen = new Set();
  for (let i = 0; i < px && seen.size <= cap; i += step) {
    const p = i * info.channels;
    seen.add((rawBuf[p] << 16) | (rawBuf[p + 1] << 8) | rawBuf[p + 2]);
  }
  return { photographic: seen.size > cap, hasAlpha, colorCount: seen.size };
}

function encodeLossy(rawBuf, info, cfg, quality) {
  return fromRaw(rawBuf, info, cfg)
    .webp({
      quality,
      alphaQuality: cfg.webpAlphaQuality,
      effort: clampWebpEffort(cfg.webpEffort),
      smartSubsample: true,
    })
    .toBuffer();
}

function encodeLossless(rawBuf, info, cfg) {
  return fromRaw(rawBuf, info, cfg)
    .webp({ lossless: true, effort: clampWebpEffort(cfg.webpEffort), quality: cfg.webpQuality })
    .toBuffer();
}

function encodeNearLossless(rawBuf, info, cfg) {
  return fromRaw(rawBuf, info, cfg)
    .webp({ nearLossless: true, quality: cfg.webpNearLosslessQuality, effort: clampWebpEffort(cfg.webpEffort) })
    .toBuffer();
}

/** Quality-searched lossy candidate (smallest lossy that clears the target). */
async function lossyCandidate(rawBuf, info, cfg, refLuma) {
  const r = await searchQuality({
    encode: (q) => encodeLossy(rawBuf, info, cfg, q),
    refLuma,
    width: info.width,
    height: info.height,
    min: cfg.webpMin,
    max: cfg.webpMax,
    target: cfg.webpTargetSsim,
    downsample: cfg.webpSsimDownsample,
  });
  return { data: r.data, mode: 'lossy', quality: r.quality, ssim: r.ssim };
}

/**
 * Encode WebP from raw pixels.
 * @param {{ inputFormat: string }} ctx
 * @returns {Promise<{ data: Buffer, mode: string, quality: number|null, ssim: number|null }>}
 */
export async function encodeWebp(rawBuf, info, cfg, ctx) {
  const refLuma = () => toLuma(rawBuf, info.width, info.height, info.channels);

  if (cfg.webpMode === 'lossless') {
    return { data: await encodeLossless(rawBuf, info, cfg), mode: 'lossless', quality: null, ssim: 1 };
  }
  if (cfg.webpMode === 'near-lossless') {
    return { data: await encodeNearLossless(rawBuf, info, cfg), mode: 'near-lossless', quality: cfg.webpNearLosslessQuality, ssim: null };
  }
  if (cfg.webpMode === 'lossy') {
    return lossyCandidate(rawBuf, info, cfg, refLuma());
  }

  // --- auto: classify, build a candidate set, keep the smallest that passes ---
  const cls = classify(ctx.inputFormat, rawBuf, info, cfg);
  const candidates = [];

  if (cls.photographic) {
    // Continuous tone: lossy is the right tool. (Lossless would be huge.)
    candidates.push(await lossyCandidate(rawBuf, info, cfg, refLuma()));
  } else {
    // Graphic / flat: lossless is usually smallest AND exact. Also try a lossy
    // candidate in case the "graphic" actually has enough tone to favor lossy.
    candidates.push({ data: await encodeLossless(rawBuf, info, cfg), mode: 'lossless', quality: null, ssim: 1 });
    const lossy = await lossyCandidate(rawBuf, info, cfg, refLuma());
    if (lossy.ssim == null || lossy.ssim >= cfg.webpTargetSsim) candidates.push(lossy);
  }

  candidates.sort((a, b) => a.data.length - b.data.length);
  return candidates[0];
}
