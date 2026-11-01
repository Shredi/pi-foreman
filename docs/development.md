# Development

> Covers the repo layout, test commands, the replay rig, CI, Windows notes and how the docs are kept current.
> Read it when you change pi-foreman itself.
> It must run on Linux, macOS and Windows: Python stdlib only (3.13+), TypeScript only for Pi extensions.

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
- Runtime dependencies (`package.json`, exact pins mirrored in `packages.lock.json`): pi-subagents, pi-intercom, `unbash` (the gate's shell parser), and `@inquirer/prompts` (the arrow-key setup picker, imported lazily by `setup.mjs`)

Running from a checkout instead of the installed package: [install](install.md#developing).

## Tests

```sh
python -m unittest discover -s tests -v          # npm test (through the test lock, `--exec` mode)
node --import ./extensions/core-adapter/test/_hermetic-env.mjs --test "extensions/core-adapter/test/*.test.ts"   # npm run test:node (through scripts/foreman_test_run.mjs)
node --test "integrations/herdr-app/pi-foreman/*.test.mjs"   # herdr-app mod model (also in npm run test:node)
node --test "tests/installer/*.test.mjs"          # npm run test:installer
npm run test:ci                                   # pre-PR: what CI runs and npm test does not (replay, core conformance, installer, bench probe); replay is the slow step
npm run typecheck                                 # tsc --noEmit
node setup.mjs --dry-run                          # installer preview, writes nothing (exits 1 until pi-foreman is installed as a package; see install.md#developing)
```

A fresh worktree needs `npm ci --legacy-peer-deps` before `npm run test:node`.

`npm run test:node` and `npm test` run through `scripts/foreman_test_run.mjs`, so parallel sessions do not overload the host. Only one full suite runs per machine: the wrapper takes an exclusive lock file `<agentDir>/pi-foreman/state/test-lock` (the temp dir when the agent dir does not exist; `FOREMAN_TEST_LOCK_DIR` overrides the directory) holding `{pid, started, cwd, host}`. A second run prints one line `waiting for the test lock held by pid N, started HH:MM` to stderr and polls every 2 s. A lock is stale, and is taken over atomically, when its pid is dead, it is older than `FOREMAN_TEST_LOCK_MAX_MINUTES` (default 30), or it is unreadable and older than 5 s. The lock is released on exit, failure, SIGINT and SIGTERM (the signal goes to the child first). `node --test` runs with `--test-concurrency` set to half the cores (`FOREMAN_TEST_CONCURRENCY=N` overrides). `FOREMAN_TEST_LOCK=0` or a truthy `CI` skips the lock (CI calls `node --test` directly). `npm run test:node` passes `--import ./extensions/core-adapter/test/_hermetic-env.mjs` (hermetic env for the core-adapter tests). Leading node options such as `--import` stay before `--test`; the first plain argument starts the globs. `--exec -- <command>` takes the lock around any command without the concurrency flag. Builders run targeted tests only; the reviewer runs the full suite once per change.

## Installer test rig

`tests/installer/rig/sandbox.mjs` exports `createSandbox({ versions })`, one hermetic sandbox per test: a temp agent dir, a fake `HOME`, and a bin dir first on `PATH` holding shims for `pi`, `npm`, `herdr`, `herdr-app`, `hc` and `python`. It returns `{ agentDir, home, binDir, env, calls(), snapshot(), cleanup() }`. Pass `env` to the process under test (it sets `HOME`, `PATH`, `PI_CODING_AGENT_DIR`, `PI_FOREMAN_PI_BIN`, `FAKE_PI_LOG`, `PI_FOREMAN_PICKER=off`, `CI=1`); `calls()` returns every shim call as `{tool, argv, cwd}` from one JSONL log (`$FAKE_PI_LOG`); `snapshot()` returns the agent dir as `{relative path: contents}`; call `cleanup()` in a `finally`.

The shims are Node scripts in `tests/installer/rig/shims/` (`pi` is `fixtures/fake-pi.mjs`), started through `process.execPath` by a `#!/bin/sh` wrapper, or a `.cmd` wrapper on Windows. The shims other than `pi` write only to the log; the `pi` shim (`fixtures/fake-pi.mjs`) also writes `settings.json` in the sandbox agent dir. `SHIM_VERSIONS` is a JSON map the shims answer from: `npm view <pkg> version` returns `map[pkg]`, `herdr --version` returns `map.herdr`, `herdr-app --version` returns `map["herdr-app"]`, `hc --version` returns `map.hc`, `python --version` returns `map.python`; a missing key exits 1. `npm install` and `npm ci` exit 0. No test touches the network or the real agent dir.

Screen snapshots: `tests/installer/screens.test.mjs` draws each setup screen from `setup/fixtures/preview.json` through the frame-capture terminal at 100x30 and 80x24 (key scripts drive navigation) and compares to `tests/installer/screens/*.snap.txt`. After an intended change, rewrite them with `UPDATE_SNAPSHOTS=1 node --test tests/installer/screens.test.mjs` and review the diff. To see a screen yourself, run `node setup.mjs --preview <screen>` (same sample data, so you see the snapshot bytes live). Rig tests: `tests/installer/rig.test.mjs`.

## Replay rig

`node scripts/replay_run.mjs` runs each `tests/replay/test_*.py` as its own `unittest` process, in parallel: `FOREMAN_REPLAY_JOBS` workers (default `min(4, availableParallelism)`), then the modules in its `SERIAL` list one by one. It prints a PASS or FAIL line per module, the 15 slowest, the wall time, and the last 80 lines of each failing module; exit 1 on a failure, 2 when no module is found. Each module starts `pi --mode rpc` with
a temp `PI_CODING_AGENT_DIR` and temp project against a scripted fake provider and compares the trace to golden
sequences. No real model calls. The Pi CLI comes from `FOREMAN_PI_CLI`, else the global npm root, else Pi's managed
install (`~/.pi/agent/install/current-version`); none found is an error naming the paths tried, not a skip. pi-subagents, the permission system and pi-intercom come from the repo's `node_modules` (run `npm install` first); the rig
adds only this repo as a package and filters intercom out for non-intercom rigs. Rigs wait with `driver.wait_until(pred)`: it polls the asserted condition and raises with the last state seen on timeout; do not add fixed sleeps before assertions. `FOREMAN_REPLAY_UPDATE_GOLDEN=1` regenerates the replay goldens; run it only for the rigs you intend to change and review the diff. Design: `design/architecture.md`
[section 10](../design/architecture.md#10-replay-rig-and-tests), installer: [section 11](../design/architecture.md#11-installer).

## CI

GitHub Actions runs a matrix of Linux, macOS and Windows on Python 3.13 for pull requests and after each merge to main, plus manual dispatch (no feature-branch push trigger). The run on main catches combination failures, because branch protection is non-strict (a PR need not be up to date with main). A new push to a PR cancels the superseded run; runs on main are not cancelled. The only required check is `ci-ok`, which passes only when the `test` and `bench-smoke` jobs all succeeded. The replay suite runs through `scripts/replay_run.mjs` in parallel (`FOREMAN_REPLAY_JOBS` sets the worker count; the Windows job uses 2 workers, the others the default 4, because 4 cold `pi` starts on a 4-vCPU Windows runner timed out; the first RPC after launch, `session_id()` in `tests/replay/driver.py`, has a 60 s startup deadline, every other request 15 s); the Windows job turns Defender real-time scanning off first for speed.

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
