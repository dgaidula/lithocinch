// CLI argument handling: --help on every command prints help and exits 0, and an
// unknown option on a sub-command is a one-line usage error (exit 2), never a
// Node stack trace (regression: `lithocinch transform --help` used to crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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
    assert.match(r.stderr, /^error: --cheat and --(json|quiet) cannot be combined/);
  });
}

test('lithocinch --help and --version take precedence over --cheat', () => {
  assert.equal(run('--cheat', '--help').stdout, run('--help').stdout);
  assert.equal(run('--cheat', '--version').stdout, run('--version').stdout);
});

// ---- exit status of a run ---------------------------------------------------

/** Run `fn(dir)` in a fresh temporary folder, removed afterwards. */
async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lco-cli-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const tiny = (background, w = 32, h = 24) => sharp({ create: { width: w, height: h, channels: 3, background } });

test('a run with errors exits 1 in --json exactly as in human mode', async () => {
  await withDir(async (dir) => {
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    await tiny('#888').jpeg().toFile(path.join(input, 'good.jpg'));
    await fs.writeFile(path.join(input, 'broken.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const to = (o) => [input, '-o', path.join(dir, o), '--error-dir', path.join(dir, `${o}-err`), '-q'];
    const human = run(...to('h'));
    assert.equal(human.status, 1, human.stderr);
    const json = run(...to('j'), '--json');
    assert.equal(json.status, 1, json.stderr);
    assert.equal(JSON.parse(json.stdout).errors, 1);
    await fs.rm(path.join(input, 'broken.jpg'));
    const clean = run(...to('c'), '--json');
    assert.equal(clean.status, 0, 'a run without errors still exits 0');
  });
});

test('lithocinch transform with a bad option, bad JSON or a bad density is a one-line error (exit 2), not a stack trace', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'a.jpg');
    const jpeg = await tiny('#888').jpeg().toBuffer();
    await fs.writeFile(file, jpeg);
    const stdin = (req) => spawnSync(process.execPath, [CLI, 'transform'], { encoding: 'utf8', input: JSON.stringify(req) });
    const cases = {
      '--format bogus': run('transform', '--in', file, '--format', 'bogus'),
      '--ops not JSON': run('transform', '--in', file, '--ops', '{width:'),
      'defaults.density abc': stdin({ image: jpeg.toString('base64'), defaults: { density: 'abc' } }),
      'density with webp': stdin({ image: jpeg.toString('base64'), format: 'webp', defaults: { density: 72 } }),
      'no image': stdin({ format: 'jpeg' }),
    };
    for (const [label, r] of Object.entries(cases)) {
      assert.equal(r.status, 2, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, '', label);
      assert.match(r.stderr, /^error: \S.*\n$/, `${label}: one line`);
    }
    assert.match(cases['defaults.density abc'].stderr, /--density "abc"/);
    const good = stdin({ image: jpeg.toString('base64'), format: 'jpeg', defaults: { density: 72 } });
    assert.equal(good.status, 0, good.stderr);
  });
});

test('sources that would write the same output are refused before any job starts, at any concurrency', async () => {
  await withDir(async (dir) => {
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    await tiny('#c00').gif().toFile(path.join(input, 'a.gif'));
    await tiny('#0c0').png().toFile(path.join(input, 'a.png'));
    await tiny('#00c').webp().toFile(path.join(input, 'a.webp'));
    const mean = async (file) => (await sharp(file).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean / 64));
    for (let k = 0; k < 3; k++) {
      const out = path.join(dir, `jpeg${k}`);
      const r = run(input, '-o', out, '--error-dir', path.join(dir, 'err'), '--format', 'jpeg', '-c', '8', '-q', '--json');
      assert.equal(r.status, 1, r.stderr);
      const stats = JSON.parse(r.stdout);
      assert.equal(stats.processed, 1);
      assert.deepEqual(stats.refusedFiles.map((f) => [f.file, f.output]).sort(), [['a.png', 'a_lco.jpg'], ['a.webp', 'a_lco.jpg']]);
      assert.match(stats.refusedFiles[0].reason, /^a\.gif writes the same output: a_lco\.jpg$/);
      assert.match(r.stderr, /^ {2}a\.png: not written: a\.gif writes the same output: a_lco\.jpg$/m);
      assert.deepEqual(await fs.readdir(out), ['a_lco.jpg']);
      assert.deepEqual(await mean(path.join(out, 'a_lco.jpg')), [3, 0, 0], 'the first source in sorted order (a.gif, red) wins every time');
    }
    // --emit: a primary keeps its own name; another file's sibling of that name is refused.
    const out = path.join(dir, 'emit');
    const r = run(input, '-o', out, '--error-dir', path.join(dir, 'err'), '--emit', 'webp', '-c', '8', '--json');
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).refusedFiles.map((f) => `${f.file} ${f.output}`).sort(), ['a.gif a_lco.webp', 'a.png a_lco.webp']);
    assert.deepEqual(await mean(path.join(out, 'a_lco.webp')), [0, 0, 3], 'a.webp (blue) keeps a_lco.webp');
    // Human mode names the count; a run with no collision has no such line.
    const human = run(input, '-o', path.join(dir, 'h'), '--error-dir', path.join(dir, 'err'), '--format', 'png');
    assert.match(human.stderr.replace(/\x1b\[[0-9;]*m/g, ''), /^ {2}refused {3}: 2 outputs not written \(reasons above\)$/m);
    const none = run(input, '-o', path.join(dir, 'n'), '--error-dir', path.join(dir, 'err'));
    assert.equal(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stderr, /refused/);
  });
});

test('outputs that differ only in case collide where the volume ignores case (the macOS default), and not where it does not', async () => {
  await withDir(async (dir) => {
    const input = path.join(dir, 'in');
    await fs.mkdir(input);
    await tiny('#c00').png().toFile(path.join(input, 'Logo.png'));
    await tiny('#00c').gif().toFile(path.join(input, 'logo.gif'));
    // Ask the volume itself, independently of the code under test.
    const insensitive = await fs.access(path.join(input, 'LOGO.PNG')).then(() => true, () => false);
    const out = path.join(dir, 'out');
    const r = run(input, '-o', out, '--error-dir', path.join(dir, 'err'), '--format', 'jpeg', '-q', '--json');
    const stats = JSON.parse(r.stdout);
    if (insensitive) {
      assert.equal(r.status, 1, r.stderr);
      assert.deepEqual(stats.refusedFiles.map((f) => [f.file, f.reason]), [['logo.gif', 'Logo.png writes the same output: logo_lco.jpg']]);
      assert.deepEqual(await fs.readdir(out), ['Logo_lco.jpg']);
    } else {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual((await fs.readdir(out)).sort(), ['Logo_lco.jpg', 'logo_lco.jpg']);
    }
  });
});
