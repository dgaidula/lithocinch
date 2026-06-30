// GIF finalization. sharp (libimagequant) handles colour/resize/quantization;
// gifsicle then does a LOSSLESS pass (-O3, best-in-class LZW + inter-frame
// optimization, especially for animations). gifsicle's pass can only shrink or
// tie, never reduce quality, so the `auto` engine uses it whenever it's on PATH.

import { runBinary, hasBinary, binHint } from './bin.js';

/** Lossless gifsicle optimization; returns the smaller of {input, gifsicle output}. */
async function gifsiclePass(gifBuffer, cfg) {
  const args = [`--optimize=${cfg.gifsicleOptimize}`];
  if (cfg.gifsicleLossy > 0) args.push(`--lossy=${cfg.gifsicleLossy}`); // opt-in lossy LZW
  args.push('--output', '-'); // write to stdout; stdin is the (only) input
  const { code, stdout } = await runBinary('gifsicle', args, gifBuffer);
  if (code === 0 && stdout.length > 0 && stdout.length < gifBuffer.length) return stdout;
  return gifBuffer;
}

/**
 * @param {Buffer} sharpGifBuffer  GIF already encoded by sharp
 * @param {object} cfg
 * @returns {Promise<{ data: Buffer, engine: 'sharp'|'gifsicle' }>}
 */
export async function finalizeGif(sharpGifBuffer, cfg) {
  if (cfg.gifEngine === 'sharp') return { data: sharpGifBuffer, engine: 'sharp' };

  const available = await hasBinary('gifsicle');
  if (!available) {
    if (cfg.gifEngine === 'gifsicle') throw binHint('gifsicle', { code: 'ENOENT' });
    return { data: sharpGifBuffer, engine: 'sharp' }; // auto: silently fall back
  }

  const out = await gifsiclePass(sharpGifBuffer, cfg);
  return { data: out, engine: out === sharpGifBuffer ? 'sharp' : 'gifsicle' };
}
