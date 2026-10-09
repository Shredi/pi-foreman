# Install and configure

> Covers the installer flags, what `setup.mjs` writes, the `foreman.json` provider map, config layers, updating Pi and the Claude bridge login.
> Read it when you set up pi-foreman, change models, or after pulling a pin change.
> Run `node setup.mjs --dry-run` first; a second run changes nothing and says "up to date".

## Install

Needs Node 22+, Pi 1.1.x on `PATH` and Python 3.9+. From a checkout of this repo:

```sh
node setup.mjs --dry-run   # show the planned diff and `pi install` commands, write nothing
node setup.mjs             # install into the user-level Pi agent dir
node setup.mjs --project   # install project-locally (.pi/settings.json)
node setup.mjs --remove    # remove only what the installer manages
```

Options: `--overlay npm:<pkg>@<exact-version>` installs an organisation overlay (ranges are refused; see
[overlays](overlays.md)), `--agent-dir <dir>` overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`, `--no-intercom`
skips `pi-intercom` (installed by default, see below). Project packages load only after
the project is trusted; headless runs need `pi --approve`. A second run changes nothing and says "up to date".

## What setup writes

The installer installs `pi-subagents` (pinned in `packages.lock.json`) and registers this checkout with
`pi install <path>`. It also installs the pinned permission package (`@gotgenes/pi-permission-system`) and writes
its config, generated from the permission baseline and your `safety.permissions` (see [safety](safety.md)). It writes the generated
`subagents` block into `settings.json` (backup `settings.json.bak-<timestamp>` first) and creates
`<agent dir>/foreman.json` only if absent. Unless `--no-intercom`, it installs `pi-intercom` (pinned) and
writes `<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if
absent; an existing file that sets `brokerCommand`, `brokerArgs` or `crossMachine` gets a warning. Map each provider you use to models there:

```json
{
  "version": 1,
  "providers": {
    "my-provider": {
      "roles": {
        "foreman": { "model": "my-provider/big-model", "thinking": "high" },
        "builder": { "model": "my-provider/mid-model", "thinking": "medium" }
      }
    }
  }
}
```

Then re-run `node setup.mjs` to regenerate the block, and run `/foreman doctor` in Pi. Tests:
`node --test "tests/installer/*.test.mjs"`.

Roles, ladders and the opt-in presets for the model map are in [roles](roles.md).

## Config layers

Config merges plain last-wins in the order: package defaults (`config/foreman.defaults.json`) -> organisation
overlay (`pi.foreman.config` of the overlay package) -> your user file (`<agent dir>/foreman.json`, honours
`PI_CODING_AGENT_DIR`) -> the repository's `.pi/foreman.json` (read only after Pi project trust is resolved) ->
session (`/foreman set`, launch flags; not persisted). Maps deep-merge, leaves are last-wins.

**Tighten-only rule.** A project file (and the session) may only make `safety.*` and several ceremony keys
stricter: permissive booleans can only become stricter, lists can only gain entries, nothing is removed. A cloned
repository therefore cannot loosen your guards. Each key's direction is listed in the tables in
[ceremony](ceremony.md) and [safety](safety.md). A JSON Schema ships as `config/foreman.schema.json`; unknown keys
warn, an invalid safety key fails closed to the package values. Rationale: `design/architecture.md`
[section 3](../design/architecture.md#3-config-schema).

## Updating Pi

The pinned Pi version lives in `packages.lock.json` (currently 1.1.0, range 1.1.x); `setup.mjs` refuses a Pi
outside the range. After pulling a pin change, update the global Pi and re-run the installer:

```sh
npm i -g @earendil-works/pi-coding-agent@1.1.0
node setup.mjs --dry-run && node setup.mjs
```

If you use the Claude bridge, also install pi-claude-bridge 0.9.2 or later (`pi install npm:pi-claude-bridge@0.9.2`):
earlier versions drop Pi's custom prompt sections, which carry the foreman's rules.

## Claude bridge: log in once

When the active provider is `claude-bridge`, pi-foreman points `CLAUDE_CONFIG_DIR` at an empty folder,
`<agent dir>/pi-foreman/claude-config/`, so the host's Claude Code settings, hooks, plugins and
`CLAUDE.md` do not load into every bridge turn (config key `bridge.isolateClaudeConfig`: `"auto"` by
default, `true`, or `false`; a project file cannot set it). The folder starts without a login, and the
installer does not log in. Do one of these once:

```sh
CLAUDE_CONFIG_DIR=<agent dir>/pi-foreman/claude-config claude    # then /login
claude setup-token                                                 # then export CLAUDE_CODE_OAUTH_TOKEN
```

`/foreman doctor` fails if the folder holds host config and reports whether a login is present
(never its value).

## Checks inside Pi

- `/foreman doctor` checks Python, that the generated block is in sync, required child extensions and auth per
  provider, and reports permission-config drift and the bridge folder state.
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.
  Outside Pi: `bin/foreman update-check` (see [sessions](sessions.md)).
