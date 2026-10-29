# Changelog

## Unreleased — 2026-10-28
- `--density <ppi>`: after encoding, writes the resolution into JPEG (JFIF, plus EXIF and Photoshop’s resolution resource where present) and PNG (`pHYs`, plus a kept `eXIf`) output by rewriting header bytes only, so it adds no ICC profile or EXIF block: 0 bytes on a PNG, 18 on a JPEG that had no JFIF header. A WebP, AVIF, GIF or TIFF target (`--format`, `--emit`) is a usage error (exit 2); `--format auto` narrows its pool to JPEG and PNG; a file whose own format cannot hold it is written as usual and reported (`density` in the `--json` summary, a warning, a count in the summary). A passed-through original that keeps an XMP resolution is warned about and counted as stale (`density.stale`, `density.staleFiles`), not as written; outputs skipped because they exist are counted as `skipped (density not checked)`. The value must be plain decimal digits (`0x48`, `1e2` and `72.0` are usage errors).
- `lithocinch density <files-or-folders> --ppi <n>`: new sub-command that rewrites the resolution header of existing JPEGs without re-encoding (decoded pixels and every byte after the header are identical). Refuses a non-JPEG, a damaged or cut-off file (including an EXIF value that points into its own header) and a JPEG that cannot take a JFIF header safely; a stale XMP resolution is a `warn` that names the value and the readers that still see it; other images in a folder are listed as `skip not a JPEG`, and a run with no JPEG exits 1. Writes via a temporary file and a rename; SIGINT and SIGTERM remove the temporary files in flight (exit 130, 143). Human, `--brief`, `--json` and `--quiet` output; `--dry-run`; exit 0/1/2/3.
- Library: `patchJpegDensity`, `patchPngDensity`, `readJpegDensity`, `readPngDensity`, `DensityError`; `optimizeImageBuffer` accepts `density` and returns `result.density`.

## 3.2.0 — 2026-10-19
- `--cheat` added: `lithocinch --cheat` (and `litho --cheat`) prints a short card of common invocations in tldr page format and exits 0. It cannot be combined with `--json` or `--quiet` (usage error, exit 2).

## 3.1.2 — 2026-10-19
- Fix: a usage error on the directory command (an unknown option, a bad `--format` choice) exited 1, the same status as a failed run; it now exits 2, like `serve` and `transform`. Help and `--version` still exit 0.
- Fix: the `serve` banner said `process-images serve`; it now says `lithocinch serve`.

## 3.1.1 — 2026-10-19
- Fix: `lithocinch transform --help` / `serve --help` (and `-h`) crashed with an `ERR_PARSE_ARGS_UNKNOWN_OPTION` stack trace; they now print the sub-command’s help and exit 0, and an unknown or malformed option is a one-line usage error (exit 2).
