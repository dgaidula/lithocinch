# lithocinch — agent guide

Fast, batch + on-demand image optimizer on **sharp** + **svgo**. ESM, Node ≥ 20.
3.x rewrite of the long-lived `process-images-2.9.js`. Runs four ways from one
core: **CLI**, **library**, **HTTP daemon**, **AWS Lambda**.

## What it does (the philosophy)
Smallest **perceptually-lossless** output, per file, by *measuring* (SSIM), not
guessing. Content-aware: picks lossy vs lossless and the best format per image.
"Opinionated auto": uses the best specialist tool available (pngquant / gifsicle
/ jpeg-recompress) when on PATH, else portable sharp; never a quality regression.

## Map
- `src/optimize.js` — core: decode→process→encode; routes per format; animated path.
- `src/{jpeg,png,webp,avif,gif,svg}.js` — per-codec encoders (content-aware/adaptive).
- `src/ssim.js`, `src/lossy-search.js`, `src/content-aware.js` — perceptual metric + shared quality search + classify/shootout.
- `src/best-format.js` — `--format auto` (pick smallest format; JPEG pruned if below bar; tie-break = most compatible; AVIF in pool).
- `src/transform-api.js` / `src/server.js` / `src/cli-service.js` — the transform service (one-shot CLI, HTTP daemon); `lambda/transform.js` is the same handler.
- `src/process-dir.js` — directory orchestrator (glob, concurrency, skip, `--emit`, `--manifest`).
- `src/density.js` — resolution headers (JPEG JFIF/EXIF/Photoshop APP13, PNG pHYs/eXIf) rewritten without re-encoding; `src/density-cli.js` is the `lithocinch density` sub-command.
- `src/config.js` — all defaults + `resolveConfig` (single source of truth).
- `lambda/` — `transform.js` (sync API / remote driver), `handler.js` (S3 batch), `Dockerfile` + `template.yaml` (SAM deploy).

## Commands
```bash
node --test                         # 147 tests (node:test); 1 env-skip
node src/cli.js <dir> --verbose     # directory optimize
node src/cli.js transform           # one-shot: JSON request on stdin -> JSON out
node src/cli.js serve --port 4111   # HTTP daemon (warm sharp)
```
Optional binaries that the `auto` engines use when present: `pngquant`,
`gifsicle`, `jpeg-recompress` (all installed on this Mac).

## Conventions
- ESM only; `node:test`; no TypeScript. Keep deps minimal (sharp/svgo/commander/
  tinyglobby/cli-progress/picocolors).
- Commit attribution per the global `~/.claude/CLAUDE.md` (model + ctx + effort line).
- Branch before committing if on the default branch; commit only when asked.

## Docs (read these before big changes)
- `README.md` — usage. `NOTES.md` — every flag + 2.9→3.x mapping.
- `RESEARCH.md` — **why** each codec behaves as it does, with measured numbers.
- `SPEC.md` — the Craft-plugin product architecture + roadmap (§11).

## Status / next
Feature-complete optimizer (still/animated/vector, auto-format, manifest) + the
transform-service backbone. The companion **Craft plugin** lives at
`../craft-lithocinch`. Next: native Craft `ImageTransformer`, on-upload optimization.
