# process-images 3.x — design notes & migration from 2.9

This file documents the rewrite decisions, the **internal-variable → CLI-flag
hoisting** you asked for, and the things that changed behaviorally so you aren't
surprised when you point it at your usual folders.

---

## 1. The big architectural changes

### a. `imagemin` and its native binaries are gone
2.9 ran every raster image through `sharp` (resize / colorspace / TIFF→JPEG) and
**then** through `imagemin` with `imagemin-mozjpeg`, `imagemin-pngquant`,
`imagemin-gifsicle`, `imagemin-svgo`, wrapped by `image-2-min`. That plugin chain
depends on `bin-wrapper`-style global binaries — the exact "installed globally +
old pattern that newer versions dropped" trap you were stuck in. Those packages
also went ESM-only and broke `require()`.

3.x does **raster compression with `sharp` alone**:
- JPEG uses an **adaptive per-file SSIM search** that reproduces
  `imagemin-jpeg-recompress` (see §1e below) — *not* a fixed quality.
- `pngquant`-grade palette quantization is libimagequant, built into libvips
  (`.png({ palette: true, quality })`).
- GIF, WebP, AVIF, TIFF all encode natively.
- `mozjpeg` trellis quantization is built into libvips and is used when encoding
  every JPEG candidate.

SVG still uses **`svgo`** (v4, ESM) directly — no `imagemin-svgo` wrapper.

### e. JPEG quality is adaptive, not fixed — the jpeg-recompress reimplementation
This is the single most important behavior to preserve. 2.9's real workhorse was
`imagemin-jpeg-recompress` with `{ min: 30, max: 60, quality: "low" }`. That tool
does **not** apply one quality to every image — it binary-searches JPEG quality
per file and keeps the **smallest** encoding whose **SSIM** vs the source still
clears a perceptual target (`"low"` ≈ 0.999 SSIM). A flat logo and a detailed
photo need very different quality numbers for the same visual result; the search
finds each one's sweet spot. `mozjpeg` (quality 50) was only a **fallback** for
when recompress produced a file *larger* than the input.

3.x reproduces this in `src/jpeg.js` + `src/ssim.js`:
- Decode the processed image to raw pixels **once**.
- Binary-search quality in `[--jpeg-min, --jpeg-max]` (default 30–60); for each
  candidate, encode with sharp/mozjpeg, decode, and score **SSIM** vs the source
  luma. Keep the lowest quality whose SSIM ≥ `--jpeg-target` (default 0.999).
- If nothing in the band reaches the target, use the band ceiling.
- **Larger-than-input fallback:** if the source was a JPEG and the best result
  isn't smaller, try `--jpeg-fallback-quality` (mozjpeg 50) and, if the original
  is *still* smaller and the pixels weren't resized/trimmed, pass the original
  through untouched (2.9 would have written the larger re-encode — hardened here).

Because the search re-encodes candidates with sharp, it needs **no native
jpeg-recompress binary** and runs anywhere sharp does, including Lambda. For
byte-exact parity with 2.9 you can still opt into the real binary with
`--jpeg-engine jpeg-recompress` (requires `jpeg-recompress` on PATH —
`brew install jpeg-archive`); it's piped via stdin/stdout, no temp files.

Notes on fidelity: our SSIM is the standard Wang 11×11-Gaussian metric with the
reference implementation's auto-downsampling, so absolute values are *close to*
but not bit-identical to JPEG-Archive's `iqa` SSIM. The `[min,max]` band is the
real guardrail (output quality can never leave 30–60), so results are tight and
"the same or similar" regardless. `--jpeg-target`, `--jpeg-min`, `--jpeg-max`,
and `--no-jpeg-ssim-downsample` let you dial it in, and `--jpeg-mode fixed`
falls back to a plain single-quality encode if you ever want it.

Result: ~35 installed packages instead of 200+, prebuilt binaries that also run
on AWS Lambda, and no global-binary dependency.

### b. ESM, not CommonJS
`"type": "module"`. This is what lets us use current `svgo`, and it's the modern
default. Node ≥ 20.

### c. Split into a pure core + thin shells
- `src/optimize.js`, `src/svg.js`, `src/transform.js` — **pure, buffer-in /
  buffer-out**, no filesystem or `cwd` assumptions.
- `src/process-dir.js` — local/server directory walker built on the core.
- `src/cli.js` — Commander front end.
- `lambda/handler.js` — S3-triggered handler that reuses the pure core.

That separation is what makes the same logic publishable to npm **and** runnable
as a Lambda without a rewrite.

### d. The tmp-directory "color fix" is deleted
In 1.5 there was a real temp-dir workaround: when imagemin threw *"Unsupported
color conversion"* (CMYK JPEGs), it piped the file through `JPEGDecoder →
ColorTransform('rgb') → JPEGEncoder` to a file in `../img-optimize-output-tmp/`,
then re-ran imagemin on that temp file. By 2.x this was superseded by
`sharp().toColorspace('srgb')`, but the dead scaffolding lingered: 2.9 still had
`getTmpFile()` and `emptyTmpFolder`, and `getTmpFile` referenced a `tmpPath`
variable **that no longer existed** (it would have thrown if ever called).

3.x removes all of it. Color is normalized **in memory**: sharp reads any
embedded ICC profile, then `toColorspace('srgb')` converts CMYK/other into sRGB.
No temp files, no second pass, and it works identically in Lambda (which only has
a small `/tmp` anyway). `--keep-metadata` re-embeds an sRGB ICC profile + EXIF if
you want it; default strips for smaller files.

---

## 2. Internal variable → flag hoisting

Every hard-coded `const`/`var` from the top of `process-images-2.9.js` is now an
option (CLI flag + library option key). Defaults match 2.9 unless noted.

| 2.9 internal variable | value in 2.9 | 3.x CLI flag | option key | notes |
|---|---|---|---|---|
| *(implicit cwd)* | `.` | `[input]` positional | `input` | now an explicit arg, default `.` |
| `outPath` | `../img-optimize-output/` | `-o, --output` | `output` | |
| `errorPath` | `../img-optimize-error/` | `--error-dir` | `errorDir` | |
| `outputAppend` | `_opt` | `-s, --suffix` | `suffix` | |
| `overwriteFiles` | `false` | `--overwrite` | `overwrite` | |
| `maxSize` | `2560` | `-m, --max-size` | `maxSize` | `0` (or `--no-resize`) disables; this is the 2.8 "skip maxSize" switch |
| `onSquare` | `false` | `--square` | `square` | now uses sharp `fit:contain` instead of manual `extend()` |
| `bgColor` | `{255,255,255,1}` | `--bg-color` | `bgColor` | accepts `#rrggbb`, `#rgb`, `#rrggbbaa`, or `r,g,b[,a]`; also used to flatten alpha on →JPEG |
| `trimWhiteSpace` | `false` | `--trim` | `trim` | |
| `convertTiffJpeg` | `true` | `--no-tiff-to-jpeg` to disable | `tiffToJpeg` | |
| `useMozJpeg` | `true` | `--no-mozjpeg` to disable | `mozjpeg` | now means "use mozjpeg trellis quantization when encoding JPEG candidates", in-process via libvips. In 2.9 this flag *switched the whole engine* (mozjpeg q50 vs jpeg-recompress); that role is now `--jpeg-engine`/`--jpeg-mode` |
| `imageminJpegRecompress({min,max,quality})` | `30 / 60 / low` | `--jpeg-min` / `--jpeg-max` / `--jpeg-target` | `jpegMin` / `jpegMax` / `jpegTarget` | the adaptive SSIM search; `low` ⇒ target `0.999`. See §1e |
| *(jpeg-recompress engine)* | implicit | `--jpeg-engine` | `jpegEngine` | `sharp-ssim` (default, portable) or `jpeg-recompress` (real binary, exact parity) |
| *(jpeg strategy)* | recompress | `--jpeg-mode` | `jpegMode` | `recompress` (default, adaptive) or `fixed` (single quality) |
| mozjpeg fallback quality | `50` | `--jpeg-fallback-quality` | `jpegFallbackQuality` | used only when a recompress result would be ≥ the input |
| `replaceSpaceChr` | `_` | `--space-char` | `spaceChar` | now replaces **all** whitespace, not just the first space |
| `lowerCaseExtensions` | `false` | `--lowercase-ext` | `lowercaseExt` | |
| `copyNonImgFiles` | `true` | `--no-copy-non-images` to disable | `copyNonImages` | |
| `copyNonImageByType` | `true` | `--copy-non-images-by-type` | `copyNonImagesByType` | **default flipped to off** (opt-in) so you don't get a duplicate `non-images/` tree unless asked |
| `copyBakFiles` | `true` | `--copy-bak` | `copyBak` | 2.9's impl was a no-op stub (it only `console.log`'d); now actually copies, opt-in |
| `batchLimit` | `100` | `-c, --concurrency` | `concurrency` | merged with `svgBatchLimit`; in-memory buffers, so this is true parallelism, not crash-avoidance batching |
| `svgBatchLimit` | `10` | *(folded into `--concurrency`)* | — | |
| `emptyTmpFolder` | `true` | *(removed)* | — | no temp dir anymore |
| svgo `multipass` | `true` | `--no-svg-multipass` to disable | `svgMultipass` | |
| svgo `removeViewBox:false` | keep | `--svg-remove-viewbox` to strip | `svgRemoveViewBox` | svgo v4 keeps viewBox by default already |
| jpeg `quality` (fixed) | n/a | `--jpeg-quality` | `jpegQuality` | **only used in `--jpeg-mode fixed`**; default 80. The default mode is adaptive (see rows above), so this flag is normally irrelevant |
| pngquant `quality` | `[0.5,0.6]` | `--png-quality` | `pngQuality` | single 1–100 scale now (libimagequant); default 80 |
| — (new) | — | `--webp-quality` | `webpQuality` | |
| — (new) | — | `--avif-quality` | `avifQuality` | |
| — (new) | — | `--gif-colors` | `gifColors` | |
| — (new) | — | `--effort` | `effort` | png/webp/avif encoder effort |
| — (new) | — | `-f, --format` | `format` | force everything to one format (e.g. `--format webp`) |
| — (new) | — | `--keep-metadata` | `keepMetadata` | re-embed sRGB ICC + EXIF |
| — (new) | — | `--flatten` | `flatten` | write output flat instead of mirroring subfolders |
| — (new) | — | `--dry-run` | `dryRun` | plan only, write nothing |
| — (new) | — | `--quiet` / `--verbose` / `--json` | — | output control |

---

## 3. Behavioral differences to be aware of

- **JPEG is adaptive by default (matches 2.9's jpeg-recompress).** Quality is
  chosen per file by SSIM within the 30–60 band, not fixed. For byte-exact parity
  with your old runs, `--jpeg-engine jpeg-recompress` (needs the binary). The
  built-in metric is close-but-not-identical to JPEG-Archive's `iqa` SSIM; the
  30–60 band keeps output tight either way. See §1e.
- **`--copy-non-images-by-type` defaults off.** 2.9 had both `copyNonImgFiles`
  and `copyNonImageByType` on, so non-image files landed in output **twice**
  (once mirrored, once under `non-images/<ext>/`). Now you pick one.
- **Skip-detection** still avoids reprocessing files already present in the
  output dir (unless `--overwrite`). With `--format`, the known target extension
  is used for the check; auto TIFF→JPEG can't be predicted without reading the
  file, so those re-process harmlessly on a second run.
- **Errors don't stop the batch.** A corrupt/unreadable file is logged, copied
  through to the output tree (so the tree stays complete) **and** copied to
  `--error-dir` for investigation — same intent as 2.9 but without the crash
  paths, and tracked in the summary's `errors` count.
- **Logging.** No more `log4js` + dated logfiles in `logs/`. The CLI prints a
  live progress bar + a summary to stderr; `--json` emits machine-readable
  stats to stdout. (If you want file logging back, pipe stderr to a file.)

---

## 4. Still TODO / possible follow-ups

- `--concurrency` autoscaling to CPU count.
- Optional WebP/AVIF "also emit" mode (write `foo.jpg` **and** `foo.webp`).
- A `--config <file>` loader so you can save preset profiles.
- SAM/CDK template + `Dockerfile` for the Lambda packaging path.
