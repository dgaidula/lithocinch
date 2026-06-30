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
| `-f, --format <fmt>` | *keep* | Force output to `jpeg`/`png`/`webp`/`avif`/`gif`/`tiff` |
| `--square` | off | Pad to a `max-size` square using `--bg-color` |
| `--jpeg-target <ssim>` | `0.999` | Adaptive JPEG SSIM target (`0.999` = jpeg-recompress "low") |
| `--jpeg-min` / `--jpeg-max` | `30` / `60` | Adaptive JPEG quality search band |
| `--jpeg-mode <mode>` | `recompress` | `recompress` (adaptive) or `fixed` |
| `--jpeg-quality <n>` | `80` | Fixed JPEG quality (only with `--jpeg-mode fixed`) |
| `--png-quality <n>` | `80` | PNG palette quality |
| `--overwrite` | off | Reprocess even if output already exists |
| `--flatten` | off | Write output flat instead of mirroring subfolders |
| `--no-copy-non-images` | — | Don't copy non-image files through |
| `-c, --concurrency <n>` | `16` | Images processed in parallel |
| `--dry-run` | off | Plan only; write nothing |
| `--json` | off | Print summary as JSON |

Run `process-images --help` for the complete list (color, trim, metadata, AVIF,
SVG, error-dir, etc.). Every option also exists as a library option key — see
the mapping table in [NOTES.md](./NOTES.md).

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
fixed --jpeg-quality 80` switches to a plain single-quality encode. See
[NOTES.md §1e](./NOTES.md) for the full rationale.

## Development

```bash
npm test        # node --test (unit tests for the pure core)
npm start -- --help
```

## License

MIT © Dan Gaidula
