// SVG optimization via svgo v4. svgo is ESM-only now (one of the libraries the
// old require()-based 2.9 script was stuck on an older major to avoid), so it
// lives behind this thin, string-in / string-out wrapper.

import { optimize } from 'svgo';

/**
 * Optimize an SVG document.
 *
 * Mirrors 2.9's svgo settings (multipass on, preserve viewBox) but exposes them
 * as options instead of a hard-coded plugin array.
 *
 * @param {string|Buffer} svg
 * @param {object} [opts]
 * @param {boolean} [opts.svgMultipass=true]
 * @param {boolean} [opts.svgRemoveViewBox=false]
 * @returns {string} optimized SVG markup
 */
export function optimizeSvg(svg, opts = {}) {
  const { svgMultipass = true, svgRemoveViewBox = false } = opts;
  // svgo v4 removed `removeViewBox` from preset-default, so viewBox is preserved
  // by default (what 2.9 forced via active:false). To strip it, add the plugin
  // explicitly after the preset.
  const plugins = ['preset-default'];
  if (svgRemoveViewBox) plugins.push('removeViewBox');

  const result = optimize(String(svg), { multipass: svgMultipass, plugins });
  return result.data;
}
