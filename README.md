# process-images

Fast, batch image optimizer built on [**sharp**](https://sharp.pixelplumbing.com/)
and [**svgo**](https://github.com/svg/svgo). Point it at a folder and it will,
for every image in the tree:

- **cap dimensions** to a max width/height (default 2560px),
- **normalize color to sRGB** (CMYK and oddly-profiled images included),
- **compress** JPEG (mozjpeg), PNG (libimagequant palette), GIF, WebP, AVIF,
  TIFF, and SVG,
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
| `--jpeg-quality <n>` | `80` | JPEG quality (mozjpeg) |
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

## Development

```bash
npm test        # node --test (unit tests for the pure core)
npm start -- --help
```

## License

MIT © Dan Gaidula
