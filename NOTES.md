# lithocinch 3.x — design notes & migration from 2.9

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

### f. PNG / GIF / SVG — codec-by-codec audit vs 2.9
These were verified head-to-head against the actual `pngquant` and `gifsicle`
binaries (output size **and** measured SSIM), not assumed.

**PNG** — 2.9 used `imageminPngquant({ quality:[0.5,0.6], speed:1 })`.
- Engine: sharp's `png({ palette:true })` is **libimagequant** — literally the
  library `pngquant` wraps. Same quantization quality at the same settings.
- `speed:1` (pngquant's best) == libimagequant **effort 10**, which is the 3.x
  default (`--png-effort`). Measured ~8.5% smaller than low effort.
- Quality target: 2.9 used 50–60; 3.x defaults `--png-quality 80`, which keeps
  *more* color = equal-or-better visual quality (often identical bytes when the
  palette saturates anyway).
- **The one real gap, now closed:** pngquant's `min` quality makes it *bail*
  (keep the image lossless) when palettization would drop below the floor — a
  deliberate "don't ship something ugly" guard. libvips doesn't expose that. So
  3.x runs a **perceptual palette search** (`--png-min-ssim`, default 0.92, scored
  full-res): encode the top quality, and if even that is below the gate keep
  lossless; otherwise try lower qualities too and ship the **smallest file** that
  still clears the gate. (Palette size is non-monotonic with quality — dithering
  can make a *lower* quality larger — so it compares bytes, not quality numbers.
  See RESEARCH §2.) Verified: a smooth gradient (SSIM 0.62) falls back to
  lossless — even *smaller* than pngquant's own lossless bail (272K vs 291K),
  same quality. A UI graphic ships a q75 palette (smallest that's perceptually
  perfect). The upstream never-inflate guard caps the lossless fallback at the
  original size.
- For **byte-exact parity**, `--png-engine pngquant` shells out to the real
  binary with 2.9's exact `--quality 50-60 --speed 1`.
- **The default is actually `auto`** (see §1g): it runs both sharp and pngquant
  and keeps the smaller quality-passing result. That closes the one size gap —
  libvips emits a chunkier file than pngquant on tiny/flat PNGs (a flat logo:
  594 B sharp → **195 B** via pngquant, identical quality), and `auto` picks the
  195 B automatically when pngquant is installed.

**GIF** — 2.9 used `imageminGifsicle()` (default `-O1`, lossless). 3.x uses
sharp's libimagequant GIF encoder for colour/resize/quantization, then a
**lossless `gifsicle -O3` pass** (best-in-class LZW + inter-frame optimization,
especially for animations). The default `--gif-engine auto` runs the gifsicle
pass whenever the binary is on PATH (it can only shrink or tie — never reduce
quality), falling back to sharp-only when it isn't. `--gif-engine sharp` forces
the portable path; `--gif-engine gifsicle` requires the binary. Opt-in
`--gif-lossy <n>` enables gifsicle's lossy LZW for extra savings.

**Animated** GIF/WebP are feature-complete: `--format auto` runs a WebP-vs-GIF
shootout (AVIF excluded — libheif animation is unreliable), scoring SSIM across
*all* frames, and keeps the smallest. Measured: a 45.6 KB animated GIF → 1.3 KB
animated WebP, 8 frames preserved. See RESEARCH §9a.

**SVG** — 2.9 used `imageminSvgo({ multipass:true, removeViewBox:false })` on an
old svgo (v2/3, bundled by imagemin-svgo). 3.x calls **svgo v4 directly** with
`preset-default` + `multipass`, viewBox preserved. svgo v4's preset is newer and
safer (it *removed* the historically-risky `removeViewBox` from the default set),
so output is equal-or-better and the intent (full optimization, keep viewBox,
multipass) is matched exactly.

### g. Opinionated `auto` engines — tightest file at acceptable quality
The default engine for PNG and GIF is `auto`: use the best tool actually
available, fall back gracefully when it isn't, and never accept a quality
regression. This makes the tool adapt to the machine it runs on without config.

- **PNG `auto`** runs *both* the built-in libimagequant path (with its SSIM
  gate) and the real `pngquant` (when on PATH), measures SSIM on the pngquant
  candidate, and keeps the **smaller output that still clears the quality bar**.
  In practice: tiny/flat PNGs go to pngquant (libvips is a bit chunky there —
  e.g. a logo 594 B → 195 B), hard images stay on sharp's gated lossless. Result
  is the tightest of the two at equal-or-better quality.
- **GIF `auto`** post-processes sharp's GIF through `gifsicle -O3` (lossless) when
  available, keeping it only if smaller.
- **Determinism trade-off:** because `auto` adapts to installed binaries, output
  can differ between a dev machine (pngquant/gifsicle present) and a bare Lambda.
  Both are good; pin `--png-engine sharp` / `--gif-engine sharp` for byte-stable,
  portable output, or the binary engines for byte-exact 2.9 parity. The CLI
  prints which engine won per file under `--verbose` (`... via pngquant`).
- **JPEG `auto`** (default) runs the built-in sharp-ssim search and, when the
  real `jpeg-recompress` is on PATH, also runs it and keeps the smaller result —
  gated *fairly*: the binary only has to match the SSIM sharp actually achieved
  (both engines are clamped to the `[jpeg-min, jpeg-max]` band, so neither may
  reach `jpeg-target`), not a stricter bar. Without the binary it's just
  sharp-ssim. Pin `--jpeg-engine sharp-ssim` (portable) or `jpeg-recompress`
  (exact 2.9).

### h. WebP — content-aware, not one-size-fits-all
The reason "just add WebP" is hard: the right *mode* depends on the content, and
the source extension is only a weak hint. A photo wants **lossy** WebP (tiny,
visually identical); a flat graphic/screenshot/logo wants **lossless** (crisp
edges, no ringing, and usually smaller at the high quality graphics need). Guess
wrong and you get blurry logos or bloated photos.

`--webp-mode auto` (default) decides per image by *measuring*, not guessing
(`src/webp.js`):
1. **Classify** the decoded pixels: a JPEG source is photographic by definition;
   otherwise sample distinct colours — many ⇒ photographic, few ⇒ graphic
   (`--` threshold `webpGraphicColorCap`).
2. **Build candidates** for that class and keep the **smallest that clears the
   SSIM bar** (`--webp-target`, default 0.99): photographic ⇒ a quality-searched
   lossy encode (shared search from §1e, band `--webp-min..--webp-max`); graphic
   ⇒ lossless (always exact) plus a lossy challenger, smaller wins.

Measured results (auto, per input):

| source | → webp | mode chosen |
|---|---|---|
| JPEG photo | 701 KB → 24 KB | lossy (SSIM 0.996) |
| flat PNG | 3.4 KB → 48 B | lossless (exact) |
| graphic PNG | 3.5 KB → 116 B | lossless (exact) |
| photographic PNG | 1.27 MB → 6 KB | lossy (SSIM 0.994) |
| animated GIF | 45.6 KB → 25.5 KB | animated lossy WebP |

So you never have to pick lossy-vs-lossless by hand — the tool proves the right
choice per file. `--webp-mode lossy|lossless|near-lossless` forces one. Today
this fires on `--format webp` (convert everything to WebP); auto "also emit a
.webp next to each original" is a planned follow-up (§4).

**AVIF** uses the exact same content-aware driver (`--format avif`,
`--avif-mode auto`), via libheif/AV1 in the prebuilt sharp. It's ~3× smaller than
WebP on photos (e.g. a 701 KB JPEG → 7.4 KB AVIF vs 24 KB WebP) but slower to
encode (own `--avif-effort`). WebP lossless still wins on flat graphics. Both
share the **`--perceptual-target`** SSIM bar (default 0.99) — the single
"perceptually lossless" knob; per-codec `--webp-target` / `--avif-target`
override it. JPEG keeps its own validated 0.999-within-band. **JPEG XL is
intentionally not supported** — not in the prebuilt sharp/libvips and dropped by
Chrome; see [RESEARCH.md §6](./RESEARCH.md). Full measured findings for every
codec live in [RESEARCH.md](./RESEARCH.md).

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
| `outputAppend` | `_lco` | `-s, --suffix` | `suffix` | |
| `overwriteFiles` | `false` | `--overwrite` | `overwrite` | |
| `maxSize` | `2560` | `-m, --max-size` | `maxSize` | `0` (or `--no-resize`) disables; this is the 2.8 "skip maxSize" switch |
| `onSquare` | `false` | `--square` | `square` | now uses sharp `fit:contain` instead of manual `extend()` |
| `bgColor` | `{255,255,255,1}` | `--bg-color` | `bgColor` | accepts `#rrggbb`, `#rgb`, `#rrggbbaa`, or `r,g,b[,a]`; also used to flatten alpha on →JPEG |
| `trimWhiteSpace` | `false` | `--trim` | `trim` | |
| `convertTiffJpeg` | `true` | `--no-tiff-to-jpeg` to disable | `tiffToJpeg` | |
| `useMozJpeg` | `true` | `--no-mozjpeg` to disable | `mozjpeg` | now means "use mozjpeg trellis quantization when encoding JPEG candidates", in-process via libvips. In 2.9 this flag *switched the whole engine* (mozjpeg q50 vs jpeg-recompress); that role is now `--jpeg-engine`/`--jpeg-mode` |
| `imageminJpegRecompress({min,max,quality})` | `30 / 60 / low` | `--jpeg-min` / `--jpeg-max` / `--jpeg-target` | `jpegMin` / `jpegMax` / `jpegTarget` | the adaptive SSIM search; `low` ⇒ target `0.999`. See §1e |
| *(jpeg-recompress engine)* | implicit | `--jpeg-engine` | `jpegEngine` | **`auto`** (default; shoots out sharp-ssim vs the real jpeg-recompress binary, keeps smaller), `sharp-ssim`, or `jpeg-recompress`. See §1g |
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
| jpeg `quality` (fixed) | n/a | `--jpeg-quality` | `jpegQuality` | **only used in `--jpeg-mode fixed`**; default 80. The default mode is adaptive (see rows above), so this flag is normally irrelevant |
| `imageminPngquant({quality})` | `[0.5,0.6]` | `--png-quality` / `--png-min-quality` | `pngQuality` / `pngMinQuality` | libimagequant (the engine pngquant wraps). Now a palette-quality **search** ceiling/floor (100/50); the smallest *file* that clears the gate wins. See §1f/RESEARCH §2 |
| `imageminPngquant({speed})` | `1` | `--png-effort` | `pngEffort` | pngquant speed:1 ("best") == libimagequant effort 10, the new default |
| *(pngquant min-quality bail)* | implicit | `--png-min-ssim` | `pngMinSsim` | perceptual gate: palette must clear this SSIM or fall back to lossless. **Default 0.92** (perceptually-lossless separator). See §1f |
| *(png engine)* | pngquant | `--png-engine` | `pngEngine` | **`auto`** (default; shoots out sharp vs pngquant, keeps smaller quality-passing), `sharp`, or `pngquant` (exact parity). See §1g |
| `imageminGifsicle()` | defaults (`-O1`) | `--gif-engine` | `gifEngine` | **`auto`** (default; sharp + lossless `gifsicle -O3` when available), `sharp`, or `gifsicle`. See §1f/§1g |
| `imageminSvgo({multipass})` | `true` | `--no-svg-multipass` | `svgMultipass` | svgo upgraded v2/3 → **v4**; see §1f |
| svgo `removeViewBox:false` | keep | `--svg-remove-viewbox` | `svgRemoveViewBox` | svgo v4 keeps viewBox by default already |
| — (new) | — | `--webp-mode` | `webpMode` | content-aware: **`auto`** (classify + shoot out lossy vs lossless), `lossy`, `lossless`, `near-lossless`. See §1h |
| — (new) | — | `--webp-quality` / `--webp-min` / `--webp-max` / `--webp-target` / `--webp-effort` | `webp*` | lossy quality / auto search band / SSIM bar / encoder effort |
| — (new) | — | `--avif-mode` / `--avif-target` / `--avif-min` / `--avif-max` / `--avif-effort` | `avif*` | content-aware AVIF (libheif/AV1), same strategy as WebP. See §1h |
| — (new) | — | `--perceptual-target` | `perceptualTarget` | unified perceptually-lossless SSIM bar (0.99) driving WebP/AVIF searches |
| — (new) | — | `--gif-colors` | `gifColors` | |
| — (new) | — | `--effort` | `effort` | AVIF encoder effort (PNG uses `--png-effort`, WebP `--webp-effort`) |
| — (new) | — | `-f, --format` | `format` | force one format (`--format webp`) **or `auto`** = pick the smallest per image. See RESEARCH §9 |
| — (new) | — | `--format-pool` / `--format-tolerance` | `formatPool` / `formatTolerance` | `auto` candidate set (default `avif,webp,jpeg,png`) + compatibility tie-break tolerance (3%) |
| — (new) | — | `--manifest` | `manifest` | JSON map of source → output(s); required for `auto` skip-detection (extensions change) |
| — (new) | — | `--keep-metadata` | `keepMetadata` | re-embed sRGB ICC + EXIF |
| — (new) | — | `--density <ppi>` | `density` | after encoding, rewrite the output’s resolution header to this many pixels per inch (plain decimal digits, 1–65535). JPEG: JFIF + any EXIF resolution + any Photoshop resolution resource (an 18-byte JFIF header is inserted if there is no JFIF or EXIF); PNG: `pHYs` + any `eXIf`. WebP/AVIF/GIF/TIFF are refused (`--format`, `--emit`) or reported per file; `--format auto` narrows its still-image pool to jpeg/png. No ICC/EXIF is added. An output that keeps a stale XMP value is warned about and counted as stale (`density.staleFiles` in `--json`). Skip-detection ignores it: re-run with `--overwrite` after changing it (the summary counts the outputs skipped unchecked) |
| — (new) | — | `lithocinch density <files> --ppi <n>` | — | sub-command: header-only rewrite of existing JPEGs, no re-encode. Takes `-o/--output`, `-s/--suffix`, `--overwrite`, `--dry-run`, `--brief`, `--json`, `-q/--quiet`; other images in a folder are listed as `skip not a JPEG`; XMP left stale is a `warn`; exit 0/1/2/3 (1 also when no JPEG is found; see README) |
| — (new) | — | `--flatten` | `flatten` | write output flat instead of mirroring subfolders |
| — (new) | — | `--emit` | `emit` | also write sibling formats (e.g. `webp,avif`) beside each raster for `<picture>` fallbacks |
| — (new) | — | `--dry-run` | `dryRun` | plan only, write nothing |
| — (new) | — | `--quiet` / `--verbose` / `--json` | — | output control |
| — (new) | — | `--cheat` | — | print a short card of common invocations (tldr page format) and exit; not with `--json` or `--quiet` |

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
- `--density`: rewrite XMP resolution fields, or refuse files that carry them (open decision); report the density outcome from the transform service.
- `--density` for WebP/AVIF (needs an EXIF block, ~210–255 bytes, and is ignored by many tools) and for TIFF output (sharp’s `withDensity` writes the TIFF resolution tags at no cost; not wired up).
- Optional WebP/AVIF "also emit" mode (write `foo.jpg` **and** `foo.webp`).
- A `--config <file>` loader so you can save preset profiles.
- SAM/CDK template + `Dockerfile` for the Lambda packaging path.
