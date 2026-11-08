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
- Runtime dependencies (`package.json`, exact pins mirrored in `packages.lock.json`): pi-subagents, pi-intercom, `unbash` (the gate's shell parser), and `@inquirer/prompts` (the arrow-key setup picker, imported lazily by `setup.mjs`). `@earendil-works/pi-tui` is a Pi-provided peer (`"*"`), not a dependency, because Pi warns about host packages under `dependencies`; a checkout has it as a devDependency for `setup --preview` and the installer tests, so a package install without dev dependencies has no `--preview`

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

A new `context` or `before_agent_start` hook must keep the messages already sent byte-identical (the rules are in [cache](cache.md#stable-prefix)). `extensions/core-adapter/test/prefix-stable-catchall.test.ts` collects every such handler the adapter registers and fails when one rewrites a sent message or the system prompt, so a new hook needs no entry there.

`npm run test:node` and `npm test` run through `scripts/foreman_test_run.mjs`, so parallel sessions do not overload the host. Only one full suite runs per machine: the wrapper takes an exclusive lock file `<agentDir>/pi-foreman/state/test-lock` (the temp dir when the agent dir does not exist; `FOREMAN_TEST_LOCK_DIR` overrides the directory) holding `{pid, started, cwd, host}`. A second run prints one line `waiting for the test lock held by pid N, started HH:MM` to stderr and polls every 2 s. A lock is stale, and is taken over atomically, when its pid is dead, it is older than `FOREMAN_TEST_LOCK_MAX_MINUTES` (default 30), or it is unreadable and older than 5 s. The lock is released on exit, failure, SIGINT and SIGTERM (the signal goes to the child first). `node --test` runs with `--test-concurrency` set to half the cores (`FOREMAN_TEST_CONCURRENCY=N` overrides). `FOREMAN_TEST_LOCK=0` or a truthy `CI` skips the lock (CI calls `node --test` directly). `npm run test:node` passes `--import ./extensions/core-adapter/test/_hermetic-env.mjs` (hermetic env for the core-adapter tests). Leading node options such as `--import` stay before `--test`; the first plain argument starts the globs. `--exec -- <command>` takes the lock around any command without the concurrency flag. Builders run targeted tests only; the reviewer runs the full suite once per change.

## Installer test rig

`tests/installer/rig/sandbox.mjs` exports `createSandbox({ versions })`, one hermetic sandbox per test: a temp agent dir, a fake `HOME`, and a bin dir first on `PATH` holding shims for `pi`, `npm`, `herdr`, `herdr-app`, `hc` and `python`. It returns `{ agentDir, home, binDir, env, calls(), snapshot(), cleanup() }`. Pass `env` to the process under test (it sets `HOME`, `PATH`, `PI_CODING_AGENT_DIR`, `PI_FOREMAN_PI_BIN`, `FAKE_PI_LOG`, `PI_FOREMAN_PICKER=off`, `CI=1`); `calls()` returns every shim call as `{tool, argv, cwd}` from one JSONL log (`$FAKE_PI_LOG`); `snapshot()` returns the agent dir as `{relative path: contents}`; call `cleanup()` in a `finally`.

The shims are Node scripts in `tests/installer/rig/shims/` (`pi` is `fixtures/fake-pi.mjs`), started through `process.execPath` by a `#!/bin/sh` wrapper, or a `.cmd` wrapper on Windows. The shims other than `pi` write only to the log; the `pi` shim (`fixtures/fake-pi.mjs`) also writes `settings.json` in the sandbox agent dir. `SHIM_VERSIONS` is a JSON map the shims answer from: `npm view <pkg> version` returns `map[pkg]`, `herdr --version` returns `map.herdr`, `herdr-app --version` returns `map["herdr-app"]`, `hc --version` returns `map.hc`, `python --version` returns `map.python`; a missing key exits 1. `npm install` and `npm ci` exit 0. No test touches the network or the real agent dir.

Screen snapshots: `tests/installer/screens.test.mjs` draws each setup screen from `setup/fixtures/preview.json` through the frame-capture terminal at 100x30 and 80x24 (key scripts drive navigation) and compares to `tests/installer/screens/*.snap.txt`. After an intended change, rewrite them with `UPDATE_SNAPSHOTS=1 node --test tests/installer/screens.test.mjs` and review the diff. To see a screen yourself, run `node setup.mjs --preview <screen>` (same sample data, so you see the snapshot bytes live). Rig tests: `tests/installer/rig.test.mjs`.

## Replay rig

`node scripts/replay_run.mjs` runs each `tests/replay/test_*.py` as its own `unittest` process, in parallel: `FOREMAN_REPLAY_JOBS` workers (default `min(4, availableParallelism)`), then the modules in its `SERIAL` list one by one. It prints a PASS or FAIL line per module, the 15 slowest, the wall time, and the last 80 lines of each failing module; exit 1 on a failure, 2 when no module is found or the arguments are bad. `--shard i/n` (or `FOREMAN_REPLAY_SHARD=i/n`; the flag wins) runs only shard i of n: the sorted modules are dealt round-robin, pool first, then the serial ones continue the count, so the n shards are disjoint and cover every module. `--list` prints the stems a selection runs and exits without starting Python. One shard locally: `node scripts/replay_run.mjs --shard 2/4` (preview with `--list --shard 2/4`). Each module starts `pi --mode rpc` with
a temp `PI_CODING_AGENT_DIR` and temp project against a scripted fake provider and compares the trace to golden
sequences. No real model calls. The Pi CLI comes from `FOREMAN_PI_CLI`, else the global npm root, else Pi's managed
install (`~/.pi/agent/install/current-version`); none found is an error naming the paths tried, not a skip. pi-subagents, the permission system and pi-intercom come from the repo's `node_modules` (run `npm install` first); the rig
adds only this repo as a package and filters intercom out for non-intercom rigs. Rigs wait with `driver.wait_until(pred)`: it polls the asserted condition and raises with the last state seen on timeout; do not add fixed sleeps before assertions. `FOREMAN_FAKE_DELAY=<tag>:<step>:<ms>` (`fake_provider.ts`) delays the fake model's answer to that script step (the step `locate()` computes), so a test can force a timer to fire inside a run (`test_replay_wait_race.py`). When `driver.py` times out waiting for an RPC record, the `TimeoutError` message (prefix `no RPC record in time`) carries the stderr tail, the last 25 records seen as (type, customType, role) and the count and last 5 unparseable stdout lines (each cut to 300 characters). `FOREMAN_REPLAY_UPDATE_GOLDEN=1` regenerates the replay goldens; run it only for the rigs you intend to change and review the diff. Design: `design/architecture.md`
[section 10](../design/architecture.md#10-replay-rig-and-tests), installer: [section 11](../design/architecture.md#11-installer).

## CI

GitHub Actions runs a matrix of Linux, macOS and Windows on Python 3.13 for pull requests and after each merge to main, plus manual dispatch (no feature-branch push trigger). The run on main catches combination failures, because branch protection is non-strict (a PR need not be up to date with main). A new push to a PR cancels the superseded run; runs on main are not cancelled. The required checks are `ci-ok` and `pr-policy` (see [Auto-merge](#auto-merge)). `ci-ok` passes only when the `test`, `replay` and `bench-smoke` jobs all succeeded. The replay suite runs as the `replay` job, sharded per OS (`--shard i/n`): Windows 4 shards, Linux 2, macOS 1, seven legs in all. GitHub caps concurrent macOS jobs per account, and macOS arm64 capacity is scarce (a shard was cancelled with "not acquired by Runner" after 15 min in the queue), so macOS runs as one replay job (shard 1/1, which covers every module) plus the `test` job. Windows is the slow OS, so it keeps most shards. Every OS still runs the full suite. The `test` job no longer runs replay. Each shard runs through `scripts/replay_run.mjs` in parallel (`FOREMAN_REPLAY_JOBS` sets the worker count; the Windows legs use 2 workers, the others the default 4, because 4 cold `pi` starts on a 4-vCPU Windows runner timed out; the first RPC after launch, `session_id()` in `tests/replay/driver.py`, has a 60 s startup deadline, every other request 15 s); the Windows legs turn Defender real-time scanning off first for speed.

`npm run test:ci` (`scripts/foreman_ci.mjs`) is the pre-PR check. It runs the CI steps that `npm test` does not, in CI's order: the replay suite against the `node_modules` Pi CLI, `pull_core.py --conformance` (skipped with a line when pytest is missing), the installer suite, and the bench smoke probe on the fake provider (skipped when `harbor` is not on PATH). It prints one line per step and exits 1 on any failure; `--only <step>` runs one step.

## Auto-merge

A PR merges itself once its required checks are green: press GitHub's own **Enable auto-merge** button (squash) on the PR. No label or workflow is involved.

- **Required checks on `main`:** `ci-ok` (ci.yml) and `pr-policy` (`.github/workflows/pr-policy.yml`). `pr-policy` is its own workflow so a body edit reruns only it.
- **Policy rules:** the PR body has a `## Changelog` section with at least one `- ` bullet before the next `## ` heading (`###` does not end it), and `CHANGELOG.md` is not among the changed files (neither as `filename` nor `previous_filename`). The workflow uses `pull_request` with a read-only token, no checkout and the body only through `env`, so no PR code runs and fork PRs work.
- **Turn it on for a repo (owner, once):** `node scripts/repo_automerge.mjs <owner/repo> [<owner/repo>...] --checks ci-ok,pr-policy` is a dry run that prints what it would change; add `--apply` to write. It enables `allow_auto_merge` and `delete_branch_on_merge` (read back afterwards), sets the required checks on the default branch and turns required pull-request reviews off. Rulesets are reported, never edited. A repo that fails is reported and the next one runs; the exit code is 1 if any failed. Where the plan has no branch protection (a private repo on a free plan) the script says so and skips it; there the button does not appear.
- **Trade-off:** with required reviews off a solo owner can merge their own PR, so the checks are the only gate. Keep required reviews on where a second person exists, and then auto-merge waits for the approval as well.
- **After the merge:** the foreman's watcher on the merged PR (`pr_watch`, see [tools](tools.md)) triggers `git switch <default> && git pull --ff-only && git branch -d <branch>`, which the guard allows when the branch is merged ([safety](safety.md), [permissions](permissions.md)).
- **A PR merged by another session or the owner:** run a watcher with `foreman_bg`. Poll `gh pr view <n> -R <owner/repo> --json state,mergeCommit` every 60 s; stop on `CLOSED` (report closed without merge) or `MERGED` (report repo, PR and merge sha). Then retry `gh run list -R <owner/repo> --commit <sha> --workflow ci.yml --json databaseId -q '.[0].databaseId'` every 15 s for up to 5 minutes until a run exists, and run `gh run watch <id> -R <owner/repo> --exit-status` to follow the CI run on the default branch.
- **Known limit:** a PR that edits `pr-policy.yml` runs its own version of the workflow under `pull_request`, so the owner's button press stays the real gate for such a PR.

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
A new outside source for a skill or design note goes into `config/knowledge.json` and gets accepted (`foreman knowledge accept <id>`, [sessions](sessions.md#knowledge-sources)).

`docs/features.md` is generated: `python scripts/foreman_docs.py features` writes it from `config/features.json`
(the only hand-kept part), the defaults and the layer rules in `scripts/foreman_config.py`; `--check` exits 1 on
drift. Add every new key or command to one feature in `config/features.json`; `tests/test_features_doc.py` fails
otherwise and on a stale file. `FOREMAN_DOCS_UPDATE=1 python -m unittest discover -s tests -p "test_features_doc.py"`
rewrites it.
