// Adaptive JPEG encoding — the heart of the tool's compression quality.
//
// 2.9 leaned on `imagemin-jpeg-recompress` (min:30, max:60, quality:"low"),
// which binary-searches JPEG quality per file and keeps the SMALLEST encoding
// whose SSIM vs the source still clears a perceptual target (~0.999 for "low").
// A fixed quality can't match that: a flat graphic and a detailed photo want
// very different quality numbers for the same visual result. This module
// reproduces that adaptive search in-process using sharp/mozjpeg to encode
// candidates and our own SSIM to score them — so it runs anywhere sharp does
// (including Lambda), with no native jpeg-recompress binary required.
//
// An opt-in `jpegEngine: 'jpeg-recompress'` path shells out to the real binary
// for byte-exact parity with 2.9 when it's available locally.

import sharp from 'sharp';

import { toLuma } from './ssim.js';
import { searchQuality, ssimOfEncoded } from './lossy-search.js';
import { runBinary, hasBinary } from './bin.js';

/** Build a sharp instance from a raw pixel buffer, re-attaching sRGB metadata if requested. */
function fromRaw(rawBuf, info, cfg) {
  let img = sharp(rawBuf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (cfg.keepMetadata) img = img.withMetadata({ icc: 'srgb' });
  return img;
}

const encodeAt = (rawBuf, info, cfg, quality) =>
  fromRaw(rawBuf, info, cfg).jpeg({ quality, mozjpeg: cfg.mozjpeg }).toBuffer();

/**
 * Encode a JPEG from raw pixels using the configured engine/mode.
 *
 * @param {Buffer} rawBuf  raw, interleaved pixels (post resize/color/flatten)
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} cfg  resolved config
 * @param {{ inputBytes:number, inputFormat:string }} ctx
 * @returns {Promise<{ data: Buffer, quality: number|null, ssim: number|null, engine: string }>}
 */
export async function encodeJpeg(rawBuf, info, cfg, ctx) {
  if (cfg.jpegMode === 'fixed') {
    const data = await encodeAt(rawBuf, info, cfg, cfg.jpegQuality);
    return { data, quality: cfg.jpegQuality, ssim: null, engine: 'sharp-fixed' };
  }
  if (cfg.jpegEngine === 'jpeg-recompress') {
    return recompressBinary(rawBuf, info, cfg);
  }

  const refLuma = toLuma(rawBuf, info.width, info.height, info.channels);
  const sharpResult = await recompressSSIM(rawBuf, info, cfg, ctx, refLuma);

  // 'auto': also try the real jpeg-recompress when present and keep the smaller
  // result that still clears the SSIM target (same shootout pattern as PNG).
  if (cfg.jpegEngine === 'auto' && (await hasBinary('jpeg-recompress'))) {
    try {
      const bin = await recompressBinary(rawBuf, info, cfg);
      const score = await ssimOfEncoded(bin.data, refLuma, info.width, info.height, cfg.jpegSsimDownsample);
      // Fair bar: the binary just has to be at least as good as what sharp
      // actually achieved (which may itself ride the [min,max] band ceiling below
      // jpegTarget), not held to a stricter standard than the result it competes
      // with. Then it wins only if it's also smaller.
      const bar = Math.min(cfg.jpegTarget, sharpResult.ssim ?? cfg.jpegTarget);
      if (score >= bar && bin.data.length < sharpResult.data.length) {
        return { ...bin, ssim: score };
      }
    } catch {
      // binary failed mid-run — fall back to the sharp result silently
    }
  }
  return sharpResult;
}

/**
 * Adaptive SSIM-guided search (the portable jpeg-recompress replacement).
 * Finds the lowest quality in [jpegMin, jpegMax] whose SSIM >= jpegTarget.
 */
async function recompressSSIM(rawBuf, info, cfg, ctx, refLuma) {
  const search = await searchQuality({
    encode: (q) => encodeAt(rawBuf, info, cfg, q),
    refLuma,
    width: info.width,
    height: info.height,
    min: cfg.jpegMin,
    max: cfg.jpegMax,
    target: cfg.jpegTarget,
    downsample: cfg.jpegSsimDownsample,
  });

  let outData = search.data;
  let outQ = search.quality;
  let outSsim = search.ssim;
  let engine = 'sharp-ssim';

  // "Larger than input" handling (2.9's behavior, hardened). Only meaningful when
  // the source was itself a JPEG. If our best encoding isn't smaller than the
  // original, try a fixed mozjpeg quality and keep whichever is smaller...
  if (ctx.inputFormat === 'jpeg' && outData.length >= ctx.inputBytes) {
    const fb = await encodeAt(rawBuf, info, cfg, cfg.jpegFallbackQuality);
    if (fb.length < outData.length) {
      outData = fb;
      outQ = cfg.jpegFallbackQuality;
      outSsim = null;
    }
    // ...and never INFLATE: if the untouched original is still smaller and the
    // pixels weren't transformed (no resize/trim/square), pass it straight
    // through. 2.9 would have written the larger re-encode here.
    if (!ctx.transformed && ctx.inputBuffer && ctx.inputBuffer.length <= outData.length) {
      outData = ctx.inputBuffer;
      outQ = null;
      outSsim = null;
      engine = 'passthrough';
    }
  }

  return { data: outData, quality: outQ, ssim: outSsim, engine };
}

/**
 * Byte-exact parity path: pipe a high-quality intermediate JPEG through the real
 * `jpeg-recompress` binary (no temp files — stdin/stdout via "-"). Requires the
 * binary on PATH; throws a clear hint otherwise.
 */
async function recompressBinary(rawBuf, info, cfg) {
  // jpeg-recompress operates on a JPEG, so feed it a high-quality intermediate.
  const intermediate = await encodeAt(rawBuf, info, cfg, cfg.jpegRecompressIntermediate);
  const args = [
    '--quality',
    cfg.jpegRecompressPreset,
    '--min',
    String(Math.round(cfg.jpegMin)),
    '--max',
    String(Math.round(cfg.jpegMax)),
    '--method',
    cfg.jpegRecompressMethod,
    '-',
    '-',
  ];
  const { code, stdout, stderr } = await runBinary('jpeg-recompress', args, intermediate);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`jpeg-recompress exited ${code}: ${stderr}`);
  }
  return { data: stdout, quality: null, ssim: null, engine: 'jpeg-recompress' };
}
