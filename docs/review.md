# Review: occasions, model rule, panel and findings

> Covers the four review occasions, the different-model rule, plan review, per-occasion overrides
> (`ceremony.reviewByOccasion`), the shadow-model panel, the findings store with `foreman findings` and
> `foreman retro models`. Read it when you tune reviewer cost against catch rate (base triggers: [ladder](ladder.md)).

## Reviewer escalation

A `reviewer` launch the foreman passed no model for runs on `roles.reviewer`. `ladder.reviewerClimb` (user or overlay
config only; `enabled` defaults to `false`, both `claude-bridge` presets turn it on) adds two triggers: the second FAIL
of one ledger item sends the next launch to `roles.reviewer.strong` (`rung_up` reason `review_fail_repeat`), and a
security-shaped diff sends it to `ladder.reviewerClimb.securityRung` (reason `security`; see [ladder](ladder.md)).
There is no climb on a finding: see [Why one reviewer](#why-one-reviewer).

The gate's classifier is a separate path: one cheap model call clears a dangerous-class tool call only by citing a sentence of the owner's whitelist, in any session kind; see [permissions](permissions.md#the-classifier).

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
The PR gate checks the head only when the PR is created. After that the session's [PR watch](tools.md#watch) reports drift: when the PR head moves to a commit with no counting PASS (`head <sha> not reviewed (last PASS on <sha>)`, once per head), the tracker row shows `unreviewed head` and `pr_status` carries a `review` line; a PASS on the new head clears all three.
`[second-opinion]` wins over `[plan-review]`, which wins over `[pre-pr]`.
A marker counts only as a standalone token: preceded by the start of the text, whitespace or an opening bracket, and outside backtick spans, fenced blocks and `[pi-foreman ...]` harness lines. A mention in backticks is not an occasion. The `role_launch` trace of a reviewer carries `occasion`, and the launch result adds `occasion: second-opinion (advisory: marks no items, does not open the review gate)` (or the plan-review/pre-pr equivalent) when the occasion is not `item`, so a misclassified review is visible before it runs.

The reviewer diff-scan base is set at the first builder launch and resets on an owner prompt and when the session writes a new `.workflow/LEDGER-*.md` (the round boundary), so the next builder launch records the round's base.

### Scope of a review

The ledger is the scope source. The adapter prepends the ledger text to every `reviewer` launch: the cited items when the task cites any (`item 3`, `#3`), else the whole ledger (header and items). The binding is the session marker, so a review launched with `cwd` in a worktree gets it too. The adapter does not append the owner's prompt. A diff fact is in scope when the prepended ledger block or the task text asks for it; the reviewer quotes the ledger item that asks for the change, else FAIL. A foreman statement in the task never overrides a fact. Because the ledger is the only scope source, an item the foreman upserts mid-round also widens scope; a future round can snapshot the ledger at checkpoint approval.

## Readiness of a PR

The review record in the session keeps the occasion of the review (`item`, `pre-pr` and so on). A record from an older session entry has none and never counts as a `[pre-pr]` PASS.

A PR is ready to merge only on a `[pre-pr]` PASS that is the session's newest code review and covers the pushed head, with no work since (see [draft handling](tools.md#draft) for the whole rule). An `item` PASS is not enough; an `item` review after the `[pre-pr]` PASS ends readiness until a new `[pre-pr]` PASS. The PR gate itself is unchanged: `pr_create` still opens on any code review PASS for the head (see [safety](safety.md)).

## Verdict file

When a reviewer run ends with a verdict, the adapter appends one last line to that run's `<runId>_reviewer_output.md` (the artifact pi-subagents wrote just before the run-end event): `Head: <full sha>` when HEAD of the run's cwd is unchanged since launch (or moved only by a commit whose tree id is exactly the tree id of the working-tree snapshot taken at launch: any head whose tree id equals the snapshot, typically the commit issued in the launch's own message; the `review_recorded` trace event then carries `via: "same_tree"`; a commit that leaves out or adds any file or changes a mode, or a snapshot that cannot be taken or compared, stays `head_moved`), else `Head: unknown (<why>)` with the reason the review carries no head (`no_launch_head`, `cwd_unmatched`, `head_moved`, `head_unread`). A reviewer's own text may quote a `Head:` line, so a reader takes the last match. A run without an output file gets no line (the file is never created).

## Re-review after a FAIL

A review launched after a FAIL checks only the items that failed: the harness prepends the line `[re-review items: 2, 4]` (the `N. FAIL` items of the last FAIL verdict, cleared by a PASS) to a plain `item` review task, and the verdict must list each of them as `N. PASS` or `N. FAIL`; an item is marked only from an unqualified `N. PASS` line (`N. PASS`, `N. PASS: …`, `N. PASS - …`, `N. PASS — …`, `N. PASS evidence`). A qualified PASS (PASS followed by `(` or `[`, or by the word `partial`/`partially`, any case) and `N. PARTIAL` never mark (a plain `N. PASS` line for the same item wins over a qualified one: it marks and adds no note); for each such item that is still open the harness adds a ledger note `reviewer: <the line after the number, one line, at most 200 chars>` and leaves its state alone (traced as `noted` in `ledger_mark_by_review`). No count caps the review runs: reviews run until one passes, and the loop guard stops a round that repeats the findings of the round before or stalls with no diff and no new finding (`[review_loop]`; a new owner prompt, an answered `ask_user_question`, a `/ceremony` tier change or a parent-written `ruling-<n>.md` or `brief-<x>.md` in the session's handoff dir lifts it; see [ceremony](ceremony.md)). Every review run, re-reviews and panel shadows included, traces `review_done` at its run end. A `reviewer` launched after a FAIL also gets the first line `[pi-foreman re-review] Review the revision diff since <sha of the reviewed head> …` (targeted tests only, no tsc or full suites; "the reviewed head" when the sha is unknown); `[plan-review]`, `[pre-pr]` and `[second-opinion]` tasks get none. The line follows the last FAIL in the session until a PASS or an owner prompt.

## One reviewer per revision

With `ceremony.reviewPerRevision` (default on) a reviewer launch after a PASS is refused unless something changed since that PASS. The harness records the PASS time, the number of completed builder runs, HEAD, the working-tree content (tracked and untracked, non-ignored files; `worktreeTree`) and the bound ledger path, and compares them at the next launch; any one difference allows the launch (trace `review_dup_allowed` with `signals`). The working-tree comparison (`treeChangedSince` in `extensions/core-adapter/commentonly.ts`, not raw hash equality) ignores paths under `.workflow/` (ledger and notes), so writing those alone is no change. Otherwise the refusal reads: `pi-foreman: the last review passed at <HH:MM:SS> and nothing changed since (no builder run, HEAD, worktree or ledger change) — finish, or revise first. Ask for a second review only when warranted: put "[second-opinion]" in the reviewer task text.` (`at <HH:MM:SS>` is omitted when no PASS mark exists.) The finish gate's comment-only touch-up relief is separate and unchanged.

## Critique

After its verdict, a `reviewer` report carries a CRITIQUE block (agents/reviewer.md) in a fixed format:

```
CRITIQUE:
- [now] <a simplification one builder commit makes>
- [later] <simplify later>
```

or `CRITIQUE: none`. It lists overengineering, niche checks beyond the item's scope, one-caller abstractions, flags or
options nothing sets and tests of mocks. The foreman sends the `now` lines back to the builder in the same revision and
records the `later` lines in result.md. Critique never turns a PASS into a FAIL on its own: the
verdict parsing (`verdictOf`, the `N. PASS` marks, the re-review items) skips the block (`withoutCritique` in rounds.ts).
There is no extra review pass and no other reviewer model for it. Each counted review traces how many critique lines
it raised and how many `now` lines a builder revision took, with the diff size: see
[retro](retro.md#critique-counter).

## Different-model rule

A review by the model that built the work is weak evidence. On every `reviewer` launch, when the resolved model is the
foreman's own (model ids, the thinking level ignored; the same model id under another provider counts as the same model), the harness moves it to the next rung that differs, else
to `ceremony.reviewModel` (default `null`, user or overlay config only). Trace `review_model {role, from, to, reason:
same_as_foreman}` (+ `policy_override` when the rank policy would refuse the pick). With no differing rung and no
`reviewModel` the launch proceeds unchanged and the trace says `reason: no_alternative`. The rule applies whether or
not the repeat-fail climb is enabled. The automatic rule compares ids without the provider name (`provA/model-x` and
`provB/model-x` are one model), for the entry, for the rung or `reviewModel` it may move to and for the occasion
exception below. A configured pair is used as set, also a pair onto the foreman's own model or onto the same id under
another provider, without a warning. At high stakes a differing `ceremony.highStakes.model` applies and wins over a pair
on the foreman's model (`paired_skipped`).

The rule judges the foreman's **live** model (the model running the turn, which is the idle rung's model while the
foreman is downshifted, see [ladder](ladder.md#idle-rung-foreman-downshift)), not the base model the rank checks keep.

Roles (`roles.reviewer`, `.strong`), explicit launch models and the security rung keep the rank check and this rule.
A model written by `ceremony.reviewByOccasion` or `ceremony.highStakes.model` is used as set: see below.

**Missing pair.** When no `ceremony.reviewModel` pair covers the live foreman model and the reviewer would be swapped
(`same_as_foreman`) or stay on the foreman's model (`no_alternative`, which includes an unmapped reviewer that inherits
it), the harness warns once per model (at session start and on a model change, a UI notice, never system-prompt text)
and `/foreman doctor` prints a `WARN` line naming the model and the key `ceremony.reviewModel["<provider>/<model>"]`.
The warning is advice only and never blocks a launch.

### Reviewer pairs

`ceremony.reviewModel` may also be a map from a foreman model to a reviewer model, `"<provider>/<model>":
"<provider>/<model>[:<level>]"`. The harness looks the live foreman model up in the map first (the level of the
foreman model is ignored); a hit replaces the reviewer's model with the pair (`review_model {from, to, reason:
paired}`), whether or not the role map's model would have differed. A foreman model without a pair takes the rule above
against the live model. A pair always replaces the entry's model together with its level, even when the entry already has the pair's model.

A pair overrides the role-mapped model and a repeat-fail climb (the climb's `rung_up` trace is then not written, so the
trace never names a rung the launch does not use). It never overrides three pins, traced `review_model {reason:
"paired_skipped", pin}`:

- `explicit`: a model the launch call set and the child rank policy allowed (`explicitModelAllowed`);
- `security_rung`: the model of a security climb (`ladder.reviewerClimb`);
- `occasion`: a model set by `ceremony.reviewByOccasion` (or by `ceremony.highStakes.model`).

An occasion model that equals the live foreman's base is the exception: that foreman's pair replaces it (`reason:
paired`), else today's rule moves it to the next differing rung of `roles.reviewer` / `.strong`, else to the string
`reviewModel`, else `no_alternative`. An occasion model with a differing base stays (`paired_skipped`, pin `occasion`).
An occasion's thinking override still replaces the level of a pair, and applies to the model moved to. Invalid map entries (a value that is not a
string, a key without a `/`) are dropped with a config warning; `foreman doctor` checks the pair values against the model
registry. Two neutral examples:

```json
{ "ceremony": { "reviewModel": { "provider-a/big": "provider-b/mid:high", "provider-b/mid": "provider-a/big" } } }
```

A two-provider pair (each foreman is reviewed by the other provider's model) and, as a separate map, a same-provider
pair between two tiers:

```json
{ "ceremony": { "reviewModel": { "provider-a/big": "provider-a/mid", "provider-a/mid": "provider-a/big" } } }
```

## Plan review

With `ceremony.planReview.<tier>` on (heavy by default, see [ceremony](ceremony.md)), `foreman_checkpoint` refuses
with `plan_review_required` until a `[plan-review]` reviewer run ended with a verdict for the current plan, keyed by
the plan version hash (sha256 of the plan body above any `## Ruling`, `## Rulings`, `## Parent ruling`,
`## Decision log`, `## Addendum…` heading or `<!-- plan-appendix -->` line; see [ceremony](ceremony.md)). A ruling appended
below such a heading neither needs a new review nor resets the checkpoint; a body edit is a new version. Verdicts are kept per plan path (in memory, for the session); a new plan path
starts a new lineage. A FAIL below the round cap refuses with `plan_revision_required`: the foreman revises the plan with the findings and has
it reviewed again until it passes, asking nobody while the findings are defects or gaps. A finding that needs a decision
(the reviewer marks it `DECISION:` after the verdict word of its item line, `3. FAIL: DECISION: ...`; prompt only, the
adapter does not parse it) goes to the checkpoint with a FAIL, which opens at the round cap
(`ceremony.planReviewRounds`). The
owner's dialog shows `Plan review: PASS|FAIL (reviewer <model>)` and up to 8 located findings (`file:line class note`).
The `[plan-review]` runs are not capped; the loop guard stops a plan review that fails again on the same plan version with the same findings or nothing new, and a revised plan that fails again with the same located finding (`at:` key); new findings under the same ledger item on a revised plan do not stop it (see [ceremony](ceremony.md)). A finding located in the ledger keeps stopping revised plans, because the ledger does not change between plan versions.
The facts block of a `[plan-review]` launch also has one `Owner section (<plan>): ...` line per plan; the reviewer FAILs a plan whose `## For the owner` section is missing, not the first `##` section, too long (over about 10 lines), without the implicit decisions, or full of jargon (see [ceremony](ceremony.md)).
Trace `plan_review {model, decision}`. The foreman's instructions carry the plan-review step only while it is on
(`<!--planReview=on-->` variant). Plan review uses the model rule like any other occasion.

## Security findings

The one `reviewer` is modular: `roles.reviewer.skills` names the shipped `security-review` skill (`skills/security-review/SKILL.md`), which the reviewer reads from its catalog and applies when the diff touches secrets, permissions, destructive commands, trust boundaries or untrusted input. There is no separate security reviewer role.

The threat model in that skill is the scope of a security finding. The shell guards are guardrails against accidents by the harness's own agents, not a sandbox against an attacker; a `SECURITY:` line is only for a break of a hard floor (secrets, a child's publish or off-branch push, deletes outside its own worktree, a child changing guard or permission config, injection). Parser bypasses go to the report as `- [later]` CRITIQUE lines.

A finding line starting `SECURITY:` (the agent file tells the reviewer to prefix security findings so) is an ordinary finding for the loop guard and puts the answering revision on the strong rung (`strongOnRevision`); no count limit exists for it to bypass.

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
used as set, like a pair: the rank policy does not refuse it, and when it would have refused it the trace carries
`policy_override: true`. The skip is per launch entry; another entry of the same launch that carries the same model
through the role map is still checked. Trace `review_occasion {occasion, thinking, model_overridden}`.

### High stakes

A reviewer launch is high stakes when any rule fires: `occasion` (`plan-review` or `second-opinion`), `heavy_pre_pr`
(`pre-pr` on the heavy tier), `risk_tag` (a builder launch of this session since the last counted review carried a
risk tag `security`, `guard` or `permission`) or `sensitive_path` (the work diff the reviewer sees touches a path
matching `ceremony.highStakes.paths`). Every high-stakes launch writes `review_stakes {role, occasion, level: high,
reasons, tags?, paths?, model_applied}` (`reasons` and `tags` are comma-joined, `paths` is the number of matching
paths). Low and medium launches write nothing.

| Key | Values | Meaning |
|---|---|---|
| `ceremony.highStakes.model` | `<provider>/<model>[:<level>]`, default `null` | Model of a high-stakes reviewer launch whose occasion has no model of its own. |
| `ceremony.highStakes.paths` | glob list, default `[".github/workflows/**"]` | Diff paths that make a launch high stakes; a list replaces the default. |

Precedence: the occasion's own `reviewByOccasion.<occasion>.model`, then `ceremony.highStakes.model`, then the pair or
the different-model rule; the security climb wins over both. `highStakes.model` is used as set, like an occasion
model. Unset, the model never changes. User or overlay config only; the PR gate and merge flow are unchanged.

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

A neutral overlay with an everyday pair to a mid model and the top model for plan-review and second-opinion:

```json
{
  "ceremony": {
    "reviewModel": { "provider-a/big": "provider-a/mid" },
    "reviewByOccasion": {
      "plan-review": { "model": "provider-a/top" },
      "second-opinion": { "model": "provider-a/top" }
    }
  }
}
```
