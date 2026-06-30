// Raster image optimization core. Pure buffer-in / buffer-out — no filesystem,
// no cwd, no globals — so it runs identically in the CLI, as a library call, and
// inside an AWS Lambda. This is the consolidation of 2.9's processImageSharp() +
// the imagemin compression pass into a single sharp pipeline.
//
// Why sharp-only (no imagemin):
//   - mozjpeg, libimagequant (the pngquant replacement), and gifsicle-class GIF
//     handling are all built into libvips, which sharp ships as a prebuilt
//     binary that also works on AWS Lambda.
//   - imagemin's plugin chain relied on bin-wrapper global binaries that newer
//     Node and Lambda environments routinely break on.
//
// JPEG specifically is NOT a fixed-quality encode: it goes through the adaptive
// SSIM-guided search in jpeg.js, reproducing 2.9's jpeg-recompress behavior.

import sharp from 'sharp';
import { resolveConfig } from './config.js';
import { encodeJpeg } from './jpeg.js';

const EFFORT_RANGE = {
  png: [1, 10],
  webp: [0, 6],
  avif: [0, 9],
};

function clampEffort(value, codec) {
  const [min, max] = EFFORT_RANGE[codec] || [0, 9];
  return Math.min(max, Math.max(min, value));
}

function targetFormat(inputFormat, cfg) {
  if (cfg.format) return cfg.format;
  if (inputFormat === 'tiff' && cfg.tiffToJpeg) return 'jpeg';
  if (inputFormat === 'jpg') return 'jpeg';
  if (inputFormat === 'tif') return 'tiff';
  return inputFormat;
}

/** Encode a non-JPEG format from a raw pixel buffer. */
function encodeRawNonJpeg(rawBuf, info, format, cfg) {
  let img = sharp(rawBuf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  switch (format) {
    case 'png':
      return img
        .png({ quality: cfg.pngQuality, palette: true, effort: clampEffort(cfg.effort, 'png'), compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
    case 'webp':
      return img
        .webp({ quality: cfg.webpQuality, effort: clampEffort(cfg.effort, 'webp') })
        .toBuffer({ resolveWithObject: true });
    case 'avif':
      return img
        .avif({ quality: cfg.avifQuality, effort: clampEffort(cfg.effort, 'avif') })
        .toBuffer({ resolveWithObject: true });
    case 'gif':
      return img.gif({ colours: cfg.gifColors }).toBuffer({ resolveWithObject: true });
    case 'tiff':
      return img.tiff({ quality: cfg.jpegQuality, compression: 'jpeg' }).toBuffer({ resolveWithObject: true });
    default:
      return img.toBuffer({ resolveWithObject: true });
  }
}

/**
 * Build the geometry/color processing stage (shared by raw and animated paths).
 * @returns {{ pipeline: sharp.Sharp, resized: boolean }}
 */
function buildPipeline(input, meta, cfg, animated) {
  let pipeline = sharp(input, { failOn: 'none', animated });
  if (cfg.colorspace) pipeline = pipeline.toColorspace(cfg.colorspace);

  const overMax =
    cfg.maxSize > 0 && ((meta.width || 0) > cfg.maxSize || (meta.height || 0) > cfg.maxSize);
  let resized = false;
  if (cfg.square && cfg.maxSize > 0) {
    pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, { fit: 'contain', background: cfg.bgColor });
    resized = true;
  } else if (overMax) {
    pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, { fit: 'inside', withoutEnlargement: true });
    resized = true;
  }
  if (cfg.trim && !cfg.square) pipeline = pipeline.trim();
  return { pipeline, resized };
}

/** Direct encode path for animated GIF/WebP (no raw round-trip, no SSIM search). */
async function optimizeAnimated(input, meta, cfg, format, resized, pipeline) {
  if (cfg.keepMetadata) pipeline = pipeline.withMetadata({ icc: 'srgb' });
  if (format === 'webp') pipeline = pipeline.webp({ quality: cfg.webpQuality, effort: clampEffort(cfg.effort, 'webp') });
  else pipeline = pipeline.gif({ colours: cfg.gifColors });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, info, inputFormat: meta.format, outputFormat: format, resized, quality: null };
}

/**
 * Optimize a single raster image.
 *
 * @param {Buffer|Uint8Array} input  encoded image bytes
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 * @returns {Promise<{ data: Buffer, info: sharp.OutputInfo, inputFormat: string, outputFormat: string, resized: boolean, quality: number|null, ssim?: number|null }>}
 */
export async function optimizeImageBuffer(input, options = {}) {
  const cfg = options.__resolved ? options : resolveConfig(options);
  const inputBuf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const meta = await sharp(inputBuf, { failOn: 'none' }).metadata();
  const inputFormat = meta.format || 'unknown';
  const isAnimated = (meta.pages || 1) > 1 && (inputFormat === 'gif' || inputFormat === 'webp');
  const format = targetFormat(inputFormat, cfg);
  const keepAnimation = isAnimated && (format === 'gif' || format === 'webp');

  const { pipeline, resized } = buildPipeline(inputBuf, meta, cfg, keepAnimation);

  if (keepAnimation) {
    return optimizeAnimated(inputBuf, meta, cfg, format, resized, pipeline);
  }

  // Flatten alpha for JPEG (no alpha channel) onto the configured background, so
  // transparent regions don't go black on PNG/WebP -> JPEG conversions.
  let prepared = pipeline;
  if (format === 'jpeg' && meta.hasAlpha) prepared = prepared.flatten({ background: cfg.bgColor });

  // Decode to raw pixels once, so the JPEG quality search can re-encode many
  // candidates without redoing resize/colour each time.
  const { data: rawBuf, info: rawInfo } = await prepared.raw().toBuffer({ resolveWithObject: true });

  if (format === 'jpeg') {
    const ctx = {
      inputBytes: inputBuf.length,
      inputFormat,
      inputBuffer: inputBuf,
      // Only safe to pass the original through untouched if we didn't change pixels.
      transformed: resized || cfg.trim || cfg.square,
    };
    const r = await encodeJpeg(rawBuf, rawInfo, cfg, ctx);
    const info = await sharp(r.data).metadata();
    return {
      data: r.data,
      info: { format: 'jpeg', width: info.width, height: info.height, size: r.data.length },
      inputFormat,
      outputFormat: 'jpeg',
      resized,
      quality: r.quality,
      ssim: r.ssim,
      engine: r.engine,
    };
  }

  const { data, info } = await encodeRawNonJpeg(rawBuf, rawInfo, format, cfg);
  return { data, info, inputFormat, outputFormat: format, resized, quality: null };
}
