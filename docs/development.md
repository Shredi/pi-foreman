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
- `setup.mjs` setup script (`foreman setup`); `packages.lock.json` pinned Pi and packages

Running from a checkout instead of the installed package: [install](install.md#developing).

## Tests

```sh
python -m unittest discover -s tests -v          # npm test
node --test "extensions/core-adapter/test/*.test.ts"   # npm run test:node
node --test "tests/installer/*.test.mjs"          # npm run test:installer
npm run test:ci                                   # pre-PR: what CI runs and npm test does not (replay, core conformance, installer, bench probe); about 25 minutes
npm run typecheck                                 # tsc --noEmit
node setup.mjs --dry-run                          # installer preview, writes nothing (exits 1 until pi-foreman is installed as a package; see install.md#developing)
```

## Replay rig

`python -m unittest discover -s tests/replay -v` starts `pi --mode rpc` with
a temp `PI_CODING_AGENT_DIR` and temp project against a scripted fake provider and compares the trace to golden
sequences. No real model calls. The Pi CLI comes from `FOREMAN_PI_CLI`, else the global npm root, else Pi's managed
install (`~/.pi/agent/install/current-version`); none found is an error naming the paths tried, not a skip. pi-subagents, the permission system and pi-intercom come from the repo's `node_modules` (run `npm install` first); the rig
adds only this repo as a package and filters intercom out for non-intercom rigs. Rigs wait with `driver.wait_until(pred)`: it polls the asserted condition and raises with the last state seen on timeout; do not add fixed sleeps before assertions. `FOREMAN_REPLAY_UPDATE_GOLDEN=1` regenerates the replay goldens; run it only for the rigs you intend to change and review the diff. Design: `design/architecture.md`
[section 10](../design/architecture.md#10-replay-rig-and-tests), installer: [section 11](../design/architecture.md#11-installer).

## CI

GitHub Actions runs a matrix of Linux, macOS and Windows (Python 3.9 and 3.13) on every push and PR.

`npm run test:ci` (`scripts/foreman_ci.mjs`) is the pre-PR check. It runs the CI steps that `npm test` does not, in CI's order: the replay suite against the `node_modules` Pi CLI, `pull_core.py --conformance` (skipped with a line when pytest is missing), the installer suite, and the bench smoke probe on the fake provider (skipped when `harbor` is not on PATH). It prints one line per step and exits 1 on any failure; `--only <step>` runs one step.

## Releases

Cut a release with `gh release create <tag> --generate-notes`. The notes come from the merged PRs' titles and their `## Changelog` sections (one to three user-facing bullets each). PRs do not edit CHANGELOG.md; it is kept as history. Overlays read the GitHub release page to see what changed.

## Windows notes

Use `path.resolve` on drive-letter paths before comparing, `realpathSync.native` for short runner names, quote or
forward-slash paths interpolated into shell strings, simulate win32 in unit tests by injecting platform and
separator, never `shutil.rmtree` a `.git` dir (rename it), and keep POSIX-only mechanics in skip-marked tests.

## Public-repo rule

This repo is public: nothing private in files, commit messages or issues. See `AGENTS.md`.

## Keeping docs current

`tests/test_docs.py` checks that config schema keys, registered commands and relative links appear in these pages.
When you add a key or command, document it in the page for its area.

`docs/features.md` is generated: `python scripts/foreman_docs.py features` writes it from `config/features.json`
(the only hand-kept part), the defaults and the layer rules in `scripts/foreman_config.py`; `--check` exits 1 on
drift. Add every new key or command to one feature in `config/features.json`; `tests/test_features_doc.py` fails
otherwise and on a stale file. `FOREMAN_DOCS_UPDATE=1 python -m unittest discover -s tests -p "test_features_doc.py"`
rewrites it.
