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
| Providers and models | A `providers.<p>` block; the provider itself as a Pi extension (`registerProvider`) |
| Display names | `displayNames` preset or per-id map |
| Skills | `skills/` in the overlay package (Pi skills format) |
| Permission rules | `safety.permissions` entries (see [safety](safety.md)) |
| Guards and child extensions | `safety.requiredChildExtensions` |
| MCP servers | Pi `mcp.json` or `registerMcpServer` from the overlay extension |
| Events | `foreman:ready` on `pi.events` (see Handshake); no other `foreman:*` events are emitted |
| Retro backlog | `retro.backlogDir` points the central backlog elsewhere; `retro.repoBacklog` and `retro.workspaceKey` pick per-workspace stores and keys (see [retro](retro.md)). User or overlay config only. |
| Ceremony, fan-out, fallback | `ceremony.*`, `fanout.max`, `providers.<p>.fallback` |

Conflict rules and rationale: `design/architecture.md`
[section 2](../design/architecture.md#2-layers-and-the-overlay-contract).
