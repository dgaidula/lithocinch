# Lithocinch

**Perceptually-lossless, best-format image optimization — measured, not guessed.**
*Lithographic quality, cinched.*

Most optimizers ship a fixed `quality: 82` and hope. Lithocinch **measures**: it
binary-searches the encoder quality per image against a structural-similarity
(**SSIM**) target — landing on the smallest file that’s still perceptually identical
to the source — then runs a **format shootout** (AVIF / WebP / JPEG / PNG) and ships
the smallest one the client can actually display.

### Results

Real output, verified end-to-end through a Craft CMS site writing to Google Cloud Storage:

| Source | Optimized (800px) | Reduction |
|---|---|---|
| 1,644 KB PNG | **13 KB AVIF** | **−99.2%**, perceptually lossless |

**[RESEARCH.md](./RESEARCH.md)** documents *why* each codec behaves as it does, with
measured numbers — the methodology, not marketing.

One engine, four runtimes: **CLI · library · AWS Lambda · [Craft CMS plugin](https://github.com/dgaidula/craft-lithocinch)**.

---

Fast, batch image optimizer built on [**sharp**](https://sharp.pixelplumbing.com/)
and [**svgo**](https://github.com/svg/svgo). Point it at a folder and it will,
for every image in the tree:

- **cap dimensions** to a max width/height (default 2560px),
- **normalize color to sRGB** (CMYK and oddly-profiled images included),
- **compress** JPEG with an **adaptive per-file quality search** (the
  `jpeg-recompress` approach — picks the smallest quality that still looks right
  by SSIM), plus PNG (libimagequant palette), GIF, WebP, AVIF, TIFF, and SVG,
- **convert** real TIFFs — including phone/WhatsApp files mislabeled as `.jpg` —
  to JPEG,
- **mirror the folder structure** into an output directory, copying any
  non-image files (PDFs, docs…) straight through,
- and route anything corrupt to an error folder instead of crashing.

It runs three ways from one codebase: a **CLI**, an importable **library**, and
an **AWS Lambda** (S3-triggered). No ImageMagick, no global binaries — sharp
ships prebuilt libvips, which is also Lambda-compatible.

> This is the 3.x rewrite of a long-lived personal tool (`process-images-2.9.js`).
> See **[NOTES.md](./NOTES.md)** for the architecture, the full
> old-variable → flag mapping, and behavioral differences from 2.x.

## Requirements

- Node.js ≥ 20

## Install

```bash
# global CLI
npm install -g lithocinch

# or per-project / as a library
npm install lithocinch
```

Or from a clone:

```bash
git clone <repo> lithocinch && cd lithocinch
npm install
npm link        # optional: puts `lithocinch` on your PATH
```

## CLI usage

```bash
lithocinch [input-dir] [options]
```

Run it from (or point it at) the folder of images. By default it writes to a
sibling `../img-optimize-output/` folder and skips files already optimized there.

```bash
# optimize the current folder with defaults
lithocinch

# a specific folder, custom output, force everything to WebP at 1600px
lithocinch ./photos -o ./web --format webp --max-size 1600

# square-pad product shots onto a white canvas, higher JPEG quality
lithocinch ./products --square --bg-color "#ffffff" --jpeg-quality 90

# see what would happen without writing anything
lithocinch ./photos --dry-run --verbose
```

`lithocinch --cheat` prints a short card of common invocations in tldr page format.

### Common options

| Flag | Default | Description |
|---|---|---|
| `[input]` | `.` | Input directory (recursive) |
| `-o, --output <dir>` | `../img-optimize-output/` | Output directory |
| `-s, --suffix <str>` | `_lco` | Inserted before each file's extension |
| `-m, --max-size <px>` | `2560` | Cap width & height (`0` / `--no-resize` to disable) |
| `-f, --format <fmt>` | *keep* | `jpeg`/`png`/`webp`/`avif`/`gif`/`tiff`, or **`auto`** (smallest per image) |
| `--manifest <path>` | — | JSON `source → output` map; enables `--format auto` skip-detection |
| `--webp-mode <m>` | `auto` | `auto` (classify + shoot out), `lossy`, `lossless`, `near-lossless` |
| `--emit <formats>` | — | Also write sibling formats (e.g. `webp,avif`) for `<picture>` |
| `--density <ppi>` | — | Write this resolution into JPEG and PNG outputs ([details](#resolution-headers---density-and-lithocinch-density)) |
| `--allow-stale-xmp` | off | With `--density`: write a JPEG whose XMP resolution can’t be rewritten in place, with a warning, instead of refusing it |
| `--square` | off | Pad to a `max-size` square using `--bg-color` |
| `--jpeg-target <ssim>` | `0.999` | Adaptive JPEG SSIM target (`0.999` = jpeg-recompress "low") |
| `--jpeg-min` / `--jpeg-max` | `30` / `60` | Adaptive JPEG quality search band |
| `--jpeg-mode <mode>` | `recompress` | `recompress` (adaptive) or `fixed` |
| `--jpeg-quality <n>` | `80` | Fixed JPEG quality (only with `--jpeg-mode fixed`) |
| `--png-quality <n>` | `100` | PNG palette quality search ceiling (libimagequant) |
| `--png-min-ssim <n>` | `0.92` | Palette must clear this SSIM, else fall back to lossless |
| `--png-engine <e>` | `auto` | `auto` (shootout) / `sharp` (libimagequant) / `pngquant` (binary) |
| `--gif-engine <e>` | `auto` | `auto` (lossless gifsicle pass when available) / `sharp` / `gifsicle` |
| `--overwrite` | off | Reprocess even if output already exists |
| `--flatten` | off | Write output flat instead of mirroring subfolders |
| `--no-copy-non-images` | — | Don't copy non-image files through |
| `-c, --concurrency <n>` | `16` | Images processed in parallel |
| `--dry-run` | off | Plan only; write nothing |
| `--json` | off | Print summary as JSON (the exit status is the same as without it) |

Two sources that would write the same output path — `a.gif`, `a.png` and
`a.webp` under `--format jpeg` all become `a_lco.jpg`, and `--emit webp` gives
`a.png` a sibling with the name `a.webp` writes — are settled before any file
is processed, so with a fixed `--format` the result never depends on which job
finishes first: primary outputs are claimed before `--emit` siblings, each in
sorted source order, the first keeps the path, and each later one is
**refused** (not written, named in the log with the file that keeps it,
counted on a `refused` summary line and in `refused` / `refusedFiles` in
`--json`). A run with a refusal or an error exits 1. On a volume that ignores
case in names (the macOS and Windows default, probed at the start of the run)
`Logo_lco.jpg` and `logo_lco.jpg` are one file, so names that differ only in
case collide there too; on a case-sensitive volume they are two files and both
are written. **Under `--format auto` the winner can vary between runs:** a name
is known only after encoding, so it is claimed when the file is written, the
first file written keeps it, and which file finishes encoding first can differ
from one run to the next. The later one is still refused, never overwritten.

Run `lithocinch --help` for the complete list (color, trim, metadata, AVIF,
SVG, error-dir, etc.). Every option also exists as a library option key — see
the mapping table in [NOTES.md](./NOTES.md).

> **Legacy suffix (`_opt`).** As of 3.1.0 the default output suffix is `_lco`
> (“lithocinch optimized”), replacing the generic `_opt` that carried over from
> the original `process-images` script. To restore the old behavior — e.g. for a
> tree already built with `photo_opt.*` names — pass `-s _opt` (or `--suffix _opt`),
> or set `suffix: '_opt'` when calling the library. `-s ''` drops the suffix
> entirely (`photo.jpg` → `photo.avif`).

## Auto-pick the best format (`--format auto`)

Let the tool choose the smallest format for each image — it encodes the viable
candidates and ships the winner, changing the extension to match:

```bash
lithocinch ./images --format auto --manifest ./out/manifest.json
```

```
photographic.png  1.27 MB  ->  4.3 KB   .avif   (no longer a bloated PNG)
logo.png          11 KB    ->  64 B     .webp   (lossless)
photo.jpg         700 KB   ->  7.4 KB   .avif
icon-with-alpha   ...      ->  .webp            (alpha preserved; JPEG excluded)
```

- **Photographic PNGs stop being PNGs** — they convert to AVIF/WebP automatically.
- **Tie-break favors compatibility:** when two formats are within
  `--format-tolerance` (default 3%), the more universally-supported one wins, so a
  trivial AVIF edge doesn't rewrite every URL to `.avif`.
- **Restrict the pool** for conservative targets: `--format-pool webp,jpeg,png`
  drops AVIF.
- **The manifest matters.** Because extensions change, `--manifest` records
  `source → output, format, bytes` for every file — feed it to your build/HTML
  rewrite, and re-runs use it to skip already-done files. Pair with `--emit` to
  also write guaranteed fallbacks.

See [RESEARCH.md §9](./RESEARCH.md) for the candidate-pool and tie-break rules.

## Emit `<picture>` fallbacks alongside originals

`--emit` writes extra formats **next to** each optimized image (keeping the
primary), so you get a modern-format set without changing the original:

```bash
lithocinch ./photos --emit webp,avif
#  photo.jpg  ->  photo_lco.jpg   (primary, optimized)
#               + photo_lco.webp  (content-aware)
#               + photo_lco.avif  (content-aware)
```

Each sibling uses that codec's content-aware/perceptual settings. The primary
format is never duplicated, SVGs are skipped, and re-runs fill in only missing
siblings — so adding `--emit avif` to an already-processed tree just backfills the
AVIFs. Pair with `<picture>`:

```html
<picture>
  <source srcset="photo_lco.avif" type="image/avif">
  <source srcset="photo_lco.webp" type="image/webp">
  <img src="photo_lco.jpg" alt="">
</picture>
```

## Resolution headers (`--density` and `lithocinch density`)

**Hardened:** 2026-10-29 · 8b85bbf · gate CLOSED WITH FOLLOW-UPS (release gate at `xhigh` FIX FIRST, two fix rounds, re-gate and closure re-check; for the `--density` release)

Some submission forms ask for an exact resolution (72 ppi for one awards
program, 300 for print). The number lives in a few header bytes that do not
affect the pixels, and lithocinch can set it two ways. They differ in what they
promise.

| | `--density <ppi>` | `lithocinch density <files> --ppi <n>` |
|---|---|---|
| Does | the normal optimize run, then writes the resolution into each output | rewrites the resolution of JPEGs you already have |
| Re-encodes | yes, as always (smaller files, resized, sRGB) | **no**: the image data is copied byte for byte |
| Guarantees | the output is the optimizer’s output, plus a header that says *n* ppi | the decoded pixels are identical to the input’s |
| Formats | JPEG and PNG | JPEG only |
| Cost | 0 bytes (PNG) or 18 bytes (JPEG) over the same run without it | 0 bytes when the file already has a density header, 18 when it needs one |

```bash
# optimize a folder and stamp 72 ppi on every JPEG and PNG that comes out
lithocinch ./submission -o ./ready --density 72

# keep your own pixels exactly: only the resolution header changes
lithocinch density print-export.jpg --ppi 72 -o ./ready
lithocinch density ./exports --ppi 72 --dry-run --brief
```

### What gets written

**JPEG** can hold a density in four places, and each is rewritten wherever it
exists:

- the **JFIF** header: units set to pixels per inch, plus the horizontal and
  vertical density;
- **EXIF**: `XResolution` and `YResolution` (stored as fractions, rewritten as
  *n*/1) and `ResolutionUnit` (set to inches, so a file saved in centimetres is
  not left claiming 72 per centimetre);
- **Photoshop’s resolution resource** (APP13, resource `0x03ED`): a fixed
  16-byte record, rewritten in place to *n* pixels per inch (the display units
  Photoshop shows in its dialog are left as they were);
- **XMP**: `tiff:XResolution`, `tiff:YResolution` and `tiff:ResolutionUnit`
  (and the same names under `exif:` or any other prefix), rewritten in place
  (see below).

A JPEG with neither JFIF nor EXIF (what sharp writes, so every file lithocinch
itself has optimized) gets an 18-byte JFIF header inserted. That is done only
when it cannot change how a decoder reads the colours: a file with an Adobe
marker, with four components, or with components labelled R, G, B is refused
instead.

XMP matters because Apple ImageIO (Preview, Finder) reads it before JFIF: a
JPEG whose XMP says 300 still shows 300 there after its JFIF header says 72.
XMP is a text packet, and `300/1` → `72/1` changes its length, so it is
rewritten **in place**: each value keeps its form (a fraction is written as
*n*/1, a whole number as *n*), the unit becomes 2 (inch), and the difference
in length is taken from, or given to, the whitespace padding that writers such
as Photoshop leave before `<?xpacket end="w"?>`. The APP1 segment keeps its
exact length and no byte outside the packet changes. Only the two plain forms
are edited, an attribute (`tiff:XResolution="300/1"`) and an element holding
nothing but its value (`<tiff:XResolution>300/1</tiff:XResolution>`); a
`ResolutionUnit` stored as the word `Inch` or `Centimeter` (any case), as some
writers do, becomes `Inch`. A longer name such as `exif:FocalPlaneXResolution`
is not a resolution and is left alone. Only the image’s own properties are
edited, those of an `rdf:Description` directly inside `rdf:RDF`: the same
name inside a comment or inside another attribute’s value is text, and one
inside a nested resource (an `xmpMM:Pantry` or `xmpMM:DerivedFrom` entry
describes another document) is not this image’s; all of these are left as
they are.

When the XMP **cannot** be rewritten that way — no padding to absorb a longer
value (or no `<?xpacket end?>` at all when the length changes), Extended XMP
(a packet split over several APP1 segments), a packet marked read-only
(`<?xpacket end="r"?>`), a UTF-16 packet (JPEG XMP must be UTF-8, but Apple
ImageIO reads one), a name with no namespace prefix (a default namespace),
markup that cannot be followed to the end (an unclosed tag, quote, comment or
element), a resolution on an element that is not an `rdf:Description`, or a
value in any other form (attributes on the element, markup or entities inside
it, a decimal) — the file is **refused** and nothing is written for it:
`lithocinch density` gives it the verdict `refuse` (`XMP not rewritable`), and
the main command leaves that output unwritten, logs the reason, counts it
under `refused` and exits 1. `--allow-stale-xmp` (on either command;
`allowStaleXmp` in the library) writes such a file anyway with its old XMP, as
before: a `warn` in `lithocinch density`, a stale count on the main command,
and a warning that names the value XMP still holds and who reads it, for
example `XMP resolution fields (still 300 ppi; Apple ImageIO (Preview, Finder)
reads XMP before JFIF)`. Either way the run exits 1, so a script sees that a
file still carries an old value.

The thumbnail’s EXIF (IFD1) is **not** rewritten; readers ignore it.

**PNG** stores a density in its `pHYs` chunk, in pixels per *metre*, so a whole
number of inches is not exactly representable: 72 ppi is stored as 2835 and
reads back as 72.01, 300 ppi as 11811 (299.9994). Programs round it, and
ImageMagick reports the pixel-per-centimetre figure. An existing `pHYs` is
replaced in place; a missing one is inserted (21 bytes). A PNG that carries
EXIF (an `eXIf` chunk, kept by `--keep-metadata`) has that EXIF’s resolution
rewritten too, and the chunk’s checksum recomputed: libvips and Apple ImageIO
read `eXIf` before `pHYs`.

**WebP, AVIF, GIF and TIFF output are not supported.** WebP and AVIF can only
hold a resolution inside an EXIF block, which sharp writes at 190 to 255 bytes
and many tools ignore; GIF has no field for it; TIFF output is not wired up
yet. Asking for them is refused up front (`--density 72 --format webp` is a
usage error, exit 2, as is `--emit webp`). With `--format auto` the candidate
pool for still images is narrowed to JPEG and PNG; an animated input still
goes through its own WebP-versus-GIF shootout, so it comes out as WebP or GIF
without a density and is reported. When the format is only known per file (the
default keeps each file’s own format, so a folder can hold a WebP), the file is
still written, a warning names it, and the summary counts it under
`density: not written`. An untouched original that cannot hold a density can
still win an `auto` shootout; it is reported the same way.

An untouched original that wins (the optimizer could not make it smaller) also
keeps whatever XMP it had, and that XMP is rewritten or refused as above (an
encoded output carries no XMP: sharp does not keep it). With
`--allow-stale-xmp`, or for a Photoshop resolution resource that is not the
expected 16 bytes, such a file gets its JFIF or EXIF density but is not counted
as written: a warning names the file and the stale field, the summary line
counts it as `written but an older value kept in another field`,
`--json` lists it under `density.staleFiles`, and the run exits 1 (as a `warn`
does in `lithocinch density`).

### Metadata, and what the number costs

lithocinch strips metadata for size, and `--density` keeps that. The header
bytes are rewritten *after* encoding, so nothing else is added: no ICC profile,
no EXIF block. sharp’s own `withDensity` could do it during encoding, but
it adds an EXIF block (about 190 bytes on a small JPEG, 192 on a PNG), and
`withMetadata({ density })` also embeds an ICC profile (about 690 bytes). Rewriting
the header costs 18 bytes on a JPEG (the JFIF header) and none on a PNG.
With `--keep-metadata`, EXIF that is kept has its resolution rewritten too.

Skip-detection looks only at whether the output file exists, so after changing
`--density` on a re-run, add `--overwrite` or the existing outputs are kept as
they are. The summary line says how many were skipped this way:
`density   : 72 ppi written to 0, not written to 0, 14 skipped (density not checked)`.

### `lithocinch density`

```
lithocinch density <file-or-folder...> --ppi <n> [-o dir] [-s suffix] [--overwrite] [--dry-run]
                   [--allow-stale-xmp] [--brief | --json | --quiet]
```

It follows the directory command’s conventions: copies go to `-o` (default
`../img-optimize-output/`, a folder tree is mirrored) with `-s` inserted before
the extension (default `_lco`, though names keep their spaces here), an output
that already exists is skipped unless `--overwrite`, and `--dry-run` reads and
checks every file and writes nothing. To rewrite files where they are, name
their own folder as the output:
`lithocinch density ./exports --ppi 72 -o ./exports --suffix "" --overwrite`
(see the known limits below for what a rewrite in place does to links).

A folder is scanned for `.jpg` and `.jpeg`; any other image in it (PNG, WebP,
GIF, AVIF, TIFF) is listed as `skip not a JPEG`, so an output folder that is
missing them is no surprise. Each file is checked before anything is written. A
file that is not a JPEG, has a damaged header, is cut off partway through the
image (it is decoded once to find out), cannot hold a density, or has an XMP
resolution that cannot be rewritten in place (without `--allow-stale-xmp`) is
**refused** and no output is made for it. Output is written to a temporary name
beside the destination and then renamed, so a failed write never leaves a
half-written file, and an interrupted run (Ctrl-C, SIGTERM) removes the
temporary files it was writing before it exits 130 or 143.

Output has four shapes, all rendered from the same list of results (one per
file): the default (a few lines per file, showing the header before and after),
`--brief` (one line per file, `<verdict> <summary>  <name>`, then a summary
line), `--json`, and `--quiet` (the summary line). Verdicts are `ok`, `warn`,
`skip`, `refuse` and `fail`. Exit status: `0` all done or skipped, `1` any file
refused, failed or warned about, or no JPEG found to work on, `2` usage error,
`3` the run could not complete.

```
$ lithocinch density print-export.jpg --ppi 72 -o ready --brief
ok set 72 ppi (JFIF, EXIF)  print-export.jpg
summary: ok=1 warn=0 skip=0 refuse=0 fail=0
```

The library exports `patchJpegDensity`, `patchPngDensity`, `readJpegDensity`, `readPngDensity` and `DensityError` (Buffer in, Buffer out) for the same job without the CLI; `patchJpegDensity(buf, ppi, { allowStaleXmp })` throws a `DensityError` with code `stale-xmp` for an XMP it cannot rewrite, and `readJpegDensity` adds an `xmp` entry when a packet names a resolution. `optimizeImageBuffer` takes `density` and `allowStaleXmp` options, returns what happened in `result.density`, and throws the same `stale-xmp` error.

### Known limits

- **XMP is rewritten only in place.** A packet without enough padding for the
  new values, Extended XMP, a read-only or UTF-16 packet, an unprefixed name,
  or a value in a form other than a plain attribute or element is refused (see
  above); `--allow-stale-xmp` writes it with the old XMP. XMP in a PNG (an
  `iTXt` chunk on a passed-through original) is neither rewritten nor
  reported.
- **Extended XMP is refused even when it need not be.** A file whose main
  packet holds the resolution and whose extension names none is refused all
  the same, and with `--allow-stale-xmp` its main packet is written unchanged
  rather than rewritten.
- **`lithocinch density` refuses Photoshop “Save for Web” JPEGs.** They carry
  an Adobe APP14 marker and EXIF without a resolution, and no JFIF header, so
  there is nothing to rewrite and a JFIF header is not added next to an Adobe
  marker (see above). In a survey of local files this was 85 of 2,980 JPEGs
  (2.9%) and 18 of 60 made by Photoshop. The main command’s `--density`, which
  re-encodes, handles them.
- **The thumbnail’s EXIF (IFD1) is not rewritten or reported.** ImageMagick
  and Apple ImageIO both read IFD0.
- **PNG density is per metre**, so 72 ppi reads back as 72.01 and 300 as
  299.9994 (see above).
- **Apple ImageIO ignores a JFIF-only density outside a middle range.**
  Measured with `sips`: 1, 2, 9600, 32767 and 65535 ppi show as 72; 10 to
  4800 read correctly. ImageMagick reads all of them.
- **An inserted JFIF header can make an untouched original 18 bytes larger
  than its source.** The never-inflate check runs before the density is
  written, and a header was asked for, so the 18 bytes are kept.
- **Skip-detection ignores `--density`.** Add `--overwrite` to change the
  density of outputs that already exist; the summary counts the ones skipped.
- **A file that fails to optimize** is copied to the output folder with its
  original header (as without `--density`); it is counted under `errors`, not
  on the density line.
- **The transform service** (the `transform` CLI, `serve` and the Lambda sync
  handler) accepts `defaults.density` but does not report whether a density
  was written for each output.
- **A rewrite in place replaces the file by renaming a new one over it.** A
  symbolic link is replaced by a regular file (its target keeps the old
  density), a hard link is broken (the other name keeps the old bytes),
  extended attributes such as Finder tags are dropped, and a read-only file is
  rewritten without comment.
- **Only SIGINT and SIGTERM are cleaned up after.** A run killed with SIGKILL,
  or by a power cut, can leave hidden `.<name>.<pid>.<hex>.tmp` files beside
  its outputs; they are safe to delete.
- **`lithocinch density` does not yet catch outputs that differ only in
  case.** On a case-insensitive volume (the macOS default),
  `lithocinch density a/Same.jpg b/same.jpg` reports both `ok` and leaves one
  `Same_lco.jpg` holding the second file’s pixels, replacing the first without
  `--overwrite`. The main command does catch this. Give such files distinct
  names, or run them one at a time, until it is fixed.
- **A resolution name in element text is refused.** A `dc:description` that
  says “Set XResolution to 300” (or the name inside CDATA or a DOCTYPE) makes the
  packet refused, with the reason “has no namespace prefix”. It is a safe
  over-refusal; `--allow-stale-xmp` writes the file anyway.
- **Collision checks and volumes.** When the output folder does not exist yet
  and its nearest existing parent is a volume’s root, the case probe can ask the
  wrong volume. On a case-sensitive volume, two names that differ only in
  Unicode normalization (`café` written two ways) are not caught.
- **Two XMP packets.** When the second cannot be rewritten,
  `--allow-stale-xmp` writes the first one rewritten, and the warning names the
  first packet’s new value rather than the stale one.

## Transform service (CMS plugin / Lambda backbone)

Besides batch-optimizing folders, the tool exposes a **single-image transform
API** for on-demand use (a CMS image transform, a build step, an upload hook).
The same `runTransform()` core is reachable three ways — pick per host:

| Transport | Command | Use |
|---|---|---|
| **CLI** (stdin→stdout JSON) | `lithocinch transform` | shell out from PHP/anything; needs Node on the box |
| **HTTP daemon** | `lithocinch serve` | persistent, warm sharp; POST from localhost |
| **AWS Lambda** | `lambda/transform.js` | hosts that can't run Node; same logic, Function URL |

**Bytes in, bytes out — stateless and storage-agnostic.** The caller reads the
source (from GCS, S3, local, a Craft `Fs`…) and writes the results; the service
never touches storage. So it works with any backend, including the
`craftcms/google-cloud` filesystem, with no integration.

### Request / response contract

```jsonc
// request (image carried as base64 in the `image` field)
{
  "image": "<base64>",
  "ops":    { "width": 800, "height": 600, "fit": "cover",
              "focal": { "x": 0.3, "y": 0.6 }, "maxSize": 2560, "bg": "#fff" },
  "format": "auto",                       // or jpeg|png|webp|avif|keep
  "batch":  [ { "ops": { "width": 800 }, "format": "avif" },   // one source ->
              { "ops": { "width": 800 }, "format": "webp" },   // many outputs
              { "ops": { "width": 800 }, "format": "auto" } ], // (<picture>)
  "defaults": { "perceptualTarget": 0.99, "formatPool": ["avif","webp","jpeg"] }
}
```
```jsonc
// response
{ "ok": true, "outputs": [
  { "format": "avif", "width": 800, "height": 533, "bytes": 1914,
    "ssim": 0.997, "engine": "avif-lossy", "data": "<base64>" }
]}
```

`fit` maps to the usual CMS modes: `cover` (crop), `inside`/`contain` (fit),
`fill` (stretch). `focal` is `{x,y}` in 0..1 for a focal-point crop.

### Run it

```bash
# one-shot, from a file (testing)
lithocinch transform --in photo.jpg --ops '{"width":800}' --format auto --out out.avif

# one-shot, JSON on stdin (the shell-out contract)
echo '{"image":"...","ops":{"width":800},"format":"auto"}' | lithocinch transform

# persistent daemon (warm), optional bearer token
lithocinch serve --port 4111 --token "$PI_TOKEN"
curl -s localhost:4111/transform -H "authorization: Bearer $PI_TOKEN" \
  -d '{"image":"...","ops":{"width":800},"format":"auto"}'
```

The Lambda (`lithocinch/lambda/transform`) takes the identical JSON body via a
Function URL / API Gateway v2 event and honors `PI_TOKEN`.

`lithocinch transform` reports a failure as one `error: …` line on stderr: exit
2 for a bad option or request (an unknown `--format`, a bad `density`, JSON
that does not parse, no `image`), exit 1 for a failure while transforming.

## Library usage

```js
import {
  optimizeImageBuffer, // raster bytes -> optimized bytes (pure)
  optimizeSvg,         // svg string   -> optimized string (pure)
  optimizeBytes,       // any image bytes + filename -> { data, outName, ... } (pure)
  optimizeFile,        // one file on disk -> optimized file
  processDirectory,    // whole tree -> mirrored output tree
} from 'lithocinch';

// In-memory, framework-agnostic:
const { data, info } = await optimizeImageBuffer(inputBuffer, {
  maxSize: 1600,
  format: 'webp',
  webpQuality: 82,
});

// Drive a whole folder with progress callbacks:
const stats = await processDirectory(
  { input: './photos', output: './out', maxSize: 2048 },
  { onProgress: (e) => e.type === 'done' && console.log(e.file) }
);
console.log(stats); // { processed, skipped, errors, copied, bytesIn, bytesOut, ... }
```

## AWS Lambda

`lambda/handler.js` is a ready-to-adapt **S3 object-created** handler: it reads
the uploaded image, optimizes it in memory with the same core, and writes the
result to a destination bucket — no `/tmp` scratch files.

```
SOURCE_BUCKET ──S3 event──▶ Lambda ──optimizeBytes()──▶ DEST_BUCKET/optimized/...
```

Environment variables: `DEST_BUCKET` (required), `DEST_PREFIX` (default
`optimized/`), plus optional `MAX_SIZE`, `FORMAT`, `JPEG_QUALITY`, … .

**Packaging:** install sharp for the Lambda platform before zipping (or use a
layer):

```bash
# arm64 (Graviton) functions
npm install --os=linux --cpu=arm64 sharp
# x86_64 functions
npm install --os=linux --cpu=x64 sharp
```

The AWS SDK v3 (`@aws-sdk/client-s3`) is already in the Lambda Node 18+ runtime,
so it is **not** a dependency of this package.

## How it handles color (the old "tmp" problem)

Earlier versions kept a temp directory to fix CMYK JPEGs: decode → color-
transform to RGB → re-encode to a temp file → re-optimize. That's gone. sharp
reads any embedded ICC profile and converts to sRGB **in memory** in a single
pipeline, so CMYK and mis-profiled images come out correct with no scratch files
— which is also what makes the Lambda path clean. Use `--keep-metadata` to
re-embed an sRGB ICC profile + EXIF; the default strips metadata for size.

## Adaptive JPEG compression (the important part)

JPEG quality is **not** a fixed number. By default the tool reproduces the
`jpeg-recompress` strategy this project has relied on for years: for each image
it binary-searches JPEG quality within a band (default **30–60**) and keeps the
**smallest** encoding whose **SSIM** vs the source still clears a perceptual
target (default **0.999** — jpeg-recompress's "low" preset). A flat graphic gets
crushed to the floor; a detailed photo settles higher — each file gets its own
sweet spot instead of a one-size-fits-all quality.

```bash
# loosen or tighten the perceptual target
lithocinch ./photos --jpeg-target 0.997
# widen the quality band
lithocinch ./photos --jpeg-min 35 --jpeg-max 75
# see the chosen quality + SSIM per file
lithocinch ./photos --verbose         # ... scene.jpg -> scene.jpg (685KB -> 30KB q58 ssim0.9951)
```

The built-in engine (`sharp-ssim`) needs no native binary, so it runs in Lambda
too. For **byte-exact parity** with the original `jpeg-recompress` binary:

```bash
brew install jpeg-archive   # provides the `jpeg-recompress` binary
lithocinch ./photos --jpeg-engine jpeg-recompress
```

Its SSIM is the standard Wang metric and is *close to* — not identical to —
JPEG-Archive's; the 30–60 band keeps results tight either way. `--jpeg-mode
fixed --jpeg-quality 80` switches to a plain single-quality encode. With the real
`jpeg-recompress` on PATH, the default `--jpeg-engine auto` shoots it out against
the built-in and keeps the smaller. See [NOTES.md §1e](./NOTES.md).

## WebP (content-aware)

`--format webp` converts the tree to WebP, and `--webp-mode auto` (default)
**picks lossy vs lossless per image by measuring both** — because the right mode
depends on the content, not the source extension:

| source | → webp | chosen mode |
|---|---|---|
| photo / JPEG | much smaller | **lossy** (quality-searched to an SSIM target) |
| flat graphic / logo / screenshot | tiny, **exact** | **lossless** |
| photographic PNG | much smaller | **lossy** |
| animated GIF | smaller, frames kept | animated **lossy** WebP |

```bash
lithocinch ./photos --format webp                 # auto per image
lithocinch ./ui --format webp --webp-mode lossless # force lossless
lithocinch ./photos --format webp --webp-target 0.985  # looser = smaller
```

A photographic source is detected from the JPEG marker or a high distinct-colour
count; graphics fall to lossless (crisp, no ringing). `--verbose` shows the mode
each file got (`... via webp-lossy` / `webp-lossless`). See
[NOTES.md §1h](./NOTES.md).

**AVIF** works the same way (`--format avif`, `--avif-mode auto`) and is ~3×
smaller than WebP on photographs (a 701 KB JPEG → **7.4 KB AVIF** vs 24 KB WebP),
at the cost of slower encoding. Both share one **perceptually-lossless** knob,
`--perceptual-target` (SSIM, default 0.99) — raise toward 0.999 for stricter
(larger) output, lower for smaller. JPEG keeps its own validated 0.999-in-band.

> **JPEG XL** is intentionally not supported: it isn't in the prebuilt
> sharp/libvips and Chrome removed it from browsers — so it can't be delivered to
> most users or run on a bare Lambda. AVIF is the modern format here. Rationale +
> all per-codec measurements are in [RESEARCH.md](./RESEARCH.md).

## PNG, GIF, and SVG

- **PNG** uses sharp's `palette: true` (**libimagequant** — the exact library
  `pngquant` wraps) at max effort. It runs a **perceptual palette search**: it
  keeps the smallest palette that's still perceptually lossless (`--png-min-ssim`,
  default 0.92, full-res SSIM), and falls back to lossless for gradients/photos
  that can't be palettized cleanly. `--png-engine pngquant` shells out to the real
  binary for byte-exact 2.9 parity; `--png-lossless` forces lossless.
- **GIF** uses sharp (libimagequant) for pixels, then a lossless `gifsicle -O3`
  pass. `--gif-engine auto` (default) runs gifsicle when it's installed — best
  for animations — and falls back to sharp otherwise.
- **Animated GIF/WebP** are handled too: `--format auto` runs a WebP-vs-GIF
  shootout (SSIM measured across all frames) and keeps the smallest — a 45 KB
  animated GIF becomes a ~1 KB animated WebP, frames preserved.
- **SVG** uses **svgo v4** (`preset-default` + multipass, viewBox preserved).

### Opinionated `auto` engines

By default PNG and GIF use `auto`: the tool uses the best encoder actually
available and keeps the **tightest result that still passes the quality bar**.
With `pngquant`/`gifsicle` installed, tiny PNGs and animated GIFs get the
specialist tools automatically; without them it falls back to the portable
built-ins. `--verbose` shows which engine won each file (`... via pngquant`).
Pin `--png-engine sharp` / `--gif-engine sharp` for byte-stable portable output.

See [NOTES.md §1f](./NOTES.md) for the head-to-head audit (sizes + SSIM) against
the actual pngquant/gifsicle binaries.

## Development

```bash
npm test        # node --test (unit tests for the pure core)
npm start -- --help
```

## License

[Apache-2.0](./LICENSE) © 2026 Danniel T. Gaidula
