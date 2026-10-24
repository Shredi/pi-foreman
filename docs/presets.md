# Presets

> Opt-in config files under `config/presets/`, merged into your `<agent dir>/foreman.json` on request, never by default.
> Covers `apply-preset`, `--dry-run`, the rank-tier `inexpensive` preset and an overlay on top of it.
> Role and rank background is in [roles](roles.md); overlay layering in [overlays](overlays.md).

## apply-preset

```
foreman config apply-preset <name> [--foreman <provider>/<model id>] [--dry-run]
```

The preset wins over equal keys in your file; the old file is backed up first (`foreman.json.bak-<date>`). The merged
result is validated against the schema and nothing is written when it fails. `--dry-run` writes nothing.
`--foreman` sets the foreman model of the preset's provider. Shipped presets: `claude-bridge`,
`claude-bridge-sonnet-reviewer`, `google`, `openai` (fixed model maps) and `inexpensive` (rank tiers, below).

## claude-bridge cache values

`claude-bridge` and `claude-bridge-sonnet-reviewer` carry the values for a Claude subscription through the bridge:

| key | value | why |
|---|---|---|
| `providers.claude-bridge.cache.byModel` row `claude-*` | `ttlSeconds: 3600`, note "subscription within plan usage; 300 on extra-usage credits or API key" | Claude Code gives a subscription turn within plan usage the 1-hour cache; on extra-usage credits or an API key it is 5 minutes (set 300 then). |
| `providers.claude-bridge.cache.keepalive.enabled` | `true` | pi-foreman sends the warms beyond Pi's 30-minute cap itself ([cache](cache.md#self-warm-beyond-pis-cap)). |
| `providers.claude-bridge.cache.keepalive.awayTicks` | `2` | While the owner is away at most two warms per idle ([presence gate](cache.md#presence-gate)). |
| `providers.claude-bridge.roles.foreman.idle` | Sonnet 5.5, thinking `medium` | The foreman's idle rung ([ladder](ladder.md#idle-rung-foreman-downshift)). |

The `claude-bridge` preset used to carry a 600 s row and switch the keep-alive off; apply it again to pick up the new
values. Pi needs the matching `promptCache` tier for the model (`long: 3600`, with `PI_CACHE_RETENTION=long`) and
`cacheWarming: "idle"`; `foreman doctor` warns when they differ.

## The inexpensive preset

`inexpensive` names roles by rank tier, never a model id, and resolves them at apply time from
`providers.<p>.ranks` of the active provider. Without ranks it stops with an error (nothing written). Tier numbers are
positions among the distinct tiers you ranked (0 = best), so gaps in your numbering are fine.

| role | tier |
|---|---|
| `foreman`, `session-foreman` | 1 (with `--foreman`: that model's own tier) |
| `reviewer`, `senior-reviewer` | same model as the foreman |
| `planner` | none: `ceremony.planner: self`, the foreman writes the plan; plan review for heavy stays on |
| `builder`, `explorer`, `finalizer` | 2 (one below the foreman) |
| permission auto-review (`providers.<p>.review.model`) | the lowest tier |

A tier needs a model id: a `ranks` row with a literal `match` (no `*`/`?`) or a model already named in the provider's
`roles`/`review`. The active provider is the only one with ranks, or the provider in `--foreman`.

The tier template lives in the preset's `rankTiers` key (preset files only; `apply-preset` resolves it and never
writes it, the runtime does not read it).

Static keys: `childMaxThinking: medium`, `retro.enabled: false`, `ladder.rolePolicy` (reviewers `at-or-below`,
builders `below`), and `compaction.maxTokens` 100000 (the compaction cap `foreman setup` turns into Pi's per-model compaction point;
see [cache](cache.md#where-compaction-fires)).

`--dry-run` prints the resolved role map and writes nothing:

```
$ foreman config apply-preset inexpensive --dry-run
foreman -> claude-bridge/claude-opus-5-5 (tier 1)
builder -> claude-bridge/claude-sonnet-5-5 (tier 2)
auto-review -> claude-bridge/claude-haiku-5-5 (tier 3)
```

## Overlay on top of inexpensive

Apply the preset, then let your overlay own what is specific to your provider, for example a request-billed,
multi-family provider (ranks with a literal row per model, and a cache row so the keep-alive stays off):

```json
{
  "providers": {
    "my-provider": {
      "cache": { "billing": "request", "byModel": [{ "match": "gpt-*", "ttlSeconds": 600 }] },
      "ranks": [
        { "match": "claude-opus-5-5", "tier": 0 },
        { "match": "gpt-6-astra", "tier": 0 },
        { "match": "claude-sonnet-5-5", "tier": 1 },
        { "match": "gpt-6.1-sol", "tier": 1 },
        { "match": "claude-haiku-5-5", "tier": 2 }
      ]
    }
  }
}
```

Put the overlay's `ranks` in `foreman.json` first, then run `apply-preset inexpensive`; later edits to the roles stay
yours. Cache rows are in [cache](cache.md).
