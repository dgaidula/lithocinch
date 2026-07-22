// Filename transforms: extension swapping, suffix insertion, space replacement,
// and lowercasing. Pure string helpers — no filesystem access — so they are
// equally usable from the CLI, the library, and the Lambda handler.

import path from 'node:path';

const EXT_FOR_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
  tiff: '.tif',
};

/**
 * Build the output filename for a processed image.
 *
 * Replaces 2.9's `appendToFile()` — which only swapped a global space->char on
 * the *first* space and conflated suffix/extension logic. This version:
 *   - inserts the suffix before the extension,
 *   - optionally rewrites the extension when the output format changed,
 *   - optionally lowercases the extension,
 *   - replaces *all* whitespace runs in the basename (not just the first).
 *
 * @param {string} name        original filename (basename or relative path)
 * @param {object} opts
 * @param {string} [opts.suffix='']        e.g. "_lco"
 * @param {string|null} [opts.outputFormat] sharp format name if it changed, else null/undefined
 * @param {boolean} [opts.lowercaseExt=false]
 * @param {string} [opts.spaceChar='_']
 * @returns {string}
 */
export function buildOutputName(name, opts = {}) {
  const { suffix = '', outputFormat = null, lowercaseExt = false, spaceChar = '_' } = opts;

  const dir = path.dirname(name);
  const origExt = path.extname(name);
  const stem = path.basename(name, origExt);

  let ext = outputFormat ? EXT_FOR_FORMAT[outputFormat] || origExt : origExt;
  if (lowercaseExt) ext = ext.toLowerCase();

  let base = `${stem}${suffix}${ext}`;
  if (spaceChar != null) base = base.replace(/\s+/g, spaceChar);

  return dir === '.' ? base : path.join(dir, base);
}

/**
 * Lowercased extension without the dot. Replaces 2.9's `fileExtension(p, true)`.
 * @param {string} filePath
 * @returns {string} e.g. "jpg", or "" when there is no extension
 */
export function extNoDot(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}
