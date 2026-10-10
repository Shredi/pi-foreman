# pi-foreman architecture

## 0. Status and scope

| Item | Value |
|---|---|
| Status | Design, Phase 1c, reviewed by the owner on 2026-10-03 (decisions in §16). Phase 2 builds the walking skeleton from it. |
| Evidence date | 2026-10-03, Pi `@earendil-works/pi-coding-agent` 1.0.0, Node 22, hands-on runs in throwaway directories |
| Evidence format | "hands-on 2026-10-03, Pi 1.0.0, `<package>@<version>`: result". Tests that did not run are marked "not tested". |
| Pin update | 2026-10-07: pin bumped to Pi 1.0.4; unit, installer and replay suites re-run. pi-subagents stays 0.75.0 because 0.76.1 breaks four replay scenarios (idle-parent completion notice, tracked separately). Pi 1.0.4 keeps MCP tools when a tool allowlist names no `mcp__` entry: they are not declared to the model but codemode scripts and tool_search can reach them, so an explorer child with codemode can call MCP tools; PS `"*": "ask"` remains the only gate (a child's ask defers to the parent; headless → denied). Known gap, tracked separately. |
| Pin update | 2026-10-08: pin bumped to Pi 1.1.0 (range 1.1.x); typecheck, unit, installer and replay suites re-run on 1.1.0 (replay 92 run, 0 fail), no fixture changed. pi-subagents 0.75.0, pi-permission-system 39.0.2 and pi-intercom 0.16.1 held; their peer ranges accept 1.1.0. Bench pin pi-claude-bridge 0.9.2 (forwards Pi's custom prompt sections, which carry the foreman rules; 0.9.1 dropped them). Pi 1.1 OSC 7501 program status: Herdr 0.9.3 does not answer the query and pi-permission-system's prompt (`ui.custom`) is not reported as blocked, so the Herdr state feed below stays as is. |
| Latency run | https://github.com/Shredi/pi-foreman/actions/runs/37120750064 |
| Upstream core | Python core from `Shredi/fable5-opus5-orchestrator` (MIT), a fork of `Rylaa/fable5-opus5-orchestrator` (now `Rylaa/fable5-opus5.5-orchestrator`), credited in `NOTICE` |

## 1. Goals and non-goals

| Goals | Non-goals |
|---|---|
| A generic orchestration harness on Pi: a main-session foreman, five subagent roles, a ledger, safety layers and proportional ceremony | A new agent runtime, subagent engine or permission engine. Those are adopted packages. |
| Same behaviour on Linux, macOS and Windows | Native TypeScript guards, unless measured latency ever demands them (§7) |
| Role → model + thinking per provider. Switching provider switches the whole map. | Automatic escalation to a more expensive provider |
| Overlays add without patching. Flow is one-way. | Shipping private or organisation content, or taking content back from overlays |
| One Python core shared by two harnesses: the Claude Code orchestrator plugin and pi-foreman | A third harness. The Codex CLI port is retired, and the OpenAI/Codex subscription is now a Pi provider. |
| Routine safe operations run without a dry-run/apply step | Removing human approval for anything that fails a precondition |
| Benchmarks decide defaults such as codemode and models | Benchmark runs in this phase (design only, §12) |

## 2. Layers and the overlay contract

| Layer | Form | Pins | Owns |
|---|---|---|---|
| L1 pi-foreman (public) | npm Pi package `pi-foreman`: `extensions/`, `agents/`, `skills/`, `core/` (vendored), `scripts/` (own Python), `config/` (defaults + schema), `setup.mjs` | Pi 1.1.x, its third-party packages (§13), core tag | Mechanisms, neutral roles, default policy |
| L2 private overlay | A user's own Pi package plus `foreman.json` in the Pi agent dir | `pi-foreman@x.y.z` exactly | Model maps, extra roles, MCP servers, repository list, personal preferences |
| L3 organisation overlay | Organisation-owned Pi package declaring `pi.foreman.config` in its `package.json` | `pi-foreman@x.y.z` exactly | Provider gateways (via `registerProvider`), internal tools and skills, default policy for its users |

**One-way rule.** Overlays consume a released version and never write into the pi-foreman package directory. The installer refuses to merge overlay keys into L1 files. Nothing from an overlay is copied back into L1. Changes to L1 come as public issues or PRs written from scratch.

### Extension points

| Point | How an overlay contributes | Conflict rule |
|---|---|---|
| Roles | Role files in its package via `pi.subagents.agents`; listed in `roles.<id>.file` | New id: added. Existing id: `promptAppend` adds text; `file` replaces the prompt (L2/L3 only). Ids stay neutral. |
| Providers and models | `providers.<p>` block; the provider itself as a Pi extension (`registerProvider`) | Per leaf, last layer wins (§3) |
| Display names | `displayNames` preset or per-id map | Last layer wins |
| Skills | `skills/` in the overlay package (Pi skills format) | Pi's own resolution; a same-name skill in an overlay shadows L1 with a warning |
| Permission rules | `safety.permissions` entries, generated into the permission-system config, plus the adapter overlay (§5) | Last layer wins (§3); a project file may only add `deny`/`ask` entries |
| Guards and child extensions | `safety.requiredChildExtensions` (paths in the overlay package) | Last layer wins (§3); a project file may only add entries |
| MCP servers | Pi `mcp.json` or `registerMcpServer` from the overlay extension | Pi's rule: a same-name `mcp.json` entry wins |
| Events | Listen on `pi.events` `foreman:*` (`role_launch`, `role_result`, `ledger_phase`, `ceremony_tier`, `retro`) | Read-only notifications. Veto power only through the overlay's own `tool_call` handler or permission rules. |
| Ceremony, fan-out, fallback | `ceremony.*`, `fanout.max`, `providers.<p>.fallback` | Preferences, last layer wins |

**Merge rule.** Every key merges plain last-wins in the order L1 → L3 → L2 → project → session. There are no organisation safety bounds: a user's L2 may change any value an L3 sets. The one exception is the repository's project file `.pi/foreman.json`: it may only tighten `safety.*` keys (a permissive boolean can only become stricter, safety lists can only gain entries), because a cloned repository is not trusted. A loosening attempt is ignored with a warning naming the key.

## 3. Config schema

| File | Layer | Read when |
|---|---|---|
| `<pi-foreman>/config/foreman.defaults.json` | L1 | Always |
| `foreman.json` from the L3 package (`pi.foreman.config`) | L3 | The package is installed |
| `<pi agent dir>/foreman.json` (honours `PI_CODING_AGENT_DIR`) | L2 | Always |
| `.pi/foreman.json` | Project | Only after Pi project trust is resolved |
| `/foreman set …`, launch flags | Session | Not persisted |

| Key class | Examples | Merge (L1 → L3 → L2 → project → session) |
|---|---|---|
| Scalar or list | `displayNames.*`, `providers.*.roles.*.model/thinking`, `roles.*.codemode`, `ceremony.*`, `fanout.max`, `maxThinking`, `safety.*` | Last wins |
| Map | `providers`, `roles`, `safety` | Deep merge; leaves are last-wins |
| Project file on `safety.*` (and some other keys, §5 table) | `safety.children.mayPush`, `safety.review.required`, `safety.permissions.deny/ask`, `safety.requiredChildExtensions`, `safety.git.protectedBranches` | Tighten only: booleans move to the stricter value, lists gain entries, nothing is removed |

**Keys:** `version`, `displayNames`, `roles.<id>.{file, promptAppend, tools, codemode, launch}`, `providers.<p>.roles.<id>.{model, thinking, codemode}`, `providers.<p>.{costTier, fallback}`, `fanout.max`, `maxThinking`, `ceremony.{default, heavySignals, overrides, foremanEdits, scratchDir, reviewBeforePr, trivialBound, required, foremanReads, reviewGate, orientation, recheckBudget, launchWait, dedupeNotify, ledgerHelper, reviewPerRevision, heavyThreshold}`, `safety.{permissions, review, git, children, requiredChildExtensions, ops, subagents}`, `bridge.isolateClaudeConfig`, `providers.<p>.review`, `python.path`, `trace.{enabled, dir}`. Which layer may set which key: §5.

**Validation.** A JSON Schema is shipped in `config/foreman.schema.json`. A stdlib Python validator (`scripts/foreman_config.py`, a supported subset of the schema) runs in three places: the installer, CI, and once at `session_start`, through the adapter (about 50 ms). Rules:
- An unknown key gives a warning.
- An invalid safety key fails closed: the L1 safety values apply, and the user is notified.
- Every role must resolve to a model for the active provider or name a `fallback`. Otherwise the result is a launch error, never a silent default.

**Generation.** pi-foreman's `providers.*` block is the single source. `/foreman apply` and the installer generate pi-subagents' `subagents.agentOverridesByProvider` (and `agentOverrides.<id>.tools` as JSON arrays) into the user's Pi `settings.json`, in a managed block. A hand edit to that block is backed up and then overwritten. pi-subagents keeps resolving the map by the parent's active provider (hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0: the same `/run builder` under `--provider openrouter` and `--provider claude-bridge` gave different child models). Phase 2 checks runtime agent registration as a way to avoid writing settings.

```json
{
  "version": 1,
  "displayNames": "classic",
  "fanout": { "max": 3 },
  "providers": {
    "github-copilot": {
      "costTier": 1,
      "roles": {
        "foreman":  { "model": "github-copilot/claude-sonnet-5.5", "thinking": "high" },
        "explorer": { "model": "github-copilot/gpt-5.4-mini",      "thinking": "low"  }
      },
      "fallback": { "provider": "openrouter", "confirm": true }
    }
  },
  "roles": { "builder": { "codemode": true, "launch": "detached" } },
  "safety": { "permissions": { "ask": ["git push*"] }, "children": { "mayPush": false } }
}
```

## 4. Role model

| Id | Display (preset "classic") | Purpose | Runs as | Default tools (strict allowlist) | Codemode default |
|---|---|---|---|---|---|
| `foreman` | Picard | Triage, plan, ledger, delegate, integrate. Never trusts a child's request blindly. | Main session | All active tools + `subagent` | on |
| `explorer` | Dora | Read-only search, briefs | Child, detached | `read, ls, grep, find, bash`, codemode | on |
| `planner` | Hannibal | Heavy tasks: writes `.workflow/scratch/plan-<topic>.md` for the owner checkpoint (§6) | Child, detached, single launch only | `read, ls, grep, find, write, edit` (no bash by default; write scope in §5), `timeoutMinutes` 20 | off |
| `builder` | Bob | Implements one scoped change | Child, detached | `read, ls, grep, find, bash, edit, write` | off |
| `reviewer` | Watson | Diff review against ledger items | Child, detached | `read, ls, grep, find, bash` | off |
| `senior-reviewer` | Sherlock | Plan review for heavy tasks, security review | Child, detached | Same as reviewer | off |
| `finalizer` | Gandalf | Close-out: verification, commit preparation, summary | Child, detached | `read, ls, grep, find, bash, edit` | off |

- Display names come only from config. A second preset, `"plain"`, shows the ids (`planner` shows as `planner`). No code path compares a display name.
- **The foreman is the main-session role.** It has its own provider-map entry. At `session_start`, pi-foreman looks up `providers.<active>.roles.foreman` and calls:
  - `pi.setModel(model)`. This returns `Promise<boolean>`, and false means the provider has no auth: the extension notifies and keeps the current model.
  - `pi.setThinkingLevel(level)`. Pi clamps the level to the model.

  A later `model_select` by the user is respected and never overridden. Children follow the parent's provider automatically.
- **Thinking levels** in Pi 1.0: `off | minimal | low | medium | high | xhigh | max`. Per-model `thinkingLevelMap` entries remap or null levels. `maxThinking` caps every launch.

### Provider map (illustrative examples, not defaults; benchmarks set real values)

L1 ships `providers: {}`. Ready-made maps are opt-in overlay files under `config/presets/` (never merged by
default; copy them into the user layer). `claude-bridge.json` is the frugal Claude map:

| Role | claude-bridge preset (`model` -> `strong`) | openrouter | github-copilot (Copilot-class, primary target) |
|---|---|---|---|
| foreman | `claude-opus-5-5` / high | a strong paid model / high | `claude-sonnet-5.5` / high |
| explorer, builder, reviewer | `claude-haiku-5-5` / medium -> `claude-sonnet-5-5` / medium | a cheap model -> a coding model | `gpt-5.4-mini` / low |
| planner, finalizer | `claude-sonnet-5-5` / medium, low | a coding model | `gpt-5.5` / low |
| senior-reviewer | `claude-sonnet-5-5` / high | a strong paid model / high | `claude-opus-5.5` / high |
| auto-review (`review.model`) | `claude-haiku-5-5` | the cheapest mapped model (default) | the cheapest mapped model (default) |

The preset ranks fable (0) > opus (1) > sonnet (2) > haiku (3) with `ladder.childPolicy: "below"`, so no child
runs on Opus under an Opus foreman. An overlay keeps Opus for `strong` or `senior-reviewer` simply by naming it in
that role and either setting `childPolicy: "any"` (a private overlay that wants every model available, for
example Opus children under a Fable foreman) or running a foreman ranked above it (Fable). A frugal work overlay
keeps `below`. The preset also sets `childMaxThinking: "high"` (a cap on every child level, rungs included, on
top of `maxThinking`; no L1 default), so no child runs at `max`. `openai.json` (astra > sol > luna) and
`google.json` (pro > flash) follow the same shape (ids from Pi's registry, tiers by capability class).

### Role ladder and rank policy

Two rungs per role: `model` -> `strong`. Triggers, each making the run climb-eligible when it ran on its bottom
rung: (a) context: the child-side hook sees a call whose input + cacheRead + cacheWrite passes `strongAbove`
(`roles.<id>` > `providers.<p>` > `ladder`, default 100000; Haiku 5.5's long-context price tier starts there)
and steers the child once to stop and reply with a handoff report whose first line is `RUNG_UP: context`
(done / remaining / files touched); (b) turns: past `childMaxTurns` assistant turns (same lookup, default 60) the
bottom rung hands off with `RUNG_UP: turns`, the top rung is steered to stop and report (`child_turn_cap`); (c)
stuck: the report says `STATUS: stuck` or "own checks failed"; (d) the foreman passes `model: "strong"` with a
`reason` (never traced: it is a tool argument). A `strong` launch with no reason and no trigger is refused
(`launch_refused` reason `strong_no_reason`); a heavy-tier builder and a `strongOnRevision` revision count as
triggers. The child learns its limits and rung from the launch binding (`usage.ts`), so only single launches are
checked. The foreman relaunches: the launch-wait result of a climb-eligible run ends with a hint, and the next
`strong` launch of that role gets the prior report (bounded at 4000 characters), its result path and the ledger
item lines the task names (else the open items) prepended; the trace records `rung_up {role, from, to, reason}`.
A rung's configured `thinking` (or model suffix) wins over the foreman's level, so the bottom rung never
escalates thinking; the climb is by model.

Harness-side auto-relaunch (not built): the adapter sees the run end (`RUN_END_EVENTS`) but has no API to start a
`subagent` run itself. It could only inject a follow-up message asking the foreman to relaunch, which is a turn
anyway, or call pi-subagents' internals, which would bypass the `tool_call` checks (allowlist, model map, rank
policy, required child extensions, guards) every launch must pass. The foreman's own relaunch keeps those checks
and costs one short foreman turn, so the shipped path is foreman relaunch plus harness-built handoff.

Rank policy: `providers.<p>.ranks` = `[{match: <glob>, tier: <0 = top>}, ...]`, highest first;
`ladder.childPolicy` = `below` (default) | `at-or-below` | `any`, one value for all providers because tiers are
compared across providers (a model is looked up in its own provider's list first, then the others). With ranks
configured, an unranked child or foreman model refuses every launch except under `any`; with no ranks anywhere
the policy is inert, so the shipped defaults behave as before. Strong rungs and relaunches are checked like any
launch. A refusal is traced `launch_refused {reason: rank_policy, policy, foreman, requested}`.

### Builder frugality (explorer brief, child read budget, child prompt)

- **Explorer brief.** The latest completed explorer report of the session (bounded 4000 characters, cut with a marker,
  plus its result path) is prepended once to the next fresh builder launch's task, after any rung-up handoff
  (handoff, brief, task); a resume gets none. Trace `explorer_brief {role, chars}`.
- **Child read budget.** `ceremony.childReads.<role>.{warn,deny}` (defaults builder 20/40, reviewer 15/30, explorer and
  others none) counts a child's read, grep, find, ls and read-only bash calls (`childreads.ts`; a test or build bash
  call is not counted). At warn the result carries a notice; above deny the call is refused and the child is told to
  return its report with what it has, or `STATUS: stuck` (ladder trigger b). Trace `child_read_budget {role, count,
  action}`.
- **Child system prompt: measured, nothing to trim.** Replay fake provider, size mode (`FOREMAN_FAKE_USAGE=size`,
  `FOREMAN_FAKE_SIZES`, `FOREMAN_FAKE_SYSTEM`); estimated tokens = chars / 4, one fixed-size launch each:

  | Role (before = after) | System chars | Est. tokens | Of which |
  |---|---|---|---|
  | builder | 4612 | 1150 | pi-subagents child preamble 480, role prompt 990, intercom block 1490, acceptance contract 1520 |
  | reviewer | 5039 | 1260 | the same, role prompt larger, `instructions/reviewer.md` section ~430 |
  | explorer | 4502 | 1125 | the same, role prompt smaller |
  | foreman (reference) | 31509 | 7880 | Pi base prompt, tool schemas, pi-foreman section, orientation |

  pi-subagents already gives a custom agent a replaced system prompt: no Pi base prompt, no `AGENTS.md`/`CLAUDE.md`,
  no skills catalog (`systemPromptMode: replace`, inherit flags off by default), and the `tools:` frontmatter is a strict
  allowlist (reviewer and explorer have no edit/write). The adapter removes nothing more: the remaining blocks are
  pi-subagents' supervisor and acceptance protocols, and the role prompt. A child system prompt is about 1.1k to 1.3k
  tokens, so a measured 22k to 29k cacheWrite per launch is context growth (tool results), not the prompt; the levers
  are the explorer brief, the read budget and the ladder's context steer. Candidate not taken (changes pi-subagents'
  acceptance gating, a decision for the owner): `acceptance: none` in the frontmatter drops the 1520-character contract
  and the closing JSON report.

How thinking reaches each provider (Pi 1.0.0 catalogue and source):

| Provider | Thinking behaviour | Status |
|---|---|---|
| Copilot Claude models | Adaptive thinking with `effort` | Code read, not run |
| Copilot GPT models | `reasoning.effort` | Code read, not run |
| Copilot Gemini-flash and Kimi models | Send no effort at all, so the level has no effect | Code read, not run |
| Codex subscription | Login through Pi's built-in `openai-codex` provider | Not run |
| claude-bridge | Passed through | Hands-on 2026-10-03, Pi 1.0.0, pi-claude-bridge@0.9.1: `:high` → child `thinking_level_change high` |

- **Per-launch override.** pi-subagents 0.75.0 accepts a level only on a full id. `explorer[model=<provider>/<model>:low]` works. `explorer[model=:high]` fails for native children with "Unknown subagent model" (hands-on 2026-10-03). So the adapter writes every launch's `model` (top level, or each `tasks`/`chain` entry) as the role's mapped `<provider>/<model>:<thinking>` for the active provider; a level the foreman passed applies only to a rung with no configured thinking (clamped by `maxThinking`), and a different model it passed is replaced and traced as `model_override`. If a provider rejects suffixed ids, `subagents.disableThinking` applies.
- **Explicit fallback.** `providers.<p>.fallback` names one provider. Fallback happens only on auth failure or unavailability. A fallback to a higher `costTier` needs a one-time confirmation per session. A role never escalates upward on its own.
- **Fan-out width.** `fanout.max` sets the number of concurrent children (default 3). It is an ordinary preference.

## 5. Safety policy

| Layer | Mechanism | Scope | On error |
|---|---|---|---|
| 1. Permission map | `@gotgenes/pi-permission-system` 39.0.2 (PS): allow/ask/deny, bash wildcards, path and MCP rules. The installer generates PS's global file from L1 → L3 → L2 rules; it owns that file (changes are backed up, then overwritten), and user rules belong in `foreman.json`. The adapter also enforces an overlay by itself, before and independent of PS (below). | Main + children (required child extension) | Fail-closed (package behaviour) |
| 2. Destructive/secret guard | Vendored core `destructive_guard.py` via the adapter (§7) on `bash`/`powershell`. The adapter checks the payload first and sets two opt-in switches for the core: `FABLE_ORCH_GUARD_FAIL_CLOSED=1` (an internal error exits non-zero) and `FABLE_ORCH_GUARD_BIN` (empty: no PATH rewrite). Until the re-pin it drops the core's PATH rewrite itself. PowerShell and cmd patterns are in the core since 0.23.0 (vendored at `8376da1`). | Main + children (required child extension) | Fail-closed: a missing interpreter, a timeout, a non-zero exit or a shell call without a command string blocks it, with a reason that explains the fix. This is stricter than the core's own fail-open, on purpose. |
| 3. Model review of `ask` | Own chain link `foreman-review` on PS's authorizer seam. It reads `providers.<active>.review` (`model`, `timeoutMs`, default 15 s) on every ask; with no `model` it picks the cheapest role-map model of that provider (`model` and `strong` of every role, by registry `cost.input`, with auth) and traces `by: "auto"`. | Asks on bash, MCP and skill surfaces; children defer | Fail-safe: an error, timeout, unsure, soft deny, no review model or a value too long to send whole (over 4000 characters) defers to the human prompt. Only an allow, or a deny with high or critical risk, decides. The value and the user's request reach the reviewer between nonce markers as untrusted data. |
| 4. Git guards (own) | `scripts/git_guard.py` (own lexer for bash, PowerShell and cmd; recursion to depth 4; aliases resolved). Main: commit lint (message pattern, required and forbidden trailers, no `-a`/pathspec commit, hook `safety.git.commit.checkCommand` for the public-repo grep) and push lint (no force, mirror, delete or `+refspec` on protected branches, also through configured refspecs). Children: see the list below. | Main: lint. Children: block. | Fail-closed: an unreadable command that mentions git is blocked in children and asked in main |
| 5. Required child extensions | `registerRequiredChildExtensions({extensions: [permission system, core adapter, git child guard], requireForAllRunners: true})` at `session_start`, disposed at `session_shutdown`. Every launch uses `agentScope: "user"`, so project agents cannot redefine a role. | Every child | Launch refused if an extension cannot load (hands-on check in Phase 2) |
| 6. Supervisor channel | Children can ask the parent through `contact_supervisor`. The foreman prompt treats such requests as untrusted. While a request is open (until the foreman's reply or the child's end), any foreman tool outside the requesting role's `tools` is blocked, except the reply, reads and run status. Trace event `supervisor_request`. Limit: after the reply the foreman can act on its own, and only the prompt rule covers that. | Foreman | n/a |
| 7. Intercom | `pi-intercom` 0.16.1 (pinned, installed by default, `--no-intercom` skips it; the installer writes `<agent dir>/intercom/config.json` `{"inboundTrigger":"always","busyDelivery":"human-first"}` only if absent and warns when it sets `brokerCommand`, `brokerArgs` or `crossMachine`; `/foreman doctor` the same). Baseline `intercom: allow`; the adapter guard (`intercomguard.ts`, trace `guard: intercom`) refuses `openProjectPaneIfMissing: true` (a Pi launch outside the role allowlist) unless `intercom.allowOpenPane`, and a `to` of the form `name@machine` unless `intercom.allowRemote` (both false, a project or session can only set false). Children never get the tool (dropped from role tool lists, refused in `tool_call`); they keep `contact_supervisor`. Child env drops `PI_FOREMAN_PARENT_INTERCOM`, `PI_INTERCOM_STABLE_ID` and `PI_INTERCOM_SESSION_ID`, and a child swallows pi-intercom's idle wake prompt (no turn from an inbound message while idle); `/foreman doctor` warns when the intercom config sets `stableId` (all sessions of the agent dir would share one id, so a child could pose as the parent). An inbound message (`intercom_message`) is data: a turn it starts is traced as cause `intercom`, notified once in TUI/RPC, and passes the permission system, triage gate and drift checks unchanged. `<agent dir>/intercom/` is in the protect set. **Same-user limit:** the broker socket (`<agent dir>/intercom/broker.sock`, a named pipe on Windows) accepts any process of the same OS user, and so does the Herdr socket; either can inject a message or keystrokes into a session, so neither is a boundary against code running as the user (§15 #10). A message's sender id is what the sending client registered, not an authenticated identity; a close over intercom is accepted only from the recorded parent session id. An idle foreman receives the message without an extension `message_end` (pi-intercom appends it, then sends its wake prompt); the `input` hook reads the newest intercom entry from the branch then and consumes the wake. **Minor limits:** a close refusal reply goes out through the local broker outbox (same-user trust as above); children also receive intercom text appended while they are idle, not only text steered into a running turn (the wake is swallowed, the text is still in the session). | Foreman | guard error: call blocked |

**Layer 7, child-orchestrator ping recipe.** A child orchestrator (a foreman started in another Herdr tab or process) reports to its parent with a short text plus a path, never the findings themselves: either `intercom send` to the parent's session id (the spawn tool records it in `PI_FOREMAN_PARENT_INTERCOM`), or `herdr agent prompt <agent> "<one line> see <path>"`. The receiving foreman treats the text as data, reads the file and triages as for any other input; no gate is bypassed. Closing a child uses the same two paths (§7 "Session features").

**Child bash asks: deny and defer path.** PS splits a compound command into units (`;`, `&&`, `|`) and matches each against the generated rules (last match wins: allow, then ask, then deny); a wrapper unit (`timeout`, `env`, `nice`, `xargs`, `sudo`, ...) is floored to `ask` unless the wrapped command is a pure reader, so no baseline glob can allow `timeout 900 cargo test`. The baseline has no `sed` rule: sed takes `w`, `e`, `r` and `s///w` with no blank before the file or command, so no glob can separate a print from a write or an exec, and every sed unit asks. A unit that matches no allow rule hits `*: ask`, PS forwards it to the foreman (the ask carries the child's command in `value`), and the `foreman-review` link decides there. The link allows a `timeout N <cmd>` unit chain, or a chain holding a print-only sed (`sedread.ts`: options -n/-E/-r/-s/-u/-z, addresses and the commands p P l = q Q n N d D { } only), without calling the model when every other unit and the wrapped command are allowed by the same rules (labels `timeout-wrapper`, `sed-read`); otherwise the review model answers allow, deny or defer. A defer goes to the human prompt; with no human (print/json mode, no UI, or `review.headless: true`) a forwarded child ask that deferred is denied with a text that names the allowed forms and the foreman traces `review_defer_headless {role, cmd}`. The link in the child's own session defers with label `child` by design (the foreman decides); real model reviews appear only in the foreman's trace.

**Layer 1b: adapter deny overlay.** PS's own merge can loosen (a project `bash: "allow"` replaces the global deny map), and PS has no session scope. So the adapter enforces the merged deny set (baseline, L1 → L3 → L2, plus project and session additions) in `tool_call`, before PS. Deny beats any allow. Project and session `ask` entries are confirmed in TUI/RPC and denied in print mode and in children. A `.pi/extensions/pi-permission-system` file shipped by a repository can at most turn an ask into an allow; the adapter warns at `session_start` and `/foreman doctor` fails on it. Every word of a shell command is resolved (`~`, `$HOME`, globs in every segment, ANSI-C quoting, braces, case folding on macOS and Windows, symlinks, inline `python -c`/`node -e` strings) and checked, so `cat .env`, `head ~/.ssh/id_x` and `git diff --no-index a .env` deny. The baseline `protect` block adds write protection that PS cannot express: `.git` is denied for every session; the project's `.pi/` and `.agents/`, the agent dir's `foreman.json`, `settings.json`, `agents/`, `npm/`, `extensions/`, `pi-foreman/claude-config/` and `pi-foreman/state/` (drift snapshots), the project's `.claude/` and `.mcp.json`, `~/.claude/`, `~/.gitconfig`, `~/.config/git/` and `$XDG_CONFIG_HOME/git/`, and the package root are asked in the foreman and denied in children (for the package root, shell words are checked in children only). A `.pi/claude-bridge.json` in any directory is denied to children. Removing or renaming the agent dir itself or `<agent dir>/pi-foreman` (the ancestors of the state folder) is asked in the foreman and denied in children: an operand of `rm`, `rmdir`, `unlink`, `trash`, `mv`, `rename`, `del`/`rd`, `Remove-Item`/`Move-Item`/`Rename-Item` and their aliases, `find -delete`, a string in inline code, or foreman_move's source; reading and listing them stays allowed, and `cd` into the folder followed by a relative operand is not seen. `CLAUDE.md` is not protected: claude-bridge excludes it from its turns. Credential files (`~/.git-credentials`, `~/.config/gh/`, `~/.netrc`, `~/_netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/hub`, `~/.config/glab-cli/`) are deny paths, and `gh auth token`, `gh auth status --show-token`, `git credential fill` and `security find-*-password` with `-w`/`-g` are baseline command denies. Paths resolve symlinks of the deepest existing ancestor, so a new file below a symlinked directory is checked at its target; a `<rev>:<path>` word is also checked by its path part. Where the overlay matcher differs from PS:
- It looks up deny rules inside `-c` strings, `eval`, `find -exec` and wrappers. PS floors those to `ask`.
- It checks path-shaped words whether or not the file exists. PS checks a bare name only when it exists.
- It uses a hand-written lexer, not PS's bash grammar. Heredoc bodies are lexed as plain words, so more words are checked, never fewer.
- Path patterns fold case on macOS and Windows and ignore the separator on Windows.
- It ignores per-agent frontmatter and `yoloMode`.
- Not modelled by either: other shell variables, command output used as a path, `cd` tracking, hard links. A recursive command over an ancestor directory (`grep -r x ~`) is not caught.

**Children, git guard.** Blocked: `push` (also through an alias, a computed word or `-c`), `reset --hard/--merge/--keep`, `checkout -- <path>`, `checkout -f/--force`, `switch -f/--force/--discard-changes`, `restore`, `clean` without `-n`, `stash drop/clear`, `branch -D`, moves of protected refs (`branch -f/-m`, `checkout -B`, `switch -C`), `worktree remove --force`, `update-ref -d`, `reflog expire`, `gc --prune`, `read-tree -u`, `checkout-index -f`, `fetch +ref:ref`, `send-pack`, and `git config`/`-c` for `remote.*`, `push.*` and `include.*`. Dynamic program words (`X='git push'; $X`) that mention git are unreadable and therefore blocked.

**Not a sandbox.** The guards work on command strings. Allowing the repo's test and build commands (`npm test`, `pytest`) means allowing code the agent may just have written, such as a changed `package.json` script or a `conftest.py`. So a child with write tools and the allowed test and build commands can run any code as the user. Assume it can read the user's secrets (ssh keys, the `gh` keyring, credential helpers) and push as the user; the stripped environment and the git guard only stop the plain forms. The larger risk is on the foreman side: the foreman's own tests, builds, git hooks, `core.fsmonitor` and claude-bridge turns run whatever a child planted in the workspace, with the foreman's full credentials and without a guard in the way. Mitigations in place: `.git` writes are denied to every session; the foreman is asked before its next git command when the git config or hooks changed since a child was launched (snapshot drift); the project's `.claude/` and `.mcp.json`, `~/.claude/`, the bridge config folder, `~/.gitconfig` and the git config dirs are protected, and `/foreman doctor` fails on project Claude Code hooks, command-running settings (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, status lines, `fileSuggestion`, `processWrapper`, `env`, `enabledPlugins`, `extraKnownMarketplaces`) or `.mcp.json` when claude-bridge is active, and, with any provider, on a project `.pi/claude-bridge.json` that sets an executable path (`provider.pathToClaudeCodeExecutable` or any key named like a path, command, script or helper), `askClaude.enabled`, `askClaude.defaultMode: "full"` or `provider.strictMcpConfig: false` (session start notifies the same); on Windows the protection strips trailing dots and spaces from each path segment, and an 8.3 short name (`CLAUDE~1`) that fits a protected name where that name sits counts as that name (also for the deny paths, `~\SSH~1\id_x`); credential files and token-printing commands are denied; the guard interpreter is never taken from inside the workspace. The real boundary for children is an OS boundary (§15 #10).

**Known limits (string-level).** These pass the overlay and the guards today and are accepted until the OS boundary exists:
- Paths built from variables (`G=.gi; echo x >> ${G}t/config`).
- `cd`/`pushd` targets are not tracked (`cd ~ && cat .s?h/id_ed25519`).
- Code inside `python -c` beyond adjacent literals (`chr(46)+'env'`) and heredoc-fed scripts (`python3 - <<EOF`).
- PowerShell and cmd variants: `iex` on a concatenated string, cmd `for` loop variables, `pwsh -File x.ps1` (like `sh x.sh`).
- Git leftovers in children: `submodule deinit/update --force`, `worktree add --force`, `filter-branch`, `sparse-checkout set`, `lfs prune`, `tag -d`.
- Push through wrappers that re-add the stripped environment or bring their own transport (`uv run env -u … git push`, `npx`, `gh api`).
- Computed program names in main mode (asked, not blocked).
- The supervisor window closes at the end of a run; after that only the prompt rule covers the foreman.
- A project `safety.requiredChildExtensions` path may point inside the repository.
- A nested `.git` created through `foreman_copy`.
- Very long commands make the guards time out; the call is then blocked (fail-closed), not reviewed.
- The PowerShell lookup can fall back to the project's `node_modules`.
- Files outside the protected set that run later: `.husky/*`, `.github/workflows/*`, `.envrc`, `.vscode/tasks.json`, `~/.zshrc`, `~/.local/bin/*` (writes outside the workspace ask through the permission system; inside it they pass).
- Credential sources not in the deny list: cloud CLI default credentials (for example gcloud ADC), `ssh-add -L`, `git credential-osxkeychain get`; and agent-dir files such as `models.json`, `prompts/`, `skills/`.
- Git config drift gate (security review T1): it covers the repository's own config, worktree config (`config.worktree`), in-repo includes and hooks, the submodule git dirs (`.git/modules/**` config and hooks), `info/attributes` and the project's Claude Code settings (`.claude/settings*.json`, `.mcp.json`) and claude-bridge config (`.pi/claude-bridge.json`); the snapshot is persisted per workspace in `<agent dir>/pi-foreman/state/`, so it survives `/new`, `/resume` and a restart. That folder is in the protect set (asked in the foreman, denied in children, for file tools and shell words). Each workspace's first stored snapshot also writes a seen marker next to it that pi-foreman never removes: a snapshot that is missing while its marker exists, or that is unreadable, truncated or does not parse, counts as drift (asked; blocked without a UI), never as a fresh baseline. A true first session (no snapshot, no marker) takes the baseline and says so in a notice. Code that deletes both the snapshot and the marker (a child's `npm test` is not gated) gets a first-session notice, not an ask. Code that rewrites the stored snapshot to match the state it planted passes silently in every later session: the snapshot is not signed, so across sessions the protection is the protect set around the state folder, not the snapshot (within one session the in-memory snapshot still catches it, and each foreman approval or child launch overwrites the file). Not covered: global or system config, includes pointing outside, and git run indirectly by the foreman (inside `npm test`). Any change asks, including a child's allowed `user.name`. A change a child makes while the foreman's own git command runs is absorbed by the re-snapshot after it. The foreman shell sets only `core.fsmonitor=false` and `protocol.ext.allow=never` and keeps the repository's hooks on purpose; only `safe_ops.py` also empties `core.hooksPath`. So `filter.*`, `diff.external`, `diff.*.textconv`, `core.pager` and hooks are covered only by the drift ask. Further limits: submodules whose `.git` is a directory inside their work tree are not snapshotted; two foreman sessions on one workspace share the stored snapshot (last write wins). The Claude settings check (foreman on claude-bridge) runs before every model request, through Pi's `context` event (Pi 1.0.0 emits it in the agent loop right before the provider call). That covers every run start: typed and RPC prompts, runs a detached child's completion notice starts (`sendMessage` with `triggerTurn`, which skips Pi's `input` and `before_agent_start` events), queued follow-ups, steers, and retries or continuations inside a run. On drift it asks; denied or no UI aborts the run before the request reaches the provider (Pi checks the aborted signal while it resolves the provider's auth, before it calls the provider), with a notify, a message in the session and, without a UI, stderr. Typed and RPC prompts are also checked on Pi's `input` event, so they are refused before a run starts. A switch to claude-bridge (`model_select`) checks and notifies. Cache-warming refreshes of a claude-bridge request are stopped while drift is pending. The snapshot also covers the bridge's own project config, `.pi/claude-bridge.json` (pi-claude-bridge 0.9.1 merges it over `<agent dir>/claude-bridge.json`; it is the only project-level bridge config file). Its `provider.pathToClaudeCodeExecutable` is the program the bridge starts: the bridge reads it at extension load for its turns and AskClaude, and re-reads it on every compaction summary, branch summary and one-shot call (the review link). So: compaction and branch summaries on claude-bridge are checked in Pi's `session_before_compact` and `session_before_tree` events and cancelled on drift that is denied or has no UI; the review link never calls a claude-bridge model while drift is pending, it defers to the human. Pi stops at the first handler that cancels, in extension load order, and the bridge's own handler for those two events starts Claude Code, so the cancel works only when pi-foreman loads before pi-claude-bridge. The installer moves the pi-foreman entry in settings.json `packages` before any pi-claude-bridge entry (shown in the dry run, with a backup), and `/foreman doctor` fails when the bridge is listed first. The user-level `<agent dir>/claude-bridge.json` is in the same snapshot (without `startupNoticeShown`, which the bridge writes there itself) and in the protect set (asked in the foreman, denied in children). The doctor judges it with the same keys, but an executable path there is a warning, not a failure, since the user may have set it on purpose. Not covered: with the bridge loaded first (for example a `-e` extension or a hand-edited order), a compaction between two requests of a run (after a tool result pushes the context over the threshold) or a manual `/compact` or `/tree` summary can start the planted program before any check; a compaction before a typed prompt is covered by the `input` check; `/bug` report summaries (interactive, user-started) go straight to the provider with no event; AskClaude, once enabled in the user's bridge config, runs Claude Code with the project's setting sources and `bypassPermissions` whatever the session's provider is, and its tool calls get no drift check. A changed `.pi/claude-bridge.json` takes effect for normal turns only at the next Pi start, where the session-start check reports it. A change made inside a run reaches the bridge's Claude Code process only at its next fresh start, and that process loaded its settings when the run began. In print mode a stored drift blocks claude-bridge runs until it is approved in a session with a UI.
- A filter, textconv or `core.hooksPath` that already points at a tracked script: the drift check sees the config change, not later edits to the tracked script, so a child that edits the script runs its code in the foreman's next git command (security re-check L3).
- Writes into protected folders by commands that never name them (security re-check M3): `git apply`, `patch -p1 < x.diff`, `tar -xf`, `unzip -o`, `cp -R stage/. .`, `rsync -a stage/ ./`. They are not on the allowlist, so a child needs one approved ask, and the reviewer sees only the command text.
- A dangling symlink as a path word (security re-check L1): `cl -> .claude` made before `.claude` exists cannot be resolved, so a write to `cl/settings.json` passes. Creating the link needs another bypass first.
- Windows 8.3 short names of files whose deny rule is a wildcard name (`*.env`, `*.pem`, `*.key`): only literal folder and file names (`.ssh`, `.aws`, `.claude`) are matched against short names, so `ENV~1` for `.env` passes.
- Project Claude Code settings: `env`, `enabledPlugins` and `extraKnownMarketplaces` are flagged as a whole; the doctor cannot tell a harmless `env` entry from one that runs code.
- The installer (`setup.mjs`) resolves Python without the workspace check the adapter applies.
- Order of checks: the permission system's handler runs before the adapter's (package load order). A command it asks about reaches the human or the review link first; the adapter's guards (destructive guard, git guard) run only after an approval and can still block it. Live run 2: `git push --force origin main` was denied by the review link before push lint saw it.

**Foreman shell-write scanner** (`scripts/shell_write_guard.py`, run by the adapter on the foreman's `bash` and `powershell` calls at every tier, trivial included; children are not checked). It reads the command string and refuses it when it would write a file inside the workspace and outside the allowed dirs: `<workspace>/.workflow/` always (ledger and notes), plus `ceremony.scratchDir` in `scratchpad` mode (§6, foreman edit modes). It covers redirects, `tee`, in-place edits (`sed -i`, `perl -i`, `ruby -i`), `cp`/`mv`/`install`/`ln`/`rsync` destinations, `touch`/`truncate`/`dd`, deletes and renames (`rm`, `rmdir`, `unlink`, `shred`, `git rm`, `git mv`, `git clean`), `sort -o`, `curl -o|-O`, `wget`, `tar x`, `unzip`, `awk -i inplace`, git forms that rewrite the tree (`apply`, `am`, `restore`, every `checkout`/`switch` except creating a branch at HEAD, `stash pop|apply`, `reset --hard`), `patch`, and interpreter code (`python`, `node`, `perl`, `ruby`, `deno`, `tsx`: `-c`/`-e`, here-docs, piped text) with a write-open pattern (method `.open('w')` included); `sh -c` (option clusters too), here-docs and `eval` are scanned as shell. It tracks `cd`/`pushd` (subshell-scoped), resolves file targets through symlinks before `..`, looks through wrappers (`sudo`, `env`, `timeout`, `xargs`, `find -exec`, ...) and project runners (`uv run`, `poetry run`, `pipenv run`, `npx`, `pnpm exec|dlx`, `yarn exec`, `bunx`) and scans `$(..)`, backticks and process substitutions. It is conservative: an unresolvable target (`$VAR`, glob, brace list, a cwd lost through `cd $X`) counts as a write, and a command that cannot be tokenised or nests deeper than 4 is refused. Fail-closed: an internal error blocks the call. A refusal tells the foreman to use `edit`/`write` (measured by the trivial bound, §6) or delegate; trace `shell_write_refused` with the write form as `kind`, never the command. **Blind spots** (not a sandbox; they belong to the OS-boundary round): a script written earlier and run later (`python .workflow/x.py`, `bash x.sh`, `source`, `make`, `npm run`); build and format tools that write (`cargo fmt`, `gofmt -w`, `prettier --write`, `npm install`, code generators); composed program names, aliases and shell functions; interpreter writes through other APIs (`subprocess`, `os.system`, `zipfile`, `sqlite`, `os.chdir` before a relative open, `$^I`); git forms outside the list (`merge`, `pull`, `rebase`, `cherry-pick`, `revert`, `stash push`, `worktree`); a symlink into the project made under `.workflow/` in the same call. **PowerShell** (`shell: "powershell"`) gets a small cmdlet scan: `Set-Content`, `Add-Content`, `Clear-Content`, `Out-File`, `Tee-Object`, `New-Item`, `Copy-Item`, `Move-Item`, `Remove-Item`, `Rename-Item` and their aliases, `-OutFile`/`-DestinationPath`, `>`/`>>` (not `$null`), `[IO.File]::` writers, `Set-Location` tracking; other programs get the bash analysis. Its blind spots: other writing cmdlets and .NET types, `cmd /c`, script files, `iex $var`. All of this is part of the OS-boundary round (§15 #10).

The foreman's edit modes (`ceremony.foremanEdits`) and the review-before-PR gate are described in §6 (Foreman edit modes and the PR gate).

**Planner write scope.** The `planner` role has `write` and `edit` but may write only where the foreman's scratchpad mode may: the same allowed-roots rule, applied child side (`.workflow/` and `ceremony.scratchDir`; resolved path, no symlink component, hard-linked files refused, workspace only: a target outside the workspace, absolute, `~` or `..`, by lexical or real path, is refused too, unlike the foreman's edit mode). It is binding-based: the child's adapter knows its role only from the launch binding the adapter wrote, which exists for single launches only. So `planner` is launched as a single launch and refused inside `tasks`, `chain` and on `resume` (trace `launch_refused {reason: "planner_single"}`). The gate covers `write`, `edit`, `foreman_move` and `foreman_copy`; a refused call is traced `planner_write_refused {kind}`. Without a binding a child cannot be recognised as a planner, which is why there is no heuristic and no multi-launch form. An overlay may add `bash` to the planner (L1/L3 only); the shell write guard then runs for the planner with `.workflow/` and the scratch dir as allowed dirs and `confine` set, so a shell write outside the workspace is refused as well. Git writes and PR forms stay refused for every child. A `subagent` call with `output` (other than `false`) or `outputMode`, at the top level or in any `tasks[]`, `chain[]` or `chain[].parallel[]` step, is refused for every role with the other launch checks, before the spawn gate (`launch_refused {reason: "output_path"}`): pi-subagents would write the child's final reply to that path itself, past every tool hook and the edit mode.

**Child shell baseline.** `cd *` is allowed in the permission baseline, so a child can run `cd <dir> && <allowed command>`; each unit of the compound still needs its own allow. For children only, an adapter deny check (deny-only, it never allows) resolves every `cd`/`pushd`/`popd` target cumulatively from the session cwd and denies the command unless each one is provably inside the workspace (symlinks resolved); a target that is not literal (`$VAR`, `$(..)`, glob, `~`, `-`, bare `cd`) denies. `bg_wait` and `contact_supervisor` are allowed in the baseline, so a child can wait on a background job and ask its supervisor (§5 layer 6).

**Child env (security review S9).** A child's env has `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN` and similar variables removed, the credential helper reset, `core.sshCommand=false` and an invalid `pushInsteadOf` set. This is a speed bump, not a boundary: the plain `git fetch`/`git push` and `gh` calls fail, but code a child runs can still reach the `gh` keyring, ssh keys or credential helpers (see "Not a sandbox"). The foreman does the network git. `safety.children.mayPush: true` (L1/L3/L2 only) lifts it.

**Layer 3, why an own link.** `pi-permission-ai-guard` 0.13.0 reads its config once at `session_start` and builds its reviewer pool once; its session overrides cover only mode and notification level. Switching to a provider with another review model therefore needs a restart (probe: after a switch, the old reviewer still decided). Its verdict paths did behave: allow no prompt, deny-high denied, soft deny, defer, garbage, empty reply, provider error and hang all reached the human prompt. So `foreman-review` (about 150 lines) keeps those semantics, with its own try/catch and timeout, and ai-guard is not installed. A failure of the link shows the human prompt, never a block or a silent allow. Each decision is logged to PS's review log without the command, and `scripts/review_log_stats.py` counts approvals per session.

Evidence:
- Layer 1, hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0 + pi-permission-system@39.0.2:
  - A **detached** child's `ask` reached the parent as `extension_ui_request` with the options "Yes / Yes, for this session / No / No, provide reason", and both approve and deny round-tripped.
  - A **foreground** child (`async:false`) ran ungated without the required extension, and with it the ask was auto-denied ("no interactive UI"). So every role launches detached (`roles.*.launch`).
  - `@gotgenes/pi-subagents`@22.0.0 forwards foreground asks and is the fallback (§13).
- Layer 3, hands-on 2026-10-03 and 2026-10-04, Pi 1.0.0, ai-guard@0.13.0 + PS@39.0.2: the verdict paths worked (see above), the provider switch did not. Replacement `foreman-review`: replay covers allow, deny-high, deny-low, defer, garbage, empty, error, hang and a provider switch without restart.
- Layer 5, hands-on 2026-10-03, pi-subagents@0.75.0: a required child extension blocked a marker command in the child, and the control run without it did not block.

### Precondition-checked operations (replaces the dry-run/apply helper step)

The tools are registered by pi-foreman. The logic is own Python in `scripts/safe_ops.py`, so the Claude Code plugin can reuse it. Each tool re-checks its preconditions immediately before acting. If every precondition holds, it runs **without approval**. If any fails, it returns `precondition failed: <which>` and does nothing. The agent may then take the normal path, which goes through layers 1–3.

| Tool | Preconditions (all required) | Action |
|---|---|---|
| `foreman_worktree_remove` | The path is a linked worktree of the current repo (not the main one). `git status --porcelain` is empty, including untracked files. There are no ignored files, except paths under `safety.ops.worktreeDisposable`. The worktree HEAD is merged into the base branch, or contained in its pushed upstream. No stash entries reference the branch. | `git worktree remove <path>` (no `--force`), then `git branch -d` (never `-D`) |
| `foreman_move` | The real paths of source and destination are inside the workspace root, with symlinks resolved. The destination does not exist. Neither path is inside `.git/`. A tracked source is clean. | `git mv` if tracked, otherwise a rename with no-overwrite semantics |
| `foreman_copy` | Same path rules. The destination does not exist. The source is a regular file or directory under a size cap. | Exclusive-create copy (`COPYFILE_EXCL` semantics) |

All three are recorded in the trace (§10, field `precondition`, name only) and counted by `/retro`.

- **Who gets them.** The builder has `foreman_move` and `foreman_copy`. `foreman_worktree_remove` is for the foreman only. The overlay treats the tools' paths like file-tool paths: `foreman_copy .env x` and a move into `.git/` deny.
- **Ignored files.** `git worktree remove` deletes ignored files, and they can hold results that exist nowhere else (this repo's `.workflow/` is one). So any ignored file outside `safety.ops.worktreeDisposable` (default `node_modules/`, `target/`, `dist/`, `build/`, `__pycache__/`, `.venv/`) fails the precondition. A project cannot extend that list.
- **Directory-move limit.** The standard library has no `RENAME_NOREPLACE`. A directory or untracked symlink is moved by check-then-rename, so another process could create the destination in between. Files use `os.link` plus unlink, and tracked paths use `git mv`, so the window exists for directories only. Symlinks are resolved once; a swap after the check is not detected.

### Safety and loosening keys by layer

Direction: **tighten** keys may be set by every layer; the project file (`.pi/foreman.json`) and the session may only make them stricter. **Loosen** keys are set by L1, L3 and L2 only; the project file ignores them with a warning, and the session drops them.

| Key | Layer | Direction | Project / session |
|---|---|---|---|
| `safety.children.mayPush` | 1, 4 | `true` loosens | only `false` |
| `safety.review.required` | 3 | `true` is strict | only `true` |
| `safety.permissions.deny`, `ask`, `paths.deny`, `paths.ask` | 1 | tighten | entries are added |
| `safety.permissions.allow` | 1 | loosen | cannot be extended (intersection) |
| `safety.permissions.projectCommands` | 1 | loosen (allows commands) | ignored |
| `safety.requiredChildExtensions` | 5 | tighten | entries are added |
| `safety.git.protectedBranches` | 4 | tighten | entries are added |
| `safety.git.commit.requiredTrailers`, `forbiddenTrailers` | 4 | tighten | entries are added |
| `safety.git.commit.messagePattern` | 4 | loosen (a pattern can accept anything) | ignored |
| `safety.git.commit.checkCommand` | 4 | runs a program | ignored |
| `safety.ops.copyMaxBytes` | ops | lower is tighter | only a lower value |
| `safety.ops.worktreeDisposable`, `safety.ops.baseBranch` | ops | loosen | ignored |
| `safety.subagents.allowWorkflow` | launch | `true` loosens (workflow scripts and `schedule.*` can name any agent); at tier heavy such calls stay refused (`launch_refused {reason: "unchecked_heavy"}`), since neither the builder gate nor the planner rule sees inside them | ignored |
| `python.*` (also `python.path`) | 2, 4 | chooses the executable that runs every guard | ignored |
| `roles.*.tools` | 5 | narrow only | intersection with the L1 → L3 → L2 list |
| `roles.<new id>`, `providers.*.roles.<new id>` | 5 | a new launchable role | ignored |
| `roles.*.launch`, `roles.*.file` | 5 | loosen | ignored |
| `roles.*.codemode`, `providers.*.roles.*.codemode` | 5 | `true` adds a tool | only `false` |
| `providers.*.review` | 3 | a review model approves asks | ignored |
| `providers.*.roles.*.strong` | launch | picks a stronger, costlier model | ignored |
| `ladder.*`, `providers.*.ranks`, `providers.*.strongAbove`/`childMaxTurns`, `roles.*.strongAbove`/`childMaxTurns` | launch | the ladder and the child rank policy decide which models run | ignored |
| `providers.*.strongOnRevision` | launch | `true` loosens (revision rounds run on the strong model) | only `false` |
| `ceremony.revisionRounds.standard`, `.heavy` | 6 | higher loosens | only a lower value |
| `ceremony.requireTriage` | 6 | `false` loosens | only `true` |
| `ceremony.heavySignals` | 6 | removing a signal loosens | union with the earlier layers |
| `ceremony.heavyFileCount` | 6 | higher loosens | only a lower value, minimum 1 |
| `ceremony.default` | 6 | a lower tier loosens | only a higher tier |
| `ceremony.foremanEdits` | 6 | `bounded` loosens (the foreman edits project files itself, up to the trivial bound) | only a move toward `readonly` (`readonly` < `scratchpad` < `bounded`) |
| `ceremony.foremanReads.<phase>.warn`, `.deny` | 6 | higher lets the foreman read more | only a lower value, minimum 1 |
| `ceremony.reviewGate` | 6 | `verdict` lets a FAIL satisfy the reviewer step | only a move to `pass` |
| `ceremony.orientation.enabled`, `.maxLines` | 6 | none (context only) | free per layer |
| `ceremony.recheckBudget` | 6 | higher lets the foreman check more after a PASS | only a lower value, minimum 0 |
| `ceremony.launchWait` | 6 | `detach` costs a `bg_wait` turn per launch (not a safety loosening) | only a move to `block` (`detach` < `block`) |
| `ceremony.dedupeNotify` | 6 | `false` keeps duplicate notices in the context | only `true` |
| `ceremony.ledgerHelper` | 6 | `off`/`bash` restore the shell `ledger` path (compound commands need approval) | only a move toward `off` (`off` < `bash` < `tool`) |
| `ceremony.reviewPerRevision` | 6 | `false` lifts the duplicate-review refusal | only `true` |
| `ceremony.heavyThreshold` | 6 | `eee843d` escalates on keyword signals, so it tightens the ceremony | only a move toward `eee843d` (`eee843d` < `strict`) |
| `ceremony.scratchDir` | 6 | a wider directory loosens | only a subpath of the lower layer's value; workspace-relative, never the root, never outside the workspace (symlinks resolved) |
| `ceremony.reviewBeforePr` | 6 | `false` loosens | only `true` |
| `ceremony.trivialBound.files`, `.lines`, `.newFiles` | 6 | higher lets the foreman change more itself | only a lower value per field, minimum 0 |
| `ceremony.required.standard`, `.heavy` | 6 | removing a step loosens (heavy default: `planner`, `builder`, `reviewer`, `finalizer`) | steps are added (union; unknown steps dropped) |
| `roles.planner.tools` | launch | adding `bash` loosens (the shell write guard then covers it) | only narrowing |
| `ceremony`, `ceremony.revisionRounds` not an object | 6 | `null` drops every escalation | ignored |
| `roles.*.timeoutMinutes` | launch | higher loosens | only a lower value |
| `bridge.isolateClaudeConfig` | bridge | `false` loosens | ignored |
| `trace.dir` | trace | writes outside the workspace | only inside the workspace (symlinks resolved) |

Each layer is validated on its own: an invalid safety entry is dropped from that layer only, with a warning. Documented limit: `maxThinking` is plain last-wins, so a project can raise the thinking ceiling. It costs money and grants no access. Subagent management actions are a fail-closed allowlist; `resume` passes only for a run this session launched, with the same role and mapped model. Checking launches made inside workflow scripts is Phase 4 (§15).

### Bridge isolation

A claude-bridge turn loads the host's Claude Code setup (settings, hooks, plugins, `CLAUDE.md`) through the SDK child, which also pulls the host orchestrator profile into the prompt. `bridge.isolateClaudeConfig` (`"auto"` by default: on when the active provider is `claude-bridge`) makes the adapter set `CLAUDE_CONFIG_DIR` to `<agent dir>/pi-foreman/claude-config/` (mode 0700) at `session_start` and `model_select`. `/foreman doctor` checks that the folder holds no `hooks/`, `CLAUDE.md`, `agents/`, `skills/` or `commands/`, no installed plugins (`plugins/installed_plugins.json` entries or a non-empty `plugins/cache/`; a marketplace catalog alone is INFO) and no `settings*.json` that is unparseable or holds a key outside an allow list of display keys (`$schema`, `theme`, `verbose`, `preferredNotifChannel`, `spinnerTipsEnabled`, `editorMode`: INFO); code-loading keys (`hooks`, `env`, `enabledPlugins`, `extraKnownMarketplaces`, command helpers such as `apiKeyHelper`, `statusLine`, `mcpServers`) and every other key (`permissions`, `enableAllProjectMcpServers`, `enabledMcpjsonServers`, ...) fail by name, and that a login is present (presence only, never the value). One-time login: run `CLAUDE_CONFIG_DIR=<folder> claude`, then `/login`, or set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Hands-on 2026-10-04, Pi 1.0.0, pi-claude-bridge@0.9.1, Sonnet: with the key the host profile was absent and the same question wrote 325 cache tokens instead of 2372; without a login the turn fails with "Not logged in". The folder also receives cloud-fetched `remote-settings.json` and `policy-limits.json`; the doctor lists them as INFO. Isolation covers the user level only: the bridge still loads the project's `.claude/settings*.json` and `.mcp.json`, so with claude-bridge active the adapter notifies at `session_start` and on a switch to claude-bridge (`model_select`), and `/foreman doctor` fails, when they hold `hooks`, a command-running key such as `apiKeyHelper` or `awsAuthRefresh`, or MCP servers, and children cannot write them (§5 layer 1b).

## 6. Ledger, gates and proportional ceremony

The ledger, spawn gate, write gate and stop gate come from the vendored core (§7). The foreman triages every task once, records the tier in the ledger header, and escalates automatically on new signals. It never de-escalates automatically. The user can override the tier with `/ceremony <tier>`.

| Tier | Signals (configurable `ceremony.heavySignals`) | Ledger | Plan review | Children | Finalizer |
|---|---|---|---|---|---|
| trivial | One source file within `trivialBound`, no exported signature or schema change, no test file touched, a test present (checked at finish) | Only for a change (`Tier: trivial`, no V item) | No | One builder on its default model (builder path), or the foreman's own edit in `bounded` mode | No |
| standard | Several files in one area, one phase | Yes | Foreman's own short `plan-<topic>.md`, no checkpoint | explorer → builder → reviewer | No |
| heavy | Several phases or areas, deletes or migrations, safety, auth, CI or release work, a public API, or more than N files | Yes | `planner` writes the plan, owner checkpoint (`foreman_checkpoint`) before any builder | Full set; builders may fan out | Yes |

**Tiers and the gate.** The core's spawn gate stays the enforcement; the tier is only the foreman's routing. A trivial task without a change has no ledger and at most one short `explorer` launch, which stays below the gate's threshold; a trivial change keeps a `Tier: trivial` ledger (trivial builder path, below). Standard and heavy tasks write the ledger first; the gate denies further launches until the session has its own ledger, and the stop gate blocks ending while items are open.

The foreman creates the ledger with the `write` tool, never through the shell, so the write binds the session to it; the tier is a line `Tier: <tier>` directly under the ledger title, and a bound ledger without that line counts as `standard`.

**Triage is enforced** (`ceremony.requireTriage`, default true; a project or session can only set true). The foreman records the tier with its own tool `foreman_triage({tier, reason})` (not registered in children), the ledger header or `/ceremony`. `foreman_triage` never lowers a recorded or escalated tier; it returns an error text instead. In `bounded` mode (the edit modes are described below) a gate in the foreman's `tool_call` refuses `write`, `edit`, `foreman_move` (source and destination) and `foreman_copy` (destination) on paths inside the workspace while the tier is untriaged (the config default, or only escalated by a signal) and always at standard and heavy. The refusal tells the foreman what to do: call `foreman_triage`, and at standard or heavy launch a builder. `.workflow/**` (ledger, notes) stays writable. Paths are checked as given and resolved by the OS (`fs.realpathSync.native`: symlinks, Windows short names, a `\\?\` prefix; deepest existing ancestor), against the workspace root as given and resolved, so a link cannot carry a write into the workspace, and the `.workflow` exemption holds only when the resolved target lies in the real `.workflow` folder. Paths outside the workspace keep the overlay rules (§5). Writes from the foreman's shell are refused by the shell-write scanner (§5). **Known limit:** the scanner is a string scan with blind spots, and write tools from MCP servers or other extensions are not gated either: the gate knows `write`, `edit`, `foreman_move` and `foreman_copy` by name. Phase 4: OS boundary (§15 #10). `foreman_copy`/`foreman_move` destinations count toward `ceremony.heavyFileCount` like `write`/`edit`.

**Heavy plan checkpoint.** The heavy flow is ledger, `planner` (writes `<scratchDir>/plan-<topic>.md`), `foreman_checkpoint(path)`, builder(s), finalizer, reviewer, PR. The plan gate belongs to the ceremony, the plan writing to a role; **plan mode** (a Pi session toggle) **is not part of the ceremony, the checkpoint is**, and nothing here reads plan mode. `foreman_checkpoint` is registered only in the foreman. The path must resolve inside the workspace under the scratch dir, be a regular file named `plan-<topic>.md` (topic `[A-Za-z0-9._-]{1,64}`), without symlink component or extra hard links, at most 256 KiB. The harness hashes the bytes itself (sha256; the model never supplies a hash) and shows a dialog without a timeout: a summary notice, then `select` titled `pi-foreman checkpoint: plan-<topic>.md (<hash8>)` with `revise`, `reject`, `approve` (approve last, so it is never the preselected option); `revise` asks for the change as text. The tool is registered with `executionMode: "sequential"`, so no other tool call of the same message runs during the dialog; on `approve` the file is read and hashed again and the approval applies only if the hash is still the one shown (otherwise the record stays pending, trace decision `pending`). While a planner run of this session is active the checkpoint is refused (decision `refused`, record unchanged). The record is `{topic, path, hash, approvedAt, by}` and is set pending before the dialog opens, so an abort never leaves it approved. `by` is `user` in the TUI and `rig` over RPC (an RPC client driven by a human is recorded as `rig`: never claim a user approval that cannot be seen). Print or json mode, no UI, or a dismissed dialog leaves the record pending; **the harness never approves on its own and never turns a timeout into approval**. The same bytes recreated have the same hash and stay approved; a changed plan needs a new approval.

At tier heavy a `subagent` launch that includes a `builder` (top level, `tasks`, `chain`, `chain` parallel entries or a `resume` of a builder run) is refused before the revision-round check, so a refused builder consumes no round, with `launch_refused` and one of: `plan_required` (no record, or the plan was rejected), `checkpoint_pending` (pending or revise), `plan_changed` (approved, but the file's hash differs now or the file is gone or a link). The tier is read at call time, so a mid-session escalation gates the next builder. `revise` returns the owner's words; the foreman re-plans (a planner relaunch or its own edit) and checkpoints again. `reject` stops the heavy path with a visible warning; the finish gate at heavy then also names the missing `plan` (`finish_refused {missing: "...,plan"}`) until a new approval or the user lowers the tier with `/ceremony`. The two-refusal pressure valve stays: after two refusals per user prompt the third settle passes visibly with `ceremony_incomplete`; it never approves a plan and never launches a builder. The record lives in memory; a restarted session checkpoints again. At standard the foreman writes its own plan to the scratch dir; the adapter only counts it (`plan_written`).

**Read budget.** `ceremony.foremanReads.<before|after>.{warn,deny}` (defaults 4/8 before and after) limit the foreman's own read-class calls (`bash`, `read`, `grep`, `find`, `ls`, `codemode`). A call counts by its distinct top-level call id, so a codemode script and its nested calls are one unit. Phase `before` lasts until the first child launch that started, `after` from the latest one. At `warn` the result carries a notice; above `deny` the call is refused (trace `read_budget`). A fresh explorer launch that starts (not a `resume`) lifts a deny once per phase; a second deny needs the user's `/foreman budget lift`. The deny text points at the explorer and at that command. The former 6/12 `before` default can be restored only from the user layer (lower_only). The state is in memory and resets to phase `before` with each new user prompt.

**Review gate.** `ceremony.reviewGate` (`pass` default, `verdict`) decides what satisfies the `reviewer` required step. With `pass` the latest reviewer or senior-reviewer verdict must be PASS (APPROVE) and no revision (a builder launch or a foreman project-file edit; not a finalizer launch or a scratchpad write) may follow it; a FAIL or a later revision re-opens the step. Each reviewer or senior-reviewer launch while the step is re-opened traces `rereview {role, after: fail|revision}` (bench column `rereviews`). `verdict` keeps the old rule (any verdict counts). The escape hatch is unchanged: after 2 refusals the finish passes with `ceremony_incomplete`. **One review per revision** (`ceremony.reviewPerRevision`, default true; project/session cannot turn it off). After a reviewer or senior-reviewer PASS with no revision since, a second reviewer launch is refused (trace `review_dup_refused {agent}`; bench column `dup_reviews`). A second opinion is allowed when the launch task text contains the marker `[second-opinion]` (pi-subagents has no `reason` parameter; an `input.reason` of `second-opinion` is accepted too); the foreman instructions allow it only for auth or safety changes, a heavy tier, or when the first reviewer could not run the tests (trace `review_second_opinion {agent}`, bench column `second_opinions`). A launch that includes a builder is a revision, not a duplicate. **Known gap:** the PASS is recorded when the reviewer run ends, so a second reviewer launched while the first still runs is not caught. **Harness-attested V close** (`ceremony.ledgerHelper: tool`): the foreman marks item V itself with `foreman_ledger({action: "mark", items: ["V"]})` once a reviewer PASS stands with no builder launch or project edit since; the tool refuses otherwise, and the note says so (`closed by the foreman after a reviewer PASS ... (harness-attested)`). A reviewer child may call the same tool, but only to mark V on the foreman's ledger. The tool is the foreman's alternative to the shell `ledger` command; every call is traced `ledger_call {kind, allowed, items, attested}` (foreman only; bench columns `ledger_calls`, `ledger_denies`). The 2g bench run's foreman and reviewer denies came from the `ledger -f F <sub>` form, which the permission baseline does not allow (the permission system splits compound commands and matches each part); the tool path sidesteps the shell permission check. A pure-ledger shell command (with the helper on) is exempt from the read and recheck budgets, and the tool is not a read-class call. **Strict triage** (`ceremony.heavyThreshold: strict`, default): `ceremony.heavySignals` keyword hits in a request no longer escalate to heavy; they are a hint shown to the foreman (trace `triage_hint`), and the instructions reserve heavy for multi-component or risky changes (several packages, schema/API/wire-format change, concurrency redesign, migrations, deletes, auth/safety), not task length or file count. `eee843d` restores keyword escalation. The tier of a bench cell comes from the foreman's own trace only; a child session never records one. The core stop gate holding the foreman's finish (open ledger items) is traced `stop_hold` (bench column `stop_hold`).

**Orientation.** `ceremony.orientation {enabled: true, maxLines: 120}` adds a repository packet (tracked-file tree to depth 2 from `git ls-files`, first 30 lines of AGENTS.md or README.md, detected build/test commands, explorer hint with the read budget; relative paths only, deterministic, capped at `maxLines`) to the foreman's context once per session, so it need not spend read budget on it. Trace `orientation {lines}` (0 when disabled or outside a git repository; bench column `orient_lines`).

**Recheck budget.** `ceremony.recheckBudget` (default 3) is the number of read-class calls the foreman may make after a reviewer PASS; the next one is refused with "the reviewer passed; finish now" (trace `recheck_budget`) and the read budget does not apply in that state. The count resets on a reviewer FAIL, a builder launch, a foreman change of a project file after the PASS (not a write under `.workflow/` or the scratch dir), or a new user prompt.

**Launch-wait.** With `ceremony.launchWait: "block"` (default) the tool_result handler holds the result of a foreman `subagent` launch until the run ends, a supervisor request of any child run arrives (pi-subagents' `pi-intercom:detach-request` event; it releases every held launch, the others with "still running, continue with `bg_wait <id>`"), the turn is aborted, or `wait.maxSeconds` (or the child role's `timeoutMinutes` plus 60 s, when shorter) passes, and appends the outcome (child output, "still running, continue with `bg_wait <id>`", or "cancelled") to the result; the foreman then needs no `bg_wait` turn. Pi 1.0.4 runs the tool calls of one assistant message in parallel, so every launch of the message is held concurrently; if a sequential tool (`foreman_checkpoint`) is in the message, only the last launch is held. A launch from inside codemode is never held. Trace `launch_wait {role, runId, outcome, ms}`. `detach` restores the earlier behaviour.

**Notify dedupe.** pi-subagents delivers every completion as a `subagent-notify` message that repeats a result the foreman already has. With `ceremony.dedupeNotify` (default true) the `context` handler drops such a notice from the model context (a one-line stub stays available as `mode: "stub"`) when every run it reports was delivered by an earlier launch-wait "done" result (only pi-foreman's own marker counts: the last text block of a non-error `subagent` result starts with it and the result's details name that run; a `bg_wait` result carries only an archive path, so a notice after it stays intact). The rewrite is a pure function of the history, so the provider cache prefix stays stable from the first request that sees it; the held launch result also loses every pi-subagents async-started guidance line (trace `notify_deduped`).

**Required steps at triage.** The `foreman_triage` result and the system prompt state the finish steps `ceremony.required[tier]` asks for ("Before you finish: a builder run must complete, a reviewer must pass."), so the foreman does not learn them from a refused finish.

**Foreman edit modes and the PR gate.** `ceremony.foremanEdits` (default `scratchpad`) decides what the foreman may write itself, independent of `requireTriage`. `readonly`: only `.workflow/`. `scratchpad`: `.workflow/` and `ceremony.scratchDir` (default `.workflow/scratch`, for notes, drafts, commit messages and review pages). `.workflow/` stays writable in every mode because the harness keeps the ledger and state there. A target is allowed only when its resolved path (symlinks followed, as above) lies under an allowed root; the shell-write scanner gets the same roots (`allowed_dirs`). Anything else is refused with "delegate to a builder" (trace `foreman_edit_refused {mode, kind}`, `kind` the tool or `shell`), sets `needsChange`, and makes the task standard (`triage_escalated {reason: "edit_mode"}`; an untriaged session records a later trivial as standard). `bounded` restores the earlier behaviour: the triage gate and the trivial bound. **PR gate** (`ceremony.reviewBeforePr`, default true): when a reviewer or senior-reviewer run ends with a verdict, the adapter records the verdict and the `HEAD` of the run's cwd, only if it equals that `HEAD` at the reviewer's launch (else no head is recorded). A PR-creating command (`gh pr create` or its alias `gh pr new`, a write `gh api .../pulls`, `glab mr create`, `hub pull-request`, `tea pr create`, a push with a merge-request or topic push option or to `refs/for/*`, and PR tools of loaded packages by name) is refused unless the head it opens from has a recorded PASS (trace `pr_refused {reason}`: `no_review`, `stale_review`, `head_unknown`, `child`, `pr_alias`, `pr_compound`, `pr_config`). With the gate on, also refused: `gh alias set|import` and any gh top-level word that is not a built-in command (`pr_alias`); push options from `-c push.pushOption`, `GIT_CONFIG_*` in the environment or the repository's `push.pushOption`; `git config push.pushOption <PR key>` (`pr_config`); `gh api graphql` with an unreadable body; a PR form in a compound command with a `cd`/`pushd`/`Set-Location` or a HEAD- or ref-changing git/gh segment (`pr_compound`, "run the PR step on its own"); for `gh pr create`, an upstream of the head that is not a reviewed head (`stale_review`); a computed refspec on a PR push (`head_unknown`). Package PR tools (snake, kebab or camelCase names with `pr`/`mr`/pull or merge request plus create/open) check their `head`/`source_branch`/`sourceBranch`/`branch`/`head_branch` argument, resolved in the workspace, instead of HEAD. Consequences: start the reviewer in the checkout that will be PR'd; a commit after the PASS, a finalizer's included, changes HEAD and makes the review stale, so the heavy order is builder, finalizer, reviewer, PR, or review twice; in a non-repository workspace the head is unknown and no PR goes through; children are refused every PR form. The trust level is role name plus verdict token, as for the required steps.

**Trivial bound** (`ceremony.trivialBound`, defaults `files` 2, `lines` 40, `newFiles` 0). A self-declared trivial is checked, because the tier is the foreman's own claim. At tier trivial the adapter keeps a per-session tally of the foreman's own changes to project files (inside the workspace, outside `.workflow/`) through `write`, `edit`, `foreman_move` and `foreman_copy`: distinct files, changed lines (added plus removed, from the tool arguments: edit old vs new text, write prior vs new content, a copy's source lines; a move inside the project is a rename with no lines) and new files. The check is pre-flight and includes calls of the same turn that have no result yet: a call that would cross any limit is refused (not counted), the tier escalates trivial to standard (trace `triage_escalated`) and the refusal tells the foreman to write the ledger and delegate. A call that passes is added to the tally at its tool result. Only `/ceremony` by the user resets the tally. The bound is off when `ceremony.requireTriage` is false.

**Trivial builder path** (frugal-roles D6; `extensions/core-adapter/trivial.ts`; on while `ceremony.required.trivial` names `builder`, the default). Why it exists: with `foremanEdits: scratchpad` (the default and the bench setting) the foreman cannot change project files, a refused edit raised trivial to standard, and any non-explorer launch at trivial did the same, so a trivial task with a code change was always standard (0 of 12 bench tasks ran trivial). Trivial was only the bound on the foreman's own edits. The path: the foreman triages trivial, writes a ledger with `Tier: trivial` (no V item) and marks its items itself, skips explorer, planner, reviewer and finalizer, and launches one builder on its bottom rung. Builder-only launches keep the tier; another role, a second non-builder launch, or a `strong` launch without a ladder trigger (ladder reason `foreman`) escalates to standard (trace `triage_escalated {reason: strong}`). A refused foreman edit still escalates, as before. `required.trivial` (`builder`) applies once a ledger is bound, and the builder step is dropped in `bounded` mode, where the foreman's own edit is measured by the bound above. At finish, a trivial session that launched a builder has its work diff checked (diffscan.ts: `git diff` against the HEAD at the first builder launch plus untracked files, `.workflow/` and the scratch dir excluded): a changed test file, more than one source file, an exported (or test-referenced) signature change, a schema or migration file, a diff over `trivialBound`, or no test beside the source file and no project test command each escalate to standard (trace `triage_escalated {from: trivial, to: standard, reason}`), so the finish is refused until a reviewer passes. A git failure fails closed (`unmeasured`). The scan is line-based (diffscan.ts limits); it is a floor, not a proof. `required.trivial: []` restores the earlier trivial (no ledger, at most one explorer).

**Required steps** (`ceremony.required.<tier>`, defaults standard `builder`, `reviewer`; heavy `planner`, `builder`, `reviewer`, `finalizer`; `planner` counts as a completed planner run). The adapter counts per session, from the run-end events of runs this session launched (single launches, `chain` and `tasks` entries alike; workflow-script launches only as far as pi-subagents reports them): `builder` = a builder run that completed (a failed, timed-out or stopped run does not count), `reviewer` = a reviewer or senior-reviewer run whose output has a verdict (PASS/FAIL, APPROVE/BLOCK), `finalizer` = a finalizer run that completed. In the `agent_before_settle` hook, after the ledger stop gate, a triaged standard or heavy session with missing steps gets a refusal that names them (trace `finish_refused`) and the turn continues. The gate is silent while a child of this session still runs. After 2 refusals per user prompt the finish passes, visibly: trace `ceremony_incomplete` and a warning notice "finished with ceremony incomplete: missing <steps>"; the bench counts it (`ceremony_incomplete` column). The count of refusals starts again with each user prompt.

**Revision rounds** (H2). A builder run after a review of built work is a revision round. Every launch call is walked in order: in a `chain`, each builder entry after a reviewer or senior-reviewer step is one round, `tasks` entries count each, and a call whose rounds would exceed the limit is refused as a whole. A review of built work counts as open from its launch until a PASS/APPROVE completion closes it, so a builder launched while that review still runs is a round too. A `resume` of a builder run counts like a builder launch (same limit, same refusal; it keeps the run's model, so it is never a strong relaunch). The adapter sees a child's end through pi-subagents' completion notice (the custom message `subagent-notify`, delivered before the run it triggers) and reads the verdict from it: `Overall verdict: FAIL` (senior-reviewer: `Verdict: BLOCK`) opens a round, `PASS` (`APPROVE`) does not. When the notice shows no verdict (the preview was cut, the contract not followed), the order alone counts. A review before the first builder launch (a heavy plan review) opens no round. The limit is `ceremony.revisionRounds` (standard 1, heavy 2, trivial 0; a project or session can only lower it). Over the limit the builder launch is refused, nothing is recorded, and the foreman reports the open findings to the owner and asks how to go on; the owner can raise the tier with `/ceremony`. The count resets on a user prompt and on a tier change by the user (`/ceremony`); a raise by the foreman (`foreman_triage`), a ledger header or an automatic escalation keeps it. Consequence of the ordering rule: a builder launch for a new task after a PASS in the same session, with no user prompt in between, counts as a revision whenever the verdict is not visible in the notice. With `providers.<p>.strongOnRevision` true, a revision launch without a strength keyword runs on the builder's strong model (launch kind `strong-relaunch` in the usage log, else `revision`). The relaunch is the foreman's own `subagent` call, so it passes the allowlist, the model map, the required child extensions and every guard. **Accepted limits:** only the `builder` role is counted; another role with edit tools (the finalizer, an overlay role) launched to apply a reviewer's findings is not a revision round. The verdict is read from the completion notice text, which carries the child's output: a reviewer can be made to print a PASS (planted text it quotes, another child's preview in a grouped notice), and a cut preview falls back to the order rule. `steer` to a running builder is not counted.

**Model map checks.** At session start the foreman checks the active provider's map: each mapped model (default, strong, and the fallback provider's) must be in Pi's model registry, and each provider it uses must have auth; one warning per gap. `/foreman doctor` checks every provider in the map. A second warning appears when the reviewer or senior-reviewer shares the builder's model family (default or strong; a small name heuristic) while the provider offers a model of another family.

**`/retro` friction metrics (built).** `/retro` (foreman only) and `foreman retro` run `scripts/foreman_retro.py` on the Pi session JSONL, the permission-system review log, the trace and the usage log; each input is optional and a missing one prints "no data". Only counts, command families (first two words, three for `sudo`/`ssh`, digits and hex normalised), tool names and guard names are printed: never prompts, command text, file bodies or tool output. Output is at most 30 lines.

| Metric | Definition |
|---|---|
| Approvals | Human approved and denied asks, plus auto-review allow, deny and defer (from the review log; asks of unknown session are counted and flagged) |
| Overridden denials | A deny later followed by an approval of the same command family |
| Guard, overlay and triage-gate blocks | Per guard name; overlay denials; `triage_gate` events (trace) |
| Revisions, precondition ops | `revision` events; safe-op runs vs `precondition_failed` and the hit rate |
| Supervisor requests | `supervisor_request` events |
| Turn causes | Count of turns per cause (`user`, `child`, `intercom`, `wake`, `close`, `other`) |
| Spawn cost | Per role: children, launches by kind, tokens in and out, cache read and write, cost (usage log) |
| Session tools | Top ten tools and bash families used three times or more |
| Permission-map proposals | A bash command family approved (by the user or the review model) at least `retro.proposalMinReviews` (default 5) times in at least 2 sessions and never denied, as `"<family> *"`. A family that the baseline or the merged config deny/ask rules already match is dropped. A family whose words hit a protect-list path, and any family that runs code (interpreters, wrappers, runners, `eval`/`exec`, `ssh`, git config/remote/submodule, git global options), is dropped too; read each proposal before applying it. |

The proposals go to `<agent dir>/pi-foreman/state/retro/permission-proposals-<date>.json` with an apply hint. Nothing edits a config; the owner adds entries to `safety.permissions` by hand. `/sync` runs the retro at its end when `sync.runRetro` is on.

**Ledger hints, compaction digest and auto-retro (D8).** Each `foreman_ledger` action except `status`, each child launch and each reviewer verdict adds one line `  > YYYY-MM-DD <text>` (at most 120 characters) under its ledger items, at most 3 per item with the oldest dropped (`hints.ts`). A launch's items are the ones its task cites (`items 1, 2`, `#N`, a line starting `N.`); a verdict goes to its launch's items; none found means V. The vendored `ledger.py` ignores these lines (no box, no id); one known edge: `ledger add` in a ledger without V inserts the new item right after the last item line, above that item's hints. At `session_before_compact` the foreman builds a digest of at most 40 lines (open items, items closed since the last compaction, the last 8 hints); after a successful compaction it is appended to the pi-foreman section, which names the ledger file as the source of truth to re-read (`retrodigest.ts`). The price-tier compaction (`ctx.compact`) passes `customInstructions` asking the summary to end with `## Retro` (at most 10 lines: what was missing, what to enhance), so the retro costs no extra model call. Compactions Pi starts itself (overflow, its own threshold, a typed `/compact`) cannot carry these instructions (Pi passes `customInstructions` only from the caller), so their summary has no Retro section. At `session_compact` the foreman appends a dated entry to `.workflow/retro/<session>.md`: one counters line from `foreman_retro.py --json` (denies, rereviews, budget hits, rung-ups, child read-budget hits, headless defers, turns) and the extracted section, then hints `retro written` on V. `/retro` also appends its output to `<agent dir>/pi-foreman/state/retro/retro-<session>.md`; `/retro --model` (idle foreman only) then sends one user message asking for at most 10 lines, and the reply is appended under `### Model retro` at that run's `agent_end`. The bench `retro` post-step sends `/retro --model` (an RPC `prompt` starting with `/` runs the extension command, as a typed one does).

## 7. Core and TypeScript adapter

- **Vendoring.**
  - `core/` holds selected paths of `Shredi/fable5-opus5-orchestrator` extracted from the GitHub tarball at a pinned full commit SHA (a core tag once one exists). `core/VERSION` records the pin and `core/MANIFEST` the SHA-256 of every vendored file. `scripts/pull_core.py` updates both (Python rather than make, so it runs on Windows). No `git subtree`: no foreign history in this repo.
  - `core/` is never edited. A test compares the tree with `core/MANIFEST`. Fixes land in the fork, get tagged, and are pulled. The core's own tests run in pi-foreman CI as a conformance suite (pytest, a CI-only dependency).
  - Two harnesses share the core: the Claude Code orchestrator plugin, where it originates, and pi-foreman.
- **Adapter** (`extensions/core-adapter/`, TypeScript). It mirrors the adapter pattern of the orchestrator's earlier Codex port: `normalise` → tool-name map → `runGuard` → output translation.

| Pi tool | Core name | Guards fired |
|---|---|---|
| `bash`, `powershell` | `Bash` | destructive guard, git guard (pre); both fail closed |
| `write` | `Write` | write gate (pre), ledger bind (post) |
| `edit` | `Edit` | ledger bind (post). Not write-gated, as in the core's own hook config: the gate would deny the Edit that binds an existing ledger. |
| `subagent` | `Agent` | spawn gate (pre; the input is the task text) |
| `read`, `grep`, `find`, `ls` | `Read`/`Grep`/`Glob` | none today (Claude-only read guard not ported) |
| `codemode` | none | Inner tool calls pass through `tool_call` individually (Pi: nested `ctx.executeTool` calls are hooked). Replay test in Phase 2. |
| MCP tools | none | Permission system gates each built-in MCP tool call (PS ≥ 38) |

| Pi event | Core script | Translation |
|---|---|---|
| `before_agent_start` | none: pi-foreman's own `instructions/foreman.md` | System-prompt section, main session only. The core's `inject_instructions` is not called: its text names Claude model tiers and it reads Claude config dirs. |
| `tool_call` | permission overlay, `destructive_guard`, `git_guard` (own, `scripts/git_guard.py`), `ledger_guard_write`, `ledger_guard_spawn` | Result handling below |
| permission asks | `foreman-review` chain link (own, layer 3) | allow, deny or defer to the human prompt |
| `tool_result` | `ledger_bind` | Side effect only |
| `agent_before_settle` | `ledger_guard_stop` | Block → `{continue: true}` plus the reason as a message |

How `tool_call` results are translated:
- `deny` → `{block: true, reason}`.
- `updatedInput` → mutate `event.input` in place.
- `ask` depends on the mode:

| Mode | `ask` handling |
|---|---|
| TUI | `ctx.ui.confirm` |
| RPC | `ctx.ui.confirm` arrives as `extension_ui_request` |
| print or JSON | Deny with "needs approval, no UI" |
| Detached child | Core-guard `ask` → deny with "ask the foreman". Permission-system asks are forwarded to the parent (§5). Routing core-guard asks through that forwarding is a Phase 3 item. |

**`runGuard`:**
- Spawns `<python> core/scripts/<guard>.py`, with the hook JSON on stdin and a 5 s timeout.
- Environment:
  - `FABLE_ORCH_HARNESS=pi`.
  - `FABLE_ORCH_SESSION_BINDING=1` (core ≥ 0.22.1) switches the core's gates off legacy ledger discovery, so a session only ever sees its own ledger. `FABLE_ORCH_METRICS_DIR` puts the core's metrics into pi-foreman's state dir.
  - The session id variables are set to the Pi session id.

**Session binding.** `ctx.sessionManager.getSessionId()` (Pi 1.0.0 `SessionManager.getSessionId(): string`) becomes `session_id` in every payload. Shell tools already receive `PI_SESSION_ID`, so `ledger` CLI calls from bash bind to the same session. The adapter puts pi-foreman's `bin/` (shims `ledger`, `ledger.cmd`, `ledger.ps1` that run `core/scripts/ledger.py` with the resolved Python) on `PATH` for the `bash` and `powershell` tools.

**Python resolution.** The adapter tries these in order:
1. `python.path` from config
2. `PI_FOREMAN_PYTHON`
3. Windows: `py -3`, then `python`. Unix: `python3`, then `python`.

The interpreter must report version ≥ 3.9. The Windows Store alias stub is rejected. The result is cached per session. If no interpreter is found, layer 2 fails closed for shell tools and `/foreman doctor` explains the fix.

**Latency** (CI run above: 50 warm spawns from Node, `destructive_guard`):

| Runner | Warm p50 | Warm p95 |
|---|---|---|
| ubuntu | 34–39 ms | 35–41 ms |
| macOS | 41–47 ms | 68–75 ms |
| windows | 55–60 ms | **65–71 ms** |

The threshold was a Windows warm p95 above 150 ms, and the measurement is far below it. So the **Python core is used everywhere** and no native TypeScript guards are needed. Not measured: `py -3` launcher overhead on a real Windows host, and the blocked-command path.

### Session features (Phase 4)

| Feature | Behaviour |
|---|---|
| Herdr state | The official Herdr Pi integration (`herdr integration install pi`, installed by the user, never by the installer) reports working on `agent_start`, idle on `agent_settled` and, through `pi.events` `herdr:blocked`, blocked; Herdr derives done from idle-not-yet-seen. `/foreman doctor` prints an INFO line when `HERDR_ENV=1` and `herdr-agent-state.ts` is missing. Tab management from outside (agent list and prompt, pane read, tab close) needs nothing from pi-foreman. Starting a Pi session in a new tab is the owner's spawn tool (it takes a `--kind pi` mode there; not part of this repo). pi-foreman emits `herdr:blocked` `{active, label}` (counter based, released also when the ask throws) around its own asks and bridges pi-permission-system's `permissions:ui_prompt` / `permissions:decision` events into it (only request ids seen in a prompt are released); open prompts are released on `agent_end` and `session_shutdown`. |
| `/sync`, `foreman sync` | `scripts/foreman_sync.py`, no model. For each `sync.repos` entry `{path, branch, paths}` (user and overlay config only): refuse a repo that is not a work tree root, has a detached HEAD, an operation in progress or a current branch other than the entry's `branch` (a branch recorded for this session in `<state>/created-branches.json` also counts; pi-foreman records none today, so in practice only listed branches push); `git pull --ff-only --no-rebase`; candidates are changed or untracked files matching the entry's `paths` globs; a file whose name or content looks like a secret refuses the whole repo (name and rule reported only; the content scan reads the whole file as bytes, capped at 20 MiB, and symlinks or other links are refused); explicit-path `git add` and `git commit -- <files>` (`chore(sync): <date> <session>`); `git push <remote> <branch>:refs/heads/<branch>`. Never forced; no `clean`, `reset --hard` or `push --force` anywhere in the script (a test checks). Git runs with the `safe_ops` hardening, including an empty `core.hooksPath`, and the same `-c` overrides on every call. A repo's local, worktree and included config is checked against an allowlist of harmless keys before any git call that would honour it (`ALLOWED_KEYS` in the script: core layout and line-ending keys, `core.fsmonitor`/`commit.gpgSign`/`tag.gpgSign` only when false, `extensions.*` format keys, `user.name`/`user.email`, `remote.<x>.url` (no `ext::`/`fd::`), `.fetch`/`.tagopt`/`.prune`, `branch.<x>.remote`/`.pushRemote` naming a configured remote, `.merge`/`.rebase`, pull/push/fetch/gc defaults, display keys, includes inside the git dir). Any other key refuses the repo (key class reported, never the value): this covers filters and textconv, config-based hooks (`hook.*`), `core.alternateRefsCommand`, ssh, proxy, askpass and credential helpers, gpg programs, url rewrites, `pushurl`, upload/receive-pack, `http.*`, `lfs.*`, `maintenance.*`, `pack.*` and any `submodule.*` (so repos with initialised submodules are refused). A repo with `objects/info/alternates` is refused. Every git call also gets `-c commit.gpgSign=false -c submodule.recurse=false -c core.alternateRefsCommand= -c core.alternateRefsPrefixes= -c protocol.file.allow=never` (git refuses any local-path remote even if a check is raced), and branch and push remotes must be plain names (no `/` or `\`, not `.`/`..`). Git output in reports is redacted. Hooks still do not run. A `remote.<x>.url` must be `https://`, `ssh://`, `git://` or scp-like (`host:path`); a local path, `file://` and any helper transport (`ext::`, `fd::`, `<helper>::`) is refused, so a child cannot point a sync repo at a local repository with hooks. `git status` runs with `--ignore-submodules=all`, and a submodule gitlink (mode 160000) among the candidates is ignored and the repo refused. The config is re-checked right before the commit and again before the push. `/sync` refuses ("sync refused: N child run(s) still active") while a detached child run of this foreman has not ended: a child's commit in the same repo would otherwise race the sync. Exit 0 when every repo is clean, committed or pushed, 1 when any was skipped or refused. Then the retro when `sync.runRetro`. |
| Remote close | `/foreman close [result-path]` (typed in the pane, or sent by `herdr agent prompt`; source `herdr`) or an inbound intercom message that is exactly `foreman:close [path]` from the session id in `PI_FOREMAN_PARENT_INTERCOM` (source `intercom-parent`); `close.from` lists the accepted sources. Refused, and traced, while any `foreman_wait` is active or a detached child run of this foreman has not ended (it never cancels either; the refusal goes to the intercom sender when the close came by intercom) and from any other sender. Sequence: wait until idle, one ordinary close turn asks the model to write the result file, then `foreman_sync.py` runs, a stub result is written if the file is missing, and the session shuts down. The result path uses only `A-Za-z0-9._/-` (at most 200 characters), ends in `.md` and must resolve inside the workspace's `.workflow/`; the close prompt carries only that path. An idle intercom close is started through pi-foreman's own consumption of the wake prompt (above). A `started` flag is set only when an assistant reply follows the close prompt; a close turn that has not started within a 60 s deadline (a check stopped it) is given up, with a notice and an intercom reply; no later run syncs or shuts down. The close turn meets the permission system, triage gate and drift checks like any turn, and never answers an ask. |
| `foreman update-check` | `/foreman update-check` and `foreman update-check` run `scripts/foreman_update_check.py`: for each package pinned in `packages.lock.json`, the pinned and latest version, up to five newer versions with dates and the release-notes URL. Unpinned packages (the Claude bridge) are listed as "not pinned". Offline gives one line per package, exit 0. It changes nothing; updating is raising the pin and re-running the installer. |
| Usage footer | `ctx.ui.setStatus("foreman-usage", ...)` (TUI and RPC), refreshed after each assistant message from in-memory totals: tokens in (input + cache) and out, list-price cost from Pi's registry (when a message reports cost 0 with tokens, the price falls back to the registry rates of its provider and model, `claude-bridge` mapped to `anthropic`; `n/a`, or `$x + n/a` when only part is priced, when the registry has no price) split into warm (cache read) and cold (input + cache write), and the number of child launches. No provider limits. `footer.usage: false` turns it off. |
| Compaction per price tier | After each turn the adapter classes the active model by `model.cost.input` (USD per million tokens): below `compaction.priceTiers.cheap` cheap, below `.standard` standard, else premium (unknown cost: standard). When context use exceeds `compaction.threshold.<tier>` of the window it calls `ctx.compact()` once (trace `compact_tier`); Pi's own `reserveTokens` stays as the backstop. The claude-bridge summary gate still runs. |
| Long wait and governor | Foreman-only tool `foreman_wait` (`start`, `list`, `cancel`; kinds `timer`, `file` (appears), `pid` (exits), `ci` (a GitHub Actions run id completes, polled with `gh` every 60 s, resolved to an absolute PATH entry outside the workspace (empty, relative and workspace entries skipped); without such a `gh` a `ci` wait is refused; on Windows `execFile` cannot run a `gh.cmd` found through PATHEXT, so `ci` waits need `gh.exe`; `wait.ci: false` disables it)). It returns at once; polling is timers in the extension, no model turn. The first outcome opens a `wait.batchWindowSeconds` window (default 300, 0 = immediate); when it closes, or no wait is left, one `foreman_wake` custom message lists every outcome (id, kind, note, outcome; no file contents, no CI logs) and starts a turn if idle, else queues as a follow-up. Trace `turn` records `cause: wake` and `wakeKinds`. A `file` wait reveals whether a file exists (and its size) to the foreman. A `file` path must resolve (symlinks included) inside the workspace, its `.workflow/` or `<agent dir>/pi-foreman/state/wait/`, and not into the protect set; others are refused. Limits: `wait.maxSeconds` per wait, `wait.maxActive` at once. Allowed in the baseline; no per-turn model routing. |
| Intercom | See §5 layer 7. `intercom` is dropped from every child role's tool list in the config resolver and refused in the child's `tool_call`. |
| M1 follow-ups | `model_override` trace events carry `requested` (the model asked for) in the same event. The `..` containment test in `python.ts` no longer rejects a name like `..foo`. The replay driver closes its file handles. CI runs `tsc --noEmit` on Linux (`tsconfig.json`, Pi 1.0.0 types as a dev dependency). |
| `subagents.disableBuiltins` | Decided: left unset. The role allowlist (`roles.ts`) already refuses every builtin agent and package roles shadow same-named builtins (replay `TestRoleAllowlist` plus a probe); builtins appear only in subagent list output with no standing prompt cost; the flag lives in the user's Pi settings and would change their non-foreman sessions. |

The `foreman` CLI (`bin/foreman`, `.cmd`, `.ps1`; `foreman update-check|retro|sync [args]`) runs the same scripts outside Pi, with the interpreter from `PI_FOREMAN_PYTHON` or `python3`/`python`, `-E -s`.

**Config keys.** Defaults in `config/foreman.defaults.json`; rules in `scripts/foreman_config.py`. "Neutral": no loosening in either direction, last layer wins. L1/L3/L2 are the harness, organisation and user layers; project is `.pi/foreman.json`.

| Key | Default | Direction | Layers |
|---|---|---|---|
| `sync.repos` | `[]` | loosens (what gets committed and pushed) | L1, L3, L2; project ignored |
| `sync.runRetro` | `true` | neutral | any |
| `radar.doneTtlMinutes` | `30` | neutral (display) | L1, L3, L2 (radar reads no project file) |
| `retro.proposalMinReviews` | `5` | lower proposes sooner | L1, L3, L2; project ignored |
| `intercom.allowRemote`, `intercom.allowOpenPane` | `false` | `true` loosens | any layer may set false; a project or session can only set false |
| `close.from` | `["herdr","intercom-parent"]` | fewer is tighter | any; project and session intersect |
| `footer.usage` | `true` | neutral | any |
| `compaction.priceTiers` | `{cheap: 1, standard: 5}` | neutral (classification) | L1, L3, L2; project ignored |
| `compaction.threshold.<cheap\|standard\|premium>` | `0.85`, `0.75`, `0.6` | higher compacts later (loosens) | any; project and session only lower, minimum 0.3 |
| `wait.batchWindowSeconds` | `300` | neutral | any |
| `wait.maxSeconds`, `wait.maxActive` | `86400`, `8` | higher loosens | any; project and session only lower, minimum 1 |
| `wait.ci` | `true` | `true` loosens (runs `gh`) | any; project and session only false |

**Accepted limits (Phase 4).**
- Same-user trust boundary, intercom broker and Herdr socket side by side: both accept any process of the same OS user, so either can inject a message or keystrokes into a session. Intercom sender ids are chosen by the client, not authenticated; the check on a close request compares that id with the recorded parent. Neither is a boundary against code running as the user; the OS boundary is its own round (§15 #10).
- Children still load `pi-intercom` and register with the broker. They swallow the idle wake (matched by the extension's wake text), but a message steered into a running child turn still reaches it; the child has no send tool and every guard still applies.
- Active child runs are tracked from `subagent` launch results and the run-end events of this session; a run started outside this session (or whose end event is missed) is not seen, so the refusal is best effort.
- `/sync` is enabled only by the owner's overlay list (`sync.repos`, L1–L3; project and session layers cannot set it). **Known limit (parent ruling 2026-10-07):** a child or same-user code that plants repository state can still try to steer a sync; the three security review rounds and the B1/B2 confirmation closed every reproduced vector (repo-config allowlist, network-only remote urls, `-c protocol.file.allow=never`, plain remote names, gitlinks ignored and refused, re-check before commit and push, refusal while child runs are active), but string and state checks are not a boundary against code running as the user; the OS-boundary round (§15 #10) owns the rest.
- `/sync` and the close sync run no repository hooks (deliberate: hooks are repository code run with the owner's credentials), so a hook-enforced check does not run. The repo-config allowlist covers the repository's own config only: the user's global and system git config still apply to pull, commit and push. Commits that child code makes directly in a sync repo (ungated shell, §15 #10) match the `paths` globs like any other change and get pushed by the next sync. Remote urls are limited to network transports, but the host is not pinned: code that rewrites `remote.<x>.url` to another https/ssh host makes the next sync push the repository content there (the owner's credentials for the real host are not sent to it). Git's error text is redacted but can still hint at a remote.
- Long wait needs a TUI or RPC session (print and json refuse it); waits live in the process and do not survive a restart or `/new`.
- A wake turn, like a child notice, skips `before_agent_start`: no heavy-signal scan of the wake text, no stop-continue reset, no review intent. The context drift check, triage gate, permission system and launch checks apply. A wake message carries metadata only and is data. The pi-foreman system-prompt section persists on wake and child-notice turns (`context_with_system` keeps it).
- Close: an input handler that swallows the close prompt leaves the close pending; a close typed during an open dialog goes into the dialog.
- The Herdr integration reports state in the TUI only (not RPC or print); the `herdr:blocked` counter relies on its listener being installed.
- Retro proposals drop families whose words hit a protect-list path (an approximation of the overlay matcher, conservative: anything under the package root is dropped too) and never include interpreters, wrappers and runners (`env`, `sudo`, `nohup`, `timeout`, `xargs`, `npx`, `uvx`, `go run`, …), `eval`/`exec`, `ssh`, `git config`/`remote`/`submodule` or git families led by a global option (`git -C`, `git -c`, …).

## 8. Codemode

| Aspect | Design |
|---|---|
| Mechanism | Pi 1.0 built-in. It is off by default. It is enabled per session by the tool list: children get `codemode` in their `tools` JSON array (a comma string is rejected), and the foreman adds it through `pi.setActiveTools` at `session_start`. There is no per-model flag in Pi. |
| Evidence | Hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0: a child with `tools: ["read","ls","codemode"]` ran a codemode script successfully |
| Default | The mechanism works for all six roles. The shipped default is `on` (direct tools plus codemode) only for `foreman` and `explorer`, and `off` for the other four until benchmark numbers exist. `codemode.mode: only` is never a default. |
| Switch | `providers.<p>.roles.<id>.codemode` (per role × provider) overrides `roles.<id>.codemode`. The benchmark rig flips it per configuration, and the generator writes the resulting tool arrays. |
| MCP | Built-in MCP servers default to `codemode` exposure. `autoEnableCodemode` stays as Pi sets it. |

## 9. Subagent launch contract

Every role is launched detached (`async: true` in the role frontmatter) with these properties:
- The required child extensions from §5. The policy extensions are required in every child.
- A strict tool allowlist. Extension tools are not inherited and must be listed with their path. Hands-on 2026-10-03: an unlisted tool was absent, and a listed one ran.
- A model resolved from the provider map. The foreman picks a strength with `model: "default"` or `"strong"` (an optional `:<level>` suffix applies only to a rung with no configured thinking; `strong` needs a reason or a ladder trigger, see Role ladder). Without a keyword the builder runs on `providers.<p>.roles.builder.strong` on a heavy tier, every other launch on the default model. `strong` without a mapped strong model launches the default model and says so in the tool result. The strong model comes from the provider the role's `model` came from: the fallback provider's strong applies only when the role's `model` is the fallback's too. A raw model id is replaced by the map.
- A run-time limit: `timeoutMs` = `roles.<id>.timeoutMinutes`; a lower foreman value is kept. For tasks/chain it is the parent deadline (highest entry for tasks, sum of steps for a chain), since pi-subagents 0.75.0 reads no per-entry limit.

An explicit `async: false` in a call would beat the frontmatter, so the adapter rewrites every `subagent` call to `async: true` (and drops `foregroundOnly`), and the generated `subagents` block sets `forceTopLevelAsync: true`.

Launches are limited to the configured child role ids (the keys of `roles` except `foreman`, overlay roles included): the adapter refuses any other agent, such as a pi-subagents builtin, in `agent`, `tasks[]`, `chain[]` or `chain[].parallel[]`, and lets management calls (`action`) pass.

Results return through pi-subagents' async notifications. The foreman waits, bounded by `fanout.max`. pi-subagents writes run state (`run-history.jsonl`, `missions/`) to the Pi agent dir, so the replay rig and tests always set `PI_CODING_AGENT_DIR` to a temp dir.

## 10. Replay rig and tests

| Part | Design |
|---|---|
| Trace | Opt-in JSONL in the state dir. **Allowlisted fields only:** `ts`, `event`, `role`, `toolFamily` (mapped core name), `guard`, `decision`, `latencyMs`, `model`, `tokensIn`/`tokensOut`, `cost`, `exit`, `tier`, `precondition`, `errorKind`, `cause` (turn cause), `cacheRead`/`cacheWrite`, `requested` (the model a `model_override` event asked for), `wakeKinds` (comma list of long-wait trigger kinds), `pollBash` (bash calls made while a child ran, on `turn` and `role_result` events), `codemode` (true on `llm` and `turn` events whose turn called codemode), events `read_budget`, `recheck_budget` (a warn or deny; the bench counts denies), `launch_wait {role, runId, outcome, ms}` and `notify_deduped {runId, mode, trimmed_lines}`, `from`/`to` (tiers of `triage_escalated`), `files`/`lines`/`newFiles` (the foreman's tally at escalation), `missing` (comma list of missing steps), `kind` (write form of a refused shell write, or the tool of a refused foreman edit), `mode` (the foreman edit mode), `reason` (why a PR or a launch was refused), `by` (`user`/`rig` on a checkpoint, `foreman`/`planner` on `plan_written`). Events added for delegation: `triage_escalated`, `finish_refused`, `ceremony_incomplete`, `shell_write_refused`, `foreman_edit_refused {mode, kind}`, `pr_refused {reason}` (`no_review`, `stale_review`, `head_unknown`, `child`, `pr_alias`, `pr_compound`, `pr_config`). Events added for the plan checkpoint: `checkpoint {decision, by, tier}` (`decision` approve, revise, reject, pending or refused; `by` user or rig; no plan or note text), `launch_refused {reason, tier}` (`plan_required`, `checkpoint_pending`, `plan_changed`, `planner_single`, `output_path` (a launch with `output` or `outputMode`, any role), `unchecked_heavy`), `plan_written {tier, by}` (`by` foreman or planner) and `planner_write_refused {kind}`. The bench table adds the columns `pollBash`, `ceremony_incomplete`, `foreman_edit_refused`, `pr_refused` `read_blocks`, `recheck_blocks`, `finish_refused`, `launch_waits`, `wait_turns` (turns that only called `bg_wait` or subagent list/status), `text_only_turns` and `codemode_turns`, and `checkpoint_auto` (counts per cell; `checkpoint_auto` counts `checkpoint` events with `by` rig and decision approve: the bench waiter answers a select titled `pi-foreman checkpoint:` whose options are exactly approve, revise and reject with `approve` and denies every other dialog; print-driver rows have no UI, so their heavy runs stay pending), and the rig's `asks_denied` keeps the title of a denied ask only, not its command text. Never prompts, tool arguments, paths or outputs. The writer drops any non-allowlisted key, and a unit test asserts it. |
| Fake provider | `pi.registerProvider("foreman-fake", …)` streams scripted assistant messages (text and tool calls) from a fixture. It is also registered as a required child extension, so children run on it too. |
| Driver | Python, stdlib. It starts `pi --mode rpc --approve` with a temp `PI_CODING_AGENT_DIR` and a temp project, sends prompts and UI answers, and compares the trace to a golden sequence. `pi -p` is not used for subagent runs, because it exits before detached children finish (hands-on 2026-10-03). |
| Suites | Python `unittest` for `scripts/`; the core conformance suite (pytest, CI-only); the `core/MANIFEST` pin check; `node --test` for the adapter's pure functions; replay scenarios: guard deny, ask in TUI/RPC/print, child cannot push, precondition pass and fail, provider switch, ceremony tiers |
| CI | GitHub Actions matrix `ubuntu-latest`, `macos-latest`, `windows-latest` × Python 3.9 and 3.13, on every push and PR. CI installs the pinned Pi and pi-subagents and runs the replay scenarios on the fake provider only: no secrets and no real model calls. |

## 11. Installer

`node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--remove]`

| Step | Behaviour |
|---|---|
| 1. Check | Node and Pi versions. Pi must match the pinned range (1.1.x). |
| 2. Python | Same resolution as §7. If no Python ≥ 3.9 is found, the installer stops with OS-specific instructions. |
| 3. Packages | `pi install npm:<pkg>@<exact>` for pi-foreman and each pinned package from `packages.lock.json`. Pi and pi-permission-system are pinned in lockstep, because a PS major tracks Pi majors. `--project` uses `-l` and notes that project packages load only after trust; headless runs need `--approve`. |
| 4. Settings merge | User `settings.json`: add or update only the entries pi-foreman manages, and write the generated `subagents` block (§3). Never remove or reorder user keys. Back up to `settings.json.bak-<timestamp>` before the first change. |
| 5. Policy | Generate the permission-system global file from the L1 → L3 → L2 rules. The installer owns it: a hand edit is backed up and overwritten, and user rules go into `foreman.json`. `authorizerChain` is `["foreman-review"]`. `/foreman doctor` reports drift. |
| 6. Config | Write a commented `foreman.json` template only if it is absent |
| 7. Doctor | `/foreman doctor` checks: Python, the generated block in sync, required child extensions resolvable, auth per provider in the map |

- `--dry-run` prints the planned changes as a diff and writes nothing.
- A second run is a no-op. CI asserts that on all three OSes.
- Overlays install with `--overlay`, pinned exactly. The installer never edits overlay files.

## 12. Benchmark design (design only, no runs)

| Aspect | Design |
|---|---|
| Runner | Harbor (`harbor-framework/harbor`, Apache-2.0). It has agent adapters for `pi` and `claude-code` and runs tasks in Docker. `foreman bench` is a thin wrapper, not an own runner. |
| Tasks | Three sizes (small, medium, big), 2–3 each, from already-solved commits: start at the parent commit and check with the tests the fix added. Private tasks stay outside this repo. The repo ships the runner config and synthetic samples. |
| Configurations | Plain Pi; pi-foreman; codemode on/off per role; pi-foreman per provider map; Claude Code without a harness and with the orchestrator plugin (reference) |
| Metrics | Success (hidden tests), tokens, cost, wall time, tool calls, approvals, guard blocks |
| Protocol | 3 repeats per configuration, a budget cap per run, median and range reported. Providers that log or train on data are never used on private code. |
| Decision rule | A default changes only if success is not worse and cost or time improves beyond the observed range. With this suite size the result can show "not worse, at this cost", not a small advantage. |

## 13. Adopt / wrap / own

| Capability | Choice | Version tested | Evidence summary |
|---|---|---|---|
| Runtime | adopt Pi | `@earendil-works/pi-coding-agent` 1.1.0 | All runs; signatures read from installed types |
| Subagents | **adopt** `pi-subagents`, every role detached | 0.75.0 | Hands-on: package roles discovered and launched; provider switch changes child model; full-id thinking override; codemode in child; required child extension blocks; strict tool allowlist. FAIL: foreground ask forwarding. |
| Subagents (fallback) | fallback `@gotgenes/pi-subagents`, used only if the primary blocks | 22.0.0 | Hands-on: forwards foreground asks. Role and provider features not tested. |
| Permission map | **adopt** `@gotgenes/pi-permission-system` | 39.0.2 | Hands-on: ask rules, detached-child forwarding, authorizer chain resolves |
| Model review | **own** chain link `foreman-review` (replaces `pi-permission-ai-guard`) | n/a | ai-guard 0.13.0 ran with PS 39.0.2 and all verdict paths behaved, but its reviewer cannot switch with the provider without a restart. Replay covers all paths and the switch. |
| Model review (rejected) | `@mzwing/pi-permission-auto-review` / `pi-verdict` | 0.7.0 / 0.14.0 | Auto-review needs Node ≥ 24 and PS 33–36. pi-verdict runs its own gate beside PS (double prompts). Load test only. |
| Destructive/secret guard | **own** (vendored core) | core 0.23.0 @ fork SHA `8376da1` (latency run: `1be4960`) | CI latency run on three OSes |
| Ledger, gates, git guards, permission overlay, bridge isolation, precondition ops, ceremony, `/retro`, trace, installer | **own** | n/a | Design |
| Claude provider (private) | adopt `pi-claude-bridge` in L2 | 0.9.2 (hands-on on 0.9.1) | Hands-on: child turns, thinking level reached |
| Copilot, Codex subscription | Pi built-in providers | Pi 1.0.4, pin 1.1.0 | Source read: Copilot device-flow `/login github-copilot` or `COPILOT_GITHUB_TOKEN`. Not run. |
| MCP | **adopt Pi built-in (pending hands-on in Phase 2)**; `pi-mcp-adapter` 5.0.0 opt-in overlay only | Pi 1.0.4 (docs, types) | The adapter replaces the built-in, rewrites user settings, and hides per-tool gating behind one proxy tool. Not run. |
| Codemode | adopt Pi built-in | Pi 1.0.4, pin 1.1.0 | Hands-on in child |
| Background tasks | **none**; `pi-background-tasks` avoided | 2.6.9 (source read) | 2.6.9 impersonates the Claude Code client on the `anthropic` provider, and its Pi peer range is `^0.81–0.84` |
| Claude Code child runner | **not used**, not even in an overlay | pi-subagents 0.75.0 (docs) | Async only, no Pi guards inside. The Claude bridge is the only Claude path. |
| Intercom | **adopt `pi-intercom` 0.16.1** behind the guard in §5 layer 7 | 0.16.1 (source read) | Inbound messages are data; open-pane and cross-machine sends are off by default |
| Plan mode, todo, web search | candidates, not adopted yet | not tested | Decided with evidence in Phases 2 and 4 |
| Benchmark runner | adopt Harbor (pending hands-on in Phase 2b) | not run | Design only |

## 14. Changes from the master plan

| # | Change | Reason |
|---|---|---|
| 1 | The core is shared by **two** harnesses, not three. The OpenAI/Codex subscription is a first-class Pi provider example. | The Codex CLI harness is retired, because Pi covers that provider. |
| 2 | Subagent roles launch **detached**, with permission system, guard and git child guard as required child extensions (`requireForAllRunners`) | Foreground children run ungated, or are auto-denied |
| 3 | A per-launch thinking change restates the full `provider/model:level`, not a bare `:level` | A bare level fails for native children in pi-subagents 0.75.0 |
| 4 | pi-foreman's `providers.*` is the source, and the pi-subagents block is generated from it | The foreman entry, codemode switch, fallback and fan-out need one file. pi-subagents' mechanism is still used. |
| 5 | Model review is an own chain link, `foreman-review`; ai-guard is not installed (supersedes the first plan: pinned ai-guard with the own link as fallback) | ai-guard cannot switch the reviewing model with the provider without a restart |
| 6 | `pi-background-tasks` dropped | Client impersonation by default, and the peer range excludes Pi 1.0 |
| 7 | MCP decided: Pi built-in, adapter as opt-in only | Per-tool gating, no settings mutation, native to Pi 1.0 |
| 8 | The foreman is a main-session role with its own provider-map entry, applied via `setModel`/`setThinkingLevel` | It is not a subagent, but it must follow the provider switch |
| 9 | Python core everywhere, including Windows | Measured Windows warm p95 is 65–71 ms, under the 150 ms threshold |
| 10 | The replay rig and tests drive Pi in RPC mode, not `pi -p` | `pi -p` exits before detached children finish |
| 11 | No Claude Code children at all; the Claude bridge is the only Claude path | Pi guards do not apply inside them |
| 12 | `contact_supervisor` requests are treated as untrusted | Hands-on: a cooperative parent ran a tool that the child's allowlist excluded |
| 13 | Asks get a real prompt in TUI and RPC. Only print mode and children deny. | Unlike Codex, Pi has an interactive confirm API |
| 14 | The precondition-op logic is own Python in `scripts/`, not in the vendored core, and the vendoring script is Python, not make | The core is never edited, and make is not available on Windows by default |
| 15 | Skills in `.agents/skills/` are for Pi only | Claude Code 2.1.288 does not load them (headless check). See open items. |
| 16 | The adapter enforces the merged deny set and a write-protection block itself, before PS. The installer owns the generated PS file. | PS's merge can loosen and it has no session scope |
| 17 | Children get an env without push credentials; the foreman does network git | Allowed test commands run agent-written code (security review S9) |
| 18 | Project and session layers cannot loosen `python.*`, `roles.*.tools`, new role ids, `roles.*.launch/file`, codemode, `providers.*.review`, `bridge.*`, `trace.dir` outside the workspace (table in §5) | A cloned repository is not trusted. Confirmed by the owner. |
| 19 | `workflow`, `schedule.*` and agent-definition actions are blocked by default (`safety.subagents.allowWorkflow`) | They can name any agent and skip the role allowlist and the model check |
| 20 | The builder gets `foreman_move` and `foreman_copy`; worktree removal needs no ignored files outside `worktreeDisposable` | Ignored files can hold the only copy of a result |
| 21 | Bridge sessions run with an own empty Claude config folder | Owner decision: the host setup leaked into bridge turns |

## 15. Open items for the owner

| # | Item | How to check |
|---|---|---|
| 1 | Does thinking reach Copilot models? | With the Copilot provider active, run `/run explorer[model=github-copilot/<model>:low]` and then `:high`. Check `thinking_level_change` in the child session file and that the request is not rejected. Try one Claude, one GPT and one Gemini-flash model (the last should show no effect). |
| 2 | The forwarded-ask dialog in the interactive TUI | In the TUI, start a detached child that hits an `ask` rule. Check that the dialog appears and that both answers round-trip. Headless RPC already passed. |
| 3 | The `py -3` launcher on a real Windows host | `/foreman doctor` timing |
| 4 | Closed: ai-guard replaced by `foreman-review` (§5, §14 #5) | n/a |
| 5 | Required child extension missing at launch | Hands-on in Phase 2. The expected result is that the launch is refused. |
| 6 | Closed: the PowerShell/cmd pass and the opt-in fail-closed and guard-bin switches are in core 0.23.0. The baseline still asks for `Remove-Item -R*`, `ri`, `rd /s`, `del /s` as a second layer. | Done (re-pinned to `8376da1`) |
| 7 | Closed: vendored core re-pinned to 0.23.0 (`8376da1`) | Conformance 644 passed |
| 8 | Phase 4: check launches inside workflow scripts and scheduled runs. No `tool_call` fires for those children. | Needs an upstream veto hook per workflow child launch, or the child extension asserting its own role and model against the map at `session_start` (the robust check). Until then `allowWorkflow` stays off. |
| 9 | Core guard review at the fork (internal error paths, the fail-closed switch) | The security review did not read `destructive_guard.py` (a safety classifier stopped it); the parent's verifier covers it at the fork |
| 10 | Phase 4: an OS boundary for children (container, OS sandbox or a separate user) | String guards cannot stop code a child runs through allowed test/build commands (§5 "Not a sandbox"). Check: a child's planted test cannot read `~/.ssh`, the `gh` keyring or write outside its worktree. The same boundary closes the triage gate's shell gap (§6): the foreman's own shell writes into the workspace. |
| 11 | Closed: Phase-4 session features (§7 "Session features"), keys and limits documented | Replay covers close, intercom guards and wait; footer, compaction, sync and retro have unit tests |
| 12 | Herdr pane state for a foreman: idle, working, blocked (foreman ask, permission-system ask), done | Live check in a Herdr pane with the official Pi integration; pi-foreman emits `herdr:blocked` for its own asks and bridges the permission system's prompt events (`herdr.ts`) |

Open item 13: per-cycle context collapse (replacing a finished delegation span by a summary). Not built. pi-boomerang's mechanism, `navigateTree(targetId, {summarize})`, exists only on `ExtensionCommandContext`; event handlers (`tool_result`, `agent_end`, `context`) get an `ExtensionContext` without it, so an automatic collapse would need a command context captured earlier. `pi.on("context")` can rewrite the history per request, but rewriting a span that already went to the provider changes the prefix from that point: one cache invalidation (a full re-write of the tail) per cycle. With launch-wait a launch and its result are one tool pair, so only multi-turn spans (supervisor questions, a timeout followed by `bg_wait`) would gain. Notify dedupe keeps the cache intact and covers the common case. The owner's private benchmark decides whether the gap matters.

## 16. Decisions (owner review, 2026-10-03)

| # | Decision |
|---|---|
| 1 | Subagents: `pi-subagents` 0.75.0, every role detached, policy extensions required in every child. The fallback package is used only if this one blocks. |
| 2 | Permission map `@gotgenes/pi-permission-system` 39.0.2, pinned with Pi. Model review `pi-permission-ai-guard` 0.13.0, pinned; Phase 3 wires and tests it (superseded 2026-10-04: own link `foreman-review`, §14 #5). |
| 3 | MCP: Pi built-in. No background-tasks package. |
| 4 | Codemode works for all six roles; the shipped default is on only for `foreman` and `explorer` until benchmark numbers exist. The switch per role and per role × provider stays. |
| 5 | Display preset "classic": Picard, Dora, Bob, Watson, Sherlock, Gandalf. |
| 6 | Skills under `.agents/skills/` are for Pi sessions only. |
| 7 | No Claude Code children at all. The Claude bridge is the only Claude path. |
| 8 | No organisation safety bounds. Every key merges last-wins (L1 → L3 → L2 → project → session); only `.pi/foreman.json` is limited to tightening safety keys. |
| 9 | A guard failure blocks the shell call and explains the fix (fail closed). |
| 10 | All changes in §14 are accepted. |
| 11 | Phase 2 (plan review): pi-foreman injects its own `instructions/foreman.md`; the core's injector is not called. The core is vendored as a pinned tarball with a hash manifest, not a subtree. pytest is a CI-only dependency. CI runs replay on the fake provider on all three systems. |
| 12 | Phase 4: `subagents.disableBuiltins` stays unset (§7 "Session features"). Herdr state: the official integration reports working and idle; pi-foreman emits `herdr:blocked` for its own asks and bridges the permission system's prompts. Intercom is adopted behind the §5 layer-7 guard; the same-user limit of the broker and the Herdr socket is accepted until the OS boundary round. |
