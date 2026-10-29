// Single-item transforms shared by the library API and the directory
// orchestrator. Kept separate from index.js so process-dir.js and index.js can
// both import it without a circular dependency.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { optimizeImageBuffer } from './optimize.js';
import { optimizeSvg } from './svg.js';
import { resolveConfig, RASTER_EXTS, SVG_EXTS } from './config.js';
import { buildOutputName, extNoDot } from './naming.js';

/**
 * Optimize one image (raster or SVG) from its bytes + original filename.
 * Pure: returns optimized bytes and the derived output name; writes nothing.
 *
 * @param {Buffer|Uint8Array|string} bytes
 * @param {string} filename
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 * @returns {Promise<{ data: Buffer, outName: string, kind: 'svg'|'raster', inputFormat?: string, outputFormat?: string, density?: object }>}
 */
export async function optimizeBytes(bytes, filename, options = {}) {
  const cfg = options.__resolved ? options : resolveConfig(options);
  const ext = extNoDot(filename);

  if (SVG_EXTS.includes(ext)) {
    const out = Buffer.from(optimizeSvg(bytes, cfg), 'utf8');
    return {
      data: out,
      kind: 'svg',
      outName: buildOutputName(filename, {
        suffix: cfg.suffix,
        lowercaseExt: cfg.lowercaseExt,
        spaceChar: cfg.spaceChar,
      }),
    };
  }

  if (!RASTER_EXTS.includes(ext)) {
    throw new Error(`Unsupported image extension: ".${ext}" (${filename})`);
  }

  const { data, inputFormat, outputFormat, quality, ssim, engine, density } = await optimizeImageBuffer(
    Buffer.from(bytes),
    { ...cfg, __resolved: true }
  );
  const formatChanged = outputFormat !== inputFormat;
  return {
    data,
    kind: 'raster',
    inputFormat,
    outputFormat,
    quality,
    ssim,
    engine,
    density, // only when cfg.density is set; see optimizeImageBuffer
    outName: buildOutputName(filename, {
      suffix: cfg.suffix,
      outputFormat: formatChanged ? outputFormat : null,
      lowercaseExt: cfg.lowercaseExt,
      spaceChar: cfg.spaceChar,
    }),
  };
}

/**
 * Optimize a single file on disk. Writes to `destPath` when provided.
 * @param {string} srcPath
 * @param {string} [destPath]
 * @param {Partial<import('./config.js').DEFAULTS>} [options]
 */
export async function optimizeFile(srcPath, destPath, options = {}) {
  const bytes = await fs.readFile(srcPath);
  const result = await optimizeBytes(bytes, path.basename(srcPath), options);
  if (destPath) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, result.data);
  }
  return result;
}
