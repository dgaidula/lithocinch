// CLI argument handling: --help on every command prints help and exits 0, and an
// unknown option on a sub-command is a one-line usage error (exit 2), never a
// Node stack trace (regression: `lithocinch transform --help` used to crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '' });

for (const args of [['--help'], ['-h'], ['transform', '--help'], ['transform', '-h'], ['serve', '--help'], ['serve', '-h']]) {
  test(`lithocinch ${args.join(' ')} prints help to stdout and exits 0`, () => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage: lithocinch/m);
    assert.doesNotMatch(r.stderr, /ERR_PARSE_ARGS|at /);
  });
}

for (const sub of ['transform', 'serve']) {
  test(`lithocinch ${sub} --bogus is a one-line usage error (exit 2)`, () => {
    const r = run(sub, '--bogus');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /--bogus/);
  });
}

for (const args of [['--bogus'], ['--format', 'bmp']]) {
  test(`lithocinch ${args.join(' ')} is a usage error (exit 2), not a run`, () => {
    const r = run(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^error: /m);
    assert.doesNotMatch(r.stderr, /^\s+at \S|CommanderError/m); // no stack frame
  });
}

test('lithocinch --version prints the version and exits 0', () => {
  const r = run('--version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('lithocinch serve names itself lithocinch in its banner', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const banner = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`no banner: ${err}`)), 10000);
      child.stderr.on('data', (c) => { err += c; if (err.includes('\n')) { clearTimeout(timer); resolve(err); } });
    });
    assert.match(banner, /^lithocinch serve \d+\.\d+\.\d+ listening on http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    child.kill();
  }
});
