# Changelog

## [Unreleased]

### Fixed
- Ledger 7c: the session's round surfaces (own handoff dirs, round worktrees recorded in the session manifest, isolation worktrees below them) are owned by the foreman; the bound ledger is a read root. A child writes only its own worktree: the round worktree is written by the foreman and the `builder` child whose cwd is in it, every other child role (and any isolation child) reads it but cannot write it; an isolation child writes only its own isolation worktree, never a sibling's. See docs/permissions.md, "Round surfaces". Tests: `roundsurface.test.ts`.
- Ledger 7d: the closed shell-variable grammar takes `cd <literal>`, `NAME=$PWD[/sub]`, `NAME=$FOREMAN_SCRATCH[/sub]` and `NAME=<literal under an owned dir>`; a heredoc opener ends the checked text at its line and an interpreter reading a heredoc keeps its class (still reviewed or asked). Cases in `tests/fixtures/shellvars-cases.json`, read by both implementations.
- Ledger 7e: the foreman's own `git worktree add <repo>.worktrees/<round>` needs no ask (label `round-worktree`); a child's `git worktree` stays denied.
- Ledger 7f: the git guard denies a bash line whose quoted, escaped or `"a"+"b"` pieces reassemble a guarded token (`.git`) that no single piece spells (`split literal reassembles a guarded token`). Tests: `tests/test_git_guard_split_literal.py`.
- Ledger 7h: test-only fixes: a refused close notice wakes a child `foreman_wait`; `npm root -g` runs lazily in the trust tests instead of at import.
- Ledger 8: `bg_wait` is not refused while a child's supervisor ask is open; repeated "tool open for Ns" control notices for one tool call are dropped from the model context (`ceremony.dedupeNotify`); the `strong_no_reason` refusal says to pass `reason` as an extra top-level field of the subagent call; the builder prompt forbids `sed -i`/`sed -i.bak` and shell appends to project files. `RUNG_UP: context` compares the last call's context with `strongAbove` (checked, unchanged; see docs/ladder.md). Tests: `supervisor-window`, `notices-toolcall`, `ladder-reason-text`.
- Ledger 9: `foreman_worktree_setup.read_input` reads only data that is ready on stdin, so a caller that keeps stdin open with nothing written (or a tty) no longer blocks it. Test in `tests/test_foreman_worktree_setup.py`.
- Ledger 11: all suites run with stdin closed (`</dev/null`); no replay goldens changed.
- Ledger 12: a new pane showed the previous session's sidebar row (`fm_l1`, `fm_l2`, `fm_cost`) before its own first publish. Cause: the daemon's join fell back to the working directory and matched a finished, stale or lost presence to the new pane in the same folder. `join()` now skips those states, and the daemon clears the `fm_*` keys of a Pi pane no session is joined to, once. Tests: `StaleTokensTest` (join, blanks).
- Ledger 3: a child session in another Herdr workspace could render a blank row. Defensive, root cause not reproduced: a pane whose push stamp is fresh but whose `agent.list` tokens hold no `fm_l1` is composed by the daemon instead of left to the session. Tests: `StaleTokensTest` (self-pane path).
- R3b point 1: `foreman session open --model <id>` wins over the overlay/preset foreman role model for that session (model and thinking): the child gets `PI_FOREMAN_SESSION_MODEL` and `applyForemanModel` leaves the model alone when it is set. The CLI now runs the session rank rule too when the own model is known (`--own-model`, `PI_FOREMAN_SESSION_MODEL`, or the in-Pi open); an unknown own model (non-Pi parent) skips it and prints `rank check skipped: own model unknown`. `open` and `--dry-run` print `session model: <id>`. Tests: Python (env, dry-run line, rank refusal/skip), TS (resolver with env set and unset, `--own-model` passed).
- R3b point 6: `foreman session brief <handoff dir|label|child id> <text|file>` delivers a brief through pi-intercom's CLI (no shell; manual fallback printed with exit 1, never `herdr agent prompt`). Registry entries record the session `model`; `foreman session list` and `/foreman session list` show label, model, state, handoff dir and child id. Tests with a stubbed sender.
- R3b point 3: ask contract for a parent that is not a Pi session: when a session writes `ask.md` (first line `# Ask <n>: <topic>`) in its own handoff dir, pi-foreman touches `<handoff>/.ask` and shows the session blocked in Herdr (`ask <n>: <topic>`, no `herdr agent prompt`); the parent answers `ruling-<n>.md`, the child waits with `foreman_wait` kind `file` and writes `.seen` (the ruling name) to end the signal. The brief footer names the contract (also for "Session not found" on intercom); worked example in docs/sessions.md. Tests: TS (marker and signal for the own handoff, nothing for other paths), Python (footer).
- R3b point 4: `/foreman close` also closes the session's own child sessions: each open/pending registry child gets `foreman:close`, the registry is polled up to the new `close.childWaitMs` (default 60000, user/overlay config only), and the close notice reports each child as closed, refused, timeout or not sent; it never fails the parent's close. A child's `pi-foreman: close refused: …` reply is recorded in the registry. Tests: `close-children.test.ts` (stub send and timer).
- R3b point 7: the parent row no longer shows a working child as `✗ lost`: a registry entry whose handoff dir matches a live node is merged into it, an `open` entry with `result.md` and no live file is idle, `foreman session open|brief` take the parent id from `--parent-id`, `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`, then config (as the live key does), and a closing child marks its own registry entry `closed`. Tests: radar fixture (R3 shape), opener-id precedence, `markOwnClosed`.
- R3b point 2: `foreman session open` into a fresh managed worktree no longer stops at Pi's "Trust project folder?" dialog: it writes that exact path as `true` into `<agent dir>/trust.json` (atomic, other entries kept, never a parent, nothing on `--dry-run` or for other folders), records it in the registry entry and removes it when the worktree is removed (close cleanup, `foreman worktree sweep`, `foreman_worktree_remove`); entries it did not add are never removed. Builder worktrees run headless, where Pi does not show the dialog, so they need nothing. Tests: `tests/test_foreman_trust.py` (temp agent dir, fresh worktree, Pi's `ProjectTrustStore` when installed).
- R3b point 8 (8a): a child with a bound scratch dir is denied instead of asked for writes below `/tmp` or the OS temp dir outside its scratch dir and workspace (write/edit paths, redirects, `tee`, `touch`, `mkdir`, `mv`, `cp`, `install`, `ln` targets); the reason names `FOREMAN_SCRATCH` and its path. Foreman-side `/tmp` rules unchanged. Tests: `childtmp.test.ts` (R3 lines).
- R3b point 8 (8b): new deterministic allow `own-handoff`: `mkdir`, `cp`, `cat` and `ls` chain segments that stay below the session's own handoff dirs and its round worktree are allowed without a question or a model call (no `parent`/`child` file writes, nothing outside the two roots, a trailing `<dir>/*` accepted on reads). Tests: `ownhandoff.test.ts` (R3 lines). Shared symbols: `deterministicAllow` (`AllowDeps.ownDirs`, label `own-handoff`), `ReviewSession.ownDirs`, `ForemanReview.authorize` (own, non-forwarded bash asks).
- R3b point 8 (8c): at session start the resolved `npm root -g` is compared with the npm root the rendered permission policy grants (read only, never rewritten); a policy that grants a different root writes one `npm_root_drift` trace event and one warning `npm root drifted: run \`foreman setup\`` with both roots (the foreman only; children write the trace). A policy with no npm root grant stays silent. Pure module `npmrootdrift.ts`. Tests: `npmrootdrift.test.ts` (R3 line fixture, warn once, no-grant silent). Shared symbol: `resolveNpmRoot` callers in `index.ts` (session start `.then` also reads the policy).
- R3b point 5: `foreman session open --dry-run` writes nothing (no handoff dir, brief, parent, child or registry entry); it prints the would-be handoff path, child id and command. Regression test.
- radar: a child session known only from its handoff dir (no registry entry yet) crashed `build()` with a NameError; the sidebar then showed no `fm_*` tokens and a blank tree row. Regression test.

### Added
- Ledger 5: `foreman_bg {command, note}` runs a shell command detached (stdout/stderr to `state/scratch/<session>/wait-<id>.log`), registers a pid wait with the note and passes the same bash guards as the foreground tool (toolmap, overlay, shell-write guard, `shellTools.foreman_bg` in the permission baseline). `foreman_wait` pid and ci waits take `log`; `/foreman waits` lists id, kind, note, age, time left and the last 5 log lines; the sidebar, footer and presence `waits[]` name the note. Tests: `bg.test.ts`. See docs/sessions.md, "Background runs".
- Ledger 6: optional `pi-background-tasks` add-on (`PI_BG_FEATURES=process pi install npm:pi-background-tasks`, printed by `foreman setup`). `/foreman doctor` prints `INFO background-tasks: present|absent`; with it present `foreman_bg` refuses with a pointer to `bg_run`, `/foreman waits` lists its `.pi/tasks/` tasks, and `bg_run` passes the same bash guards as bash (toolmap, overlay, shell-write guard, `shellTools.bg_run`; a non-string `command` is denied). Its attribution hook decides by provider name `anthropic`, so a bridge provider is not an Anthropic route, but it takes over the global `anthropic` slot: keep attribution off. No code path requires it. See docs/herdr.md, "Optional add-on: background tasks".
- Ledger 10 (5, 6): `config/features.json` rows `foreman-bg`, `background-tasks-addon` and the `/foreman waits` command on `waits`; `docs/features.md` regenerated; docs/sessions.md, herdr.md, permissions.md, safety.md and tools.md updated.
- Ledger 1: the Herdr children line shows the model after the role (`builder sonnet-5.5 ×2`; short name, provider and `claude-` dropped, `N-M` as `N.M`). The rung is dropped while a model shows and appears again on panels 60 columns or wider. The presence file's `runs[].model` and `foreman_radar --json` carry the launch's model. Tests: presence writer (TS), sidebar fixtures (Python).
- Ledger 2: row 1 of `config-snippet.toml` opens with Herdr's built-in `state_icon`; the 1 s spinner timer and its per-frame metadata calls are gone, and `fm_sym` carries only `!` (blocked over 15 minutes) and the done mark. `ui.spinner` is deprecated: still accepted, ignored. See docs/herdr.md.
- Ledger 4: presence `waits[]` (from `WaitRuntime.list()`), the session state `waiting` (idle with a `foreman_wait` pending; Herdr's status stays working), `⏳ <note> 4m` on the sidebar line 2 when no child runs, `waiting <note>` in the usage footer and a `wait` column in radar. Tests: TS (livestate, footer, wait hook) and Python fixtures.
- Self-planning-roles round (numbers are the brief's points):
  - (102) `ceremony.planner: self|role` (default `self`): under `self` the foreman writes the heavy plan itself and its approved checkpoint satisfies the planner step; under `role` a planner on the foreman's own rung or above switches the session to `self` (trace `planner_self_fallback`); `[plan-review]` stays mandatory.
  - (102) Plan versions: the body above `## Ruling`, `## Rulings`, `## Parent ruling`, `## Decision log`, `## Addendum…` or `<!-- plan-appendix -->` is hashed (`planVersionHash`); review rounds, checkpoint approval and the `plan_changed` gate use it, so an appended ruling needs no new review.
  - (103) `session-foreman` role: model of sessions opened by `foreman session open` (`--model` > provider mapping > own model; only the mapping's model is used); claude-bridge presets map Opus, openai and google their foreman model; not launchable.
  - (103) A session never opens one ranked above its own: `session open refused [session_rank]`; fails closed when ranks exist and the own model is unknown.
  - (103) `foreman:plan` / `foreman:result` intercom aliases; `foreman_wait kind:child` (label or any) wakes on a child's plan, result, update or close notice; heavy instruction for multi-session plans with `ruling.md` and `foreman session brief`; replay `session_tree`.
  - (47) `roles.<role>.denyTools` (globs, layers only add): `mcp__*` denied, never asked, for planner, explorer, reviewer, senior-reviewer; applies to codemode inner calls.
  - (54b) The foreman read budget counts `mcp__*` calls and `subagent get|guide`; the supervisor exemption ends at the reply or run end.
  - (54c) Replay `parallel_ask`: two parallel child launches, one asks the supervisor.
  - (54d) A child's `rm` of editor backups (`*~ *.bak *.orig *.swp .#*`, also via `/bin/rm`, `command rm`, `sudo rm`, `unlink`) is denied (`editor_backup`); builder and finalizer wording forbids shell edits.
  - (97/30) A line inside a closed grammar (every statement a sole `NAME=<plain absolute path>` or a simple command from `mkdir cp mv cat ls tee touch tar node npm npx python3 git test echo true` with plain words; split on `;` `&&` `||` newline only) resolves a later `$NAME` in the overlay path checks and the shell write guard, identical in TypeScript and Python (`tests/fixtures/shellvars-grammar.json`); any other line resolves nothing and asks as before. Replaces the per-form setter blacklists.
  - (97/31) grep, egrep, fgrep, rg and `git grep` patterns and option values are never path operands.
  - (97/32) `/foreman close` cancels the session's own pending waits; an active child run still refuses.
  - (97/33) The finish gate accepts a self-plan plus reviewer verdicts as a complete heavy ceremony.
  - (97/34) A reviewer FAIL with a `SECURITY:` finding line exempts the answering builder revisions from `ceremony.revisionRounds`, ceiling 2x the limit (`revision_security_exempt`).
  - (106) AGENTS.md: no new Python outside core/guards.
  - (106, ruling 3a) The git guard no longer treats the `[`/`[[` builtin as a computed program; command substitutions in argument positions of reader commands stay allowed.
  - (106, ruling 3b) Foreman policy rows allow `npm ci` and `npm install`; a child's `git fetch`/`npm ci`/`npm install` ask. There is no `git fetch` row (it asks for every role).
  - (106, ruling 3c) Reading `parent`/`child` of the session's own handoff dir is allowed for the foreman, writes ask.
  - (106, ruling 3d) The orientation names the bundled package roots.
  - (106, ruling 3e) The foreman never lists the checkout's parent directory. Documented limit: a reader chained with `find` loses the reader skip on a protected file.
  - Documented limit: the permission system's own extractor resolves only HOME/PWD and has no `git grep` pattern handling (docs/permissions.md).
  - Security (ruling 12:05): variable resolution is a closed grammar in both implementations instead of form blacklists, so `case` arms, newlines after control words, comments after a pipe, `printf -v`, `declare -n`, `$[..]`, `${X:H=0}`, `exec {H}>`, `wait -p`, `coproc`, `IFS`/`HOME` assignments and conditional assignments all leave the line unresolved.
  - Security (ruling 12:05): the `git fetch` policy rows are dropped (`--upload-pack=<cmd>` ran code unasked); a `git fetch` asks for every role.
  - Security (ruling 12:50): the variable grammar refuses special, readonly and sensitive names (`_ RANDOM PPID PATH IFS HOME`, `BASH_*`, `FOREMAN_*`, `GIT_*`, `NODE_*`, `NPM_*`, `LD_*`, `DYLD_*`, `SSH_*`) in assignments and references, and `~` anywhere in a word (`H=/x; cp f "~$H"`); `GIT_ALLOW_PROTOCOL` before a git network command is refused. Single-letter names other than `_` stay allowed.
  - Security (delta review): `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH`, `GIT_ASKPASS` and similar leading env assignments before a git network command are refused in every role.
  - Security (pre-PR review): the git guard refuses `fetch`/`pull`/`clone`/`push` with `--upload-pack`, `--receive-pack`, `--exec`, `--config`, `-u` (fetch/pull/clone) or `-c core.sshCommand=`/`core.gitProxy=` in every role.
- Harness-friction round (numbers are the round's ledger items):
  - (2, 3, 5, 6, 18) Owned dirs: `external_directory` patterns in the permission policy for the handoffs dir,
    `sessions/*/subagent-artifacts`, `*.worktrees`, the children's scratch root, bare `foreman.json`/`settings.json`,
    and read for `<agentDir>/pi-foreman` and the global npm root. `git worktree add|list|prune|lock|unlock|move|repair`
    is allowed for the foreman (`remove` asks). The grants are per user; the overlay and git guard keep children out
    of them, except their own `$FOREMAN_SCRATCH` subtree (readWrite, `node <script>` and `cd` included) and the
    handoff `plan.md`/`result.md`; children may only list worktrees. `foreman_wait kind:file` accepts owned paths; the
    shell write guard takes `--allow-dir`.
  - (4) The npm root is readable for every role, resolved with `npm root -g`.
  - (7) The `waiting_for_parent` state is honoured by the finish gate: set by a pending checkpoint, a `foreman_wait`
    file wait under the handoffs dir, or a timer wait while the session's own handoff dir holds a recent
    `plan.md`/`result.md`; cleared by the next user or parent input.
  - (10, 13) Hook `foreman-worktree-setup` copies a real `node_modules` into managed worktrees that have a lockfile
    (never a symlink); `foreman setup` registers it on Linux/macOS. `/foreman doctor` WARNs on a symlinked
    `node_modules` in a live worktree and on a missing hook; launch-wait prints the worktree path; both worktree
    roots (launch result path, `../<repo>.worktrees/<branch>`) are documented.
  - (16) Review tasks carry the ledger (the cited items or the whole ledger) and no owner prompt; reviewers quote the
    ledger item.
  - (20) `ceremony.childTimeoutSeconds` (default 1800) sets the child tool timeout.
  - (21) pi-intercom 0.17.0 (idle-wake, steer delivery, `IntercomSessionHeldError`, `acknowledgesReceipts`; no
    upstream changelog), `renovate.json` (pinned, grouped weekly, no automerge), and the full `promptCache` snippet in
    doctor and `docs/cache.md`.
- Idle prompt cache (`providers.<p>.cache`, `docs/cache.md`): a per-provider TTL and billing policy. For
  `claude-bridge` (on by default through the built-in provider defaults) pi-foreman lets Pi's cache warmer keep an idle session warm for up to 30 minutes
  (`cache_warming_decision` hook), spends the last warm read on one compaction above half the tier threshold, tags the
  refreshes `keepalive` in the usage log (own `/foreman cost` line, not in the footer's per-turn cost), shows a footer
  glyph and a `cache:` retro line, and `foreman doctor` warns when Pi's `cacheWarming: "idle"` or the model's
  `promptCache` is missing. Keep-alive costs tokens; switch it off with `keepalive.enabled: false`.
- PR tools (`tools.pr`, on by default; `docs/tools.md#pr-tools`): `pr_create`, `pr_status`, `pr_checks`, `pr_comments`
  and `pr_watch`, host-neutral through `tools.prHost` (built-in `gh` and `glab`, or command templates). `pr_watch` wakes
  the foreman when checks finish or a comment lands (`tools.prWatchSeconds`). A `pr:` retro line counts the calls.
  Re-run `foreman setup` so children get the read tools.
- Optional git tool pack (`tools.git`, off by default; `docs/tools.md`): `git_status`, `git_log`, `git_diff_stat` and
  `git_branch_state`, capped read-only tools for the foreman and for children whose role has bash. A `tool_pack` trace
  event and a `git:` retro line compare pack calls with bash git. Re-run `foreman setup` after enabling.
- Generated feature overview (`docs/features.md`) for agents setting pi-foreman up: install lines, config layers,
  every feature with its fresh-install state (on, off, opt-in), keys with defaults and layer rules, enable snippets,
  commands, overlay quick start and invariants. Built by `scripts/foreman_docs.py features` from the curated
  `config/features.json` plus schema, defaults and `foreman_config.py` layer rules; tests fail on drift, on a schema
  key or command no feature claims, and `FOREMAN_DOCS_UPDATE=1` regenerates. `llms.txt` points agents at it.
- `/foreman doctor` prints `dormant: <feature ids>`, the features switched off in the live config.
- Package-first install (`docs/install.md`): `pi install git:github.com/Shredi/pi-foreman` (`npm:pi-foreman` planned
  for v0.1.0). `pi-subagents`, `pi-permission-system` and `pi-intercom` are bundled dependencies pinned in
  `package.json` and `package-lock.json`, loaded through `node_modules` resource paths.
- `foreman setup` (also `/foreman setup` in Pi and a `bin/foreman` arm) replaces the clone-first installer flow. It no
  longer installs pi-foreman or its dependencies, and migrates leftover top-level `npm:` entries of the bundled
  packages (a second copy is a fatal tool conflict). `--no-intercom` is now a package filter.
- `foreman setup --develop` writes `.pi/settings.json` in a checkout so the checkout replaces the installed package in
  its own tree; the core adapter has a once-guard (a second core copy registers nothing and posts one notice).
- Overlay handshake (`docs/overlays.md`): `globalThis[Symbol.for("pi-foreman.core.v1")]` and `foreman:ready` on `pi.events`.
- Session close (`docs/close.md`): a per-session manifest (`<state>/sessions/<session>/manifest.json`) records the
  worktrees and scratch dirs a session creates (bash `git worktree add`, `mkdir`, writes into a new scratch topic dir,
  `foreman close record`; silent, no tokens). `foreman close` prints a CLOSE report (`CLOSE: ready|open`, `uncommitted:`,
  `unmerged:`, `open item:`, `pending child:`, `removed:`, `kept:`, `handover:`, `child handover:`), writes `close.json`,
  and cleans up manifest entries only when the preconditions pass (worktree clean, merged or pushed, unlocked, no stash,
  no live session inside, never `--force`; scratch via trash or an exact-path remove). `--dry-run`, `--take` and `--drop`
  hand a child's leftovers to the parent; `foreman worktree sweep [--dry-run]` removes any passing linked worktree and
  lists `off-convention:` ones. `foreman sync` and `/sync` run the same report and cleanup; `/foreman close` traces
  `close` with decision `report`. Keys `close.autoClean` (a project may only turn it off) and `close.worktreeDir`
  (user or overlay only).
- Review (`docs/review.md`, renamed from `docs/review-climb.md`): `ceremony.reviewByOccasion` sets reviewer thinking
  and/or model per occasion (user or overlay only; trace `review_occasion`). Four review occasions (`item`, `[plan-review]`, `[pre-pr]`,
  `[second-opinion]`) share one path; only `item` and `pre-pr` count for items and gates. Different-model rule: a
  reviewer on the foreman's own model moves to the next differing rung or `ceremony.reviewModel` (trace `review_model`).
- Plan review: `ceremony.planReview.<tier>` (heavy on; a project can only tighten) makes `foreman_checkpoint` wait for a
  `[plan-review]` verdict on the current plan (`plan_review_required`, `plan_revision_required`; trace `plan_review`).
- Review panel: `ladder.reviewPanel` `{shadows, gates, visible, waitSeconds}`; see Review panel below.
- Findings store `<agent dir>/pi-foreman/state/findings/<session>.jsonl` (trace `finding`, basenames only) and
  `foreman findings list|dismiss|export`; export writes an unconfirmed bench task that `foreman bench review` skips.
  `foreman retro models` (per model and rung: findings, accepted, rejected, unique, late misses, USD, median and p90
  seconds, time to clean), `retro.panelThreshold` and backlog kind `review-model`.
- `foreman bench review --mode climb --rungs a,b,...` composes cached rung cells into policies; `review-table` gains a
  Policies table.
- Retro backlog (`docs/retro.md`): findings survive sessions in a local store (central `<agentDir>/pi-foreman/state/retro/backlog/<key>.md`,
  `global.md` for harness bugs, or `<workspace>/.workflow/retro-backlog.md` via `retro.repoBacklog`), counted per
  session and aged out (`retro.expireDays`, 90-day purge). `foreman backlog list|show|expire|mark|move|brief`. New keys
  `retro.enabled`, `retro.workspaceKey`, `retro.backlogDir`, `retro.repoBacklog`, `retro.expireDays`, `retro.askThreshold`.
- Roles end their report with a `Friction:` line; the foreman emits one `friction` trace event per non-empty line
  (`role`, `runId`, `kind`, `note` of 120 characters, paths reduced to basenames). With the foreman's retro on, a bound
  child writes `trace-<launchId>.jsonl` with `role` and `runId` on every record (also in json and print mode unless its
  `trace.enabled` is an explicit false); `/retro` and `/sync` read those child traces, and `foreman_retro.py` and
  `foreman_sync.py` take `--trace` repeatably.
- `/retro` and `/sync` feed the backlog; `foreman backlog brief` writes a lessons brief you hand to a session you
  open yourself. Bench cells file under `bench/<task-id>`; their retro usage (`kind: "retro"`) stays out of cost columns.
- Herdr sidebar, live: the Pi session pushes its own pane's `fm_*` tokens (`sidebar.py push`) on run start and end, asks,
  state changes, permission prompts and every 5 s (debounced, at most 4 per second, a final row at session end, so it never goes blank), so spawns
  and short runs show at once; while a session pushes, the daemon publishes only `fm_sort` (and the tree layout) and
  takes all keys back when the push stops or the session is lost. A working session cycles a braille spinner in
  `fm_sym` (`ui.spinner`, default true; `false` keeps the hourglass). A finished run shows as `✓ role` on line 2 for
  `radar.recentRunSeconds` (default 8). Line 3 counts uncached input (fresh input plus cache writes); radar JSON gains
  `recentRunSeconds`, run `ended_s`, session `sid` and `uncached`. Lead cells default to 0. Re-merge the rows snippet
  (the working colour now sits on the glyph cell, one `contains = "!"` rule) and run `herdr server reload-config`.
- Herdr sidebar plugin `pi-foreman.sidebar` (`integrations/herdr/pi-foreman-sidebar/`, `docs/herdr.md`): a stdlib
  daemon reads `foreman radar --json --follow`, joins sessions to panes (presence `paneId`, else pid, else a unique
  cwd) and publishes `fm_*` pane tokens (state glyph, label and age or blocked timer, children, tokens, cost, sort key;
  15 s TTL, every 5 s); sets the Agents view sort while a foreman session exists and clears it otherwise. `configure`
  prints a `rows_by_agent.pi` rows snippet; the plugin never writes Herdr's config.
- Radar: `foreman radar --json` (one snapshot line) and `--follow` (one line per `--interval`), no ANSI; wide glyphs
  align. `ui.symbols` (`unicode` default, `nerd`) picks the glyph set for radar, the children widget and the plugin
  (`config/symbols.json`); radar glyphs are now ⏳ working, ⏸ waiting, ? asking, ✋ blocked, ✓ done, ✗ lost.
- Presence file: `paneId` (from `HERDR_PANE_ID`), session totals `tokensIn`, `tokensOut`, `cost` and `blockedSince`
  (additive, `v` stays 1). The children widget prefixes each run with its state glyph.
- Radar: `radar.doneTtlMinutes` (default 30) and `foreman radar --done-ttl MINUTES`. A `done` session older than the TTL
  is hidden and its presence file deleted on refresh (only `state: "done"` files, never unparseable ones); a not-done
  session with no heartbeat for 15 minutes reads `stale` instead of `lost`. Working, blocked and lost rows never expire by age.
- Startup warning when the session's model provider has no `providers.<id>` map (tui and rpc, top-level, not silenced
  by `quiet`): names the fitting presets or says to add `providers.<id>`, instead of failing at the first role launch.
- Dev checkout (`docs/permissions.md`): when the session cwd resolves to the package root or inside it, the
  `{pkgRoot}` write protection narrows to `protect.writeAskSelfHost` (`config/permissions*.json`,
  `config/foreman.defaults.json`, `package.json`); trace `protect_selfhost`, one startup notice.
- Review link, child bash asks (`docs/permissions.md`): effect classes `read`, `build-test` (from the project manifest
  at the worktree root), `write-in`, `write-out`, `unknown` (`effects.ts`); only write-out and unknown reach the review
  model. Read and write paths must resolve inside the worktree or `$FOREMAN_SCRATCH`, writes also under `/tmp`, reads
  also under the user/overlay key `safety.permissions.readRoots` (default empty; no `~`, `..`, other absolute paths,
  symlinks out, `.git`). Chains joined by `&&`, `||`, `;`, `|` are allowed when every segment is
  (`shellchain.ts`; `$(`, backticks, subshells, `eval`, `sh -c`, `xargs`, `&`, heredocs refused; redirects only to
  `/dev/null`, scratch or `/tmp`); trace `chain_allow {segments}`. New label `test-restore` for `git restore`/`git
  checkout --` on test files, so the git guard's test restore no longer defers headless. The `review` trace gains `class`.
- Ladder: `ladder.reviewerClimb {enabled, securityRung}` (default off; on in both `claude-bridge` presets with the
  foreman's Opus as `securityRung`). The second FAIL of the same ledger item across reviewer runs sends the next
  reviewer launch to its strong rung (`rung_up` reason `review_fail_repeat`, `item`); a security-shaped work diff
  (path words and call shapes, `securityScan` in `diffscan.ts`, diff taken once before the model is picked) sends
  it to `securityRung`, else the next ranked mapped model (`rung_up` reason `security`, `hits`; none:
  `security_rung_unset`). A security rung above what `childPolicy` allows is kept (user/overlay config only) and its
  `rung_up` carries `policy_override: true`. New page `docs/ladder.md`.
- Bench: `foreman bench review` scores reviewer models on diffs with planted defects, one reviewer launch per cell
  through the real review path (diff facts and owner block from `diffscan.ts`, core-adapter loaded as a reviewer
  child, empty `CLAUDE_CONFIG_DIR`, token from `FOREMAN_BENCH_OAUTH_TOKEN_FILE`): located and diagnosed defects,
  false alarms per FAIL item (process items apart), clean-control verdicts, USD and a per-class matrix; resumable,
  `--dry-run`, `review-table` rescores old runs with the current scorer (versioned). Three synthetic sample tasks in
  `bench/review-samples/`; `bin/foreman bench` runs `scripts/foreman_bench.py`.
- Review bench: scorer v3 credits symptom descriptions per class (e.g. "passes validation", "nothing is logged",
  "stale", "one byte short", an explicit `x - 1` fix), negation rule unchanged; samples `py-shell-filter` and
  `py-path-serve` (in-scope shell-injection and path-traversal plants); `docs/bench.md` on in-scope versus add-on plants.
- `foreman config apply-preset <name> [--foreman <model id>] [--dry-run]`: merges `config/presets/<name>.json` into
  `<agent dir>/foreman.json` (preset wins), validates before writing, keeps `foreman.json.bak-<date>`. With no role or
  review model configured, an interactive top-level session prints one notice naming the presets and this command;
  new key `quiet` (default false) silences it.
- Bench: row `bench.pi_prebaked` installs pi with `npm ci` from the committed lock in `bench/pi-lock/` (pins the
  transitive tree); default stays the live install.
- Docs: "Parallel rounds" in `docs/sessions.md` (one worktree per orchestrator session, never switch the main checkout).
- Launch briefs: `instructions/foreman.md` gets explorer, builder and foreman skeletons (invariants and callers, new tests
  instead of edits, no narrowed fuzz strategies, visibility, shared symbols, edit tools only); matching rules in
  `agents/explorer.md` and `agents/builder.md`. A builder launch that cites ledger items ("item 3", "#5") gets a
  `[pi-foreman ledger items]` block with their text (trace `ledger_block`); none on a rung-up launch, whose handoff has it.
- Notices: a completion notice whose result was delivered inline is dropped from the model context instead of stubbed,
  and the held launch result loses every pi-subagents async-started guidance line; trace `notify_deduped {runId, mode,
  trimmed_lines}`. The extra turn a notice can trigger is decided inside pi-subagents and is not suppressed here.
- Triage rules (`instructions/foreman.md`, every `foreman_triage` answer): a version or hash bump is trivial, security
  hardening inside one component is standard not heavy, the explorer may be skipped when the builder brief lists the
  files and symbols (the standard finish gate needs only builder and reviewer).
- Review marks: a reviewer PASS marks its per-item "N. PASS" ledger items through the harness, never V (trace
  `ledger_mark_by_review`); a builder or foreman touch-up after a PASS that only changes comments or docs needs no
  re-review and uses no revision round (trace `revision_comment_only`).
- Child scratch: each single-child launch gets `$FOREMAN_SCRATCH` (`<tmp>/pi-foreman-scratch/<session>/<launch>`, 0700);
  writes and `rm` inside it are allowed (overlay cd, planner write guard, review label `child-scratch`); the harness
  traces `child_scratch {bytes, files}`, removes it at run end and sweeps at shutdown; `ceremony.childScratch.keep` keeps it.
- `codemode` is allowlisted; each inner call is still decided on its own (replay `test_replay_codemode.py`).
- Bench: `/retro --model --known-limits <file>` tells the foreman which environment limits are rig facts, not harness
  gaps (row `bench.known_limits`, default `/opt/known-limits.md`, capped at 2000 characters); generic Rust and Go task
  images in `bench/images/` with rustfmt, clippy and a readable vendor dir.
- `foreman radar` (`scripts/foreman_radar.py`, `bin/foreman radar`): a read-only ANSI tree of running sessions, the sessions they
  opened and their subagent runs (glyph, state, last-event age, subtree tokens and cost), from presence files
  `state/live/<sessionId>.json`, the session registry, handoff dirs and usage files; `--once`, `--since`, `--interval`,
  `--no-color`; works without Herdr and on Windows (no curses).
- Children widget (`widget.children`, default on, TUI only): below the editor, this session's subagent runs
  (`role · rung · state · tokens · cost`, `ask` while a forwarded permission ask waits) and opened sessions; the extension
  writes the presence file `state/live/<sessionId>.json` (tui and rpc) that radar reads.
- Herdr: one blocked tracker per Pi process shows every open dialog (any extension's `ui_prompt_*`), permission ask
  (forwarded child asks too) and own ask as blocked, balanced on empty/non-empty, labelled `<agent> · <tool> <head>`
  (never the full command); off without `HERDR_ENV=1`, with `herdr.blockedShim` false or with Herdr's Pi integration
  >= 10. Group tag (`herdr.groupTag`): an opened child pane shows `<parent> › <child>`, a parent `<slug> · <n> children`
  (display-only `report-metadata`, source `user:pi-foreman`, 180 s TTL refreshed every 60 s).
- Ladder: a builder revision after a reviewer FAIL climbs to its strong rung (`ladder.strongOnRevision`, default true,
  trace `rung_up` reason `review_fail`); the finish gate refuses, uncounted, while that climb is open
  (`finish_refused {climb_available}`); on the top rung the two-refusal valve is unchanged.
- Review: the reviewer task carries the owner's task text verbatim (3000 characters) next to the diff facts; a foreman
  ruling never puts a fact in scope, reviewers quote the owner text or FAIL (BLOCK for the senior reviewer).
- Opt-in preset `config/presets/claude-bridge-sonnet-reviewer.json` (reviewer on Sonnet 5.5, no strong rung).
- Children may `git restore` / `git checkout --` test files their own diff modified (vs HEAD), one plain path each;
  every refusal names the allowed form; each restore leaves a `test_restore` trace line.
- Auto-review allows a child's `cp`/`mkdir` into `/tmp/` without a model call (label `tmp-scratch`); `rm` stays reviewed.
- Autoreview usage is estimated (chars/4, `estimated: true`) when the provider reports zero tokens.
- Bench table: `wall task s` / `wall post s` (waiter start to the post-step marker, marker to waiter end) beside `wall s`.
- `docs/` split (install, roles, ceremony, safety, sessions, bench, overlays, development) with a lean README, a
  generated `banner.svg` (`scripts/make_banner.py`, `--check` runs in CI through the docs test) and `tests/test_docs.py` (config keys, commands,
  links and page headers must stay documented).
- `/foreman session open|brief|close|list` and `bin/foreman session open|list` (`scripts/foreman_session.py`): open
  a handoff dir (`brief.md` with a report-back footer, `parent`, `child`) in a new Herdr tab or print the command,
  keep a registry `<agent dir>/pi-foreman/state/sessions.json`, and send briefs and close requests over pi-intercom.
- Close: the parent id is read from the handoff `parent` file (`PI_FOREMAN_HANDOFF_DIR`) at check time, and an accepted
  intercom close replies `foreman:closed <path>` before the session exits.
- Write protection for the handoff `parent` and `child` files (`protect.writeAsk`): children are denied, the
  foreman's write/edit asks, `result.md` and `plan.md` stay writable, so a child can no longer pose as the parent.
- Explorer brief: the latest completed explorer report (8000 characters since the ladder fixes, cut with a marker, plus its result path) is
  prepended once to the next fresh builder launch (after any rung-up handoff); trace `explorer_brief {role, chars}`.
- `ceremony.childReads.<role>.{warn,deny}` (builder 20/40, reviewer 15/30, explorer none): a child's read, grep, find,
  ls and read-only bash calls get a notice at warn and are refused above deny with a "return your report / STATUS:
  stuck" message; trace `child_read_budget {role, count, action}`.
- `review.headless` (default false) in the config schema and defaults.
- Replay fake provider `FOREMAN_FAKE_USAGE=size`, `FOREMAN_FAKE_SIZES`, `FOREMAN_FAKE_SYSTEM`: usage and per-request
  prompt size for every model; child system prompt measured at 1.1k to 1.3k tokens, nothing trimmed
  (design/architecture.md, builder frugality).
- Trivial builder path (`ceremony.required.trivial: ["builder"]`, default): a trivial change keeps a `Tier: trivial`
  ledger and runs one bottom-rung builder, no explorer, planner, reviewer or finalizer; at finish a diffscan check
  (one source file within `trivialBound`, no exported signature/schema change, no test file touched, a test present)
  escalates to standard otherwise (trace `triage_escalated {reason}`), so a reviewer must pass. `[]` restores the old trivial.
- foreman.md tells the foreman about the ladder: `reason` on a strong launch, `RUNG_UP:` / `STATUS: stuck` relaunch.
- Role ladder: `ladder.strongAbove` (100000) and `ladder.childMaxTurns` (60), per provider and per role; a
  bottom-rung child past either is steered to hand off (`RUNG_UP: context|turns`), `STATUS: stuck` / "own checks
  failed" also make the run climb-eligible; the foreman's strong relaunch gets the handoff prepended (trace `rung_up`,
  `rung_up_steer`, `child_turn_cap`). A strong launch with no reason and no trigger is refused (`strong_no_reason`).
- Rank policy: `providers.<p>.ranks` and `ladder.childPolicy` (`below` default, `at-or-below`, `any`); tiers compare
  across providers; inert while no ranks are configured (trace `launch_refused {policy, foreman, requested}`).
- Opt-in presets `config/presets/claude-bridge.json` (Haiku 5.5 -> Sonnet 5.5 children, Opus 5.5 foreman, Haiku
  auto-review), `openai.json`, `google.json`; never merged by default.
- `childMaxThinking` (no default): caps every child launch's thinking level, ladder rungs included.
- Permission auto-review without `review.model` picks the cheapest role-map model with auth (trace `by: "auto"`).
- The baseline has no `sed` rule (no glob separates a print from `1wout` or `1etouch x`, so every sed asks); the
  foreman's review link allows a child's forwarded ask without a model call when it holds a print-only sed
  (`sed -n '<addr>p' <file>`: no s/w/e/r commands, no -i/-f; trace label `sed-read`) or `timeout N <allowed command>`
  and every other unit is allowed (PS floors wrappers).
- Review prompt for child asks: read-only inspection (also chained) is allowed; defer only for writes outside the
  workspace, network or destructive steps. Headless defer (no UI, or `review.headless: true`): a forwarded child ask is
  denied with a text naming the allowed forms, trace `review_defer_headless {role, cmd}`; the `review` trace carries the
  model's defer `reason`.
- Reviewer and senior-reviewer hard rules (changed exported signature, weakened/removed test or assertion, skipped test
  are FAIL unless asked for; grep callers) and `diffscan.ts`: a "Facts to rule on" block from `git diff` (against the HEAD
  at the first builder launch) is appended to a reviewer's launch task; trace `review_facts {count}`.
- `ceremony.ledgerHelper` (`tool` default, `bash`, `off`) and the foreman's `foreman_ledger` tool; the foreman
  closes V itself after a reviewer PASS with no revision since (harness-attested), reviewer children mark V only.
- `foreman_ledger` action `upsert` (`item?`, `text`): replaces an item's text keeping its state, or appends a new item;
  identical text is a no-op.
- `ceremony.reviewPerRevision` (default true): a second reviewer launch after a PASS on unchanged work is
  refused; `[second-opinion]` in the task text allows one.
- `ceremony.heavyThreshold` (`strict` default, `eee843d`): keyword signals become a hint (`triage_hint`).
- Trace events `ledger_call`, `review_dup_refused`, `review_second_opinion`, `triage_hint`; bench columns
  `ledger_denies`, `ledger_calls`, `dup_reviews`, `second_opinions`, `stop_hold`.
- Orientation packet: tracked-file tree to depth 2, head of AGENTS.md or README.md, detected build/test
  commands and an explorer hint, added to the foreman's system prompt once per session
  (`ceremony.orientation {enabled, maxLines}`, trace event `orientation`).
- Trace event `rereview` and bench columns `rereviews` and `orient_lines`.
- Knob `ceremony.reviewGate` (`pass` default, `verdict`; tighten-only toward `pass`).
- Project agent `implementer` for worker waves.
- README: "Updating Pi".
- Permission auto-review model calls are logged to the usage log with role `autoreview` (they were not counted before).
- Bench: Haiku 5.5 long-context price tier applied per request (`tier_approx` flag without a per-request log);
  row key `bench.post_steps` (`retro`, `sync`) with usage split out as `retro_tokens`/`retro_usd` and
  `retro-findings.md`; columns `autoreview_*`, `rung_up`, `child_read_warn`/`child_read_deny`,
  `review_defer_headless`, `child_turn_cap`, `launch_refused`, `thinking_by_role`, `tier_dist`, `cache_write_per_launch`.
- Every role's output contract ends with `Missing: <file | allow rule | brief detail | none>`.
- Ledger hints: each `foreman_ledger` action (not status), child launch and reviewer verdict adds `  > <date> <text>`
  under the cited items (`items 1,2`, `#N`, `N.` lines; else V), at most 3 per item.
- Compaction digest (foreman): open items, items closed since the last compaction and the last 8 hints are added to
  the pi-foreman section after a compaction, naming the ledger as the source of truth.
- Auto-retro: the price-tier compaction asks the summary to end with `## Retro`; each foreman compaction appends the
  friction counters and that section to `.workflow/retro/<session>.md` and hints `retro written` on V.
- `/retro` writes `<agent dir>/pi-foreman/state/retro/retro-<session>.md`; `/retro --model` adds one foreman reply of
  at most 10 lines. The bench `retro` post-step sends `/retro --model`. `foreman_retro.py` counts rereviews, budget
  hits, rung-ups, child read-budget hits, headless defers and turns.

### Review panel: foreman-launched shadows
- The primary reviewer launch is unchanged. At its run end the harness lists the shadow launches; the foreman issues one
  `subagent` reviewer call per shadow with the marker `[panel-shadow:<model>] [<gate>]`, and the hook reuses the primary's
  task and sets the shadow model (rank-checked, thinking clamped). Refusals and launches trace `panel {decision}`.
- Shadows are optional and never block, mark, count or satisfy the PR gate. The attributed block composes when all ended
  or after `ladder.reviewPanel.waitSeconds` (default 600, `decision: timeout`); missing shadows are listed as "not run".

### Changed
- Harness-friction round:
  - (1, 15) Setup keeps top-level bundled copies when a manifest entry is missing and prints the `npm ci` hint;
    doctor FAILs on a missing bundled entry; the developing docs use `npm ci`.
  - (8) The recheck budget exempts reads of the handoffs dir (`ruling.md` included) and `git worktree add|list|prune`;
    nothing else, and anything it cannot read with certainty still counts.
  - (9) `ceremony.planReviewRounds` defaults to 2; the capped checkpoint shows open findings.
  - (11) Builder prompt: edit tools only, no `npm ci` where `node_modules` is a symlink; planner and explorer use
    `npm ls -g` instead of `find` over the global npm root.
  - (12) The git guard treats `git` as a command word only; inline interpreters are classified by their own command.
  - (23) The planner rank refusal says "plan it yourself".
  - (24, 25, 26) Regression rows; child scratch `node <script>` is allowed.
- `foreman setup` recognises a pi-foreman package entry from any git host (`git:<host>/<owner>/pi-foreman`, https),
  not only github.com. `design/architecture.md` §11 describes the package install path.
- README quick start is the package install plus `/foreman setup`; `docs/install.md` covers update (`pi update`),
  remove, developing and Windows notes. The update-check footer says to update the package and run `foreman setup`.
- `docs/overlays.md` no longer promises `foreman:*` role and ledger events; only `foreman:ready` is emitted.
- `trace.enabled` defaults to `null` (was `false`): the trace follows the effective `retro.enabled` (on in tui and rpc,
  off in json and print). An explicit `false` still turns it off.
- `/sync` runs the retro before the repository commits; a `retro.repoBacklog` entry with `commit: true` is staged in the
  sync commit, one with `commit: false` goes to `.git/info/exclude`. `/foreman close` is the sub-orchestrator exit.
- The roles' output contract gains the `Friction:` line.
- Git config drift no longer asks for added or removed `branch.<name>.remote` / `branch.<name>.merge` keys
  (`git worktree add -b`, `git push -u`, `git checkout -b`); a changed value still asks.
- `foreman radar`: header with colored non-zero counts and a right-aligned clock, a totals line (sessions, trees,
  tokens, cost, oldest block), blocked ages amber over 5 min and red over 15 min, blue cost, dim ids, tokens and tree
  lines; footer `q quit · r refresh · c cost on/off · ↑↓ select · enter show session path` with those keys live.
  16-color ANSI only; `--no-color`, `NO_COLOR`, `--once` and non-TTY output stay plain.
- Bench: both in-container npm installs retry up to 3 times, 20 s apart.
- The README moved into `docs/`; the README is now an overview with a table of pages.
- A rung's configured `thinking` (or model suffix) now wins over the foreman's passed level; only a rung without
  one takes the foreman's level.
- Bench rows without `review_model` no longer default the auto-review to the reviewer's model.
- Foreman tier in the bench is taken from the foreman's own trace only.
- Pure-ledger shell commands no longer count against the read and recheck budgets (helper on).
- Foreman read budget before the first launch is now warn 4 / deny 8 (was 6/12); the deny text
  points at the explorer and `/foreman budget lift`. The old values are restorable from the user layer only.
- Pi 1.1.0 (range 1.1.x): pins in `packages.lock.json`, `package.json`, CI, bench and the replay driver;
  suites re-run on 1.1.0. pi-subagents 0.75.0, pi-permission-system 39.0.2 and pi-intercom 0.16.1 held.
- Bench: pi-claude-bridge 0.9.2 (forwards Pi's custom prompt sections, so the foreman rules reach bridge
  models) with claude-agent-sdk 0.3.293.

### Removed
- Runtime on-find reviewer climb: `ladder.reviewerClimb.mode` and `rungs` (a stale key gets the unknown-key warning),
  traces `climb_done` and `rung_up {reason: on_find}`. The bench climb policy (`foreman bench review --mode climb`)
  stays, as offline exploration.

### Fixed
- Bench waiter: generate-subagents and permissions_gen failures now report the return code, stdout and stderr tails.
- Harness-friction round:
  - (14) Read-only bash naming protected files is no longer write-protected, but only for a minimal reader set
    (`cat head tail wc grep egrep fgrep rg ls stat file diff cmp md5sum sha1sum sha256sum shasum`, and `cd`), no write redirect
    at all and no `$`, `${` or backtick in any argument (a variable could supply an option or script); sed, awk/gawk,
    sort, uniq, less, find, xargs, tee, interpreters and every other verb keep full protection on protected operands, whatever their flags; `--flag=value`
    and grep patterns are not paths; `cd` is allowed inside the workspace root and the child's scratch dir.
  - (17) Foreman reads of its own config no longer raise the protected-config dialog. Heredoc part not done: bodies are
    scanned as before; four reviews showed no safe reader-only skip (design in the round's result).
  - (19) Documented limit: stale needs-attention notices cannot be withdrawn (Pi has no pre-turn hook for queued
    custom messages); the needed upstream change is described in `docs/safety.md`.
  - (22) Documented limit: a session pattern grant on a not-yet-existing dir does not cover a later `cd <dir>`
    (permission-system `deriveApprovalPatterns`); workaround in `docs/permissions.md`.
  - (27) Procedure note: handoff-dir `plan.md`/`result.md` are written in full, fallback `cp`.
  - (28) Known issue: a ruling appended to an approved plan changes its hash and forces a re-review; the cap should
    count hash re-reviews, or decision appends must keep the verdict.
- `tool_pack` is no longer counted for calls the git-config drift preflight blocked.
- Review bench: removes each cell's work dir once the cell is recorded and the whole `pf-rb-work/<hash>` dir after a run
  (kept on interrupt, with `--keep-work`, or for a user work path), so a run no longer leaves tens of GB of clones;
  Policies rows with missing or failed cells are marked `(partial: k/n cells)`.
- Tests no longer write fixture retro backlog entries into the real `~/.pi/agent`: `tests/_isolation.py` points `PI_CODING_AGENT_DIR` at a per-run temp dir, plus a regression test.
- Herdr sidebar (`docs/herdr.md`): the daemon spawns radar through the posix_spawn path before its event thread starts
  (no fork of a threaded process), restarts a radar child that prints no line for three intervals (stack dump in the
  log), dumps its stacks on `SIGUSR1` and logs the first radar line and each change of the joined pane count with a
  reason. One state folder whoever starts it (`HERDR_PLUGIN_STATE_DIR`, else Herdr's plugin state path when present,
  else the temp folder); `status` prints it. `run --once` reports with a 60 s TTL and prints `ok`/`error` per pane;
  `run --dry-run` only composes. `fm_pre` is gone: the tree prefix starts `fm_l1`, `fm_sym` is the bare glyph (the
  rows snippet changed; shutdown also clears an old `fm_pre`). Width follows Herdr: default 26, ` · ` (3 columns)
  between cells, one leading user cell reserved (`--lead-cells`, `HERDR_SIDEBAR_LEAD`), line 1 two columns short of
  its budget and cut in the label, never the age.
- Children widget: the TUI view no longer jumps while children run. The widget keeps its height during a batch (rows
  reserved, finished runs fold into one `<n> done` line, lines cut to one row each, same component updated in place)
  and clears when the last active run ends; unchanged content makes no UI call (`childwidget.ts`).
- Radar presence: pi-foreman's own asks (git/claude config drift, protect, checkpoint) hold the session `blocked`
  directly, also without `HERDR_ENV`; Pi suppresses `ui_prompt_start` while an earlier dialog is unsettled. Blocking
  sources are counted, so a Pi dialog's end or typed input no longer clears an open own ask (`livestate.ts`, `herdr.ts`).
- Reviewer PASS marks: `N. PASS` lines are recognised with decoration (`` `1. PASS` ``, `**1. PASS**`, `1) PASS`,
  `- 1. PASS`, the doubled "1. `1. PASS`"); `PASSED` in prose, fenced blocks and `10. PASS` for item 1 stay out.
- Triage: `release` is a heavy signal only when the prompt also names a version, changelog or manifest bump; a slash
  command prompt (`/retro`, `/sync`) gets no signals or `triage_hint`.
- Explorer brief: the harness writes the full report to `explorer-brief.md` in a session scratch dir every child may
  read without an ask; the task keeps the first 8000 characters and, when cut, a `[full brief at <path>]` marker;
  `explorer_brief` records `action: file|none`.
- Ladder: a climb starts from the role's live rung (its latest launch on any path: single, tasks, chain, parallel)
  instead of the bottom rung, so a review FAIL after a context climb no longer emits a stale second `rung_up` from the
  bottom; on the top rung the trace records `rung_top {role, model, reason}` and the finish gate uses the two-refusal
  valve without the `climb_available` refusal.
- Git drift: git's own worktree bookkeeping (`commondir`, `gitdir` and worktree `.git` files appearing or vanishing
  on `git worktree add/remove`) no longer reports; a worktree whose `commondir` or `.git` file points elsewhere does
  (`worktree-link:<n>`), and all per-worktree changes collapse into one `worktrees: N changed (...)` line.
- Write protection matched grep patterns and other string operands (`register\b` expanded to `.git/...`): it now
  checks shell path arguments only; grep/rg patterns, sed/awk scripts, find `-name` values and echo/printf text are
  skipped on read and filter lines, bash `*` skips dot entries and `\` is no separator outside Windows.
- Bench post-step waiter passed `1.0` (an epoch) to `PiRpc._next` instead of an absolute deadline, so it never read a
  record and ran every post step to the 300 s cap; it now warns on stderr when the cap is hit.
- `/sync --dry-run` ignored its arguments and ran a real sync; the flag now reaches `foreman_sync.py` (other arguments warn).
- Bench `autoreview_defer_share` counts model defers over model calls only (deterministic labels excluded);
  the `autoreview_usd~est` column is marked as an estimate (the bridge reports no usage for review calls).
- `/retro` cost: bridge usage lines log cost 0; the handler passes the Pi registry rates (`--rates` file) and
  `foreman_retro.py` prices those lines from tokens (also in `/foreman close` and `/sync`).
- diffscan attributed a changed unexported symbol to the first test file containing the word anywhere in the repo;
  it now needs a call-shaped match, same package for unexported Go symbols, nearest path first.
  `review_facts.count` is the number of facts (was the number of reviewer steps).
- Forwarded child asks reached auto-review as the offending unit only (a bare `python3`); the model and the
  `review_defer_headless` trace now get the full command.
- Explorer brief cap 4000 -> 8000 characters (7 of 8 bench briefs were cut); `explorer_brief` records `cut`.
- Deterministic auto-review allows (sed-read, timeout-wrapper, tmp-scratch) checked only the forwarded unit, so a
  chained command (`... && rm -rf src`) passed without a model; the full command must now pass as well.
- Child test restore refuses git global options (`-C`, `--git-dir`, `--work-tree`, `-c`, ...), `GIT_*` variables,
  wrappers and other repositories, and is allowed only as one plain `git restore`/`git checkout --` command
  (decided on structure: no chain, nesting, assignment, expansion or redirect); the no-rulings rule in foreman.md renders with the ladder off too (`factRulings`).
- The model review of an ask forwarded from a child saw an empty value: PS 39.0.2 puts the child's command in `value`,
  not `command`. That is why most child bash asks were deferred (and then denied headless).
- Child sessions mislabelled the tier (they emitted `tier` events with their own default); only the foreman does now.
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
