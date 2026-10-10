# Ladder rungs and climbs

> Covers the two-rung role ladder at run time: the live rung, context and failure climbs, `rung_top`, the
> reviewer's own climb (`ladder.reviewerClimb`, `securityRung`) and the trace records. The role map, rank policy
> and presets are in [roles](roles.md).

## Rungs and the live rung

Each role has a bottom rung (`roles.<id>.model`) and an optional top rung (`roles.<id>.strong`). The harness keeps,
per role, the model of the role's latest launch: single, `tasks`, `chain` and `chain[].parallel` launches all count.
This is the live rung. A climb starts from it: `rung_up {role, from, to, reason}` names the live model as `from`.

When the live model already is the strong rung there is nothing to climb. The trace records
`rung_top {role, model, reason}` instead of a `rung_up` and the launch proceeds on the strong rung unchanged. A
second climb after a context climb therefore never reports a stale `from` of the bottom rung.

## Context climb

A bottom-rung child whose last call's context (input + cacheRead + cacheWrite) passes `strongAbove` is steered once
to stop and return a handoff report starting `RUNG_UP: context` (also `RUNG_UP: turns` past `childMaxTurns`, and a
`STATUS: stuck` or "own checks failed" report). The run is climb-eligible: the foreman's next `model: "strong"`
launch of that role needs no reason, gets the prior report prepended to its task, and the trace records
`rung_up {reason: "context"}` (or `turns`, `stuck`, `checks_failed`).

## Failure climb

A builder revision launched while the latest reviewer verdict is FAIL goes to the builder's strong rung when
`strongOnRevision` resolves true (`rung_up {reason: "review_fail"}`; lookup in [roles](roles.md)). While the
builder's live rung is the bottom one, the finish gate refuses once more without counting the refusal
(`finish_refused {climb_available: true}`). On the top rung the revision is a `rung_top`, the finish gate offers no
climb, and the usual two-refusal valve applies: two counted refusals, then `ceremony_incomplete`
(see [ceremony](ceremony.md)).

## Reviewer climb

`ladder.reviewerClimb` gives the reviewer its own climb. It is off in the generic defaults; both `claude-bridge`
presets turn it on. It applies only to `reviewer` launches the foreman passed no model for (`senior-reviewer` never
climbs here), and only user or overlay config can set it.

| Key | Default | Meaning |
|---|---|---|
| `ladder.reviewerClimb.enabled` | `false` | Turn the two triggers below on. |
| `ladder.reviewerClimb.securityRung` | unset | Model of a reviewer launch on a security-shaped diff, `<provider>/<model>[:<level>]`. |
| `ladder.reviewerClimb.mode` | `repeat-fail` | `repeat-fail`: the two triggers below. `on-find`: each ledger item climbs one rung per FAIL or per PASS with located findings until a clean verdict (`climb_done {rungs, reason: clean, item}`) or the top rung still finds (`reason: exhausted`). |
| `ladder.reviewerClimb.rungs` | `[]` | On-find reviewer models, bottom first; empty means `[roles.reviewer, roles.reviewer.strong]`. |
| `ladder.reviewPanel.shadows`, `ladder.reviewPanel.gates`, `ladder.reviewPanel.visible` | `[]`, `[pre-pr]`, `true` | Shadow reviewer models launched beside the primary on the named occasions (`item`, `plan-review`, `pre-pr`, `second-opinion`); their findings never block. Empty `shadows` = off. User or overlay config only. |

- **Repeated FAIL.** The harness reads each reviewer run's per-item `N. FAIL` lines (a list marker, backticks,
  `**` and `N)` are accepted; fenced blocks are skipped). When the same ledger item fails in a second reviewer run,
  the next reviewer launch goes one rung up, to `roles.reviewer.strong`: `rung_up {role: "reviewer", from, to,
  reason: "review_fail_repeat", item}`. Without a strong reviewer rung nothing happens.
- **Security-shaped diff.** Before the reviewer's model is picked, the harness takes the work diff the reviewer will
  review (the same diff the facts block uses; it is taken once per launch). It is security-shaped when a changed path
  has a part like `auth`, `crypto`, `security`, `secret`, `exec`, `shell`, `net`, `listen` or `socket`, or an added
  line has a call shape like `exec(`, `spawn(`, `child_process`, `subprocess.`, `os.system(`, `Command::new(`,
  `net.Listen(`, `ListenAndServe(`, `.listen(`, `bind(`, `os.Remove(`/`RemoveAll(`, `unlink(`, `fs.rm`,
  `remove_file(`, `rmtree(` or a crypto, hash or cipher import. The reviewer then launches on `securityRung`:
  `rung_up {role: "reviewer", from, to, reason: "security", hits}` (`hits` lists pattern labels such as
  `path:auth,spawn(`, never a path or a line). The scan is line-based, a floor and not a proof.

Without `securityRung` the harness takes the mapped strong rung (of any role) or literal ranks entry in the next rank
above the reviewer's strong rung, by `providers.<p>.ranks`. A role's plain model is never a candidate, since a
project layer may set it; strong rungs and ranks come from the user or overlay config only. With no ranks or no such model there is no extra climb and the
trace records `security_rung_unset {role: "reviewer", reason: "security", hits}`; the repeated-FAIL climb still
applies. The security rung is explicit config: it is written after the rank check, so `ladder.childPolicy` does not
refuse it. Its thinking level is capped by `maxThinking` and `childMaxThinking`.
When the rung goes beyond what `ladder.childPolicy` would allow, its `rung_up` (or `rung_top`) record carries `policy_override: true`.

## Trace records

A child's records carry `role` and `runId` (the launch id) in its own `trace-<launchId>.jsonl`; see [retro](retro.md).

| Event | Fields | When |
|---|---|---|
| `rung_up` | `role, from, to, reason` (+ `item` or `hits`, and `policy_override` for the reviewer) | A launch climbs from its live rung. |
| `rung_top` | `role, model, reason` (+ `item` or `hits`, `policy_override`) | A climb was due but the live rung already is the top one. |
| `security_rung_unset` | `role, reason, hits` | A security-shaped diff found no security rung. |
| `rung_up_steer` | `role, count, rung` | A child was steered to hand off (context or turns). |
| `finish_refused` | `climb_available` | The uncounted refusal while the builder's failure climb is open. |
