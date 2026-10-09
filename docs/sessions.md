# Sessions and commands

> Covers `/sync`, `/retro`, `/foreman close`, the usage footer, `bin/foreman`, pi-intercom setup and the Herdr blocked state.
> Read it when you end, hand over or wrap up a session, or script one from outside Pi.
> `/foreman close` is refused while a long wait is pending or a child run is still active; nothing is cancelled.

## Session commands

Added in this round; see below.

## Commands

In a Pi session (the foreman, not children):

- `/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config, then runs the retro. It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active. It does nothing until you list repositories in `sync.repos` of your user or overlay config (a project or session cannot). The known limit is in [safety](safety.md).
- `/retro` prints friction metrics of the session and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you. `/retro --model <id>` picks the model that writes the findings.
- `/foreman close [result-path]` ends the session cleanly: result file, sync, exit. It is refused while a long wait is pending or a child run is still active (nothing is cancelled). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session).
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The usage footer (tokens, list-price cost, child launches) is on by default (`footer.usage`). Outside Pi,
`bin/foreman update-check|retro|sync [args]` (`.cmd` and `.ps1` on Windows) runs the same scripts. The keys
and their layer rules are in the tables of [ceremony](ceremony.md) and [safety](safety.md) and in the schema
`config/foreman.schema.json`.

## pi-intercom

The installer installs `pi-intercom` (pinned) unless `--no-intercom`, and writes
`<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if absent
(see [install](install.md)). Sessions then address each other by name or id; the close request above travels over
it as plain text `foreman:close`, accepted only from the recorded parent session.

## Herdr

Herdr's Pi integration (`herdr integration install pi`, installed by you, never by the installer) shows a session
as working, idle or blocked. pi-foreman emits `herdr:blocked` on `pi.events` while one of its own prompts or a
permission prompt is open, so the pane reads blocked instead of working. Design record: `design/architecture.md`
[session features](../design/architecture.md#session-features-phase-4).
