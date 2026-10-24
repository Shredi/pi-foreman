# Ladder rungs and climbs

> Covers the two-rung role ladder at run time: the live rung, context and failure climbs, `rung_top`, the
> reviewer's own climb (`ladder.reviewerClimb`, `securityRung`) and the trace records. The role map, rank policy
> and presets are in [roles](roles.md); the review occasions, per-occasion overrides and panel in [review](review.md).

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

The foreman's own strong launch passes `reason` as an extra top-level field of the `subagent` call (the published
schema stays unchanged; the adapter removes the field before the tool sees it). Without a reason, and without a
climb-eligible run, the launch is refused: `strong launch of builder refused [strong_no_reason]: pass `reason` as
an extra top-level field of the subagent call ...`.

`strongAbove` is 100000 by default and 200000 for the explorer (`roles.explorer.strongAbove` in the defaults): an
explorer's read-only map grows its context by reading, a 276 s map ended climb-eligible at the old limit, and a
stronger model would start from the same context. Raise or lower it per role, provider or ladder.

## Turn limit

`ladder.maxTurns.<role>` is the assistant-turn limit of a role (default `{builder: 100}`); roles without an entry use
`childMaxTurns` (default 60), which stays the fallback. A child past its limit is steered once; the trace records
`child_turn_limit {role, turns, limit}` next to `child_turn_cap`.

## Failure climb

A builder revision launched while the latest reviewer verdict is FAIL goes to the builder's strong rung when
`strongOnRevision` resolves true (`rung_up {reason: "review_fail"}`; lookup in [roles](roles.md)). While the
builder's live rung is the bottom one, the finish gate refuses once more without counting the refusal
(`finish_refused {climb_available: true}`).

The `review_fail` target is the higher of the launch model and the strong rung by provider rank (`providers.<p>.ranks`). A model that ranks above the strong rung stays: the trace is `rung_top` with reason `already above strong rung`. A model below it rises to the strong rung.

`strongOnRevision` (default true) also covers a revision that answers a FAIL with a `SECURITY:` finding: it launches
on the strong rung. The security exemption (`revision_security_exempt`) is separate: it lifts only the revision cap
for that round and never climbs by itself; with `strongOnRevision` false the exempt revision stays on the bottom
rung. On the top rung the revision is a `rung_top`, the finish gate offers no
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
| `ladder.reviewPanel.shadows`, `ladder.reviewPanel.gates`, `ladder.reviewPanel.visible`, `ladder.reviewPanel.waitSeconds` | `[]`, `[pre-pr]`, `true`, `600` | Shadow reviewer models the foreman launches after the primary ends, on the named occasions (`item`, `plan-review`, `pre-pr`, `second-opinion`); their findings never block. Empty `shadows` = off. `waitSeconds` is the wait before the block composes without late shadows. User or overlay config only; see [review](review.md#review-panel). |

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

## Research markers

A launch entry (single, `tasks`, `chain` or `parallel`) whose task text carries a marker (case-insensitive) is routed on its own role:

| Marker | Rung |
|---|---|
| `[research]` | At least the role's strong rung: an entry on a weaker model (by `providers.<p>.ranks`, or any model without ranks) is moved to it, one already as strong or stronger stays. Written before the rank check, so `ladder.childPolicy` still applies. With no strong rung mapped the model stays. |
| `[fact-critical]` | Implies `[research]` and wins over it. The rung is the first of `ladder.research.factCriticalRung` (default unset; user or overlay config only), the security rung (`ladder.reviewerClimb.securityRung`, else the default security rung), the role's strong rung. Written after the rank check like the security rung, with its thinking level capped by `maxThinking` and `childMaxThinking`. |

Use `[research]` on an explorer launch that reads the web or PDFs; add `[fact-critical]` only when a wrong fact is costly. Code search needs no tag. In the claude-bridge presets this moves the explorer from its bottom to its strong model, and a fact-critical one to the security rung.

## Launch sizing

A builder launch may carry two extra top-level fields (like `reason`, per `tasks`/`chain`/`parallel` entry too; the entry wins). The adapter strips them from every launch and picks the rung from them. A launch without them runs as before (`launch_sizing` rule `undeclared`).

- `size: { files: string[], largestFileLines?: number, modules?: number }`: the files the builder will touch.
- `risk: string[]`, from `guard, permission, parser, concurrency, security, design`.

Malformed fields (wrong type, unknown tag, negative or non-integer number, a directory in `files`) refuse the foreman's launch with `[sizing_invalid]` and a one-line fix. Other roles ignore the fields.

**Measurement.** The adapter reads at most 20 named files, each against the entry's `cwd` (else the session cwd), inside that checkout only. A missing file counts 0 lines (new file); a file over 1 MiB or an unreadable one counts as large; files past the 20th count as large. `modules` counts distinct components: the first two directory segments of each file, leaving out root files, `docs/`, `*.md` and test directories. The claim only raises: the rule sees `max(declared, measured)`.

| Rule | Condition | Rung |
|---|---|---|
| `risk_top` | a risk in `topRisks` (design) | top |
| `risk_strong` | a risk in `strongRisks` (guard, permission, parser, concurrency, security) | strong |
| `large_file` | lines over `largeFileLines`, or a large file | strong |
| `modules` | components over `maxModules` | strong |
| `small` | anything else (docs, changelog, config keys, a small new test, 1-3 small files) | default |

The first matching row wins. Sizing only raises the rung:

- **Precedence.** With no `model`, the final rung is the higher of the usual logic (heavy tier, revision climb, handoff) and the sizing rung. A sizing climb needs no `reason` and traces `rung_up` reason `sizing`. An explicit `model` at or above the sizing rung keeps the usual logic; a lower one needs a `reason`, else the launch is refused (`[sizing_below]`); with a reason it wins (`override`). With no strong rung mapped nothing is refused and the trace says `capped`.
- **Top rung.** `ladder.sizing.topRung`, else the next rank above the builder's strong rung (`providers.<p>.ranks`), else strong (`capped`). A top refused by `ladder.childPolicy` falls back to strong; the launch is never blocked.
- **Pressure and trivial.** Pressure delays, never downgrades: at high pressure (launches one at a time) and critical (launches deferred) every climb keeps its rung, the sizing strong or top climb included; a top falls back to strong only through `capped`, never through pressure. At the trivial tier a sizing strong or top launch escalates to standard, like a `reason` strong launch.
- **Receipt rung note.** A launch that stays on the bottom rung although a strong climb was asked or wanted says why in its receipt: `builder on <bottom> (bottom rung: no strong rung mapped)`; a revision climb wanted with no strong rung also traces `revision_no_strong {role}`. Other receipts are unchanged.
- **Bypass probes.** A builder launched with a `strongRisks` tag makes the next `item` or `pre-pr` reviewer launch carry a first line `[pi-foreman risk] <tags>: probe for bypasses ... and list each probe you ran.` An `item` or `pre-pr` PASS clears it.

Keys (user or overlay config only; a project layer cannot change them): `ladder.sizing.enabled` (false: the fields are stripped and ignored), `ladder.sizing.largeFileLines` (1500), `ladder.sizing.maxModules` (2), `ladder.sizing.strongRisks`, `ladder.sizing.topRisks`, `ladder.sizing.topRung`.

`foreman retro` lists per rule the launches, the final rungs, later climbs and later review FAILs. The join is heuristic: a record belongs to the last `launch_sizing` of the same role before it, so parallel builders and rounds that overlap can be misattributed. Read it as a trend, not a count per task.

## Trace records

A child's records carry `role` and `runId` (the launch id) in its own `trace-<launchId>.jsonl`; see [retro](retro.md).

| Event | Fields | When |
|---|---|---|
| `rung_up` | `role, from, to, reason` (+ `item` or `hits`, and `policy_override` for the reviewer) | A launch climbs from its live rung. |
| `rung_up` reason `sizing` | `role, from, to, reason` | A builder launch climbed because its `size`/`risk` asked for a higher rung (see Launch sizing). |
| `launch_sizing` | `role, rule, rung, base` (+ `files, lines, declaredLines, modules, declaredModules, outside, risk, note`) | Once per builder entry that carried `size` or `risk` or none (`undeclared`), and for another role that carried them (`not_builder`). `rung` is the final rung (`default`, `strong`, `top`), `base` the rung before sizing; `note` holds `capped`, `override`, `explicit`. |
| `rung_top` | `role, model, reason` (+ `item` or `hits`, `policy_override`) | A climb was due but the live rung already is the top one. |
| `child_policy_block` | `role, runId, kind, outcome, exit, decision` | A child stopped on a permission-policy block: `kind` is `policy_block`, `decision` is `stopped`. It is never climb-eligible and the harness does not relaunch it; the report says so. |
| `child_repeat_refusal` | child: `runId, role, reason, decision`; foreman: `role, runId, kind, outcome, exit, decision` | The child got the same overlay deny reason twice in one run and stopped it (`run failed: repeated guarded-token probe`, `decision` `stopped`); every later tool call of the run is blocked. The foreman's record (`kind` `repeat_refusal`) treats it like `child_policy_block`: failed, never climb-eligible, not relaunched. |
| `REPEAT_STOP_REASONS` (`launchwait.ts`, a constant, not a trace event) | — | The deny reasons a repeat may stop a child on (`child_repeat_refusal`): split or concatenated guarded literals, `HOME`/`FOREMAN_SCRATCH`/`$S` rebinding, a self-ruling write, and protected-config or credential path reads and writes. A repeated `cd` outside the workspace, worktree paths, npm/install asks, temp-dir writes, and read-budget or review-cap refusals never stop a run. |
| `review_model` | `role, from, to, reason` | The different-model rule moved a reviewer off the foreman's model (`same_as_foreman`) or found no alternative (`no_alternative`). |
| `review_occasion` | `occasion, thinking, model_overridden` | A reviewer launch for that occasion (`item`, `plan-review`, `pre-pr`, `second-opinion`); `ceremony.reviewByOccasion` applied (see [review](review.md#per-occasion-overrides)). |
| `panel`, `finding` | see [review](review.md) | Shadow launch; a located finding. |
| `research_rung` | `role, marker, model` (+ `kind`: `single` or `entry`) | Once per marked launch entry, with the model it launches on. `foreman retro` counts explorer launches by model from the usage lines (single launches) and these events (`kind: entry`; tasks and chain children log role `child` in usage). |
| `launch_entry` | `role, kind, model` | Once per agent entry of a tasks or chain launch that carries no research marker (`kind: entry`; `model` is the entry's base model or null). `foreman retro` counts the `explorer` ones into the explorer line; marked entries emit only `research_rung`, so nothing is counted twice. |
| `security_rung_unset` | `role, reason, hits` | A security-shaped diff found no security rung. |
| `rung_up_steer` | `role, count, rung` | A child was steered to hand off (context or turns). |
| `finish_refused` | `climb_available` | The uncounted refusal while the builder's failure climb is open. |
