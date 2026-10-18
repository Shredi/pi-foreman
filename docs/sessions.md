# Sessions and commands

> Covers `/sync`, `/retro`, `/foreman close`, `/foreman session` (open, brief, close, list), the usage footer, `bin/foreman`, pi-intercom setup and the Herdr blocked state.
> Read it when you end, hand over or wrap up a session, or script one from outside Pi.
> `/foreman close` is refused while a child run is still active (never cancelled); the session's own pending long waits are cancelled.

## Session commands

`/foreman session` opens a second pi-foreman session on a brief, talks to it over pi-intercom and closes it
again. All four subcommands are yours to type; a subagent child refuses every one of them.

- `/foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--focus] [--dry-run]`
  writes a handoff dir (below), starts `pi` in a new Herdr tab (or prints the command to run in a terminal)
  and records the session. The label is 1 to 40 characters of `A-Z a-z 0-9 . _ -`. `--plan-first` makes the
  brief ask for a `plan.md` and a stop before any work; `--focus` focuses the new tab; `--dry-run` writes nothing
  (no handoff dir, brief, parent, child or registry entry) and prints the handoff path, the child id, the session
  model (`session model: <id>`, when `--model` is given) and the command it would run; no Herdr call.
  Example: `/foreman session open docs ./brief-docs.md --cwd ../site --model anthropic/claude-sonnet-4-5 --plan-first`
- `/foreman session brief <target> <file|text…>` sends a brief to a session. A single word naming an existing
  file is sent as `Brief from <your id>: read <absolute path> and act on it`; anything else is sent as typed.
  Example: `/foreman session brief docs ./more-context.md`, `/foreman session brief docs also cover the CLI flags`
- `/foreman session close <target> [result-path]` sends `foreman:close [result-path]` (see the contract below)
  and marks the registry entry `closing` once the send went out. The result path may use only `A-Z a-z 0-9 . _ / -`,
  at most 200 characters, and must end in `.md`. Example: `/foreman session close docs .workflow/result-docs.md`
- `/foreman session list` prints the registry: label, model, status, handoff dir, child id and the last report.

`<target>` is a registry label (the newest entry of that name) or a child id; any other text is passed to
pi-intercom as the address. Spaces in a brief path or `--cwd` do not survive the command line; use the CLI for those.

### Outside Pi

`bin/foreman session open|list` (`.cmd` and `.ps1` on Windows) runs `scripts/foreman_session.py`:

- `foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--focus] [--dry-run] [--print-all] [--parent-id ID] [--own-model ID] [--agent-dir DIR]`.
  `--print-all` prints both the POSIX and the PowerShell command. The parent id is `--parent-id`, else
  `PI_INTERCOM_SESSION_ID`, else `PI_INTERCOM_STABLE_ID`, else `stableId` in `<agent dir>/intercom/config.json`; without any, `open` is refused.
- `foreman session list [--json] [--agent-dir DIR]` prints label, model (`-` when none was given), state, handoff dir and child id.
- `foreman session brief <handoff dir|label|child id> <text|file> [--parent-id ID] [--agent-dir DIR]` delivers a brief to the
  child through pi-intercom (`cli.mjs send`, run without a shell). A handoff dir resolves through its `child` file, a label
  to the newest registry entry. A single word naming a file is sent as `Brief from <opener id>: read <abs path> and act on it`
  (the opener id as for `open`), anything else as is. If node or pi-intercom is missing, or the broker refuses, the message
  is printed for you to send by hand and the exit code is 1; it never falls back to `herdr agent prompt`.
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
  (result file, sync, exit) and replies `foreman:closed <result path> CLOSE: ready|open` before it exits; the parent's registry
  entry becomes `closed` with that result path. A close that is refused is answered with
  `pi-foreman: close refused: <reason>`, for example `the sender is not the parent recorded at spawn`,
  `N child run(s) still active; let them finish (a close never cancels them), then close again` or
  `N foreman_wait pending (…)` (only when a wait cannot be cancelled).
- The child's brief footer tells it to re-read `parent` before each message (the parent can change).

### Closing the children with the parent

`/foreman close` also closes the session's own child sessions: after the result turn and before the sync, every
registry entry whose `parent` is this session's opener id and whose status is `open` or `pending` gets
`foreman:close` over pi-intercom and turns `closing`. The registry is then polled (every second) for up to
`close.childWaitMs` (default 60000; `0` = send and do not wait). The close notice lists one line per child:
`closed`, `refused (<reason>)` (the child answered `pi-foreman: close refused: …`; the entry goes back to `open`),
`timeout after <n> ms` (the child may still close later) or `not sent (<status>)`. A child that does not close never
fails or delays the parent's close beyond that bound.

### Ask by file (parent that is not a Pi session)

A parent without a pi-intercom connection (for example a Claude session) cannot receive an intercom `send`; the child's
`send` fails with `Session not found`. The brief footer then names a file contract in the handoff dir:

| File | Written by | Content |
|---|---|---|
| `ask.md` | the child | first line `# Ask <n>: <topic>` (n = 1, 2, …), then the question and options |
| `.ask` | pi-foreman | marker, `ask-<n>`, touched when `ask.md` is written in the session's own handoff dir |
| `ruling-<n>.md` | the parent | the answer to ask n |
| `.seen` | pi-foreman (the child may write it too) | the ruling file name, written when the ruling wait wakes |

When the child writes `ask.md` (a `write` or `edit` that succeeds, only under one of its own handoff dirs), pi-foreman
touches `.ask` and shows the session as blocked in Herdr (`herdr:blocked`, label `ask <n>: <topic>`); it never uses
`herdr agent prompt`. The parent polls the handoff dir for `*.md` and `.ask`; the child waits with
`foreman_wait({action: "start", kind: "file", path: "<handoff dir>/ruling-<n>.md"})`.

- **`.seen` by the harness.** When a file wait on `ruling-<n>.md` (or `ruling.md`) in an own handoff dir wakes, pi-foreman
  writes `.seen` (the ruling file name) itself; no tool call or dialog. A `.seen` the child writes by hand is harmless
  (idempotent), also one made by `bash`.
- **Blocked is recomputed from the files**, never a sticky flag: blocked while `.ask` is present and no `.seen` names the
  ruling of that ask (`ruling-<n>.md`, or `ruling.md`). Any `.seen` write (write/edit tool, or a `bash` result) and the
  session shutdown recompute it.
- **A stale ruling is ignored.** A `ruling-<n>.md` whose mtime is older than `ask.md` does not wake the wait (it keeps waiting).
- **A parent ruling never satisfies the finish gate.** A `ruling.md` or `ruling-<n>.md` (first line `APPROVED` or `SHIP`)
  from the parent does not close the reviewer step: only a reviewer verdict does. After a FAIL the finish refusal names
  the newer ruling and says the chair runs `/ceremony <tier>` to override; `/foreman close` lists what is still open and
  what the parent would have to rule.
  Only handoff dirs whose `child` file names this session count (for the ask state too); a dir where this session is the
  `parent` never does. **Who may write a ruling file:** only the parent. A session's write, edit, `foreman_copy` /
  `foreman_move` destination, or `bash` / `powershell` / `foreman_bg` / `bg_run` command that names `ruling*.md` in a dir
  where it is the child is refused up front ("a session cannot write its own parent's ruling"). A shell command is lexed
  by `scripts/shell_facts.py` (the git guard's Lexer, nested `sh -c` / heredoc scripts up to depth 4) and refused only
  when a write surface may be such a file: a redirect on any fd, `tee`/`cp`/`mv`/`install`/`ln`/`rsync` (their
  destinations, and a ruling file as their source), `dd of=`, `sed -i` and sed `w`, `truncate`/`touch`, `sort -o`,
  `curl -o`, `--output=`, PowerShell write cmdlets, python/node/perl code writes, or a ruling-named argument of a
  program that is not a reader. A computed name or directory in a write position (an unbound `$var`, a glob, a `cd`
  the tracker cannot follow, a directory that does not exist yet, a line that makes a symlink) counts as such a file.
  Reads, `$`/glob words in read positions and heredoc bodies never do; `$FOREMAN_SCRATCH` is the harness scratch dir
  unless the line assigns it. `ruling-<name>.ack` files are no ruling files. No python, a timeout or an unreadable
  line refuses the call. Writing `ruling*.md` into a dir where it is the parent (answering its child) stays
  allowed. This refusal is defence in depth, since a ruling cannot satisfy the gate anyway; a ruling file this session
  still changed is ignored until the parent writes it again (a newer mtime). Self-written marks live in memory.
- **Child input dirs.** A child writes the files it passes to a command (its `git commit -F` message file) only into
  `$FOREMAN_SCRATCH` or `<worktree>/.workflow/scratch/`; `.pi/scratch/` is the main session's dir, and the git guard
  refuses a child message file there and anywhere else in the worktree (docs/permissions.md, overlay narrowing). A
  child's `git tag -F` message file under a write-protect rule (`.pi/scratch/` included) is denied by the overlay.
- **`bg_wait` during a builder's supervisor ask.** pi-foreman does not refuse it (`bg_wait` is exempt from the supervisor window).
  The pi-subagents package (node_modules, not editable here) ends the wait with "Wait yielded for a pending supervisor
  request"; background work continues, so answer with `subagent_supervisor` and call `bg_wait` again.
- **`foreman_bg` and `foreman_wait {kind: pid}`.** `foreman_bg` returns the wait id; an explicit `foreman_wait` on the same pid
  returns that id (no second wait).

Worked example:

1. The child writes `<handoff dir>/ask.md`:
   ```
   # Ask 1: which schema for the export?

   A: flat CSV. B: nested JSON. I lean to A.
   ```
   pi-foreman writes `<handoff dir>/.ask` (`ask-1`) and Herdr shows `blocked`; the child starts the file wait on `ruling-1.md`.
2. The parent sees `.ask`, reads `ask.md` and writes `<handoff dir>/ruling-1.md`: `A, flat CSV.`
3. The wait wakes; pi-foreman writes `<handoff dir>/.seen` containing `ruling-1.md` and Herdr leaves `blocked`; the child reads `ruling-1.md` and continues.
   The next question is `# Ask 2: …` answered by `ruling-2.md`.

### Steer while a child runs

While a foreman's launch-wait holds a child's result, the adapter polls `$PI_FOREMAN_HANDOFF_DIR` every 2 s for a `ruling*.md` or `steer*.md` file that is new or has a newer mtime than the one already delivered (files present when the first wait starts are the baseline). The first one found ends the wait early: the launch result says the run is still running, then the file text (first 4 KB, marked as data, not instructions); continue with `bg_wait <runId>`. Each file version is delivered once. With no `PI_FOREMAN_HANDOFF_DIR` nothing is polled. The `launch_wait` trace event reports `outcome: steer`.

### Child orchestrator sessions

A heavy task with several phases may run as a multi-session plan: one child session per phase, each in its own worktree, opened with `foreman session open <label> <brief> --plan-first`. The parent reviews each phase before the next.

- **Model.** The session runs on `--model`, else the mapped `session-foreman` model (`providers.<p>.roles.session-foreman.model`, the own provider then its fallback), else the opener's own model; `open` prints `session model: <model>`. Only an explicit choice (`--model` or the mapped `session-foreman` model) is passed on as `--model`; the opener's-model fallback is displayed but not passed, so that child does not get `PI_FOREMAN_SESSION_MODEL` and keeps its role thinking. An explicit `--model` wins over the overlay/preset foreman role model (model and thinking) in the child: it gets `PI_FOREMAN_SESSION_MODEL=<model>` and keeps the model it started on. The CLI (`foreman session open`, `--own-model ID` or `PI_FOREMAN_SESSION_MODEL` naming the opener's model) applies the same rank rule as `/foreman session open` when the opener's model is known; when it is unknown (a parent that is not Pi) the check is skipped and `rank check skipped: own model unknown` is printed. A child never opens a session ranked above its own: the open is refused (`session open refused [session_rank]`, nothing spawned). See [roles](roles.md).
- **Plan review.** The child writes `plan.md`, sends `Plan from <label>: <path>` and waits. The parent writes `<handoff dir>/ruling.md` (first line `APPROVED`, else a revision note) and sends it with `foreman session brief <label> <ruling path>`, which wakes the child. The child works only after an `APPROVED` ruling; otherwise it revises `plan.md` and sends `Plan from` again. The parent reviews `result.md` before it opens the next phase, then closes the child with `foreman:close`.
- **Reload in a round session.** With `PI_FOREMAN_HANDOFF_DIR` set, the adapter keeps `<handoff dir>/round-state.json` itself: the handoff dir, the topic and version hash of the checkpointed `.workflow/scratch/plan-<topic>.md`, that plan's `[plan-review]` verdict and round count, the review counters (`ceremony.reviewRuns`) and the revision rounds per chain. It never keeps an approval. On `/reload` the file counts only when its handoff dir is this one and its hash equals the plan file now; else it is discarded and the plan goes through the ceremony again (plan review, `foreman_checkpoint`). The checkpoint approval comes back only from the parent's `ruling.md` (never `ruling-<n>.md`) with first line `APPROVED` and a ctime newer than the ctime of both `.workflow/scratch/plan-<topic>.md` and `<handoff dir>/plan.md`; a session cannot set a ctime back, so a plan edited after the ruling, or a file with `approved: true`, grants nothing. Counters come back only as non-negative integers; the rulings a chain already used, its last refusal and the security-exempt flag do not. An owner prompt or a tier change rewrites the file, so cleared counters stay cleared. The restored approval lets builders launch; the finish gate still needs a reviewer PASS. Without `PI_FOREMAN_HANDOFF_DIR` nothing is written or restored.
- **Message contract.** Besides `Plan from|Result from|Update from <label>: <path>`, a registry child may send the aliases `foreman:plan <path>` and `foreman:result <path>`; the label is taken from the registry entry of the sender. `foreman:closed <path>` is as before.
- **Waiting.** `foreman_wait({action: "start", kind: "child", label})` resolves on the next plan, result, update or closed notice of the registry child `label` (or of any child with `label: any`; a wait naming the label wins over `any`). The wake line is `child <label>: plan|result|update|closed <path>`. A child's refusal of a close (`pi-foreman: close refused: <reason>`) wakes the same wait with `child <label>: refused <reason>`. Race: a notice that arrives before the wait starts is not replayed; check `/foreman session list` (the registry's `last`) first.

### Parallel rounds

Every orchestrator session works in its own worktree (`git worktree add …`) and never switches the shared main checkout. Merges happen from the session's worktree, so two sessions running in parallel cannot move each other's branch or working tree.

A security revision after the final review is cap-exempt: one more Opus builder is allowed.
Builders commit per numbered item.
A child bundle holds at most 3 items.

### Trust dialog for a fresh worktree

Pi asks `Trust project folder?` (`<cwd>`, "This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.") when the cwd has project resources (`.pi/settings.json`, `extensions`, `skills`, … or a `.agents/skills` directory in the cwd or an ancestor) and `<agent dir>/trust.json` holds no decision for it or a parent. A new round worktree has none, so every `foreman session open` into one would stop at the dialog.

When the `--cwd` of `open` (not `--dry-run`) is the root of a linked git worktree under the managed root (`close.worktreeDir`, default `../<repo>.worktrees`), `open` writes `{"<realpath of cwd>": true}` into `<agent dir>/trust.json`: an atomic read-modify-write under Pi's own lock directory that keeps every other entry, for that exact path only (never a parent folder), and not when the store already has an exact entry for it or cannot be parsed. The registry entry records `trusted: <path>`; whenever pi-foreman removes the worktree (session close cleanup, `foreman worktree sweep`, the `foreman_worktree_remove` tool) it deletes that entry again, and only entries it recorded, so your own trust decisions stay. Builder worktrees from pi-subagents run headless: Pi only shows the dialog in an interactive run and treats an undecided folder as untrusted without asking otherwise, so nothing is written for them.

Alternatives: start `pi` with `--approve`, or set `defaultProjectTrust` to `always` in your Pi settings (every folder, so broader than the entry above).

### Safety

- Only you start these: they are user commands, children refuse them, and no model tool exists in v1.
- Only the parent may close: `foreman:close` is accepted over intercom only when the sender id equals the
  contents of `$PI_FOREMAN_HANDOFF_DIR/parent`, read at check time (no `PI_FOREMAN_HANDOFF_DIR` or no such file:
  `PI_FOREMAN_PARENT_INTERCOM`; a file with no valid id refuses). Re-pointing the parent is a one-file change.
  `close.from` must include `intercom-parent` (default), and cross-machine messages are refused.
- A close is refused while a child run is active; the session's own pending `foreman_wait`s are cancelled instead (trace `waits_cancelled`).
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

### Providers in opened sessions

The opened command is a plain `pi [--model ID] '<prompt>'`: it loads the same packages as any start, so
`claude-bridge/*` models are there only if pi-claude-bridge is in `settings.json` packages. One R13 round session
opened with `--model anthropic/…` had no `claude-bridge/*` entries in `/model` until `/reload`. Not reproduced
(no live run); best hypothesis from reading Pi's startup: Pi resolves the `enabledModels` scope (or `--models`)
once at start, and a provider an extension registers later (after the scope is resolved, e.g. in `session_start`)
is missing from that scoped list; `/reload` resolves it again. No generic fix in pi-foreman. Workaround: run
`/reload` in the opened session, or add the bridge models to `enabledModels`. `/foreman doctor` prints
`providers: <list>`, the providers the model registry holds in that session; a missing `claude-bridge` there
means the bridge is not loaded or has not registered yet.

### Opener intercom id

The id written to `parent` is, in order: `PI_INTERCOM_SESSION_ID` (the id pi-intercom 0.17.0 resolved and
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

- `/sync [--dry-run]` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config. The retro runs first (`sync.runRetro`), so a committed repository backlog is current ([retro](retro.md)); `--dry-run` reports what would be committed and pushed and changes nothing (other arguments are ignored with a warning). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active. It does nothing until you list repositories in `sync.repos` of your user or overlay config (a project or session cannot). The known limit is in [safety](safety.md). It also prints the CLOSE report and cleans up what the session created ([close](close.md)).
- `/retro` prints friction metrics of the session (usage lines logged with cost 0, as the Claude bridge does, are priced from the Pi model registry's rates like the footer) and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you. Findings also go to the retro backlog, listed with `foreman backlog` ([retro](retro.md)); `retro.enabled` null turns this on in tui and rpc sessions only. `/retro --model <id>` picks the model that writes the findings. `/retro --model --known-limits <file>` appends the file's first 2000 characters to that prompt as rig facts the foreman must not list under Missing (a missing file adds nothing).
- `/foreman close [result-path]` is how a sub-orchestrator (a session opened with `/foreman session open`) exits: result file, sync (retro, then repository commits), exit. The top orchestrator runs `/sync` by hand; subagents never sync ([retro](retro.md)). It is refused while a long wait is pending or a child run is still active (nothing is cancelled). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session). Its CLOSE report, cleanup of the worktrees and scratch the session created, and handovers to the parent are in [close](close.md).
- `/foreman cost [workspace]` prints the usage summary (tokens, list-price cost, child launches) of this session, or of all sessions in the given workspace. `--json` prints one object instead (by role, model and role×model: tokens, USD to the cent, and per row how many calls used a recorded cost, were re-priced from `config/prices.json` (long-context tier included) or unpriced); `--all` scopes it to every session of this workspace.
- `/foreman dialogs --json` prints the permission dialogs this session's trace recorded (overlay `ask-*` records), counted per family (`state_usage_read`, `pi_scratch_read`, `toolchain_probe`, `own_run_dir`, `own_bg_output`, `own_bash_output_log`, `owned_scratch`, `hub_ledger_read`, `other`) as `{family: {count, lines: [...]}}` with the redacted, path-scrubbed command lines (200 characters at most). With the trace off (`trace.enabled`) it says so instead of printing zero counts. The foreman-only tool `foreman_dialogs({trace?})` returns the same JSON (default: this session's trace; `trace` names another trace file), and `foreman dialogs <trace>` (`bin/foreman`, `.cmd`, `.ps1`) prints it for a trace file from a shell; it runs `extensions/core-adapter/dialogs-cli.ts` through `node --experimental-strip-types` and needs Node 22.6 or newer.
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The usage footer (tokens, list-price cost, child launches, and `waiting <note>` while a `foreman_wait` is pending) is on by default (`footer.usage`). Below the editor, the children
widget (`widget.children`, on by default, TUI only) lists this session's subagent runs as `role · rung · state · ↑in ↓out · $cost`
(state `working`, or `ask` while a forwarded permission ask of that role waits) and its opened sessions as
`label · status · age`; runs that finished during the batch fold into one `<n> done` line. While any run is active the
widget keeps its height (it may grow when a run starts, padded rather than shrunk, at most 8 rows, one screen row each)
and updates in place, so the view does not shift; the run rows go when the last active run ends. It costs no model tokens. Outside Pi,
the `foreman` launcher in `bin/` (`.cmd` and `.ps1` on Windows) runs the same scripts: `foreman update-check`, `foreman retro [args]`, `foreman sync [args]`, `foreman backlog [args]` ([retro](retro.md)), `foreman findings list|dismiss|export` and `foreman retro models` ([review](review.md)), `foreman session` (below), `foreman radar` ([Radar](#radar)) and `foreman bench` ([benchmark](bench.md), including `foreman bench review`). The keys
and their layer rules are in the tables of [ceremony](ceremony.md) and [safety](safety.md) and in the schema
`config/foreman.schema.json`.

While an idle prompt-cache keep-alive window is open (`providers.<p>.cache`, on by default for `claude-bridge`) the
status line shows a keep-alive glyph (`♨`, or a nerd-font icon with `ui.symbols`). The refresh requests are not part of the
per-turn cost; `/foreman cost` sums them on a `keep-alive` line ([cache](cache.md)).

## Radar

`foreman radar` (`bin/foreman radar`, Python standard library, Linux, macOS and Windows) shows a live tree of the
running sessions: top sessions, the sessions they opened with `/foreman session` (recursively, so top, child
orchestrators and their children) and every session's subagent runs. It only displays; nothing in it controls a
session, and it works without Herdr.

```
pi-foreman radar                ⏳ 5  ⏸ 0  ? 1  ✋ 1  ✓ 1  ✗ 0    14:00:00
6 sessions · 1 tree · ↑2.1k ↓175 · $1.25 · oldest block 12s

⏳ top                  working    12s  ↑2.1k ↓175 $1.25
├─ ⏳ builder/strong    working    12s  ↑1.0k ↓100 $0.25
├─ ?  reviewer          ask        12s  ↑500 ↓50 $0.25
├─ ✓  explorer          done       12s
├─ ⏳ docs-fix          working    12s  ↑610 ↓25 $0.75
│  ├─ ⏳ builder        working    12s  ↑10 ↓5 $0.50
│  └─ ✋ api            blocked    12s  ↑600 ↓20 $0.25
└─ ⏳ tests             starting   40s

q quit · r refresh · c cost on/off · ↑↓ select · enter show session path
```

Each row: glyph, name (label, else role, else the cwd's name and the short session id), state, age of the last event, and the tokens
(`↑` in incl. cache, `↓` out) and cost of the whole subtree (a run shows its own). Header line 1: title, a count per glyph
(a zero count is dim) and the clock, right-aligned to the terminal width; line 2: sessions, trees, total tokens and cost,
and the oldest blocked row's age (omitted when nothing is blocked). Active rows sort first, then by start time.
Colors (16-color SGR): working green, blocked amber, starting teal, lost red glyph on a dim row, costs blue, ids, tokens and
tree lines dim; the age of a blocked row turns amber after 5 minutes and red after 15. Keys: `q` quit, `r` refresh now,
`c` cost on/off, `↑`/`↓` select a row (inverted band), `enter` shows the selected session's path (presence `cwd`, else the
handoff dir) under the footer.

Glyphs come from the `ui.symbols` set (`unicode` shown; `nerd` uses Nerd Font icons, table in
[Herdr sidebar](herdr.md#symbols)):

| Glyph | Meaning |
| --- | --- |
| `⏳` | working, or starting: registry entry `pending`, or `open` with no presence file yet and opened under 2 minutes ago |
| `⏸` | waiting: idle, or `stale` (no heartbeat for 15 minutes) |
| `⏳ <note> 4m` | on a Herdr line 2: no child runs and a `foreman_wait` is pending (state `waiting`); radar adds a `wait <note> 4m` column |
| `?` | asking: a run waits on an ask |
| `✋` | blocked: the session waits on a prompt |
| `✓` | done (also a closed session, a finished run) |
| `✗` | lost: presence file not `done` and no heartbeat for 90 seconds; or registry `open` with no presence file after 2 minutes; or `failed` |

Options: `--once` prints one plain snapshot (no ANSI) and exits 0; without it the screen is redrawn with ANSI codes
every `--interval` seconds (default 3) until `q` or Ctrl-C (no curses, so Windows works; a stdout that is not a
terminal behaves like `--once`, which also prints the footer). `--json` prints one snapshot as a JSON line and exits;
`--follow` prints one such line every `--interval` seconds until stopped (no ANSI, no keys; the Herdr sidebar plugin
reads it): `{"v":1,"now","symbols","roots":[node]}`, each node with `key`, `kind`, `name`, `role`, `rung`, `state`,
`sym`, `glyph`, `paneId`, `pid`, `cwd`, `age_s`, `blocked_s`, `own` and `tot` (`in`, `out`, `uncached`, `cost`), `done_children` and
`children`. The header also has `recentRunSeconds` (`radar.recentRunSeconds`, default 8: how long a finished run stays visible
as `✓ role` before it joins the done count), run nodes have `ended_s` (seconds since the run ended, or `null`) and session
nodes have `sid` (session id). `uncached` is fresh input plus cache writes; `in` still includes cache reads. `--symbols unicode|nerd` overrides `ui.symbols`. `--agent-dir` (default `PI_CODING_AGENT_DIR`, else `~/.pi/agent`). `--since HOURS`
(default 24) hides finished or lost sessions whose last activity is older, unless a descendant is still shown.
`--no-color` or `NO_COLOR` turns off colors (and with them the selection band).

Sources, all under `<agent dir>/pi-foreman/` and all optional (a missing or corrupt file is skipped):
`state/live/<sessionId>.json` (presence files, below), `state/sessions.json` (the registry above), `handoffs/*/`
(`parent`, `child`), `state/usage/<sessionId>.jsonl` (tokens and cost, read incrementally) and the mtime of
`state/trace-<sessionId>.jsonl` as an extra last-event signal. Sessions are joined by intercom id: a presence file's
`intercomId` or the registry's `child`; the parent is the presence file's `parentIntercom`, else the registry or
handoff `parent`. A session without a known parent is a root.

### Presence files

The extension writes `<agent dir>/pi-foreman/state/live/<sessionId>.json` atomically (temp file, then rename) on every
state change and on a 30 second heartbeat, and a final `state: "done"` at shutdown:

```json
{"v":1,"sessionId":"...","intercomId":"fm-top-1a2b3c","parentIntercom":null,"handoff":null,"label":"top",
 "cwd":"...","pid":1234,"mode":"tui","startedAt":"2026-10-09T10:00:00.000Z",
 "paneId":"w1:p2","heartbeatAt":"2026-10-09T12:00:00.000Z","lastEventAt":"2026-10-09T11:59:48.000Z","state":"working",
 "runs":[{"launchId":"...","role":"builder","rung":"strong","state":"working","tokensIn":0,"tokensOut":0,"cost":0}],
 "tokensIn":341000,"tokensOut":2300,"cost":0.47,"blockedSince":null}
```

| Field | Meaning |
| --- | --- |
| `v` | format version, `1` |
| `sessionId`, `intercomId` | the Pi session id (also the usage file name) and the id opened sessions record as their parent (the [opener intercom id](#opener-intercom-id) rule) |
| `parentIntercom`, `handoff` | the opener's intercom id and the handoff dir, or `null` for a top session |
| `label`, `cwd`, `pid` | display label (or `null`), working directory, process id |
| `mode` | `tui` or `rpc` (print and json runs write no presence file; bench runs in rpc and does) |
| `startedAt`, `heartbeatAt`, `lastEventAt` | ISO timestamps: start, last write by the heartbeat, last session event |
| `paneId` | Herdr pane id from `HERDR_PANE_ID`, or `null` outside Herdr |
| `state` | `working`, `blocked`, `waiting` (idle with a `foreman_wait` pending; Herdr's own status stays working), `idle` or `done` |
| `waits` | pending `foreman_wait`s: `id`, `kind`, `note`, `ageSeconds` (as of `heartbeatAt`), `leftSeconds` |
| `blockedSince` | ISO time the session became blocked, or `null` when it is not blocked |
| `tokensIn`, `tokensOut`, `cost` | the session's own model usage as its footer shows it (`↑` in incl. cache reads and writes, `↓` out, list cost); runs are not included |
| `runs` | subagent runs: `launchId`, `role`, `rung` (`model`, `strong` or `null`), `state` (`working`, `ask`, `done`), `tokensIn`, `tokensOut`, `cost` (used when the usage file has no line for that `launchId`), `model` (the launch's explicit model as given, else `null`) |

Rows of finished or lost sessions disappear from radar after `--since` hours; those files are not deleted.

A `done` session expires sooner: once its last activity (newest of `heartbeatAt`, `lastEventAt`, the trace mtime) is older
than `radar.doneTtlMinutes` (default 30; `--done-ttl MINUTES` overrides it) its row is hidden, unless a shown descendant
keeps it, and on each refresh radar deletes the presence file of a `done` session whose `heartbeatAt` and `lastEventAt`
are both older than the TTL (file mtime when neither parses). Only presence files with `state: "done"` are ever
deleted; unparseable or unreadable files are skipped. `working`, `blocked`, `lost` and `stale` rows never expire by age
(only by `--since`). A session that is not `done` and has had no heartbeat for 15 minutes shows the state `stale`
(the waiting glyph); between 90 seconds and 15 minutes it shows `lost`.

## pi-intercom

`pi-intercom` is bundled with the package (pinned); `foreman setup` filters it out with `--no-intercom` and otherwise writes
`<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if absent
(see [install](install.md)). Sessions then address each other by name or id; the close request above travels over
it as plain text `foreman:close`, accepted only from the recorded parent session.

## Herdr

Herdr's Pi integration (`herdr integration install pi`, installed by you, never by the installer) shows a session
as working, idle or blocked. pi-foreman emits `herdr:blocked` on `pi.events` while any dialog waits for you, so
the pane reads blocked ("?") instead of working. The foreman tree in Herdr's Agents panel is a separate plugin:
[Herdr sidebar](herdr.md). In a Herdr pane the session also pushes its own sidebar tokens (`sidebar.py push`, on every state change and every 5 s; Herdr's own `state_icon` shows the working state, `ui.spinner` is deprecated and ignored); see [who publishes what](herdr.md#who-publishes-what). Design record: `design/architecture.md`
[session features](../design/architecture.md#session-features-phase-4).

### Blocked shim

One tracker per Pi process counts what is waiting for you:

- any Pi dialog, from every extension (Pi's `ui_prompt_start` .. `ui_prompt_end`);
- each permission ask (`permissions:ui_prompt` .. `permissions:decision`, by request id), including a child's ask
  forwarded to this session;
- pi-foreman's own asks (checkpoint, guard confirms).

It emits `herdr:blocked {active:true,label}` when the first one opens and `{active:false}` when the last one closes,
so Herdr's counter stays balanced however they overlap. The end of a turn releases permission and own asks that never
got their decision (an open Pi dialog stays until Pi closes it); shutdown releases everything. Pi can orphan a
dialog that a second dialog replaces (it never sends that dialog's end); typed input then releases the stale dialog.
While such a dialog is unsettled Pi sends no `ui_prompt_start` for later ones, so pi-foreman's own asks also hold the
presence file's `state` at `blocked` directly (with or without Herdr); a Pi dialog's end or typed input does not
release an own ask that is still open.

Label: for a permission ask `<agent> · <tool> <first word>` (the requesting child's agent when forwarded; a path is
cut to its basename; leading `env` and `NAME=value` assignments are skipped (a quoted or `$(…)` value up to its closing quote or paren),
nothing after an `=` is shown, and a word that is not a plain command name is dropped;
never the full command), else the dialog title, else pi-foreman's ask title, else the dialog
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

## Background runs

The foreman-only `foreman_bg({command, note})` runs one shell command detached (its own process group on POSIX, not detached on win32; stdout and stderr go to
`<agent dir>/pi-foreman/state/scratch/<session>/wait-<id>.log`) and registers a `pid` wait with your `note`. It returns the wait
id and the log path at once; you end the turn and one message wakes you when the process has exited (the exit code is not
known: read the log). The command passes the same guards as a bash call, with no bypass: the overlay deny and ask rules, the
shell-write guard, the destructive guard and the git guard. A command that is empty or not a string is refused.
On Windows the command runs under `cmd.exe` while the guards read it as bash; see the
[known limit](safety.md#known-limit-background-runs-on-windows) (a `bash.exe -c` switch is a later item).

`foreman_wait` `pid` and `ci` waits take an optional `log`: a file inside the workspace, its `.workflow/`, `<agent dir>/pi-foreman/state/wait/`
or the session scratch dir. A path outside those, or one that is not a string, is refused and no wait is registered. The log is named in the wake line.

`/foreman waits` lists the session's pending waits: id, kind, note, age, time left and the last 5 lines of the log. The note is also what
the footer (`waiting <note>`), the presence file (`waits[].note`) and the Herdr sidebar line 2 show.

With the optional [background-tasks add-on](herdr.md#optional-add-on-background-tasks) installed, `foreman_bg` refuses and points at that
add-on's `bg_run` tool; `/foreman waits` then also lists its running tasks, and `bg_run` passes the same guards as bash.

## Further session keys

| Key | Meaning and layer rule |
|---|---|
| `sync.runRetro` | Run the retro step during `/sync`, before the repository commits (default `true`). |
| `radar.doneTtlMinutes` | Minutes after which `foreman radar` hides a finished session and deletes its presence file (default 30). Radar reads the harness, organisation and user layers, no project file. |
| `retro.proposalMinReviews` | Reviews needed before a retro proposal (default 5). User or overlay config only. |
| `retro.enabled`, `retro.workspaceKey`, `retro.backlogDir`, `retro.repoBacklog`, `retro.expireDays`, `retro.askThreshold` | Retro backlog switches and store (see [retro](retro.md)). `retro.enabled` null is on in tui and rpc, off in json and print. `workspaceKey`, `backlogDir` and `repoBacklog` are user or overlay config only. |
| `compaction.priceTiers.cheap`, `compaction.priceTiers.standard` | USD per MTok input upper bounds of the price tiers (1 and 5); above `standard` is premium. User or overlay config only. |
| `compaction.threshold.cheap`, `compaction.threshold.standard`, `compaction.threshold.premium` | Context fraction that triggers compaction per tier (0.85, 0.75, 0.6); a project or session can only lower each value. |
| `wait.batchWindowSeconds` | Window in which wait notices are batched (default 300). |
| `wait.maxActive` | Concurrent waits allowed (default 8); a project or session can only lower it. |
| `wait.ci` | CI waits on or off (default `true`); a project or session can only set false. |
| `close.autoClean`, `close.worktreeDir` | Cleanup at close and the worktree convention directory (see [close](close.md)). `autoClean` can only be turned off by a project or session; `worktreeDir` is user or overlay config only. |
| `herdr.blockedShim` | Show any open dialog or permission ask as blocked in Herdr (default `true`); any layer may set it. |
| `herdr.groupTag` | Herdr group tag on opened child and parent panes (default `true`); any layer may set it. |
| `ui.symbols` | Glyph set for radar, the children widget and the Herdr sidebar plugin: `unicode` (default) or `nerd` (Nerd Font); any layer may set it. |
| `widget.children` | Children widget below the editor in the TUI (default `true`); any layer may set it. |
