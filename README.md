# process-images

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
npm install -g process-images

# or per-project / as a library
npm install process-images
```

Or from a clone:

```bash
git clone <repo> process-images && cd process-images
npm install
npm link        # optional: puts `process-images` on your PATH
```

## CLI usage

```bash
process-images [input-dir] [options]
```

Run it from (or point it at) the folder of images. By default it writes to a
sibling `../img-optimize-output/` folder and skips files already optimized there.

```bash
# optimize the current folder with defaults
process-images

# a specific folder, custom output, force everything to WebP at 1600px
process-images ./photos -o ./web --format webp --max-size 1600

# square-pad product shots onto a white canvas, higher JPEG quality
process-images ./products --square --bg-color "#ffffff" --jpeg-quality 90

# see what would happen without writing anything
process-images ./photos --dry-run --verbose
```

### Common options

| Flag | Default | Description |
|---|---|---|
| `[input]` | `.` | Input directory (recursive) |
| `-o, --output <dir>` | `../img-optimize-output/` | Output directory |
| `-s, --suffix <str>` | `_opt` | Inserted before each file's extension |
| `-m, --max-size <px>` | `2560` | Cap width & height (`0` / `--no-resize` to disable) |
| `-f, --format <fmt>` | *keep* | `jpeg`/`png`/`webp`/`avif`/`gif`/`tiff`, or **`auto`** (smallest per image) |
| `--manifest <path>` | — | JSON `source → output` map; enables `--format auto` skip-detection |
| `--webp-mode <m>` | `auto` | `auto` (classify + shoot out), `lossy`, `lossless`, `near-lossless` |
| `--emit <formats>` | — | Also write sibling formats (e.g. `webp,avif`) for `<picture>` |
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
| `--json` | off | Print summary as JSON |

Run `process-images --help` for the complete list (color, trim, metadata, AVIF,
SVG, error-dir, etc.). Every option also exists as a library option key — see
the mapping table in [NOTES.md](./NOTES.md).

## Auto-pick the best format (`--format auto`)

Let the tool choose the smallest format for each image — it encodes the viable
candidates and ships the winner, changing the extension to match:

```bash
process-images ./images --format auto --manifest ./out/manifest.json
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
process-images ./photos --emit webp,avif
#  photo.jpg  ->  photo_opt.jpg   (primary, optimized)
#               + photo_opt.webp  (content-aware)
#               + photo_opt.avif  (content-aware)
```

Each sibling uses that codec's content-aware/perceptual settings. The primary
format is never duplicated, SVGs are skipped, and re-runs fill in only missing
siblings — so adding `--emit avif` to an already-processed tree just backfills the
AVIFs. Pair with `<picture>`:

```html
<picture>
  <source srcset="photo_opt.avif" type="image/avif">
  <source srcset="photo_opt.webp" type="image/webp">
  <img src="photo_opt.jpg" alt="">
</picture>
```

## Transform service (CMS plugin / Lambda backbone)

Besides batch-optimizing folders, the tool exposes a **single-image transform
API** for on-demand use (a CMS image transform, a build step, an upload hook).
The same `runTransform()` core is reachable three ways — pick per host:

| Transport | Command | Use |
|---|---|---|
| **CLI** (stdin→stdout JSON) | `process-images transform` | shell out from PHP/anything; needs Node on the box |
| **HTTP daemon** | `process-images serve` | persistent, warm sharp; POST from localhost |
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
process-images transform --in photo.jpg --ops '{"width":800}' --format auto --out out.avif

# one-shot, JSON on stdin (the shell-out contract)
echo '{"image":"...","ops":{"width":800},"format":"auto"}' | process-images transform

# persistent daemon (warm), optional bearer token
process-images serve --port 4111 --token "$PI_TOKEN"
curl -s localhost:4111/transform -H "authorization: Bearer $PI_TOKEN" \
  -d '{"image":"...","ops":{"width":800},"format":"auto"}'
```

The Lambda (`process-images/lambda/transform`) takes the identical JSON body via a
Function URL / API Gateway v2 event and honors `PI_TOKEN`.

## Library usage

```js
import {
  optimizeImageBuffer, // raster bytes -> optimized bytes (pure)
  optimizeSvg,         // svg string   -> optimized string (pure)
  optimizeBytes,       // any image bytes + filename -> { data, outName, ... } (pure)
  optimizeFile,        // one file on disk -> optimized file
  processDirectory,    // whole tree -> mirrored output tree
} from 'process-images';

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
process-images ./photos --jpeg-target 0.997
# widen the quality band
process-images ./photos --jpeg-min 35 --jpeg-max 75
# see the chosen quality + SSIM per file
process-images ./photos --verbose         # ... scene.jpg -> scene.jpg (685KB -> 30KB q58 ssim0.9951)
```

The built-in engine (`sharp-ssim`) needs no native binary, so it runs in Lambda
too. For **byte-exact parity** with the original `jpeg-recompress` binary:

```bash
brew install jpeg-archive   # provides the `jpeg-recompress` binary
process-images ./photos --jpeg-engine jpeg-recompress
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
process-images ./photos --format webp                 # auto per image
process-images ./ui --format webp --webp-mode lossless # force lossless
process-images ./photos --format webp --webp-target 0.985  # looser = smaller
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

MIT © Dan Gaidula
