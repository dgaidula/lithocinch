# Changelog

## 3.1.2 — 2026-10-19
- Fix: a usage error on the directory command (an unknown option, a bad `--format` choice) exited 1, the same status as a failed run; it now exits 2, like `serve` and `transform`. Help and `--version` still exit 0.
- Fix: the `serve` banner said `process-images serve`; it now says `lithocinch serve`.

## 3.1.1 — 2026-10-19
- Fix: `lithocinch transform --help` / `serve --help` (and `-h`) crashed with an `ERR_PARSE_ARGS_UNKNOWN_OPTION` stack trace; they now print the sub-command’s help and exit 0, and an unknown or malformed option is a one-line usage error (exit 2).
