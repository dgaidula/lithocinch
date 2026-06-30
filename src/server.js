// Tiny HTTP transform daemon (`process-images serve`). A persistent process so
// sharp stays warm — the `daemon` backend for the CMS plugin. Endpoints:
//
//   GET  /health            -> { ok: true, version }
//   POST /transform         -> body is the JSON request (image as base64);
//                              responds { outputs: [ { ..., data: base64 } ] }
//
// Optional bearer-token auth (--token / PI_TOKEN). Stateless: bytes in, bytes
// out. This is the same logic the Lambda runs (see lambda/transform.js).

import http from 'node:http';

import { handleJsonRequest } from './transform-api.js';

const MB = 1024 * 1024;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Create (but don't start) the transform HTTP server.
 * @param {{ version?: string, token?: string|null, maxBodyMb?: number }} [opts]
 * @returns {import('node:http').Server}
 */
export function createServer(opts = {}) {
  const version = opts.version || '0.0.0';
  const token = opts.token || null;
  const limit = (opts.maxBodyMb || 64) * MB;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, version });
      }
      if (req.method !== 'POST' || req.url.split('?')[0] !== '/transform') {
        return send(res, 404, { ok: false, error: 'not found' });
      }
      if (token) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${token}`) return send(res, 401, { ok: false, error: 'unauthorized' });
      }

      const raw = await readBody(req, limit);
      let request;
      try {
        request = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { ok: false, error: 'invalid JSON body' });
      }

      const result = await handleJsonRequest(request);
      return send(res, 200, { ok: true, ...result });
    } catch (err) {
      const status = err.statusCode || 500;
      return send(res, status, { ok: false, error: err.message });
    }
  });
}

/**
 * Start the server. Resolves with { server, port, host }.
 * @param {{ port?: number, host?: string, version?: string, token?: string|null, maxBodyMb?: number }} [opts]
 */
export function startServer(opts = {}) {
  const server = createServer(opts);
  const host = opts.host || '127.0.0.1';
  const port = opts.port ?? 0; // 0 = ephemeral
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host });
    });
  });
}
