# Install and configure

> Covers installing pi-foreman as a Pi package, `foreman setup`, what setup writes, the `foreman.json` provider map, config layers, updating and removing, developing from a checkout, Windows notes and the Claude bridge login.
> Read it when you set up pi-foreman, change models, or after pulling a pin change.
> Run `foreman setup --dry-run` first; a second run changes nothing and says "up to date". `foreman setup` here means `/foreman setup` in Pi, or `bin/foreman setup` in a checkout.

## Install

Setting up with an agent: point it at [features.md](features.md).

Needs Node 22+, Pi 1.1.x on `PATH` and Python 3.9+. pi-foreman is a [Pi package](https://pi.dev/docs/latest/packages):

```sh
pi install git:github.com/Shredi/pi-foreman            # global; pin with @<tag-or-commit>
pi install -l git:github.com/Shredi/pi-foreman         # project scope (.pi/settings.json)
```

`npm:pi-foreman` is planned once v0.1.0 is published. Pi clones the repository to
`<agentDir>/git/github.com/Shredi/pi-foreman` (`<agentDir>` is `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) and runs
`npm install --omit=dev --legacy-peer-deps` there. That brings the bundled `pi-subagents`, `pi-permission-system` and
`pi-intercom`, pinned in `package.json` and `package-lock.json` and loaded through `node_modules` resource paths (the
meta-package pattern Pi's docs prescribe). The manifest is the `pi` key of `package.json`: Pi reads `extensions`,
`skills`, `prompts` and `themes`; `pi.subagents.agents` (the `agents/` folder) is read by pi-subagents. Pi runs lifecycle scripts; pi-foreman has none on purpose. Project packages
load only after the project is trusted; headless runs need `pi --approve` (`-a`).

Then run setup once:

```sh
/foreman setup --dry-run   # inside Pi: show the planned changes, write nothing
/foreman setup             # inside Pi: apply
bin/foreman setup          # from a checkout (or: node setup.mjs)
```

Upgrading from a setup that installed `pi-subagents`, `pi-permission-system` or `pi-intercom` as top-level `npm:`
packages: Pi stops at start with a tool conflict until setup has removed them, so `/foreman setup` cannot run yet. Run
setup from the clone once: `node <agentDir>/git/github.com/Shredi/pi-foreman/setup.mjs`.

Flags: `--dry-run`, `--project` (project-local settings), `--overlay npm:<pkg>@<exact-version>` (organisation overlay;
ranges are refused, see [overlays](overlays.md)), `--no-intercom` (see below), `--develop` (see
[Developing](#developing)), `--remove`, `--agent-dir <dir>` (overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`).
If pi-foreman is not installed as a Pi package, setup stops and prints the `pi install` line above.

## What setup writes

Setup does not install pi-foreman or the bundled packages: the package brings them. It migrates a setup from before
the package install: leftover top-level `npm:` entries of the bundled packages in `settings.json` are removed with
`pi remove`, because a second copy registers the same tools and Pi stops with a fatal tool conflict. It writes the
config of `pi-permission-system`, generated from the permission baseline and your `safety.permissions` (see
[safety](safety.md)), and the generated `subagents` block into `settings.json` (backup
`settings.json.bak-<timestamp>` first), and creates `<agent dir>/foreman.json` only if absent. Unless
`--no-intercom`, it writes `<agent dir>/intercom/config.json`
(`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if absent; an existing file that sets
`brokerCommand`, `brokerArgs` or `crossMachine` gets a warning. `--no-intercom` is a package filter: it adds
`!node_modules/pi-intercom/**` to the pi-foreman package entry and writes no intercom config (delete those filter
lines from `settings.json` to undo). When the Claude bridge is in use, setup prints a login hint (see
[below](#claude-bridge-log-in-once)). Map each provider you use to models in `foreman.json`:

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

Or apply a shipped preset: `foreman config apply-preset <name> [--foreman <model id>] [--dry-run]` merges
`config/presets/<name>.json` into that file (preset values win, every other key is kept), validates the result
before writing, backs the old file up as `foreman.json.bak-YYYYMMDD` (`-HHMMSS` appended when that name exists)
and prints the merged JSON with `--dry-run` instead of writing. `--foreman` sets the foreman's model for the
preset's providers. An unknown name lists the presets and exits 2. `foreman config validate` checks the result.

While no `providers.<p>.roles.<id>.model` and no `providers.<p>.review.model` is set, children run on Pi's
default model, and each interactive top-level session start shows one notice naming the presets and this
command. It never appears in rpc, print or child sessions. The top-level key `quiet` (boolean, default `false`)
set to `true` hides it.

Then re-run `foreman setup` to regenerate the block, and run `/foreman doctor` in Pi. Tests:
`node --test "tests/installer/*.test.mjs"`.

Roles, ladders and the opt-in presets for the model map are in [roles](roles.md).

## Config layers

Config merges plain last-wins in the order: package defaults (`config/foreman.defaults.json`) -> organisation
overlay (`pi.foreman.config` of the overlay package) -> your user file (`<agent dir>/foreman.json`, honours
`PI_CODING_AGENT_DIR`) -> the repository's `.pi/foreman.json` (read only after Pi project trust is resolved) ->
session (launch flags, or `foreman config ... --session-json '<json>'`; not persisted). Maps deep-merge, leaves are last-wins.

**Tighten-only rule.** A project file (and the session) may only make `safety.*` and several ceremony keys
stricter: permissive booleans can only become stricter, lists can only gain entries, nothing is removed. A cloned
repository therefore cannot loosen your guards. Each key's direction is listed in the tables in
[ceremony](ceremony.md) and [safety](safety.md). A JSON Schema ships as `config/foreman.schema.json`; unknown keys
warn, an invalid safety key fails closed to the package values. Rationale: `design/architecture.md`
[section 3](../design/architecture.md#3-config-schema).

## Updating and removing

```sh
pi update git:github.com/Shredi/pi-foreman    # or: pi update --extensions
foreman setup                                 # regenerate the managed block after an update
```

Pi runs `git clean -fdx` in the clone on update, so never edit files under `<agentDir>/git/...`; edit a checkout
(see [Developing](#developing)). To remove: `foreman setup --remove` (or `/foreman setup --remove`) drops the managed
`settings.json` keys and the permission config it wrote, then `pi remove git:github.com/Shredi/pi-foreman` (add `-l`
for project scope; use the same source string, `@<ref>` included, that `pi list` shows) removes the package.
`foreman.json`, `pi-foreman/managed.json`, the `.bak-<ts>` backups, the intercom config and any overlay stay. The
repository's `.npmrc` sets `legacy-peer-deps`, so a checkout's `npm install` resolves `package-lock.json` the same way
Pi's install does and leaves it unchanged.

### Updating Pi

The pinned Pi version lives in `packages.lock.json` (currently 1.1.0, range 1.1.x); `setup.mjs` refuses a Pi
outside the range. After a pin change, update the global Pi and re-run setup:

```sh
npm i -g @earendil-works/pi-coding-agent@1.1.0
foreman setup --dry-run && foreman setup
```

If you use the Claude bridge, also install pi-claude-bridge 0.9.2 or later (`pi install npm:pi-claude-bridge@0.9.2`):
earlier versions drop Pi's custom prompt sections, which carry the foreman's rules.

## Developing

To work on pi-foreman itself, run it from a checkout instead of the installed copy:

```sh
git clone https://github.com/Shredi/pi-foreman.git && cd pi-foreman
npm ci
bin/foreman setup --develop
```

After pulling a checkout that changed `package.json`, run `npm ci` again (setup keeps top-level bundled copies when a
manifest entry is missing and prints the same hint; `/foreman doctor` FAILs on a missing bundled entry).

`--develop` writes `.pi/settings.json` inside the checkout with `".."` as a package plus an empty-filter override of
the installed pi-foreman source. Project packages load before global ones and only after project trust (`pi -a` when
headless). Double-load rule: the checkout wins in its own tree. Without the override Pi exits with a tool conflict
("Tool ... conflicts with ..."), because two copies register the same tools. The core adapter also carries a
once-guard: a second core copy registers nothing and posts one notice naming both roots. The self-host protect
narrows only when the checkout copy is the active one (see [permissions](permissions.md)). Tests and the replay rig:
[development](development.md).

## Windows

`pi` is a `.cmd` shim there and Node cannot spawn `.cmd` directly, so setup reads the shim and runs Pi's JS entry with
Node. Python is found as `py -3`, then `python`; the Microsoft Store alias stub is rejected. If none works, install
Python 3.9+ from python.org (or `winget install Python.Python.3.12`) with the py launcher.

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
  provider, and reports permission-config drift and the bridge folder state. Its last lines include
  `INFO dormant: <ids>`, the features whose switch is off in the merged config (see [features](features.md)).
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.
  Outside Pi: `bin/foreman update-check` (see [sessions](sessions.md)).
