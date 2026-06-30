// Shared helper for the optional external-binary engines (jpeg-recompress,
// pngquant). Pipes input via stdin and captures stdout — no temp files — and
// resolves with the exit code so callers can treat tool-specific "soft" codes
// (e.g. pngquant's 98/99 "quality too low") as a fallback rather than a crash.

import { spawn } from 'node:child_process';

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {Buffer} input
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
export function runBinary(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return reject(binHint(bin, err));
    }
    const out = [];
    const errOut = [];
    child.on('error', (err) => reject(binHint(bin, err)));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errOut.push(d));
    child.on('close', (code) =>
      resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString().trim() })
    );
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits early
    child.stdin.end(input);
  });
}

// Is a binary available on PATH? Cached per process so the `auto` engines can
// probe once and reuse the answer across every file in a run.
const availability = new Map();
export function hasBinary(bin) {
  if (!availability.has(bin)) {
    availability.set(
      bin,
      new Promise((resolve) => {
        let child;
        try {
          child = spawn(bin, ['--version']);
        } catch {
          return resolve(false);
        }
        child.on('error', () => resolve(false));
        child.stdout?.resume();
        child.stderr?.resume();
        // Any clean spawn that reaches 'close' means the binary exists (even if
        // --version returns non-zero on some tools).
        child.on('close', () => resolve(true));
      })
    );
  }
  return availability.get(bin);
}

export function binHint(bin, err) {
  if (err && err.code === 'ENOENT') {
    const install =
      bin === 'pngquant'
        ? 'brew install pngquant'
        : bin === 'jpeg-recompress'
          ? 'brew install jpeg-archive'
          : `install ${bin}`;
    return new Error(`"${bin}" not found on PATH. ${install}, or use the built-in engine instead.`);
  }
  return err;
}
