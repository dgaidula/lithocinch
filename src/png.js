// PNG encoding — reproduces 2.9's imagemin-pngquant({quality:[0.5,0.6],speed:1})
// intent while staying portable.
//
// 2.9's pngquant had a subtle but deliberate safety feature: with a *minimum*
// quality, pngquant refuses to save (bails) when palette quantization would drop
// below that floor, and imagemin then keeps the image lossless. sharp/libvips
// exposes libimagequant (pngquant's own engine) but NOT that min-quality bail.
// So the default 'sharp' engine here adds an equivalent guard using our SSIM
// metric: palettize, measure SSIM vs the source, and if it falls below
// pngMinSsim, keep a lossless encoding instead of shipping a too-lossy palette.
//
// For byte-exact parity you can opt into the real binary with
// `--png-engine pngquant` (requires pngquant on PATH).

import sharp from 'sharp';

import { ssim, toLuma } from './ssim.js';
import { runBinary } from './bin.js';

const clampPngEffort = (v) => Math.min(10, Math.max(1, Math.round(v)));

function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

/** Lossless PNG: no palette quantization, just max zlib + adaptive filtering. */
function losslessPng(rawBuf, info, cfg) {
  return fromRaw(rawBuf, info, cfg)
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: clampPngEffort(cfg.pngEffort) })
    .toBuffer();
}

/** Lossy palette PNG via libimagequant (== pngquant engine). */
function palettePng(rawBuf, info, cfg) {
  return fromRaw(rawBuf, info, cfg)
    .png({
      quality: cfg.pngQuality,
      palette: true,
      colours: cfg.pngColors,
      dither: cfg.pngDither,
      effort: clampPngEffort(cfg.pngEffort),
      compressionLevel: 9,
    })
    .toBuffer();
}

/**
 * Encode a PNG from raw pixels.
 * @returns {Promise<{ data: Buffer, mode: string, ssim: number|null }>}
 */
export async function encodePng(rawBuf, info, cfg) {
  if (cfg.pngEngine === 'pngquant') return encodePngBinary(rawBuf, info, cfg);
  if (cfg.pngLossless) return { data: await losslessPng(rawBuf, info, cfg), mode: 'lossless', ssim: null };

  const palette = await palettePng(rawBuf, info, cfg);

  // Quality gate: refuse a palette that's perceptually too far from the source.
  if (cfg.pngMinSsim > 0) {
    const ref = toLuma(rawBuf, info.width, info.height, info.channels);
    const dec = await sharp(palette).raw().toBuffer({ resolveWithObject: true });
    const got = toLuma(dec.data, dec.info.width, dec.info.height, dec.info.channels);
    const score = ssim(ref, got, info.width, info.height, { downsample: cfg.pngSsimDownsample });
    if (score < cfg.pngMinSsim) {
      // Too lossy — keep lossless (the never-inflate guard upstream caps it at
      // the original size, exactly what 2.9's pngquant bail effectively did).
      return { data: await losslessPng(rawBuf, info, cfg), mode: 'lossless-fallback', ssim: score };
    }
    return { data: palette, mode: 'palette', ssim: score };
  }
  return { data: palette, mode: 'palette', ssim: null };
}

/** Byte-exact parity: pipe a lossless PNG through the real pngquant binary. */
async function encodePngBinary(rawBuf, info, cfg) {
  const lossless = await losslessPng(rawBuf, info, cfg);
  const args = [
    '--quality',
    `${Math.round(cfg.pngquantMin)}-${Math.round(cfg.pngquantMax)}`,
    '--speed',
    String(Math.round(cfg.pngquantSpeed)),
    '-', // read stdin, write stdout
  ];
  const { code, stdout } = await runBinary('pngquant', args, lossless);
  // pngquant exits 98/99 (and writes nothing) when it can't meet the min quality:
  // that's the "keep it lossless" signal, not an error.
  if (code === 0 && stdout.length > 0) return { data: stdout, mode: 'pngquant', ssim: null };
  if (code === 98 || code === 99 || stdout.length === 0) {
    return { data: lossless, mode: 'lossless-bail', ssim: null };
  }
  throw new Error(`pngquant exited ${code}`);
}
