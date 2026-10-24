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
