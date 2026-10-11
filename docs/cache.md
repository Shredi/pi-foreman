# Idle prompt cache

> Covers the per-provider prompt-cache policy (`providers.<p>.cache`): TTL, billing, the keep-alive that stops an idle
> session resuming cold, and warm compaction. On token-billed providers with a short cache TTL (the `claude-bridge`
> preset: 300 s) an idle session otherwise pays for a cold prompt on resume. Layer rules are in [safety](safety.md).

## Config

Built-in values exist for `claude-bridge` (`ttlSeconds` 300, `billing` `token`) and `github-copilot` (`ttlSeconds` null, `billing` `request`). A key set in the config wins over the built-in value. `config/foreman.defaults.json` stays `providers: {}`; the built-in table lives in code. The `claude-bridge` preset carries the bridge values with `keepalive.enabled` set to true.

| key | default | meaning |
|---|---|---|
| `providers.<p>.cache.ttlSeconds` | 300 for `claude-bridge`, else null | Prompt-cache time to live in seconds (integer >= 1); null = unknown, the policy stays off. |
| `providers.<p>.cache.billing` | `token` for `claude-bridge`, `request` for `github-copilot` | `token` or `request`. A request-billed provider never gets a keep-alive. |
| `providers.<p>.cache.keepalive.enabled` | true iff `billing` is `token` and `ttlSeconds` < 3600 | Switches the keep-alive on or off. |
| `providers.<p>.cache.keepalive.intervalSeconds` | 90% of `ttlSeconds`, at least 30 | Seconds between pings (30..3600). |
| `providers.<p>.cache.keepalive.windowMinutes` | 45 | Minutes of idleness after which the pings stop (1..60); capped by Pi's own idle limit of 30 minutes. |
| `providers.<p>.cache.warmCompact` | true | Warm the cache after a compaction. |

## Layers

The user and overlay layers may set every cache key. The project and session layers can only tighten: `keepalive.enabled` accepts only `false`, and `keepalive.windowMinutes` only a lower value (minimum 1; with no earlier value, at most 45). `ttlSeconds`, `billing`, `keepalive.intervalSeconds` and `warmCompact` are ignored there. An ignored or loosening value is dropped with a warning, and a `cache` or `keepalive` value that is not an object is dropped with an "expected an object" warning.

## Keep-alive

Filled in by the runtime documentation of this round.

## Warm compaction

Filled in by the runtime documentation of this round.

## Cost and privacy

Filled in by the runtime documentation of this round.

## Providers

Filled in by the runtime documentation of this round.
