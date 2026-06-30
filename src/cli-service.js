// `serve` and `transform` sub-commands — the transform-API backends used by the
// CMS plugin (and mirrored by the Lambda). Kept out of the main commander program
// so they parse independently.

import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';

import { startServer } from './server.js';
import { runTransform, handleJsonRequest } from './transform-api.js';

export async function runSubcommand(name, argv, version) {
  if (name === 'serve') return serve(argv, version);
  if (name === 'transform') return transform(argv, version);
}

// --- process-images serve [--port N] [--host H] [--token T] [--max-body MB] ---
async function serve(argv, version) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: process.env.PI_PORT || '0' },
      host: { type: 'string', default: process.env.PI_HOST || '127.0.0.1' },
      token: { type: 'string', default: process.env.PI_TOKEN || '' },
      'max-body': { type: 'string', default: '64' },
    },
  });
  const { port, host } = await startServer({
    port: Number(values.port),
    host: values.host,
    token: values.token || null,
    maxBodyMb: Number(values['max-body']),
    version,
  });
  process.stderr.write(
    `process-images serve ${version} listening on http://${host}:${port}` +
      `${values.token ? ' (token auth on)' : ''}\n  POST /transform  ·  GET /health\n`
  );
  // keep the process alive
}

// --- process-images transform ---
// Default: read a JSON request {image:base64, ops, format, batch, defaults} on
// stdin, write {outputs:[{...,data:base64}]} to stdout. Convenience flags let you
// transform a file directly for testing.
async function transform(argv, version) {
  const { values } = parseArgs({
    args: argv,
    options: {
      in: { type: 'string' }, // image file (instead of base64 in stdin JSON)
      out: { type: 'string' }, // write primary output bytes here (implies single)
      ops: { type: 'string' }, // JSON ops object
      format: { type: 'string' },
      raw: { type: 'boolean', default: false }, // single output -> raw bytes to stdout
    },
  });

  // File mode: --in given -> build a request from flags, optionally write --out.
  if (values.in) {
    const image = await fs.readFile(values.in);
    const ops = values.ops ? JSON.parse(values.ops) : {};
    const outputs = await runTransform(image, { ops, format: values.format });
    const primary = outputs[0];
    if (values.out) {
      await fs.writeFile(values.out, primary.data);
      process.stderr.write(`${primary.format} ${primary.width}x${primary.height} ${primary.bytes}B -> ${values.out}\n`);
    } else if (values.raw) {
      process.stdout.write(primary.data);
    } else {
      process.stdout.write(JSON.stringify({ outputs: outputs.map((o) => ({ ...o, data: o.data.toString('base64') })) }) + '\n');
    }
    return;
  }

  // Stdin JSON mode (the CLI-driver contract).
  const raw = await readStdin();
  const request = JSON.parse(raw.toString('utf8'));
  if (values.format && request.format === undefined) request.format = values.format;
  const result = await handleJsonRequest(request);
  process.stdout.write(JSON.stringify(result) + '\n');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}
