# pi-foreman

A generic orchestration harness for the [pi coding agent](https://pi.dev). It is planned to ship Pi extensions (TypeScript), agent roles, skills and a Python core (requirements ledger, guards) together with an installer.

**Status:** early, design phase.

## Install

Needs Node 22+, Pi 1.0.x on `PATH` and Python 3.9+. From a checkout of this repo:

```sh
node setup.mjs --dry-run   # show the planned diff and `pi install` commands, write nothing
node setup.mjs             # install into the user-level Pi agent dir
node setup.mjs --project   # install project-locally (.pi/settings.json)
node setup.mjs --remove    # remove only what the installer manages
```

Options: `--overlay npm:<pkg>@<exact-version>` installs an organisation overlay (ranges are refused),
`--agent-dir <dir>` overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`, `--no-intercom` skips `pi-intercom`
(installed by default, see below). Project packages load only after
the project is trusted; headless runs need `pi --approve`. A second run changes nothing and says "up to date".

The installer installs `pi-subagents` (pinned in `packages.lock.json`) and registers this checkout with
`pi install <path>`. The permission packages are pinned but installed from Phase 3. It writes the generated
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

### Claude bridge: log in once

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

## Commands

In a Pi session (the foreman, not children):

- `/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config, then runs the retro. It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active.
- `/retro` prints friction metrics of the session and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you.
- `/foreman close [result-path]` ends the session cleanly: result file, sync, exit. It is refused while a long wait is pending or a child run is still active (nothing is cancelled). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session).
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The usage footer (tokens, list-price cost, child launches) is on by default (`footer.usage`). Outside Pi,
`bin/foreman update-check|retro|sync [args]` (`.cmd` and `.ps1` on Windows) runs the same scripts. Keys and
their layer rules are in `design/architecture.md` §7.

## License

MIT, see `LICENSE`. Upstream attributions are in `NOTICE`.
