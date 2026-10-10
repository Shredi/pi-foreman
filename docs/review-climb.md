# Review climb, occasions, panel and findings

> Covers how the reviewer escalates (`ladder.reviewerClimb` modes), the four review occasions, the different-model
> rule, plan review, the shadow-model panel, the findings store with `foreman findings` and `foreman retro models`,
> and what stays on the machine. Read it when you tune reviewer cost against catch rate (base triggers: [ladder](ladder.md)).

## Climb modes

`ladder.reviewerClimb` applies to `reviewer` launches the foreman passed no model for; `senior-reviewer` never climbs.
Only user or overlay config can set it.

| Key | Default | Meaning |
|---|---|---|
| `ladder.reviewerClimb.enabled` | `false` | Master switch (both `claude-bridge` presets turn it on). |
| `ladder.reviewerClimb.mode` | `repeat-fail` | `repeat-fail`: the second FAIL of one item goes one rung up, plus the security rung. `on-find`: per-item climb below. |
| `ladder.reviewerClimb.rungs` | `[]` | Reviewer models of the on-find climb, bottom first (`<provider>/<model>[:<level>]`). Empty means `[roles.reviewer, roles.reviewer.strong]`. |
| `ladder.reviewerClimb.securityRung` | unset | Model for a security-shaped diff (see [ladder](ladder.md)). |

**On-find.** Each ledger item has its own climb. A reviewer verdict on the item moves it one rung up when it is a FAIL,
or a PASS whose report still locates a defect (a bullet naming a changed file with a line or a class word). A clean
PASS ends the climb; a finding on the top rung ends it too.

| Trace | Fields | When |
|---|---|---|
| `rung_up` | `role, from, to, reason: on_find, item` | An item moved up a rung. |
| `climb_done` | `role, rungs, reason: clean\|exhausted, item` | The item's climb ended; `rungs` = reviews it took. |

The next reviewer launch starts on the highest rung any item with an open climb has reached, else on rung 0. A
climb is per item and starts over for the next one, and it clears when the bound ledger changes. A security-shaped
diff still launches on the security rung and the repeated-FAIL rule still applies, but above rung 0 the on-find rung
wins over the repeated-FAIL rung (one rung up at most). Only reviews that count (below) feed the climb.

## Review occasions

One mechanism serves every review: the same launch path, climb rung, model rule, extractor and records. The occasion
is read from a marker in the reviewer's task text.

| Occasion | Marker | Reviews | Counts for items and gates |
|---|---|---|---|
| `item` | none | Built ledger items | yes |
| `plan-review` | `[plan-review]` | The plan, before the checkpoint | no |
| `pre-pr` | `[pre-pr]` | The whole branch diff before a PR | yes |
| `second-opinion` | `[second-opinion]` | Advice on unchanged work (also exempt from `ceremony.reviewPerRevision`) | no |

"Counts" means the verdict marks items, satisfies the review gate and PR gate, feeds the repeated-FAIL and on-find
climbs. A plan review, a second opinion and every panel shadow are recorded as findings only and never block.
`[second-opinion]` wins over `[plan-review]`, which wins over `[pre-pr]`.

## Different-model rule

A review by the model that built the work is weak evidence. On every `reviewer` launch, when the resolved model is the
foreman's own (base ids, the thinking level ignored), the harness moves it to the next climb rung that differs, else
to `ceremony.reviewModel` (default `null`, user or overlay config only). Trace `review_model {role, from, to, reason:
same_as_foreman}` (+ `policy_override` when the rank policy would refuse the pick). With no differing rung and no
`reviewModel` the launch proceeds unchanged and the trace says `reason: no_alternative`. The rule applies whether or
not the climb is enabled.

## Plan review

With `ceremony.planReview.<tier>` on (heavy by default, see [ceremony](ceremony.md)), `foreman_checkpoint` refuses
with `plan_review_required` until a `[plan-review]` reviewer run ended with a verdict for the current plan, keyed by
the SHA-1 of the plan file's bytes. Verdicts are kept per plan path (in memory, for the session); a new plan path
starts a new lineage. The first FAIL of a lineage refuses once with `plan_revision_required`, so the planner revises
before the owner sees it; once the revised plan (new bytes) has a verdict, the checkpoint opens whatever it says. The
owner's dialog shows `Plan review: PASS|FAIL (reviewer <model>)` and up to 8 located findings (`file:line class note`).
Trace `plan_review {model, decision}`. The foreman's instructions carry the plan-review step only while it is on
(`<!--planReview=on-->` variant). Plan review uses the model rule and the climb like any other occasion.

## Review panel

`ladder.reviewPanel` adds shadow reviewers beside the primary. User or overlay config only; off while `shadows` is empty.

| Key | Default | Meaning |
|---|---|---|
| `ladder.reviewPanel.shadows` | `[]` | Shadow models, `<provider>/<model>[:<level>]`. Empty = off. |
| `ladder.reviewPanel.gates` | `[pre-pr]` | Occasions that get the panel (`item`, `plan-review`, `pre-pr`, `second-opinion`). |
| `ladder.reviewPanel.visible` | `true` | Show the shadows' findings to the foreman. |

On a gate occasion a `reviewer` launch becomes a parallel group: the primary plus one entry per shadow, same task
text, `policy_override: true` (the shadows are explicit config, like the security rung). A shadow equal to the primary
or the foreman model is left out. Trace `panel {role, gate, models, primary}`.

Only the primary's verdict counts: shadows set no marks and no PR gate, and never block. The run end appends an
attributed block to the result: the primary's findings, then "Shadow findings (do not block)" grouped by model. A
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

`source` is `live` for the primary, `panel` for a shadow, `bench` for bench runs. A finding `id` is 12 hex characters of
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

## Example overlay

Cheap model first, strong model above it, a second vendor's model as a silent shadow before a PR, and a fallback for
when the foreman runs on the cheap model:

```json
{
  "ladder": {
    "reviewerClimb": {
      "enabled": true,
      "mode": "on-find",
      "rungs": ["<provider>/<cheap-model>:medium", "<provider>/<strong-model>:high"]
    },
    "reviewPanel": {
      "shadows": ["<other-provider>/<other-model>"],
      "gates": ["pre-pr"],
      "visible": true
    }
  },
  "ceremony": { "reviewModel": "<provider>/<strong-model>" },
  "retro": { "panelThreshold": 3 }
}
```
