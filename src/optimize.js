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
//     Node and Lambda environments routinely break on — the exact "old pattern"
//     this rewrite exists to escape.

import sharp from 'sharp';
import { resolveConfig } from './config.js';

// libvips encoder "effort" ranges differ per codec; clamp so one --effort flag
// is safe across all of them.
const EFFORT_RANGE = {
  png: [1, 10],
  webp: [0, 6],
  avif: [0, 9],
};

function clampEffort(value, codec) {
  const [min, max] = EFFORT_RANGE[codec] || [0, 9];
  return Math.min(max, Math.max(min, value));
}

/**
 * Decide the target sharp format for an input.
 * @param {string} inputFormat sharp's detected format (e.g. 'jpeg','png','tiff')
 * @param {ReturnType<typeof resolveConfig>} cfg
 */
function targetFormat(inputFormat, cfg) {
  if (cfg.format) return cfg.format;
  // Real TIFFs (often masquerading as .jpg from phones/WhatsApp) -> JPEG.
  if (inputFormat === 'tiff' && cfg.tiffToJpeg) return 'jpeg';
  if (inputFormat === 'jpg') return 'jpeg';
  if (inputFormat === 'tif') return 'tiff';
  return inputFormat;
}

/** Attach the right encoder to the pipeline for the chosen format. */
function encode(pipeline, format, cfg, hasAlpha) {
  switch (format) {
    case 'jpeg':
      // JPEG has no alpha; flatten transparency onto the configured background
      // so PNG/WebP -> JPEG conversions don't turn transparent areas black.
      if (hasAlpha) pipeline = pipeline.flatten({ background: cfg.bgColor });
      return pipeline.jpeg({ quality: cfg.jpegQuality, mozjpeg: cfg.mozjpeg });
    case 'png':
      return pipeline.png({
        quality: cfg.pngQuality, // triggers libimagequant palette quantization
        palette: true,
        effort: clampEffort(cfg.effort, 'png'),
        compressionLevel: 9,
      });
    case 'webp':
      return pipeline.webp({ quality: cfg.webpQuality, effort: clampEffort(cfg.effort, 'webp') });
    case 'avif':
      return pipeline.avif({ quality: cfg.avifQuality, effort: clampEffort(cfg.effort, 'avif') });
    case 'gif':
      return pipeline.gif({ colours: cfg.gifColors });
    case 'tiff':
      return pipeline.tiff({ quality: cfg.jpegQuality, compression: 'jpeg' });
    default:
      // Unknown/unsupported (e.g. heif without delegate) — re-encode as-is.
      return pipeline;
  }
}

/**
 * Optimize a single raster image.
 *
 * @param {Buffer|Uint8Array} input  encoded image bytes
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 * @returns {Promise<{ data: Buffer, info: sharp.OutputInfo, inputFormat: string, outputFormat: string, resized: boolean }>}
 */
export async function optimizeImageBuffer(input, options = {}) {
  const cfg = options.__resolved ? options : resolveConfig(options);

  // failOn:'none' makes sharp tolerant of slightly-truncated/quirky files rather
  // than throwing — corrupt files are surfaced by the caller, not by a hard crash.
  const probe = sharp(input, { failOn: 'none' });
  const meta = await probe.metadata();
  const inputFormat = meta.format || 'unknown';

  const isAnimated = (meta.pages || 1) > 1 && (inputFormat === 'gif' || inputFormat === 'webp');
  const format = targetFormat(inputFormat, cfg);
  // Animation only survives within gif<->webp; collapse to first frame otherwise.
  const keepAnimation = isAnimated && (format === 'gif' || format === 'webp');

  let pipeline = sharp(input, { failOn: 'none', animated: keepAnimation });

  // 1) Color: normalize working space to sRGB. This is the in-memory replacement
  //    for the old CMYK->RGB temp-file dance. sharp honors any embedded ICC
  //    profile on the way in, then converts to sRGB.
  if (cfg.colorspace) pipeline = pipeline.toColorspace(cfg.colorspace);

  // 2) Geometry.
  const overMax =
    cfg.maxSize > 0 && ((meta.width || 0) > cfg.maxSize || (meta.height || 0) > cfg.maxSize);
  let resized = false;
  if (cfg.square && cfg.maxSize > 0) {
    // Pad to a maxSize x maxSize canvas (replaces 2.9's manual extend() math).
    pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, {
      fit: 'contain',
      background: cfg.bgColor,
      withoutEnlargement: false,
    });
    resized = true;
  } else if (overMax) {
    pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    resized = true;
  }
  if (cfg.trim && !cfg.square) pipeline = pipeline.trim();

  // 3) Metadata: strip by default (smaller); re-embed sRGB ICC + EXIF if asked.
  if (cfg.keepMetadata) pipeline = pipeline.withMetadata({ icc: 'srgb' });

  // 4) Encode.
  pipeline = encode(pipeline, format, cfg, Boolean(meta.hasAlpha));

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, info, inputFormat, outputFormat: format, resized };
}
