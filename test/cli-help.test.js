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
