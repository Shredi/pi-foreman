# Changelog

## [Unreleased]

### Added
- Orientation packet: tracked-file tree to depth 2, head of AGENTS.md or README.md, detected build/test
  commands and an explorer hint, added to the foreman's system prompt once per session
  (`ceremony.orientation {enabled, maxLines}`, trace event `orientation`).
- Trace event `rereview` and bench columns `rereviews` and `orient_lines`.
- Knob `ceremony.reviewGate` (`pass` default, `verdict`; tighten-only toward `pass`).
- Project agent `implementer` for worker waves.
- README: "Updating Pi".

### Changed
- Foreman read budget before the first launch is now warn 4 / deny 8 (was 6/12); the deny text
  points at the explorer and `/foreman budget lift`. The old values are restorable from the user layer only.
- Pi 1.1.0 (range 1.1.x): pins in `packages.lock.json`, `package.json`, CI, bench and the replay driver;
  suites re-run on 1.1.0. pi-subagents 0.75.0, pi-permission-system 39.0.2 and pi-intercom 0.16.1 held.
- Bench: pi-claude-bridge 0.9.2 (forwards Pi's custom prompt sections, so the foreman rules reach bridge
  models) with claude-agent-sdk 0.3.293.

### Fixed
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
