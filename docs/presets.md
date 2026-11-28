# Presets

> Opt-in config files under `config/presets/`, merged into your `<agent dir>/foreman.json` on request, never by default.
> Covers `apply-preset`, `--dry-run`, the rank-tier `inexpensive` preset and an overlay on top of it.
> Role and rank background is in [roles](roles.md); overlay layering in [overlays](overlays.md). Feature profiles (what is switched on, not which models) are in [install](install.md#profiles-features-and-add-ons).

## apply-preset

`foreman config …` here means `/foreman config …` in Pi (the form a package install has) or `bin/foreman config …` in a checkout. After a real apply, run `/foreman setup` to apply the models.

```
foreman config apply-preset <name> [--foreman <provider>/<model id>] [--dry-run]
```

The preset wins over equal keys in your file; the old file is backed up first (`foreman.json.bak-<date>`). The merged
result is validated against the schema and nothing is written when it fails. `--dry-run` writes nothing.
`--foreman` sets the foreman model of the preset's provider. Shipped presets: `claude-bridge`,
`claude-bridge-sonnet-reviewer`, `github-copilot`, `openai-codex`, `google`, `openai` (fixed model maps) and `inexpensive` (rank tiers, below).
The first three of these are the subscription presets below.

A fresh install has no rank rules, so a builder launch that names a model outside the builder's own models is refused until a preset sets `providers.<p>.ranks`; the session start says so. Apply a preset (`foreman config apply-preset`) to name explicit builder models.

`claude-bridge` and `claude-bridge-sonnet-reviewer` need an Opus or stronger foreman. Their explorer, builder and reviewer run on Sonnet, and a role's normal model must rank below the foreman's (the reviewer: at or below): under a Sonnet foreman the explorer and the builder are refused, under a Haiku foreman all three are. The refusal names the cause and `/foreman doctor` reports it as a `FAIL` line ([roles](roles.md#role-ladder-rank-policy-and-presets)).

`claude-bridge` and `claude-bridge-sonnet-reviewer` set `ladder.equalOnStrongRisk: true`: for coding the two lower models are mostly enough and the foreman's model is for work where security or safety is crucial, so only a builder launch whose risk tag calls for the strong rung runs on the foreman's own model, while a failed review, context and stuck stay on the lower rung ([roles](roles.md#role-ladder-rank-policy-and-presets)). Under an Opus foreman a builder launch without a risk tag at tier heavy skips its climb to the strong rung: the builder launches on its normal model and the launch result says so.

## Subscription presets

| preset | subscription | login | role map |
|---|---|---|---|
| `claude-bridge` | Claude Pro or Max | install `pi install npm:pi-claude-bridge@0.11.0` or later, then the Claude login in [install](install.md#claude-bridge-log-in-once) | foreman Opus 5.5; explorer, builder and reviewer Sonnet 5.5 with a strong Opus 5.5 rung |
| `github-copilot` | GitHub Copilot | `/login` in Pi, pick GitHub Copilot | foreman and session-foreman Claude Opus 5.5; reviewer GPT-6.1 Sol; builder and explorer GPT-6 Luna with a strong GPT-6.1 Terra rung |
| `openai-codex` | ChatGPT Plus or Pro | `/login` in Pi, pick the ChatGPT subscription entry of OpenAI | foreman GPT-6 Astra; reviewer GPT-6.1 Sol; builder and explorer GPT-6 Luna with a strong GPT-6.1 Terra rung |

`openai`, `google` and `inexpensive` use API keys and are pay per use.

`github-copilot` is applied the same way as the others, for example `foreman config apply-preset github-copilot`, then `/foreman setup`. `--foreman github-copilot/claude-sonnet-5.5` gives a cheaper foreman; it moves only the foreman role, so `session-foreman` stays Opus. The reviewer always differs from the foreman through `ceremony.reviewModel` pairs ([reviewer pairs](review.md#reviewer-pairs)): Opus foreman gets GPT-6.1 Sol, Sonnet foreman gets Opus 5.5. The high-stakes reviewer ([high stakes](review.md#high-stakes)) is Fable 5.2 at `high` for `github-copilot` and `claude-bridge`, and GPT-6.2 Astra at `high` for `openai-codex`. The explorer thinks at `low`.

The Copilot models have a context window of about 1M tokens. The `github-copilot` preset sets `compaction.maxTokens` to 200000 (the default too), so sessions compact at or below 200k tokens after `/foreman setup`. A preset cannot change a model's window; the compaction point is described in [install](install.md#what-setup-writes-for-compaction).

In every shipped preset GPT Sol runs only as the reviewer: never as foreman, session-foreman, builder or explorer, and not as a `strong` rung of those. So `openai` uses GPT-6.1 Terra as the strong rung of builder and explorer.

Ranks: `openai-codex` and `openai` rank astra 0, sol 2, terra 3, luna 4. `github-copilot` ranks the same GPT families and the Claude families (fable 0, opus 1, sonnet 2, haiku 3).

If your plan lacks a model, edit the ids in `foreman.json` after applying, or pass `--foreman`.

## claude-bridge cache values

`claude-bridge` and `claude-bridge-sonnet-reviewer` carry the values for a Claude subscription through the bridge:

| key | value | why |
|---|---|---|
| `providers.claude-bridge.cache.ttlSeconds` and `byModel` | none | The TTL is derived from `bridge.promptCacheTtl` (1 h for the foreman, 5 m for subagents; [cache](cache.md#children-through-the-bridge)). An explicit value here would shadow it. |
| `providers.claude-bridge.cache.keepalive.enabled` | `true` | The only switch: pi-foreman sends every idle warm itself ([cache](cache.md#keep-alive)); the owner's presence only lowers the budget tier ([presence gate](cache.md#presence-gate)). Older presets also wrote `awayTicks: 2`, which is ignored now. |
| `providers.claude-bridge.roles.foreman.idle` | Sonnet 5.5, thinking `medium` | The foreman's idle rung ([ladder](ladder.md#idle-rung-foreman-downshift)). |

Earlier versions of the `claude-bridge` presets wrote `ttlSeconds: 300` and a `claude-*` 3600 s `byModel` row. Applying a preset again does not remove them from your user config; delete both ([migration](cache.md#migration-from-the-old-preset)).
Pi needs the matching `promptCache` tier for the model (`long: 3600`, with `PI_CACHE_RETENTION=long`); `/foreman doctor`
warns when they differ. Pi's own warmer is always told `stop`, so its `cacheWarming` setting (including the `idle`
default of Pi 1.6.0) is not read and adds no warms.

## The inexpensive preset

`inexpensive` names roles by rank tier, never a model id, and resolves them at apply time from
`providers.<p>.ranks` of the active provider. Without ranks it stops with an error (nothing written). Tier numbers are
positions among the distinct tiers you ranked (0 = best), so gaps in your numbering are fine.

| role | tier |
|---|---|
| `foreman`, `session-foreman` | 1 (with `--foreman`: that model's own tier) |
| `reviewer` | same model as the foreman |
| `builder`, `explorer` | 2 (one below the foreman) |
| permission classifier (`providers.<p>.roles.review.model`) | the lowest tier |

A tier needs a model id: a `ranks` row with a literal `match` (no `*`/`?`) or a model already named in the provider's
`roles`/`review`. The active provider is the only one with ranks, or the provider in `--foreman`.

The tier template lives in the preset's `rankTiers` key (preset files only; `apply-preset` resolves it and never
writes it, the runtime does not read it).

Static keys: `childMaxThinking: medium`, `retro.enabled: false`, `ladder.rolePolicy` (reviewers `at-or-below`,
builders `below`), and `compaction.maxTokens` 100000 (the compaction cap `/foreman setup` turns into Pi's per-model compaction point;
see [cache](cache.md#where-compaction-fires)).

`--dry-run` prints the resolved role map and writes nothing:

```
$ foreman config apply-preset inexpensive --dry-run
foreman -> claude-bridge/claude-opus-5-5 (tier 1)
builder -> claude-bridge/claude-sonnet-5-5 (tier 2)
auto-review -> claude-bridge/claude-haiku-5-5 (tier 3)
```

## Overlay on top of inexpensive

Apply the preset, then let your overlay own what is specific to your provider, for example a multi-family provider
that is not built in (ranks with a literal row per model, and a cache row for its TTL). Its keep-alive stays off because
the provider is not built in; `keepalive.enabled: true` turns it on. A legacy per-request plan on a built-in provider
sets `keepalive.enabled: false`.

```json
{
  "providers": {
    "my-provider": {
      "cache": { "byModel": [{ "match": "gpt-*", "ttlSeconds": 600 }] },
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

## Recipe: two-provider idle rung

Run the foreman on one provider and let notice turns on a cold cache run on a cheaper model of another. Put this in
your user or overlay `foreman.json` (ids are placeholders):

```json
{
  "providers": {
    "<provider-a>": {
      "roles": { "foreman": { "idle": { "model": "<provider-b>/<cheaper-model>", "thinking": "low" } } }
    },
    "<provider-b>": {
      "cache": { "ttlSeconds": 1800, "keepalive": { "enabled": true, "selfWarmWindowMinutes": 240 } }
    }
  }
}
```

After the switch the idle model's provider supplies TTL and warms, so `<provider-b>` needs the `cache` entry
(a cache is warmed by pi-foreman itself, [cache](cache.md#keep-alive)), plus a
`promptCache` entry for the idle model in Pi's `models.json`. Child roles,
`foreman_session_open` and the rank checks keep using `<provider-a>`'s map ([ladder](ladder.md#idle-rung-foreman-downshift)).
`/foreman doctor` lists the rung with the other mapped models and warns when `<provider-b>` has no cache entry.

While the foreman is downshifted the different-model rule compares reviewers against the idle model (the live model),
so a reviewer on `<provider-b>` would be moved off it. Pair each foreman model with the reviewer you want in
`ceremony.reviewModel` ([review](review.md#reviewer-pairs)):

```json
{
  "ceremony": {
    "reviewModel": {
      "<provider-a>/<big-model>": "<provider-b>/<other-model>:high",
      "<provider-b>/<cheaper-model>": "<provider-a>/<big-model>"
    }
  }
}
```

The lookup uses the live model, so each side is reviewed by the other provider's model; an explicit launch model, a
security rung and a `reviewByOccasion` model are not replaced.
