# Idle prompt cache

> Covers the per-provider prompt-cache policy (`providers.<p>.cache`): TTL, billing, the keep-alive that stops an idle
> session resuming cold, and warm compaction. On token-billed providers with a short cache TTL (`claude-bridge`:
> 300 s, keep-alive on by default) an idle session otherwise pays for a cold prompt on resume. Layer rules are in [safety](safety.md).

## Config

Built-in values exist for `claude-bridge` (`ttlSeconds` 300, `billing` `token`) and `github-copilot` (`ttlSeconds` null, `billing` `request`). A key set in the config wins over the built-in value. `config/foreman.defaults.json` stays `providers: {}`; the built-in table lives in code. Keep-alive is on by default for `claude-bridge` through these built-in provider defaults; the `claude-bridge` preset sets ttl 300 with a `byModel` row of 600 s for `claude-*` and switches the keep-alive off (`keepalive.enabled: false`). It is off for request-billed providers (`github-copilot`) and silent for providers without any cache entry.

| key | default | meaning |
|---|---|---|
| `providers.<p>.cache.ttlSeconds` | 300 for `claude-bridge`, else null | Prompt-cache time to live in seconds (integer >= 1); null = unknown, the policy stays off. |
| `providers.<p>.cache.billing` | `token` for `claude-bridge`, `request` for `github-copilot` | `token` or `request`. A request-billed provider never gets a keep-alive. |
| `providers.<p>.cache.byModel` | none | Rows `{match, ttlSeconds?, billing?, note?}` layered over `ttlSeconds` and `billing`: the first row whose `match` (glob with `*`/`?`, else a substring of the model id) fits the active model wins. `billing: "request"` in a row never gets a keep-alive. User and overlay config only. |
| `providers.<p>.cache.keepalive.enabled` | true iff `billing` is `token` and `ttlSeconds` < 3600 | Switches the keep-alive on or off. |
| `providers.<p>.cache.keepalive.intervalSeconds` | 90% of `ttlSeconds`, at least 30 | Seconds between pings (30..3600). |
| `providers.<p>.cache.keepalive.windowMinutes` | 45 | Minutes of idleness after which the pings stop (1..60); capped by Pi's own idle limit of 30 minutes. |
| `providers.<p>.cache.warmCompact` | true | Warm the cache after a compaction. |

### TTL by family

The keep-alive interval and the on/off default follow the TTL of the matched row, so a family with a longer TTL pings less often.

| family | TTL | billing | keep-alive |
|---|---|---|---|
| Anthropic direct | none built in (`no_entry`; 300 s is the provider's own TTL) | none until set | off until you set `cache.ttlSeconds` and `cache.billing` |
| Claude through the `claude-bridge` preset | 600 s (`byModel` row, measured >= 10 min, 1 h plausible) | token | per `keepalive.enabled` |
| request-billed provider, Claude-type model | 300 s | request | never |
| request-billed provider, OpenAI-type model | 600 s | request | never |

The request-billed rows document the TTL a `byModel` row such as `{"match": "gpt-*", "ttlSeconds": 600, "billing": "request"}` sets for the live policy. They do not apply to the retro cost report: retro passes no model, so only the provider-level cache values (built-in entry and `cache.ttlSeconds` / `cache.billing`) count there, never a `byModel` row.

## Layers

The user and overlay layers may set every cache key. The project and session layers can only tighten: `keepalive.enabled` accepts only `false`, and `keepalive.windowMinutes` only a lower value (minimum 1; with no earlier value, at most 45). `ttlSeconds`, `billing`, `keepalive.intervalSeconds` and `warmCompact` are ignored there. An ignored or loosening value is dropped with a warning, and a `cache` or `keepalive` value that is not an object is dropped with an "expected an object" warning.

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
- **Glyph.** While a window is open the footer shows a keep-alive glyph (see [sessions](sessions.md)).

## Warm compaction

The last warm read can be spent on a compaction, so the summary call reads a warm cache. At most one compaction per idle runs, at `windowEnd - intervalSeconds` (halfway through a window shorter than the interval), and only above the idle floor. The floor is half the runtime compaction point (see "Where compaction fires"), in tokens: Pi compacts at the full point, so an idle session is always below it, and a floor at the full value would never fire. It reads the point Pi really uses, so a smaller reserve of your own lowers the floor too. With `compaction.enabled: false` in Pi's settings there is no point and no warm compaction.

Gates, in order: `warmCompact` on, no compaction yet in this idle, not busy, not cold (the last cache read or answer is younger than 95% of the TTL), context usage over the floor. A gate that fails ends nothing; it traces `keepalive window_end` with its reason (below). When all pass, the adapter starts the compaction and traces `compaction {reason: "warm_idle", point, model}`. The compaction takes the normal `session_before_compact` path (ledger digest, retro at compaction), and the window then ends with reason `compact`. Only foreman sessions run it; a child never requests a compaction.

The savings of the warm summary call are not yet measured.

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
- Where it shows: the footer excludes keep-alive from the per-turn cost; `/foreman cost` has its own `keep-alive: N call(s), $x` line; `foreman retro` prints `cache: keepalives N ($x), warm compactions M, cold resumes K` (cold resumes are approximate, see [retro](retro.md)).
- **Switch it off:** `providers.claude-bridge.cache.keepalive.enabled: false` in the user or overlay config. A project or session may only tighten (`false`, or a lower `windowMinutes`). It is on by default for `claude-bridge` through the built-in provider defaults; applying the `claude-bridge` preset turns it off.
- **Real cost.** The sample above is computed, not measured; the keep-alive usage line and the retro `cache:` line record the real per-session cost.
- **Privacy.** The hidden request sends the same context to the same provider as the last real request. Nothing new leaves the machine.

## Providers

| provider | TTL | billing | keep-alive |
|---|---|---|---|
| `claude-bridge` | 300 s | token | on by default (built-in defaults; the preset carries the same values) |
| `github-copilot` | unknown | request | off (request-billed): policy off |
| others | no entry | n/a | none; silent (no trace) |

A provider with no entry and no `cache` config is not traced at all. Add `providers.<p>.cache` with `ttlSeconds` and `billing: "token"` to give another provider the same treatment.

## Trace events

`keepalive` (outcome, reason):

| outcome | reason | meaning |
|---|---|---|
| `fired` | none (`cacheRead`, `cacheWrite`, `cost`) | One Pi warm request, synced from the session entry. |
| `skipped` | `busy` | The session settled with a child, wait, queued message or run active; once per idle. |
| `skipped` | `disabled`, `billing_request`, `ttl_unknown`, `ttl_long` | The cache policy is off; once per reason. |
| `skipped` | `pi_mode_not_idle`, `no_prompt_cache` | A Pi prerequisite is missing; once per reason. |
| `window_end` | `window`, `activity`, `shutdown`, `compact`, `hook_stop`, `error` | The window ended for that reason. |
| `window_end` | `warmer_stopped` | The watchdog or the confirm deadline passed without a warm request. |
| `window_end` | `warm_compact_off`, `already_compacted`, `busy`, `cold`, `below_floor` | The warm-compaction check declined; the window continues. |

`compaction {reason: "warm_idle", point, model}`: a warm compaction was started. `compaction_point {model, point}`: the point Pi uses for the model (null when unknown or compaction is off), once at session start and on a model change.
