# Development

> Covers the repo layout, test commands, the replay rig, CI, Windows notes and how the docs are kept current.
> Read it when you change pi-foreman itself.
> It must run on Linux, macOS and Windows: Python stdlib only (3.9+), TypeScript only for Pi extensions.

## Layout

- `extensions/` Pi extensions (TypeScript): `core-adapter/`, `git-guard/`
- `agents/` role definitions; `instructions/` foreman and reviewer prompts
- `core/` vendored Python core; `scripts/` own Python (config, guards, retro, sync, bench, update-check); `foreman findings list|dismiss|export` and `foreman retro models` read
  the reviewer findings store (`scripts/foreman_findings.py`)
- `config/` defaults, schema, permission baseline, `symbols.json` glyph sets, opt-in `presets/`
- `integrations/herdr/pi-foreman-sidebar/` Herdr plugin (Python daemon, manifest, rows snippet)
- `bench/` benchmark presets, prices and Harbor agents; `bin/` the `foreman` and `ledger` wrappers
- `design/` architecture record; `tests/` Python tests, `tests/installer`, `tests/replay`
- `setup.mjs` installer; `packages.lock.json` pinned Pi and packages

## Tests

```sh
python -m unittest discover -s tests -v          # npm test
node --test "extensions/core-adapter/test/*.test.ts"   # npm run test:node
node --test "tests/installer/*.test.mjs"          # npm run test:installer
npm run typecheck                                 # tsc --noEmit
node setup.mjs --dry-run                          # installer preview, writes nothing
```

## Replay rig

`FOREMAN_REPLAY_CACHE=<fresh temp dir> python -m unittest discover -s tests/replay -v` starts `pi --mode rpc` with
a temp `PI_CODING_AGENT_DIR` and temp project against a scripted fake provider and compares the trace to golden
sequences. No real model calls. Design: `design/architecture.md`
[section 10](../design/architecture.md#10-replay-rig-and-tests), installer: [section 11](../design/architecture.md#11-installer).

## CI

GitHub Actions runs a matrix of Linux, macOS and Windows (Python 3.9 and 3.13) on every push and PR.

## Windows notes

Use `path.resolve` on drive-letter paths before comparing, `realpathSync.native` for short runner names, quote or
forward-slash paths interpolated into shell strings, simulate win32 in unit tests by injecting platform and
separator, never `shutil.rmtree` a `.git` dir (rename it), and keep POSIX-only mechanics in skip-marked tests.

## Public-repo rule

This repo is public: nothing private in files, commit messages or issues. See `AGENTS.md`.

## Keeping docs current

`tests/test_docs.py` checks that config schema keys, registered commands and relative links appear in these pages.
When you add a key or command, document it in the page for its area.
