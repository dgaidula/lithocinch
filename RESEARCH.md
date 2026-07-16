# lithocinch — research log & encoding decisions

A living record of *why* each codec is configured the way it is, with the
measurements behind the decisions. Companion to `NOTES.md` (which maps the old
2.9 variables to the new flags). If you change a default, update the relevant
section here with the evidence.

All numbers below were measured on this machine: **sharp 0.35.2 / libvips
8.18.3** (macOS, Intel Homebrew prefix), against real and synthetic test images.
SSIM = our Wang 11×11-Gaussian implementation (`src/ssim.js`), measured on the
luma channel vs the source.

---

## 0. The goal

**Perceptually lossless at the smallest possible size.** For every image, find
the smallest encoding that a human can't distinguish from the source. This is the
principle the JPEG path already embodied (jpeg-recompress searches quality to an
SSIM target); the rest of the pipeline is built to extend that idea to every
codec.

Two consequences:
1. **Adaptive, per-file, measured** — not fixed quality. The right setting
   depends on the content, so we search/measure instead of guessing.
2. **Opinionated `auto`** — use the best tool actually available (specialist
   binaries when installed), and never accept a quality regression; fall back
   gracefully when a tool is absent.

The unified knob is **`--perceptual-target`** (SSIM, default `0.99`), which drives
the WebP and AVIF lossy searches. JPEG keeps its own validated `0.999`-within-band
(see §1). Raise the target toward `0.999` for stricter/larger output, lower for
smaller.

---

## 1. JPEG — adaptive, the reference behavior

**2.9 used** `imagemin-jpeg-recompress({ min:30, max:60, quality:"low" })`: a
per-file binary search of JPEG quality, keeping the smallest encoding whose SSIM
vs the source clears the "low" preset (≈0.999). mozjpeg q50 was only a fallback
when recompress produced a file *larger* than the input.

**3.x reproduces this in-process** (`src/jpeg.js` + `src/lossy-search.js`):
binary-search quality in `[--jpeg-min, --jpeg-max]` (30–60), encode each
candidate with sharp/mozjpeg, score SSIM, keep the lowest quality that clears
`--jpeg-target` (0.999). No native binary needed → runs on Lambda.

Key findings:
- The **`[30,60]` band is the real control.** For a high-quality smooth source,
  even q60 only reaches SSIM ~0.995 — below the 0.999 target — so the search
  rides the ceiling. The band caps the damage regardless of the target.
- Our SSIM is *close to but not identical* to JPEG-Archive's `iqa` SSIM, so exact
  quality picks can differ slightly. `--jpeg-engine jpeg-recompress` shells out to
  the real binary for byte-exact parity.
- **`auto` (default)** shoots out sharp-ssim vs the real binary when present and
  keeps the smaller, gated *fairly*: the binary only has to match the SSIM sharp
  actually achieved (both are band-clamped), not the stricter target.
- **Never inflate:** if the source was a JPEG and no re-encode beats it, and the
  pixels weren't resized/trimmed, pass the original through untouched. (2.9 would
  have written the larger re-encode — observed turning a 305 B file into 341 B.)

Measured (smooth photographic source, no resize): target 0.99 → q40 floor (SSIM
0.995); target 0.999 → forces q93 (SSIM 0.999). Confirms the search binds.

---

## 2. PNG — same engine as pngquant, plus a quality gate

**2.9 used** `imagemin-pngquant({ quality:[0.5,0.6], speed:1 })`.

Findings, measured against the real `pngquant` binary:
- **Engine equivalence:** sharp's `png({ palette:true })` *is* libimagequant —
  the library pngquant wraps. Same quantization at the same settings.
- **Effort matters:** libimagequant effort 10 (= pngquant `speed:1`, "best") vs
  effort 1 measured **69,836 B vs 76,334 B** (~8.5% smaller). 3.x defaults
  `--png-effort 10`.
- **Quality:** 2.9 used 50–60; 3.x defaults `--png-quality 80` (keeps more
  colour ⇒ equal-or-better quality; often identical bytes when the palette
  saturates anyway).
- **The pngquant "bail" — the one real gap, now closed.** pngquant's *minimum*
  quality makes it refuse to save (keep the image lossless) when palettization
  would drop below the floor. Observed: on a rich-colour PNG, `pngquant
  --quality 50-60` **wrote no file** (bail) → 2.9 kept it lossless. libvips has no
  such bail, so 3.x adds an **SSIM gate** (`--png-min-ssim`, default 0.85,
  scored full-res): palettize, measure SSIM, and fall back to lossless if it's
  too low. Measured: a smooth gradient (palette SSIM **0.616**) falls back to
  lossless — **272 KB**, even smaller than pngquant's own lossless bail (291 KB),
  same quality; a logo (SSIM **1.000**) stays palette.
- **Perceptual palette search (replaces the fixed-quality + gate).** Calibration
  across UI/graphic, gradient, and alpha test images surfaced two facts:
  - **Palette file size is NON-monotonic with quality** — at very low quality,
    dithering raises entropy and *grows* the file. Measured (UI graphic):
    q40 → 5,504 B but q60 → 3,254 B. So a JPEG-style "lowest quality that passes"
    search would pick a *larger* file. The PNG search instead compares **actual
    bytes**: encode the top quality, then a couple of lower ones, and keep the
    **smallest file** that still clears the perceptual gate.
  - **SSIM cleanly separates palette-friendly from not.** Palette-friendly
    content (UI, flat colour, alpha) scores **~1.0** even at q60; gradients cap at
    **~0.82** at *any* quality. So the gate decides palette-vs-lossless: encode
    the top quality first, and if even that is below the gate the image isn't
    palette-friendly → lossless (the perceptually-lossless floor).
  - **Gate default 0.92** (raised from 0.85). It sits in the empty band between
    "palette-friendly ≈1.0" and "gradient ≈0.82", so it ships crisp palettes and
    routes gradients/photos to lossless. Still below the WebP/AVIF 0.99 because
    SSIM penalizes dithering noise humans don't see — measured full-res, so it is
    NOT fooled by banding (a gradient palette scores 0.62 full-res vs ~1.0
    downsampled). Photographic PNGs that fall back to lossless are better served
    by `--format webp`/`avif` anyway.
  - Cost: 1 palette encode for non-palette-friendly images (early-out to
    lossless), ~3 for palette-friendly. ~0.5 s on a 900×700 PNG.
- **`auto` (default)** shoots out sharp (gated) vs the real pngquant and keeps the
  smaller that passes the bar. Closes the remaining *size* gap: on tiny/flat
  PNGs libvips is chunky — a flat logo **594 B (sharp) → 195 B (pngquant)**,
  identical quality — and `auto` picks the 195 B automatically.

---

## 3. WebP — content-aware (the "different settings per input" problem)

The hard part of WebP: the right *mode* depends on content, and the source
extension is only a weak hint. A photo wants **lossy** (tiny, visually
identical); a flat graphic wants **lossless** (crisp, exact, often smaller at the
quality graphics need). Guess wrong → blurry logos or bloated photos.

`--webp-mode auto` (default) decides by **measuring** (`src/content-aware.js`):
1. **Classify** decoded pixels — JPEG source ⇒ photographic; else sample distinct
   colours (`> webpGraphicColorCap` ⇒ photographic).
2. **Build candidates** and keep the smallest that clears the perceptual target:
   photographic ⇒ quality-searched lossy; graphic ⇒ lossless (exact) + a lossy
   challenger.

Measured (`--format webp`, auto):

| source | → webp | mode chosen |
|---|---|---|
| JPEG photo (701 KB) | 24 KB | lossy (SSIM 0.996) |
| flat PNG (3.4 KB) | 48 B | lossless (exact) |
| graphic PNG (3.5 KB) | 116 B | lossless (exact) |
| photographic PNG (1.27 MB) | 6 KB | lossy (SSIM 0.994) |
| animated GIF (45.6 KB) | 25.5 KB | animated lossy WebP (8 frames kept) |

So lossy-vs-lossless is never a manual decision — the tool proves the right
choice per file.

---

## 4. AVIF — same strategy, more efficient

AVIF reaches the prebuilt sharp via **libheif/AV1** (`sharp.format.avif` reports
`false` but it routes through `heif`, which is `true`). Same content-aware driver
as WebP, with its own effort knob (AVIF encodes slower).

Measured (`--format avif`, auto) vs WebP on the same inputs:

| source | → AVIF | → WebP | note |
|---|---|---|---|
| JPEG photo (701 KB) | **7.4 KB** (SSIM 0.998) | 24 KB | AVIF ~3× smaller on photos |
| graphic PNG (3.5 KB) | 797 B (lossy) | **116 B** (lossless) | WebP lossless wins on graphics |

Takeaway: **AVIF dominates WebP for photographs; WebP lossless dominates AVIF for
flat graphics.** Both are offered; pick per delivery target, or run both.

---

## 5. GIF & SVG

- **GIF** — 2.9 used `imagemin-gifsicle` (`-O1`, lossless). 3.x uses sharp
  (libimagequant) for pixels, then a **lossless `gifsicle -O3` pass** when on PATH
  (`--gif-engine auto`); best for animations. Never inflates (passthrough guard on
  the animated path). gifsicle still beats sharp on complex animations; sharp is
  the portable fallback.
- **SVG** — svgo upgraded v2/3 → **v4**, called directly (`preset-default` +
  multipass, viewBox preserved). v4 dropped the historically-risky `removeViewBox`
  from its default set, so output is equal-or-better and safer.

---

## 6. JPEG XL — evaluated, NOT added (verdict: not worth it today)

Asked whether to add JXL. **No**, for two independent blocking reasons:

1. **Not in the prebuilt sharp/libvips.** `sharp.format.jxl` is `false/false` on
   this build, and `.jxl()` throws `VipsOperation: class "jxlsave_buffer" not
   found`. Supporting it would require a custom libvips compiled with libjxl —
   which breaks the "just `npm install`, runs on a bare Lambda" property that the
   whole architecture is built around.
2. **Browsers dropped it.** Chrome *removed* JXL (2023); Edge follows Chrome;
   Firefox keeps it behind a flag. Only Safari 17+ ships it. For web delivery —
   the primary use case — JXL is unusable for the Chrome-majority audience.

AVIF covers the modern-format need with broad browser support (Chrome, Firefox,
Safari 16+) **and** native prebuilt-sharp support. JXL would be a one-file add
(mirroring `avif.js`) *if* a future sharp ships libjxl or the use case becomes
Safari-only / archival — revisit then. Tracked as a future item.

---

## 7. Format support in the prebuilt sharp (this build)

| format | input | output | path |
|---|---|---|---|
| jpeg | ✓ | ✓ | mozjpeg |
| png | ✓ | ✓ | libimagequant (palette) / zlib (lossless) |
| webp | ✓ | ✓ | libwebp |
| avif | ✓ | ✓ | libheif / AV1 |
| gif | ✓ | ✓ | libimagequant (+ external gifsicle) |
| tiff | ✓ | ✓ | — |
| heif | ✓ | ✓ | libheif |
| **jxl** | ✗ | ✗ | not compiled in |
| jp2k | ✗ | ✗ | not compiled in |

---

## 8. The opinionated `auto` engines & the determinism trade-off

Default engines are `auto` (PNG, GIF, JPEG, WebP/AVIF modes). They use the best
tool available and adapt to the machine. **Consequence:** output can differ
between a dev box (pngquant/gifsicle/jpeg-recompress installed) and a bare Lambda
— both are good, but bytes aren't identical. For byte-stable, portable output pin
the built-in engines (`--png-engine sharp`, `--gif-engine sharp`,
`--jpeg-engine sharp-ssim`); for byte-exact 2.9 parity pin the binaries. The CLI
prints the winning engine per file under `--verbose` (e.g. `... via pngquant`).

---

## 9. Auto-pick output format (`--format auto`)

The opinionated extreme: encode each image in every viable format and ship the
smallest. Reuses the single raw decode and the per-codec content-aware encoders,
so it's "run N encoders on shared pixels, compare, pick" (`src/best-format.js`).

- **Candidate pool**, pruned before encoding to control cost: photographic →
  `{avif, webp, jpeg}`; graphic/flat → `{webp, png, avif}`; **alpha ⇒ JPEG
  dropped** (no transparency); intersected with `--format-pool`
  (default `avif,webp,jpeg,png`). The untouched original is always a candidate
  (never inflate).
- **Three settled decisions:**
  1. **JPEG competes only if it clears the perceptual bar.** It's band-clamped
     (30–60) and rarely wins; pruning it when it can't reach the target is clean.
     (Goal is smaller files — the user's call.)
  2. **Tie-break = most compatible.** Among candidates within `--format-tolerance`
     (default 3%) of the smallest, the more universally-supported format wins
     (rank jpeg/png/gif < webp < avif). Stops a 2% AVIF edge from churning every
     URL to `.avif`, and keeps photographic content off PNG.
  3. **AVIF is in the default pool** (best ratios; ~5% browser gap covered by
     pairing with `--emit` fallbacks).
- **Measured** (`--format auto`): photographic PNG **1.27 MB → 4.3 KB AVIF**
  (the "photo-as-PNG" annoyance, fixed); flat graphic → WebP-lossless; alpha
  graphic → WebP (alpha preserved); JPEG photo → AVIF; animated GIF → animated
  WebP (see §9a).
- **The manifest is essential** because extensions change. `--manifest out.json`
  records `input → output, format, bytes` for every file (primary + emitted), so
  build tools / HTML rewriting know `hero.jpg` became `hero_opt.avif`. Re-runs
  read it for **skip-detection** (the output name can't be predicted from the
  input under `auto`, unlike fixed formats). Without a manifest, `auto`
  reprocesses every run.
- **Cost:** 2–4 candidate encodes per image (each a small SSIM search); classify
  pruning keeps most to ~2; one shared decode; `--concurrency` parallelizes
  across files. Heavier than fixed-format — the manifest cache makes re-runs free.

### 9a. Animated images — WebP-vs-GIF shootout

Animation closes the last format gap. AVIF is excluded (libheif animation is
unreliable), so the pool is **{WebP, GIF}** plus the untouched original:
- **WebP candidate** = the same content-aware logic (classify → lossy quality
  search vs lossless), but encoded over the animated pipeline (`sharp.clone()`
  branches the resize/colour stage per candidate) and **scored by SSIM across the
  whole frame strip** (all frames at once — the raw buffer is the stacked pages),
  not just frame 0. `searchQuality`/`contentAwareEncode` gained a `decodeOpts`
  pass so candidates decode with `{animated:true}`.
- **GIF candidate** = sharp's libimagequant GIF + the lossless `gifsicle -O3`
  pass, scored the same way.
- Pick the smallest that clears the perceptual bar; tie-break toward GIF (more
  universally supported than animated WebP).
- Measured: a 45.6 KB animated GIF → **1.3 KB animated WebP** (8 frames kept);
  an already-tight animated WebP passes through untouched (never inflate); forcing
  `--format gif`/`webp` round-trips with frames preserved.

This makes every format — still, animated, vector — feature-complete under the
same "smallest perceptually-lossless" policy.

---

## 9b. Transform service — the integration backbone

To drive the tool from a CMS (Craft), a build step, or any non-Node host, there's
a single-image **transform API** layered over the same core (`src/transform-api.js`,
`runTransform()`), reachable three ways that share one request/response contract:

- **CLI** (`lithocinch transform`): JSON request on stdin → JSON (base64) on
  stdout. The shell-out backend for hosts that have Node.
- **HTTP daemon** (`lithocinch serve`, `src/server.js`): persistent, warm
  sharp; `POST /transform`, `GET /health`, optional bearer token.
- **Lambda** (`lambda/transform.js`): the identical handler behind a Function URL
  — the backend for hosts that can't run Node.

Design choices that matter for the integration:
- **Bytes in, bytes out — stateless, storage-agnostic.** The caller owns storage
  (Craft's `Fs` for GCS/S3/local), so the service needs *zero* storage
  integration. Verified target: `craftcms/google-cloud` on Craft 5 — the plugin
  reads source via `$asset->getFs()->read()` and writes variants back; the
  service only ever sees pixels.
- **Batch in one request** (multiple `ops`/`format` over one source) amortizes
  Node startup / network and yields the whole `<picture>` set at once.
- **Explicit transform resize** (`width`/`height`/`fit`/`position`/`focal`) was
  added alongside the existing `maxSize` cap; `fit` maps to the CMS crop/fit/
  stretch modes and `focal` does a focal-point cover crop.

This is the shared contract the eventual Craft plugin's three backend drivers
(`cli`/`daemon`/`remote`) target — speccing it here *is* speccing the Lambda API.

---

## 10. Open questions / future work

- ~~PNG perceptual search~~ — **shipped** (§2): byte-comparing palette-quality
  search with a 0.92 perceptual gate and lossless fallback.
- ~~"Also emit" mode~~ — **shipped**: `--emit webp,avif` writes siblings next to
  each raster for `<picture>` fallbacks; de-dups the primary format, fills in
  missing siblings on re-runs, skips SVG.
- ~~Auto-pick output format~~ — **shipped** (§9): `--format auto` + manifest.
- ~~Animated WebP-vs-GIF shootout~~ — **shipped** (§9a): SSIM scored across all
  frames; AVIF excluded (libheif animation unreliable).
- **Cross-format SSIM consistency:** candidates are scored with each codec's own
  SSIM downsample setting; a uniform re-score would make the perceptual filter
  exact (currently lossless candidates are normalized to 1.0, which is enough).
- **AVIF/WebP for graphics with alpha:** verify near-lossless vs lossless choice
  on UI assets with transparency.
- **Perceptual metric:** SSIM under-rates dithering and over-rates some blur;
  evaluate a better proxy (e.g. butteraugli/SSIMULACRA2) if it can run cheaply.
- **JPEG XL:** revisit if sharp ships libjxl.
