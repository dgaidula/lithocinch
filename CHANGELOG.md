# Changelog

## 3.1.1 — 2026-10-19
- Fix: `lithocinch transform --help` / `serve --help` (and `-h`) crashed with an `ERR_PARSE_ARGS_UNKNOWN_OPTION` stack trace; they now print the sub-command’s help and exit 0, and an unknown or malformed option is a one-line usage error (exit 2).
