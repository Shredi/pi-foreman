# Overlays

> Covers private and organisation overlays, how to install one, the one-way rule and the extension points.
> Read it when you add your own model map, roles or tools, or ship pi-foreman to a team.
> Overlays consume a released version, pinned exactly; nothing flows back into this repo.

## Three layers

1. This generic harness (public): Pi extensions, `agents/`, the Python core and the installer.
2. A user's private overlay: model map, extra agents, repository list, personal preferences. A Pi package plus `foreman.json` in the Pi agent dir.
3. An organisation-owned overlay: provider gateways, internal tools and skills, default policy for its users. A Pi package that declares `pi.foreman.config` in its `package.json`.

Overlays live outside this repo and only consume released versions of it, pinned to an exact `pi-foreman@x.y.z`.

## Install

```sh
foreman setup --overlay npm:<pkg>@<exact-version>
```

Ranges are refused (from a checkout, `node setup.mjs --overlay ...` is the same command). The installer never edits overlay files and refuses to merge overlay keys into pi-foreman's own files.

## One-way flow

Overlays never patch the harness, and nothing from an overlay is ever copied back here. Changes to the harness
come as public issues or PRs written from scratch. Config merges in the order package defaults -> organisation
overlay -> user -> project -> session (see [install](install.md)); there are no organisation safety bounds, and
only a repository's project file is held to tighten-only.

## Handshake

The core adapter sets `globalThis[Symbol.for("pi-foreman.core.v1")] = { version, pkgRoot, api: 1 }` (`version` from
`package.json`) and emits `foreman:ready` with the same payload on `pi.events` at `session_start`. An overlay checks at
its own `session_start`, not in its factory (load order between packages is not guaranteed). If the key is missing it
posts one notify and returns without throwing:

```ts
pi.on("session_start", (_e, ctx) => {
  const core = (globalThis as any)[Symbol.for("pi-foreman.core.v1")];
  if (!core) {
    ctx.ui.notify("pi-foreman core adapter not loaded; install it with pi install git:github.com/Shredi/pi-foreman", "warning");
    return;
  }
  // core.api === 1; core.version and core.pkgRoot are available
});
```

## Tool or skill

Build a tool when the model needs structured, guarded, frequent calls, or when the overlay must inject policy
(auth, output caps). Build a skill when it is knowledge plus a CLI that already exists. The generic harness ships
at most one optional tool pack, git (`tools.git`, see [tools](tools.md)). Employer-specific tools (CI, artifact
stores, ticket or wiki systems) never go into the harness: they live in the work overlay, which lists pi-foreman
as a prerequisite.

Example work overlay, placeholders only:

- `<ci-system>` status is a tool: frequent, needs auth, and its output must be capped before it reaches the model.
- `<wiki>` lookup is a skill: it explains how to use the wiki's existing CLI.

The overlay's prerequisite check is the existing [Handshake](#handshake): `globalThis[Symbol.for("pi-foreman.core.v1")]`
and `foreman:ready`. There is no second handshake.

## Extension points

| Point | How an overlay contributes |
|---|---|
| Roles | Role files in its package via `pi.subagents.agents`, listed in `roles.<id>.file`; `promptAppend` adds text to an existing role. Ids stay neutral. |
| Providers and models | A `providers.<p>` block; the provider itself as a Pi extension (`registerProvider`); [presets](presets.md) resolve role models from its `ranks`; `providers.<p>.models` gives context windows and price tiers for models Pi's registry lacks (see [Models Pi does not list](#models-pi-does-not-list)) |
| Display names | `displayNames` preset or per-id map |
| Skills | `skills/` in the overlay package (Pi skills format) |
| Permission rules | `safety.permissions` entries (see [safety](safety.md)) |
| Reviewer rules | `safety.permissions.autoReview.rulesFile` replaces the shipped reviewer rules (see [Reviewer rules file](#reviewer-rules-file)) |
| Guards and child extensions | `safety.requiredChildExtensions` |
| MCP servers | Pi `mcp.json` or `registerMcpServer` from the overlay extension |
| Events | `foreman:ready` on `pi.events` (see Handshake); no other `foreman:*` events are emitted |
| Retro backlog | `retro.backlogDir` points the central backlog elsewhere; `retro.repoBacklog` and `retro.workspaceKey` pick per-workspace stores and keys (see [retro](retro.md)). User or overlay config only. |
| Sidebar status | `sidebar.statusCommand` and `sidebar.statusSeconds` show a program's items as extra dots on the Herdr sidebar (see [External sidebar status](#external-sidebar-status)). User or overlay config only. |
| Ceremony, fan-out, fallback | `ceremony.*`, `fanout.max`, `providers.<p>.fallback` |
| Host pressure limits | `resources.*` (see [resources](resources.md)); a project file may only tighten them |

### Models Pi does not list

`foreman setup` derives each model's compaction point from Pi's model registry. A model the registry lacks (a bridge
provider, for example) gets no point unless an overlay declares it. The key is the model id without the provider prefix:

```json
{
  "providers": {
    "<provider>": {
      "models": {
        "<model-id>": { "contextWindow": 200000, "tiers": [{ "inputTokensAbove": 128000 }] }
      }
    }
  }
}
```

`providers.<p>.models.<id>.contextWindow` is required; `providers.<p>.models.<id>.tiers` is optional, and setup keeps the point 20000 tokens below the lowest `inputTokensAbove`. Numbers come from the
provider's published limits: setup does not guess them. See [install](install.md#what-setup-writes-for-compaction).

### Reviewer rules file

The foreman's own overlay asks (a project or session ask rule, a toolchain probe line, an unclear drive path) go to the
review model before the human dialog (`safety.permissions.autoReview.enabled`, default on). The model judges them by the
prose rules in `config/permissions.rules.md`: the tiers `hard_deny`, `soft_deny` and `allow` and an environment paragraph
that names what the session owns. `safety.permissions.autoReview.rulesFile` (absolute, `~/...` or relative to the agent
dir) replaces that file whole; there is no append. It is read from the user, organisation and default layers only: a
project or session value is ignored with a warning. The replacing file is write-protected like `protect.ask`, the shipped
one is under `protect.writeAskSelfHost`. Keep it short: system prompt, rules and request together stay within 4000
characters, and a request that does not fit goes to the human. Deny decisions and asks that touch protected configuration
never reach the model.

### Own host CLI

To use a PR host other than gh or glab, set `tools.prHost` to a templates object in the overlay config (see
[tools](tools.md#host-templates)). Point the templates at a wrapper script that prints the documented JSON, and keep
that script outside the workspace. Project configs cannot change `tools.prHost`.

Conflict rules and rationale: `design/architecture.md`
[section 2](../design/architecture.md#2-layers-and-the-overlay-contract).

### External sidebar status

An overlay can feed the Herdr sidebar's dots row from a program it ships. Set `sidebar.statusCommand` (and optionally
`sidebar.statusSeconds`, default 60) in the overlay config; a project or session value is ignored. The program must be on
`PATH` or an absolute path, outside the workspace, and print a JSON array on stdout:

```json
{ "sidebar": { "statusCommand": "example-status --short", "statusSeconds": 120 } }
```

```json
[{"label": "build", "state": "ok"}, {"label": "deploy", "state": "run"}]
```

`state` is `fail`, `run`, `ok` or `none` (anything else is `none`), the label is cut to 20 characters, at most 8 items are
kept. The items are display data only; they never reach the model. Run, limits, trace and doctor line:
[herdr](herdr.md#external-status).

### Session model example

Sessions opened by `foreman session open` run on the `session-foreman` role's model. An overlay for a request-billed provider such as `github-copilot` keeps child sessions on the foreman's own model by mapping both roles to it:

```json
{ "providers": { "github-copilot": { "roles": {
  "foreman": { "model": "github-copilot/<foreman model id>", "thinking": "high" },
  "session-foreman": { "model": "github-copilot/<foreman model id>", "thinking": "high" }
} } } }
```

`paths.hubWorkflow` names the hub ROOT (the dir that contains `.workflow/`), never the `.workflow` dir itself: the renderer appends `.workflow`, `/foreman doctor` warns and `foreman setup` refuses a value ending in `.workflow`.
