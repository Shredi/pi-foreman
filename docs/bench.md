# Benchmark (`foreman bench`)

> Covers the Harbor-based benchmark runner, its trace-derived columns, post steps, price tiers and the review bench.
> Read it when you measure a change to the harness; ordinary users do not need it.
> Needs `uv tool install harbor` and local Docker; Harbor telemetry is always switched off.

## Running

`python scripts/foreman_bench.py run --preset bench/presets/smoke.json` runs the preset's rows over a
[Harbor](https://github.com/harbor-framework/harbor) task dir (`--tasks DIR` or `bench.tasks_dir`) in local
Docker; a second `run` resumes, `table` prints the counters (success, tokens, wall time, tool calls,
approvals, guard blocks). Needs `uv tool install harbor`; Harbor telemetry is always switched off. The
Harbor agents live in `bench/harbor_agent.py` and are not part of the installed package.

`--dry-run` prints the cell order, `--token-cap N` stops cleanly (exit 4) once finished cells used N
tokens (two consecutive infrastructure-error cells stop it with exit 5), `--setup-only` installs one cell's agent and runs zero-model checks without a prompt.
`bench/tasks/m1-recheck` re-checks the M1 standard task (ledger, explorer, builder, reviewer).

## Columns

Trace-derived columns include `ceremony_incomplete`, `read_blocks`, `recheck_blocks`, `finish_refused`,
`launch_waits`, `rereviews` (reviewer launches while the review step was re-opened) and `orient_lines`
(lines in the orientation packet, 0 if none), `ledger_calls` and `ledger_denies` (the foreman's own `foreman_ledger` and shell `ledger` calls, and those refused; child denies stay in `asks_denied`), `dup_reviews` (reviewer launches refused as duplicates), `second_opinions` and `stop_hold`. `tier` is read from the foreman's own trace only (its `triage` event, else its last `tier` event); a trace file whose `session_start` has role `child` is ignored for it. A foreman row's user-layer `foreman.json` is generated from the row: `foreman_edits`, `foreman_reads`, `recheck_budget`, `launch_wait` and `dedupe_notify` map to their ceremony knobs, and a `user_config` object is deep-merged in last, so a row can set any knob (the eee843d-equivalent row: `"user_config": {"ceremony": {"ledgerHelper": "off", "reviewPerRevision": false, "heavyThreshold": "eee843d"}}`).

Other counters: `rung_up`, `child_read_warn`/`child_read_deny` (trace `child_read_budget`), `review_defer_headless`, `child_turn_cap`, `launch_refused`, `thinking_by_role` (levels the sessions ran with), `tier_dist`, `cache_write_per_launch` (median cache-write tokens per launch).

## Cost and post steps

Cost uses `bench/prices.json`; Haiku 5.5's long-context tier (prompts above 100k tokens) is applied per request from the usage log (rows without it are priced flat and flagged `tier_approx`). Permission auto-review calls are logged with role `autoreview` (columns `autoreview_tokens`, `autoreview_calls`, `autoreview_usd~est`, `autoreview_defer_share`). The bridge reports no usage for review calls, so their tokens are a chars/4 estimate and `autoreview_usd~est` is an estimate too. `autoreview_defer_share` is model defers divided by model calls (allow, defer, soft-deny, deny, garbage, empty, timeout, error); deterministic labels such as sed-read, timeout-wrapper, tmp-scratch, surface, no-model, truncated and child count in neither. `wall s` is the Harbor agent time including the post steps; `wall task s` (waiter start to the post-step marker) and `wall post s` (marker to waiter end) split it, and are `-` for cells without post steps. A row's `"bench": {"post_steps": ["retro", "sync"]}` (RPC driver) runs `/retro` and `/sync --dry-run` in the foreman session after the task is done; their output stays in the agent state dir, their usage after a marker is left out of tokens and cost and shown as `retro_tokens`/`retro_usd`, a changed workspace marks the cell infra `post_step_changed_workspace`, and `run` writes the cells' retro output to `<jobs dir>/retro-findings.md`.

Known limits: the post-step retro (`/retro --model`) adds `--known-limits <file>` when the file exists in the container: the row's `bench.known_limits` path, else `/opt/known-limits.md` (task images `COPY` it from the task's environment dir). The foreman's retro prompt then carries the first 2000 characters under "Known environment limits (rig facts, not harness gaps; do not list them under Missing:)". A missing file adds nothing. Generic Rust and Go task image recipes are in `bench/images/` (`Dockerfile.rust` takes `--build-arg PREBUILD_PKG=<crate>`; rustfmt, clippy and a world-readable vendor dir for the non-root agent user; Go's gofmt and go vet work as that user).

Install: the in-container Node and pi installs (`npm install -g` for pi, the `/opt/pf-npm` packages) run inside a retry loop (`retry_sh`, 3 tries, 20 s apart) because a freshly published transitive dependency can 404 transiently; `pi --version` runs after the loop. A row can set `"bench": {"pi_prebaked": true}` (default off) to install pi with `npm ci` from the committed `bench/pi-lock/` lockfile (uploaded to `/opt/pf-pi`, linked into `/usr/local/bin/pi`) instead of a live `npm install -g`. The lock pins the whole transitive tree but still installs over the network. When `PI_VERSION` in `bench/harbor_agent.py` changes, update the pin in `bench/pi-lock/package.json` and regenerate the lock (a test checks both match): `cd bench/pi-lock && npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.

## Review bench

`foreman bench review` (`scripts/foreman_review_bench.py`, no Harbor, no Docker) measures reviewer models: each cell is
one reviewer launch over a builder diff with planted defects, scored for catches and false alarms.

    foreman bench review --tasks DIR [--models id[,id]] [--repeats 2] [--out DIR] [--jobs 3]
                         [--token-cap N] [--timeout 900] [--dry-run] [--prices FILE]
    foreman bench review-table --out DIR [--tasks DIR]

Task dir (`--tasks` names one, or a folder of them; five synthetic samples (clean, secret-log, shell-injection in TypeScript and Python, path-traversal) are in `bench/review-samples/`):

- `base/` the repo before the change, plain files (or `base.tar.gz`, members relative to the repo root; a single
  top-level `base/` folder is stripped);
- `diff.patch` the builder's change, `git apply`-able onto the base;
- `prompt.md` the owner's task text the builder was given;
- `ground_truth.json` `{"clean": false, "defects": [{"id", "file", "lines": [first, last], "class", "description"}]}`,
  or `{"clean": true, "defects": []}` for a clean control. Classes: `auth`, `shell-injection`, `path-traversal`,
  `secret-log`, `off-by-one`, `resource-leak`, `race`, `swallowed-error`, `insecure-default`.

Plant defects inside the requested change, not next to it. An add-on plant (a helper or code path the prompt never
asked for) is caught by the reviewer's "unrelated change" rule without the reviewer understanding the defect, so it
over-credits weak reviewers. An in-scope plant keeps the diff doing exactly what the prompt asks and makes one line of
it wrong: a check inverted or skipped on one branch, a bound off by one, a lock pair dropped, a value interpolated into
a shell string, a join without a containment check. Verify that the task's own tests still pass with the plant, and
complete the diff wherever the reference change misses something the prompt asks for (requested tests, a required
log line), so seeded cells fail only on the plant and a clean control can honestly pass. When no reference change
offers an honest site for a class, add a small synthetic task whose prompt requests the feature and whose plant is the
unsafe implementation of exactly that request (as `py-shell-filter` and `py-path-serve` do).

Launch, one per cell, through the harness's own review path: the base is committed in a fresh git repo and the diff
applied uncommitted (new files intent-to-add). `bench/review_facts.mjs` runs `collectFacts` and `ownerBlock` from
`extensions/core-adapter/diffscan.ts` and the child scratch line from `childscratch.ts`, so the task is composed as a
session composes it: `Task: ` + a fixed neutral foreman task (three ledger items, then `prompt.md`), the facts block and
owner block only when the scan found a fact, then the scratch line. Pi runs `-p --mode json --no-session
--no-context-files --no-skills -e extensions/core-adapter/index.ts --model <id> --tools
read,ls,grep,find,bash,foreman_ledger --system-prompt <reviewer>`, where the system prompt is `<active_agent
name="reviewer"/>` plus the body of `agents/reviewer.md`. The extension runs as a reviewer child (`PI_SUBAGENT_CHILD=1`
and a launch binding with role `reviewer`), so its `before_agent_start` hook adds `instructions/reviewer.md` and
`foreman_ledger` is registered, as in a session. A replay-provider probe showed this changes nothing else besides
files in the cell's own temp agent dir (usage log, session marker). The permission system (`@gotgenes/pi-permission-system`) is not loaded.
Models default to the claude-bridge reviewer rungs `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, all
at `:medium`. Order: repeat outermost, then task, then model.

Blindness: the reviewer's repo, agent dir and scratch dir live in a work dir under the system temp dir
(`pf-rb-work/<hash>/<cell hash>/`), not under `--out`, so cell results and ground truth are not exposed in the reviewer's tree, prompt or env (the reviewer has bash on the host, so this is not a sandbox). Before each
launch the runner refuses the cell when the system prompt, task, cwd or any env value it sets contains `seeded`,
`ground_truth` or the task dir path, or when a file name in the tree or the diff contains either word. The contents of
base files are not scanned.

Auth and config isolation: the child env drops inherited `PI_*`, `FOREMAN_*`, `CLAUDE_*` and `ANTHROPIC_*` variables,
sets `PI_CODING_AGENT_DIR` to the cell's temp agent dir (its `settings.json` lists only the bridge package), and
`CLAUDE_CONFIG_DIR` to an empty folder inside it, so no host Claude Code settings, hooks or plugins load. The bridge is
installed once into `<tempdir>/pi-foreman-review-bench-cache` (`FOREMAN_REVIEW_BENCH_CACHE`), or taken from
`FOREMAN_REVIEW_BENCH_BRIDGE`; the user's Pi agent dir is never read. The token comes from the file named by
`FOREMAN_BENCH_OAUTH_TOKEN_FILE` (else `FOREMAN_BENCH_OAUTH_TOKEN`) and reaches Pi only as `CLAUDE_CODE_OAUTH_TOKEN`
in its env; it is never printed or written, and every file the runner writes is redacted. Cells name the env keys
they set, never the values. `FOREMAN_PI_CLI` points at another Pi `cli.js`; `FOREMAN_REVIEW_BENCH_FAKE_SCRIPT` feeds
the replay fake provider (`foreman-fake/<model>`, tests only).

Scoring (deterministic; scorer version 2, recorded as `scorer` in every score). `review-table` rescores every cell
from its stored final text with the current scorer, never from the stored score, so an old run is rescored without a
launch; `--tasks` supplies each task's `diff.patch` file list for cells recorded before cells kept `diff_files`.

- Verdict: a twin of `verdictOf` (`rounds.ts`); any FAIL or BLOCK wins. An overall PASS scores nothing.
- FAIL units, the only evidence: a `N. FAIL` item with its indented lines and sub-bullets; each top-level bullet
  (with its deeper lines) of a defects section (`Defects ...:` or `N. FAIL. Defects ...:`); a `Missing:` line that
  cites a path and is not `none`. `N. PASS` items and their sub-bullets, context, summary and `Overall` prose are never
  evidence. `1. 1. PASS` and `4. Missing:` numbering is accepted.
- Naming a file: a token with a directory must be the defect's path (or end in it, or be a directory-bounded tail of
  it that is unique among the diff's files); a bare basename counts only when it is unique among the diff's files.
- Located: a unit names the defect's file and gives a line within its `lines` range +-3 on a line naming the file
  (`file:N`, `file:N-M`, `file:~N`, `file:LN`, `file ~N`, `file line(s) N-M`; else `line(s) N`, `~N`, `~LN`, `LN` on
  that line), a word of its class (table below, matched at a word start, case-insensitive), or a code name from its
  description (snake_case, camelCase, `Name()`).
- Diagnosed: a unit names the file and a class word that is not negated (none of not, no, isn't, without, never, or a
  word ending in n't, among the 3 words before it in the same clause).
- False alarm: a FAIL unit that names no planted file or code name and locates no defect, counted once per unit. A
  unit that mentions tests not added, missing or not run counts under `process` (the table's process column). A unit
  that marks itself not blocking or harmless, reports callers or signatures, rules on the diff-scan facts, or only
  points at another finding (`see the defect below`) without naming a file counts under `notes`. Neither is a false
  alarm. A false alarm is not proof of a wrong finding: a real flaw in the reference change counts too.

| class | words |
|---|---|
| auth | auth, permission, access control, privilege, bypass, unauthorized |
| shell-injection | shell, inject, unquoted, unescaped, quote/quoting, metachar, execsync, sh -c, command line |
| path-traversal | travers, `../`, `..\`, escape, outside the/of (not "outside the ledger"), symlink, canonical, absolute path, sanitiz |
| secret-log | secret, token, credential, password, bearer, authorization header, api key, leak, redact, sensitive |
| off-by-one | off-by-one, fencepost, boundar, inclusive, exclusive, one too, out of range/bounds, last/first element |
| resource-leak | leak, not/never closed, unclosed, close, defer, handle, descriptor, not released, dispose, unbounded, grows without bound/limit, never freed/cleared/drained/trimmed/stop |
| race | race, racy, lock, mutex, concurren, thread-safe, atomic, synchroni, toctou, goroutine, simultaneous |
| swallowed-error | swallow, ignor, discard, silent, unchecked, not checked, error handling, lost error, unwrap_or, suppress |
| insecure-default | insecure, default, tls, verif, permissive, world-, 0777, 0666, plaintext, debug |

The source of truth is `CLASS_SYNONYMS` in the script.

Output in `--out` (default `~/.pi-foreman/review-bench/<timestamp>`): `cells/<task>__<model>__r<n>.json` (final text,
items, evidence, score, ground truth, usage per request, USD, seconds, the composed prompt, the env keys set, the work
dir with `events.jsonl`, the raw Pi event stream) and `review-bench-<run>.md`. The table has one row per model:
located/total and diagnosed/total over planted defects, false alarms over seeded and over clean cells, process items,
clean controls with an overall PASS, USD, $ per diagnosed and per located defect, median seconds and failed launches.
A per-class matrix (diagnosed, located in brackets) and a per-task line follow.
A cell whose json exists is skipped, so a second run resumes. A failed launch (timeout, provider error, no answer) is
written as `<cell>.error.json`, listed in the table and retried by the next run. `--token-cap N` stops before the next
cell once finished cells (failed ones included) used N tokens (exit 4); Ctrl-C kills the running launches (exit 6).
`--dry-run` validates the tasks, prepares one workspace per task in a temp dir (facts, composed task, blindness check),
prints the cell plan and launches nothing.

Cost: list-price equivalent from `bench/prices.json` per request (`foreman_bench.cost_of`). When the bridge reports no
usage for a request, its tokens are a chars/4 estimate priced as uncached input, so USD is flagged `~est` and is an
upper bound. Reviewers run on the host, not in Docker: a reviewer that runs Go or Rust tests may fail or fetch
dependencies; `--timeout` bounds each launch and the work dirs stay in the temp dir for audit (delete
`pf-rb-work/` when done).

Design record: `design/architecture.md` [section 12](../design/architecture.md#12-benchmark-design-design-only-no-runs).
