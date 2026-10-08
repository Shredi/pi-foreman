# Changelog

## [Unreleased]

### Added
- Orientation packet: a short git status/log summary given to the foreman once per session
  (`ceremony.orientation {enabled, maxLines}`, trace event `orientation`).
- Trace event `rereview` and bench columns `rereviews` and `orient_lines`.
- Knob `ceremony.reviewGate` (`pass` default, `verdict`; tighten-only toward `pass`).

### Changed
- Foreman read budget before the first launch is now warn 4 / deny 8 (was 6/12); the deny text
  points at the explorer and `/foreman budget lift`. The old values are restorable from the user layer only.

### Fixed
- A reviewer FAIL no longer satisfies the required reviewer step, and a revision after a PASS
  re-opens it (strict revision rule). The two-refusal escape hatch still applies.
