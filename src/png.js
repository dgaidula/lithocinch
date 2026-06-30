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
import { runBinary, hasBinary, binHint } from './bin.js';

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

/** SSIM of an encoded PNG vs the source raw luma (1.0 == identical). */
async function scoreVsSource(refLuma, info, encoded, cfg) {
  const dec = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
  const got = toLuma(dec.data, dec.info.width, dec.info.height, dec.info.channels);
  return ssim(refLuma, got, info.width, info.height, { downsample: cfg.pngSsimDownsample });
}

/**
 * Encode a PNG from raw pixels.
 *
 *  - 'sharp'    : built-in libimagequant palette, with the SSIM quality gate.
 *  - 'pngquant' : byte-exact parity via the real pngquant binary.
 *  - 'auto'     : run sharp AND (if pngquant is on PATH) pngquant, then keep the
 *                 SMALLEST output that still clears the SSIM quality bar — the
 *                 opinionated "tightest at acceptable quality" choice.
 *
 * @returns {Promise<{ data: Buffer, mode: string, ssim: number|null, engine: string }>}
 */
export async function encodePng(rawBuf, info, cfg) {
  // Lossless is an explicit quality choice — never shoot it out against a lossy
  // palette engine, regardless of pngEngine.
  if (cfg.pngLossless) {
    return { data: await losslessPng(rawBuf, info, cfg), mode: 'lossless', ssim: null, engine: 'sharp' };
  }
  if (cfg.pngEngine === 'pngquant') {
    const r = await encodePngBinary(rawBuf, info, cfg);
    return { ...r, engine: 'pngquant' };
  }

  const sharpResult = await encodePngSharp(rawBuf, info, cfg);
  if (cfg.pngEngine === 'sharp' || !(await hasBinary('pngquant'))) {
    return { ...sharpResult, engine: 'sharp' };
  }

  // auto shootout: compare sharp's (already quality-safe) result against pngquant.
  const refLuma = toLuma(rawBuf, info.width, info.height, info.channels);
  const pq = await encodePngBinary(rawBuf, info, cfg);
  // pngquant's lossless-bail meets the bar by definition; otherwise gate it.
  const pqOk =
    pq.mode === 'lossless-bail' || (await scoreVsSource(refLuma, info, pq.data, cfg)) >= cfg.pngMinSsim;

  if (pqOk && pq.data.length < sharpResult.data.length) {
    return { ...pq, engine: 'pngquant' };
  }
  return { ...sharpResult, engine: 'sharp' };
}

/** Built-in libimagequant path with the SSIM quality gate. */
async function encodePngSharp(rawBuf, info, cfg) {
  if (cfg.pngLossless) return { data: await losslessPng(rawBuf, info, cfg), mode: 'lossless', ssim: null };

  const palette = await palettePng(rawBuf, info, cfg);
  if (cfg.pngMinSsim > 0) {
    const ref = toLuma(rawBuf, info.width, info.height, info.channels);
    const score = await scoreVsSource(ref, info, palette, cfg);
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
