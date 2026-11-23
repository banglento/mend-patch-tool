[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/banglento/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/banglento/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads them all: a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. Every file is changed or nothing is.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
`hidden-spec-cli-01-run-20261122` ("Build mend, one patch tool for every AI
edit format"). Node 22, standard library only — no install step, no
dependencies.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Each edit names the lines it replaces, and `mend` finds them at the first of
three matching tiers: exact, trailing whitespace ignored, then leading and
trailing whitespace ignored (re-indenting added lines to the file's indent).
A failed edit changes nothing and the edits after it still run, so every
failure is reported; when any edit failed, no file is written.

Exit codes: `0` with one line per changed file (`A`/`D`/`M`, `R old -> new`
for a move) plus `ok: <n> files`; `1` with one `error: <code> <path>` line
per failed edit plus `failed: <k> of <n> edits`; `2` with a single
`error: usage` / `error: no-patch` / `error: format` / `error: parse <N>` line.

## Practice checks

The kit's 100 public practice checks (unified 30, search-replace 20, v4a 20,
json 15, cli 15) all pass:

```
node check.ts <practice.json>
# 100 of 100 passed: practice score 1000
```

## Files

- `main.ts` — the CLI (SPEC.md sections 1–10).
- `runner.ts` — the kit's trial runner (kept as handed out).
- `check.ts` — runs the practice set against `main.ts`.
- `LICENSE` — MIT.

## License

MIT — see [LICENSE](LICENSE).
