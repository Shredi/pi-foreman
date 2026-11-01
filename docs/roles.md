# Roles, ladder and presets

> Covers the neutral roles, display-name presets, the two-rung model ladder, the rank policy and the opt-in model presets.
> Read it when you choose models per role or cap what children may run on.
> Children climb to a stronger model only through the foreman, with a stated reason.

## Roles

Role ids are neutral: `foreman` (the main session: triage, plan, ledger, delegate, integrate), `explorer`
(read-only search), `planner` (heavy tasks with `ceremony.planner: role`; by default `self`, the foreman writes the plan for the owner checkpoint itself and the planner is not launched), `builder` (one scoped
change), `reviewer` (diff review against ledger items), `senior-reviewer` (plan or security review), `finalizer`
(verification and close-out). `session-foreman` is not a launchable role: its mapped model is the model of sessions opened by `foreman session open` (default: the opening session's own model; only the `model` of the mapping is used, the opened session keeps Pi's default thinking; `--model` overrides; `subagent({agent: "session-foreman"})` is refused). Role files are in `agents/`. Display names come only from config: the preset
`classic` shows personal names, `plain` shows the ids; no code compares a display name. Test runs: builders and finalizers run targeted tests only; the reviewer runs each full suite once per change (through the npm scripts, which queue behind the machine-wide test lock, see [development](development.md#tests)), and CI covers the rest. Models are mapped per
provider in `foreman.json` (see [install](install.md)). Design record: `design/architecture.md`
[section 4](../design/architecture.md#4-role-model).

## Role ladder, rank policy and presets

Each role has two rungs: `model` (bottom) and an optional `strong`. The foreman role has a third, `idle`: a cheaper
model for notice-driven turns that start on a cold cache, restored on the owner's next input (see
[ladder](ladder.md#idle-rung-foreman-downshift)). A child climbs only through the foreman,
which relaunches it with `model: "strong"`:

- **Context**: a bottom-rung child whose last call's context (input + cacheRead + cacheWrite) passes
  `strongAbove` (default 100000) is steered once to stop and return a handoff report starting `RUNG_UP: context`.
- **Turns**: past the role's turn limit (`ladder.maxTurns.<role>`: builder 100; otherwise `childMaxTurns`, default 60)
  a bottom-rung child hands off (`RUNG_UP: turns`); a top-rung child is told to stop and report. Trace events:
  `child_turn_cap` and `child_turn_limit {role, turns, limit}`.
- **Stuck**: a report with `STATUS: stuck` or "own checks failed".
- **Foreman**: `model: "strong"` plus a `reason` passed as an extra top-level field of the `subagent` call (the
  published tool schema does not list it; the adapter reads and removes it). A strong launch with no reason and no
  trigger is refused (`strong_no_reason`); a heavy-tier builder and `strongOnRevision` count as triggers.
  A builder launch may also carry `size` and `risk` (top-level keys of the `subagent` call, never inside `options` or `args`); the adapter reads and removes them and a large or risky
  task goes strong without a `reason` (see [ladder](ladder.md#launch-sizing)).
- **Review FAIL**: a builder revision launched while the latest reviewer verdict is FAIL goes to the builder's
  strong rung without a keyword or reason (`rung_up` reason `review_fail`) when `strongOnRevision` resolves true:
  `roles.<id>.strongOnRevision`, else `providers.<p>.strongOnRevision`, else `ladder.strongOnRevision` (default
  true). A revision without a FAIL climbs only with `providers.<p>.strongOnRevision: true` (reason `revision`);
  `false` there switches the FAIL climb off for that provider. No strong rung: no climb. While the climb is open
  the finish gate refuses once more without counting the refusal (see [ceremony](ceremony.md)).

After a context, turns or stuck report the launch result says the run is climb-eligible; the next strong launch
of that role gets the prior report (at most 8000 characters), its result path and the ledger items prepended to
its task, and the trace records `rung_up {role, from, to, reason}`. Knobs: `ladder.strongAbove`,
`ladder.childMaxTurns`, per provider `providers.<p>.strongAbove|childMaxTurns`, per role
`roles.<id>.strongAbove|childMaxTurns` (the most specific wins; user or overlay config only), and
`strongOnRevision` with the same lookup (a project or session can only set it false). A rung's own
`thinking` wins over the foreman's level: the ladder climbs by model, never by thinking. `childMaxThinking`
(unset by default) caps every child launch's level, rungs included, on top of `maxThinking`.
The live rung, `rung_top`, the reviewer's own climb (`ladder.reviewerClimb`) and the trace records are in
[ladder](ladder.md).

**Rank policy.** `providers.<p>.ranks` lists `{match: <model-id glob>, tier: <0 = top>}` entries, highest first.
`ladder.childPolicy` (one value for all providers) is `below` (default: children strictly below the foreman's
tier), `at-or-below`, or `any`; `ladder.rolePolicy.<role>` overrides it for one role (unset = `childPolicy`). An
explicit launch `model: "<provider>/<id>"` is passed through when the rank policy allows it for that role (ranks
configured, model ranked); otherwise the role map decides. Tiers are compared across providers, so a foreman on one provider may launch
rank-compatible children on another. Once any ranks exist, a model in no list is allowed only under `any`. With
no ranks anywhere the policy does nothing. A refused launch is traced `launch_refused {policy, foreman, requested}`. When the refused role is `planner`, the message adds that the role sits on the foreman's own rung: plan it yourself (write `.workflow/scratch/plan-<topic>.md`) or map the role to a lower rung (no automatic climb). With `ceremony.planner: role`, a planner whose rank tier is <= the foreman's (checked directly, whatever the policy says; unranked counts as not below) is not refused but switches the session to `self` (trace `planner_self_fallback`): the foreman plans it itself, and its approved plan satisfies the planner step.

**Session rank policy.** A session opened by `foreman session open` never runs on a higher rank than the session that opens it: if the chosen model (`--model`, else `session-foreman`, else the own model) has a lower tier number than the opener's, the open is refused (`session open refused [session_rank]`) and nothing is spawned. With no ranks configured there is no check; once ranks exist, an unranked model on either side, or an unknown own model, is refused. The `claude-bridge` presets map `session-foreman` to Opus 5.5; the `openai` and `google` presets map it to their foreman model.

**Presets** under `config/presets/` are opt-in overlay files, never merged by default. Apply one with
`foreman config apply-preset <name> [--foreman <model id>] [--dry-run]` (merges into `<agent dir>/foreman.json`,
keeps your other keys, backs up the old file; see [install](install.md)), or copy the parts you want by hand. The rank-tier `inexpensive` preset is in [presets](presets.md):

- `claude-bridge.json`: ranks fable > opus > sonnet > haiku; foreman Opus 5.5 (high); explorer, builder and
  reviewer Sonnet 5.5 (medium) on the bottom rung with a strong Opus 5.5 rung; planner, finalizer and senior-reviewer
  (high) on Sonnet 5.5; auto-review on Haiku 5.5 (Haiku is an explicit opt-in: map a role to it yourself);
  `childPolicy: below` with `rolePolicy` reviewer and senior-reviewer `at-or-below`, builder `below`, so an Opus
  foreman launches Opus reviewers but an Opus builder or explorer strong rung needs a Fable foreman or
  `rolePolicy.<role>: at-or-below`; `childMaxThinking: high`; the foreman idle rung on Sonnet 5.5 (medium) and the
  1-hour cache values ([presets](presets.md#claude-bridge-cache-values)).
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

## Review critic

The config list `review.critic` (default: four questions: is it lean and the right layer, real repeated friction or an
invented edge case, code or config we would not miss, does it move toward the Pi top-chair switch) is rendered as a
`[pi-foreman critic]` block into every `reviewer` and `senior-reviewer` task, after the ledger block. The review answers
each question once per ledger item as a line `CRITIC: <item> Q<k>: <answer>`; an item that fails question 3 is dropped, not
built. The harness does not parse or enforce the lines. A builder or explorer task gets no block. An overlay or preset
replaces the list through the normal config layering; an empty list renders no block.

Design record for the ladder: `design/architecture.md`
[role ladder and rank policy](../design/architecture.md#role-ladder-and-rank-policy).

## Further role and provider keys

| Key | Meaning and layer rule |
|---|---|
| `displayPresets.<name>` | Named display-name presets, each a map `{role id: display name}`; chosen by `displayNames`. |
| `roles.<role>.promptAppend` | Text appended to the role prompt. |
| `roles.<role>.tools` | Strict tool allowlist, written into the generated settings (informational for the foreman); project/session can only narrow it. |
| `roles.<role>.searchable` | Tools a child of the role finds on demand through `tool_search`: part of its generated allowlist (`tools` plus `searchable`, after the child-denied filter) but hidden from its declarations until searched (the child session adds these names to its own `tools.deferred` hidden set; the never-deferred tools such as `read` and `bash` stay declared, and a foreman session ignores the key). Default: the builder has `foreman_move` and `foreman_copy`, other roles none. A project or session can only narrow it, and a name dropped from `tools` cannot come back through it. Re-run `foreman setup` after a change; `foreman doctor` reports a drift. |
| `roles.<role>.mcp` | The MCP ceiling of a child role, by configured name: `server` for all its tools, `server/tool` for one. A launch can narrow it (`mcp` on `subagent`) but never widen it. The tools load on demand through `tool_search` in the child (on a `mcp.directProviders` provider the allowed deferred ones are preloaded, see below); no `mcp:` entries are written to the generated tools. Default none. User or overlay config only; a project or session value is ignored with a warning. An error where the role's `denyTools` deny the server's `mcp__` tools, and for `foreman` and `session-foreman`, which already load every enabled server in `mcp.json`. |
| `roles.<role>.skills` | Skills a child role gets as catalog entries, by name (one plain path segment; no `/`, `\`, `.`, `..`, glob characters or `:`). A role gets only the skills it names: `inheritSkills` stays off and the system prompt is replaced, so an unnamed skill is not listed. Written to the generated `agentOverrides` only when non-empty. Default none. User or overlay config only; a project or session value is ignored with a warning. |
| `roles.<role>.denyTools` | Tool-name globs (`*` wildcard) a child of the role never gets: the call is denied, never asked, before the permission overlay. Defaults: `mcp__*` for `planner`, `explorer`, `reviewer` and `senior-reviewer`, so MCP tools are denied for the read-only roles. Layers only add entries; none removes one. A child whose launch binding cannot be read gets `mcp__*` denied. The check runs in the `tool_call` hook, and every inner call of a codemode script runs through the hooks on its own, so the deny applies to those calls too. |
| `roles.<role>.launch` | How the role is launched; only `detached` exists (detached children forward permission asks to the parent). Not settable by project/session. |
| `roles.<role>.timeoutMinutes` | Run-time default of one launch: written as the launch's `timeoutMs` when the launch passes none. A launch `timeoutMs` (or `maxRuntimeMs`) wins in either direction; every written deadline is capped at `ceremony.launchTimeoutCapMinutes` (default 120), the only hard ceiling. |
| `roles.<role>.childMaxTurns` | Ladder: assistant turns after which a child of this role is steered once to stop and hand off (rung up when on its bottom rung). |
| `providers.<p>.costTier` | Relative cost tier; a fallback to a higher tier needs one confirmation per session. |
| `providers.<p>.roles.<role>.model`, `providers.<p>.roles.<role>.thinking`, `providers.<p>.roles.<role>.codemode` | The provider's model for the role as `<provider>/<model>`, its thinking level (capped by `maxThinking`) and a per-provider codemode override. |
| `providers.<p>.roles.<role>.strong.model`, `providers.<p>.roles.<role>.strong.thinking` | Stronger model for the role, picked by the strength keyword `strong` (the builder also on a heavy tier). User or overlay config only. |
| `providers.<p>.roles.foreman.idle.model`, `providers.<p>.roles.foreman.idle.thinking` | The idle rung of the foreman: the model (and thinking level) a notice turn on a cold cache runs on. Unset: no downshift. The reviewer different-model rule and the rank checks keep using the base model. User or overlay config only. |
| `ladder.idleDownshift.enabled`, `ladder.idleDownshift.causes` | The idle downshift on or off (default true) and the turn causes that may use it (default `child`, `wake`, `intercom`, `other`); a project or session can only set false or remove causes. |
| `providers.<p>.childMaxTurns` | `childMaxTurns` for every role of this provider. User or overlay config only. |
| `ladder.maxTurns` | Per-role turn limit, `{role: turns}` (default `{builder: 100}`); wins over `childMaxTurns`, which stays the fallback. User or overlay config only. |
| `ladder.rolePolicy` | Per-role rank policy, `{role: below\|at-or-below\|any}`, overriding `ladder.childPolicy`. User or overlay config only. |
| `ladder.strongOnRevision` | A builder revision after a reviewer FAIL launches on the strong rung (`rung_up` reason `review_fail`; default true); project/session can only set false. |
| `roles.<role>.strongOnRevision` | Per-role override of `ladder.strongOnRevision`, wins over the provider key; project/session can only set false. |
| `providers.<p>.strongOnRevision` | `true`: every revision round relaunches the builder on its strong model (reason `revision`); `false`: no climb, also not after a FAIL; unset: `ladder.strongOnRevision` decides. Project/session can only set false. |
| `providers.<p>.review.timeoutMs` | Timeout of the model review of permission asks (default 15000 ms); a timeout defers to the human. |
| `providers.<p>.fallback.provider`, `providers.<p>.fallback.confirm` | One explicit fallback provider for roles this provider does not map (auth failure or unavailability only), and whether to ask once per session first. |

A skill's `SKILL.md` may carry extra frontmatter keys (`metadata`, `compatibility`, `allowed-tools`, `context`, `agent`); both Pi and pi-subagents tolerate and ignore them, so they change neither the catalog entry nor the role.

## Skills and MCP per role

The table above has the key rows; this section gives the behaviour.

### `roles.<id>.skills`

- A child role gets the skills it names, as catalog entries (name, description, location). `inheritSkills` stays off and the system prompt is replaced, so an unnamed skill is not listed. The child reads the body with the `read` tool.
- A name is one plain path segment. The repo copy (`<repo>/.agents/skills`) wins over a user copy (`~/.agents/skills`, `<agentDir>/skills`) of the same name. Pi's loader takes the frontmatter `name` and falls back to the directory name; the role resolver matches by directory name, so keep the two equal.
- User or overlay config only; a project or session value is ignored with a warning.
- Visibility: the skills a role names follow the same three inputs as the foreman's skill list (`skills.visible`, `skills.hidden`, frontmatter `metadata.visibility: search`; see [tools](tools.md#deferred-tools-and-searchable-skills)). `foreman setup` writes only the visible ones into the agent file. The child computes the hidden ones itself from the same config, finds them with `tool_search` and gets a `pi-foreman-skills` prompt line naming them.
- Read scope: shell reads are granted per role, only for the skill dirs that role names. The `read` tool sees the union of the skills any role names. `foreman setup` re-renders the `external_directory_read` keys, so re-run it after changing `skills` (see docs/permissions.md, "Skill reads").
- Residual: a package skill under `{agentDir}/npm/node_modules`, or a skill from a settings `skills` path, still asks when a child reads its body. An in-repo named skill stays denied to a child's shell read (the `read` tool works).
- The package ships two generic skills, listed in `pi.skills`: `skills/skill-authoring` (writing and debugging skills) and `skills/prompting-guides` (writing system prompts, role files and briefs for a target model family). Name either in a role's `skills` to give that role the guide.

### `roles.<id>.mcp`

- A list of strings: the **ceiling** of what a child of the role may load. An entry is `server` (all of its tools) or `server/tool`. Default none.
- MCP tools load **on demand**. Nothing is declared in the child's prompt up front, except on a `mcp.directProviders` provider, whose allowed deferred tools are preloaded (see the paragraph below): every child role's generated tools carry `tool_search` (no `mcp:` entries are written any more), and the child loads a tool when its task needs one. A child with an empty ceiling has `tool_search` registered but inactive, so it sees no declaration.
- core-adapter, which runs in every child, loads Pi's MCP extension with a filtered server list. A server outside the ceiling never starts in the child and is not listed; each call to an `mcp__` tool is checked against the ceiling again and refused with `` pi-foreman: `<tool>` is outside the MCP scope of role <role> (roles.<role>.mcp[, launch mcp]) `` (trace `guard: "mcp_scope"`). `denyTools` wins: a role whose patterns match a server's tools loads nothing from it.
- User or overlay config only; a project or session value is ignored with a warning, because a server runs a command.
- Servers come from Pi's `<agentDir>/mcp.json`; the project `.pi/mcp.json` counts only when the project is trusted. Tool names are `mcp__<server>__<tool>`; a character outside `[A-Za-z0-9_]` becomes `_`. Server names compare in both `-` and `_` forms.
- Adding a server is two lines: the server in `mcp.json` and its name in `roles.<id>.mcp`. No `foreman setup` re-run is needed for MCP changes.
- A server that is down is absent from `tool_search` results; the child reports the missing tool under Friction and you check `/mcp`.
- The read-only roles (`planner`, `explorer`, `reviewer`, `senior-reviewer`) deny `mcp__*` through `denyTools` by default.

Exposure in the child, per allowed server:

| `mcp.json` exposure | In the child |
|---|---|
| `deferred` | stays `deferred` |
| `codemode` | stays `codemode` |
| `direct` | becomes `deferred` (an exact tool name is unknown at setup, and Pi does not declare a `direct` tool under the child's `--tools`; the only up-front path is the `mcp.directProviders` preload below) |
| `hidden` | the server is dropped |

`toolExposure` values map the same way. A `server/tool` entry sets the server `hidden` and lists only the allowed tool names in `toolExposure`; every other override, wildcards included, is dropped. Several `server/tool` entries for one server merge; a bare `server` entry wins. `enabled: false` in `mcp.json` keeps the server off in children too.

Providers that fix the tool list per turn (`mcp.directProviders`, default `["claude-bridge"]`; user or overlay config, `[]` turns it off): pi-claude-bridge builds its tool list once, when a turn starts, so a deferred tool that `tool_search` loads mid-turn is never callable there (the provider answers `No such tool available`). For a child whose model provider id is in that list, core-adapter loads the allowed deferred tools itself before the child's first prompt, as `tool_search` would, so the first request already declares them. It waits up to 10 s for the allowed servers to connect (a server that is down delays the start by that long), loads only tools inside the ceiling and the launch narrowing, and writes the trace event `mcp_child_direct` (`provider`, `servers`, `count`). The prompt grows by the schemas of those tools. Other providers keep on-demand loading. The child's provider id is its model's provider, read at each `before_agent_start` until the first prompt on a listed provider (it may be unset earlier). A `direct` server is not an alternative: under a child's `--tools` allowlist Pi will not declare a `direct` MCP tool, which is why `direct` becomes `deferred` above.

If the running Pi has no MCP loader on disk (for example a compiled Pi binary), MCP is refused in that child with the trace event `mcp_child_unsupported` and a line in the child prompt that the child's report carries under Friction; there is no silent fallback.

Per-launch narrowing: `subagent({ agent, task, mcp: ["server", "server/tool"] })` narrows the ceiling for that one child. Each entry must lie inside the role's ceiling (`server` only if the role lists that server; `server/tool` if the role lists the server or that same entry), else the launch is refused with `pi-foreman: launch mcp entry <x> is outside roles.<role>.mcp`. `mcp: []` means no MCP for that child; an absent field means the full ceiling. `options.mcp` is refused. A server name that `mcp.json` does not know adds a warning line to the launch receipt and the trace event `mcp_launch_unknown_server`; the launch still runs.

Groups take the same field per entry: `tasks[i].mcp`, `chain[i].mcp`, `chain[i].parallel[j].mcp`, and a dynamic fan-out step (`chain[i].parallel` given as an object with `agent`) carries one `mcp` for its children. Each entry is validated against that entry's role. pi-subagents does not yet forward per-entry bindings to the children of a group, so a group that needs MCP (any entry whose role has a non-empty ceiling, or any entry carrying `mcp`) is refused with `pi-foreman: group launches with MCP need pi-subagents with per-entry bindings (pinned <ver>); launch these roles as single subagent({agent, task}) calls`. Groups of roles without a ceiling run as before. A child without a binding fails closed: no MCP, `tool_search` inactive.

Upgrading from the `mcp:` grant: generated agent files that still carry `mcp:` entries make `/foreman doctor` report the settings block as out of sync; re-run `foreman setup` once.

Two config errors:

- `roles.<id>.mcp: role <id> denies <pattern> (denyTools); remove mcp or the deny` (hits the four read-only roles by default).
- `roles.<id>.mcp: only child roles take mcp; the main session already loads every enabled server in mcp.json` (hits `foreman` and `session-foreman`).
