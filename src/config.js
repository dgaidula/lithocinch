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
  suffix: '_lco', // "lithocinch optimized" (was const outputAppend; formerly '_opt')
  overwrite: false, // was const overwriteFiles
  flatten: false, // NEW: drop the source subdir tree, write everything flat

  // ---- resize / geometry ----
  maxSize: 2560, // was const maxSize; 0 disables resizing (was the 2.8 "skip maxSize" switch)
  square: false, // was const onSquare (pad to a maxSize x maxSize square)
  bgColor: { r: 255, g: 255, b: 255, alpha: 1 }, // was const bgColor (used by square)
  trim: false, // was const trimWhiteSpace

  // Explicit transform resize (the CMS / transform-API path). When width and/or
  // height is set these take precedence over maxSize. `fit` maps to Craft's modes
  // (cover=crop, inside/contain=fit, fill=stretch). `focal` is {x,y} in 0..1 for
  // a focal-point crop (cover, static images); `position` is a sharp gravity.
  width: null,
  height: null,
  fit: 'cover',
  position: 'centre',
  focal: null,
  withoutEnlargement: true,

  // ---- color ----
  // Everything is normalized to sRGB in-memory via sharp. This replaces the old
  // tmp-directory CMYK->RGB workaround entirely. `keepMetadata` re-embeds the
  // (now sRGB) ICC profile + EXIF instead of stripping it.
  colorspace: 'srgb',
  keepMetadata: false,
  // Resolution (pixels per inch) to write into the output's header, or null to
  // leave it alone. Written after encoding by rewriting header bytes only (see
  // density.js), so it costs 0-21 bytes, not a re-encode. JPEG and PNG only.
  density: null,

  // ---- format / encoders ----
  format: null, // null = keep; 'jpeg'|'png'|'webp'|'avif'|'gif'|'tiff'; or 'auto' (pick best per image)
  // --format auto: candidate pool (most-compatible first) and the tie-break
  // tolerance — a more-compatible format within this fraction of the smallest wins.
  formatPool: ['avif', 'webp', 'jpeg', 'png'],
  formatTolerance: 0.03,
  tiffToJpeg: true, // was const convertTiffJpeg
  mozjpeg: true, // was const useMozJpeg (mozjpeg trellis quantization, built into libvips/sharp)

  // ---- JPEG: adaptive per-file compression (replaces imagemin-jpeg-recompress) ----
  // 2.9's real workhorse was jpeg-recompress (min:30 max:60 quality:"low"): a
  // per-file SSIM-guided quality search, NOT a fixed quality. 'recompress' below
  // reproduces that in-process; 'fixed' is a plain single-quality encode.
  jpegMode: 'recompress', // 'recompress' | 'fixed'
  // 'auto' = sharp-ssim, plus a shootout against the real jpeg-recompress when on
  // PATH (keep the smaller result that still clears the SSIM target).
  jpegEngine: 'auto', // 'auto' | 'sharp-ssim' | 'jpeg-recompress'
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

  // PNG: libimagequant palette quantization == 2.9's imagemin-pngquant.
  // 'auto' = shoot out sharp vs pngquant (when on PATH), keep the smallest that
  // clears the quality gate. 'sharp' = portable/deterministic. 'pngquant' = exact 2.9.
  pngEngine: 'auto', // 'auto' | 'sharp' | 'pngquant'
  pngQuality: 100, // palette quality search CEILING (libimagequant)
  pngMinQuality: 50, // palette quality search FLOOR
  pngEffort: 10, // libimagequant effort 1-10; 10 == pngquant speed:1 ("best", 2.9's choice)
  pngColors: 256, // max palette colors (pngquant default)
  pngDither: 1.0, // Floyd-Steinberg dither (pngquant default)
  pngLossless: false, // true = skip palette quantization, lossless zlib only
  // Perceptual gate: the palette must clear this SSIM vs the source to be used,
  // else fall back to lossless (the perceptually-lossless floor). ~0.9 cleanly
  // separates palette-friendly content (graphics/UI, SSIM ~1.0) from gradients
  // and photos (SSIM ~0.8), which belong in lossless PNG or WebP/AVIF. Lower than
  // the WebP/AVIF 0.99 because SSIM penalizes dithering noise humans don't see.
  pngMinSsim: 0.92,
  // Full-res SSIM for the gate: it must not smooth away palette banding (a
  // gradient palette scores 0.62 full-res but ~1.0 downsampled).
  pngSsimDownsample: false,
  // pngquant binary engine knobs (only when pngEngine:'pngquant') — defaults are 2.9's exact values.
  pngquantMin: 50,
  pngquantMax: 60,
  pngquantSpeed: 1,

  // The unified "perceptually lossless" SSIM bar. Every adaptive lossy search
  // (WebP, AVIF; JPEG keeps its own validated 0.999-within-band) targets the
  // SMALLEST encoding that still clears this — the goal being output that's
  // visually indistinguishable from the source. Raise toward 0.999 for stricter
  // (larger) output, lower for smaller. Per-codec --*-target flags override it.
  perceptualTarget: 0.99,

  // WebP: content-aware. 'auto' classifies photographic vs graphic and shoots out
  // lossy (quality-searched) vs lossless, keeping the smallest that clears the bar.
  webpMode: 'auto', // 'auto' | 'lossy' | 'lossless' | 'near-lossless'
  webpQuality: 80, // lossy quality when not searching; also the lossless effort/quality hint
  webpEffort: 4, // 0-6 encoder effort
  webpMin: 50, // lossy quality search floor (auto)
  webpMax: 90, // lossy quality search ceiling (auto)
  webpTargetSsim: null, // perceptual bar for the lossy candidate; null => perceptualTarget
  webpSsimDownsample: true, // downsample SSIM inside the lossy search (speed)
  webpAlphaQuality: 100, // alpha channel quality for lossy WebP
  webpNearLosslessQuality: 60, // preprocessing level for --webp-mode near-lossless
  webpGraphicColorCap: 4096, // distinct-color sample threshold: <= => "graphic", > => "photographic"

  // AVIF: same content-aware strategy as WebP (libheif/AV1, in the prebuilt sharp).
  avifMode: 'auto', // 'auto' | 'lossy' | 'lossless'
  avifQuality: 50, // lossy quality when not searching
  avifEffort: 4, // 0-9 encoder effort (AVIF is slower; higher = smaller/slower)
  avifMin: 30, // lossy quality search floor (auto)
  avifMax: 63, // lossy quality search ceiling (auto)
  avifTargetSsim: null, // perceptual bar; null => perceptualTarget
  avifSsimDownsample: true,
  avifGraphicColorCap: 4096,

  // GIF: sharp/libimagequant for colour+resize, then a LOSSLESS gifsicle pass.
  // 'auto' = use gifsicle when on PATH (lossless, best for animations), else sharp.
  gifEngine: 'auto', // 'auto' | 'sharp' | 'gifsicle'
  gifColors: 256,
  gifDither: 1.0,
  gifEffort: 10, // sharp palette effort (2.9's gifsicle used -O1)
  gifsicleOptimize: 3, // gifsicle -O level (3 = max, lossless)
  gifsicleLossy: 0, // gifsicle --lossy level; 0 = off (lossless). >0 trades quality for size

  effort: 4, // WebP/AVIF encoder effort (clamped per-codec); PNG/GIF use their own effort above

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

  // ---- additional outputs ----
  // Formats to ALSO emit next to each optimized raster (for <picture> fallbacks):
  // e.g. ['webp','avif'] writes photo_lco.jpg + photo_lco.webp + photo_lco.avif.
  // Each uses that codec's content-aware/perceptual settings. Skips the format
  // that already equals the primary output.
  emit: [],

  // Path to write a JSON manifest mapping each source to its output(s) + format
  // + sizes. Essential for --format auto (extensions change): build tools / HTML
  // rewriting read it, and re-runs use it for skip-detection. null = no manifest.
  manifest: null,

  // ---- runtime ----
  concurrency: 16, // replaces batchLimit/svgBatchLimit; in-memory buffers, no crash-batching needed
  dryRun: false, // NEW: report what would happen, write nothing
});

/** An option that is not valid (a usage error, not a failed image). */
export class ConfigError extends Error {}

// Recognized raster extensions (lowercased, no dot). SVG is handled separately.
export const RASTER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff'];
export const SVG_EXTS = ['svg'];

// Valid `--format` targets.
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];

// Output formats lithocinch can write a `density` into (see density.js).
export const DENSITY_FORMATS = ['jpeg', 'png'];

// JFIF stores each axis density in 16 bits, so that is the ceiling.
export const MAX_PPI = 65535;

/**
 * Validate a resolution in pixels per inch: a whole number from 1 to 65535.
 * Shared by the `--density` option and the `density` sub-command's `--ppi`.
 * A string must be plain decimal digits ("72", not "0x48", "1e2" or "72.0").
 * @param {unknown} value
 * @param {string} [flag]  name used in the error message
 * @returns {number}
 */
export function parsePpi(value, flag = '--density') {
  const n = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PPI) {
    throw new ConfigError(`Invalid ${flag} "${value}". Expected a whole number of pixels per inch, 1-${MAX_PPI}`);
  }
  return n;
}

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
    // 'auto' is a mode (pick best per image), not a concrete format.
    if (cfg.format && cfg.format !== 'auto' && !OUTPUT_FORMATS.includes(cfg.format)) {
      throw new ConfigError(
        `Invalid --format "${cfg.format}". Expected: ${OUTPUT_FORMATS.join(', ')}, auto`
      );
    }
  }

  // Candidate pool for --format auto (normalize aliases, validate, default order).
  if (cfg.formatPool && cfg.formatPool.length) {
    cfg.formatPool = cfg.formatPool.map((f) => {
      let fmt = String(f).toLowerCase().trim();
      if (fmt === 'jpg') fmt = 'jpeg';
      if (!['avif', 'webp', 'jpeg', 'png'].includes(fmt)) {
        throw new ConfigError(`Invalid --format-pool entry "${f}". Expected: avif, webp, jpeg, png`);
      }
      return fmt;
    });
  }
  cfg.formatTolerance = Math.max(0, Number(cfg.formatTolerance) || 0);

  cfg.maxSize = Math.max(0, Number(cfg.maxSize) || 0);
  cfg.concurrency = Math.max(1, Number(cfg.concurrency) || 1);

  // Per-codec perceptual targets default to the unified perceptualTarget.
  if (cfg.webpTargetSsim == null) cfg.webpTargetSsim = cfg.perceptualTarget;
  if (cfg.avifTargetSsim == null) cfg.avifTargetSsim = cfg.perceptualTarget;

  if (typeof cfg.bgColor === 'string') cfg.bgColor = parseColor(cfg.bgColor);

  // Normalize/validate the additional-output formats.
  if (cfg.emit && cfg.emit.length) {
    cfg.emit = [
      ...new Set(
        cfg.emit.map((f) => {
          let fmt = String(f).toLowerCase().trim();
          if (fmt === 'jpg') fmt = 'jpeg';
          if (fmt === 'tif') fmt = 'tiff';
          if (!OUTPUT_FORMATS.includes(fmt)) {
            throw new ConfigError(`Invalid --emit format "${f}". Expected: ${OUTPUT_FORMATS.join(', ')}`);
          }
          return fmt;
        })
      ),
    ];
  } else {
    cfg.emit = [];
  }

  // Resolution header. Refuse what is knowable from the options alone; a format
  // that is only known per file (--format keep on a mixed folder) is reported
  // per file instead, so the output never pretends to carry a density it lacks.
  if (cfg.density != null) {
    cfg.density = parsePpi(cfg.density, '--density');
    const cannot = (list) => list.filter((f) => !DENSITY_FORMATS.includes(f));
    const sayCannot = (what, bad) =>
      new ConfigError(
        `--density cannot be written to ${what} ${bad.join(', ')} output (only ${DENSITY_FORMATS.join(' and ')} carry it)`
      );
    if (cfg.format && cfg.format !== 'auto' && cannot([cfg.format]).length) {
      throw sayCannot('--format', cannot([cfg.format]));
    }
    if (cannot(cfg.emit).length) throw sayCannot('--emit', cannot(cfg.emit));
    if (cfg.format === 'auto') {
      // The shootout may only pick a format that can hold the density.
      cfg.formatPool = (cfg.formatPool?.length ? cfg.formatPool : DEFAULTS.formatPool).filter((f) => DENSITY_FORMATS.includes(f));
      if (!cfg.formatPool.length) {
        throw new ConfigError(`--density with --format auto needs jpeg or png in --format-pool`);
      }
    }
  }

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
    throw new ConfigError(`Invalid hex color: "${str}"`);
  }
  const parts = s.split(',').map((p) => Number(p.trim()));
  if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
    const [r, g, b, a] = parts;
    return { r, g, b, alpha: a == null || Number.isNaN(a) ? 1 : a };
  }
  throw new ConfigError(`Invalid color: "${str}" (use #rrggbb or r,g,b[,a])`);
}
