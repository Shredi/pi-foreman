# Triage, delegation and finish gates

> Covers the tiers, the trivial builder path, bounded mode, finish gates, planner and checkpoint, waiting, read budgets, the ledger tool and the key table.
> Read it when the foreman refuses a step, or when you tune how much process a task gets.
> The foreman records a tier first and the adapter checks the claim instead of trusting it.

## Triage and delegation

`/ceremony [trivial|standard|heavy]` shows the current tier, or sets it yourself (you may move it either way).

The foreman records a tier (trivial, standard, heavy) before it changes files itself, and the adapter checks the claim instead of trusting it:

- Trivial builder path (`ceremony.required.trivial: ["builder"]`, default): a trivial change keeps a `Tier: trivial`
  ledger and runs one bottom-rung builder, no explorer, planner, reviewer or finalizer. At finish a diffscan check
  (one source file within `trivialBound`, no exported signature or schema change, no test file touched, a test present)
  escalates to standard otherwise (trace `triage_escalated {reason}`), so a reviewer must pass. `[]` restores the old trivial.
- In `bounded` mode, at trivial the foreman may change at most `ceremony.trivialBound` itself (default 2 files, 40 changed lines, no new file). The call that would cross it is refused, the tier rises to standard and a builder does the rest. A project or session can only lower the bound.
- Shell writes into project files are refused for the foreman at every tier (see [safety](safety.md)).
- Standard needs a completed builder run and a reviewer verdict before the foreman may finish, heavy also a finalizer (`ceremony.required`, a project can only add steps). A refused finish names what is missing; after two refusals per prompt it passes with a visible warning (trace `ceremony_incomplete`). Before that valve, while the reviewer step is open on a FAIL, the review-FAIL climb is on (`ladder.strongOnRevision`, see [roles](roles.md)) and the builder's latest launch ran on its bottom rung, the finish is refused with "relaunch the builder for the revision; it climbs to its strong rung" and the refusal does not count (trace `finish_refused {climb_available: true}`; at most two per prompt). On the top rung the valve works as before.
- The foreman's own edits follow `ceremony.foremanEdits`; a PR needs a reviewer PASS on the current head (`ceremony.reviewBeforePr`, see [safety](safety.md)). In `readonly` and `scratchpad` mode the foreman never changes project files itself, so a refused edit makes the task standard and a builder does the work. The scratch dir is for notes, drafts, commit messages and review pages. `.workflow/` stays writable in every mode, because the harness keeps the ledger and state there.
- Plans: heavy runs ledger, `planner`, `foreman_checkpoint`, builder(s), finalizer, reviewer, PR. `planner` is a role (read-only tools plus `write`/`edit` limited to `.workflow/` and the scratch dir, never outside the workspace, single launch only). `foreman_checkpoint(path)` shows the plan `plan-<topic>.md` to the owner (revise, reject, approve; approve is never preselected) and records the approved hash, only if the file is unchanged when the owner answers; it is refused while a planner run is active; a heavy `builder` launch is refused until the current bytes are approved (`plan_required`, `checkpoint_pending`, `plan_changed`). The harness never approves on its own: print/json mode or a dismissed dialog leaves the checkpoint pending, and it never turns a timeout into approval. A rejected plan blocks the finish (the two-refusal valve ends the session visibly, never approving). Standard writes its own short plan to the scratch dir; no checkpoint. Plan mode is not part of the ceremony; the checkpoint is. A `subagent` launch with `output` or `outputMode` is refused for every role (`launch_refused:output_path`: the runner would write the reply to a file without a write check), and with `safety.subagents.allowWorkflow` on, workflow and `schedule.*` calls are still refused at heavy (`unchecked_heavy`).
- With `ceremony.launchWait` on (default `block`) a foreman launch returns when the child finishes, any child asks the foreman something, or `wait.maxSeconds` (or the role's `timeoutMinutes` plus 60 s, when shorter) passes, so no `bg_wait` turn is needed; every launch of one message is held in parallel, a launch from inside codemode never. A completion notice for a run already delivered that way is dropped from the model context (`ceremony.dedupeNotify`; trace `notify_deduped {runId, mode, trimmed_lines}`), and the async-started guidance lines (detached, bg_wait, "Return control") are trimmed from the held result. `bg_wait` stays for a child the result says is still running; the trace and the bench table count polling bash calls (`pollBash`).
- Read budgets: the foreman's own read-class calls (`bash`, `read`, `grep`, `find`, `ls`, `codemode`; one codemode script counts once; a pure-ledger shell command is exempt from this and the recheck budget while `ledgerHelper` is not `off`) warn and then are refused past `ceremony.foremanReads` until a fresh explorer launch has started (not a resume; once per phase; a second refusal needs the user's `/foreman budget lift`). The count resets to phase `before` with each user prompt. After a reviewer PASS only `ceremony.recheckBudget` own checks are allowed, then the foreman is told to finish; that budget resets on a reviewer FAIL, a builder launch, a foreman change of a project file after the PASS (not `.workflow/` or scratch notes), or a new user prompt. `foreman_triage` and the system prompt state the required finish steps up front.
- Child read budgets: `ceremony.childReads.<role>.{warn,deny}` (builder 20/40, reviewer 15/30, explorer none): a child's read, grep, find, ls and read-only bash calls get a notice at warn and are refused above deny with a "return your report / `STATUS: stuck`" message; trace `child_read_budget {role, count, action}`.
- Child scratch: every single-child launch gets its own dir `<os temp dir>/pi-foreman-scratch/<session>/<launch>` (mode 0700), named in a line appended to the task and as the child's env `FOREMAN_SCRATCH`. The harness removes it when the run ends, after the trace line `child_scratch {role, bytes, files, action}`, and sweeps the session's dirs at shutdown; `ceremony.childScratch.keep` keeps them. What the guards allow there: [safety](safety.md#child-scratch).
- Explorer brief: the latest completed explorer report (first 8000 characters, plus its result path; the harness writes the full report to `explorer-brief.md` in a session scratch dir that children read without an ask, and a cut brief ends with `[full brief at <path>]`) is prepended once to the next fresh builder launch (after any rung-up handoff); trace `explorer_brief {role, chars, cut, action: file|none}` (traces never hold paths).
- Ledger items block: a fresh builder launch whose task cites items ("item 3", "items 1 and 2", "#5") gets `[pi-foreman ledger items]` with those ledger lines prepended (before the explorer brief); none when it cites none, and none on a rung-up launch, whose handoff already carries them (trace `ledger_block`). The standard finish gate needs only builder and reviewer, so the explorer may be skipped when the builder brief lists the files and symbols.

| Key | Default | Direction |
|---|---|---|
| `ceremony.foremanEdits` | `scratchpad` (`readonly`, `scratchpad`, `bounded`) | project/session can only move toward `readonly` |
| `ceremony.scratchDir` | `.workflow/scratch` | project/session can only narrow it to a subpath |
| `ceremony.reviewBeforePr` | `true` | project/session cannot turn it off |
| `ceremony.foremanReads.<before\|after>.<warn\|deny>` | before 4/8, after 4/8 | project/session can only lower (minimum 1) |
| `ceremony.reviewGate` | `pass` (`pass`, `verdict`) | project/session can only move to `pass` |
| `ceremony.orientation` | `{enabled: true, maxLines: 120}` | free per layer |
| `ceremony.recheckBudget` | `3` | project/session can only lower (minimum 0) |
| `ceremony.launchWait` | `block` (`block`, `detach`) | project/session can only move to `block` |
| `ceremony.dedupeNotify` | `true` | project/session cannot turn it off |
| `ceremony.ledgerHelper` | `tool` (`tool`, `bash`, `off`) | project/session can only move toward `off`; `off` is the eee843d-equivalent |
| `ceremony.reviewPerRevision` | `true` | project/session cannot turn it off; `false` (the eee843d-equivalent) only from the user or package layer |
| `ceremony.heavyThreshold` | `strict` (`strict`, `eee843d`) | project/session can only move to `eee843d` (keyword signals escalate to heavy, as before) |
| `roles.foreman.codemode` | `true` | project/session can only switch it off |
| `ceremony.required.heavy` | `[planner, builder, reviewer, finalizer]` | steps are added, never removed, by project/session |
| `roles.planner` | tools `read, ls, grep, find, write, edit`; `timeoutMinutes` 20; display "Hannibal" (classic) | project/session can only narrow `tools` |

`reviewGate: pass` means the required reviewer step needs a current PASS (a FAIL, or a revision after the last
PASS, re-opens it); `verdict` accepts any verdict. The orientation packet (tracked-file tree to depth 2,
head of AGENTS.md or README.md, detected build/test commands, explorer hint; at most `maxLines` lines) is added
to the foreman's system prompt once per session and does not count against the read budget.

Ledger and review rules: with `ceremony.ledgerHelper: tool` the foreman manages its ledger with the tool `foreman_ledger({action, items?, item?, text?})` (`upsert` rewrites one item's text keeping its state, or appends when `item` is omitted; identical text is a no-op) instead of the shell `ledger` command (the permission system splits compound shell commands, so forms like `ledger -f F mark V` were denied). The foreman may mark V itself once a reviewer PASS stands with no builder launch or project edit since; a reviewer child can use the tool to mark V only. On a `reviewer` PASS (not `senior-reviewer`) the harness marks each still-open item the review's `N. PASS` lines name, with the note "verified by reviewer PASS", once per review run and never V (trace `ledger_mark_by_review {items, skipped}`). At a review PASS the harness also records the working tree (a git tree of the index plus every non-ignored file); a later builder run or foreman edit whose changes since then touch only docs (`*.md`, `docs/`) or only comments and whitespace of Go, Rust, TypeScript/JavaScript or Python files (`//`, `/* */`, `///`, `//!`, `#`; string literals, directive comments such as `//go:build`, Rust doctests and JSX count as code; an unknown language, no change at all or any doubt is not comment-only) is not a revision: no re-review, no revision round (trace `revision_comment_only {files}`, a count). With `ceremony.reviewPerRevision` a second reviewer launch after a PASS on unchanged work is refused; add `[second-opinion]` to the task text for auth or safety changes, a heavy tier, or when the first reviewer could not run the tests. With `ceremony.heavyThreshold: strict`, heavy-signal keywords are only a hint (`triage_hint`) and heavy is for multi-component or risky changes. To reproduce the pre-change behaviour, set `ledgerHelper: off`, `reviewPerRevision: false` and `heavyThreshold: eee843d` in the user layer (`<agent dir>/foreman.json`); `reviewPerRevision: false` is ignored from project and session layers.

Reviewer rules: a changed exported signature, a weakened or removed test or assertion, or a skipped test is a FAIL
unless asked for (callers are grepped). A "Facts to rule on" block from `git diff` (against the HEAD at the first
builder launch) is appended to a reviewer's launch task (`diffscan.ts`; trace `review_facts {count}`).

Design record: `design/architecture.md`
[section 6](../design/architecture.md#6-ledger-gates-and-proportional-ceremony).

## Further ceremony keys

| Key | Default | Meaning and layer rule |
|---|---|---|
| `ceremony.default` | `standard` | Tier assumed when no signal applies (`trivial`, `standard`, `heavy`). |
| `ceremony.heavySignals` | `delete, migration, safety, auth, ci, release, public-api` | Keywords or areas that hint at heavy (a hint only under `heavyThreshold: strict`). `release` counts only when the prompt also names a version, changelog or manifest bump; slash-command prompts have no signals. |
| `ceremony.heavyFileCount` | `8` | A task touching more files than this is heavy. |
| `ceremony.overrides` | `{}` | Per-repository-path tier, `{path: tier}`. |
| `ceremony.revisionRounds.standard`, `ceremony.revisionRounds.heavy` | 1, 2 | Builder revision rounds after a review (trivial has none); project/session can only lower. |
| `ceremony.requireTriage` | `true` | The foreman records a tier before it edits workspace files itself; project/session can only set true. |
| `ceremony.trivialBound.files`, `ceremony.trivialBound.lines`, `ceremony.trivialBound.newFiles` | 2, 40, 0 | The bound of `bounded` mode at trivial: distinct files, changed lines, new files. |
| `ceremony.required.standard` | `[builder, reviewer]` | Steps a standard session completes before the foreman may finish (trivial and heavy are above); steps are added, never removed, by a project. |
| `ceremony.foremanReads.before.warn`, `ceremony.foremanReads.before.deny`, `ceremony.foremanReads.after.warn`, `ceremony.foremanReads.after.deny` | 4/8, 4/8 | The read-budget pairs per phase (see the table above). |
| `ceremony.childReads.<role>.warn`, `ceremony.childReads.<role>.deny` | builder 20/40, reviewer 15/30 | Read budget per child role; a role without an entry has none. |
| `ceremony.childScratch.keep` | `false` | Keep the child scratch dirs after the run and at shutdown; any layer may set it (it only retains temporary data). |
| `ceremony.orientation.enabled`, `ceremony.orientation.maxLines` | `true`, 120 | Orientation packet switch and size. |
| `ceremony.reviewModel` | `null` | Reviewer model used when a reviewer launch resolves to the foreman's own model and no later reviewer climb rung differs (trace `review_model`). User or overlay config only. |
| `ceremony.planReview.trivial`, `ceremony.planReview.standard`, `ceremony.planReview.heavy` | `false`, `false`, `true` | The checkpoint needs a `[plan-review]` verdict for the current plan first; project/session can only set true. |
