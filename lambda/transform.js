// AWS Lambda handler for the synchronous transform API — the `remote` backend of
// the CMS plugin. Designed for a Lambda Function URL or API Gateway (HTTP API)
// with payload format 2.0. Same logic as `process-images serve`; bytes in (base64
// JSON body), bytes out (base64 JSON) — stateless and storage-agnostic, so it
// works regardless of where the caller (Craft/GCS, S3, local) keeps its files.
//
// Env: PI_TOKEN (optional) — require `Authorization: Bearer <PI_TOKEN>`.
//
// Packaging: install sharp for the Lambda platform before zipping, e.g.
//   npm install --os=linux --cpu=arm64 sharp   # arm64 (Graviton)
//   npm install --os=linux --cpu=x64   sharp   # x86_64

import { handleJsonRequest } from '../src/transform-api.js';

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

/**
 * @param {object} event  Function URL / API Gateway v2 event
 */
export async function handler(event) {
  try {
    const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
    const rawPath = event?.rawPath || event?.path || '/transform';
    const path = rawPath.split('?')[0];

    if (method === 'GET' && path === '/health') return json(200, { ok: true });
    if (method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

    const token = process.env.PI_TOKEN;
    if (token) {
      const auth = event.headers?.authorization || event.headers?.Authorization || '';
      if (auth !== `Bearer ${token}`) return json(401, { ok: false, error: 'unauthorized' });
    }

    let body = event.body || '';
    if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');

    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return json(400, { ok: false, error: 'invalid JSON body' });
    }

    const result = await handleJsonRequest(request);
    return json(200, { ok: true, ...result });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
}
