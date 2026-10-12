# Review: occasions, model rule, panel and findings

> Covers the four review occasions, the different-model rule, plan review, per-occasion overrides
> (`ceremony.reviewByOccasion`), the shadow-model panel, the findings store with `foreman findings` and
> `foreman retro models`. Read it when you tune reviewer cost against catch rate (base triggers: [ladder](ladder.md)).

## Reviewer escalation

A `reviewer` launch the foreman passed no model for runs on `roles.reviewer`. `ladder.reviewerClimb` (user or overlay
config only; `enabled` defaults to `false`, both `claude-bridge` presets turn it on) adds two triggers: the second FAIL
of one ledger item sends the next launch to `roles.reviewer.strong` (`rung_up` reason `review_fail_repeat`), and a
security-shaped diff sends it to `ladder.reviewerClimb.securityRung` (reason `security`; see [ladder](ladder.md)).
`senior-reviewer` never climbs. There is no climb on a finding: see [Why one reviewer](#why-one-reviewer).

## Review occasions

One mechanism serves every review: the same launch path, climb rung, model rule, extractor and records. The occasion
is read from a marker in the reviewer's task text.

| Occasion | Marker | Reviews | Counts for items and gates |
|---|---|---|---|
| `item` | none | Built ledger items | yes |
| `plan-review` | `[plan-review]` | The plan, before the checkpoint | no |
| `pre-pr` | `[pre-pr]` | The whole branch diff before a PR | yes |
| `second-opinion` | `[second-opinion]` | Advice on unchanged work (also exempt from `ceremony.reviewPerRevision`) | no |

"Counts" means the verdict marks items, satisfies the review gate and PR gate, feeds the repeated-FAIL rule. A plan review, a second opinion and every panel shadow are recorded as findings only and never block.
`[second-opinion]` wins over `[plan-review]`, which wins over `[pre-pr]`.

### Scope of a review

The ledger is the scope source. The adapter prepends the ledger text to every `reviewer` and `senior-reviewer` launch: the cited items when the task cites any (`item 3`, `#3`), else the whole ledger (header and items). The binding is the session marker, so a review launched with `cwd` in a worktree gets it too. The adapter does not append the owner's prompt. A diff fact is in scope when the prepended ledger block or the task text asks for it; the reviewer quotes the ledger item that asks for the change, else FAIL (BLOCK in a senior review). A foreman statement in the task never overrides a fact. Because the ledger is the only scope source, an item the foreman upserts mid-round also widens scope; a future round can snapshot the ledger at checkpoint approval.

## Different-model rule

A review by the model that built the work is weak evidence. On every `reviewer` launch, when the resolved model is the
foreman's own (base ids, the thinking level ignored), the harness moves it to the next rung that differs, else
to `ceremony.reviewModel` (default `null`, user or overlay config only). Trace `review_model {role, from, to, reason:
same_as_foreman}` (+ `policy_override` when the rank policy would refuse the pick). With no differing rung and no
`reviewModel` the launch proceeds unchanged and the trace says `reason: no_alternative`. The rule applies whether or
not the repeat-fail climb is enabled.

## Plan review

With `ceremony.planReview.<tier>` on (heavy by default, see [ceremony](ceremony.md)), `foreman_checkpoint` refuses
with `plan_review_required` until a `[plan-review]` reviewer run ended with a verdict for the current plan, keyed by
the plan version hash (sha256 of the plan body above any `## Ruling`, `## Rulings`, `## Parent ruling`,
`## Decision log`, `## Addendum…` heading or `<!-- plan-appendix -->` line; see [ceremony](ceremony.md)). A ruling appended
below such a heading neither needs a new review nor resets the checkpoint; a body edit is a new version. Verdicts are kept per plan path (in memory, for the session); a new plan path
starts a new lineage. The first FAIL of a lineage refuses once with `plan_revision_required`, so the planner revises
before the owner sees it; once the revised plan (new bytes) has a verdict, the checkpoint opens whatever it says. The
owner's dialog shows `Plan review: PASS|FAIL (reviewer <model>)` and up to 8 located findings (`file:line class note`).
Trace `plan_review {model, decision}`. The foreman's instructions carry the plan-review step only while it is on
(`<!--planReview=on-->` variant). Plan review uses the model rule like any other occasion.

## Security findings and the revision cap

A reviewer or senior-reviewer FAIL (BLOCK) whose report has a finding line starting `SECURITY:` (the agent files tell
them to prefix security findings so) makes the builder launches that answer it exempt from `ceremony.revisionRounds`:
the builder launches after that FAIL, up to the next review verdict (trace `revision_security_exempt`). Every other
revision counts as before. A hard ceiling stays: exempt and counted revisions together never exceed 2 x
`ceremony.revisionRounds` per prompt (heavy: 4); past it the launch is refused as usual, and the refusal text names the
exempt count.

## Per-occasion overrides

`ceremony.reviewByOccasion` sets the thinking level and/or model of a `reviewer` launch per occasion. User or overlay
config only (a project layer's value is dropped with a warning). Default `{}`: no override.

| Key | Values | Meaning |
|---|---|---|
| `ceremony.reviewByOccasion.<occasion>.thinking` | `low`, `medium`, `high` | Thinking level of the launch. |
| `ceremony.reviewByOccasion.<occasion>.model` | `<provider>/<model>[:<level>]` | Model of the launch. |

`<occasion>` is `item`, `plan-review`, `pre-pr` or `second-opinion`, so the keys are
`ceremony.reviewByOccasion.item.thinking`, `ceremony.reviewByOccasion.item.model`,
`ceremony.reviewByOccasion.plan-review.thinking`, `ceremony.reviewByOccasion.plan-review.model`,
`ceremony.reviewByOccasion.pre-pr.thinking`, `ceremony.reviewByOccasion.pre-pr.model`,
`ceremony.reviewByOccasion.second-opinion.thinking` and `ceremony.reviewByOccasion.second-opinion.model`; any other key is an unknown-key warning. The
override applies after the role map and before the different-model rule, so an overridden model takes part in that
rule. The thinking level is clamped by `maxThinking` and `childMaxThinking`. A model chosen by the repeat-fail or
security climb wins over an occasion model; the thinking override still applies. An occasion model is
written before the rank check, like the role map: with `ranks` set, a model the rank policy refuses (by default
one not ranked below the foreman) refuses the launch. Trace `review_occasion {occasion,
thinking, model_overridden}`.

## Review panel

`ladder.reviewPanel` adds shadow reviewers beside the primary. User or overlay config only; off while `shadows` is empty.

| Key | Default | Meaning |
|---|---|---|
| `ladder.reviewPanel.shadows` | `[]` | Shadow models, `<provider>/<model>[:<level>]`. Empty = off. |
| `ladder.reviewPanel.gates` | `[pre-pr]` | Occasions that get the panel (`item`, `plan-review`, `pre-pr`, `second-opinion`). |
| `ladder.reviewPanel.visible` | `true` | Show the shadows' findings to the foreman. |
| `ladder.reviewPanel.waitSeconds` | `600` | Seconds after the primary run end before the block composes with whatever shadows ended. |

The primary launch is unchanged. When the primary's run ends on a gate occasion, the harness lists the shadow launches
(shadows not equal to the primary or the foreman model). The foreman then issues one `subagent` reviewer call per
shadow, each with only the marker line `[panel-shadow:<model>] [<gate>]`. The hook binds the call to the newest open
pending panel of the same gate, replaces the task with the primary's stored task and facts, and sets the shadow model
after the model rules: exempt from the role-map rule, still rank-checked by `ladder.childPolicy` and clamped by
`maxThinking`. Shadows are optional for the verdict; the foreman may skip them when the budget is tight. The list
reaches the foreman with the primary's held result, else as its own message that steers into the running turn or
starts one. With shadows configured the foreman prompt carries the matching rule. A shadow launch is never held by
`ceremony.launchWait`.

The hook refuses a marker call (trace `panel {role, gate, models, primary, decision: refused, reason}`) when the panel is off
or the caller is a child, there is no open panel (or the call is outside a gate), the model is not configured in `shadows`, the shadow already ran for that
panel, the occasion differs, the call is not a single `reviewer` launch, or the rank policy rejects the model.
Otherwise the trace says `decision: launched`.

Only the primary's verdict counts: shadows never block, mark, count or satisfy the PR gate. The block composes when
all listed shadows have ended or after `waitSeconds` (trace `panel {..., decision: timeout}`); shadows missing then are
listed as "not run". It is sent to the foreman without triggering a turn and holds the primary's findings, then "Shadow findings (do not block)" grouped by model. A
finding several models located (same file and class, lines within 3) is listed once under the first model, tagged
"also found by". With `visible: false` the shadow section and names are left out; the records are still written.

## Findings store

Every completed reviewer run ends in `scripts/foreman_findings.py record` (fail-soft: a failure counts as zero findings
and traces nothing). It extracts the located defects of the report against the changed files and appends to
`<agentDir>/pi-foreman/state/findings/<session>.jsonl`, repo-relative paths only. Three record types:

| `type` | Fields (`review` and `finding` also carry `session, gate, model, rung, primary, role, runId, head, ts, source`) |
|---|---|
| `review` | `base, items, verdict, secs, startedTs, findings` |
| `finding` | `id, file, line, class, note` (note cut to 120 characters) |
| `dismiss` | `id, reason, session, ts` |

`source` is `live` for the primary, `panel` for a shadow, `bench` for bench runs. `rung` is `1` when the reviewer was raised to the strong rung by the repeat-fail rule or the security rung, else `0`.
A finding `id` is 12 hex characters of
a SHA-1 over file, `line // 5` and class, so a re-report of the same spot by the same model is one finding. The
`finding` trace event carries `findingId, model, gate, class, file` (basename only), `line, primary`.

## `foreman findings`

| Command | What it does |
|---|---|
| `foreman findings list [--since 7d\|ISO] [--only-model SUBSTR] [--unique] [--session S] [--json]` | Located findings; `--unique` keeps those only one model found. Dismissed ones are tagged. |
| `foreman findings dismiss <id> <reason>` | Marks a finding rejected (a `dismiss` record). |
| `foreman findings export <id> --to DIR [--repo PATH]` | Turns a finding into a review-bench task. `--to` is required and never inside the package tree or the finding's repo. |

Export writes `DIR/harvest-<id>/` with `base/` (the file at the merge base), `diff.patch` (the file's change up to the
finding's head), `prompt.md` (the ledger items the review covered, else a generic line), `ground_truth.json` (the
bench's format, one defect) and `harvest.json` (`"confirmed": false`). `foreman bench review` skips a task whose
`harvest.json` is unconfirmed; set `"confirmed": true` after you have checked the planted truth, then it joins the suite.
See [bench](bench.md).

## Outcomes

Every finding gets an outcome, read from later reviews of the session and the git history:

| Outcome | Meaning |
|---|---|
| `accepted` | A later review at another head, up to the next primary PASS, changed a hunk within 3 lines of the finding. |
| `rejected` | Dismissed, or the lines were untouched at the next primary PASS. |
| `confirmed_late` | Found after a primary PASS that did not report it (that PASS counts as a late miss of its model). |
| `open` | Not decided yet, or the history is unknown. |

## `foreman retro models`

`foreman retro models [--since 30d] [--source live|panel|bench] [--json]` prints one row per model and rung:

| Column | Meaning |
|---|---|
| `reviews`, `findings` | Review runs and located findings of the model. |
| `accepted`, `rejected` | Findings by outcome. |
| `unique` | Findings no other model located. |
| `late-miss` | Primary PASS reviews of this model that missed a later `confirmed_late` finding. |
| `usd`, `usd/acc` | Reviewer cost from the usage log, and per accepted finding. |
| `med s`, `p90 s` | Median and nearest-rank 90th percentile review seconds. |

A last line gives the time to clean: per ledger item, first primary review to its first clean PASS (median, p90).
A shadow model whose unique accepted findings reach `retro.panelThreshold` (default 3, user or overlay only) files a
backlog candidate of kind `review-model` ("consider it as primary or rung"); see [retro](retro.md).

## Privacy

Everything stays on the machine. The trace carries a finding's file as a basename only, never a path or a line of
code. Repo-relative paths and 120-character notes live only in the local findings store; `export` writes only into a
directory you name. Nothing is sent anywhere.

## Why one reviewer

The runtime launches one reviewer per review. A climb from a cheap reviewer to a strong one on every finding was
measured offline and not kept; the numbers are in [bench](bench.md#review-bench).

## Example overlay

A second vendor's model as a silent shadow before a PR, a fallback for when the foreman runs on the cheap model, and a
higher thinking level for the pre-PR review:

```json
{
  "ladder": {
    "reviewerClimb": { "enabled": true },
    "reviewPanel": {
      "shadows": ["<other-provider>/<other-model>"],
      "gates": ["pre-pr"],
      "visible": true,
      "waitSeconds": 600
    }
  },
  "ceremony": {
    "reviewModel": "<provider>/<strong-model>",
    "reviewByOccasion": { "pre-pr": { "thinking": "high" } }
  },
  "retro": { "panelThreshold": 3 }
}
```

An occasion can name a model too: `"reviewByOccasion": {"plan-review": {"model": "<model-id>"}}`.
