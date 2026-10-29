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
import { encodePng } from './png.js';
import { encodeWebp } from './webp.js';
import { encodeAvif } from './avif.js';
import { finalizeGif } from './gif.js';
import { pickBestFormat } from './best-format.js';
import { contentAwareEncode } from './content-aware.js';
import { ssim, toLuma } from './ssim.js';
import { applyDensity } from './density.js';

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
    // PNG is handled separately (encodePng, with its SSIM gate) in the caller.
    case 'webp':
      return img
        .webp({ quality: cfg.webpQuality, effort: clampEffort(cfg.effort, 'webp') })
        .toBuffer({ resolveWithObject: true });
    case 'avif':
      return img
        .avif({ quality: cfg.avifQuality, effort: clampEffort(cfg.effort, 'avif') })
        .toBuffer({ resolveWithObject: true });
    case 'gif':
      // gifsicle replacement: libimagequant palette + max effort (2.9 used
      // gifsicle's default -O1; sharp at high effort is equal-or-better for most).
      return img
        .gif({ colours: cfg.gifColors, dither: cfg.gifDither, effort: clampEffort(cfg.gifEffort, 'png') })
        .toBuffer({ resolveWithObject: true });
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

  let resized = false;
  if (cfg.width || cfg.height) {
    // Explicit transform resize (CMS / transform API). Takes precedence over maxSize.
    pipeline = applyExplicitResize(pipeline, meta, cfg, animated);
    resized = true;
  } else {
    const overMax =
      cfg.maxSize > 0 && ((meta.width || 0) > cfg.maxSize || (meta.height || 0) > cfg.maxSize);
    if (cfg.square && cfg.maxSize > 0) {
      pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, { fit: 'contain', background: cfg.bgColor });
      resized = true;
    } else if (overMax) {
      pipeline = pipeline.resize(cfg.maxSize, cfg.maxSize, { fit: 'inside', withoutEnlargement: true });
      resized = true;
    }
  }
  if (cfg.trim && !cfg.square && !(cfg.width || cfg.height)) pipeline = pipeline.trim();
  return { pipeline, resized };
}

/** Explicit width/height resize with fit/position, and focal-point crop for cover. */
function applyExplicitResize(pipeline, meta, cfg, animated) {
  const w = cfg.width || null;
  const h = cfg.height || null;
  const fit = cfg.fit || 'cover';
  const withoutEnlargement = cfg.withoutEnlargement !== false;

  // Focal-point crop: scale to cover the target, then extract a window centered
  // on the focal point. Static images only (extract on animated strips is unsafe).
  if (cfg.focal && fit === 'cover' && w && h && (meta.pages || 1) <= 1 && meta.width && meta.height) {
    const scale = Math.max(w / meta.width, h / meta.height);
    const sw = Math.max(w, Math.round(meta.width * scale));
    const sh = Math.max(h, Math.round(meta.height * scale));
    const fx = clamp01(cfg.focal.x ?? 0.5);
    const fy = clamp01(cfg.focal.y ?? 0.5);
    const left = Math.max(0, Math.min(sw - w, Math.round(fx * sw - w / 2)));
    const top = Math.max(0, Math.min(sh - h, Math.round(fy * sh - h / 2)));
    return pipeline.resize(sw, sh).extract({ left, top, width: w, height: h });
  }

  const opts = { fit, withoutEnlargement };
  if (fit === 'cover' || fit === 'contain') opts.position = cfg.position || 'centre';
  if (fit === 'contain') opts.background = cfg.bgColor;
  return pipeline.resize(w, h, opts);
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));

// Compatibility rank for the animated tie-break (lower = more universal). GIF is
// universal; animated WebP is broadly but not universally supported.
const ANIM_RANK = { gif: 0, webp: 1 };

/**
 * Animated GIF/WebP path. `format` is 'gif', 'webp', or 'auto'. For 'auto' it
 * runs a real WebP-vs-GIF shootout (AVIF is excluded — libheif animation is
 * unreliable), scoring SSIM across ALL frames. Content-aware WebP (lossy search
 * vs lossless) + lossless gifsicle GIF, smallest perceptually-OK candidate wins.
 */
async function optimizeAnimated(input, meta, cfg, format, resized, pipeline) {
  if (cfg.keepMetadata) pipeline = pipeline.withMetadata({ icc: 'srgb' });

  // Decode the processed frame strip once: the reference for SSIM + classify.
  const ref = await pipeline.clone().raw().toBuffer({ resolveWithObject: true });
  const sInfo = ref.info; // { width, height: pageHeight*pages, channels }
  const refLuma = toLuma(ref.data, sInfo.width, sInfo.height, sInfo.channels);
  const scoreOf = async (buf) => {
    const d = await sharp(buf, { animated: true }).raw().toBuffer({ resolveWithObject: true });
    const got = toLuma(d.data, d.info.width, d.info.height, d.info.channels);
    return ssim(refLuma, got, sInfo.width, sInfo.height, { downsample: cfg.webpSsimDownsample });
  };

  const wEffort = Math.min(6, Math.max(0, cfg.webpEffort));
  const makeWebp = async () => {
    const r = await contentAwareEncode({
      inputFormat: meta.format,
      rawBuf: ref.data,
      info: sInfo,
      target: cfg.webpTargetSsim,
      downsample: cfg.webpSsimDownsample,
      min: cfg.webpMin,
      max: cfg.webpMax,
      colorCap: cfg.webpGraphicColorCap,
      decodeOpts: { animated: true },
      encodeLossy: (q) => pipeline.clone().webp({ quality: q, alphaQuality: cfg.webpAlphaQuality, effort: wEffort, smartSubsample: true }).toBuffer(),
      encodeLossless: () => pipeline.clone().webp({ lossless: true, effort: wEffort, quality: cfg.webpQuality }).toBuffer(),
    });
    return { data: r.data, format: 'webp', ssim: r.mode === 'lossy' ? r.ssim : 1, engine: `webp-${r.mode}` };
  };
  const makeGif = async () => {
    const g = await pipeline
      .clone()
      .gif({ colours: cfg.gifColors, dither: cfg.gifDither, effort: Math.min(10, Math.max(1, cfg.gifEffort)) })
      .toBuffer();
    const fin = await finalizeGif(g, cfg); // lossless gifsicle -O3 when available
    return { data: fin.data, format: 'gif', ssim: await scoreOf(fin.data), engine: fin.engine };
  };

  const candidates = [];
  if (format === 'gif') candidates.push(await makeGif());
  else if (format === 'webp') candidates.push(await makeWebp());
  else candidates.push(await makeWebp(), await makeGif()); // auto

  // Untouched original (never inflate) when it could be the output and we didn't resize.
  if (!resized && (format === 'auto' || meta.format === format)) {
    candidates.push({ data: input, format: meta.format, ssim: 1, engine: 'passthrough', original: true });
  }

  // Smallest that clears the perceptual bar; tie-break toward the more compatible.
  let pool = candidates.filter((c) => c.ssim == null || c.ssim >= cfg.perceptualTarget);
  if (!pool.length) pool = candidates;
  pool.sort((a, b) => a.data.length - b.data.length);
  const ceiling = pool[0].data.length * (1 + cfg.formatTolerance);
  const within = pool.filter((c) => c.data.length <= ceiling);
  within.sort((a, b) => (ANIM_RANK[a.format] ?? 9) - (ANIM_RANK[b.format] ?? 9) || a.data.length - b.data.length);
  const win = within[0];

  const m = await sharp(win.data).metadata();
  return {
    data: win.data,
    info: { format: win.format, width: m.width, height: m.height, size: win.data.length },
    inputFormat: meta.format,
    outputFormat: win.format,
    resized,
    quality: null,
    ssim: win.original || win.ssim === 1 ? null : win.ssim,
    engine: win.original ? 'passthrough' : win.engine,
  };
}

/**
 * Optimize a single raster image.
 *
 * With `density` set, the finished output's resolution header is rewritten
 * (density.js) and the result carries `density`: `{ applied, ppi, patched,
 * unpatched }`, or `{ applied: false, ppi, reason }` when the chosen output
 * can't hold one (WebP, AVIF, GIF, TIFF). The data is then left as encoded.
 *
 * @param {Buffer|Uint8Array} input  encoded image bytes
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 * @returns {Promise<{ data: Buffer, info: sharp.OutputInfo, inputFormat: string, outputFormat: string, resized: boolean, quality: number|null, ssim?: number|null, density?: object }>}
 */
export async function optimizeImageBuffer(input, options = {}) {
  const cfg = options.__resolved ? options : resolveConfig(options);
  const result = await optimizeRaster(input, { ...cfg, __resolved: true });
  if (cfg.density == null) return result;
  const { data, ...density } = applyDensity(result.data, result.outputFormat, cfg.density);
  return {
    ...result,
    data,
    info: { ...result.info, size: data.length },
    density,
  };
}

async function optimizeRaster(input, options) {
  const cfg = options;
  const inputBuf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const meta = await sharp(inputBuf, { failOn: 'none' }).metadata();
  const inputFormat = meta.format || 'unknown';
  const isAnimated = (meta.pages || 1) > 1 && (inputFormat === 'gif' || inputFormat === 'webp');
  // `--format auto` picks the best format per image. Static auto runs the
  // candidate shootout here; animated auto runs a WebP-vs-GIF shootout in
  // optimizeAnimated (which understands 'auto').
  const autoStatic = cfg.format === 'auto' && !isAnimated;
  const format = cfg.format === 'auto' ? 'auto' : targetFormat(inputFormat, cfg);
  const keepAnimation = isAnimated && (format === 'gif' || format === 'webp' || format === 'auto');

  const { pipeline, resized } = buildPipeline(inputBuf, meta, cfg, keepAnimation);
  // Pixels are only "untransformed" (so the original may be passed straight
  // through) when we didn't resize/trim/pad.
  const transformed = resized || cfg.trim || cfg.square;

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

  if (autoStatic) {
    const ctx = { inputFormat, inputBytes: inputBuf.length, inputBuffer: inputBuf, transformed };
    const r = await pickBestFormat(rawBuf, rawInfo, cfg, ctx);
    const m = await sharp(r.data).metadata();
    return {
      data: r.data,
      info: { format: r.outputFormat, width: m.width, height: m.height, size: r.data.length },
      inputFormat,
      outputFormat: r.outputFormat,
      resized,
      quality: null,
      ssim: r.ssim ?? null,
      engine: r.engine,
    };
  }

  if (format === 'jpeg') {
    const ctx = { inputBytes: inputBuf.length, inputFormat, inputBuffer: inputBuf, transformed };
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

  let data;
  let info;
  let quality = null;
  let ssimOut = null;
  let engine = 'sharp';
  if (format === 'png') {
    const r = await encodePng(rawBuf, rawInfo, cfg);
    data = r.data;
    engine = r.engine;
    quality = r.quality ?? null;
    ssimOut = r.ssim ?? null;
    const m = await sharp(data).metadata();
    info = { format: 'png', width: m.width, height: m.height, size: data.length };
  } else if (format === 'gif') {
    const sharpGif = (await encodeRawNonJpeg(rawBuf, rawInfo, 'gif', cfg)).data;
    const g = await finalizeGif(sharpGif, cfg);
    data = g.data;
    engine = g.engine;
    const m = await sharp(data).metadata();
    info = { format: 'gif', width: m.width, height: m.height, size: data.length };
  } else if (format === 'webp') {
    const r = await encodeWebp(rawBuf, rawInfo, cfg, { inputFormat });
    data = r.data;
    quality = r.quality ?? null;
    ssimOut = r.ssim ?? null;
    engine = `webp-${r.mode}`; // e.g. webp-lossy / webp-lossless (shown in --verbose)
    const m = await sharp(data).metadata();
    info = { format: 'webp', width: m.width, height: m.height, size: data.length };
  } else if (format === 'avif') {
    const r = await encodeAvif(rawBuf, rawInfo, cfg, { inputFormat });
    data = r.data;
    quality = r.quality ?? null;
    ssimOut = r.ssim ?? null;
    engine = `avif-${r.mode}`;
    const m = await sharp(data).metadata();
    info = { format: 'avif', width: m.width, height: m.height, size: data.length };
  } else {
    ({ data, info } = await encodeRawNonJpeg(rawBuf, rawInfo, format, cfg));
  }

  // Universal never-inflate guard (mirrors pngquant's "keep the original if it
  // can't do better"): if we didn't transform the pixels and the re-encode isn't
  // smaller than the source of the same format, pass the original through.
  if (!transformed && format === inputFormat && data.length >= inputBuf.length) {
    return {
      data: inputBuf,
      info: { format: inputFormat, width: meta.width, height: meta.height, size: inputBuf.length },
      inputFormat,
      outputFormat: format,
      resized,
      quality: null,
      engine: 'passthrough',
    };
  }

  return { data, info, inputFormat, outputFormat: format, resized, quality, ssim: ssimOut, engine };
}
