# Review: occasions, model rule, panel and findings

> Covers the review occasions (four config-facing ones and the `[high-stakes]` pass), the different-model rule, plan review, per-occasion overrides
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
is taken from the launch field `occasion` of the reviewer entry; a marker at the head of the task text works as a backup (see below).

| Occasion | Field value and marker | Reviews | Counts for items and gates |
|---|---|---|---|
| `item` | none | Built ledger items | yes |
| `plan-review` | `occasion: "plan-review"`, `[plan-review]` | The plan, before the checkpoint | no |
| `pre-pr` | `occasion: "pre-pr"`, `[pre-pr]` | The whole branch diff before a PR | yes |
| `high-stakes` | `occasion: "high-stakes"`, `[high-stakes]` | The whole change, one extra pass on a risky change (see [High stakes](#high-stakes)) | no: marks no items, writes no normal review record |
| `second-opinion` | `occasion: "second-opinion"`, `[second-opinion]` | Advice on unchanged work (also exempt from `ceremony.reviewPerRevision`) | no |

"Counts" means the verdict marks items, satisfies the review gate and PR gate, feeds the repeated-FAIL rule. A plan review, a second opinion and every panel shadow are recorded as findings only and never block.
The PR gate checks the head only when the PR is created. After that the session's [PR watch](tools.md#watch) reports drift: when the PR head moves to a commit with no counting PASS (`head <sha> not reviewed (last PASS on <sha>)`, once per head), the tracker row shows `unreviewed head` and `pr_status` carries a `review` line; a PASS on the new head clears all three.
**The launch field.** `occasion` (`pre-pr`, `high-stakes`, `plan-review` or `second-opinion`) is a key of a single reviewer launch (a reviewer in a `tasks`, `chain` or `parallel` group is refused, `review_single_launch`); a non-reviewer entry of a group may carry it (no effect). Like `size` and `risk` it may arrive as JSON text, and a copy placed in `options` or `args` is moved to the entry. It never reaches pi-subagents. On a `tasks` or `chain` call itself, or with another value, the launch is refused (`[review_occasion_unknown]`); on a builder or other non-reviewer entry a valid value has no effect (an unknown value is refused on any entry), and a tag in a builder's task is no review kind. When only the field names the kind, the harness puts `[<kind>] ` in front of the reviewer's task, so the reviewer and later steps see it.
The sources of a reviewer entry are the field, `reason: "second-opinion"` and the head run of its task: the leading `[tag]` or `[[tag]]` tokens (other tokens such as `[panel-shadow:<model>]`, `[[replay:<id>]]` or `[re-review items]` are skipped). All present sources must name one kind; otherwise the launch is refused (`[review_occasion_ambiguous]`, traced, also with the high-stakes feature off): keep one. With the sources agreeing, the head run settles by this order: `[second-opinion]` wins over `[plan-review]`, which wins over `[high-stakes]`, which wins over `[pre-pr]`; a head run that names both `[pre-pr]` and `[high-stakes]` (and neither `[second-opinion]` nor `[plan-review]`) is ambiguous whatever the field says. `high-stakes` is not a config-facing occasion: it is no `ceremony.reviewByOccasion` key and no `ladder.reviewPanel.gates` entry, so no panel shadow attaches to it. A reviewer launch with no source is a normal `item` review, unless its text names a kind tag later on: that is refused (`[review_occasion_late]`) with the fix `set occasion: "<kind>" on the launch (or put [<kind>] first in the task)`. With a source present, tags later in the text are mentions.
A tag counts only as a standalone token: preceded by the start of the text, whitespace or an opening bracket, and outside backtick spans, fenced blocks and `[pi-foreman ...]` harness lines. A mention in backticks is not an occasion. The `role_launch` trace of a reviewer carries `occasion`, and the launch result adds `occasion: second-opinion (advisory: marks no items, does not open the review gate)` (or the plan-review/pre-pr equivalent) when the occasion is not `item`, so a misclassified review is visible before it runs. While a high-stakes review is due (a trigger fired and none has run), the `pre-pr` line adds `; a [high-stakes] review is due (<reasons>); launch it if the change warrants it`, and an `item` review gets that reminder as a line of its own (a reminder only, nothing is refused): a fired trigger does not change the class of a `[pre-pr]` launch, whose PASS counts as pre-pr.

The reviewer diff-scan base is set at the first builder launch and resets on an owner prompt and when the session writes a new `.workflow/LEDGER-*.md` (the round boundary), so the next builder launch records the round's base.

### Scope of a review

The ledger is the scope source. The adapter prepends the ledger text to every `reviewer` launch: the cited items when the task cites any (`item 3`, `#3`), else the whole ledger (header and items). The binding is the session marker, so a review launched with `cwd` in a worktree gets it too. The adapter does not append the owner's prompt. A diff fact is in scope when the prepended ledger block or the task text asks for it; the reviewer quotes the ledger item that asks for the change, else FAIL. A foreman statement in the task never overrides a fact. Because the ledger is the only scope source, an item the foreman upserts mid-round also widens scope; a future round can snapshot the ledger at checkpoint approval.

## Readiness of a PR

The review record in the session keeps the occasion of the review (`item`, `pre-pr` and so on). A record from an older session entry has none and never counts as a `[pre-pr]` PASS.

A PR is ready to merge only on a `[pre-pr]` PASS that is the newest code review recorded for the pushed head, with no send-back since (other work in the session does not count; see [draft handling](tools.md#draft) for the whole rule). An `item` PASS is not enough; an `item` review after the `[pre-pr]` PASS ends readiness until a new `[pre-pr]` PASS. The PR gate itself is unchanged: `pr_create` still opens on any code review PASS for the head (see [safety](safety.md)), and a due [high-stakes review](#high-stakes) only reminds (the PR tool's answer carries the reminder); an uncleared high-stakes FAIL still holds.

## The verdict tool

A reviewer gives its verdict through the tool `review_verdict`, not through its report. The harness reads gates, marks and the repeat stop only from this call; the report is for the foreman to read and no harness code reads meaning from it (the widened rule of `AGENTS.md`).

The call carries:

- `verdict`: `pass`, `fail` or `incomplete`. `incomplete` (with a one-line `reason`) means the reviewer could not run its checks: gates see no verdict, the foreman sees the reason, and a high-stakes run that ends so is not counted as used.
- `items`: a result (`pass`, `fail` or `open`, with an optional one-line `note`) per ledger item. V is an item like any other and closes V as the fresh verifier only when the launch's `items` field named it.
- `findings`: `{kind, text, file?, line?, class?}` with `kind` `defect`, `now` or `later` (see [Critique](#critique)). Only `defect` findings feed the repeat-stop key and the [findings store](#findings-store); a `class` is one of the store's classes.

The tool checks the call in the reviewer's turn and returns an error that names the valid choices: a `pass` with a failed item or a `defect` is refused, a `fail` needs a failed item or a `defect`, an item id must be one of the launch's items (a `[high-stakes]` launch takes none), no id twice, size caps. A second call replaces the first and the answer names the given items it left out; they stay open. The call does not end the run.

The launch carries the items: the foreman sets the `items` field (`items: [1, 4, "V"]`, a key beside `agent` and `task`, declared in the schema the model sees and stripped before pi-subagents sees the call; inside `options` it is lifted to the top level like `reason`). An id that is not open on the ledger the launch routes to is refused (trace `launch_refused`, reason `items_unknown`, naming the open ids). Without the field the launch takes every open item except V, and a plain `item` review after a FAIL takes the failed items that are still open (the re-review default above); with the field the launch takes exactly the items it names. Every review task of a single launch ends with a line naming that set (`[pi-foreman verdict items] review_verdict takes results for these items only: 1, 2. ...`, or `this launch takes no items` for a `[high-stakes]` launch), built by the same helper the tool reads (`allowedItems`, `launchItemsLine`), so a plan reviewer that reads the open V line in the facts block is told not to give a result for it; the re-review line lists only the failed items that set takes. The tool refuses an id outside the launch's items and names the valid ones.

The record lives in `<agentDir>/pi-foreman/state/review-records/<session>/<launch>/verdict.json`, a folder the harness makes for each review launch (mode 0700) and protects like the child-ask folder: no tool call or shell line of a session writes it. A launch whose folder cannot be made is refused (`review_record_dir`, with the OS error). The parent reads the record once at the run end, validates it as untrusted input (JSON, version, launch id, the tool's schema, every item id in the launch's items; anything else is no verdict, trace `review_record_invalid`) and renames it to `verdict.<runId>.json`; the completion notice and a reload read it from there. A record of a run that did not complete is ignored (`review_record_ignored`). The folder lives for the session (a resume writes into it again; a resume after a session restart re-creates it) and goes at session end; folders of sessions untouched for 7 days are swept at session start.

Failure paths:

| Case | Result |
|---|---|
| The reviewer ends without the call | Held once with a reminder before it ends; then no verdict: the review step stays open, nothing is marked, `review_done` with `no-verdict`. |
| Timeout, turn cap, crash, stop | No verdict; a record is ignored. |
| A reviewer started before the update, or whose settings were not regenerated | The tool refuses (no record folder), or its adapter records `incomplete` with the reason `review_verdict is not in this reviewer's tool list; run /foreman setup`. Run `/foreman setup` after the update; `/foreman doctor` flags the drift. |
| A group launch (`tasks`, `chain`) naming a review role | Refused (`review_single_launch`): pi-subagents forwards a launch binding only for a single launch. Launch each reviewer as its own call. |
| Reload while a reviewer runs | Gates see no verdict (as before); the completion notice marks the record's items and opens the round from the persisted route, and marks nothing for an occasion that does not count (`[plan-review]`, `[second-opinion]`, a panel shadow). |
| `[plan-review]`, `[second-opinion]`, `[high-stakes]`, panel shadow | The record is read; it marks nothing, V included. |

**What the channel does not stop.** The tool stops misreads and accidents, not a foreman that cheats on purpose. A foreman can start a pi process by hand with a forged reviewer binding that names a real record folder (the review bench starts reviewers this way); it writes the reviewer's task and can resume a failed reviewer and press it toward a pass. The gates hold against misreads, accidents and casual shortcuts; the owner's look at the PR remains the last check.

## Verdict file

When a reviewer run ends with a verdict, the adapter appends one last line to that run's `<runId>_reviewer_output.md` (the artifact pi-subagents wrote just before the run-end event): `Head: <full sha>` when HEAD of the run's cwd is unchanged since launch (or moved only by a commit whose tree id is exactly the tree id of the working-tree snapshot taken at launch: any head whose tree id equals the snapshot, typically the commit issued in the launch's own message; the `review_recorded` trace event then carries `via: "same_tree"`; a commit that leaves out or adds any file or changes a mode, or a snapshot that cannot be taken or compared, stays `head_moved`), else `Head: unknown (<why>)` with the reason the review carries no head (`no_launch_head`, `cwd_unmatched`, `head_moved`, `head_unread`). A reviewer's own text may quote a `Head:` line, so a reader takes the last match. A run without an output file gets no line (the file is never created). **One order: review, commit the reviewed files unchanged, push, `pr_create`.** A review's record keeps the tree of the content the reviewer saw (`tree`: the work tree without `.workflow/` at the end of the run, set only when it equals the tree at launch). A commit made later whose tree without `.workflow/` equals that tree gets a copy of the PASS (`via: same_tree`; the alias is not a review round), so the PR gate, `pr_create`, `pr_status`, the PR watch and the finish accept it; a commit that adds or changes anything, or only part of the reviewed files, has another tree and makes the review stale. The alias needs the PASS to be the checkout's newest code review, and any record at that head, or a newer code-review FAIL on the same tree in any checkout, blocks it. While any high-stakes FAIL of the session is uncleared, in any checkout, no alias is made, and the source PASS must be newer than every high-stakes FAIL of the session, cleared or not; a record without `tree` (older entries, or content that changed while the reviewer ran) keeps the head rule only.

## The review gate per checkout

The state "a reviewer PASS stands, or work was revised after it" is kept per checkout (the git top-level of the directory a review or a builder ran in), not once per session. A builder run, a project edit or a `foreman_move` in checkout B marks only B as revised: a PASS in checkout A still stands for the finish gate, for `foreman_ledger` V, for the repeat-review refusal and for `pr_create` in A. A reviewer PASS in B clears B only; a review launch is one run in one checkout, so a verdict covers the checkout it ran in. A directory the harness cannot resolve to a checkout is *unknown*: work there revises every checkout, a PASS there clears only the session-wide entry, a FAIL or missing verdict opens every checkout. The finish refusal names the open checkouts and why (`(re-review needed: <path>: built, no review yet; <path>: revised after the last PASS)`); with only the session's own checkout open it keeps the older text. The gates and the PASS marks of every checkout are stored in the ceremony-state entry and restored on `/reload`; an entry from before this change is read as the session-wide entry.

## Re-review after a FAIL

A review launched after a FAIL checks only the items that failed: the harness prepends the line `[re-review items: 2, 4]` (the items the last FAIL record marked `fail` that are still open, cleared by a PASS) to a plain `item` review task, and the reviewer's `review_verdict` call must give each of them a result. Without an `items` launch field the allowed items of that launch are those failed items (never V; every open item except V when none of them is open). With the field, the allowed items are the ones it names and the line names only the failed items inside it (its second sentence then reads "These items failed a review since the last PASS; give each of them a result in review_verdict."), so it never asks for an id the tool refuses; no failed item inside it, no line. A launch with another occasion gets no line and every open item except V. An item is marked only from a `pass` result of the call. An item the call gives `open` with a note gets a ledger note `reviewer: <note>` and its state stays (traced as `noted` in `ledger_mark_by_review`); after a FAIL nothing is marked. No count caps the review runs: reviews run until one passes, and the loop guard stops a round that repeats the findings of the round before or stalls with no diff and no new finding (`[review_loop]`; a new owner prompt, an answered `ask_user_question`, a `/ceremony` tier change or a parent-written `brief-<x>.md` in the session's handoff dir lifts it (a `ruling-<n>.md` does not); see [ceremony](ceremony.md)). Every review run, re-reviews and panel shadows included, traces `review_done` at its run end. A `reviewer` launched after a FAIL also gets the first line `[pi-foreman re-review] Review the revision diff since <sha of the reviewed head> …` (run the tests the fix touches, and the full suites again when the fix since the last review can affect them; "the reviewed head" when the sha is unknown); `[plan-review]`, `[pre-pr]` and `[second-opinion]` tasks get none. The line follows the last FAIL in the session until a PASS or an owner prompt. After it the task carries the findings of the last normal-review FAIL (its `defect` and `now` findings, else the notes of its failed items) as a fenced data block `[pi-foreman earlier findings] …` (review tags defused, cut at 8 KB; none when that FAIL left neither; a high-stakes FAIL clears them, so after a normal FAIL that followed a high-stakes FAIL the task carries both blocks, and after a high-stakes FAIL that followed a normal FAIL only the high-stakes block). A child's refused read of another session's state names that block (`selfmod-state-read`: "On a re-review, the earlier findings are in your task …"); read rights are unchanged. A task that cites items and names `items` (or is narrowed to the failed items by a re-review) gets a ledger block that lists those allowed items, the ones `review_verdict` takes, not the cited ones. When the launch's `items` name numbered items outside the failed set, one sentence follows that line: "Items 3, 4: review them against the whole change, not only the revision diff." (V never counts; "Item 3:" for one).

## One reviewer per revision

With `ceremony.reviewPerRevision` (default on) a reviewer launch after a PASS is refused unless something changed since that PASS. The harness records the PASS time, the number of completed builder runs, HEAD, the working-tree content (tracked and untracked, non-ignored files; `worktreeTree`) and the bound ledger (its path and a per-session count of subject changes, saved with the ceremony state), and compares them at the next launch; any one difference allows the launch (trace `review_dup_allowed` with `signals`). The working-tree comparison (`treeChangedSince` in `extensions/core-adapter/commentonly.ts`, not raw hash equality) ignores paths under `.workflow/` (ledger and notes), so writing those alone is no change. The ledger count goes up by one for each item `foreman_ledger` adds or rewrites (`add`, `upsert`) and for each foreman `write` or `edit` of the bound ledger file (whatever it changes, a tick included); `mark`, `note` and `defer` through the tool and the harness's own marks after a PASS leave it alone, so they are no change. Otherwise the refusal reads: `pi-foreman: the last review passed at <HH:MM:SS> and nothing changed since (no builder run, new commit, changed file in the checkout, or ledger item added or rewritten) — finish, or revise first. Ask for a second review only when warranted: set occasion: "second-opinion" on the reviewer launch (or put "[second-opinion]" first in its task).` A launch counts as a second opinion only when every reviewer entry in it has that occasion. (`at <HH:MM:SS>` is omitted when no PASS mark exists.) The finish gate's comment-only touch-up relief is separate and unchanged.

## Critique

A `reviewer` gives simplification advice (agents/reviewer.md) as findings of kind `now` and `later` in its `review_verdict` call:

- `now`: a simplification one builder commit makes.
- `later`: a point to simplify or harden later, including guard or parser bypass ideas.

They list overengineering, niche checks beyond the item's scope, one-caller abstractions, flags or
options nothing sets and tests of mocks. The foreman sends the `now` findings back to the builder in the same revision and
records the `later` findings in result.md. Advice never turns a PASS into a FAIL on its own: the tool refuses a `fail` with
only `now` or `later` findings, and they enter no loop key and no findings-store entry.
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
another provider, without a warning. `ceremony.highStakes.model` plays no part in this rule: it belongs to the
`[high-stakes]` review only (see [High stakes](#high-stakes)).

The rule judges the foreman's **live** model (the model running the turn, which is the idle rung's model while the
foreman is downshifted, see [ladder](ladder.md#idle-rung-foreman-downshift)), not the base model the rank checks keep.

Roles (`roles.reviewer`, `.strong`), explicit launch models and the security rung keep the rank check and this rule.
A model written by `ceremony.reviewByOccasion` is used as set: see below. The `[high-stakes]` review is used as set too.

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
- `occasion`: a model set by `ceremony.reviewByOccasion`.

The `[high-stakes]` entry has a pin of its own, `high_stakes`, and takes no part in the pair or the rule at all.

An occasion model with the same id as the live foreman's base (provider and level ignored) is the exception: that foreman's pair replaces it (`reason:
paired`), else today's rule moves it to the next differing rung of `roles.reviewer` / `.strong`, else to the string
`reviewModel`, else `no_alternative`. An occasion model with a differing id stays (`paired_skipped`, pin `occasion`).
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
below such a heading neither needs a new review nor resets the checkpoint; a body edit is a new version. For an HTML plan (`plan-<topic>.html`) the version is the sha256 of the whole page and rulings go to `rulings-<topic>.md`; the reviewer reads the generated markdown copy `plan-<topic>.md` (see [ceremony](ceremony.md)). The facts block names the copy and lists hidden-style facts of the page: counts of `display:none`, `visibility:hidden`, CSS `content:`, `font-size:0`, `opacity:0` and the `hidden` attribute, which hide or add words the copy does not show (facts only, the reviewer judges). A `[plan-review]` launch naming the page or its copy is refused with `plan_copy_stale` when the copy on disk is not the current one after the harness tried to write it (a locked or read-only file, a full disk); the refusal names the cause, and no reviewer starts. Verdicts are kept per plan path (in memory, for the session); a new plan path
starts a new lineage. A FAIL below the round cap refuses with `plan_revision_required`: the foreman revises the plan with the findings and has
it reviewed again until it passes, asking nobody while the findings are defects or gaps. A finding that needs a decision
(the reviewer records it as a `defect` finding whose text starts `DECISION:`; prompt only, the
adapter does not read that word) goes to the checkpoint with a FAIL, which opens at the round cap
(`ceremony.planReviewRounds`). The
owner's dialog shows `Plan review: PASS|FAIL (reviewer <model>)` and up to 8 located findings (`file:line class note`).
The `[plan-review]` runs are not capped; the loop guard stops a plan review that fails again on the same plan version with the same findings or nothing new, and a revised plan that fails again with the same located finding (`at:` key); new findings under the same ledger item on a revised plan do not stop it (see [ceremony](ceremony.md)). A finding located in the ledger keeps stopping revised plans, because the ledger does not change between plan versions.
The form of the plan is checked by code before the reviewer starts: a `[plan-review]` launch is refused with `[plan_form]` (trace `launch_refused`, reason `plan_form`; no reviewer is started) when the plan's `## Summary` section (the older `## For the owner` is still accepted) is missing, empty, or not the first `##` section (diagram count and the plan-first headings are asked for by the instructions, not checked); a plan that cannot be read is not refused. The write or edit result of a plan file carries the same faults, and a separate advice line when the Summary reads like jargon (a path, an id; never a refusal). The facts block has one `Summary section (<plan>): ...` line per plan (`present (checked by the harness)` or the issues), followed by `; form hints: ...` when the Summary has no `**Goal:**` paragraph, no numbered steps or a box before other content (hints never refuse; the write result carries them as one more advice line). The reviewer does not fail for length or jargon; it fails the owner section only when it contradicts the plan or omits a decision the plan makes, and it covers the whole plan in its first review against a fixed list (claims about the code, callers and pinning tests, failure paths and modes, doc and config follow-ups, tests for named conditions, parts that disagree), reporting all findings of one pass and what it did not check. On a re-review of a plan with an earlier verdict the facts also carry the diff against the last reviewed version (at most 200 lines, header lines naming the plan path) and the instruction to verify the earlier findings and review the changed text in full. The last reviewed text is kept in memory only: after a reload, or when the plan changed while the reviewer ran, the facts say `no diff (the last reviewed version is not in memory)`. What fails a later review does not change (see [ceremony](ceremony.md)). To count the review rounds of a plan, count the trace events `plan_review` (one per verdict) and `launch_refused` with reason `plan_form` (refused before a reviewer started) of the session.
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

The high-stakes review is one extra reviewer pass on a risky change. It never replaces the model of a normal review:
item, `[pre-pr]`, `[plan-review]` and `[second-opinion]` reviews take the pair, the different-model rule and
`ceremony.reviewByOccasion` as if `ceremony.highStakes` did not exist. With no `ceremony.highStakes.model` nothing runs:
no state, no trace, no requirement.

| Key | Values | Meaning |
|---|---|---|
| `ceremony.highStakes.model` | `<provider>/<model>[:<level>]`, default `null` | Model of the `[high-stakes]` review; `null` = no high-stakes review. |
| `ceremony.highStakes.modules`, `ceremony.highStakes.lines` | any | Retired: accepted and ignored. The size of the change no longer matters; doctor says so when either is set. |
| `ceremony.highStakes.paths` | glob list | Retired: accepted and ignored. The sensitive-path rule no longer selects a model. |

User or overlay config only.

**The pass.** The foreman launches one `reviewer` alone with `occasion: "high-stakes"` (or `[high-stakes]` first in its task; see [occasions](#review-occasions)).
The launch runs on `ceremony.highStakes.model` exactly as set: no pair, no different-model move, no rank refusal (trace
`policy_override` when the policy would have refused), no climb, and no exception when the id equals the foreman's or the
normal reviewer's. An explicit `model` in the call is replaced (trace `model_override`); thinking is capped by `maxThinking`
and `childMaxThinking`. A `[research]` or `[fact-critical]` marker does not change its model. The adapter prepends the
ledger items like a `[pre-pr]` review and adds the line `occasion: high-stakes (the whole change against <base>: ...)`.
The reviewer reviews the whole change, not the last revision, and the diff-scan facts are collected against the same
base. It marks no ledger item, never closes V (the ledger tool refuses the mark for its child), is never refused as a
repeat and writes no normal review record, so PR readiness, the PR gate heads and the repeated-FAIL rule never see it.
Its findings go to the findings store with `--gate high-stakes`.

**When it is asked.** The change is risky, whatever its size; nothing is measured. The review is due for the session when
any of these happened:

- A builder launch carried a risk tag `security`, `permission`, `guard`, `concurrency` or `design` (fixed in code; `parser`
  does not count). The tags are read from the launch with `ladder.sizing` and the ladder on or off, but the foreman is told
  about the `risk` field only with launch sizing on, so with sizing off in practice only the next two apply. A malformed
  `size` drops the launch's tags.
- The task is heavy (tier `heavy`) and the session launched a builder or changed a project file. The reason `heavy` counts
  until the owner lowers the tier below heavy with `/ceremony`; a later `foreman_triage` or a raise that stays below heavy
  does not bring it back; a raise back to tier heavy (a heavy signal in a prompt, say) does. The tag and `foreman` reasons stay.
- The foreman launched a `[high-stakes]` review itself: a launch with no reason yet is allowed when a normal PASS stands,
  and the accepted launch adds the reason `foreman`.

The reasons are sticky for the session and one state serves the whole session, wherever the work lands: a builder
worktree that passed and was then merged into the main checkout asks for no second review, with a remote or without, and
a later tagged builder after the pass asks for nothing. Only the owner lowers the requirement, by unsetting the model,
which ends every high-stakes check at once (stored state is kept and not read). A large change alone never fires.

**The base.** The review reads the whole change against the merge-base of the checkout's HEAD with the PR base branch:
`safety.ops.baseBranch`, else the remote's default branch, against `<remote>/<base>` when that ref exists, else the
local branch. When no merge-base resolves (no remote, detached history) the base is the first HEAD the session saw in that
repository (a worktree shares its repository's), recorded at `session_start` for the session's own repository and at the
first builder launch for another one, when it is an ancestor of the checkout's HEAD. With neither the task line names no base and the facts keep the normal review
base. The base triggers nothing.

**Order and refusals.** A `[high-stakes]` launch is refused, first match wins, each traced as
`review_high_stakes_refused {reason}`:

| Reason | When |
|---|---|
| `high_stakes_unset` | No model is set. |
| `high_stakes_single` | The launch is inside a `tasks` or `chain` launch. |
| `high_stakes_resume` | The call resumes a run. A run that ended without a verdict, or with an `incomplete` verdict, is launched fresh. |
| `high_stakes_done` | The passes of the session are used up (the last pass was a PASS, or two ran) or one is still running (kept in memory only: after a reload nothing counts as running). |
| `high_stakes_early` | No normal PASS stands (none yet, or work was revised after it), or the session's last high-stakes pass is a FAIL that no normal PASS that got its findings has cleared. |
| `high_stakes_unrevised` | A reviewer `resume` while a high-stakes FAIL of its checkout is uncleared (a resume gets no findings). A fresh normal reviewer is never refused for it. |

After a second FAIL the answer is `high_stakes_done`, never `high_stakes_early`.

**An incomplete run.** A reviewer that must stop before it finishes, with no defect found, gives the verdict `incomplete` in `review_verdict` with a `reason` that names the checks that remain. A high-stakes run that ends so records nothing: it is no run (the two passes stay unused), the gate is unchanged, and the trace is `high_stakes {kind: incomplete}`. A fresh `[high-stakes]` launch is then judged on the state as it was before that run; there is no limit on incomplete runs, and each uses the high-stakes model. Resuming that run stays refused (`high_stakes_resume`). The adapter takes the reviewer's word: a run that gives `incomplete` although it found a defect leaves no record, and the next fresh high-stakes review checks again. A normal review with `incomplete` is no verdict.

**After a FAIL.** The FAIL is recorded with its head and findings, and the review gate is set to a failed verdict. It is
cleared by a normal PASS (item or `[pre-pr]`) of a run that got the findings: in the checkout the FAIL ran in at any head
(revised or not), in any other checkout when the PASS head is the FAIL head or builds on it (git ancestry); a FAIL recorded
with no head is cleared by such a PASS in any checkout of the same repository. A FAIL whose checkout was removed is cleared the
same way. The clear also sets the FAIL checkout's review gate entry to PASS when its PASS stood just before the FAIL and no work happened there since. Work
done there during the high-stakes run or afterwards keeps it open until a review there passes. Meanwhile:

- A fresh normal reviewer launch (item or `[pre-pr]`) is never refused for a missing revision: while the FAIL is uncleared,
  every one of them, in any checkout, gets the findings prepended, fenced and marked as data from an earlier review, with
  review tags defused. While `highStakes.model` is set the findings count as a change, so it is not refused as a repeat of a standing PASS (with no model set, today's repeat refusal stays). `[second-opinion]` and `[plan-review]`
  launches stay allowed. Any reviewer `resume` in the FAIL's checkout is refused (`high_stakes_unrevised`) until the FAIL is
  cleared, since a resume gets no findings block.
- A `[pre-pr]` launch after a FAIL is accepted like any normal reviewer: its PASS counts as a normal PASS, opens the PR gate on its head and can clear the FAIL.
- A PASS from a run that got no findings (launched before the FAIL) clears nothing.
- The finish gate carries its own entry "revise or answer the high-stakes findings, then pass the normal reviewer", whatever
  `ceremony.reviewGate` says.
- The head of a high-stakes FAIL never opens the PR gate (`pr_refused:high_stakes_failed`), nor does any head of the
  checkout the FAIL ran in (or of a head reviewed there) while the FAIL is uncleared; a PR from another checkout is not held by it. After the clear the FAIL head stays blocked, unless the clearing
  PASS was on that very head.
- The refusal and the finish hint say when the FAIL's checkout is gone, and what clears it.

Once a normal PASS cleared the FAIL, a second and last high-stakes pass is due like the first and reviews the whole
revised change. If the second pass fails too, the same steps follow, but no third pass: the normal PASS that got the findings
opens the gate, and the foreman tells the owner in one line that the second high-stakes review failed and on what.

**Gates.** A due pass (a reason counts and no pass yet, or one cleared FAIL) refuses nothing: the answer of the pack's
`pr_create` and of foreign PR tools carries "a [high-stakes] review is due (<reasons>); launch it if the change warrants
it", and so does the finish message. The state is the session's: any high-stakes PASS of the session satisfies the
requirement for every PR. An uncleared FAIL refuses `pr_create` from its own checkout (`pr_refused:high_stakes_failed`), and a PR whose head was reviewed in that checkout,
also `pr_create {cwd}` for that sibling; a PR from another checkout passes. The refusal names the checkout of the FAIL when it is not the session's own. With
`ceremony.reviewBeforePr: false` the PR gate is off and this check with it. The finish gate holds a standard or heavy
session once per set of reasons (once every ledger item except V is marked; no bound ledger, or an unreadable one, counts
as marked) with the reminder, then lets the next finish go with a one-line owner notice and the trace
`high_stakes_skipped`; a new reason holds once more. The hold itself traces `high_stakes_reminded {reasons}`. The hold is no refusal and does not count toward the two per prompt.
The FAIL entry of the finish gate does not depend on the ledger. A session that changed nothing is not held (files under `.workflow/` and the scratch dir do not count as a change; a scratch dir set to a source folder hides that folder from this check). A PR that is
already open is held only by a FAIL: its readiness answers `wip` while a FAIL stands uncleared in a checkout its head was reviewed in (a head no record names: any uncleared FAIL) or when the PR
head is the head of a high-stakes FAIL; a due pass never changes it. Under the draft flow the PR then goes back to draft until
the FAIL was cleared and the head moved. The finish hold stays session-wide. A PR opened from the shell is not refused; the rules text carries the duty.

**Traces and the PR body.** `review_stakes {level: high, reasons}` is written when a reason fires for the first time in the
session (a risk tag, `heavy`, `foreman`): the pass is then required. `role_launch` and
`review_done` of the run carry `occasion: high-stakes`, and each verdict writes `review_high_stakes {verdict, head, count}`
(`count` is 1 or 2, the number of the pass). A `review_high_stakes` record shows that the pass ran. The rules text also tells the
foreman to add one line per pass to the PR body, `High-stakes review: <verdict> on <sha> (<reasons>)`; no code checks the body.

**Known limits.**

- `high_stakes_early` reads the review gate of the checkout the launch runs in (see the review gate per checkout above); a
  checkout the harness cannot resolve reads the session-wide entry.
- One pass per session, wherever the work lands: work from a second worktree, branch or repository after the pass is not
  reviewed again, and any pass opens every PR of the session.
- A high-stakes launch needs a normal PASS in its own checkout first (a pass in another checkout is not enough).
- A PASS in one checkout survives work in another: if B's work changes code that A's PR depends on, A ships without a new review (the finish still asks for B's own review). A checkout that got work and was deleted before its review keeps blocking the finish (after two refusals it ends with a notice) and the ledger V mark.
- A high-stakes FAIL can be cleared by a normal reviewer without a code change, or by a fix in another checkout that does not touch the finding; the findings go to that reviewer, who judges them.
- A malformed `size` with sizing off drops the launch's tags.
- Migrating an old per-checkout entry keeps the runs of one checkout only, so an old FAIL in another checkout is dropped.
- A pass that ran is the one pass. Work built after it reaches the pull request with the normal review only; the finish
  gate asks for the pass only once every ledger item except V is marked, and the rules text says to launch it when the
  change is complete.
- A run lost in a reload is not counted as run and can be launched again; a run that ends after a reload is recognised by its
  persisted run id and marks no item.
- The findings count as handed over once the adapter accepted the launch; a launch that fails afterwards does not get them
  again.
- `[second-opinion]` never satisfies the requirement; `[plan-review]` never triggers it.

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
and traces nothing). The adapter hands it the run's verdict record as JSON on stdin; it appends the record's `defect` findings (checked against the changed files) to
`<agentDir>/pi-foreman/state/findings/<session>.jsonl`, repo-relative paths only. Four record types:

| `type` | Fields (`review` and `finding` also carry `session, gate, model, rung, primary, role, runId, head, ts, source, workspace, repo, branch`) |
|---|---|
| `review` | `base, items, verdict, secs, startedTs, findings` |
| `finding` | `id, file, line, class, note` (note cut to 120 characters) |
| `dismiss` | `id, reason, session, ts` |
| `pr` | `session, workspace, repo, branch, number, head, ts` |

`workspace` is the key of the repository's main checkout (a linked worktree resolves to its main checkout): the folder's name and the first 8 hex characters of a SHA-1 over its real path, or the `retro.workspaceKey` override. `repo` is `owner/name` of the `origin` remote, else of the first remote by name, else `null`. `branch` is the branch checked out where the review ran (`null` when detached). A row written before these fields existed has none of them and matches no `--workspace` or `--repo` filter; without a filter it is listed as before.

The adapter writes a `pr` row when a PR watch is armed (`pr_create`, and `pr_watch` for a PR it did not open), once per PR number and repository, to the session's findings file under the same `<file>.lock` the Python writer takes (the two exclude each other; a writer waits 5 s and breaks a lock older than 60 s). Its `branch` is the `head` argument of `pr_create` (the part after the colon for the fork form `owner:branch`; default the checkout's branch), the checkout's branch for a `pr_watch` without a number, and `null` for a `pr_watch` with a number (a watch does not know that PR's branch when it is armed; such a row joins no change). The write is best effort and happens after the watch is armed: a lock timeout or write error never releases the watch and never fails the tool (trace `pr_watch` with outcome `pr_row_failed`).

`source` is `live` for the primary, `panel` for a shadow, `bench` for bench runs. `rung` is `1` when the reviewer was raised to the strong rung by the repeat-fail rule or the security rung, else `0`.
A finding `id` is 12 hex characters of
a SHA-1 over file, `line // 5` and class, so a re-report of the same spot by the same model is one finding. The
`finding` trace event carries `findingId, model, gate, class, file` (basename only), `line, primary`.

## `foreman findings`

| Command | What it does |
|---|---|
| `foreman findings list [--since 7d\|ISO] [--only-model SUBSTR] [--unique] [--session S] [--workspace KEY\|here] [--repo OWNER/NAME] [--json]` | Located findings; `--unique` keeps those only one model found. Dismissed ones are tagged. `--workspace here` is the key of the main checkout of the current directory (also from a linked worktree); `--repo` is compared case-insensitively. Rows without the key never match either filter. |
| `foreman rounds [--workspace here\|KEY] [--branch B] [--pr N] [--since 7d\|ISO] [--json]` | Review rounds per change (see [Review rounds](#review-rounds)). |
| `foreman findings dismiss <id> <reason>` | Marks a finding rejected (a `dismiss` record). |
| `foreman findings export <id> --to DIR [--repo PATH]` | Turns a finding into a review-bench task. `--to` is required and never inside the package tree or the finding's repo. |

Export writes `DIR/harvest-<id>/` with `base/` (the file at the merge base), `diff.patch` (the file's change up to the
finding's head), `prompt.md` (the ledger items the review covered, else a generic line), `ground_truth.json` (the
bench's format, one defect) and `harvest.json` (`"confirmed": false`). `foreman bench review` skips a task whose
`harvest.json` is unconfirmed; set `"confirmed": true` after you have checked the planted truth, then it joins the suite.
See [bench](bench.md).

## Review rounds

The harness counts the review rounds of a change from the findings store (`extensions/core-adapter/reviewrounds.ts`). It is shown as one line in the result at close and by `foreman rounds`; the sidebar and GitHub do not show it.

- A change is a workspace plus a branch. A row without a workspace or branch (an old row, a detached HEAD) belongs to no change.
- One round is one reviewer run (`runId`) with at least one `review` row that is `primary` and has the gate `item`, `pre-pr` or `high-stakes`. Panel shadow rows (not primary) and the gate `second-opinion` never count. A run with several primary rows is one round, and it fails when one of its rows is a FAIL; every other round counts as a pass. A round that held a high-stakes review is counted in the total and named (`foreman rounds --json` lists the run ids in `highStakesRuns`).
- Plan reviews (gate `plan-review`) are counted apart by the same run rule. A change with plan reviews only has no entry.
- The PR number comes from the `pr` rows of the same workspace and branch, joined by time: a round that began before the row of a later PR with another number belongs to the earlier PR. A branch with two PRs therefore shows two entries. A row with a null branch joins nothing.

The line: `Review rounds: 4 (2 fail, 2 pass; 1 high-stakes), plan reviews 2, PR #301`. The high-stakes part, the plan-review part and the PR part are left out when zero or unknown. `foreman rounds` prints `<workspace> <branch>: <line>` per change and PR, or a JSON array of `{workspace, branch, pr, rounds, fail, pass, highStakes, highStakesRuns, planReviews, sessions, line}` with `--json`; `--workspace here` takes the key of the current directory's main checkout, `--since` keeps the rounds that began after the cutoff.

Known limits: reviews that ran in another worktree on another branch (a builder's own branch) are counted under that branch and do not join the PR; a PR watch armed with a number records no branch, so its line shows no PR; rows written before the key existed are not counted.

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
The table is a print only: no report entry is filed from it; see [retro](retro.md).

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
  }
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
