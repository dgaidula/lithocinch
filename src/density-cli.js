// `lithocinch density` — set the resolution header of existing JPEGs without
// re-encoding them. Only the JFIF/EXIF density bytes change (density.js); the
// image data is copied through untouched, so the pixels are identical.
//
// Follows the other commands' conventions: files land in an output folder with
// a suffix (never on top of the source unless asked), an existing output is
// skipped unless --overwrite, --dry-run writes nothing, usage errors exit 2.
// Output modes (human, --brief, --json, --quiet) are all rendered from one
// list of items, one per input file, so they cannot disagree.

import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { glob } from 'tinyglobby';

import { parsePpi, RASTER_EXTS } from './config.js';
import { patchJpegDensity, readJpegDensity, DensityError } from './density.js';
import { buildOutputName } from './naming.js';
import { runPool } from './pool.js';

const HELP = `Usage: lithocinch density <file-or-folder...> --ppi <n> [options]

Set the resolution header of JPEGs to <n> pixels per inch without re-encoding:
the JFIF density, the EXIF XResolution/YResolution/ResolutionUnit,
Photoshop's resolution resource and the XMP resolution properties are
rewritten in place and every other byte, the image data included, is copied
unchanged. A JPEG with neither JFIF nor EXIF gets an 18-byte JFIF header
(unless that could change how its colours decode, in which case it is
refused). XMP is rewritten only when its packet padding absorbs the change in
length; otherwise (or for Extended XMP) the file is refused, unless
--allow-stale-xmp writes it as a warn. Folders are scanned recursively for
.jpg and .jpeg; other images found there are listed as skipped.

Options:
  --ppi <n>        resolution to write, a whole number 1-65535 (required)
  -o, --output <dir>  output directory (default: ../img-optimize-output/)
  -s, --suffix <str>  string inserted before each output extension (default: _lco)
  --overwrite      replace an output that already exists (default: skip it)
  --allow-stale-xmp  write a file whose XMP resolution cannot be rewritten in
                   place, as a warn, instead of refusing it
  --dry-run        read and check every file, write nothing
  --brief          one line per file, then a summary line
  --json           the full result as JSON on stdout
  -q, --quiet      the summary line only
  -h, --help       display help for command

To rewrite files where they are: -o <their folder> --suffix "" --overwrite
(each file is written to a temporary name and renamed, never half-written).

Exit status: 0 all files done or skipped; 1 some file was refused, failed or
warned about, or no JPEG was found; 2 usage error; 3 the run could not complete.
`;

const VERDICTS = ['ok', 'warn', 'skip', 'refuse', 'fail'];

/** Show control characters as escapes so one item is always one line. */
const isControl = (n) =>
  (n < 32 && n !== 9) || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
const esc = (s) =>
  [...String(s)]
    .map((c) => {
      const n = c.codePointAt(0);
      return isControl(n) ? (n < 256 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`) : c;
    })
    .join('');

const firstLine = (s) => String(s).split('\n')[0];

/** Describe a readJpegDensity() result for a person: "JFIF 300x300 dpi, EXIF 300/1 in". */
function describe(d) {
  const parts = [];
  if (d.jfif) {
    const unit = ['aspect only', 'dpi', 'dpcm'][d.jfif.units] ?? `unit ${d.jfif.units}`;
    parts.push(d.jfif.units === 0 ? `JFIF ${d.jfif.x}:${d.jfif.y} aspect` : `JFIF ${d.jfif.x}x${d.jfif.y} ${unit}`);
  }
  if (d.exif) {
    const r = (v) => (v ? `${v[0]}/${v[1]}` : 'none');
    const unit = { 2: 'in', 3: 'cm', 1: 'no unit' }[d.exif.unit] ?? (d.exif.unit == null ? 'in (default)' : `unit ${d.exif.unit}`);
    parts.push(`EXIF ${r(d.exif.x)} x ${r(d.exif.y)} ${unit}`);
  }
  if (d.xmp) {
    const unit = { 2: 'in', 3: 'cm', inch: 'in', centimeter: 'cm' }[d.xmp.unit?.toLowerCase()] ?? (d.xmp.unit == null ? 'in (default)' : `unit ${d.xmp.unit}`);
    parts.push(`XMP ${d.xmp.x ?? 'none'} x ${d.xmp.y ?? 'none'} ${unit}`);
  }
  return parts.join(', ') || 'no density header';
}

/** Temporary files being written now, removed if the run is interrupted (SIGINT, SIGTERM). */
const inFlight = new Set();
let interrupted = null; // the signal, once one arrives

const exitInterrupted = () => process.exit(interrupted === 'SIGINT' ? 130 : 143);

/** Write via a temporary name in the same folder, then rename, so a failure leaves no partial file. */
async function writeAtomic(dest, data, mode) {
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  inFlight.add(tmp);
  try {
    await fs.writeFile(tmp, data, { flag: 'wx' });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  } finally {
    inFlight.delete(tmp);
    if (interrupted) {
      // The write was in the thread pool when the signal came: clean up once it settles.
      rmSync(tmp, { force: true });
      if (!inFlight.size) exitInterrupted();
    }
  }
}

/**
 * On SIGINT or SIGTERM: start no new write, let each one in flight settle and
 * remove its temporary file, then exit 130 or 143. A second signal exits at once.
 */
function onSignal(signal) {
  if (interrupted) {
    for (const tmp of inFlight) rmSync(tmp, { force: true });
    exitInterrupted();
  }
  interrupted = signal;
  if (!inFlight.size) exitInterrupted();
}

/**
 * Process one JPEG: read, check, rewrite the header, write. Returns an item.
 * Never throws for a bad input file; that is a `refuse` or `fail` item.
 */
async function processFile(job, o) {
  const item = {
    path: job.src,
    name: job.name,
    verdict: 'ok',
    summary: '',
    reason: '',
    changed: false,
    data: { output: job.dest, ppi: o.ppi },
  };
  const finish = (verdict, summary, reason = '') => Object.assign(item, { verdict, summary, reason });

  if (!o.overwrite && (await exists(job.dest))) {
    return finish('skip', 'output exists', `${job.dest} already exists (--overwrite replaces it)`);
  }
  let bytes;
  try {
    bytes = await fs.readFile(job.src);
  } catch (err) {
    return finish('fail', 'could not read', err.message);
  }
  item.data.bytesIn = bytes.length;

  let before;
  let patch;
  try {
    before = readJpegDensity(bytes); // also rejects a non-JPEG or a damaged header
    patch = patchJpegDensity(bytes, o.ppi, { allowStaleXmp: o.allowStaleXmp });
  } catch (err) {
    if (!(err instanceof DensityError)) throw err;
    const why = { 'not-jpeg': 'not a JPEG', corrupt: 'damaged JPEG', 'stale-xmp': 'XMP not rewritable' }[err.code] ?? 'cannot hold a density';
    return finish('refuse', why, err.code === 'stale-xmp' ? `${err.message}; --allow-stale-xmp writes it anyway` : err.message);
  }
  // A header walk can't see a cut-off image, so decode once and refuse a
  // truncated file rather than hand on a copy that is just as broken.
  try {
    await sharp(bytes, { failOn: 'truncated' }).stats();
  } catch (err) {
    return finish('refuse', 'damaged JPEG', firstLine(err.message));
  }
  // Read the result back: every field present must now say the new ppi, and
  // every field found before the rewrite must still be there.
  const after = readJpegDensity(patch.data);
  const jfifOk = !after.jfif || (after.jfif.units === 1 && after.jfif.x === o.ppi && after.jfif.y === o.ppi);
  const exifOk =
    !after.exif ||
    ((after.exif.unit == null || after.exif.unit === 2) &&
      [after.exif.x, after.exif.y].every((v) => !v || (v[0] === o.ppi && v[1] === 1)));
  const ppiText = [String(o.ppi), `${o.ppi}/1`];
  const xmpOk =
    !patch.patched.includes('XMP') ||
    (after.xmp && [after.xmp.x, after.xmp.y].every((v) => v == null || ppiText.includes(v)) && (after.xmp.unit == null || after.xmp.unit === '2' || after.xmp.unit === 'Inch'));
  const keptOk =
    (!before.jfif || after.jfif) &&
    (!before.exif || (after.exif && ['x', 'y', 'unit'].every((k) => before.exif[k] == null || after.exif[k] != null)));
  if (!jfifOk || !exifOk || !xmpOk || !keptOk) return finish('fail', 'internal check failed', 'the rewritten header did not read back as requested; nothing written');

  Object.assign(item.data, {
    before: describe(before),
    after: describe(after),
    bytesOut: patch.data.length,
    patched: patch.patched,
    unpatched: patch.unpatched,
  });
  if (!o.dryRun) {
    try {
      await writeAtomic(job.dest, patch.data, (await fs.stat(job.src)).mode & 0o777);
    } catch (err) {
      return finish('fail', 'could not write', err.message);
    }
    item.changed = true;
  }
  const verb = o.dryRun ? 'would set' : 'set';
  const grown = patch.data.length - bytes.length;
  const summary = `${verb} ${o.ppi} ppi (${patch.patched.join(', ')}${grown ? `, +${grown} bytes` : ''})`;
  if (patch.unpatched.length) {
    return finish('warn', summary, `also present and not rewritten: ${patch.unpatched.join('; ')}`);
  }
  return finish('ok', summary);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand the path arguments, in the order given, into entries: a `job` to run,
 * or an `item` already decided (an argument that can't be used).
 */
async function plan(args, o) {
  const entries = [];
  const items = { push: (item) => entries.push({ item }) };
  const seen = new Map(); // dest -> src
  const addJob = (src, rel) => {
    const name = rel;
    const outName = buildOutputName(rel, { suffix: o.suffix, spaceChar: null });
    const dest = path.join(o.outputRoot, outName);
    if (seen.has(dest)) {
      items.push({
        path: src, name, verdict: 'refuse', summary: 'output collides', changed: false,
        reason: `would write the same output as ${seen.get(dest)}: ${dest}`, data: { output: dest, ppi: o.ppi },
      });
      return;
    }
    seen.set(dest, src);
    entries.push({ job: { src, name, dest } });
  };
  for (const arg of args) {
    let st;
    try {
      st = await fs.stat(arg);
    } catch {
      items.push({ path: arg, name: arg, verdict: 'refuse', summary: 'no such path', reason: 'path does not exist', changed: false, data: {} });
      continue;
    }
    if (st.isDirectory()) {
      const root = path.resolve(arg);
      const rel = path.relative(root, o.outputRoot);
      const ignore = ['**/node_modules/**'];
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ignore.push(`${rel.split(path.sep).join('/')}/**`);
      const globOpts = { cwd: root, caseSensitiveMatch: false, onlyFiles: true, dot: false, ignore };
      const found = (await glob(['**/*.jpg', '**/*.jpeg'], globOpts)).sort();
      if (!found.length) {
        items.push({ path: arg, name: arg, verdict: 'skip', summary: 'no JPEG files', reason: 'folder holds no .jpg or .jpeg files', changed: false, data: {} });
      }
      for (const f of found) addJob(path.join(root, f), f);
      // Other images are named, so an incomplete output folder is not a surprise.
      const others = RASTER_EXTS.filter((e) => e !== 'jpg' && e !== 'jpeg').map((e) => `**/*.${e}`);
      for (const f of (await glob(others, globOpts)).sort()) {
        items.push({ path: path.join(root, f), name: f, verdict: 'skip', summary: 'not a JPEG', reason: 'lithocinch density rewrites JPEGs only', changed: false, data: {} });
      }
    } else {
      addJob(path.resolve(arg), path.basename(arg));
    }
  }
  return entries;
}

// ---- rendering: every mode reads the same item list -----------------------

function summarize(items) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const it of items) counts[it.verdict]++;
  return counts;
}

const summaryLine = (counts, dryRun) =>
  `summary: ${VERDICTS.map((v) => `${v}=${counts[v]}`).join(' ')}${dryRun ? '  (dry run: nothing written)' : ''}`;

function briefReason(reason) {
  const chars = [...esc(reason)];
  return chars.length > 160 ? `${chars.slice(0, 160).join('')}… (+${chars.length - 160} chars; --json for all)` : chars.join('');
}

function render(mode, items, counts, ctx) {
  const lines = [];
  if (mode === 'json') {
    return JSON.stringify(
      { tool: 'lithocinch', version: ctx.version, command: 'density', effect: ctx.dryRun ? 'dry-run' : 'applied', exit: ctx.exit, items, summary: counts },
      null,
      2
    );
  }
  if (mode !== 'quiet') {
    for (const it of items) {
      const reason = it.reason && it.verdict !== 'ok' ? `  (${mode === 'brief' ? briefReason(it.reason) : esc(it.reason)})` : '';
      lines.push(`${it.verdict} ${it.summary}  ${esc(it.name)}${reason}`);
      if (mode === 'human' && it.data.after) {
        lines.push(`    was   ${it.data.before}`, `    now   ${it.data.after}`);
        lines.push(`    to    ${it.data.output}  (${it.data.bytesIn} -> ${it.data.bytesOut} bytes)`);
      }
    }
  }
  lines.push(summaryLine(counts, ctx.dryRun));
  return lines.join('\n');
}

// ---- entry point -----------------------------------------------------------

function usageError(message) {
  process.stderr.write(`lithocinch density: ${message} (see "lithocinch density --help")\n`);
  process.exitCode = 2;
}

export async function runDensity(argv, version) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ppi: { type: 'string' },
        output: { type: 'string', short: 'o', default: '../img-optimize-output/' },
        suffix: { type: 'string', short: 's', default: '_lco' },
        overwrite: { type: 'boolean', default: false },
        'allow-stale-xmp': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        brief: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    if (!String(err.code).startsWith('ERR_PARSE_ARGS_')) throw err;
    return usageError(err.message);
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.ppi == null) return usageError('--ppi <n> is required');
  let ppi;
  try {
    ppi = parsePpi(values.ppi, '--ppi');
  } catch (err) {
    return usageError(err.message);
  }
  if (!positionals.length) return usageError('give at least one JPEG file or folder');
  const modes = ['brief', 'json', 'quiet'].filter((m) => values[m]);
  if (modes.length > 1) return usageError(`--${modes.join(' and --')} cannot be combined`);
  const mode = modes[0] ?? 'human';

  const o = {
    ppi,
    suffix: values.suffix,
    overwrite: values.overwrite,
    allowStaleXmp: values['allow-stale-xmp'],
    dryRun: values['dry-run'],
    outputRoot: path.resolve(values.output),
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const entries = await plan(positionals, o);
    const jobs = entries.filter((e) => e.job);
    const done = await runPool(jobs, 8, (e) => processFile(e.job, o));
    done.forEach((r, k) => {
      if (r.status === 'rejected') throw r.reason; // an unexpected bug, not a bad file: exit 3
      jobs[k].item = r.value;
    });
    const items = entries.map((e) => e.item);
    const counts = summarize(items);
    // No JPEG to work on at all is a 1 too: the output folder is not what was asked for.
    const exit = counts.warn || counts.refuse || counts.fail || !jobs.length ? 1 : 0;
    process.stdout.write(render(mode, items, counts, { version, dryRun: o.dryRun, exit }) + '\n');
    process.exitCode = exit;
  } catch (err) {
    process.stderr.write(`lithocinch density: could not complete: ${err.message}\n`);
    process.exitCode = 3;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
