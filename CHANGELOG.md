# Changelog

## [Unreleased]

### Round 38
- `foreman session open` takes `--first-command /CMD` (repeatable, at most 4) and `--plan-mode` (= `--first-command /plan`): the commands become positional messages before the brief prompt in the launch line (POSIX, PowerShell, fallback, dry run, `launch.txt`), and the registry entry records `firstCommands`. Without the flags the launch line is unchanged. `/foreman session open` parses and forwards both.
- New foreman-only tool `foreman_session_open` runs the same open (validation, rank rule, opener id); refused in subagent children. `planMode` without a `plan` command in the opener's commands is refused with `session open refused [plan_mode_unavailable]`. instructions/foreman.md: design or new-topic sessions open in plan mode, sessions with an approved plan without. See docs/sessions.md.
### Round 31a
- Herdr sidebar: one row per pane. `join()` gives a pane to one session by a total order (fresh heartbeat before stale, live before done, the pane's foreground pid, youngest, session id), not by walk order, so a stale or finished presence record (an ended session, a reused pid) no longer alternates with the live one. The daemon publishes the winners (`winners.json` in its state dir) and `push` skips a pane another session won; `dedupe_panes` uses the same rank. Test rigs no longer inherit `HERDR_*` (the `test:node` preload, `_r11rig`, the replay driver and the review-bench child env), so they leave no presence file naming the runner's pane. Tests: `test_herdr_sidebar_winner`, `r31a-rig-herdr-scrub`.
- Pressure gate: `loadPerCore` is the 5-minute load average; the 1-minute value is `load1PerCore` in the host record and the doctor line (`load5/core=... load1/core=...`), informational only. Thresholds and keys are unchanged. docs/resources.md. Tests: `test_pressure`, `pressure-surfaces`.

### Round 30
- The children widget shows the foreman's background rows after the active runs: a pending `foreman_wait` as `wait · note · age`, an active `pr_watch` as `pr #n · until · age` and a running `foreman_bg` command as `bg · note · age`. They show with or without child runs; the widget hides only when all are empty. Rows follow the same height rules (padding, at most 8 rows, a `+<n> more` fold), and `widget.children` off hides them too; no new key. Tests: `r30-widget-background`. See docs/sessions.md.

### Round 29
- A child's read-only shell unit that names a protected file passes the write protection (strict git read allowlist and plain readers only); an env prefix, wrapper, loop or assignment anywhere in the line ends the read and the file stays protected; docs/safety.md says the rule is no sandbox. Test: `r29-protected-read-only`.
- The PR gate accepts a reviewed head that is the commit of the branch the PR opens from, of its `origin/<branch>` ref, of its upstream or of HEAD (the reviewed PASS sha, not only the local branch ref); the stale refusal names the PASS sha and the resolved head sha. Python (`git_guard.py`) and TS (`reviews.ts`) agree. Test: `reviews.test.ts`, `test_git_guard_pr_gate.py`.
- A `subagent_supervisor_request` of a run that ended (or is not live in this session) opens no window (trace `supervisor_request` `decision: stale`); an errored `subagent_supervisor` reply to a request of a dead run closes it (`decision: closed_dead_run`). Test: `r29-supervisor-stale`.
- Child launches return at once with the receipt plus a detached-launch line; the completion notice starts the next foreman turn. `ceremony.launchWait` defaults to `detach` (`block` stays for replay rigs and bench); the foreman rules and docs/ceremony.md say launch, end the turn, act on the notice. Tests: `r29-async-launch`, `launchwait`.
- The foreman may move its checkout by branch only: `git switch <b>`, `git checkout <b>`, `git switch -C <b> <ref>` and `git reset --hard <ref>` pass the shell-write guard when the tree has no tracked change and HEAD is contained in `<ref>` or in a pushed branch (the `foreman_worktree_remove` preconditions); a refusal names the failed precondition. Paths, chains and `-f` stay refused; children get no branch move. Tests: `r29-branch-moves`, `shellwriteguard`.
- `npm run test:ci` (`scripts/foreman_ci.mjs`) runs the pre-PR checks that `npm test` does not: the replay suite on the `node_modules` Pi CLI, `pull_core.py --conformance` (skips when pytest is missing), the installer suite, and the bench detach probe on the fake provider (skips when `harbor` is not on PATH). `--only <step>` runs one step. Documented in docs/development.md and docs/ceremony.md (round flow).

### Round 27
- A child's shell-write deny covers in-place interpreter edits (`perl -pi`/`-i`, `ruby -i`, `python -c` writing files, `node -e` with `writeFileSync`/`writeFile(`, `awk -i inplace`) with the existing "use the write or edit tool" text; reads stay allowed (6aea5be). Test: `r27-child-inplace`.
- `occasionOf` counts `[second-opinion]`, `[plan-review]` and `[pre-pr]` only as standalone tokens (not in backticks, fences or `[pi-foreman` lines); the reviewer `role_launch` trace carries `occasion`; the `mark V` refusal and the revision hint name the last counted PASS run (e5a658f). Test: `r27-occasion-tags`.
- The reviewer launch result adds an `occasion: ...` line for a non-item occasion (16d9524). Test: `r27-occasion-launch-line`.
- The reviewer diff-scan base resets when the session writes a new ledger. Test: `r27-diff-base-ledger`.

### Round 26
- A subagent wake that only carries "needs attention" notices for runs that already ended is dropped before it starts a foreman turn (trace `notify_deduped {reason: "run_ended"}`); a notice for a live run passes. Test: `r26-stale-attention`.
- A `reviewer` launched after a FAIL gets the first line `[pi-foreman re-review] Review the revision diff since <sha> ...` (targeted tests only, no tsc or full suites); `[plan-review]`, `[pre-pr]` and `[second-opinion]` tasks get none. It follows the last FAIL in the session until a PASS or an owner prompt. Test: `r26-rereview-line`.
- A child's write-protection deny on a protected (write-ask) path says the foreman stages and commits that file, and every builder brief carries a `Protected files (...)` line. Test: `r26-protected-hint`.
- The spawn-length ledger guard measures the caller's task before any harness prepend (re-review line, ledger items), so a re-review no longer trips the 1 500-character limit. Test: `r26-guard-caller-task`.

### Round 25
- A forwarded child ask that the review would defer is denied with a reason naming the allowed shapes instead of parking on the owner pane, where it blocked every later forwarded ask (the parent drains them serially). `review.childDefer` (`deny` default, `owner` = old behaviour); trace `review_defer_child {decision, role, cmd}`. The foreman's own asks still defer.
- Deterministic allow (`effect-build-test`) for `node --test <contained files>`, `npx tsc --noEmit [-p <contained>]` and `python3 [-I|-B|-u] -m unittest discover ...`; a contained `cd` is a neutral chain prefix. A `cd` outside the worktree or an output redirect still asks. See docs/permissions.md, docs/safety.md.

### Round 24
- The SECURITY exemption of a reviewer FAIL is read from the full report at the run end, so a `SECURITY:` line past the notice's 2 000-character cap still exempts the revision (trace `security_exempt`); the notice text stays the fallback. Residual: a notice that arrives before its run-end event uses the notice text only.
- Revision chains reset on every owner-typed prompt, including an extension-sourced one such as `[continue]`, but not on harness texts (`pi-foreman ...`, the subagent and intercom wakes, `Background task ...`); trace `chain_clear`.
- Ledger binding: only a `write` (or Write) of a ledger rebinds a session that has a live bound ledger; an `edit` or shell `ledger -f` of another ledger, such as ticking `LEDGER-todo.md`, keeps it. The rule is enforced by the adapter (`extensions/core-adapter/index.ts`), not the core: the core's `ledger_bind.py` rebinds on every write and edit (re-vendored at c9522fb in R28). Test: `r28-ledger-bind-adapter`. See docs/ceremony.md.

### Round 23
- A launch's `timeoutMs` (or `maxRuntimeMs`) now wins over the role's `timeoutMinutes` in both directions; every written deadline is capped at `ceremony.launchTimeoutCapMinutes` (default 120, the only hard ceiling), and a launch value above the cap is traced as `launch_timeout {role, requested_ms, written_ms, reason: cap}`. See docs/roles.md.

### Round 22
- docs/close.md says where a removed child worktree's changes land: pi-subagents captures a patch under the launch's result dir (`worktree-diffs/step-N`) before it removes the worktree, so a turn-capped or timed-out builder's uncommitted work is recoverable from there; builders commit only when their brief says so.

### Round 21
- A child's session footer says that on `Session not found` it must not retry intercom and uses the handoff files (`ask.md`, `ruling-<n>.md`) instead; docs/sessions.md notes the parent-id path works only for a Pi parent.
- A child's exact `npm ci` runs unasked in a pi-subagents managed worktree (`pi-worktree-*`) as well as a round worktree (trace `overlay_allow{rule: npm-ci-worktree}`); flags, other cwds and the parent checkout still ask, win32 too. Residual: a forwarded ask is still judged with the foreman's cwd. See docs/permissions.md.
- docs/permissions.md explains the ask dialog keys: `y` twice to approve under the default `doublePressToConfirm`, and the settings that change it.

### Round 20
- A session that changed nothing finishes without a refusal: no completed builder run, no foreman project-file edit and an empty `git status --porcelain` (trace `ceremony_gate {reason: no_change}`, an info notice). A heavy session with a rejected plan still blocks; a dirty tree or a git failure keeps the refusal.

### Round 19
- Own CLI allow: the foreman's one simple `<root>/bin/foreman` command with verbs `session open|brief|list`, `dialogs` or `findings list` is allowed without the auto reviewer (trace `overlay_allow{rule: own_cli}`); all other verbs take the normal path. Residual: `session open --cwd/--agent-dir` accepts any path. See docs/permissions.md.
- A reviewer or senior-reviewer PASS on a plan review no longer starts the post-PASS recheck window, so the foreman keeps its normal read budget.

### Round 18
- A child's overlay ask (kind ask, not a self-modification) now goes to the auto reviewer too, headless included; the prompt says `requester: subagent <role>`. An allow traces `auto_review_allow` with the child role, a high or critical deny blocks, a defer keeps the child block "ask the foreman", and deny decisions never reach the reviewer.
- A parent-written `ruling-<n>.md` or `brief-<x>.md` in the session's handoff dir now also resets the review cap, the post-PASS recheck budget and the foreman read budget (trace `cap_reset`); a new owner prompt still does. Strict check: regular file, ctime and mtime newer than the last reset, not self-written.
- `foreman_dialogs` / `/foreman dialogs --json` count every blocking surface as a family (`permission_prompt`, `child_dialogs`, `checkpoint`, `ask_user_question`, `guard_ask`, `drift_ask`, plus the overlay families and `trace_read`) and add a `total`; `self_ruling_refusal` and `auto_review_allow` are listed but not summed.
- `foreman setup` runs `npm ci` when `package-lock.json` is newer than the installed `node_modules`, so a stale install is refreshed instead of reused.
- Mutation tests confined to the session's scratch dir (`$FOREMAN_SCRATCH`) are allowed in the overlay; mutation of anything outside it stays an ask.

### Round 15
- `roles.<id>.skills` names the skills a child role gets, as catalog entries; `inheritSkills` stays off. User or overlay config only. A child's shell read of a skill its role names passes (per role; the `read` tool sees the union), `foreman setup` re-renders the read keys, and extra `SKILL.md` frontmatter keys are tolerated by Pi and pi-subagents (tests). Residual: package skills under `{agentDir}/npm/node_modules` and settings `skills` paths still ask.
- `roles.<id>.mcp` (`server` or `server/tool`) maps onto `mcp:<entry>` tools for child roles; user or overlay config only. Errors where the role's `denyTools` deny the server's tools, and for `foreman` and `session-foreman`. The deny check normalises the tool part like Pi.
- New generic skill `skills/skill-authoring`, listed in package.json `pi.skills`, with a Pi section (role skills, placement and precedence, loader keys, trigger-test recipe).
- Docs: `## Skills and MCP per role` in docs/roles.md; feature rows for `roles.<x>.mcp`.
- Read keys: `foreman setup` renders read grants for Pi install releases, the subagent run root and `readRoots` (the Python renderer follows the TS `readRootsOf` rules). See docs/permissions.md.
- Checkpoint verdict: a verdict file written by the parent (`ruling-plan.md`) decides `foreman_checkpoint`, bound to the plan's ctime; a parent `ruling.md` APPROVED counts in parent mode. The node tests are hermetic against ambient session env.

### Round 17
- A write into the session's own `{cwd}/.pi/scratch/` is no longer self-modification (`selfMod`) in the overlay: a shell write or a path-tool write there stays an ordinary ask and goes to the auto reviewer instead of the human dialog. See docs/permissions.md "Two layers".
- `foreman doctor` prints an `autoReview:` line: `on|off (rulesFile: shipped or the path, model: <provider/model> or none)`.

### Round 16
- Auto reviewer for overlay asks: a foreman overlay ask that is no self-modification goes to the `foreman-review` authorizer before the human dialog (`safety.permissions.autoReview.enabled`, default on). An allow lets the call go on; a deny with riskLevel high or critical is a block; a soft deny, defer, error, timeout or missing model is the dialog. Trace event `auto_review_allow`; `foreman_dialogs` counts it as its own family. See docs/permissions.md "Two layers".
- The reviewer rules are prose in `config/permissions.rules.md` (tiers hard_deny, soft_deny, allow, plus an environment paragraph); `safety.permissions.autoReview.rulesFile` (user layer or overlay) replaces the file. The file is protected under `writeAskSelfHost`.
- Removals: `scripts/shell_facts.py` is deleted (872 lines to 0); `ruling.ts` shrinks from 280 to 196 lines and keeps the plain literal-path deny of a session's own parent ruling plus one flat ask trigger; `permoverlay.ts` drops the USAGE_VERBS chain and the python/node usage-read forms (`ownRead` is `ownStateRead` alone), net +19 lines for the whole file because of the reviewer wiring. Self-modification asks and the deterministic floor stay as before.
- `ask_user_question({questions})`, a foreman-only tool: 1 to 4 questions with 2 to 4 options and free text, raised in the pane; without a UI it points at the `ask.md` file path.
- `review.critic` (list, default four questions on leanness and the right layer, real friction, dispensable code, direction) is rendered into every reviewer and senior-reviewer task with the instruction to answer `CRITIC: <item> Q<k>: <answer>` once per ledger item; the harness does not parse the lines. An empty list renders no block.
- `foreman_dialogs` families: `self_ruling_refusal` (refusal text and the blocked `self_ruling` guard record), `trace_read` (checked before `state_usage_read`), `async-subagent-results` joins `own_run_dir`, `auto_review_allow`.
- Docs: new "Two layers" section in docs/permissions.md; the `writeAskSelfHost` list names `config/permissions.rules.md`; feature rows for the auto reviewer, the rules file and the critic.

### Round 14
- Own-state reads have one source of truth: `ownStateRead` decides for the overlay and the review link alike. Reads of the session's own trace file, its own bg_run outputs (which join the own-read set; the `foreman_wait` log is bounded) and a `.workflow/scratch/` script or a `cd <worktree> &&` prefix pass for the foreman.
- Child message-file input: a child's `git commit -F` message file lies only under `<worktree>/.workflow/scratch/` or its own `$FOREMAN_SCRATCH`; `.pi/` is refused, a white-space `FOREMAN_SCRATCH` is unresolvable and denied, and an inline `FOREMAN_SCRATCH=` never counts. The message-file exemption lifts only the write protection of `git commit -F`; a child `git tag -F` under a protect rule is denied with its own reason. A zsh `=word` message file is refused by the git guard.
- Residual shell-facts rows (`scripts/shell_facts.py`): awk run-time redirect targets and `| getline` / `|&` / `system()` are computed writes; xargs into an unknown program is a link maker; sed `e`/`w`/`W` are judged by command; zsh `=word` message files; anchored ruling-name basenames; a `cp` source is a read; the `cp` target shortcut is reverted by owner ruling 7 (a `cp` of a ruling out of a handoff dir stays refused; `foreman_copy` is the path); a copier backup suffix (`-S`/`--suffix`) is an option value and writes an unknown name next to its target; recursive and `-a` copies, rsync and script files count as link makers. A `cp` into a target that is no directory is refused again.
- `foreman_dialogs({trace?})` tool and the `foreman dialogs <trace>` CLI (`bin/foreman`, `.cmd`, `.ps1`; one implementation through `node --experimental-strip-types`, needs Node 22.6+) return the JSON of `/foreman dialogs --json`. A session's own async run results (`async-subagent-results/<run>.json`) join the read-only verbs and inline reads; another session's run id still asks.
- Reviewer and finalizer `bg_run`, `bg_status` and `bg_logs` tools: reverted (owner ruling 10). pi-subagents refuses to start a child that names an unavailable tool, so without the pi-background-tasks add-on every reviewer launch failed with no verdict; the tools need conditional wiring.
- Reload-safe round state: a round session keeps `<handoff>/round-state.json` (topic, plan hash, plan-review verdict and round count, review counters, revision rounds per chain). It never keeps an approval: the checkpoint approval comes back only from the parent's `ruling.md` (not `ruling-<n>.md`) that is newer than both the plan and the handoff plan.
- `foreman doctor` prints a `providers:` line (the providers the model registry holds in the session); the opened-session docs note the `/reload` workaround for a missing `claude-bridge`.

### Round 13
- Self-ruling guard reads lexed write surfaces through the new `scripts/shell_facts.py`, built on the git_guard Lexer; it fails closed and matches `ruling*.md` only, never `*.ack`. Computed scripts, sed `e`/`w`/`W`, find actions and computed program names count as computed writes.
- Child `git commit -F` allowlist: an optional `cd`, then `git add`/`status`/`diff --cached`, then one commit. Glob and `~` message paths are denied, and `--amend --no-edit` has its own deny reason; `message_file_clobbered` is now used only on the foreman's path.
- Revision rounds are keyed per review chain. A parent ruling line `revision-round: +1` resets a chain once, and only when the ruling is newer than the refusal; the refusal names the chain and both reset paths.
- The foreman's own async run ids are recorded at launch; `$TMPDIR` run-log reads are allowed for read-only verbs.
- Pi's truncated bash output log (`details.fullOutputPath`) is readable by its own session for read-only verbs. New dialogs family `own bash output log`; `cut` is now a read verb.
- Tests: `waitQuiet` is shared in `test/_tmpbase.ts`, and tests shut the adapter down before removing temp dirs.
- R12 leftovers: stale comments fixed, the `REPEAT_STOP_REASONS` docs row added, `HUB_ROOT_FIX` referenced from the test, and the permissions renderer refusal prints one line and exits 2.
- Windows (win32) fixes: `shell_facts` keeps a posix-rooted bash target (`/h/r`, `cd /h`) posix instead of joining it onto the native cwd (5b9fb50); the R13 adapter tests write native paths into bash lines with forward slashes (7343076); a native backslash drive word is also a write candidate in its native spelling, and read roots match 8.3 short spellings (247d8c5); the self-ruling suites use forward slashes in bash lines, and the launch trace test pins pressure off (0b0530f).

### Round 12
- Commit-message lint is uniform for foreman and children; the cd guard tracks only top-level `cd` and never reads message text; an unreadable message is a child deny; `-F -` with a literal heredoc is linted on its body.
- Own `state/usage` and live-session files stay readable by read-only verbs ahead of the protected-config write rule; writes stay protected.
- A same-line function or alias named `python3`/`node` no longer hides its `-c` body from the HOME-binding and guarded-literal checks.
- A second identical probe-class deny in one child run stops the run (`child_repeat_refusal`); other deny reasons never stop it.
- A newer `ruling-*.md` is picked up before any launch or checkpoint press; `ruling-<name>.ack` records it.
- `foreman doctor` warns on a `paths.hubWorkflow` ending in `.workflow`; setup refuses a doubled `.workflow/.workflow`.
- `/foreman dialogs --json` counts per regression family from the trace.
- `recheck_budget_exceeded` names the real review verdict; reads of the foreman session's own bg_run outputs skip the recheck budget.
- A stale "tool open" notice stops once the run's exit is recorded.
- `foreman_copy` accepts the foreman's own session handoff dir as source.

### Round 11
- Ladder: a `review_fail` climb targets the higher of the launch model and the strong rung by provider rank; a model above the strong rung stays, trace reason `already above strong rung`.
- A child stopped by a permission-policy block is never climb-eligible or relaunched; trace `child_policy_block` is the stop record.
- `foreman doctor` and `setup` report hub-ledger drift (WARN or INFO); see the new section in `docs/permissions.md`.
- Plan reviews and fix-round reviews have separate counters; the `review_cap` text names the owner prompt as the reset.
- Finalization read-budget exemption: it follows harness state and is aware of pending launches.
- `/foreman cost --json`.
- The cd guard skips literal commit-message values (`-m`/`--message`); a message the shell may expand is still scanned.
- The HOME-binding check ignores a plain `python -c` / `node -e` body in that command's own unit.
- A child may run `npm ci` in the foreman's `bench/pi-lock`.
- Presence states with icons (see `docs/herdr.md`).

### Round 10, permission overlay
- Toolchain probes: the baseline gets `externalDirectory.probe` (`/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin`, `~/.npm/_npx`, `~/.npm-global/bin`, `%APPDATA%/npm` on Windows), rendered as `external_directory_read` keys (dir and `dir/*`). The overlay narrows them: a plain `ls`/`stat`/`which` line and the `ls` tool pass, any other command, pipe, redirect or substitution naming them asks (a child: deny). The rendered policy changes: `/foreman doctor` reports drift until you run `foreman setup` again.
- Hub ledger read: after setting or changing `paths.hubWorkflow`, or after this release, re-run `foreman setup` to re-render the hub read keys (the realpath spelling of a symlinked hub dir is now rendered too).
- The foreman reads its own state and usage files, and `.pi/scratch` is readable.
- Quoted `git log -S/-G/--grep` values are no longer overlay path candidates; the production prompt still needs an upstream permission-system change.
- A child may run `npm ci` and `npm install --package-lock-only` in its own worktree subdirectories.
- Self-ruling narrowing was attempted and reverted; its fixtures are kept.
- Windows replay expectations are recorded for the round.
- The bench rig pins Pi 1.3.0 and `bench/pi-lock` is regenerated.

### Pi 1.4.0
- Pi 1.4.0 supported (range 1.4.x); no extension-surface change for this harness. Pi 1.4 stacks concurrent extension dialogs; the pi-permission-system forwarded-ask inbox is still serial upstream, so `review.childDefer` keeps its `deny` default. The herdr blocked counter is unchanged (it stays balanced under stacking). The bench rig pins Pi 1.4.0 and `bench/pi-lock` is regenerated.

### Pi 1.3.0
- Pi 1.3.0 supported (range 1.3.x); no extension-surface change. Pi's `--model` ambiguity fix prefers the provider with credentials.

### Pi 1.2.0 and the background-tasks add-on
- Pi 1.2.0 supported (range 1.2.x).
- `foreman doctor` prints an info line with pi-background-tasks' declared peer range for `@earendil-works/pi-coding-agent` against the running Pi version (never a failure; no line without the add-on).
- `foreman session open` passes the opener's `PI_BG_FEATURES` and every other `PI_BG_*` variable into the child's launch line and writes that line to `<handoff>/launch.txt`; `foreman doctor` prints the effective `PI_BG_FEATURES` and warns when `attribution` is on while the `anthropic` credential is not OAuth.

### pressure gate + permission-grammar hardening
- `resources.*` keys (`maxLoadPerCore` 1.5, `minFreeMemMB` 1024, `minFreeDiskGB` 5, `sampleSeconds` 30; a project may only tighten) and a stdlib sampler `scripts/foreman_pressure.py`. At `high` child launches run one at a time and the strong climb pauses; at `critical` launches are deferred behind a `pressure` wait (10 minutes at most). Surfaces: `foreman doctor` pressure line, `/foreman status`, a ` ⚠ <reasons>` suffix on the Herdr cost row only when not `ok`, retro line `pressure: deferred N, narrowed M` (omitted when both are 0). Trace events `launch_narrowed`, `launch_deferred`, `climb_suppressed`. See `docs/resources.md`.
- Guard: in the main session `git -c` with an exec key or a shell alias (`-c alias.x=!…`) is denied; a `PATH=` prefix before git asks; a child's file writes from a heredoc or stdin script (`python3 - <<…`, `echo … | python3 -`) are denied.
- Read-only shell: fewer false positives for pure reads, the session's owned roots are readable, and every deny trace carries its reason.
- Ceremony: the last review verdict wins, `steer.md` is read at wake, an open ask is shown, and the launch trace names the model.
- Read-only python is allowlisted and its filter fails closed; owned reads are scoped to the owned roots; the `~/` and `$S` path grammar resolves once for all target sets.
- `$HOME` and `$S` count as trusted only while the command leaves them unbound; one resolution serves every target set.
- `boundNames`: every standalone name token binds (`read N<f`, `N<<<x`, `mapfile -t N<f`), and `eval`, `source` and `.` bind every trusted name.
- PowerShell env forms (`Set-Item`/`New-Item env:`, `${env:N}=`, `SetEnvironmentVariable`) bind case-insensitively; the `$env:` home mapping applies only behind the bound check.
- Literal tests per binding form, including the PowerShell env forms, the R5 regressions and the `HOMEDIR=`/`$HOME_OLD` negatives.

### Round 6, by lane
- 1a: a read-only child's test run names only operands (`node --test <p>`, `npm run test:x -- <p>`, `pytest <p>`, `python3 -m pytest|unittest <p>`, `make test -C <p>`, values of `--require`/`--import`) that resolve inside the round worktree and are git-tracked; globs (all matches tracked), `$VAR` words (expanded, else denied) and untracked paths are denied with a reason; a builder still runs its own new untracked test. Operands fail closed: every word with a `/`, a file suffix or an existing file name is checked; only `make` options on an allowlist pass. Tests: `probescan.test.ts`.
- 1b: `git config` is a read only in its read forms (`<key>`, `get`/`list`, `--get*`, `--list`); every other form, also `--global`/`--system`, is denied for a read-only child from any cwd.
- 1c: the git guard denies, for a child, fragments joined by `+`, `..`, `concat`, `join` or `replaceAll` that reassemble a guarded command token (rm, dd, git, cd, truncate, mkfs, shred, push --force, reset --hard, checkout --): `split literal reassembles a guarded token`. Parity fixture `tests/fixtures/split-literal-cases.json`.
- 1d: a script run by `node`/`python`/`python3`/`bash`/`sh`/`npx` from outside git (scratch, tmp, untracked) is read and scanned by any child role before it runs (reassembled fragments, `String.fromCharCode`, base64 literals); a hit is denied. Every word of the command that is an existing file outside git is read; an untracked directory operand is denied.
- 1e: the role prompts (`builder`, `reviewer`, `senior-reviewer`, `explorer`, `finalizer`) forbid split, concatenated or encoded guarded tokens in a bash line or probe file; probes run through the test suite's fixtures.
- 2-0, 2-I: a directory operand of a test run inside the round roots is scanned file by file; the innermost git worktree of the cwd owns its writes (an isolation worktree nested below a round worktree is its own root).
- 2a: the permission reviewer's prompt lists the roots the session owns (read-write: child scratch, round and isolation worktrees (builder only for children), handoff dirs, `state/scratch/<session>`; read only: the npm root and the async run dirs of its own child runs, which never count for writes) as "owned: allow reads and writes" / "owned, read only"; a model defer for a command whose every path stays inside them becomes an allow (`owned-roots`), a deny never does; `/tmp` is not an owned root.
- 2b, 2c: a catch-all `*` path rule matches path operands only (not prose or a sed expression) and never denies a read below an owned root (a write target or a `write`/`edit` path with white space in it is still matched); `../x` after `cd <dir> &&` resolves from the cd'd directory; `sed` that provably only reads is a protected reader (inline python never is).
- 2d: reads of the state dir lose the protected-configuration ask, writes keep it.
- 2e: `git apply <patch>` and `patch -p1 < <patch>` are a read of the patch plus a write of the cwd worktree: no ask in an owned worktree, closed elsewhere and for read-only children.
- 2f: the bound round ledger, its `LEDGER-*.md` siblings, the session's own handoff dirs and round worktrees are readable for every child; writes stay closed.
- 2g: the review link answers per foreman session, so its allow holds for every fresh reviewer child. The permission system's own "approve for this session" grant is subagent-scoped by default and not controlled by the adapter (docs/permissions.md).
- 3a: `bench/prices.json` moved to `config/prices.json`; a usage record with `cost.total` 0 is priced from the registry rate, else the table (Haiku 5.5 long-context tier per request), marked estimated.
- 3b, 3d: per-run priced cost in presence `runs[].cost`; the status line shows the summed estimate (`all $X est (runs $Y)`); `/foreman cost` lists every role with priced totals (`~` = estimated); the summed estimate is read from the usage file.
- 3c: `ceremony.budgetUsd` (default unset) refuses a launch `[budget_exceeded]` on the summed estimate, warning at 80 %; a refused launch sets no warning.
- 3e: `ceremony.reviewRuns` (default 3) caps review runs per user prompt (`[review_cap]`); a re-review after FAIL gets `[re-review items: N, M]`; a refused launch uses no slot; panel shadows are rank-checked with the reviewer policy.
- 3f, 3g, 3h: `review_done` is traced at the run end of every review (shadows `kind: shadow`); the launch trace `role_result` is now `role_launched` and `role_result` is logged at the real run end; deny traces carry `reason`, `role` and `command` (TRACE_FIELDS gains `command`, kept only on denies, redacted: auth headers, `token=`/`key=`/`password=`/`secret=` values, URL userinfo, AKIA/ghp_/sk- keys, long base64/hex, home path).
- 4a, 4b: a `foreman_wait` file wait on `ruling-<n>.md` / `ruling.md` in an own handoff dir writes `.seen` itself when it wakes; the Herdr blocked state is recomputed from the files (`.ask` present and no `.seen` naming the ruling) on any `.seen` write, also by bash; a ruling older than `ask.md` is ignored and does not wake the wait. Both read only handoff dirs where this session is the `child`.
- 4c (narrowed by parent ruling 3): a parent ruling never satisfies the finish gate. The refusal names the ruling and `/ceremony <tier>`, the chair's override; `/foreman close` lists what the parent would have to rule. Defence in depth: a session cannot write its own parent's ruling (write, edit, `foreman_copy`/`foreman_move` destination and any non-read `bash`/`powershell`/`foreman_bg`/`bg_run` command naming `ruling*.md` in a handoff dir where it is the child are refused; reads and writes into dirs where it is the parent stay allowed).
- 4d (docs only; the yield is upstream in pi-subagents): `bg_wait` during a builder's supervisor ask is documented.
- 4e: `foreman_wait {kind: pid}` on a pid that `foreman_bg` already watches returns the existing wait id.
- 4f: integration test for ask, ruling, `.seen` and the finish gate (not a replay case).
- 5a: `reason` is documented as an extra top-level field of a strong launch (tested, schema unchanged).
- 5b: a revision answering a `SECURITY:` FAIL climbs under `strongOnRevision`; `revision_security_exempt` only lifts the cap.
- 5c: both `claude-bridge` presets put Sonnet 5.5 on the explorer, builder and reviewer bottom rung (Opus 5.5 strong; Haiku only as an explicit opt-in).
- 5d: an explicit launch `model: "claude-bridge/claude-sonnet-5-5"` was overwritten by the role map to the haiku bottom rung. An explicit `<provider>/<id>` model is now passed through when the rank policy allows it for the role; a model picked with `--model` at startup counts as user-picked and wins over the overlay foreman model. Tests in `r6-lane5.test.ts`.
- 5e: the explorer's default `strongAbove` is 200000.
- 5f: `ladder.maxTurns.<role>` (builder 100) with `childMaxTurns` as fallback and a `child_turn_limit {role, turns, limit}` trace event.
- 6a: `config/presets/inexpensive.json`, applied with `foreman config apply-preset inexpensive [--foreman <model>] [--dry-run]`; roles are named by rank tier and resolved from `providers.<p>.ranks`; `--dry-run` prints the role map. See `docs/presets.md`.
- 6b: `ladder.rolePolicy.<role>` overrides `ladder.childPolicy` per role (presets: reviewer and senior-reviewer `at-or-below`, builder `below`).
- 6c: `providers.<p>.cache.byModel` rows `{match, ttlSeconds, billing?}` layered over the provider cache policy (first match wins; request billing never keeps alive); the `claude-bridge` preset has ttl 600 s for `claude-*` and keep-alive off (the brief says keep-alive stays off; measured TTL is at least 10 min); `docs/cache.md` table per family.
- 6e: `docs/presets.md`.
- 7a: a pending `foreman_wait` / `foreman_bg` wait keeps the session state `working` (presence `waits[]` still lists the waits); Herdr and the sidebar show it as working.
- 7e: the Python and node test suites no longer depend on the caller's environment: `tests/_isolation.py` drops `GIT_CONFIG_*` and an explicit list of running-session variables (`PI_FOREMAN_HANDOFF_DIR`, `_STATE_DIR`, `_PARENT_INTERCOM`, `_PARENT_LABEL`, `_SESSION_MODEL`, `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_PARENT_SESSION`; test switches such as `PI_FOREMAN_LIVE_SMOKE` and `PI_FOREMAN_DOCS_ROOT` survive), and the `session:` node tests clear and restore `PI_SUBAGENT_CHILD`, so every suite is green inside a child sandbox.
- 3h, 7f (pre-pr fixes 3): the trace writer scrubs every string field (deny `command`, `reason`, `note`, …), not only `tool_error.message`: secrets redacted, then paths, URLs (whole) and file names become `[path]`; the model ids (`model`, `models`, `primary`, `from`/`to`) and a finding's `file` base name are exempt. A deny `command` such as `curl http://x/secret` is now traced as `curl [path]`.
- 2 (security, pre-pr fixes 3): a path tool's `path` (read/grep/find/ls) is always a path operand, so a `*` deny also covers a path with white space; in bash the white-space exemption applies only to the value of a known prose option (`--reason/--title/--body/--note/--message`, `-m` of a `git commit` unit) by position, never to the path arguments of a pure read.
- 7f: `tool_error {tool, message}` is traced for a tool result with `isError` (message cut to 200 characters, redacted, and path-scrubbed: paths, file names, `name.ext:12:3` and `key=file.ext` values become `[path]`).
- 7g: the sidebar shows a static state glyph in `fm_sym` (⏳ working or waiting, ⏸ idle, ? ask open, ✋ blocked, ✓ done, ✗ lost, `!` blocked over 15 minutes), pushed when the state changes; no spinner, no frames, and an unchanged row is re-sent only every 10 s, before the 15 s token TTL expires; the config snippet row 1 opens with `fm_sym` again. See docs/herdr.md.

### Known gaps
- Modules imported by a scanned script are not scanned (1d scans the script file only).
- Any child's operand-less test runner (bare `node --test`, `node --test .`, `npm run test:node`, `make test`) runs untracked worktree files unscanned (only a builder can plant one).
- A command with a backtick is refused for read-only children even when harmless: the over-block is deliberate (docs/permissions.md).
- The trace scrubs extensionless file names (`Makefile`, `id_rsa`) only as operands of a read/exec verb; elsewhere such a word stays.
- 2d: inline python over the state dir still asks (fail closed).
- 2g: the external package's "approve for this session" is subagent-scoped.
- 4d: `bg_wait` yielding during a supervisor ask is upstream in pi-subagents.
- 6a: the option "`review.model` of another family when ranked" is not built.

### Deferred / dropped
- 6d (background model): deferred to a follow-up round.
- 7b, 7c, 7d: dropped for budget.

### Fixed
- Review fixes, ruling 4: a single-agent review launch counted twice against `ceremony.reviewRuns` (3f), so the default cap of 3 refused the second review of a prompt; it now counts once. Replay goldens changed only for 3f (`role_launched` at launch and `role_result` at the run end, `role` on an overlay deny) and 7f (`tool_error`): destructive, detach, launch_model_switch, ledger_flow, parallel_ask, provider_switch, role_allowlist, role_model, safe_ops.
- Ledger 7c: the session's round surfaces (own handoff dirs, round worktrees recorded in the session manifest, isolation worktrees below them) are owned by the foreman; the bound ledger is a read root. A child writes only its own worktree: the round worktree is written by the foreman and the `builder` child whose cwd is in it, every other child role (and any isolation child) reads it but cannot write it; an isolation child writes only its own isolation worktree, never a sibling's. See docs/permissions.md, "Round surfaces". Tests: `roundsurface.test.ts`.
- Ledger 7d: the closed shell-variable grammar takes `cd <literal>`, `NAME=$PWD[/sub]`, `NAME=$FOREMAN_SCRATCH[/sub]` and `NAME=<literal under an owned dir>`; a heredoc opener ends the checked text at its line and an interpreter reading a heredoc keeps its class (still reviewed or asked). Cases in `tests/fixtures/shellvars-cases.json`, read by both implementations.
- Ledger 7e: the foreman's own `git worktree add <repo>.worktrees/<round>` needs no ask (label `round-worktree`); a child's `git worktree` stays denied.
- Ledger 7f: the git guard denies a bash line whose quoted, escaped or `"a"+"b"` pieces reassemble a guarded token (`.git`) that no single piece spells (`split literal reassembles a guarded token`). Tests: `tests/test_git_guard_split_literal.py`.
- Ledger 7h: test-only fixes: a refused close notice wakes a child `foreman_wait`; `npm root -g` runs lazily in the trust tests instead of at import.
- Ledger 8: `bg_wait` is not refused while a child's supervisor ask is open; repeated "tool open for Ns" control notices for one tool call are dropped from the model context (`ceremony.dedupeNotify`); the `strong_no_reason` refusal says to pass `reason` as an extra top-level field of the subagent call; the builder prompt forbids `sed -i`/`sed -i.bak` and shell appends to project files. `RUNG_UP: context` compares the last call's context with `strongAbove` (checked, unchanged; see docs/ladder.md). Tests: `supervisor-window`, `notices-toolcall`, `ladder-reason-text`.
- Ledger 9: `foreman_worktree_setup.read_input` reads only data that is ready on stdin, so a caller that keeps stdin open with nothing written (or a tty) no longer blocks it. Test in `tests/test_foreman_worktree_setup.py`.
- Ledger 11: all suites run with stdin closed (`</dev/null`); no replay goldens changed.
- Ledger 12: a new pane showed the previous session's sidebar row (`fm_l1`, `fm_l2`, `fm_cost`) before its own first publish. Cause: the daemon's join fell back to the working directory and matched a finished, stale or lost presence to the new pane in the same folder. `join()` now skips those states, and the daemon clears the `fm_*` keys of a Pi pane no session is joined to, once. Tests: `StaleTokensTest` (join, blanks).
- Ledger 3: a child session in another Herdr workspace could render a blank row. Shipped: an R3-shape regression test (`tests/test_herdr_cross_workspace.py`), a defensive `self_panes_for` path (a pane whose push stamp is fresh but whose `agent.list` tokens hold no `fm_l1` is composed by the daemon instead of left to the session; `StaleTokensTest`), and a live-first `join()`: a finished, stale or lost session's presence no longer claims a pane id Herdr reused for a live child (that put the wrong row on the pane); such a session joins a pi pane only when the pane's `agent_session` names it, otherwise the pane stays unjoined. The root cause of the blank row itself was not reproduced (deferred).
- Ledger 7c (follow-up): a read-only child (reviewer or other non-builder role in the round worktree, any child in an isolation worktree it does not own) is denied every shell write there: `rm`/`rmdir`/`unlink`/`shred`, in-place `sed`, `truncate`, `dd of=`, `chmod`/`chown`, `touch`/`mkdir`/`mv`/`cp`/`ln`/`tee`, `find -delete`, and git commands that change the worktree (`checkout`, `reset`, `apply`, `stash`, `commit`, `add`, `restore`, ...). Redirects (`>`, `>>`, also to a new file) and `tee` into a read-only root are denied, except `/dev/null`, fd dups (`2>&1`) and the child's own scratch dir. A command that is neither a known reader, a test run nor a known writer is denied while the cwd is read-only, and from any cwd when one of its words is a path in a read-only root (`perl -pi -e s/x/y/ <worktree>/f`). Test runs are `npm test`, `npm run test|lint|typecheck|check`, `cargo test`, `go test`, `pytest`, `make test*`, `python3 -m pytest|unittest`, and a script file named by a relative path (`python3 [-I] scripts/x.py ...`, `node scripts/x.mjs ...`) that is git-tracked (`git ls-files --error-unmatch` from the round worktree) and whose realpath, symlinks resolved, lies in the round worktree; a line with such a script or any test run is refused for a read-only child when it contains `cd`, `pushd` (also `builtin cd`, `command cd`, `( cd ... )`), an environment assignment (`VAR=...`, `export VAR=...`) or `env`. Test runs may write caches, build output and scratch, and what a script itself writes is not classified. Test-runner operands and `git config` are covered too (R6 lane 1a, 1b below). `python3 -c`, `node -e`, heredoc and stdin interpreter forms stay denied. Tests: `roundowner-shell.test.ts`, `roundowner-redirect.test.ts`, `roundowner-script.test.ts`.
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
  transitive tree); the default is now the pinned `bench/pi-lock/` install, and `bench.pi_prebaked=false` opts out to the live install.
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
