// Example AWS Lambda handler — S3 "object created" trigger.
//
// Flow: an image lands in SOURCE_BUCKET (or the event's bucket) -> Lambda reads
// the bytes -> process-images optimizes them in memory -> the result is written
// to DEST_BUCKET under DEST_PREFIX. No /tmp scratch files, no native bin-wrapper
// binaries: just sharp (prebuilt libvips) + svgo, both of which run fine in the
// Lambda Node runtime.
//
// Packaging notes:
//   - sharp ships platform-specific binaries. Install for Lambda's platform:
//       npm i --os=linux --cpu=arm64 sharp     # for arm64 (Graviton) functions
//       npm i --os=linux --cpu=x64   sharp     # for x86_64 functions
//     then zip node_modules + this file, or use a Lambda layer.
//   - The AWS SDK v3 (@aws-sdk/client-s3) is preinstalled in the Lambda Node 18+
//     runtime, so it is NOT a dependency of this package.
//
// Env vars:
//   DEST_BUCKET   (required) bucket to write optimized images to
//   DEST_PREFIX   (optional) key prefix for outputs, default "optimized/"
//   MAX_SIZE, JPEG_QUALITY, FORMAT, SUFFIX ... any DEFAULTS key, UPPER_SNAKE_CASE

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { optimizeBytes } from '../src/index.js';

const s3 = new S3Client({});

// Map UPPER_SNAKE env vars onto the camelCase options the library expects.
function optionsFromEnv() {
  const opts = {};
  const num = (v) => (v == null ? undefined : Number(v));
  if (process.env.MAX_SIZE != null) opts.maxSize = num(process.env.MAX_SIZE);
  if (process.env.SUFFIX != null) opts.suffix = process.env.SUFFIX;
  if (process.env.FORMAT) opts.format = process.env.FORMAT;
  if (process.env.JPEG_QUALITY != null) opts.jpegQuality = num(process.env.JPEG_QUALITY);
  if (process.env.PNG_QUALITY != null) opts.pngQuality = num(process.env.PNG_QUALITY);
  if (process.env.WEBP_QUALITY != null) opts.webpQuality = num(process.env.WEBP_QUALITY);
  if (process.env.KEEP_METADATA != null) opts.keepMetadata = process.env.KEEP_METADATA === 'true';
  return opts;
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * @param {{ Records?: Array<{ s3: { bucket: { name: string }, object: { key: string } } }> }} event
 */
export async function handler(event) {
  const destBucket = process.env.DEST_BUCKET;
  if (!destBucket) throw new Error('DEST_BUCKET env var is required');
  const destPrefix = process.env.DEST_PREFIX ?? 'optimized/';
  const baseOpts = { ...optionsFromEnv(), suffix: process.env.SUFFIX ?? '' };

  const records = event.Records ?? [];
  const results = [];

  for (const record of records) {
    const srcBucket = record.s3.bucket.name;
    // S3 keys arrive URL-encoded and use '+' for spaces.
    const srcKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    const obj = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    const bytes = await streamToBuffer(obj.Body);

    const filename = srcKey.split('/').pop();
    const optimized = await optimizeBytes(bytes, filename, baseOpts);

    // Preserve the source key's folder structure, swap in the optimized filename.
    const dir = srcKey.includes('/') ? srcKey.slice(0, srcKey.lastIndexOf('/') + 1) : '';
    const destKey = `${destPrefix}${dir}${optimized.outName.split('/').pop()}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        Body: optimized.data,
        ContentType: contentType(optimized),
      })
    );

    results.push({
      srcKey,
      destKey,
      bytesIn: bytes.length,
      bytesOut: optimized.data.length,
      saved: bytes.length - optimized.data.length,
    });
  }

  return { ok: true, count: results.length, results };
}

function contentType(result) {
  if (result.kind === 'svg') return 'image/svg+xml';
  const map = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', tiff: 'image/tiff' };
  return map[result.outputFormat] || 'application/octet-stream';
}
