# Changelog

## [Unreleased]

### Added
- Orientation packet: tracked-file tree to depth 2, head of AGENTS.md or README.md, detected build/test
  commands and an explorer hint, added to the foreman's system prompt once per session
  (`ceremony.orientation {enabled, maxLines}`, trace event `orientation`).
- Trace event `rereview` and bench columns `rereviews` and `orient_lines`.
- Knob `ceremony.reviewGate` (`pass` default, `verdict`; tighten-only toward `pass`).

### Changed
- Foreman read budget before the first launch is now warn 4 / deny 8 (was 6/12); the deny text
  points at the explorer and `/foreman budget lift`. The old values are restorable from the user layer only.

### Fixed
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
