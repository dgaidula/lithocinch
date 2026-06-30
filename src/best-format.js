// Auto-pick output format (`--format auto`). For each image, encode it in every
// viable candidate format (reusing the content-aware perceptually-lossless
// encoders) and output the SMALLEST result — changing the extension to match.
// The opinionated extreme of "tightest file at best quality", across formats.
//
// Decisions (see RESEARCH.md):
//   - JPEG competes only if it clears the perceptual bar (it's band-clamped and
//     rarely wins; excluding it when it can't is a clean prune).
//   - Tie-break (within --format-tolerance of the smallest): prefer the MORE
//     COMPATIBLE format, so a 2% AVIF win doesn't churn every URL to .avif.
//   - The untouched original is always a candidate (never inflate / never do
//     worse than today).
//   - Alpha => JPEG is excluded (it can't carry transparency losslessly).

import { classify } from './content-aware.js';
import { encodeJpeg } from './jpeg.js';
import { encodePng } from './png.js';
import { encodeWebp } from './webp.js';
import { encodeAvif } from './avif.js';

// Browser/tooling compatibility rank — lower is more universally supported.
const COMPAT_RANK = { jpeg: 0, png: 0, gif: 0, tiff: 0, webp: 1, avif: 2 };

/** Ordered candidate formats for an image, pruned by content + alpha + allow-list. */
function candidatePool(cls, cfg) {
  let pool = cls.photographic ? ['avif', 'webp', 'jpeg'] : ['webp', 'png', 'avif'];
  if (cls.hasAlpha) pool = pool.filter((f) => f !== 'jpeg'); // JPEG has no alpha
  return pool.filter((f) => cfg.formatPool.includes(f));
}

async function encodeCandidate(fmt, rawBuf, info, cfg, ctx) {
  switch (fmt) {
    case 'jpeg': {
      const r = await encodeJpeg(rawBuf, info, cfg, ctx);
      return { fmt: 'jpeg', data: r.data, ssim: r.ssim, lossless: false, engine: r.engine };
    }
    case 'png': {
      const r = await encodePng(rawBuf, info, cfg);
      const lossless = String(r.mode).startsWith('lossless');
      return { fmt: 'png', data: r.data, ssim: lossless ? 1 : r.ssim, lossless, engine: r.engine };
    }
    case 'webp': {
      const r = await encodeWebp(rawBuf, info, cfg, ctx);
      return { fmt: 'webp', data: r.data, ssim: r.mode === 'lossy' ? r.ssim : 1, lossless: r.mode !== 'lossy', engine: `webp-${r.mode}` };
    }
    case 'avif': {
      const r = await encodeAvif(rawBuf, info, cfg, ctx);
      return { fmt: 'avif', data: r.data, ssim: r.mode === 'lossy' ? r.ssim : 1, lossless: r.mode !== 'lossy', engine: `avif-${r.mode}` };
    }
    default:
      return null;
  }
}

/**
 * @param {Buffer} rawBuf  decoded pixels (alpha preserved)
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} cfg
 * @param {{ inputFormat:string, inputBytes:number, inputBuffer:Buffer, transformed:boolean }} ctx
 * @returns {Promise<{ data:Buffer, outputFormat:string, ssim:number|null, engine:string }>}
 */
export async function pickBestFormat(rawBuf, info, cfg, ctx) {
  const cls = classify(ctx.inputFormat, rawBuf, info, cfg.webpGraphicColorCap);
  cls.hasAlpha = info.channels === 4;
  const pool = candidatePool(cls, cfg);

  const candidates = [];
  for (const fmt of pool) {
    try {
      const c = await encodeCandidate(fmt, rawBuf, info, cfg, ctx);
      if (c) candidates.push(c);
    } catch {
      // codec unavailable in this libvips build -> skip it
    }
  }

  // Always consider keeping the original untouched (never inflate, never do worse).
  if (!ctx.transformed && ctx.inputBuffer) {
    const fmt = ctx.inputFormat === 'jpg' ? 'jpeg' : ctx.inputFormat;
    candidates.push({ fmt, data: ctx.inputBuffer, ssim: 1, lossless: true, engine: 'passthrough', original: true });
  }

  // Decision (a): JPEG competes only if it meets the perceptual bar.
  const eligible = candidates.filter(
    (c) => !(c.fmt === 'jpeg' && c.ssim != null && c.ssim < cfg.perceptualTarget)
  );
  const finalists = eligible.length ? eligible : candidates;

  // Smallest wins, but a more-compatible candidate within tolerance beats it.
  finalists.sort((a, b) => a.data.length - b.data.length);
  const smallest = finalists[0];
  const ceiling = smallest.data.length * (1 + cfg.formatTolerance);
  const within = finalists.filter((c) => c.data.length <= ceiling);
  within.sort((a, b) => (COMPAT_RANK[a.fmt] ?? 9) - (COMPAT_RANK[b.fmt] ?? 9) || a.data.length - b.data.length);
  const win = within[0];

  return {
    data: win.data,
    outputFormat: win.fmt,
    ssim: win.lossless ? null : win.ssim,
    engine: win.original ? 'passthrough' : win.engine,
  };
}
