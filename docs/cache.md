# Idle prompt cache

> Covers the per-provider prompt-cache policy (`providers.<p>.cache`): TTL, billing, the keep-alive that stops an idle
> session resuming cold, its spend budget and presence gate, the self-sent warms beyond Pi's 30-minute cap, and warm
> compaction.

On token-billed providers with a short cache TTL (`claude-bridge`: 3600 s for the foreman, 300 s for subagents, derived; keep-alive on by default) an idle
session otherwise pays for a cold prompt on resume. Layer rules are below; the idle model downshift is in [ladder](ladder.md#idle-rung-foreman-downshift).

## Config

Built-in values exist for `claude-bridge` (`ttlSeconds` 300, `billing` `token`; the TTL is derived from `bridge.promptCacheTtl` first, see below) and `github-copilot` (`ttlSeconds` null, `billing` `request`, plus built-in per-model rows). A key set in the config wins over the built-in value. `config/foreman.defaults.json` stays `providers: {}`; the built-in table lives in code. Keep-alive is on by default for `claude-bridge` through these built-in provider defaults; the claude-bridge presets set `billing: token`, `keepalive.enabled: true`, `keepalive.awayTicks: 2` and a foreman idle model ([presets](presets.md#claude-bridge-cache-values)). It is off for request-billed providers (`github-copilot`) and silent for providers without any cache entry.

| key | default | meaning |
|---|---|---|
| `bridge.promptCacheTtl.main`, `.subagent` | `1h`, `5m` | Claude Code's prompt-cache TTL on the `claude-bridge` provider for the foreman and session foremen (`main`) and for subagents (`subagent`): `1h`, `5m` or `inherit` (leave `CLAUDE_CODE_PROMPT_CACHE_TTL` alone; the policy assumes 300 s). Invalid values fall back to the default with a warning. User and overlay config only; a project or session value is ignored with a warning. |
| `providers.<p>.cache.ttlSeconds` | derived for `claude-bridge` (3600 foreman, 300 subagent), else null | Prompt-cache time to live in seconds (integer >= 1); null = unknown, the policy stays off. An explicit value wins over the derived bridge TTL. |
| `providers.<p>.cache.billing` | `token` for `claude-bridge`, `request` for `github-copilot` | `token` or `request`. A request-billed provider never gets a keep-alive. |
| `providers.<p>.cache.byModel` | none | Rows `{match, ttlSeconds?, billing?, note?}` layered over `ttlSeconds` and `billing`: the first row whose `match` (glob with `*`/`?`, else a substring of the model id) fits the active model wins, ahead of `ttlSeconds` and the derived bridge TTL. `billing: "request"` in a row never gets a keep-alive. User and overlay config only. |
| `providers.<p>.cache.keepalive.enabled` | true iff `billing` is `token` and `ttlSeconds` < 3600 or derived from `bridge.promptCacheTtl` | Switches the keep-alive on or off. |
| `providers.<p>.cache.keepalive.intervalSeconds` | 90% of `ttlSeconds`, at least 30 | Seconds between pings (30..3600). |
| `providers.<p>.cache.keepalive.windowMinutes` | 45 | Minutes of idleness after which Pi's warms stop (1..60); capped by Pi's own idle limit of 30 minutes. |
| `providers.<p>.cache.keepalive.budgetShare` | 0.5 | Warm budget per idle: the warms may cost at most this share (0..1) of one cold re-cache of the prompt. |
| `providers.<p>.cache.keepalive.awayTicks` | 0 | Warms allowed per idle while the owner is away (0..20). |
| `providers.<p>.cache.keepalive.whileWaiting` | true | Child runs, waits and launch waits no longer stop the warms. |
| `providers.<p>.cache.keepalive.beyondPiCap` | true | pi-foreman sends the warms itself where Pi stops (TTL above about 33 minutes); needs `keepalive.enabled`. |
| `providers.<p>.cache.keepalive.selfWarmWindowMinutes` | `max(45, 3 x TTL minutes)` | Minutes of idleness after which the self-sent warms stop (1..1440). |
| `providers.<p>.cache.keepalive.compactMinTokens` | 100000 | Smallest context (tokens) at which a warm compaction runs; 0 = no minimum. |
| `providers.<p>.cache.warmCompact` | true | Warm the cache after a compaction. |
| `presence.enabled` | true | Probe the idle input time for the presence gate. |
| `presence.awayAfterMinutes` | 11 | Minutes without keyboard or mouse input after which the owner counts as away (1..1440). |
| `presence.command` | unset | A command that prints the seconds since the last input, replacing the platform probe. User or overlay config only. |

### TTL by family

The keep-alive interval and the on/off default follow the TTL of the matched row, so a family with a longer TTL pings less often.

| family | TTL | billing | keep-alive |
|---|---|---|---|
| Anthropic direct | none built in (`no_entry`; 300 s is the provider's own TTL) | none until set | off until you set `cache.ttlSeconds` and `cache.billing` |
| Claude through `claude-bridge`, foreman and session foremen | derived from `bridge.promptCacheTtl.main`: 3600 s (`1h`, default), 300 s (`5m`, `inherit`, or `FORCE_PROMPT_CACHING_5M`) | token | pi-foreman's self-warm at 3600 s (Pi stops at 30 minutes), Pi's warmer at 300 s |
| Claude through `claude-bridge`, subagents | derived from `bridge.promptCacheTtl.subagent`: 300 s (`5m`, default) | token | Pi's warmer |
| `github-copilot`, Claude-type model (`claude-*`) | 300 s (built-in row) | request | never |
| `github-copilot`, OpenAI-type model (`gpt-*`, `o1*`, `o3*`, `o4*`) | 1800 s (built-in row) | request | never |
| `github-copilot`, any other model | unknown (null), the policy stays hidden | request | never |
| request-billed provider with a `byModel` row such as `gpt-*` 600 | the row | request | never |

The built-in `github-copilot` rows are an order of precedence of their own: a matching `byModel` row, then an explicit `cache.ttlSeconds`, then the built-in row, then the provider's null. The footer hides every request-billed policy, so the rows show in `foreman doctor` and the policy values only.

### Children through the bridge

The bridge calls the Claude Agent SDK and sets no TTL itself; Claude Code reads `CLAUDE_CODE_PROMPT_CACHE_TTL` from the environment of the Pi process (the bridge spawns it with a copy of that environment at query time). pi-foreman sets it on the `claude-bridge` provider, at session start and on a model switch, before the first bridge query:

- `main` (the foreman and session foremen): `1h` by default. The bar, keep-alive, self-warm, warm compaction and the retro cache line use the same 3600 s.
- `subagent` (children, `PI_SUBAGENT_CHILD=1`): `5m` by default, so a child overrides a `1h` it inherited from the parent. Short-lived children gain nothing from the 1-hour cache and its higher write price.
- `inherit`: the variable is left alone, and the policy assumes 300 s. A subagent that inherits the parent's `1h` then runs on 1 h while the policy and bar assume 300 s.

Switching away from `claude-bridge` restores the earlier value (or removes the variable); other providers are never touched. The variable is process-wide, so a `claude` started from a shell tool inherits it too.

Claude Code honours the variable from roughly v2.1.242 (the exact minimum is unconfirmed); older versions ignore it harmlessly and keep their own TTL, so the policy then assumes a TTL the cache does not have.

**Cost.** The 1-hour cache costs more per cache write than the 5-minute one. On a subscription within plan usage that is covered; on extra-usage credits or an API key set `bridge.promptCacheTtl.main` to `5m` (or `inherit`). Without the preset a bridge foreman now gets a derived 3600 s and, since the keep-alive defaults to on for a derived bridge TTL, self-warms; set `providers.claude-bridge.cache.keepalive.enabled: false` to stop that.

`FORCE_PROMPT_CACHING_5M` in the environment makes Claude Code cache 5 minutes whatever the setting; the policy then assumes 300 s. `DISABLE_PROMPT_CACHING*` turns caching off. `foreman doctor` prints the effective TTL per kind and warns on both.

#### Migration from the old preset

Earlier versions of the `claude-bridge` presets wrote `providers.claude-bridge.cache.ttlSeconds: 300` and a `claude-*` `byModel` row of 3600 s. Applying a preset again does not remove them from your user config, and an explicit value wins over the derived TTL. Delete both from your user `foreman.json`; `foreman doctor` warns while they are there. A row or `ttlSeconds` you set on purpose is respected silently.

The request-billed rows document the TTL a `byModel` row such as `{"match": "gpt-*", "ttlSeconds": 600, "billing": "request"}` sets for the live policy. They do not apply to the retro cost report: retro passes no model, so only the provider-level cache values (built-in entry and `cache.ttlSeconds` / `cache.billing`) count there, never a `byModel` row. For `claude-bridge` retro derives the TTL of the foreman kind from `bridge.promptCacheTtl` and the retro process's own environment (`FORCE_PROMPT_CACHING_5M`), not the foreman's.

## Layers

The user and overlay layers may set every cache key. The project and session layers can only tighten: `keepalive.enabled`, `keepalive.whileWaiting` and `keepalive.beyondPiCap` accept only `false`; `keepalive.windowMinutes` only a lower value (minimum 1; with no earlier value, at most 45); `keepalive.budgetShare` only a lower value (at most 0.5), `keepalive.awayTicks` only a lower value (at most 0) and `keepalive.selfWarmWindowMinutes` only a lower value (at most its default); `keepalive.compactMinTokens` only a higher value (at least 100000 without an earlier value); `presence.enabled` accepts only `true` (more gating is the tightening direction), `presence.awayAfterMinutes` only a lower value (at most 11). `presence.command` (it runs a program), `ttlSeconds`, `billing`, `keepalive.intervalSeconds` and `warmCompact` are ignored there. An ignored or loosening value is dropped with a warning, and a `cache` or `keepalive` value that is not an object is dropped with an "expected an object" warning.

## Keep-alive

Pi's native cache warmer does the work: while a session is idle it sends a hidden request with the exact prefix of the last request and `max_tokens` 1, which refreshes the provider's prompt cache. pi-foreman only permits and watches it, through Pi's `cache_warming_decision` hook (`extensions/core-adapter/idlecache.ts`). It never sends a request itself.

- **Window.** A window opens when the foreman session settles with no child run, wait, queued message or running turn, and the provider's policy is active. It lasts `min(windowMinutes, 30)` minutes: Pi stops idle warming 30 minutes after the last real request, so a longer `windowMinutes` has no effect.
- **Ticks.** Pi itself ticks at 0.9 x TTL (at most TTL minus 10 s). `intervalSeconds` does not change that tick: it positions the warm-compaction check (`windowEnd - interval`) and the watchdog gap (the larger of `intervalSeconds` and Pi's tick, plus 60 s, without a warm request).
- **The `warm` override.** On a provider that reports zero cost (claude-bridge) Pi's own economics check would never warm. During a window the hook answers `warm`, which bypasses that check. It is bounded by the window, the busy gates and `keepalive.enabled`.
- **Window end.** After a window ends by `window` or `compact` the hook answers `stop`, which ends Pi's warming until the next real request.
- **Idle only.** While a turn or a tool runs, the hook does not override. On a zero-cost provider a final request that takes longer than one tick therefore loses Pi's warmer before the session settles, and the first window ends `warmer_stopped` without a keep-alive.
- **What ends a window.** New activity (a run starts, user input, a tool result, a child or intercom message), a compaction, session shutdown, the window end, the watchdog (no warm decision for the watchdog gap), and the confirm deadline: a warm decision with no usage entry 90 s later. The 90 s margin assumes a warm request finishes within 90 s.
- **Priced providers.** On a token provider with real prices, Pi's own economics may warm while a child runs. Those entries are synced and tagged `keepalive` too.
- **Pi prerequisites.** `cacheWarming: "idle"` in Pi's settings and a `promptCache` entry for the model. Without them Pi never warms; `foreman doctor` reports that as WARN. `foreman setup` and `foreman config apply-preset` never write either. The `promptCache` entry goes in `<agent dir>/models.json` (the file `foreman doctor` names): `{"providers": {"<provider>": {"modelOverrides": {"<modelId>": {"promptCache": {"short": 300}}}}}}`.
- **Glyph.** With `footer.style: "pi"`, while a window is open the status line shows a keep-alive glyph (see [sessions](sessions.md)). A cold cache and the idle-model downshift have their own glyphs there.
- **Footer bar.** The foreman footer shows a cache-timer bar instead (`footer.cacheBar`): the time to cold (0.95 x the TTL after the last touch), the warms still to come with `budget` or `away` when that limits them, and the idle rung that follows. It is computed from the same budget, presence and window state the warms use, costs nothing (no request, only a repaint each second), and a model change starts it cold.
- **While waiting.** With `keepalive.whileWaiting` (default true) active child runs, waits and launch waits no longer count as busy for warming: a long child run no longer lets the foreman's cache expire. A running foreman turn or a queued message still does.

## Warm budget

A warm costs tokens, so each idle (the time since the last real request) has a budget: the warms may cost at most `keepalive.budgetShare` (default 0.5) of one cold re-cache of the prompt.

- **Formula.** Before each warm: refuse when `spent + next > budgetShare x cold`. `cold` = prompt tokens P x the cache-write rate, with P = input + cacheRead + cacheWrite of the last real request. `spent` = the real cost of the warms so far in this idle (output tokens as reported, so a bridge's full answers count at their real size). `next` = the last completed warm's real cost, else P x the cache-read rate + 1 output token.
- **Rate source order.** `config/prices.json` first when it has the model (the 1-hour write rate when the effective TTL is 3600 s or more, else the 5-minute one), else the registry cost of the model (one cache-write rate for any TTL). `spent` is repriced with the same source as `cold`.
- **Reset points.** Every real request, a compaction and a model change start a new idle with an empty budget.
- **`budget_unavailable`.** With no prompt size or no price at all the budget cannot be computed: the trace says `keepalive skipped budget_unavailable` once, and the older behaviour applies (window and `windowEnd - interval` compaction, no budget refusal).
- **Refusal.** A refused warm traces `budget {spent, cold, share}` and `keepalive skipped budget`, spends the last warm read on one compaction (below) and ends the window with reason `budget`.

## Presence gate

Warms for an owner who has left are wasted. The presence gate asks the operating system how long the keyboard and mouse have been idle:

| platform | probe |
|---|---|
| macOS | `ioreg -c IOHIDSystem` (`HIDIdleTime`) |
| Windows, WSL | `powershell(.exe) -NoProfile -NonInteractive` with `GetLastInputInfo` |
| Linux | `xprintidle`, when present |
| any | `presence.command`: any command printing the idle seconds; user or overlay config only because it runs a program |

- **Away rule.** The owner is away when the idle input time is at least `presence.awayAfterMinutes` (default 11). While away, at most `keepalive.awayTicks` (default 0) warms run per idle; the next one is refused like a budget exhaustion (`keepalive skipped away`, window end `away`, warm compaction with trigger `away`).
- **Never in the hook.** Every probe is a detached process with a 2 s timeout (5 s on Windows and WSL). A background timer refreshes the cached sample about a minute before the next warm is due; the synchronous `cache_warming_decision` hook only reads the sample, and the self-warm waits for its own probe.
- **Failure is present.** A failed probe, a timeout or no probe at all gives the state `unknown`, which counts as present; the trace says so once per session (`presence {outcome, idleSeconds}`). `presence.enabled: false` skips probing.

## Self-warm beyond Pi's cap

Pi stops idle warming 30 minutes after the last real request (the constant `MAX_IDLE_WARMING_AGE_MS` in Pi's cache warmer, not configurable) and ticks at 0.9 x TTL. For a 1-hour cache the first tick (54 minutes) is already past the cap, so Pi never warms it. pi-foreman therefore sends the warm itself when `keepalive.beyondPiCap` (default true) and `keepalive.enabled` are on, the provider bills by token and the TTL is above about 33 minutes (`ttlSeconds` >= 2001); the hook then answers `stop` to Pi.

- **How.** The adapter keeps the messages of the last real request (the `context_with_system` capture) and replays them through `ctx.modelRegistry.streamSimple` with the same system prompt, tools, session id, reasoning level and cache retention and `maxTokens: 1`. Nothing is sent that the last real request did not send; handlers that change the messages after the adapter's still can alter the payload, which the miss check covers. Never in a child, never while a turn runs or a message is queued. A model that Pi itself would not replay (budget-thinking `anthropic-messages` without adaptive thinking) is skipped with `keepalive skipped not_replayable`.
- **Schedule.** 0.9 x TTL after the last cache touch (the last real request end or the last completed warm of either source), with Pi's late-timer rule. New activity, a model change, a compaction and shutdown abort a warm in flight; an aborted or failed call is not recorded.
- **Window.** `keepalive.selfWarmWindowMinutes` (default `max(45, 3 x TTL minutes)`, up to 1440) replaces `windowMinutes` for these warms. The budget and the presence gate apply as above.
- **Miss contingency.** The first completed self-warm of a session must read the cache: when its `cacheWrite` is at least its `cacheRead` the warm did not hit, self-warm is switched off for the session and the window ends with `self_warm_miss`. `/foreman cost` and `foreman doctor` report it.
- **Through a bridge.** The bridge calls the Claude Agent SDK, so a warm can be a full Claude Code query, not a one-token request; the budget counts its real output cost. Whether that is cheaper than a cold resume, and the savings of the warm summary call, are still unmeasured. The manual probe before relying on it: send one self-warm on claude-bridge and read `cacheRead` against `cacheWrite` of its usage entry.
- **Pi prerequisites.** Pi's `cacheWarming: "idle"` and a `promptCache` tier equal to `cache.ttlSeconds` for the retention in use (`long` with `PI_CACHE_RETENTION=long`, else `short`); `foreman doctor` warns on a mismatch.

## Warm compaction

The last warm read can be spent on a compaction, so the summary call reads a warm cache. At most one compaction per idle runs, and only above the idle floor. It has three triggers, traced as `trigger`:

- `budget`: the next warm was refused by the budget (compaction while the cache is still warm).
- `away`: the next warm was refused by the presence gate.
- `window`: the older rule, at `windowEnd - intervalSeconds` (halfway through a window shorter than the interval); it applies when no budget is available.

Below the floor the session goes cold uncompacted. After a compaction the idle counts as cold. The floor is half the runtime compaction point (see "Where compaction fires"), in tokens: Pi compacts at the full point, so an idle session is always below it, and a floor at the full value would never fire. It reads the point Pi really uses, so a smaller reserve of your own lowers the floor too. With `compaction.enabled: false` in Pi's settings there is no point and no warm compaction. Only foreman sessions run the warm compaction; a child never requests a compaction.

Gates, in order: `warmCompact` on, no compaction yet in this idle, not busy, not cold (the last cache read or answer is younger than 95% of the TTL), context usage over the floor (`window_end` reason `below_floor`), then the minimum context below. A gate that fails ends nothing; it traces `keepalive window_end` with its reason (below), except for the budget and away triggers, where it traces `keepalive skipped` with that reason. When all pass, the adapter starts the compaction and traces `compaction {reason: "warm_idle", point, model, trigger}`. The compaction takes the normal `session_before_compact` path (ledger digest, retro at compaction), and the window then ends with reason `compact`.

**Minimum context.** The warm compaction runs only when both hold: the context tokens are above half the runtime compaction point (the relative floor above) and at least `keepalive.compactMinTokens` (integer >= 0, default 100000, 0 = no minimum). The relative floor is checked first (a miss is `window_end` / `skipped` `below_floor`), then the minimum. `compactMinTokens` keeps warm compaction off small contexts: compacting loses detail for little saving, and a cold reload of a small context is cheap. It is checked after the gates above and before the compaction starts, on all three triggers (`budget`, `away` and `window`; the `window` trigger exists for the near expiry of Pi's warm window, not for a near-full context, so the same minimum applies). Below it nothing is compacted, the session goes cold as after a declined gate (the idle model downshift still applies) and the adapter traces `compaction_skipped {reason: "below_min", tokens, min}`. A project or session can only raise the key.

The savings of the warm summary call are not yet measured. Through the bridge the summary call takes an isolated path, so its warm savings stay unmeasured there; the compaction still pays off through the smaller cold resume.

## Where compaction fires

Pi's own auto-compaction decides, in every session, foreman and child alike: it compacts when the context passes the model's window minus `reserveTokens`. pi-foreman no longer requests a compaction after a turn (that call aborted a running child loop). `foreman setup` shapes the point per model by writing Pi's `compaction.modelOverrides["provider/id"].reserveTokens` into the same settings file as its other managed keys, with a diff and a backup; a value you set yourself is kept. What setup writes, who owns it and how `--remove` treats it: [install](install.md#what-setup-writes-for-compaction).

The point for a model is the lowest of:

- window minus the reserve Pi already uses for it (nothing to write when that is the lowest);
- the model's lowest price-tier boundary (`cost.tiers[].inputTokensAbove` in Pi's registry, or the `tiers` an overlay declares) minus `TIER_HEADROOM`, a constant of 20000 tokens, so a session stays below the dearer price tier;
- `compaction.maxTokens` (default 200000, minimum 50000, null = no cap). A project can only lower it.

The reserve written is window minus that point, and only when it is larger than the reserve Pi already uses for the model. A point below `keepRecentTokens` plus `TIER_HEADROOM` (40000 by default) is not written; setup warns instead, so a tiny cap cannot make Pi compact every turn. `compaction.priceTiers` and `compaction.threshold` are removed; a config that still has them gets a warning and the keys are ignored.

The footer bar and the idle floor show and use the point Pi really uses (window minus the effective reserve), so a full bar means compaction fires. With `compaction.enabled: false` in Pi's settings the bar falls back to the window.

Retro trade-off: Pi's own compaction cannot carry custom instructions, so a summary from a threshold compaction has no `## Retro` section; the retro entry notes that. The Retro section rides only on the idle warm compaction. A manual `/compact` never carried it either.

## Cost and privacy

The list-price table is `config/prices.json` (also read by the bench): the status line, presence `runs[].cost` and `/foreman cost` price a usage record with it when the provider logged `cost.total: 0`, as the claude-bridge does.

Keep-alive spends tokens: every tick reads the whole prefix from the cache.

- Cost per keep-alive = `cacheRead` tokens x the provider's cache-read rate + 1 output token.
- Sample (computed, not measured): a 100k-token prefix at $1 per million cache-read tokens (the Anthropic rate in Pi's bundled model registry at the time of writing; check your own model) is about $0.10 per keep-alive.
- Per window: (effective window / tick) keep-alives. With the 30 minute cap and a 270 s tick that is about 6, so about $0.60 per idle window for that prefix. Compare it with the cold prompt a resume pays once the cache has expired.
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
| `fired` | none (`source`, `cacheRead`, `cacheWrite`, `cost`) | One warm request: `source` `foreman` for a self-warm, absent for Pi's, synced from the session entry. |
| `skipped` | `budget`, `budget_unavailable`, `away`, `not_replayable`, `self_warm_miss` | The next warm was refused by the budget or presence gate (`budget`, `away`), the budget cannot be computed (once), the model cannot be replayed, or self-warm is off after a miss. |
| `skipped` | `busy` | The session settled with a child, wait, queued message or run active; once per idle. |
| `skipped` | `disabled`, `billing_request`, `ttl_unknown`, `ttl_long` | The cache policy is off; once per reason. |
| `skipped` | `pi_mode_not_idle`, `no_prompt_cache` | A Pi prerequisite is missing; once per reason. |
| `window_end` | `window`, `activity`, `shutdown`, `compact`, `hook_stop`, `error`, `budget`, `away`, `self_warm_miss` | The window ended for that reason. |
| `window_end` | `warmer_stopped` | The watchdog or the confirm deadline passed without a warm request. |
| `window_end` | `warm_compact_off`, `already_compacted`, `busy`, `cold`, `below_floor` | The warm-compaction check declined; the window continues. |

`compaction {reason: "warm_idle", point, model, trigger}`: a warm compaction was started; `trigger` is `budget`, `away` or `window`. `compaction_point {model, point}`: the point Pi uses for the model (null when unknown or compaction is off), once at session start and on a model change.

`compaction_skipped {reason: "below_min", tokens, min, trigger}`: the context is below `keepalive.compactMinTokens`, so no warm compaction ran (see Minimum context above).

Other events:

| event | fields | meaning |
|---|---|---|
| `budget` | `spent, cold, share` | A warm was refused by the budget (dollars, then the share). |
| `presence` | `outcome` (`present`, `away`, `unknown`), `idleSeconds` | A presence sample. |
| `foreman_model` | `from, to, reason, cause` or `outcome` | The idle-model downshift and its restore ([ladder](ladder.md#idle-rung-foreman-downshift)). |
