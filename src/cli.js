#!/usr/bin/env node
// Command-line front end for process-images. Every knob that was a hard-coded
// constant in process-images-2.9.js is exposed here as a flag (see NOTES.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Command, Option } from 'commander';
import cliProgress from 'cli-progress';
import pc from 'picocolors';

import { processDirectory } from './process-dir.js';
import { OUTPUT_FORMATS } from './config.js';

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')
);

const program = new Command();

program
  .name('process-images')
  .description(
    'Batch image optimizer (sharp + svgo). Caps dimensions, normalizes color to ' +
      'sRGB, compresses JPEG/PNG/GIF/WebP/AVIF/TIFF and SVG, and mirrors the input ' +
      'folder tree into an output folder.'
  )
  .version(pkg.version, '-v, --version')
  .argument('[input]', 'input directory to scan recursively', '.')
  // --- output layout ---
  .option('-o, --output <dir>', 'output directory', '../img-optimize-output/')
  .option('--error-dir <dir>', 'where to copy files that fail to process', '../img-optimize-error/')
  .option('-s, --suffix <str>', 'string inserted before the extension of each output file', '_opt')
  .option('--overwrite', 'reprocess files even if the output already exists', false)
  .option('--flatten', 'drop the source subfolder tree; write all output files flat', false)
  // --- resize / geometry ---
  .option('-m, --max-size <px>', 'cap width & height to this many pixels (0 = no resize)', '2560')
  .option('--no-resize', 'alias for --max-size 0')
  .option('--square', 'pad each image to a max-size x max-size square using --bg-color', false)
  .option('--bg-color <color>', 'background for square padding / alpha flatten (#rrggbb or r,g,b[,a])', '#ffffff')
  .option('--trim', 'trim surrounding same-color borders before encoding', false)
  // --- color / metadata ---
  .option('--keep-metadata', 're-embed sRGB ICC profile + EXIF instead of stripping', false)
  // --- format / quality ---
  .addOption(
    new Option('-f, --format <fmt>', 'force all output to one format').choices([
      ...OUTPUT_FORMATS,
      'keep',
    ])
  )
  .option('--no-tiff-to-jpeg', 'do NOT convert TIFF (incl. mislabeled .jpg TIFFs) to JPEG')
  .option('--no-mozjpeg', 'disable mozjpeg trellis quantization (faster, slightly larger)')
  // JPEG adaptive compression (the jpeg-recompress replacement)
  .addOption(
    new Option('--jpeg-mode <mode>', 'JPEG strategy: adaptive SSIM search vs single fixed quality')
      .choices(['recompress', 'fixed'])
      .default('recompress')
  )
  .addOption(
    new Option('--jpeg-engine <engine>', 'recompress engine: built-in or the real jpeg-recompress binary')
      .choices(['sharp-ssim', 'jpeg-recompress'])
      .default('sharp-ssim')
  )
  .option('--jpeg-min <n>', 'recompress quality search floor', '30')
  .option('--jpeg-max <n>', 'recompress quality search ceiling', '60')
  .option('--jpeg-target <ssim>', 'recompress SSIM target (0.999 = jpeg-recompress "low")', '0.999')
  .option('--jpeg-fallback-quality <n>', 'mozjpeg quality used when recompress would grow the file', '50')
  .option('--no-jpeg-ssim-downsample', 'score SSIM at full resolution (slower, stricter)')
  .option('--jpeg-quality <n>', 'fixed-mode JPEG quality 1-100 (only with --jpeg-mode fixed)', '80')
  .addOption(
    new Option('--png-engine <engine>', 'PNG engine: built-in libimagequant or the real pngquant binary')
      .choices(['sharp', 'pngquant'])
      .default('sharp')
  )
  .option('--png-quality <n>', 'PNG palette quality 1-100 (libimagequant; 2.9 used ~60)', '80')
  .option('--png-effort <n>', 'PNG palette effort 1-10 (10 = pngquant speed:1, best)', '10')
  .option('--png-min-ssim <n>', 'fall back to lossless if a palette PNG scores below this SSIM (0 = never)', '0.85')
  .option('--png-lossless', 'lossless PNG (no palette quantization, zlib only)', false)
  .option('--webp-quality <n>', 'WebP quality 1-100', '80')
  .option('--avif-quality <n>', 'AVIF quality 1-100', '50')
  .option('--gif-colors <n>', 'max GIF palette colors', '256')
  .option('--effort <n>', 'WebP/AVIF encoder effort (higher = slower/smaller)', '4')
  // --- svg ---
  .option('--svg-remove-viewbox', 'let svgo strip the viewBox attribute', false)
  .option('--no-svg-multipass', 'run svgo a single pass instead of multipass')
  // --- filenames ---
  .option('--lowercase-ext', 'lowercase output file extensions', false)
  .option('--space-char <ch>', 'replace whitespace in output names with this', '_')
  // --- passthrough ---
  .option('--no-copy-non-images', 'do NOT copy non-image files into the output tree')
  .option('--copy-non-images-by-type', 'copy non-image files into output/non-images/<ext>/', false)
  .option('--copy-bak', 'also copy *.bak / *.back files', false)
  // --- runtime ---
  .option('-c, --concurrency <n>', 'number of images to process in parallel', '16')
  .option('--dry-run', 'report what would happen without writing anything', false)
  .option('-q, --quiet', 'suppress the progress bar and per-file logging', false)
  .option('--verbose', 'log every file as it is processed', false)
  .option('--json', 'print the final summary as JSON', false)
  .showHelpAfterError();

program.action(async (input, opts) => {
  const options = {
    input,
    output: opts.output,
    errorDir: opts.errorDir,
    suffix: opts.suffix,
    overwrite: opts.overwrite,
    flatten: opts.flatten,
    // commander sets opts.resize=false when --no-resize is passed.
    maxSize: opts.resize === false ? 0 : Number(opts.maxSize),
    square: opts.square,
    bgColor: opts.bgColor,
    trim: opts.trim,
    keepMetadata: opts.keepMetadata,
    format: opts.format ?? null,
    tiffToJpeg: opts.tiffToJpeg, // false when --no-tiff-to-jpeg
    mozjpeg: opts.mozjpeg, // false when --no-mozjpeg
    jpegMode: opts.jpegMode,
    jpegEngine: opts.jpegEngine,
    jpegMin: Number(opts.jpegMin),
    jpegMax: Number(opts.jpegMax),
    jpegTarget: Number(opts.jpegTarget),
    jpegFallbackQuality: Number(opts.jpegFallbackQuality),
    jpegSsimDownsample: opts.jpegSsimDownsample, // false when --no-jpeg-ssim-downsample
    jpegQuality: Number(opts.jpegQuality),
    pngEngine: opts.pngEngine,
    pngQuality: Number(opts.pngQuality),
    pngEffort: Number(opts.pngEffort),
    pngMinSsim: Number(opts.pngMinSsim),
    pngLossless: opts.pngLossless,
    webpQuality: Number(opts.webpQuality),
    avifQuality: Number(opts.avifQuality),
    gifColors: Number(opts.gifColors),
    effort: Number(opts.effort),
    svgRemoveViewBox: opts.svgRemoveViewbox,
    svgMultipass: opts.svgMultipass, // false when --no-svg-multipass
    lowercaseExt: opts.lowercaseExt,
    spaceChar: opts.spaceChar,
    copyNonImages: opts.copyNonImages, // false when --no-copy-non-images
    copyNonImagesByType: opts.copyNonImagesByType,
    copyBak: opts.copyBak,
    concurrency: Number(opts.concurrency),
    dryRun: opts.dryRun,
  };

  const t0 = process.hrtime.bigint();
  let bar = null;
  const quiet = opts.quiet;

  const logger = {
    info: (m) => !quiet && process.stderr.write(pc.dim(`  ${m}\n`)),
    warn: (m) => !quiet && process.stderr.write(pc.yellow(`  ${m}\n`)),
    error: (m) => process.stderr.write(pc.red(`  ${m}\n`)),
  };

  const onProgress = (evt) => {
    switch (evt.type) {
      case 'discovered':
        if (!quiet && evt.count > 0) {
          bar = new cliProgress.SingleBar(
            {
              format: `  ${pc.cyan('{bar}')} {percentage}% | {value}/{total} | {file}`,
              hideCursor: true,
              clearOnComplete: false,
              barCompleteChar: '█',
              barIncompleteChar: '░',
            },
            cliProgress.Presets.shades_classic
          );
          bar.start(evt.count, 0, { file: '' });
        }
        break;
      case 'done': {
        if (opts.verbose) {
          const q = evt.quality != null ? ` q${evt.quality}` : '';
          const s = evt.ssim != null ? ` ssim${evt.ssim.toFixed(4)}` : '';
          logger.info(`${evt.file} -> ${evt.outFile} (${fmtBytes(evt.bytesIn)} -> ${fmtBytes(evt.bytesOut)}${q}${s})`);
        }
        bar?.increment({ file: truncate(evt.file) });
        break;
      }
      case 'skip':
        bar?.increment({ file: pc.dim(`skip ${truncate(evt.file)}`) });
        break;
      case 'error':
        bar?.increment({ file: pc.red(`err ${truncate(evt.file)}`) });
        break;
      case 'complete':
        bar?.stop();
        break;
      default:
        break;
    }
  };

  let stats;
  try {
    stats = await processDirectory(options, { onProgress, logger });
  } catch (err) {
    bar?.stop();
    process.stderr.write(pc.red(`\nFatal: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...stats, ms: Math.round(ms) }, null, 2) + '\n');
    return;
  }

  if (stats.processed === 0 && stats.skipped === 0 && stats.errors === 0) {
    process.stderr.write(pc.yellow(`\nNo images found under "${path.resolve(input)}".\n`));
    return;
  }

  const saved = stats.bytesIn - stats.bytesOut;
  const pct = stats.bytesIn > 0 ? ((saved / stats.bytesIn) * 100).toFixed(1) : '0.0';
  const line = pc.bold(opts.dryRun ? '\nDry run complete.' : '\nDone.');
  process.stderr.write(
    `${line}\n` +
      `  processed : ${pc.green(stats.processed)}\n` +
      `  skipped   : ${stats.skipped}\n` +
      `  errors    : ${stats.errors ? pc.red(stats.errors) : 0}\n` +
      `  copied    : ${stats.copied}\n` +
      `  size      : ${fmtBytes(stats.bytesIn)} -> ${fmtBytes(stats.bytesOut)} ` +
      `(${pc.green(`-${pct}%`)}, saved ${fmtBytes(saved)})\n` +
      `  time      : ${(ms / 1000).toFixed(2)}s\n`
  );
  if (stats.errors) {
    process.stderr.write(pc.red(`  see ${path.resolve(options.errorDir)} for the ${stats.errors} failed file(s)\n`));
    process.exitCode = 1;
  }
});

function fmtBytes(n) {
  if (n < 0) return `-${fmtBytes(-n)}`;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function truncate(s, max = 40) {
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}

program.parseAsync(process.argv);
