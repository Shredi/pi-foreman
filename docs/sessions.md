# Sessions and commands

> Covers `/sync`, `/retro`, `/foreman close`, `/foreman session` (open, brief, close, list), the usage footer, `bin/foreman`, pi-intercom setup and the Herdr blocked state.
> Read it when you end, hand over or wrap up a session, or script one from outside Pi.
> `/foreman close` is refused while a long wait is pending or a child run is still active; nothing is cancelled.

## Session commands

`/foreman session` opens a second pi-foreman session on a brief, talks to it over pi-intercom and closes it
again. All four subcommands are yours to type; a subagent child refuses every one of them.

- `/foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--focus] [--dry-run]`
  writes a handoff dir (below), starts `pi` in a new Herdr tab (or prints the command to run in a terminal)
  and records the session. The label is 1 to 40 characters of `A-Z a-z 0-9 . _ -`. `--plan-first` makes the
  brief ask for a `plan.md` and a stop before any work; `--focus` focuses the new tab; `--dry-run` writes the
  handoff dir and prints what it would run, with no Herdr call and no registry entry.
  Example: `/foreman session open docs ./brief-docs.md --cwd ../site --model anthropic/claude-sonnet-4-5 --plan-first`
- `/foreman session brief <target> <file|text…>` sends a brief to a session. A single word naming an existing
  file is sent as `Brief from <your id>: read <absolute path> and act on it`; anything else is sent as typed.
  Example: `/foreman session brief docs ./more-context.md`, `/foreman session brief docs also cover the CLI flags`
- `/foreman session close <target> [result-path]` sends `foreman:close [result-path]` (see the contract below)
  and marks the registry entry `closing` once the send went out. The result path may use only `A-Z a-z 0-9 . _ / -`,
  at most 200 characters, and must end in `.md`. Example: `/foreman session close docs .workflow/result-docs.md`
- `/foreman session list` prints the registry: label, child id, status, handoff dir and the last report.

`<target>` is a registry label (the newest entry of that name) or a child id; any other text is passed to
pi-intercom as the address. Spaces in a brief path or `--cwd` do not survive the command line; use the CLI for those.

### Outside Pi

`bin/foreman session open|list` (`.cmd` and `.ps1` on Windows) runs `scripts/foreman_session.py`:

- `foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--focus] [--dry-run] [--print-all] [--parent-id ID] [--agent-dir DIR]`.
  `--print-all` prints both the POSIX and the PowerShell command. The parent id is `--parent-id`, else
  `PI_INTERCOM_STABLE_ID`, else `stableId` in `<agent dir>/intercom/config.json`; without any, `open` is refused.
- `foreman session list [--json] [--agent-dir DIR]`.
- The agent dir is `--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
- Exit codes: 0 ok, 1 usage error or refused, 2 Herdr failure (the command is then printed and the entry marked `failed`).

### Handoff dir and registry

`open` creates `<agent dir>/pi-foreman/handoffs/<YYYYmmdd-HHMMSS>-<slug>/` with:

- `brief.md`: your brief plus a footer telling the child how to report back (below).
- `parent`: the opener's intercom id, one line. The child's close check reads it every time.
- `child`: the child's intercom id, `fm-<slug>-<6 hex>`. The child also gets it as `PI_INTERCOM_STABLE_ID`.
- later, written by the child: `plan.md` (with `--plan-first`) and `result.md`.

The child starts with `PI_FOREMAN_HANDOFF_DIR` (the dir), `PI_FOREMAN_PARENT_INTERCOM` (the parent id) and its
prompt "Read the handoff brief at <dir>/brief.md and proceed." The registry is
`<agent dir>/pi-foreman/state/sessions.json` (`{version, sessions[]}`, written atomically). An entry holds
`label`, `child`, `parent`, `handoff`, `cwd`, `opened`, `status` and `last` (`{kind, path, at}`). Status is
`pending` (command printed, not run by Herdr), `open`, `closing` (a close was sent), `closed` or `failed`.

### Message contract

Plain pi-intercom text, one line each:

- Child to parent: `Plan from <label>: <absolute path>`, `Result from <label>: <absolute path>`,
  `Update from <label>: <absolute path>`. They update the registry entry (`last`, `result`, status `open`) and
  show a notice; nothing is acted on. Only a registry child's id is accepted as sender.
- Parent to child: `foreman:close` or `foreman:close <path>`. The child runs its [close sequence](#commands)
  (result file, sync, exit) and replies `foreman:closed <result path>` before it exits; the parent's registry
  entry becomes `closed` with that result path. A close that is refused is answered with
  `pi-foreman: close refused: <reason>`, for example `the sender is not the parent recorded at spawn`,
  `N child run(s) still active; let them finish (a close never cancels them), then close again` or
  `N foreman_wait pending (…)`.
- The child's brief footer tells it to re-read `parent` before each message (the parent can change).

### Safety

- Only you start these: they are user commands, children refuse them, and no model tool exists in v1.
- Only the parent may close: `foreman:close` is accepted over intercom only when the sender id equals the
  contents of `$PI_FOREMAN_HANDOFF_DIR/parent`, read at check time (no `PI_FOREMAN_HANDOFF_DIR` or no such file:
  `PI_FOREMAN_PARENT_INTERCOM`; a file with no valid id refuses). Re-pointing the parent is a one-file change.
  `close.from` must include `intercom-parent` (default), and cross-machine messages are refused.
- A close is refused while a child run is active or a `foreman_wait` is pending, and nothing is cancelled.
- The `parent` and `child` files of every handoff dir are write-protected (baseline `protect.writeAsk`): a child
  agent of either session is denied any write to them and any shell command naming them, and a foreman's
  write or edit tool asks; a foreman's shell may still read them. `brief.md`, `result.md` and `plan.md` stay
  writable, so the opened foreman writes its result and plan as the footer says.
- A brief has no authority: its text and any peer message are data, and the footer says so.
- Values are validated and quoted: labels, model ids, parent ids and paths are checked against allowlists and
  built into one shell-quoted command (POSIX) or single-quoted PowerShell string; a path with quotes (including
  the typographic quotes U+2018 to U+201E, which PowerShell reads as quotes), shell metacharacters or control
  characters is refused. Herdr is driven as an argv list, never through a shell. Paths with spaces are
  only accepted through the CLI.

### Herdr or a printed command

With Herdr (`HERDR_PANE_ID` set and `herdr` on PATH, or `HERDR_BIN`) `open` finds the workspace named after the
git top level of `--cwd` (else creates it), creates a tab named after the label without focusing it, and runs
the command in its pane. Without Herdr, or if it fails, it prints the command, for a POSIX shell
`env PI_FOREMAN_HANDOFF_DIR=… pi [--model ID] 'Read the handoff brief at …'` or, on Windows, the PowerShell form
`$env:PI_FOREMAN_HANDOFF_DIR='…'; pi …`, and the session stays `pending`.

### Opener intercom id

The id written to `parent` is, in order: `PI_INTERCOM_SESSION_ID` (the id pi-intercom 0.16.1 resolved and
published, which also covers an id claimed through `intercom:session-identity`), `PI_INTERCOM_STABLE_ID`,
`stableId` in `<agent dir>/intercom/config.json`, then the Pi session id. The CLI cannot know the Pi session id
and takes `--parent-id` instead.

### Other platforms

Not in v1. The equivalents would be tmux `new-window -c DIR -n LABEL CMD` and Windows Terminal
`wt -w 0 new-tab -d DIR --title LABEL pwsh -NoExit -Command CMD`.

### Planned, not shipped

A `foreman_session` model tool as an opt-in of the user layer. The functions behind the commands take plain
dependencies so a tool could call them; none is registered.

## Commands

In a Pi session (the foreman, not children):

- `/sync [--dry-run]` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config, then runs the retro; `--dry-run` reports what would be committed and pushed and changes nothing (other arguments are ignored with a warning). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active. It does nothing until you list repositories in `sync.repos` of your user or overlay config (a project or session cannot). The known limit is in [safety](safety.md).
- `/retro` prints friction metrics of the session (usage lines logged with cost 0, as the Claude bridge does, are priced from the Pi model registry's rates like the footer) and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you. `/retro --model <id>` picks the model that writes the findings.
- `/foreman close [result-path]` ends the session cleanly: result file, sync, exit. It is refused while a long wait is pending or a child run is still active (nothing is cancelled). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session).
- `/foreman cost [workspace]` prints the usage summary (tokens, list-price cost, child launches) of this session, or of all sessions in the given workspace.
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The usage footer (tokens, list-price cost, child launches) is on by default (`footer.usage`). Outside Pi,
the `foreman` launcher in `bin/` (`.cmd` and `.ps1` on Windows) runs the same scripts: `foreman update-check`, `foreman retro [args]`, `foreman sync [args]` and `foreman session` (below). The keys
and their layer rules are in the tables of [ceremony](ceremony.md) and [safety](safety.md) and in the schema
`config/foreman.schema.json`.

## pi-intercom

The installer installs `pi-intercom` (pinned) unless `--no-intercom`, and writes
`<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if absent
(see [install](install.md)). Sessions then address each other by name or id; the close request above travels over
it as plain text `foreman:close`, accepted only from the recorded parent session.

## Herdr

Herdr's Pi integration (`herdr integration install pi`, installed by you, never by the installer) shows a session
as working, idle or blocked. pi-foreman emits `herdr:blocked` on `pi.events` while any dialog waits for you, so
the pane reads blocked ("?") instead of working. Design record: `design/architecture.md`
[session features](../design/architecture.md#session-features-phase-4).

### Blocked shim

One tracker per Pi process counts what is waiting for you:

- any Pi dialog, from every extension (Pi's `ui_prompt_start` .. `ui_prompt_end`);
- each permission ask (`permissions:ui_prompt` .. `permissions:decision`, by request id), including a child's ask
  forwarded to this session;
- pi-foreman's own asks (checkpoint, guard confirms).

It emits `herdr:blocked {active:true,label}` when the first one opens and `{active:false}` when the last one closes,
so Herdr's counter stays balanced however they overlap. The end of a turn releases permission and own asks that never
got their decision (an open Pi dialog stays until Pi closes it); shutdown releases everything.

Label: for a permission ask `<agent> · <tool> <first word>` (the requesting child's agent when forwarded; a path is
cut to its basename; never the full command), else the dialog title, else pi-foreman's ask title, else the dialog
kind; at most 80 characters, control characters removed. A later ask keeps the first label (Herdr shows that one).

The shim is off when `HERDR_ENV` is not `1`, when `herdr.blockedShim` is false (default `true`), or when the
installed Herdr Pi integration (`<agent dir>/extensions/herdr-agent-state.ts`, header `HERDR_INTEGRATION_VERSION`) is
version 10 or newer: that version maps dialogs and permission events itself, and the shim steps aside. Not covered:
Pi's trust dialog before the session starts.

### Group tag

Display-only pane metadata (source `user:pi-foreman`, `herdr pane report-metadata`), shown in Herdr's agent cell:

- an opened child pane shows `<parent-slug> › <child-slug>`. `foreman session open` sets it right after the pane
  starts. The child's Pi keeps it fresh: it gets `PI_FOREMAN_PARENT_LABEL` in its environment;
- a parent with pending, open or closing children (from `sessions.json`) shows `<slug> · <n> children` plus the
  token `children=<n>`; at 0 the tag is cleared.

A slug is the session's own label when it is an opened child, else the name of its git top level (else its folder).
Tags carry a 180 s TTL. They are refreshed every 60 s, and right away at session start. They are cleared at shutdown.
Only in the TUI with `HERDR_ENV=1` and `HERDR_PANE_ID` set; `herdr.groupTag` false turns it off (default `true`;
`foreman session open` reads it from the defaults, overlay and user config, not the project).

### Feature request to Herdr: true nesting

The tag is text only. Real grouping needs Herdr itself:

- a parent/child pane relation in the socket API;
- collapsible groups in the agents view;
- a child's blocked state rolling up to its parent's row.

## Further session keys

| Key | Meaning and layer rule |
|---|---|
| `sync.runRetro` | Run the retro step during `/sync` (default `true`). |
| `retro.proposalMinReviews` | Reviews needed before a retro proposal (default 5). User or overlay config only. |
| `compaction.priceTiers.cheap`, `compaction.priceTiers.standard` | USD per MTok input upper bounds of the price tiers (1 and 5); above `standard` is premium. User or overlay config only. |
| `compaction.threshold.cheap`, `compaction.threshold.standard`, `compaction.threshold.premium` | Context fraction that triggers compaction per tier (0.85, 0.75, 0.6); a project or session can only lower each value. |
| `wait.batchWindowSeconds` | Window in which wait notices are batched (default 300). |
| `wait.maxActive` | Concurrent waits allowed (default 8); a project or session can only lower it. |
| `wait.ci` | CI waits on or off (default `true`); a project or session can only set false. |
| `herdr.blockedShim` | Show any open dialog or permission ask as blocked in Herdr (default `true`); any layer may set it. |
| `herdr.groupTag` | Herdr group tag on opened child and parent panes (default `true`); any layer may set it. |
