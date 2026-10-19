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

// --cheat: the tldr card. parseCheat() is the skeleton's validator (ADOPTING.md section 8).
// Parse a --cheat card as a tldr page, throwing a message that names the first
// rule it breaks. The shape is the one the CHEAT comment in the tool spells out:
// "# name", blank, "> " lines ending "> More information: name --help.", blank,
// then 3 to 6 examples of "- what it does:", blank, "`name args`", blank-separated.
// Copy this into an adopted tool's tests to prove its card is a page.
function parseCheat(text) {
  const fail = (m) => { throw new Error(`cheat card: ${m}`); };
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('must end with exactly one newline');
  const lines = text.slice(0, -1).split('\n');
  const title = /^# (\S+)$/.exec(lines[0]);
  if (!title) fail('line 1 must be "# <tool-name>"');
  const name = title[1];
  if (lines[1] !== '') fail('line 2 must be blank');
  let i = 2;
  const description = [];
  while (i < lines.length && lines[i].startsWith('> ')) description.push(lines[i++].slice(2));
  if (description.length < 2) fail('the description block needs a purpose line and a "More information" line');
  if (description.at(-1) !== `More information: ${name} --help.`) fail('the description block must end "More information: <tool-name> --help."');
  const examples = [];
  while (i < lines.length) {
    if (lines[i] !== '') fail(`line ${i + 1} must be blank before an example`);
    const [what, gap, cmd] = lines.slice(i + 1, i + 4);
    if (!/^- [A-Z].*:$/.test(what ?? '')) fail(`line ${i + 2} must be "- Sentence-case description:"`);
    if (gap !== '') fail(`line ${i + 3} must be blank between the description and the command`);
    const m = /^`([\x20-\x7e]+)`$/.exec(cmd ?? '');
    if (!m) fail(`line ${i + 4} must be the command in backticks, in plain ASCII`);
    if (m[1] !== name && !m[1].startsWith(`${name} `)) fail(`line ${i + 4} must start with the tool name "${name}"`);
    if ((m[1].match(/\{\{/g) ?? []).length !== (m[1].match(/\}\}/g) ?? []).length) fail(`line ${i + 4} has unbalanced {{placeholders}}`);
    examples.push({ what: what.slice(2), cmd: m[1] });
    i += 4;
  }
  if (examples.length < 3 || examples.length > 6) fail(`needs 3 to 6 examples, has ${examples.length}`);
  return { name, description, examples };
}

test('lithocinch --cheat prints a tldr page for "lithocinch", exits 0, prints nothing else', () => {
  const r = run('--cheat');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const page = parseCheat(r.stdout);
  assert.equal(page.name, 'lithocinch');
  assert.ok(page.examples.length >= 3);
});

for (const mode of ['--json', '--quiet', '-q']) {
  test(`lithocinch --cheat ${mode} is a usage error (exit 2, stdout empty)`, () => {
    const r = run('--cheat', mode);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--cheat and --(json|quiet) cannot be combined/);
  });
}

test('lithocinch --help and --version take precedence over --cheat', () => {
  assert.equal(run('--cheat', '--help').stdout, run('--help').stdout);
  assert.equal(run('--cheat', '--version').stdout, run('--version').stdout);
});
