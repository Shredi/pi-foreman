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
node setup.mjs --overlay npm:<pkg>@<exact-version>
```

Ranges are refused. The installer never edits overlay files and refuses to merge overlay keys into pi-foreman's own files.

## One-way flow

Overlays never patch the harness, and nothing from an overlay is ever copied back here. Changes to the harness
come as public issues or PRs written from scratch. Config merges in the order package defaults -> organisation
overlay -> user -> project -> session (see [install](install.md)); there are no organisation safety bounds, and
only a repository's project file is held to tighten-only.

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
| Events | Listen on `pi.events` `foreman:*` (`role_launch`, `role_result`, `ledger_phase`, `ceremony_tier`, `retro`); read-only notifications |
| Ceremony, fan-out, fallback | `ceremony.*`, `fanout.max`, `providers.<p>.fallback` |

Conflict rules and rationale: `design/architecture.md`
[section 2](../design/architecture.md#2-layers-and-the-overlay-contract).
