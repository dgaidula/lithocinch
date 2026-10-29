// Single-image transform API — the shared backbone for the CMS plugin's three
// backends: the `transform` CLI (stdin/stdout JSON), the `serve` HTTP daemon, and
// the AWS Lambda. All three decode a request, call runTransform(), and re-encode
// the result. Bytes in, bytes out — the service is stateless and storage-agnostic
// (GCS / S3 / local all handled by the *caller*, e.g. Craft's Fs abstraction).
//
// Request shape (image supplied separately as a Buffer):
//   {
//     ops:    { width, height, fit, position, focal:{x,y}, maxSize, bg, trim },
//     format: 'auto' | 'jpeg' | 'png' | 'webp' | 'avif' | 'keep',
//     batch:  [ { ops, format }, ... ],   // multiple outputs from one source
//     defaults: { perceptualTarget, formatPool, keepMetadata, ... any config key }
//   }
// Response: [ { format, width, height, bytes, ssim, engine, data: Buffer }, ... ]

import { optimizeImageBuffer } from './optimize.js';
import { ConfigError } from './config.js';

/** Map a transform `ops` object onto optimizeImageBuffer option keys. */
function opsToOptions(ops = {}) {
  const o = {};
  for (const k of ['width', 'height', 'fit', 'position', 'focal', 'maxSize', 'square', 'trim']) {
    if (ops[k] !== undefined) o[k] = ops[k];
  }
  if (ops.bg !== undefined) o.bgColor = ops.bg;
  return o;
}

/**
 * Run one or more transforms against a single source image.
 * @param {Buffer} image  decoded source bytes
 * @param {object} request  see file header
 * @returns {Promise<Array<{format:string,width?:number,height?:number,bytes:number,ssim:number|null,engine:string|null,data:Buffer}>>}
 */
export async function runTransform(image, request = {}) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new ConfigError('runTransform: `image` must be a non-empty Buffer'); // a malformed request (exit 2 from the CLI)
  }
  const base = request.defaults || {};
  const items = Array.isArray(request.batch) && request.batch.length
    ? request.batch
    : [{ ops: request.ops, format: request.format }];

  const outputs = [];
  for (const item of items) {
    const format = item.format ?? request.format ?? base.format ?? 'auto';
    const opts = { ...base, ...opsToOptions(item.ops), format: format === 'keep' ? null : format };
    const r = await optimizeImageBuffer(image, opts);
    outputs.push({
      format: r.outputFormat,
      width: r.info?.width ?? null,
      height: r.info?.height ?? null,
      bytes: r.data.length,
      ssim: r.ssim ?? null,
      engine: r.engine ?? null,
      data: r.data,
    });
  }
  return outputs;
}

/** Serialize outputs for JSON transport (Buffer data -> base64). */
export function serializeOutputs(outputs) {
  return outputs.map((o) => ({ ...o, data: o.data.toString('base64') }));
}

/**
 * Decode + run a JSON request whose image is carried as base64 (`image` field)
 * — the form used by the CLI stdin, the HTTP daemon, and the Lambda body.
 * @param {object} req  request object with `image` as base64 string (or Buffer)
 * @returns {Promise<{ outputs: Array }>}
 */
export async function handleJsonRequest(req = {}) {
  const image = Buffer.isBuffer(req.image) ? req.image : Buffer.from(String(req.image || ''), 'base64');
  const outputs = await runTransform(image, req);
  return { outputs: serializeOutputs(outputs) };
}
