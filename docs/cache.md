# Idle prompt cache

> Covers the per-provider prompt-cache policy (`providers.<p>.cache`): TTL, billing, the keep-alive that stops an idle
> session resuming cold, the activity rule and cost rule that bound it, the presence gate, and the final warm
> compaction.

On token-billed providers with a cache TTL (`claude-bridge`: 3600 s for the foreman, 300 s for subagents, derived; keep-alive on by default) an idle
session otherwise pays for a cold prompt on resume. Layer rules are below; the idle model downshift is in [ladder](ladder.md#idle-rung-foreman-downshift).

## Config

Built-in values exist for `claude-bridge` (`ttlSeconds` 300, `billing` `token`; the TTL is derived from `bridge.promptCacheTtl` first, see below) and `github-copilot` (`ttlSeconds` null, `billing` `request`, plus built-in per-model rows). A key set in the config wins over the built-in value. `config/foreman.defaults.json` stays `providers: {}`; the built-in table lives in code. Keep-alive is on by default for `claude-bridge` through these built-in provider defaults; the claude-bridge presets set `billing: token`, `keepalive.enabled: true` and a foreman idle model ([presets](presets.md#claude-bridge-cache-values)). It is off for request-billed providers (`github-copilot`) and silent for providers without any cache entry.

`keepalive.enabled` is the only switch. pi-foreman sends every idle warm itself, for every TTL above 10 s; Pi's own cache warmer is never used (it is always told `stop`), so Pi's `cacheWarming` setting is not read.

| key | default | meaning |
|---|---|---|
| `bridge.promptCacheTtl.main`, `.subagent` | `1h`, `5m` | Claude Code's prompt-cache TTL on the `claude-bridge` provider for the foreman and session foremen (`main`) and for subagents (`subagent`): `1h`, `5m` or `inherit` (leave `CLAUDE_CODE_PROMPT_CACHE_TTL` alone; the policy assumes 300 s). Invalid values fall back to the default with a warning. User and overlay config only; a project or session value is ignored with a warning. |
| `providers.<p>.cache.ttlSeconds` | derived for `claude-bridge` (3600 foreman, 300 subagent), else null | Prompt-cache time to live in seconds (integer >= 1); null = unknown, the policy stays off. An explicit value wins over the derived bridge TTL. A TTL of 10 s or less is never warmed. |
| `providers.<p>.cache.billing` | `token` for `claude-bridge`, `request` for `github-copilot` | `token` or `request`. A request-billed provider never gets a keep-alive. |
| `providers.<p>.cache.byModel` | none | Rows `{match, ttlSeconds?, billing?, note?}` layered over `ttlSeconds` and `billing`: the first row whose `match` (glob with `*`/`?`, else a substring of the model id) fits the active model wins, ahead of `ttlSeconds` and the derived bridge TTL. `billing: "request"` in a row never gets a keep-alive. User and overlay config only. |
| `providers.<p>.cache.keepalive.enabled` | true iff `billing` is `token` and `ttlSeconds` < 3600 or derived from `bridge.promptCacheTtl` | The only switch of the keep-alive. |
| `providers.<p>.cache.keepalive.budgetShare` | 0.5 | The half tier: the warms of an idle may cost at most this share (0..1) of one cold re-cache of the prompt. The quarter tier is half of it. |
| `providers.<p>.cache.keepalive.compactMinTokens` | 100000 | Smallest context (tokens) at which the final warm compaction runs; 0 = no minimum. |
| `providers.<p>.cache.warmCompact` | true | Compact once on the last warm. |
| `presence.enabled` | true | Probe the idle input time for the presence gate. |
| `presence.awayAfterMinutes` | 11 | Minutes without keyboard or mouse input after which the owner counts as away (1..1440). |
| `presence.command` | unset | A command that prints the seconds since the last input, replacing the platform probe. User or overlay config only. |

**Deprecated keys.** `keepalive.beyondPiCap`, `keepalive.windowMinutes`, `keepalive.selfWarmWindowMinutes`, `keepalive.awayTicks`, `keepalive.whileWaiting` and `keepalive.intervalSeconds` are accepted and ignored: nothing reads them. `foreman doctor` warns once per key set; delete them from your `foreman.json`. The warm window has no fixed length any more (the activity and cost rules end the warming), the interval is fixed (see Keep-alive), and `awayTicks` is replaced by the quarter tier.

### TTL by family

The warm tick and the on/off default follow the TTL of the matched row, so a family with a longer TTL warms less often.

| family | TTL | billing | keep-alive |
|---|---|---|---|
| Anthropic direct | none built in (`no_entry`; 300 s is the provider's own TTL) | none until set | off until you set `cache.ttlSeconds` and `cache.billing` |
| Claude through `claude-bridge`, foreman and session foremen | derived from `bridge.promptCacheTtl.main`: 3600 s (`1h`, default), 300 s (`5m`, `inherit`, or `FORCE_PROMPT_CACHING_5M`) | token | pi-foreman's warm, one per 3240 s (3600 s TTL) or 270 s (300 s TTL) |
| Claude through `claude-bridge`, subagents | derived from `bridge.promptCacheTtl.subagent`: 300 s (`5m`, default) | token | pi-foreman's warm (a child session warms its own cache the same way) |
| `github-copilot`, Claude-type model (`claude-*`) | 300 s (built-in row) | request | never |
| `github-copilot`, OpenAI-type model (`gpt-*`, `o1*`, `o3*`, `o4*`) | 1800 s (built-in row) | request | never |
| `github-copilot`, any other model | unknown (null), the policy stays hidden | request | never |
| request-billed provider with a `byModel` row such as `gpt-*` 600 | the row | request | never |

The built-in `github-copilot` rows are an order of precedence of their own: a matching `byModel` row, then an explicit `cache.ttlSeconds`, then the built-in row, then the provider's null. The footer hides every request-billed policy, so the rows show in `foreman doctor` and the policy values only.

### Children through the bridge

The bridge calls the Claude Agent SDK and sets no TTL itself; Claude Code reads `CLAUDE_CODE_PROMPT_CACHE_TTL` from the environment of the Pi process (the bridge spawns it with a copy of that environment at query time). pi-foreman sets it on the `claude-bridge` provider, at session start and on a model switch, before the first bridge query:

- `main` (the foreman and session foremen): `1h` by default. The bar, keep-alive, final compaction and the retro cache line use the same 3600 s.
- `subagent` (children, `PI_SUBAGENT_CHILD=1`): `5m` by default, so a child overrides a `1h` it inherited from the parent. Short-lived children gain nothing from the 1-hour cache and its higher write price.
- `inherit`: the variable is left alone, and the policy assumes 300 s. A subagent that inherits the parent's `1h` then runs on 1 h while the policy and bar assume 300 s.

Switching away from `claude-bridge` restores the earlier value (or removes the variable); other providers are never touched. The variable is process-wide, so a `claude` started from a shell tool inherits it too.

**Keep-alive for children.** A child session on `claude-bridge` sends no warms by default (`keepalive skipped bridge_child_off`, traced once per session): a bridge warm replays through `streamSimple` and often does not match the real request's cache key, so it pays a cold write and keeps nothing warm. Opt in with `providers.claude-bridge.cache.keepalive.children: true` (read without a schema entry); the miss contingency below still ends warming after the first warm that does not hit.

Claude Code honours the variable from roughly v2.1.242 (the exact minimum is unconfirmed); older versions ignore it harmlessly and keep their own TTL, so the policy then assumes a TTL the cache does not have.

**Cost.** The 1-hour cache costs more per cache write than the 5-minute one. On a subscription within plan usage that is covered; on extra-usage credits or an API key set `bridge.promptCacheTtl.main` to `5m` (or `inherit`). Without the preset a bridge foreman now gets a derived 3600 s and, since the keep-alive defaults to on for a derived bridge TTL, warms; set `providers.claude-bridge.cache.keepalive.enabled: false` to stop that.

`FORCE_PROMPT_CACHING_5M` in the environment makes Claude Code cache 5 minutes whatever the setting; the policy then assumes 300 s. `DISABLE_PROMPT_CACHING*` turns caching off. `foreman doctor` prints the effective TTL per kind and warns on both.

#### Migration from the old preset

Earlier versions of the `claude-bridge` presets wrote `providers.claude-bridge.cache.ttlSeconds: 300` and a `claude-*` `byModel` row of 3600 s. Applying a preset again does not remove them from your user config, and an explicit value wins over the derived TTL. Delete both from your user `foreman.json`; `foreman doctor` warns while they are there. A row or `ttlSeconds` you set on purpose is respected silently. The same goes for `keepalive.awayTicks: 2`, which the old presets wrote and which is now ignored.

The request-billed rows document the TTL a `byModel` row such as `{"match": "gpt-*", "ttlSeconds": 600, "billing": "request"}` sets for the live policy. They do not apply to the retro cost report: retro passes no model, so only the provider-level cache values (built-in entry and `cache.ttlSeconds` / `cache.billing`) count there, never a `byModel` row. For `claude-bridge` retro derives the TTL of the foreman kind from `bridge.promptCacheTtl` and the retro process's own environment (`FORCE_PROMPT_CACHING_5M`), not the foreman's.

## Layers

The user and overlay layers may set every cache key. The project and session layers can only tighten: `keepalive.enabled` accepts only `false`; `keepalive.budgetShare` only a lower value (at most 0.5); `keepalive.compactMinTokens` only a higher value (at least 100000 without an earlier value); `presence.enabled` accepts only `true` (more gating is the tightening direction), `presence.awayAfterMinutes` only a lower value (at most 11). `presence.command` (it runs a program), `ttlSeconds`, `billing` and `warmCompact` are ignored there. The deprecated keys keep their old layer rule and do nothing. An ignored or loosening value is dropped with a warning, and a `cache` or `keepalive` value that is not an object is dropped with an "expected an object" warning.

## Keep-alive

pi-foreman sends every idle warm itself (`extensions/core-adapter/selfwarm.ts`); Pi's own warmer is told `stop` through its `cache_warming_decision` hook, which answers first and reads nothing. A warm replays the messages of the last real request (the `context_with_system` capture) through `ctx.modelRegistry.streamSimple` with the same system prompt, tools, session id, reasoning level and cache retention and `maxTokens: 1`.

- **Switch.** `keepalive.enabled` on, token billing, a TTL above 10 s and a model that can be replayed. A model that Pi itself would not replay (budget-thinking `anthropic-messages` without adaptive thinking) is skipped with `keepalive skipped not_replayable`.
- **Tick.** A warm goes out `min(0.9 x TTL, TTL - 10 s)` after the last cache touch (a real request end or a completed warm): 10 s at a 20 s TTL, 270 s at 300 s, 3240 s at 3600 s. There is no fixed window: a stretch opens at each real request end and ends by the rules below. An errored or aborted request keeps the last touch, the budget and the captured request, so a still-warm cache keeps warming.
- **Never while** a real request is in flight (the warm in flight is aborted when a request starts) or a message is queued. A pending claude-bridge config approval ends the stretch (`claude_cfg_pending`) before the replay would start Claude Code on unapproved config. Children warm their own cache the same way, without presence.
- **Miss contingency.** Every completed warm must read the cache: when its `cacheRead` is 0 or its `cacheWrite` is at least its `cacheRead` the warm did not hit, warming is switched off for the whole session and the stretch ends with `self_warm_miss` (traced once). `/foreman cost` and `foreman doctor` report it. The footer shows 0 warms left after a miss.
- **Single owner.** The adapter can be loaded twice in one process (a bridge child). The instances share one session record keyed by the session file or id: only the instance that claimed it arms timers and sends warms, the others stay passive and take over if the owner shuts down; the miss flag and the budget are shared, so a miss stops every instance.
- **Through a bridge.** The bridge calls the Claude Agent SDK, so a warm can be a full Claude Code query, not a one-token request; the budget counts its real output cost. Whether that is cheaper than a cold resume is still unmeasured. The manual probe before relying on it: read `cacheRead` against `cacheWrite` of the first warm's usage entry.
- **Pi prerequisite.** A `promptCache` tier equal to `cache.ttlSeconds` for the retention in use (`long` with `PI_CACHE_RETENTION=long`, else `short`); `foreman doctor` warns on a mismatch. Pi's `cacheWarming` setting is not read.
- **Glyph and bar.** With `footer.style: "pi"` the status line shows a keep-alive glyph while a stretch is open (see [sessions](sessions.md)). The foreman footer's cache-timer bar (`footer.cacheBar`) always carries `♨ N` (the warms still allowed; while a turn runs, those a fresh idle stretch would allow) and the budget-tier glyph (`½`/`¼`), is computed from the same state and costs nothing (no request, only a repaint each second).

### Activity rule

The spend of a stretch is capped by a tier, chosen at each warm by what the session is doing:

- **Half tier** (`budgetShare`, default 0.5 of one cold re-cache): a running subagent (sync or async), a background task (`foreman_bg`, `bg_run`) or a `foreman_wait` raise it whatever the presence of the owner. A running turn, an open `ask_user_question` or `plan_mode_question`, a waiting permission or approval dialog and a command the session itself waits on (`bash`, `powershell`) raise it while the owner is not away.
- **Quarter tier** (half of `budgetShare`): everything else, and an away owner without a subagent, background task or wait.

An owner counts as away `presence.awayAfterMinutes` (11) after the last input, plus a grace of 15 minutes: a turn, question, dialog or command keeps the half tier until 15 minutes after the owner turned away, judged at the due time of the warm (from the presence sample's own idle time). An unknown presence counts as present. The tier is read at each warm and for the refusal check after it, so activity that ends lowers the cap at once.

## Warm budget (cost rule)

A warm costs tokens, so each stretch (the time since the last real request) has a budget: the warms may cost at most the tier's share of one cold re-cache of the prompt.

- **Formula.** Before each warm: refuse when `spent + next > share x cold`, `share` being `budgetShare` (half tier) or half of it (quarter tier). `cold` = prompt tokens P x the larger of the cache-write and the input rate, with P = input + cacheRead + cacheWrite of the last real request. `spent` = the real cost of the warms so far in this stretch (output tokens as reported, so a bridge's full answers count at their real size). `next` = the measured real cost of the last completed warm of the session (also one from an earlier stretch, with its prompt tokens scaled by the ratio of the current to that warm's prompt size), else P x the cache-read rate + 1 output token. With the default share and a cache-read rate a tenth of the input rate that is about 4 warms in the quarter tier and 9 in the half tier on a 100k-token prompt at the sample rates below.
- **Rate source order.** `config/prices.json` first when it has the model (the 1-hour write rate when the effective TTL is 3600 s or more, else the 5-minute one), else the registry cost of the model (one cache-write rate for any TTL). `spent` is repriced with the same source as `cold`.
- **Reset points.** Every real request, a compaction and a model change start a new stretch with an empty budget.
- **`budget_unavailable`.** With no prompt size or no price at all the budget cannot be computed: the trace says `keepalive skipped budget_unavailable` once and no warm is sent.
- **Refusal.** The next warm is judged right after the last allowed warm completed (its cost counted), under the tier that will hold at its due time, not at the next tick. A refusal traces `budget {spent, cold, share, tier}` and `keepalive skipped budget` (`count` = warms sent, `phase` = `settle`, `post_warm` or `pre_warm`), runs the final warm compaction (below) and ends the stretch with reason `budget`. When the budget allows no warm at all it is decided at settle, after a grace of the shorter of 60 s and a quarter of the TTL and a fresh presence probe: an owner who answers within the grace is never compacted.

## Presence gate

Warms for an owner who has left are not stopped, only capped by the quarter tier. The presence gate asks the operating system how long the keyboard and mouse have been idle:

| platform | probe |
|---|---|
| macOS | `ioreg -c IOHIDSystem` (`HIDIdleTime`) |
| Windows, WSL | `powershell(.exe) -NoProfile -NonInteractive` with `GetLastInputInfo` |
| Linux | `xprintidle`, when present |
| any | `presence.command`: any command printing the idle seconds; user or overlay config only because it runs a program |

- **Away rule.** The owner is away when the idle input time is at least `presence.awayAfterMinutes` (default 11); the tier uses it as described in the activity rule, with a 15-minute grace.
- **Never in a hook.** Every probe is a detached process with a 2 s timeout (5 s on Windows and WSL). A background timer refreshes the cached sample about a minute before the next warm is due, and the warm waits for its own probe.
- **Failure is present.** A failed probe, a timeout or no probe at all gives the state `unknown`, which counts as present; the trace says so once per session (`presence {outcome, idleSeconds}`). `presence.enabled: false` skips probing.

## Warm compaction

The last warm read can be spent on one compaction, so the summary call reads a warm cache. It has one trigger, traced as `trigger: "final_warm"`: the next warm is refused (cost rule) after the last cache touch. At most one compaction per stretch runs, and only for a foreman session (a child never requests one).

**When it is decided.** Right after the last cache touch that leaves no further warm: after each completed warm the cost rule is checked for the next one and, when it refuses, the compaction starts then (so it reads a cache that was just refreshed, not one a tick old). Zero allowed warms are decided at settle, after the grace above.

**Gates, in order:** `warmCompact` on, no compaction yet in this stretch, not busy (no running turn, subagent or queued message), not cold (the last touch is younger than 95% of the TTL), context above the final-warm gate (`final_warm` gate = 0.6 x the model's context window; a context window that is not known blocks it: no final compaction; an unknown runtime compaction point does not), then the minimum context. A gate that fails starts no compaction and ends the stretch (the session goes cold uncompacted); it traces `keepalive skipped` with the reason (`warm_compact_off`, `already_compacted`, `busy`, `cold`, `below_floor`). When all pass the adapter traces `compaction {reason: "warm_idle", point, model, trigger}` and takes the normal `session_before_compact` path (ledger digest, retro at compaction); the stretch then ends with reason `compact`. A cancelled or failed compaction arms the warm again.

**Minimum context.** The compaction runs only when the context is also at least `keepalive.compactMinTokens` (integer >= 0, default 100000, 0 = no minimum). `compactMinTokens` keeps warm compaction off small contexts: compacting loses detail for little saving, and a cold reload of a small context is cheap. Below it nothing is compacted, the session goes cold (the idle model downshift still applies) and the adapter traces `compaction_skipped {reason: "below_min", tokens, min, trigger}`. A project or session can only raise the key.

The savings of the warm summary call are not yet measured. Through the bridge the summary call takes an isolated path, so its warm savings stay unmeasured there; the compaction still pays off through the smaller cold resume.

## Where compaction fires

Pi's own auto-compaction decides, in every session, foreman and child alike: it compacts when the context passes the model's window minus `reserveTokens`. pi-foreman no longer requests a compaction after a turn (that call aborted a running child loop). `foreman setup` shapes the point per model by writing Pi's `compaction.modelOverrides["provider/id"].reserveTokens` into the same settings file as its other managed keys, with a diff and a backup; a value you set yourself is kept. What setup writes, who owns it and how `--remove` treats it: [install](install.md#what-setup-writes-for-compaction).

The point for a model is the lowest of:

- window minus the reserve Pi already uses for it (nothing to write when that is the lowest);
- the model's lowest price-tier boundary (`cost.tiers[].inputTokensAbove` in Pi's registry, or the `tiers` an overlay declares) minus `TIER_HEADROOM`, a constant of 20000 tokens, so a session stays below the dearer price tier;
- `compaction.maxTokens` (default 200000, minimum 50000, null = no cap). A project can only lower it.

The reserve written is window minus that point, and only when it is larger than the reserve Pi already uses for the model. A point below `keepRecentTokens` plus `TIER_HEADROOM` (40000 by default) is not written; setup warns instead, so a tiny cap cannot make Pi compact every turn. `compaction.priceTiers` and `compaction.threshold` are removed; a config that still has them gets a warning and the keys are ignored.

The footer bar shows the point Pi really uses (window minus the effective reserve), so a full bar means compaction fires. With `compaction.enabled: false` in Pi's settings the bar falls back to the window. The final warm compaction does not use this point: its gate is 0.6 x the context window.

Retro trade-off: Pi's own compaction cannot carry custom instructions, so a summary from a threshold compaction has no `## Retro` section; the retro entry notes that. The Retro section rides only on the final warm compaction. A manual `/compact` never carried it either.

## Stable prefix

The per-request hooks only append: a message already sent to the model stays byte-identical in every later request until a compaction, because a rewrite of an earlier message breaks the provider's cached prefix from that point on. The `context` notice filters (`ceremony.dedupeNotify`: duplicate tool-open notices, notices of ended runs, hidden long-command notices, delivered completion notices) decide once, the first time a notice reaches the model, and keep that verdict; a run that ends or a notice that is suppressed later affects only notices not yet sent. A compaction clears the verdicts, so the filters apply afresh to the rewritten context.

## Deferred tools

The hidden set of `tools.deferred` and the skill filter (`skills.*`) are fixed at session start and never change on their
own, so they do not move the cached prefix. A `tool_search` hit does not change the declarations while codemode is
active (the tool is called through codemode), so the cache survives every search. Without codemode a hit un-hides the
found tool: its declaration enters the next request, and because Pi projects the whole transcript again when the
declarations change, that request is one cold prefix, not only a longer system prompt. The un-hidden tool then stays
declared for the session and across resume (the `deferred-loaded` session entry), so the cost is paid once per tool.
The keep-alive replay captures the request as sent and warms the current loadout. See [tools](tools.md#deferred-tools-and-searchable-skills).

## Cost and privacy

The list-price table is `config/prices.json` (also read by the bench): the status line, presence `runs[].cost` and `/foreman cost` price a usage record with it when the provider logged `cost.total: 0`, as the claude-bridge does.

Keep-alive spends tokens: every warm reads the whole prefix from the cache.

- Cost per warm = `cacheRead` tokens x the provider's cache-read rate + 1 output token.
- Sample (computed, not measured): a 100k-token prefix at $1 per million cache-read tokens (the Anthropic rate in Pi's bundled model registry at the time of writing; check your own model) is about $0.10 per warm.
- Per stretch: at most the tier's share of one cold re-cache, so with the default `budgetShare` 0.5 a stretch costs at most half (subagent, background task, wait or an owner who is present) or a quarter of one cold prompt, then it ends with one compaction. Compare it with the cold prompt a resume pays once the cache has expired.
- Where it shows: the footer excludes keep-alive from the per-turn cost; `/foreman cost` has its own `keep-alive: N call(s), $x (pi N, foreman M)` line, split by who sent the warm; `foreman retro` prints `cache: keepalives N ($x), warm compactions M, cold resumes K` and, when the idle downshift ran, `, downshifted turns D` (cold resumes are approximate, see [retro](retro.md)).
- **Switch it off:** `providers.claude-bridge.cache.keepalive.enabled: false` in the user or overlay config. A project or session may only tighten (`false`, or lower values, see Layers). It is on by default for `claude-bridge` through the built-in provider defaults and on in the claude-bridge presets.
- **Real cost.** The sample above is computed, not measured; the keep-alive usage line and the retro `cache:` line record the real per-session cost.
- **Privacy.** The hidden request sends the same context to the same provider as the last real request. Nothing new leaves the machine.

## Providers

| provider | TTL | billing | keep-alive |
|---|---|---|---|
| `claude-bridge` | derived: 3600 s foreman, 300 s subagent | token | on by default (built-in defaults; the preset carries the same values) |
| `github-copilot` | per model: `claude-*` 300 s, `gpt-*`/`o1*`/`o3*`/`o4*` 1800 s, else unknown | request | off (request-billed): policy off |
| others | no entry | n/a | none; silent (no trace) |

A provider with no entry and no `cache` config is not traced at all. Add `providers.<p>.cache` with `ttlSeconds` and `billing: "token"` to give another provider the same treatment.

## Trace events

`keepalive` (outcome, reason):

| outcome | reason | meaning |
|---|---|---|
| `fired` | `reason` = the activity reason (`subagent`, `bg_task`, `wait`, `question`, `dialog`, `command`, `turn`, `idle`), plus `source` (`foreman`), `tier`, `presence`, `cacheRead`, `cacheWrite`, `cost` | One warm request. |
| `skipped` | `budget`, `budget_unavailable` | No further warm is allowed by the cost rule (`budget`: extra fields `count`, `phase`, `tier`), or the budget cannot be computed (once). |
| `skipped` | `not_replayable`, `late`, `claude_cfg_pending`, `bridge_child_off` | The model cannot be replayed (once), the timer fired more than half the margin late, a claude-bridge config approval is pending, or a child on claude-bridge does not warm (once; `keepalive.children`). |
| `skipped` | `ttl_too_short` | The TTL is 10 s or less (once). |
| `skipped` | `warm_compact_off`, `already_compacted`, `busy`, `cold`, `below_floor` | The final-warm compaction check declined. |
| `window_end` | `budget`, `compact`, `shutdown`, `model_change`, `not_owned`, `late`, `not_replayable`, `claude_cfg_pending`, `error`, `self_warm_miss` | The stretch ended for that reason. |

`compaction {reason: "warm_idle", point, model, trigger}`: a warm compaction was started; `trigger` is `final_warm`. `compaction_point {model, point}`: the point Pi uses for the model (null when unknown or compaction is off), once at session start and on a model change.

`compaction_skipped {reason: "below_min", tokens, min, trigger}`: the context is below `keepalive.compactMinTokens`, so no warm compaction ran (see Minimum context above).

Other events:

| event | fields | meaning |
|---|---|---|
| `budget` | `spent, cold, share, tier` | A warm was refused by the cost rule (dollars, then the share of the tier). |
| `presence` | `outcome` (`present`, `away`, `unknown`), `idleSeconds` | A presence sample. |
| `foreman_model` | `from, to, reason, cause` or `outcome` | The idle-model downshift and its restore ([ladder](ladder.md#idle-rung-foreman-downshift)). |
