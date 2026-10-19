// `serve` and `transform` sub-commands — the transform-API backends used by the
// CMS plugin (and mirrored by the Lambda). Kept out of the main commander program
// so they parse independently.

import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';

import { startServer } from './server.js';
import { runTransform, handleJsonRequest } from './transform-api.js';

const HELP = {
  serve: `Usage: lithocinch serve [options]

Run the transform API as a persistent HTTP daemon (POST /transform, GET /health).

Options:
  --port <n>       port to listen on (default: $PI_PORT or 0 = any free port)
  --host <addr>    address to bind (default: $PI_HOST or 127.0.0.1)
  --token <str>    require "authorization: Bearer <str>" (default: $PI_TOKEN)
  --max-body <MB>  largest request body accepted, in MB (default: 64)
  -h, --help       display help for command
`,
  transform: `Usage: lithocinch transform [options]

One-shot transform. Default: read a JSON request on stdin
({image:base64, ops, format, batch, defaults}) and write {outputs:[...]} to stdout.

Options:
  --in <file>      read the image from this file instead of stdin JSON
  --out <file>     write the primary output bytes here (with --in)
  --ops <json>     JSON ops object, e.g. '{"width":800}' (with --in)
  --format <fmt>   output format (jpeg, png, webp, avif, gif, auto, ...)
  --raw            with --in: write the single output's raw bytes to stdout
  -h, --help       display help for command
`,
};

// parseArgs with -h/--help handled and bad arguments reported as a one-line
// usage error (exit 2) instead of a Node stack trace. Returns null when the
// caller should stop (help printed or usage error); exitCode lets stdout drain.
function parseFlags(name, argv, options) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } } }));
  } catch (err) {
    if (!String(err.code).startsWith('ERR_PARSE_ARGS_')) throw err;
    process.stderr.write(`lithocinch ${name}: ${err.message} (see "lithocinch ${name} --help")\n`);
    process.exitCode = 2;
    return null;
  }
  if (values.help) {
    process.stdout.write(HELP[name]);
    return null;
  }
  return values;
}

export async function runSubcommand(name, argv, version) {
  if (name === 'serve') return serve(argv, version);
  if (name === 'transform') return transform(argv, version);
}

// --- lithocinch serve [--port N] [--host H] [--token T] [--max-body MB] ---
async function serve(argv, version) {
  const values = parseFlags('serve', argv, {
    port: { type: 'string', default: process.env.PI_PORT || '0' },
    host: { type: 'string', default: process.env.PI_HOST || '127.0.0.1' },
    token: { type: 'string', default: process.env.PI_TOKEN || '' },
    'max-body': { type: 'string', default: '64' },
  });
  if (!values) return;
  const { port, host } = await startServer({
    port: Number(values.port),
    host: values.host,
    token: values.token || null,
    maxBodyMb: Number(values['max-body']),
    version,
  });
  process.stderr.write(
    `lithocinch serve ${version} listening on http://${host}:${port}` +
      `${values.token ? ' (token auth on)' : ''}\n  POST /transform  ·  GET /health\n`
  );
  // keep the process alive
}

// --- lithocinch transform ---
// Default: read a JSON request {image:base64, ops, format, batch, defaults} on
// stdin, write {outputs:[{...,data:base64}]} to stdout. Convenience flags let you
// transform a file directly for testing.
async function transform(argv, version) {
  const values = parseFlags('transform', argv, {
    in: { type: 'string' }, // image file (instead of base64 in stdin JSON)
    out: { type: 'string' }, // write primary output bytes here (implies single)
    ops: { type: 'string' }, // JSON ops object
    format: { type: 'string' },
    raw: { type: 'boolean', default: false }, // single output -> raw bytes to stdout
  });
  if (!values) return;

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
