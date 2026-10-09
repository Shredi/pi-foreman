# Roles, ladder and presets

> Covers the neutral roles, display-name presets, the two-rung model ladder, the rank policy and the opt-in model presets.
> Read it when you choose models per role or cap what children may run on.
> Children climb to a stronger model only through the foreman, with a stated reason.

## Roles

Role ids are neutral: `foreman` (the main session: triage, plan, ledger, delegate, integrate), `explorer`
(read-only search), `planner` (heavy tasks: writes the plan for the owner checkpoint), `builder` (one scoped
change), `reviewer` (diff review against ledger items), `senior-reviewer` (plan or security review), `finalizer`
(verification and close-out). Role files are in `agents/`. Display names come only from config: the preset
`classic` shows personal names, `plain` shows the ids; no code compares a display name. Models are mapped per
provider in `foreman.json` (see [install](install.md)). Design record: `design/architecture.md`
[section 4](../design/architecture.md#4-role-model).

## Role ladder, rank policy and presets

Each role has two rungs: `model` (bottom) and an optional `strong`. A child climbs only through the foreman,
which relaunches it with `model: "strong"`:

- **Context**: a bottom-rung child whose last call's context (input + cacheRead + cacheWrite) passes
  `strongAbove` (default 100000) is steered once to stop and return a handoff report starting `RUNG_UP: context`.
- **Turns**: past `childMaxTurns` assistant turns (default 60) a bottom-rung child hands off (`RUNG_UP: turns`);
  a top-rung child is told to stop and report (`child_turn_cap` trace event).
- **Stuck**: a report with `STATUS: stuck` or "own checks failed".
- **Foreman**: `model: "strong"` plus a `reason` on the launch. A strong launch with no reason and no trigger is
  refused (`strong_no_reason`); a heavy-tier builder and `strongOnRevision` count as triggers.
- **Review FAIL**: a builder revision launched while the latest reviewer verdict is FAIL goes to the builder's
  strong rung without a keyword or reason (`rung_up` reason `review_fail`) when `strongOnRevision` resolves true:
  `roles.<id>.strongOnRevision`, else `providers.<p>.strongOnRevision`, else `ladder.strongOnRevision` (default
  true). A revision without a FAIL climbs only with `providers.<p>.strongOnRevision: true` (reason `revision`);
  `false` there switches the FAIL climb off for that provider. No strong rung: no climb. While the climb is open
  the finish gate refuses once more without counting the refusal (see [ceremony](ceremony.md)).

After a context, turns or stuck report the launch result says the run is climb-eligible; the next strong launch
of that role gets the prior report (at most 4000 characters), its result path and the ledger items prepended to
its task, and the trace records `rung_up {role, from, to, reason}`. Knobs: `ladder.strongAbove`,
`ladder.childMaxTurns`, per provider `providers.<p>.strongAbove|childMaxTurns`, per role
`roles.<id>.strongAbove|childMaxTurns` (the most specific wins; user or overlay config only), and
`strongOnRevision` with the same lookup (a project or session can only set it false). A rung's own
`thinking` wins over the foreman's level: the ladder climbs by model, never by thinking. `childMaxThinking`
(unset by default) caps every child launch's level, rungs included, on top of `maxThinking`.

**Rank policy.** `providers.<p>.ranks` lists `{match: <model-id glob>, tier: <0 = top>}` entries, highest first.
`ladder.childPolicy` (one value for all providers) is `below` (default: children strictly below the foreman's
tier), `at-or-below`, or `any`. Tiers are compared across providers, so a foreman on one provider may launch
rank-compatible children on another. Once any ranks exist, a model in no list is allowed only under `any`. With
no ranks anywhere the policy does nothing. A refused launch is traced `launch_refused {policy, foreman, requested}`.

**Presets** under `config/presets/` are opt-in overlay files, never merged by default. Copy the parts you want
into `<agent dir>/foreman.json`:

- `claude-bridge.json`: ranks fable > opus > sonnet > haiku; foreman Opus 5.5 (high); explorer, builder and
  reviewer Haiku 5.5 (medium) with a strong Sonnet 5.5 rung; planner, finalizer and senior-reviewer (high) on
  Sonnet 5.5; auto-review on Haiku 5.5; `childPolicy: below`, so no child runs on Opus; `childMaxThinking: high`.
- `claude-bridge-sonnet-reviewer.json`: the same with the reviewer on Sonnet 5.5 (medium) and no strong rung;
  explorer, builder and auto-review unchanged. Opt-in, not the default: the bench rows decide whether it pays.
- `openai.json` (astra > sol > luna: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`) and `google.json`
  (`gemini-*-pro*` > `gemini-*-flash*`; `at-or-below`, because the strong rung is the foreman's own pro model). Ids
  are from Pi's model registry; tiers follow capability class so cross-provider comparisons hold.

To keep Opus for children (for example `strong` or `senior-reviewer` under a Fable foreman), name it in that
role and either set `ladder.childPolicy: "any"` (every model available) or rank the foreman above it.

## Auto review model

The permission auto-review (see [safety](safety.md)) uses `providers.<p>.review.model`; when unset it picks the
cheapest role-map model (by registry input price, with auth) and traces it as `by: "auto"`; with none, asks go to you.

Design record for the ladder: `design/architecture.md`
[role ladder and rank policy](../design/architecture.md#role-ladder-and-rank-policy).

## Further role and provider keys

| Key | Meaning and layer rule |
|---|---|
| `displayPresets.<name>` | Named display-name presets, each a map `{role id: display name}`; chosen by `displayNames`. |
| `roles.<role>.promptAppend` | Text appended to the role prompt. |
| `roles.<role>.tools` | Strict tool allowlist, written into the generated settings (informational for the foreman); project/session can only narrow it. |
| `roles.<role>.launch` | How the role is launched; only `detached` exists (detached children forward permission asks to the parent). Not settable by project/session. |
| `roles.<role>.timeoutMinutes` | Run-time limit of one launch; the adapter clamps a longer foreman value down to it. |
| `roles.<role>.childMaxTurns` | Ladder: assistant turns after which a child of this role is steered once to stop and hand off (rung up when on its bottom rung). |
| `providers.<p>.costTier` | Relative cost tier; a fallback to a higher tier needs one confirmation per session. |
| `providers.<p>.roles.<role>.model`, `providers.<p>.roles.<role>.thinking`, `providers.<p>.roles.<role>.codemode` | The provider's model for the role as `<provider>/<model>`, its thinking level (capped by `maxThinking`) and a per-provider codemode override. |
| `providers.<p>.roles.<role>.strong.model`, `providers.<p>.roles.<role>.strong.thinking` | Stronger model for the role, picked by the strength keyword `strong` (the builder also on a heavy tier). User or overlay config only. |
| `providers.<p>.childMaxTurns` | `childMaxTurns` for every role of this provider. User or overlay config only. |
| `ladder.strongOnRevision` | A builder revision after a reviewer FAIL launches on the strong rung (`rung_up` reason `review_fail`; default true); project/session can only set false. |
| `roles.<role>.strongOnRevision` | Per-role override of `ladder.strongOnRevision`, wins over the provider key; project/session can only set false. |
| `providers.<p>.strongOnRevision` | `true`: every revision round relaunches the builder on its strong model (reason `revision`); `false`: no climb, also not after a FAIL; unset: `ladder.strongOnRevision` decides. Project/session can only set false. |
| `providers.<p>.review.timeoutMs` | Timeout of the model review of permission asks (default 15000 ms); a timeout defers to the human. |
| `providers.<p>.fallback.provider`, `providers.<p>.fallback.confirm` | One explicit fallback provider for roles this provider does not map (auth failure or unavailability only), and whether to ask once per session first. |
