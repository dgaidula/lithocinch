// Directory orchestrator: walk an input tree, optimize every image, mirror the
// folder structure into the output dir, pass non-image files through, and route
// unreadable/corrupt files to an error dir. This is the local/server entry point
// (the CLI is a thin wrapper over it). The Lambda path uses the buffer helpers
// in index.js instead and never touches this file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';

import { resolveConfig, RASTER_EXTS, SVG_EXTS } from './config.js';
import { optimizeBytes } from './transform.js';
import { buildOutputName, extNoDot } from './naming.js';
import { runPool } from './pool.js';

const IMAGE_EXTS = [...RASTER_EXTS, ...SVG_EXTS];

function noop() {}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyThrough(srcAbs, destAbs, dryRun) {
  if (dryRun) return;
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.copyFile(srcAbs, destAbs);
}

/**
 * Optimize an entire directory tree.
 *
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 * @param {object} [hooks]
 * @param {(evt: {type:string,[k:string]:any}) => void} [hooks.onProgress]  per-file + lifecycle events
 * @param {{info:Function,warn:Function,error:Function}} [hooks.logger]
 * @returns {Promise<{processed:number,skipped:number,errors:number,copied:number,bytesIn:number,bytesOut:number,errorFiles:string[]}>}
 */
export async function processDirectory(options = {}, hooks = {}) {
  const cfg = resolveConfig(options);
  cfg.__resolved = true; // let per-file optimizeBytes skip re-validating every image
  const onProgress = hooks.onProgress || noop;
  const log = hooks.logger || { info: noop, warn: noop, error: noop };

  const inputRoot = path.resolve(cfg.input);
  const outputRoot = path.resolve(cfg.output);
  const errorRoot = path.resolve(cfg.errorDir);

  const stats = {
    processed: 0,
    skipped: 0,
    errors: 0,
    copied: 0,
    bytesIn: 0,
    bytesOut: 0,
    errorFiles: [],
  };

  // Discover image files (relative to inputRoot). Exclude the output/error dirs
  // in case they live inside the input tree, and skip log files.
  const imageGlobs = IMAGE_EXTS.map((e) => `**/*.${e}`);
  const ignore = [
    '**/node_modules/**',
    '**/logs/**',
    relForIgnore(inputRoot, outputRoot),
    relForIgnore(inputRoot, errorRoot),
  ].filter(Boolean);

  const imageFiles = await glob(imageGlobs, {
    cwd: inputRoot,
    caseSensitiveMatch: false, // matches 2.9's {jpg,JPG,...} dual-case globs
    onlyFiles: true,
    dot: false,
    ignore,
  });

  onProgress({ type: 'discovered', count: imageFiles.length });
  log.info(`Found ${imageFiles.length} image(s) under ${inputRoot}`);

  // Plan: resolve each file's destination and skip ones already present.
  const plan = [];
  for (const rel of imageFiles) {
    const ext = extNoDot(rel);
    const isSvg = SVG_EXTS.includes(ext);
    // Cheap name preview (format may change for rasters; resolved precisely after
    // optimize). For skip-detection we only need the suffix/space/case transform.
    const previewName = buildOutputName(rel, {
      suffix: cfg.suffix,
      // When --format forces a specific output we know the extension up front, so
      // skip-detection matches the real output name. (TIFF->JPEG auto-convert
      // can't be predicted without probing; those re-process, which is harmless.)
      outputFormat: !isSvg && cfg.format ? cfg.format : null,
      lowercaseExt: cfg.lowercaseExt,
      spaceChar: cfg.spaceChar,
    });
    const relOut = cfg.flatten ? path.basename(previewName) : previewName;
    plan.push({ rel, isSvg, srcAbs: path.join(inputRoot, rel), previewOut: path.join(outputRoot, relOut) });
  }

  await runPool(plan, cfg.concurrency, async (job) => {
    if (!cfg.overwrite && (await exists(job.previewOut))) {
      stats.skipped++;
      onProgress({ type: 'skip', file: job.rel });
      return;
    }

    let bytes;
    try {
      bytes = await fs.readFile(job.srcAbs);
    } catch (err) {
      return recordError(job, err, 'read');
    }

    try {
      const result = await optimizeBytes(bytes, job.rel, cfg);
      const relOut = cfg.flatten ? path.basename(result.outName) : result.outName;
      const destAbs = path.join(outputRoot, relOut);

      if (!cfg.dryRun) {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.writeFile(destAbs, result.data);
      }

      stats.processed++;
      stats.bytesIn += bytes.length;
      stats.bytesOut += result.data.length;
      onProgress({
        type: 'done',
        file: job.rel,
        outFile: relOut,
        kind: result.kind,
        quality: result.quality ?? null,
        ssim: result.ssim ?? null,
        bytesIn: bytes.length,
        bytesOut: result.data.length,
      });
    } catch (err) {
      return recordError(job, err, 'optimize', bytes);
    }
  });

  async function recordError(job, err, phase, bytes) {
    stats.errors++;
    stats.errorFiles.push(job.rel);
    log.error(`[${phase}] ${job.rel}: ${err.message}`);
    onProgress({ type: 'error', file: job.rel, phase, message: err.message });
    // Pass the original through to output (so the tree stays complete) and stash
    // a copy in the error dir for investigation — same intent as 2.9, but reliable.
    try {
      await copyThrough(job.srcAbs, path.join(outputRoot, cfg.flatten ? path.basename(job.rel) : job.rel), cfg.dryRun);
      await copyThrough(job.srcAbs, path.join(errorRoot, cfg.flatten ? path.basename(job.rel) : job.rel), cfg.dryRun);
    } catch (copyErr) {
      log.error(`Failed to copy errored file ${job.rel}: ${copyErr.message}`);
    }
  }

  // Non-image passthrough.
  if (cfg.copyNonImages || cfg.copyNonImagesByType || cfg.copyBak) {
    const copied = await copyNonImages(cfg, inputRoot, outputRoot, log);
    stats.copied += copied;
    onProgress({ type: 'copied', count: copied });
  }

  onProgress({ type: 'complete', stats });
  return stats;
}

/** Copy non-image files (and optionally .bak files) into the output tree. */
async function copyNonImages(cfg, inputRoot, outputRoot, log) {
  const ignore = [
    '**/node_modules/**',
    '**/logs/**',
    '**/*.log',
    ...IMAGE_EXTS.map((e) => `**/*.${e}`),
    relForIgnore(inputRoot, outputRoot),
    relForIgnore(inputRoot, path.resolve(cfg.errorDir)),
  ].filter(Boolean);

  const others = await glob(['**/*'], {
    cwd: inputRoot,
    onlyFiles: true,
    dot: false,
    caseSensitiveMatch: false,
    ignore,
  });

  let count = 0;
  for (const rel of others) {
    const isBak = /\.(bak|back)(\.|$)/i.test(path.basename(rel));
    if (isBak && !cfg.copyBak) continue;
    if (!isBak && !cfg.copyNonImages && !cfg.copyNonImagesByType) continue;

    const srcAbs = path.join(inputRoot, rel);
    let destRel = rel;
    if (cfg.copyNonImagesByType) {
      const ext = extNoDot(rel) || 'noext';
      destRel = path.join('non-images', ext, path.basename(rel));
    }
    try {
      await copyThrough(srcAbs, path.join(outputRoot, destRel), cfg.dryRun);
      count++;
    } catch (err) {
      log.error(`Failed to copy ${rel}: ${err.message}`);
    }
  }
  if (count) log.info(`Copied ${count} non-image file(s) through to output`);
  return count;
}

/** Turn an absolute path into an inputRoot-relative ignore glob, or null if outside. */
function relForIgnore(inputRoot, absPath) {
  const rel = path.relative(inputRoot, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `${rel.split(path.sep).join('/')}/**`;
}
