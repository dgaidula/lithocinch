// Central configuration for process-images.
//
// This object is the single source of truth for every tunable that used to be a
// hard-coded `const`/`var` at the top of process-images-2.9.js. The CLI, the
// library API, and the Lambda handler all start from these defaults and merge
// user-supplied overrides on top. See NOTES.md for the full old-var -> option map.

/** @typedef {{ r:number, g:number, b:number, alpha:number }} RGBA */

export const DEFAULTS = Object.freeze({
  // ---- input / output layout ----
  input: '.', // directory to read from (was implicit cwd)
  output: '../img-optimize-output/', // was const outPath
  errorDir: '../img-optimize-error/', // was const errorPath
  suffix: '_opt', // was const outputAppend
  overwrite: false, // was const overwriteFiles
  flatten: false, // NEW: drop the source subdir tree, write everything flat

  // ---- resize / geometry ----
  maxSize: 2560, // was const maxSize; 0 disables resizing (was the 2.8 "skip maxSize" switch)
  square: false, // was const onSquare (pad to a maxSize x maxSize square)
  bgColor: { r: 255, g: 255, b: 255, alpha: 1 }, // was const bgColor (used by square)
  trim: false, // was const trimWhiteSpace

  // ---- color ----
  // Everything is normalized to sRGB in-memory via sharp. This replaces the old
  // tmp-directory CMYK->RGB workaround entirely. `keepMetadata` re-embeds the
  // (now sRGB) ICC profile + EXIF instead of stripping it.
  colorspace: 'srgb',
  keepMetadata: false,

  // ---- format / encoders ----
  format: null, // null = keep input format; or 'jpeg'|'png'|'webp'|'avif'|'gif'|'tiff'
  tiffToJpeg: true, // was const convertTiffJpeg
  mozjpeg: true, // was const useMozJpeg (mozjpeg trellis quantization, built into libvips/sharp)

  // ---- JPEG: adaptive per-file compression (replaces imagemin-jpeg-recompress) ----
  // 2.9's real workhorse was jpeg-recompress (min:30 max:60 quality:"low"): a
  // per-file SSIM-guided quality search, NOT a fixed quality. 'recompress' below
  // reproduces that in-process; 'fixed' is a plain single-quality encode.
  jpegMode: 'recompress', // 'recompress' | 'fixed'
  jpegEngine: 'sharp-ssim', // 'sharp-ssim' (built-in, portable) | 'jpeg-recompress' (binary, exact parity)
  jpegMin: 30, // search floor (was imageminJpegRecompress min)
  jpegMax: 60, // search ceiling (was imageminJpegRecompress max)
  jpegTarget: 0.999, // SSIM target; 0.999 == jpeg-recompress "low" preset ("quality: low")
  jpegSsimDownsample: true, // standard SSIM auto-downsample (fast; set false for full-res scoring)
  jpegFallbackQuality: 50, // mozjpeg quality used when a recompress result is >= the input (2.9's fallback)
  jpegQuality: 80, // used ONLY in jpegMode:'fixed'
  // --- jpeg-recompress binary engine knobs (only when jpegEngine:'jpeg-recompress') ---
  jpegRecompressPreset: 'low', // jpeg-recompress --quality (low|medium|high|veryhigh)
  jpegRecompressMethod: 'ssim', // jpeg-recompress --method (mpe|ssim|ms-ssim|smallfry)
  jpegRecompressIntermediate: 95, // quality of the intermediate JPEG fed to the binary

  pngQuality: 80, // sharp uses libimagequant under the hood (the pngquant replacement)
  webpQuality: 80,
  avifQuality: 50,
  gifColors: 256,
  effort: 4, // png/webp/avif encoder effort (0-9 / 0-6 depending on codec; clamped per-codec)

  // ---- svg ----
  svgRemoveViewBox: false, // keep viewBox by default (was the explicit svgo override)
  svgMultipass: true, // was multipass: true in 2.8.1

  // ---- filenames ----
  lowercaseExt: false, // was const lowerCaseExtensions
  spaceChar: '_', // was const replaceSpaceChr

  // ---- non-image passthrough ----
  copyNonImages: true, // was const copyNonImgFiles
  copyNonImagesByType: false, // was const copyNonImageByType (off by default; opt-in)
  copyBak: false, // was const copyBakFiles (was half-disabled/buggy in 2.9; opt-in + fixed)

  // ---- runtime ----
  concurrency: 16, // replaces batchLimit/svgBatchLimit; in-memory buffers, no crash-batching needed
  dryRun: false, // NEW: report what would happen, write nothing
});

// Recognized raster extensions (lowercased, no dot). SVG is handled separately.
export const RASTER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff'];
export const SVG_EXTS = ['svg'];

// Valid `--format` targets.
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];

/**
 * Merge partial user options over the frozen defaults, returning a fresh config.
 * Performs light validation/normalization so every entry point behaves the same.
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
export function resolveConfig(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  // normalize format aliases
  if (cfg.format) {
    cfg.format = String(cfg.format).toLowerCase();
    if (cfg.format === 'jpg') cfg.format = 'jpeg';
    if (cfg.format === 'tif') cfg.format = 'tiff';
    if (cfg.format === 'keep' || cfg.format === 'original') cfg.format = null;
    if (cfg.format && !OUTPUT_FORMATS.includes(cfg.format)) {
      throw new Error(
        `Invalid --format "${cfg.format}". Expected one of: ${OUTPUT_FORMATS.join(', ')}`
      );
    }
  }

  cfg.maxSize = Math.max(0, Number(cfg.maxSize) || 0);
  cfg.concurrency = Math.max(1, Number(cfg.concurrency) || 1);

  if (typeof cfg.bgColor === 'string') cfg.bgColor = parseColor(cfg.bgColor);

  return cfg;
}

/**
 * Parse a CSS-ish color string into sharp's RGBA object.
 * Accepts "#rrggbb", "#rgb", "#rrggbbaa", or "r,g,b[,a]".
 * @param {string} str
 * @returns {RGBA}
 */
export function parseColor(str) {
  const s = String(str).trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b, alpha };
    }
    throw new Error(`Invalid hex color: "${str}"`);
  }
  const parts = s.split(',').map((p) => Number(p.trim()));
  if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
    const [r, g, b, a] = parts;
    return { r, g, b, alpha: a == null || Number.isNaN(a) ? 1 : a };
  }
  throw new Error(`Invalid color: "${str}" (use #rrggbb or r,g,b[,a])`);
}
