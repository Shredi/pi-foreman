# Changelog

## [Unreleased]

### Added
- Review link, child bash asks (`docs/permissions.md`): effect classes `read`, `build-test` (from the project manifest
  at the worktree root), `write-in`, `write-out`, `unknown` (`effects.ts`); only write-out and unknown reach the review
  model. Read and write paths must resolve inside the worktree, `$FOREMAN_SCRATCH` or `/tmp` (no `~`, `..`, other
  absolute paths, symlinks out, `.git`). Chains joined by `&&`, `||`, `;`, `|` are allowed when every segment is
  (`shellchain.ts`; `$(`, backticks, subshells, `eval`, `sh -c`, `xargs`, `&`, heredocs refused; redirects only to
  `/dev/null`, scratch or `/tmp`); trace `chain_allow {segments}`. New label `test-restore` for `git restore`/`git
  checkout --` on test files, so the git guard's test restore no longer defers headless. The `review` trace gains `class`.
- Ladder: `ladder.reviewerClimb {enabled, securityRung}` (default off; on in both `claude-bridge` presets with the
  foreman's Opus as `securityRung`). The second FAIL of the same ledger item across reviewer runs sends the next
  reviewer launch to its strong rung (`rung_up` reason `review_fail_repeat`, `item`); a security-shaped work diff
  (path words and call shapes, `securityScan` in `diffscan.ts`, diff taken once before the model is picked) sends
  it to `securityRung`, else the next ranked mapped model (`rung_up` reason `security`, `hits`; none:
  `security_rung_unset`). New page `docs/ladder.md`.
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

### Changed
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

### Fixed
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
