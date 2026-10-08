# Changelog

## [Unreleased]

### Added
- `ceremony.ledgerHelper` (`tool` default, `bash`, `off`) and the foreman's `foreman_ledger` tool; the foreman
  closes V itself after a reviewer PASS with no revision since (harness-attested), reviewer children mark V only.
- `foreman_ledger` action `upsert` (`item?`, `text`): replaces an item's text keeping its state, or appends a new item;
  identical text is a no-op.
- `ceremony.reviewPerRevision` (default true): a second reviewer launch after a PASS on unchanged work is
  refused; `[second-opinion]` in the task text allows one.
- `ceremony.heavyThreshold` (`strict` default, `eee843d`): keyword signals become a hint (`triage_hint`).
- Trace events `ledger_call`, `review_dup_refused`, `review_second_opinion`, `stop_hold`; bench columns
  `ledger_denies`, `ledger_calls`, `dup_reviews`, `second_opinions`, `stop_hold`.
- Orientation packet: tracked-file tree to depth 2, head of AGENTS.md or README.md, detected build/test
  commands and an explorer hint, added to the foreman's system prompt once per session
  (`ceremony.orientation {enabled, maxLines}`, trace event `orientation`).
- Trace event `rereview` and bench columns `rereviews` and `orient_lines`.
- Knob `ceremony.reviewGate` (`pass` default, `verdict`; tighten-only toward `pass`).
- Project agent `implementer` for worker waves.
- README: "Updating Pi".

### Changed
- Foreman tier in the bench is taken from the foreman's own trace only.
- Pure-ledger shell commands no longer count against the read and recheck budgets (helper on).
- Foreman read budget before the first launch is now warn 4 / deny 8 (was 6/12); the deny text
  points at the explorer and `/foreman budget lift`. The old values are restorable from the user layer only.
- Pi 1.1.0 (range 1.1.x): pins in `packages.lock.json`, `package.json`, CI, bench and the replay driver;
  suites re-run on 1.1.0. pi-subagents 0.75.0, pi-permission-system 39.0.2 and pi-intercom 0.16.1 held.
- Bench: pi-claude-bridge 0.9.2 (forwards Pi's custom prompt sections, so the foreman rules reach bridge
  models) with claude-agent-sdk 0.3.293.

### Fixed
- Child sessions mislabelled the tier (they emitted `tier` events with their own default); only the foreman does now.
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
