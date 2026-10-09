# Changelog

## [Unreleased]

### Added
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
- Permission baseline allows read-only `sed -n *` (asks for `-i`, `w`, `W`, `e` forms); `timeout N <allowed command>` in a
  child's bash ask is allowed by the foreman's review link when every unit of the command is allowed (PS floors wrappers).
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

### Changed
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
- The model review of an ask forwarded from a child saw an empty value: PS 39.0.2 puts the child's command in `value`,
  not `command`. That is why most child bash asks were deferred (and then denied headless).
- Child sessions mislabelled the tier (they emitted `tier` events with their own default); only the foreman does now.
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
