# Install and configure

> Covers installing pi-foreman as a Pi package, `foreman setup`, what setup writes, the `foreman.json` provider map, config layers, updating and removing, developing from a checkout, Windows notes and the Claude bridge login.
> Read it when you set up pi-foreman, change models, or after pulling a pin change.
> Run `foreman setup --dry-run` first; a second run changes nothing and says "up to date". `foreman setup` here means `/foreman setup` in Pi, or `bin/foreman setup` in a checkout.

## Install

Setting up with an agent: point it at [features.md](features.md).

Needs Node 22.19+, Pi 1.4.x on `PATH` and Python 3.13+. pi-foreman is a [Pi package](https://pi.dev/docs/latest/packages):

```sh
pi install git:github.com/Shredi/pi-foreman            # global; pin with @<tag-or-commit>
pi install -l git:github.com/Shredi/pi-foreman         # project scope (.pi/settings.json)
```

`npm:pi-foreman` is planned once v0.1.0 is published. Pi clones the repository to
`<agentDir>/git/github.com/Shredi/pi-foreman` (`<agentDir>` is `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) and runs
`npm install --omit=dev --legacy-peer-deps` there. That brings the bundled `pi-subagents` and
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

Upgrading from a setup that installed `pi-subagents` or `pi-intercom` as top-level `npm:`
packages: Pi stops at start with a tool conflict until setup has removed them, so `/foreman setup` cannot run yet. Run
setup from the clone once: `node <agentDir>/git/github.com/Shredi/pi-foreman/setup.mjs`.

Flags: `--dry-run`, `--project` (project-local settings), `--overlay npm:<pkg>@<exact-version>` (organisation overlay;
ranges are refused, see [overlays](overlays.md)), `--no-intercom` (see below), `--develop` (see
[Developing](#developing)), `--remove`, `--agent-dir <dir>` (overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`),
`--profile <name>`, `--enable <id>[,<id>]`, `--disable <id>[,<id>]`, `--addon <id>` and `--pick` (see
[Profiles, features and add-ons](#profiles-features-and-add-ons)).
If pi-foreman is not installed as a Pi package, setup stops and prints the `pi install` line above.

## Profiles, features and add-ons

Setup has a feature axis next to the model-map presets ([presets](presets.md)): three shipped **profiles**, per-feature
**toggles** declared in `config/features.json` (see [features](features.md)) and consent-only **add-ons** from
`config/addons.json`. The choice is written into the user `foreman.json` (`profile` plus the toggle leaves) and shown by
`/foreman doctor`.

### Flags

- `--profile <name>`: apply `orchestration`, `standard` or `full`. Applying a profile assigns every toggleable feature: the
  ones it names as given, every other one to its shipped state. So `full` followed by `standard` turns the relaxations back off.
- `--enable <id>[,<id>]` and `--disable <id>[,<id>]`: switch toggleable features after the profile; both are repeatable.
  On Windows repeat the flag instead of using a comma list, because `cmd` splits arguments on commas.
- `--addon <id>`: install an add-on (repeatable). This flag is the consent; nothing is installed without it or a picker "yes".
- `--pick`: open the picker again.
- `--preview [screen]`: draw one setup screen (`home`, `plan`, `updates`, `config`, `models`, `workfolders`, `apply`; default `home`) from built-in sample data. On a terminal it opens the full-screen view (`1`-`7` or Tab switch screens, arrows move, `q` quits; the footer shows other keys, but they are inactive); without a terminal it prints one 100x30 frame. It reads and writes nothing of yours, exits 2 for an unknown screen, and cannot be combined with any other flag. Needs Node 22.19+.

Setup exits 2 and prints the valid ids or the rule for: an unknown profile, feature or add-on id; a feature that is not
toggleable (the message names the doc link and the enable snippet); the same id in `--enable` and `--disable`; `--remove`
combined with any of `--profile/--enable/--disable/--addon/--pick`; and `--pick` when a picker precondition fails. `--pick`
needs every picker precondition below except "no profile recorded"; the message names the one that failed.

### The picker

The picker is an arrow-key menu (select, checkbox and confirm prompts from `@inquirer/prompts`, a runtime dependency pinned in
`package.json`). `setup.mjs` loads it with a dynamic `import()` only when the picker opens, so flag-driven and non-interactive
runs need no `node_modules`. Without a real terminal, `PI_FOREMAN_PICKER=force` uses a plain numbered readline menu
(`node:readline`) that asks the same questions and prints the same summary; so does a run where the import fails, after one
note line telling you to run `npm ci` (checkout) or reinstall the package. It opens only when stdin and stdout are terminals, `CI` is unset,
none of `--profile/--enable/--disable/--addon` is given, and either no profile is recorded yet or `--pick` is given.
`PI_FOREMAN_PICKER=force` overrides the terminal and `CI` tests and `PI_FOREMAN_PICKER=off` disables the picker; both are a
test and automation aid. `/foreman setup` inside Pi runs setup with piped output and sets `PI_FOREMAN_PICKER=off` for it, so
it stays flag-driven. A run that never prompts and has no recorded profile prints one hint naming `--pick` and `--profile`.

Steps: (1) pick a profile, with its summary and off-list; the recorded or `standard` one is preselected and Enter keeps it;
(2) "Adjust features?" (default no): per area, one checkbox list each (space flips; the readline menu flips by number), safety relaxations in a last group with a warning;
(3) add-ons not yet installed: purpose, exact spec, clash notes, `y/N` (default no); (4) summary with the `foreman.json` diff,
the planned `pi install` lines and the equivalent flag line, then `y/N`. Ctrl-C, end of input or "no" prints "nothing
written" and exits 0.

### Write order

The `foreman.json` step runs before `generate-subagents` and the permission render, so a real run produces generated files
that reflect the new config. On `--dry-run` nothing is written, so those diffs reflect the file on disk, one run behind the
shown `foreman.json` diff. Steps: create the template if the file is absent, plan the changes, show the diff, validate the
candidate. Validation blocks only on an error the current file does not already have (error strings compare exactly);
safety-path findings are warnings and never block. A new error prints, nothing is written, setup exits 1. Otherwise setup
backs up `foreman.json.bak-<timestamp>` (the `YYYYMMDD-HHMMSSmmm` form of setup; `apply-preset` uses a date form), writes a
file beside it and renames. Profile and toggle leaves win over hand-set values; no user key is removed; a re-run with
nothing to change says "up to date".

Risks: `foreman.json` is written before the add-on installs and the settings write. If a later step fails, the new profile
stays and the backup exists. The recorded profile is the merged user-plus-overlay value; a project or session `profile` is dropped
with a warning. A recorded name that no longer exists warns, skips the picker and names `--profile` as the fix.

### The profiles

| Profile | Off | On |
|---|---|---|
| `orchestration` | `pr-ops`, `herdr`, `footer-ui`, `idle-cache`, `idle-downshift`, `retro`, `trace` | the rest in their shipped state |
| `standard` | none | every toggleable feature in its shipped state (the package defaults) |
| `full` | none | every toggleable feature, safety relaxations included |

`full` prints `WARN safety relaxations on: <ids>`. The relaxations are `git-tools`, `children-may-push`, `workflow-scripts`
and `remote-intercom`: the project layer may not switch them on. Safety rules (permissions, git, ops, ceremony gates, bridge) are never
toggleable. `idle-cache` has no fixed default (cache policy decides per provider): its shipped state is declared `on`, and
explicit `true` matches the policy except for a provider with a TTL but no billing set, where it turns pings on. `features list`
and the doctor show `on` for request-billed providers that skip keepalive anyway.

### Add-ons

`config/addons.json` lists exact-pinned optional Pi packages. Setup installs one only on consent: `pi install
npm:<package>@<version>` (`-l` with `--project`), and records it under `managed.addons`. If the package is already installed in
either settings file at any version, setup says "already installed" and runs nothing, because a second copy stops Pi at start.
Without consent, setup prints one line per add-on that is not installed: purpose, spec, clash notes and how to consent.

- `polish` (`pi-polish`): compact tool output; registers renderers only. It ships a second extension (`chrome`) you may filter.
- `background-tasks` (`pi-background-tasks`): `bg_run`. It needs `PI_BG_FEATURES=process`, which the add-on reads **when Pi
  starts**: set it permanently in your shell profile, not as a prefix on `pi install`. Without `process`, its attribution hook
  takes over the global `anthropic` provider slot. Its declared Pi peer range (0.81 to 0.84) excludes the pinned Pi 1.4.x;
  the doctor reports that. See [herdr](herdr.md#optional-add-on-background-tasks).

`--remove` lists installed add-ons as `add-ons installed: <id> (<source>); kept, remove with: pi remove <source>` and runs
nothing for them.

### foreman features

- `foreman features list [--json]`: id, area, state (`on`, `off`, `auto`, `configured`, `n/a`), the recorded profile's
  expectation and a `*` on a deviation. It reads the user-plus-overlay merge, without the project layer.
- `foreman features addons [--json]`: the registry with the installed state from both settings files.
- `foreman features profile <name>`, `enable <id..>`, `disable <id..>` (plus `--dry-run`): these run the whole setup with the
  matching flags (Pi must be on `PATH`; in a checkout it may run `npm ci`), so there is one write path.

### Doctor lines

`/foreman doctor` prints `INFO profile: <name>` (or `none (run foreman setup --pick or --profile <name>)`, or `WARN profile
<name> unknown (valid: ...)`), `INFO profile deviations: <id> is <state>, profile says <state>; ...` (or `none`), and `WARN
safety relaxations on: <ids>` whenever a relaxation is on, with or without a profile.

## What setup writes

Setup does not install pi-foreman or the bundled packages: the package brings them. It migrates a setup from before
the package install: leftover top-level `npm:` entries of the bundled packages in `settings.json` are removed with
`pi remove`, because a second copy registers the same tools and Pi stops with a fatal tool conflict. It no longer writes any
permission config: the tool gate decides from the shipped policy and your own policy file (see
[permissions](permissions.md)). If your `foreman.json` still has keys of the removed permission package
(`safety.permissions.*`, `review.headless`, `review.childDefer`, `review.fallback`, `providers.<p>.review.*`), setup maps them to
`gate.*` keys, prints one line per key, backs up your config and the package's rendered config under
`<agent dir>/pi-foreman/state/migration/`, and removes the rendered file. It never edits the package entry in
`settings.json`: run `node scripts/foreman_migrate_gate.mjs settings --dry-run`, then `node scripts/foreman_migrate_gate.mjs settings`
yourself (the doctor prints a `FAIL` line until you do). The way back is the previous pi-foreman release plus those
backups ([migration](permissions.md#migration-from-the-permission-package)). Setup writes the generated `subagents` block into `settings.json` (backup
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

### What setup writes for compaction

Pi decides when to compact; pi-foreman only sets the point. Setup derives one point per model and writes it as
`compaction.modelOverrides["<provider>/<id>"].reserveTokens` into the same `settings.json` as the `subagents` block
(global, `--project` or `--develop` file; same diff, `.bak-<timestamp>` backup and `--dry-run`). The point is the
smallest of: the context window minus the reserve Pi already uses for that model (per-model override, then your
`reserveTokens`, then 16384), 20000 tokens below the model's lowest price tier (`cost.tiers[].inputTokensAbove`), and
`compaction.maxTokens` from `foreman.json` (default 200000; a project value counts only with `--project`). The reserve is
the window minus that point. Setup writes an override only when it makes Pi compact earlier than it does now, and never
below `keepRecentTokens` + 20000 (such a model gets a warning naming it). It never touches `compaction.enabled`,
`reserveTokens`, `keepRecentTokens` or other fields of an override.

Models covered:

- the role map, every rung (`model`, `strong.model`, `idle.model`), `providers.<p>.review.model` and `ladder.reviewerClimb.securityRung` (thinking suffixes dropped);
- Pi's default model, `defaultProvider` + `defaultModel` joined as `<provider>/<model>` (with `--project` the project value wins per field);
- models of your providers that match a `providers.<p>.ranks` glob: in Pi's registry, or in Pi's live model list for a provider without a registry file;
- models an overlay declares under `providers.<p>.models` ([overlays](overlays.md#models-pi-does-not-list)).

Where a model's data comes from, first hit wins:

1. `providers.<p>.models.<id>` (window and tiers as declared).
2. Pi's registry file for the provider (`<p>.json`). A registry provider that lacks the id is skipped: `no model data; declare providers.<p>.models.<id>`.
3. A provider with no registry file, such as `claude-bridge` (an extension registers it at runtime), has a base: `providers.<p>.modelDataFrom` (user or overlay config only), else the built-in `claude-bridge` -> `anthropic`. Price tiers come from the base's registry entry; the context window comes from Pi's live list (`pi --list-models`), because the bridge registers 1M only for models it has measured and 200K for the rest. Borrowing the base's window would write a reserve far too large for a 200K runtime window.
4. No registry file and no base: the live window with no price tiers (the line says `(no price tiers known)`; setup writes only when that compacts earlier than Pi does now).

Setup runs `pi --list-models` at most once, only when a covered or recorded key needs it, also in `--dry-run` (Pi itself may migrate or refresh its own files when it runs). A one-decimal `262.1K` in the list is read as its upper bound (at most 100 tokens off, in the earlier-compacting direction); a one-decimal `N.NM` that does not match the base's window is skipped.

Skip lines and the fix:

- `no model data; declare providers.<p>.models.<id>` (with `or providers.<p>.modelDataFrom` for a provider without a registry file): declare the model's window and tiers, or point `modelDataFrom` at a provider that has the id.
- `Pi's model list unavailable` (one warning names the reason; recorded entries stay and are not removed): `pi --list-models` failed, timed out, or printed no list because nothing is logged in. Log in and re-run setup.
- `not in Pi's model list (provider not logged in, its extension not loaded, or the project untrusted)`: log in to the provider first and re-run setup after a plan change, since the bridge's windows depend on the credential. An untrusted project does not load project-local extensions.
- `window <N.NM> is not exact; declare providers.<p>.models.<id>`: declare the window.

Recorded entries of a provider without a registry file stay while the list is unavailable or has no row for the provider (`kept (...)`). Every covered or recorded model gets exactly one line.

Haiku: `anthropic/claude-haiku-5-5` (window 1M, first tier above 100000) gets point 80000 (reserve 920000); `claude-bridge/claude-haiku-5-5` at its live 200K window with the same tier also gets point 80000 (reserve 120000). The other Claude models have their first tier at 220000 or higher, so the 200000 cap wins.

Ownership: the values written are recorded per settings file in `<agent dir>/pi-foreman/managed.json`
(`compactionDerived`). A `reserveTokens` equal to the recorded value is ours and is updated or removed when the model
is no longer covered; any other value is yours and stays (`kept: user value`). `foreman setup --remove` deletes only the
entries still equal to their recorded value, then the record. `/foreman doctor` reports a derived entry that drifted, in the global and the project settings file.

The model registry is read from the npm-global Pi package, found by path (no network): `PI_FOREMAN_PI_AI_DATA` (the
`pi-ai/dist/providers/data` folder), the folder of `PI_FOREMAN_PI_BIN`, every `pi` on `PATH` that resolves into
`@earendil-works/pi-coding-agent`, then `npm root -g` (the same lookup serves `/foreman doctor`, which prints an INFO line when nothing is found). That package can differ in version from the `pi` that runs. Only
`chat:` entries count; `classifier:`, `image:` and other prefixes are skipped. If the folder is not found or unreadable,
setup prints one warning and writes no registry-derived override. On Windows, `npm root -g` is not used when `npm.cmd`
is missing; set `PI_FOREMAN_PI_BIN` to Pi's `cli.js`. See [cache](cache.md) for where compaction fires.

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

The pinned Pi version lives in `packages.lock.json` (currently 1.4.0, range 1.4.x); `setup.mjs` refuses a Pi
outside the range. After a pin change, update the global Pi and re-run setup:

```sh
npm i -g @earendil-works/pi-coding-agent@1.4.0
foreman setup --dry-run && foreman setup
```

Children load MCP through Pi's own loader, `dist/extensions/mcp/config.js` relative to the Pi package root (core-adapter
reads it, so a Pi update that moves or renames it refuses MCP in children with `mcp_child_unsupported`; a compiled Pi
binary has no such file). Check it after each Pi update. MCP changes (`mcp.json`, `roles.<id>.mcp`) need no setup re-run;
the one exception is the upgrade from the older `mcp:` grant, where one `foreman setup` rewrites the generated agent files.

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
manifest entry is missing and prints the same hint; `/foreman doctor` FAILs on a missing bundled entry). `foreman setup` in a checkout also runs `npm ci` itself when `package-lock.json` is newer than `node_modules/.package-lock.json` (or `node_modules` is missing); after a merge that changes `package-lock.json`, run `npm ci` (or `foreman setup`) in the main checkout.

`--develop` writes `.pi/settings.json` inside the checkout with `".."` as a package plus an empty-filter override of
the installed pi-foreman source. Project packages load before global ones and only after project trust (`pi -a` when
headless). Double-load rule: the checkout wins in its own tree. Without the override Pi exits with a tool conflict
("Tool ... conflicts with ..."), because two copies register the same tools. The core adapter also carries a
once-guard: a second core copy registers nothing and posts one notice naming both roots. The self-host protect
narrows only when the checkout copy is the active one (see [permissions](permissions.md)). Tests and the replay rig:
[development](development.md).

## Python on macOS

The Command Line Tools `/usr/bin/python3` is Python 3.9, which pi-foreman refuses. Install 3.13 with
`brew install python@3.13` or from [python.org](https://www.python.org/downloads/). The POSIX launchers (`bin/foreman`,
`bin/ledger`, `bin/foreman-worktree-setup`) use `PI_FOREMAN_PYTHON` as it is when it is set; otherwise they take the
first of `python3`, `python3.14`, `python3.13`, `python` that is Python 3.13+. None found: exit 2 with
`pi-foreman needs Python 3.13+; found <cmd> <version>`. To pin an interpreter, set `PI_FOREMAN_PYTHON` or `python.path`
in `foreman.json` (`null` auto-detects; the adapter tries `python.path` before `PI_FOREMAN_PYTHON`).

## Windows

`pi` is a `.cmd` shim there and Node cannot spawn `.cmd` directly, so setup reads the shim and runs Pi's JS entry with
Node. Python is found as `py -3`, then `python`; the Microsoft Store alias stub is rejected. If none works, install
Python 3.13+ from python.org (or `winget install Python.Python.3.13`) with the py launcher.

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
