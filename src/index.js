// Public library API for process-images.
//
//   import {
//     optimizeImageBuffer, // raster bytes -> optimized bytes (pure, Lambda-safe)
//     optimizeSvg,         // svg string   -> optimized string (pure, Lambda-safe)
//     optimizeBytes,       // any image bytes + filename -> bytes + output name (pure)
//     optimizeFile,        // one file on disk -> optimized file
//     processDirectory,    // whole tree -> mirrored, optimized output tree
//   } from 'process-images';

export { optimizeImageBuffer } from './optimize.js';
export { optimizeSvg } from './svg.js';
export { optimizeBytes, optimizeFile } from './transform.js';
export { processDirectory } from './process-dir.js';
export { runTransform, handleJsonRequest, serializeOutputs } from './transform-api.js';
export { createServer, startServer } from './server.js';
export { resolveConfig, DEFAULTS, parseColor, RASTER_EXTS, SVG_EXTS, OUTPUT_FORMATS } from './config.js';
export { buildOutputName, extNoDot } from './naming.js';
export { patchJpegDensity, patchPngDensity, readJpegDensity, readPngDensity, DensityError } from './density.js';
