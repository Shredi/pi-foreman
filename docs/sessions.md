# Sessions and commands

> Covers `/sync`, `/retro`, `/foreman close`, `/foreman session` (open, brief, close, list), the usage footer, `bin/foreman`, pi-intercom setup and the Herdr blocked state.
> Read it when you end, hand over or wrap up a session, or script one from outside Pi.
> `/foreman close` is refused while a child run is still active (never cancelled); the session's own pending long waits are cancelled.

## Session commands

`/foreman session` opens a second pi-foreman session on a brief, talks to it over pi-intercom and closes it
again. All four subcommands are yours to type; a subagent child refuses every one of them.

- `/foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--plan-mode] [--first-command /CMD]… [--focus] [--dry-run] [--worktree [--base REF]] [--machine NAME [--trust]]`
  (with `--machine`, `--print-all` is refused: `remote_option`; `--plan-mode` and `--first-command` are checked on the remote; `--focus` runs `herdr-app do agent.focus` here)
  writes a handoff dir (below), starts `pi` in a new Herdr tab (or prints the command to run in a terminal)
  and records the session. The label is 1 to 40 characters of `A-Z a-z 0-9 . _ -`. `--plan-first` makes the
  brief ask for a `plan.md` and no builder before the plan phase ends (the child owns its plan, see [child orchestrator sessions](#child-orchestrator-sessions)), and sets the plan phase (`PI_FOREMAN_PLAN_PHASE=1`, see [ceremony](ceremony.md#plan-state-tier-source-and-plan-phase)); `--focus` focuses the new tab; `--dry-run` writes nothing
  (no handoff dir, brief, parent, child or registry entry) and prints the handoff path, the child id, the session
  model (`session model: <id>`, when `--model` is given) and the command it would run; no Herdr call.
  Example: `/foreman session open docs ./brief-docs.md --cwd ../site --model anthropic/claude-sonnet-4-5 --plan-first`
  `--first-command /CMD` (repeatable, at most 4) and `--plan-mode` are described under [First commands and plan mode](#first-commands-and-plan-mode).
- `/foreman session brief <target> <file|text…>` writes a brief into the session's handoff dir as `brief-<n>.md` and sends
  `Brief from <your id>: read <absolute path> and act on it` (the message names that file). A single word naming an
  existing file is copied; anything else is written as typed. See the message contract below.
  Example: `/foreman session brief docs ./more-context.md`, `/foreman session brief docs also cover the CLI flags`
  `/foreman session brief <target> --rework <file|text…>` also [sends the work back](#send-work-back). The flag counts only directly after the target; the same word inside the brief text is text.
  Briefs, rulings and `result.md` follow the package's `handoff` skill (`skills/handoff`).
- `/foreman session close <target> [result-path]` sends `foreman:close [result-path]` (see the contract below)
  and marks the registry entry `closing` once the send went out. The result path may use only `A-Z a-z 0-9 . _ / -`,
  at most 200 characters, and must end in `.md`. Example: `/foreman session close docs .workflow/result-docs.md`
- `/foreman session list` prints the registry: label, model, status, handoff dir, child id, for a remote entry `address: <label>@<machine>`, and the last report.

`<target>` is a registry label (the newest entry of that name) or a child id; any other text is passed to
pi-intercom as the address. Spaces in a brief path or `--cwd` do not survive the command line; use the CLI for those.

### Outside Pi

`bin/foreman session open|list|restart` (`.cmd` and `.ps1` on Windows) runs `scripts/foreman_session.py`:

- `foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--plan-mode] [--first-command /CMD]… [--focus] [--dry-run] [--worktree [--base REF]] [--machine NAME [--trust]] [--print-all] [--parent-id ID] [--profile NAME] [--agent-dir DIR]`.
  `--profile NAME` is accepted and ignored: permissions profiles are gone (see [permissions](permissions.md#profiles)). The launcher prints one notice on stderr.
  A session opened by another session asks for a gate decision in its own pane, like an owner session; it no longer files `ask.md` to its parent for that. A subagent child it launches asks in the pane of this session. Without a human at the pane (no UI) the call is denied at once. An owner who is away does not deny it: the dialog waits for the owner.
  Who is asked in a session opened with `--plan-first`: defects and gaps found by its plan review are revised and reviewed again, not asked about; a real decision of the owner's goes to the owner with `ask_user_question` (shown at the child's own pane, it is not routed to the parent); everything else goes to the parent in a message (see [a question to the parent](#a-question-to-the-parent)), by file (`ask.md`) only where intercom cannot reach it. A question is asked once: to the parent, or to the owner as a dialog when a human is at the pane and it is the owner's to decide, never both. At a `[review_loop]` stop the child reports the open findings to the parent in a message and ends its turn; the parent lifts the stop with a brief (see [ceremony](ceremony.md)). A remote child asks by file (`ask.md`), says at its pane that it waits and ends its turn; the answer comes as a brief and starts its next turn.
  `--print-all` prints both the POSIX and the PowerShell command. With `--machine`, `--print-all` is refused (`remote_option`); `--plan-mode` and `--first-command` go to the remote, which checks them; `--focus` runs `herdr-app do agent.focus` here. The parent id is `--parent-id`, else
  `PI_INTERCOM_SESSION_ID`, else `PI_INTERCOM_STABLE_ID`, else `stableId` in `<agent dir>/intercom/config.json`; without any, `open` is refused.
- `foreman session list [--json] [--agent-dir DIR]` prints label, model (`-` when none was given), state, handoff dir, child id and, for a remote entry, its address `<label>@<machine>` (before the `hc:` part). With or without `--json` it first settles the expired close attempts of remote entries and removes the leftover terminals of `closed` ones (see [Remote child sessions](#remote-child-sessions)): that can contact another machine, write the registry and end a program left behind after a `closed` notice, and only when an expired attempt or a `closed` entry not yet cleaned up exists. A machine that cannot be read costs one capped read, then its entries are left alone for ten minutes. The lines of that pass go to stderr, so the list, or the one JSON document, is all of stdout.
- `foreman session prune [--dry-run] [--agent-dir DIR]` marks `closed` (note `pruned: process and terminal gone`) the local `open` or `closing` entries whose process is gone (no live file with a running pid or a fresh heartbeat) and whose hc terminal or Herdr pane is provably not listed. Never touched: an entry with a live process, a still listed terminal, a terminal listing that could not be read (hc or Herdr unreachable: treated as present), a remote entry or one without a terminal record. `--dry-run` writes nothing. It prints one line per entry and the count. The radar applies the same convergence rule when it draws: such an entry shows as closed, never live or idle, so the Herdr sidebar converges without the command.
- `foreman session restart <label|child id|label@machine> [--json] [--dry-run] [--agent-dir DIR]` (and `/foreman session restart <label>` in Pi) starts a child session that ended (a crash, an update, a closed window) again in a new kept `hc` terminal with Pi as its program (`pi --session <file>`: its history, its link to the parent and its plan phase from the session's identity entry; the restart passes no permission profile, since profiles are gone). It is never typed into an existing shell. The new terminal is named as the open names it, nested under the child's recorded parent terminal when that one still lives (else under the caller's terminal, never `--no-parent`), and gets no `herdr.space` or `herdr.tab` label: a local child has no Herdr tab, the sidebar shows it as a row under its parent. The registry entry keeps its child id and gets the new `hc.address`; the child gets one appended message that it was restarted, as after a crash restart, and the sidebar row of the child is live again, so the owner answers its dialog there. Restartable: an `open` entry whose Pi is not running, and a `closed` entry that `prune` closed (`closedBy: "prune"`; an entry pruned before that field existed is known by its note). Refused: an entry a close flow closed (you closed it on purpose), an entry whose Pi still runs or whose session lock another run holds, an entry whose working folder is gone, a second restart of the same child while one runs, and the remote machine's own entry of a child that a remote parent opened (its `parent` is `<id>@<machine>`: restart it from the parent's machine). An entry on the herdr backend or without an hc terminal is not restarted for you: the command prints the line to start it by hand and exits 0. A resume by hand (`hc run … pi --continue`) is not tracked again by the registry: use this command instead. For a remote child (`label@machine`) the parent first probes the machine; an older pi-foreman there is refused with "update pi-foreman on <machine>" before anything changes. Then the remote runs the same restart (it refuses a child whose Pi still runs, and a caller that is not the child's parent) and returns the new terminal; the parent stores `<machine>/<t>` as the entry's address, ends the old local attach terminal and starts a new one, so notices from the new terminal wake `foreman_wait` kind `child` again. The herdr-app sidebar shows a **Restart** action on a child row that radar flags `restartable` (an ended local child, or a remote child whose terminal finished; a remote child that is only `lost` with a live terminal or an open entry is not ended and has none). It runs `foreman session restart <child id>` and closes no tab or pane. `--dry-run` says what would happen and changes nothing.
- `foreman session brief <handoff dir|label|child id> <text|file> [--rework] [--parent-id ID] [--agent-dir DIR]` delivers a brief to the
  child through pi-intercom (`cli.mjs send`, run without a shell). A handoff dir resolves through its `child` file, a label
  to the newest registry entry; a target with no handoff dir is refused. The brief is written to `<handoff dir>/brief-<n>.md`
  (n = the lowest free number from 1; the file is created exclusively, so an existing `brief-<n>.md` is never overwritten and
  a refusal is printed). A single word naming a file is copied there; anything else is written as is. The message is
  `Brief from <opener id>: read <abs posix path> and act on it` (the opener id as for `open`). Text briefs stay on disk. If node or pi-intercom is missing, or the broker refuses, the message
  is printed for you to send by hand and the exit code is 1; it never falls back to `herdr agent prompt`.
- The agent dir is `--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. A local child gets `PI_CODING_AGENT_DIR` set to that resolved agent dir when the opener has the variable set (its handoff dir lives there); a remote child never gets it.
- Exit codes: 0 ok, 1 usage error or refused, 2 Herdr failure (the command is then printed and the entry marked `failed`).

### First commands and plan mode

`--first-command /CMD` (repeatable, at most 4; each starts with `/`, is one line of at most 200 characters without control characters, else `open` is refused) makes the new session run Pi extension commands before the brief prompt. `--plan-mode` is shorthand for `--first-command /plan`: it comes first and is never repeated. `--plan-first` is unchanged and independent (it changes the brief, not the launch line). Without these flags the launch line is the same as before.

Status line: the launch command first prints one ASCII line in the new pane, `pi-foreman: starting session <label> (<model>) on <this computer|machine>, brief <path> ...` (the model part is left out when none is set; a remote session names its machine; no env values or tokens), so the pane is not blank while Pi boots. It is `printf` (POSIX) or `Write-Host` (PowerShell) followed by `;`, never `&&`, so a failed print cannot stop Pi. An hc child on POSIX runs as `sh -c 'printf …; exec "$@"'` around the same argv. The line is part of the printed fallback, the dry run and `launch.txt`.

Mechanism: the commands are positional messages of the launch line, ahead of the brief prompt: `pi "/x" "Read the handoff brief at … and proceed."`. `/plan` is the exception: the brief prompt becomes part of it as the last word, `pi "/x" "/plan Read the handoff brief at … and proceed."` (a bare `/plan` would open the plan-mode menu, so the brief rides on the command; `/plan start` or other `/plan …` text stays a separate word). Pi runs the messages in order and awaits each; a message starting with `/` runs as an extension command. The commands are quoted for POSIX and PowerShell, appear in the printed fallback, the dry run and `launch.txt`, and the registry entry gets `firstCommands` when there are any.

Requirement and residual risk: `--plan-mode` needs a `plan` command in the new session (a plan-mode package). The CLI cannot check that; the `/foreman session open` command and the tool refuse with `session open refused [plan_mode_unavailable]` when the opening session has no `/plan` command. A bare `/plan` message would open the plan-mode menu and wait for the user, which is why the brief rides on the command as `/plan <brief prompt>`. If another first command's handler starts a turn without awaiting it, the brief prompt that follows may fail to start.

### The foreman_session_open tool

A foreman session can open a session without bash: `foreman_session_open({label, brief, cwd?, model?, planFirst?, planMode?, firstCommand?: string[], summary?, focus?, dryRun?, worktree?, base?, machine?, trust?})` runs the same open as the command (same validation, confirm window and opener id); `machine` (a `sessions.machines` name, with `cwd`, the directory on that machine) opens a remote child, and `trust` records the remote folder's trust grant with it. It is refused in subagent children, which never get the tool. `foreman_session_open({model})` is the way to open a cheaper or a stronger child session: the session runs on that model, after the owner confirms the open. Design or new-topic sessions open with `planFirst: true` (`planMode: true` is retired for them); a session with an approved plan opens without.

The tool does not block on the owner. It waits `sessions.confirmWaitSeconds` (default 20; 0 waits without limit) for the confirm window; an open answered inside that wait returns its result in the same call; after that it returns `pending owner confirmation` (`details.decision: "pending"`, not an error) and the window stays open. The owner's later answer is reported as a `foreman_wake` message that wakes the foreman: Yes runs the open and the message names the label, the terminal, the handoff dir and the intercom id, says that the session is starting (`live.json` appears once it has started; `live` when it already exists) and how to wait for it (`foreman_wait` kind `child`); No sends `declined by the owner`; a failed open sends the label and the reason. Until then nothing is spawned or written. A repeated open for a label that is waiting answers `pending` without a second window; another label raises its own window at once (Pi stacks extension dialogs, newest on top, every one stays answerable, and the tool runs in parallel with other tool calls). A `foreman_wait` kind `child` on the label may be armed before the session exists: it resolves on the label's first notice after the open. Cancelling the tool call (its abort signal) withdraws a window still within the wait and opens nothing; if the UI could not withdraw it, the owner's late Yes still opens nothing and a wake message says so. A cancel after the owner said Yes does not stop the open (a half-made session would have no message): it runs to its end and its outcome is sent by wake.

A label that already has a registry entry that is not closed or failed is not opened again: the answer is `session <label> is already open in <terminal>, handoff dir <dir>`, with the intercom id and whether `live.json` shows it live, and no window is shown. If the worktree path of a `worktree: true` open already exists, the refusal `the worktree path exists: <path>` stays and names the registry session whose cwd is that path (open or closed), or says that no session is registered for it.

### Handoff dir and registry

`open` creates `<agent dir>/pi-foreman/handoffs/<YYYYmmdd-HHMMSS>-<slug>/` with:

- `brief.md`: your brief plus a footer telling the child how to report back (below).
- `parent`: the opener's intercom id, one line. The child's routing, close check and replies read it every time ([re-point an orphaned child](#safety)). The parent-id path works for a Pi parent only; other parents (for example a Claude session) are reached through the handoff files ([ask by file](#ask-by-file-parent-that-is-not-a-pi-session)).
- `child`: the child's intercom id, `fm-<slug>-<6 hex>`. The child also gets it as `PI_INTERCOM_STABLE_ID`.
- later, written by the child: `plan.md` (with `--plan-first`) and `result.md`, and for a question `ask.md`, `ask-<n>.md` and files below `work/`; no dialog for the write tool, `cp` and an `echo >`, `printf >` or heredoc redirect to these names. A subagent of a child session may write the same names.
- `reports.jsonl`, written by the report tool (not by the model): a copy of every fault the session and its subagent children report, see [Reports from remote and parent-opened sessions](#reports-from-remote-and-parent-opened-sessions).
- `live.json`: `{intercomId, piSessionId, at}`, written by the child's adapter at each session start. It binds the handoff dir to the Pi session. It is write-ask, like `parent` and `child`.

#### Identity after a restart

After a Herdr restart `pi` resumes the child's session file without the handoff env. The adapter writes a session entry `pi-foreman-identity` (Pi session id, child id, parent label, handoff dir, model, remote flag, session name) when a value changes, and restores it at the next start unless the start is a fork. It counts only if the entry's Pi session id is this session's id, the handoff dir's `child` file equals the entry's child id, and the handoff `live.json` names this Pi session id. A fork or a copied session file gets a new id and restores nothing. The parent id is re-read from the `parent` file. The restore sets the handoff, parent and intercom env, the parent label, the remote flag, the session name when empty, and the session model on startup and on resume. A `pi-intercom` loaded before core-adapter is unsupported: the id may already be published, so the adapter warns and asks for `/reload`.

`brief` and `close` also resolve the target by a Pi session id found in a registry entry's `live.json`. On `Session not found` they retry once with the `intercomId` in that `live.json` when it differs from the registry's child id. The retry target always comes from the handoff dir the registry entry names.

The child starts with `PI_FOREMAN_HANDOFF_DIR` (the dir), `PI_FOREMAN_PARENT_INTERCOM` (the parent id) and its
prompt "Read the handoff brief at <dir>/brief.md and proceed." The registry is
`<agent dir>/pi-foreman/state/sessions.json` (`{version, sessions[]}`, written atomically). An entry holds
`label`, `child`, `parent`, `handoff`, `cwd`, `opened`, `status` and `last` (`{kind, path, at}`). Status is
`pending` (command printed, not run by Herdr), `open`, `closing` (a close was sent), `closed` or `failed`.

### Send work back

`--rework` on `foreman session brief` (CLI, or `/foreman session brief <target> --rework …` in Pi) says that the brief asks for more work on a PR that the child already opened. Without the flag nothing changes.

- The side that writes the delivered brief also writes an empty marker file `rework-<k>` beside it in the child's handoff dir. `k` is the markers' own sequence: one more than the highest `rework-<k>` already in the handoff dir, created exclusively. It is independent of the brief and ruling numbers. If no number up to the highest one the child reads is free, the send-back is refused with an error and no marker is written. No brief text is read or parsed.
- The child looks for a new marker at its next tool call and at each PR watch tick. It then puts the PR it opened back into draft (see [draft handling](tools.md#draft)). A marker is handled once; one left on disk does not send the work back again.
- The PR leaves draft again only after a new `[pre-pr]` review PASS on the pushed head (see [review](review.md#readiness-of-a-pr)).
- A marker can only move a PR toward draft. A forged or stale one can do no more.
- With a remote child the flag travels with the delivery. A remote machine on an older version refuses a delivery that carries it; resend the brief without the flag.

### Message contract

Plain pi-intercom text, one line each:

- Child to parent: `Plan from <label>: <absolute path>`, `Result from <label>: <absolute path>`,
  `Update from <label>: <absolute path>`. They update the registry entry (`last`, `result`, status `open`) and
  show a notice; nothing is acted on. Only a registry child's id is accepted as sender.
- Child to parent, before its plan checkpoint (a local child at tier heavy): the plain line
  `<label> waits on the owner at its plan checkpoint`. It is information, asks nothing of the parent and updates no registry entry.
  When the owner answers that checkpoint, the parent gets one quiet line from its own timer (see below): `Child session <label>: plan approved by the owner.` / `plan sent back by the owner (revise).` / `plan rejected by the owner.`
- Parent side, after a local child's `Plan from`: the adapter appends one quiet line of its own (message type `pi-foreman-child-blocked`, no turn started) that says what the child waits for, from the child's `round-state.json` (tier, plan review, plan status): `<label> waits for: its own plan review and the owner's approval at its pane; nothing from you.` (heavy, no plan-review PASS yet, the state of a child that sent `Plan from` before its review and checkpoint), `… the owner's approval at its pane; nothing from you.` (heavy, reviewed), `… its own plan review, then it goes on to build; nothing from you.` (below heavy, not yet reviewed), `… nothing; it goes on to build.` (below heavy with a PASS, or approved) or `<label> waits for: unknown (no state); nothing from you is required.` The words are fixed; nothing the child wrote enters the line. A remote child gets no such line. The parent answers the `Plan from` in the turn it reads it: `no notes` when the child waits for the owner, `no notes, go on` only when the line says it goes on, or its notes as a brief; a note or ruling approves nothing.
- Parent to child: `foreman:close` or `foreman:close <path>`. The child runs its [close sequence](#commands)
  (result file, sync, exit) and replies `foreman:closed <result path> CLOSE: ready|open` before it exits; the parent's registry
  entry becomes `closed` with that result path. A close that is refused is answered with
  `pi-foreman: close refused: <reason>`, for example `the sender is not the parent recorded at spawn`,
  `N child run(s) still active; let them finish (a close never cancels them), then close again` or
  `N foreman_wait pending (…)` (only when a wait cannot be cancelled) or
  `PR #n open and watched (wait for the merge, or pr_unwatch)`: a session cannot close while a PR it watches is open; it waits
  for the watch to report the merge (see [close](close.md#close-refused-while-a-pr-is-open)).
- The child's brief footer tells it to re-read `parent` before each message (the parent can change).
- Parent to child brief: `Brief from <opener id>: read <absolute path> and act on it`, the path being `<handoff dir>/brief-<n>.md`.
  `n` starts at 1 per handoff dir and takes the lowest free number (a gap is filled); an existing `brief-<n>.md` is never
  overwritten, and a name that appears during the write is refused. A text brief is written to the same kind of file and stays
  on disk. A parent-written `brief-<n>.md` lifts the child's loop stop and resets its read budget (see [ceremony](ceremony.md)).
- Child to parent, a question: a plain `send` whose first line starts with `Question`, for example `Question from <label>: …` (long detail goes into a file in the handoff dir that the message names). The parent answers with a plain `send`; a message lifts no stop, a brief does. A `Plan from` line is not a question. See [a question to the parent](#a-question-to-the-parent).

### A child after a merge

A child that opened a PR watches it itself (the parent does not watch child PRs) and reports the parent only that the PR is
ready to merge (or, when the checks passed but a draft state, a review or a branch rule holds it back, the line the watch gives), or why it is stuck. Then the child waits: no session merges a PR, and the watch reports the merge. A review or comment that arrives meanwhile is feedback the child acts on. A child never closes itself, a merge included: it may have more work (more PRs, open ledger items). When a PR of the child is merged (the watch reports `merged`), the child says so once in its pane and once to the parent (`PR #n merged; <label> stays open: it sends Result from when its brief is done, then close it with foreman:close (a session never closes itself)`; a remote parent gets no line, the pane only) and goes on with its brief. When the brief is done it writes `<handoff dir>/result.md` (PR numbers, merge commits, anything left open) and sends `Result from <label>: <path>`; the parent reviews it and sends `foreman:close` (the owner's `/foreman close` in the child's pane closes it too). A close after a merge runs the worktree and branch cleanup (a refused cleanup reaches the parent as a `PR #n merged, closing (cleanup: not started (<reason>); ...)` reply before the `foreman:closed` line): the close archives the child's `.workflow/` files (a linked worktree keeps every regular file whatever its age; the written-since-start rule is only for the main checkout's shared `.workflow/`; capped at 16 MiB, never `closed/` or `archive/`, no links; see [Self-finish on merge](close.md#self-finish-on-merge)) into `<handoff dir>/workflow/` and exits.
A detached process then removes its worktree and local branch and writes `<handoff dir>/cleanup.json`; a failed precondition
keeps both and is named in `result.md` and in the message to the parent. A PR closed without a merge starts nothing: the child
reports `PR #n closed unmerged` and waits for the parent. See [close](close.md#self-finish-on-merge).

### Closing the children with the parent

`/foreman close` also closes the session's own child sessions: after the result turn and before the sync, every
registry entry whose `parent` is this session's opener id and whose status is `open` or `pending` gets
`foreman:close` over pi-intercom and turns `closing`. The registry is then polled (every second) for up to
`close.childWaitMs` (default 60000; `0` = send and do not wait). The close notice lists one line per child:
`closed`, `refused (<reason>)` (the child answered `pi-foreman: close refused: …`; the entry goes back to `open`),
`timeout after <n> ms` (the child may still close later) or `not sent (<status>)`. A child that does not close never
fails or delays the parent's close beyond that bound.

### A question to the parent

Where intercom reaches the parent (local Pi sessions), the message carries the question and the answer. The child sends its
parent one plain `send` whose first line starts with `Question`, with long detail in a file in the handoff dir that the
message names, and then ends its turn. It does not use the blocking intercom `ask` and does not `foreman_wait` for the answer:
a blocking ask fails after ten minutes, and a parent inside a long tool call may read it only after that. The parent's answer
is a plain `send` and starts the child's next turn; a decision of the owner's goes to the owner first, then to the child.
The parent's rule is to answer in the turn it reads the question, or to tell the child when. A message answers a question
but lifts no stop: a review-loop stop and the read budgets of a child are lifted by a brief (see [ceremony](ceremony.md)).
Nothing marks the child as blocked and nothing is shown for it; a question to the owner is a dialog and shows as before.

A parent that does not answer is reminded once (see [a child that waits on the owner](#a-child-that-waits-on-the-owner)).
The child runs no turn while it waits, so it costs nothing; it ends by an answer, by the owner typing at its pane, or by closing it.

A remote child's footer does not use intercom: it asks by file (below), and the answer comes as a brief. A plain intercom message from the child's own parent (not another sender, not one from another machine) answers an open `ask.md` too: the child's parent badge (`blockedOn: parent`) closes. An owner dialog of a session on another machine (a checkpoint, a question) is answered in that session's pane only (`hc attach <machine>/<t>`); the notice text of a remote plan or ask names it, and so does a pending checkpoint: no file or message answers a checkpoint.

### Ask by file (parent that is not a Pi session)

Only where intercom cannot reach the parent: a parent without a pi-intercom connection (for example a Claude session) cannot receive an intercom `send`; the child's
`send` fails with `Session not found`. A remote child asks this way too. The brief footer then names a file contract in the handoff dir:

| File | Written by | Content |
|---|---|---|
| `ask.md` | the child | first line `# Ask <n>: <topic>` (n = 1, 2, …), then the question and options |
| `brief-<n>.md` | the parent | the answer: a brief, delivered with `foreman session brief` |

The child writes `ask.md`, says at its pane that it waits for the parent and ends its turn; it does not `foreman_wait` for the
answer. pi-foreman writes no marker file, and the parent's radar shows no ask row (number and topic) for a local file ask. The
parent reads `ask.md` in the handoff dir and answers with a brief, which starts the child's next turn. The child never uses
`herdr agent prompt`.

The session's own `ask.md` (`ownask.ts`) is open while the same handoff dir holds no answer file that is not older than it (an equal modification time counts as an answer) and typed input at the pane has not closed that version of it. An answer file is a brief (`brief-<x>.md`) or a numbered `ruling-<n>.md` (n at least 1) from a parent on the old footer. A plan ruling (`ruling.md`, `ruling-plan.md`), a `brief-<x>.md` that is a byte copy of one, and a steer are not answers. Typed input is remembered in memory only: after a reload, an `ask.md` that was answered at the pane shows again until a brief arrives. While it is open the session shows "needs you" (Herdr `blocked`) with the label `ask <n>: <topic>` from the header, or `ask` when the first line is not `# Ask <n>: <topic>`, and the turn may end without the finish checks until the next message, wake or typed input. The end of the turn drops only the Herdr `blocked` signal (a reload or a new session start, which check afresh, and a new `ask.md` version raise it again); the live file keeps "needs you" and `blockedOn: parent` until a brief, typed input or a plain intercom message from the parent answers the ask.

- **`ask_user_question` (foreman only).** When a human is at the pane, the foreman can also raise a structured question.
  The tool comes from the bundled `@juicesharp/rpiv-ask-user-question` (exact pin in `package.json`; `foreman setup`
  installs it, `foreman doctor` fails when it is missing): `ask_user_question({questions: [{question, header, options:
  [{label, description}], multiSelect?}]})` takes 1 to 4 questions with 2 to 4 options each, a `header` chip per question
  and a type-your-own row, and blocks the turn until answered. `n` adds a note to a question or a global note on the Submit
  tab; they come back as `user notes: ...` / `global note: ...` in the answer, and Esc cancels. The harness registers no
  such tool itself; it keeps a hook keyed on the tool name: `tool_call` counts the dialog (`foreman_dialogs` family
  `ask_user_question`). The answer to a dialog is never filed as an answer file, whether or not an `ask.md` is open.
  The package's `details` are never rewritten. A question goes either to the
  parent or, when a human is at the pane and it is the owner's to decide, to the owner as a dialog, never both. Without a human at the pane the package does not register the tool; ask by file (`ask.md`, the file path
  above) then.
- **Open is recomputed from the files**, never a sticky flag (the rule is under [ask by file](#ask-by-file-parent-that-is-not-a-pi-session)). Session start, a message or wake, writes by the write/edit tools and a `bash` result recompute it; typed input closes the open version; shutdown releases it.
- **A stale ruling is ignored.** A `ruling-<n>.md` whose mtime is older than `ask.md` does not wake the wait (it keeps waiting).
- **A file wait on a ruling is a plain file wait.** A file wait on `ruling.md` or `ruling-<n>.md` ends only when that
  file arrives; a newer `brief-<x>.md` does not end it.
- **A parent ruling never satisfies the finish gate.** A `ruling.md` or `ruling-<n>.md` (first line `APPROVED` or `SHIP`)
  from the parent does not close the reviewer step: only a reviewer verdict does. After a FAIL the finish refusal names
  the newer ruling and says the chair runs `/ceremony <tier>` to override; `/foreman close` lists what is still open and
  what the parent would have to rule.
  Only handoff dirs whose `child` file names this session count (for the ask state too); a dir where this session is the
  `parent` never does. **Who may write a ruling file:** only the parent. A session's write, edit, `foreman_copy` /
  `foreman_move` destination, or `bash` / `powershell` / `bg_run` command that writes `ruling.md`,
  `ruling-<n>.md` or `brief-<x>.md` in a dir where it is the child is refused up front ("a session cannot write its own
  parent's ruling"). This is the literal self-ruling refusal (`selfRulingRefusal` in `ruling.ts`), run in the `tool_call` hook
  before the gate. For a shell line it catches a redirect (also `2>`), `tee`, `cp`, `mv`, `rm`, `install`, `rsync`, `dd of=`,
  `truncate`, `touch`, `sed -i`, `sort -o`, `curl -o`, a git `--output=` and `ln -s` onto it, inline `python3 -c`, `node -e` and
  `perl -e` code, `bash -c`, a bare name after `cd <own handoff dir> &&`, a directory spelled with a variable (bound on the
  same line, or unbound), an unquoted glob in a write target that can match a ruling or brief name in the own handoff dir
  (`ru*.md`, `r?ling.md`, `*.md`, `[r]uling.md`, `handoffs/*/ruling.md`; judged by the text before the first glob
  character), and a bare or relative ruling name written after a `cd` or `pushd` to a directory the line cannot resolve
  (`cd $X`, a directory that does not exist yet). It does
  not refuse a write through a symlink whose own name is no ruling name (the write lands; a shell write, and a write or edit tool write whose real path is a ruling name, count as self-written and stay ignored),
  a `ln -s` that has the ruling only as its source (the link is no write onto the ruling),
  or `ruling-<name>.ack` and `ruling.md.bak` (no ruling files). A builder's redirect, `tee`, `cp`, `mv` or write tool onto
  such a file is also refused by the gate (`child-write-outside`). Writing a ruling into a dir where the session is the parent
  (answering its child) is allowed (`default-write-handoff-ruling`, `path-write-handoff-ruling`). Reading a ruling and
  copying from it (`cat`, `grep`, `cp <handoff dir>/ruling.md .workflow/scratch/r.md`) is not asked about and not refused:
  the ask that used to follow a line touching a ruling file is gone. A line that only mentions a ruling in text (`echo "see
  ruling.md"`, `git commit -m "read ruling.md"`) is not refused either. `git ls-remote` is a read
  (see [safety](safety.md#owned-paths)). This refusal is defence in depth, since a ruling cannot satisfy the gate anyway; a ruling file this session
  still changed is ignored until the parent writes it again (a newer mtime). Self-written marks live in memory.
- **Child input dirs.** A child should write the files it passes to a command (its `git commit -F` message file) into
  `$FOREMAN_SCRATCH` or `<worktree>/.workflow/scratch/`; `.pi/scratch/` is the main session's dir. The gate does not enforce
  this: a builder's write-tool write onto `<worktree>/.pi/scratch/m.txt` is allowed (`path-write-worktree`), and its
  `git tag -F <file>` is not denied, whatever file it names (a reviewer or explorer is refused `git tag` in its worktree as
  `child-readonly-write`).
- **`bg_wait` during a builder's supervisor ask.** pi-foreman does not refuse it (`bg_wait` is exempt from the supervisor window).
  The pi-subagents package (node_modules, not editable here) ends the wait with "Wait yielded for a pending supervisor
  request"; background work continues, so answer with `subagent_supervisor` and call `bg_wait` again.
- **A wake during a run is delivered after the run settles.** An idle session is started by the `foreman_wake` message at once.
  When the waits resolve while a run is active, the outcomes are held (not sent as a follow-up into that run) and go out as one
  message with a turn trigger after the run's `agent_settled` and the reset of its stop-gate state. The wake therefore runs as
  its own run (trace `turn` cause `wake`) with its own stop hold. A session shutdown drops a held wake. Exception: a run started by an intercom message (trace `turn`
  cause `intercom`) takes the wake at once as a follow-up, for every other wait kind and for the notice of a remote child (the remote watcher),
  so that wake costs no extra turn. Only a child notice that came as an intercom message while a run is in progress (whoever started the run) is already in that run,
  so its wait ends with one quiet line of its own message type, `foreman_wait_note`
  (`foreman_wait <id> (child) "<note>": ended by the notice above: child <label>: <kind> <path>`; shown, no turn, no `foreman_wake`, trace `wait` decision `taken`),
  and the run's turn cause stays as it was. With no run in progress an idle session is started by the wake; a session that is not idle (a compaction) gets the wake
  as a follow-up only when the last turn cause is intercom, otherwise the wake is held until the session settles. On Pi before 1.2 the intercom message starts its run
  only after the adapter saw it, so the doubled turn stays there.
- **A restart loses the waits.** `foreman_wait` waits live in the process, so a restart (`pi --continue`,
  `--session <id>`, `/reload`) ends them without a wake. The active set is stored in the session file (`pi-foreman-waits`
  entry, keyed by the Pi session id); at the next start of the same session the agent gets one `foreman_wake` message
  `foreman_wait lost on restart: …` listing the lost ids, kinds and notes, and starts again what it still needs (trace `wait`
  decision `lost`). Nothing is reattached; a pid is not reattached because the process may be gone or reused. `pr_watch`
  watches do resume, without a deadline (see [tools](tools.md#watch)).

Worked example:

1. The child writes `<handoff dir>/ask.md`:
   ```
   # Ask 1: which schema for the export?

   A: flat CSV. B: nested JSON. I lean to A.
   ```
   The child says at its pane that it waits for the parent and ends its turn.
2. The parent reads `ask.md` and answers with a brief: `foreman session brief <label> <file>` with `A, flat CSV.`
3. The brief starts the child's next turn; it reads `brief-<n>.md` and continues.
   The next question is `# Ask 2: …`, answered the same way.

### A turn that ends under a wait

A foreman turn that ends while a `foreman_wait` of any kind (timer, file, pid, ci, child) is active, a subagent it launched is running, or one of its `bg_run` tasks (bg tasks of this pi process only; records of an earlier crashed process do not count) that notifies and triggers on completion is running, is a pause, not a finish: each of those starts the next turn by itself, so neither the ledger stop guard nor the ceremony finish gate runs (trace `finish_gate {skipped: pending_wait, runId: <ids>}`; the stop guard's once-per-session reminder and the refusal count stay unspent). When the wait resolves or is cancelled and nothing else is pending, the next turn end is gated as usual. A wait that never resolves keeps the gates quiet until its own timeout wakes the session.

### A turn that ends after a message to the parent

A successful intercom `send` from a session to its parent (the id in its handoff `parent` file: a send to that id, or to an id prefix of at least 4 characters, counts; a send by name counts only once the parent has sent this session a message under that name; a send held in the broker mailbox counts) lets its turn end without the ceremony finish checks, as a file wait on its parent does. The next inbound intercom message, `foreman_wait` wake or typed input clears it, also when the message arrives in the same turn, and the checks run again. It is kept in memory only: a reload clears it, and nothing is displayed, written or added to the live file for it. (`foreman_hold` is the deliberate form for a wait on the owner: see [ceremony](ceremony.md); it is kept across a reload and shown as "Needs you".) A failed send, or a send to another session, does not set it.

### A child that waits on the owner

A child session waits on its owner while one of its dialogs is open: a guard approval, an `ask_user_question`, a checkpoint or script proposal, a confirm dialog, or any other Pi dialog. A wait on its parent (ask by file, a gate ask waiting for the parent's ruling) is not a wait on the owner. A child that holds the dialog for its own subagent's permission question is blocked on its owner (kind `approval`) and is reported like any other dialog. The parent session detects it; the child sends nothing and cannot word it. A 60 s timer in the parent reads its own children (the registry entries whose `parent` is this session): a local child through its live file (see [presence files](#presence-files)), a remote child through the state the remote watcher stored in the registry (`remoteLive`) and the watcher's last contact, which must be recent (a remote child with an open ask is skipped: the remote state does not say who it waits on). A live file whose heartbeat is older than 90 s is a dead session and says nothing.

After `sessions.blockedNoticeSeconds` (default 600; `0` turns this notice and the reminders for an unanswered question below off (local and remote); user or overlay config only) the parent gets one custom message of its own type, `pi-foreman-child-blocked`: `Child session <label> has waited on its owner since <time> (<kind>). Information only: … do not answer or approve for it, do not steer it, redo its work or work around it.` It is a message, never system text, and it is not a `foreman_wait` wake: an armed `foreman_wait` stays armed and the finish gate is not touched. It starts no turn: it is shown and appended, and the parent reads it at its next turn. The text is fixed words plus the registry label, a time and one of the kind words `approval`, `question`, `checkpoint`, `script`, `confirm`, `dialog`; nothing the child or its dialog wrote enters it. Once per wait (keyed on label and the start of the wait, kept in `<agent dir>/pi-foreman/state/child-blocked/<session id>.json`, so a reload sends nothing twice), no repeat. A dialog answered before the delay sends nothing; one that ended after a notice sends one quiet note that starts no turn. "Answered" is said only when the child stored an answer: each dialog that returns writes `lastAnswer` (kind word, time, outcome `answered` or `dismissed`; no dialog text) to the live file, and the parent says "answered" only for an answer at or after the start of the wait, "dismissed" for an Esc or cancel. A session that started again after the wait began says `ended by a restart of the session … not answered; the child asks again`; a live file with neither says `ended after <duration> without a recorded answer`; a remote child, which shows only its state, says `is no longer waiting`; a hold ends with `no longer holds for the owner`.

A dialog a restart ended is asked again, never replayed. While an owner dialog is open the session keeps `<agent dir>/pi-foreman/state/open-dialog/<session id>.json` (the kind, the tool, and what the dialog showed: the questions of `ask_user_question`, the plan path of a checkpoint, the call summary of a guard dialog); an answer or a dismissal removes it, a shutdown leaves it. At the next start of that session the file produces one custom message (never system text, so the prompt cache holds) that says the restart ended the dialog, that no answer was given and nothing is replayed, and asks the child to ask the owner again; the file is removed at once, so a second start sends nothing. The kind words a notice prints include `hold`. When the owner answers a local child's plan checkpoint (approve, revise or reject; the child records only that word and a time in its live file as `lastCheckpoint`), the parent gets one quiet line naming the answer, merged into the "answered" note when that same pass clears an announced wait; an answer older than the parent session's first start (kept in the same state file, so a reload does not move it) is not replayed, `blockedNoticeSeconds: 0` also turns this line off, and a remote child reports by its usual path. The notice grants nothing and no agent answers another session's dialog: the owner answers in that session's pane.

One more quiet notice of the same type covers a local child idle at its plan: when its plan phase is open (`round-state.json`: nothing built, plan not approved, a missing plan review included) and its live file says `state: idle` (not working, not blocked on the owner) for longer than `sessions.blockedNoticeSeconds` (measured from the live file's `lastEventAt`), the parent gets `Child session <label>: idle at its plan for <duration>; waits for: <the same fixed text as the line above>.` Once per episode (the same state file, a key with the kind word `plan`), no wake, and no "answered" note when it ends. A child blocked on its owner gets the notice above instead, never both. `0` turns it off with the rest (trace `child_plan_idle_notice`).

A local child's file ask is no longer reported to the parent: the parent's tick sends no notice for an `ask.md`, and the live file has no `asks` field.

A question that a local child sent as an intercom message (first line starts with `Question`, see [a question to the parent](#a-question-to-the-parent)) is remembered by the parent: one record per open child session, with the label and the time, never the text, in the parent's memory only (a reload loses it). The record goes when the parent sends that child a message, when a `brief-<n>.md` or `ruling-<n>.md` newer than it appears in the child's handoff dir (not `ruling.md`, `ruling-plan.md`, `steer-<n>.md` or a brief that is a copy of a plan ruling), or when the child is closed. A record still there after `sessions.blockedNoticeSeconds` gets one message of the same type with the label and the age (`Child session <label> has waited <age> for your answer to its question …`); it wakes an idle parent, unlike the waits-on-its-owner notice, and it is sent once per record (trace `child_question_reminder`). A question without the word `Question` gets no reminder.

The footer of a remote child does not use intercom, so its question is its `ask.md`. While the watcher holds that ask in the registry (the mirrored file, see [remote ask](#remote-child-sessions)) and it is older than `sessions.blockedNoticeSeconds`, the parent gets one message (`Remote child session <label> has waited <age> for your answer to its ask. Answer it with a brief …`, trace `child_question_reminder` with `remote`). It starts a turn on an idle parent. It is sent once per ask: a new ask (a new notice number) is reminded again. The state is in memory and rebuilt from the registry, so after a reload of the parent an ask that is still open and older than the setting is reminded once more. `foreman session brief <label> <file>` is the answer: it clears the ask, so no reminder follows. `0` turns it off.

What a watching session reads without the parent's help: the live file of the child, always written and refreshed every 30 s, with `state`, `blockedSince`, `blockedOn`, `blockedKind` and `ownerBlockedSince`. With `trace.enabled` on, the trace also holds `blocked_open` and `blocked_closed` (`on`, `kind`, a short `label`, and `waitedMs` on the close; exactly one `blocked_open` and one `blocked_closed` per dialog: a dialog the harness classed is recorded with its class and kind, a Pi dialog nobody classed as `owner`/`dialog`, and a wait on the parent is its own pair) and, in the parent, `child_blocked_notice` and `child_blocked_cleared` (`label`, `waitedMs`) and `child_checkpoint_answer` (`label`, `decision`). With tracing off (the default) only the live file shows it. The gate log keeps its meaning (verdicts) and has no dialog record. A dialog Pi drops without its end event leaves the wait open until a later prompt end or typed input; the sidebar shows the same.

### Steer while a child runs

While a foreman's launch-wait holds a child's result, the adapter polls `$PI_FOREMAN_HANDOFF_DIR` every 2 s for a `ruling*.md` or `steer*.md` file that is new or has a newer mtime than the one already delivered (files present when the first wait starts are the baseline). The first one found ends the wait early: the launch result says the run is still running, then the file text (first 4 KB, marked as data, not instructions); continue with `bg_wait <runId>`. Each file version is delivered once. With no `PI_FOREMAN_HANDOFF_DIR` nothing is polled. The `launch_wait` trace event reports `outcome: steer`.

### Child orchestrator sessions

A heavy task with several phases may run as a multi-session plan: one child session per phase, each in its own worktree, opened with `foreman session open <label> <brief> --plan-first`. The parent reviews each phase before the next.

- **Model.** The session runs on `--model`, else the mapped `session-foreman` model (`providers.<p>.roles.session-foreman.model`, the own provider then its fallback), else the opener's own model; `open` prints `session model: <model>`. Only an explicit choice (`--model` or the mapped `session-foreman` model) is passed on as `--model`; the opener's-model fallback is displayed but not passed, so that child does not get `PI_FOREMAN_SESSION_MODEL` and keeps its role thinking. An explicit `--model` wins over the overlay/preset foreman role model (model and thinking) in the child: it gets `PI_FOREMAN_SESSION_MODEL=<model>` and keeps the model it started on. There is no rank rule for sessions.
- **Confirm window.** `foreman_session_open` and `/foreman session open`, local and `--machine`, first show the owner a Yes/No window (Herdr shows the pane as blocked) with the label, the model, the cwd, whether a worktree is created and its base, plan-first and the machine (or local), in the owner-dialog shape: a plain question (`Open a new session <label>?`), a short summary, the facts, the details dimmed, a link to the brief (`.md` or `.txt` only, a plain path line where the terminal has no links) and an answers line that starts with the marker sign `▸`; the dialogs strip from all other text every Default_Ignorable, format, private-use and unassigned code point and these sign blocks: Arrows (U+2190-21FF), U+22B2-22B5, Miscellaneous Technical (U+2300-23FF), Box Drawing, Block Elements and Geometric Shapes (U+2500-25FF), U+2794-27BF, U+27F0-27FF, U+2900-297F, U+2B00-2BFF, U+1F780-1F8FF, U+2023, U+1405, U+FF1E, U+203A and U+00BB, so model text cannot show the marker or forge an answers line (a plain `>` stays ordinary text and is not the marker). The summary is the optional `summary` parameter of the tool (at most 300 characters), else the brief's first heading, else `A new session for <label>.`; the brief's lines are no longer shown. The command waits without a timeout; the tool waits `sessions.confirmWaitSeconds` and then answers pending (see "The foreman_session_open tool" above). Yes opens the session; No refuses with `session open refused [owner_declined]`, and nothing is spawned or written. Without an interactive Pi session (print or json mode) the open is refused with `session open refused [no_ui]`; open it with `foreman session open` in a terminal instead. A brief that is not a readable regular file (for example a text instead of a path) is refused before the window, also for `--dry-run`, with `session open refused [brief_unreadable]`; the terminal `foreman session open` refuses it too. `--dry-run` shows no window and works without a UI. The plain CLI (`foreman session open`) shows no window: a shell `foreman session open` run by an agent takes the normal permission path of its bash call and no confirm window, so only the tool shows the window. The tool has no skip rule: an open made right after another dialog was answered still asks. See [roles](roles.md).
- **The child owns its plan.** The child records its tier (`foreman_triage`), has its plan reviewed (`[plan-review]`) until it passes, writes `plan.md` and sends `Plan from <label>: <path>` as information; it does not wait for an answer: after sending it the review is done and the child goes on to its next step (below heavy it builds; at heavy it sends the waits-on line and calls the checkpoint), never idle waiting for the parent. Below tier heavy the plan review's PASS on the current plan version ends its plan phase (`foreman_checkpoint` is refused there). At tier heavy the child calls `foreman_checkpoint` and the owner answers in a dialog in the child's own pane; a local child first sends the plain line `<label> waits on the owner at its plan checkpoint`, a remote child sends nothing (the parent learns it from its own check, see [a child that waits on the owner](#a-child-that-waits-on-the-owner)). Only a child opened with `--plan-first` is told to send that plain line; the parent's `waited on its owner` notice covers every child, so a heavy child opened without `--plan-first` reaches its parent through the notice alone. After a reload or resume (not a fork) a child's approval comes back only from its own session entry: the owner's dialog answer in this session, for the plan version it approved; an edit of the plan voids it. A child never reads the approval store under `state/approvals/`, which keys an approval by the plan's text (its version hash) and keeps no session or plan path, so an approval of the parent's plan, or of another plan in a shared scratch dir, never opens a child's builders; a child whose session file is lost asks the owner again. A session without a parent restores from the store when its entry restored no plan record (the newest stored approval of a plan file now in its scratch dir). A fresh `foreman_checkpoint` call does not read the store and opens the dialog. `ceremony.checkpoint: parent` is refused (`[checkpoint_parent]`). The parent reads `plan.md` and sends notes, corrections or owner decisions as a brief (`foreman session brief <label> <file>`); a brief that changes the plan makes a new plan version, which the child has reviewed again and, at heavy, takes to the checkpoint again. A `ruling.md` or `ruling-plan.md` a parent still writes is delivered as a note and approves nothing; a delivered `ruling-plan.md` also does not clear a pending ask (see the remote ask under [remote child sessions](#remote-child-sessions)). The parent reviews `result.md` before it opens the next phase, then closes the child with `foreman:close`.
- **What is weaker than with a parent's approval.** No second session reads a child's plan before it builds: the parent reads it alongside, and its notes come as briefs. A standard child's plan is seen by no human: its own plan review is the only check before builders. A heavy child cannot start building while the owner is away: its checkpoint stays pending until the owner answers in its pane. A heavy remote child's dialog is answered by attaching to its pane on the other machine; this path was read in the source, not shown live, and is listed for a hand test on a second machine.
- **Reload in a session opened by another session.** With `PI_FOREMAN_HANDOFF_DIR` set, the adapter keeps `<handoff dir>/round-state.json` itself: the handoff dir, the topic and version hash of the checkpointed `.workflow/scratch/plan-<topic>.md`, that plan's `[plan-review]` verdict and round count, the round state (a `round` object: whether a builder ran and whether a review is open) and the loop-guard reset watermark. It never keeps an approval; the `tier`, `reviewPassed` and `planOpen` fields it also holds feed only the parent's `waits for:` line and are never restored. On `/reload` the file counts only when its handoff dir is this one and its hash equals the plan file now; else it is discarded and the plan goes through the ceremony again (plan review, `foreman_checkpoint`). The checkpoint approval, always the owner's dialog answer, comes back only from the session's own state entry (never from the approval store), only for the plan version it approved; no file from the parent (`ruling.md`, `ruling-plan.md`, a file with `approved: true`) grants it. The rulings a chain already used, its last refusal and the security-exempt flag do not come back. An owner prompt or a tier change rewrites the file, so cleared counters stay cleared. The restored approval lets builders launch; the finish gate still needs a reviewer PASS. Without `PI_FOREMAN_HANDOFF_DIR` nothing is written or restored.
- **Message contract.** Besides `Plan from|Result from|Update from <label>: <path>`, a registry child may send the aliases `foreman:plan <path>` and `foreman:result <path>`; the label is taken from the registry entry of the sender. `foreman:closed <path>` is as before.
- **Waiting.** `foreman_wait({action: "start", kind: "child", label})` resolves on the next plan, result, update, ask or closed notice of the registry child `label` (or of any child with `label: any`; a wait naming the label wins over `any`). There is at most one child wait per label (`any` included): a second start returns the first wait's id and keeps its note. The wake line is `child <label>: plan|result|update|closed <path>`. A child's refusal of a close (`pi-foreman: close refused: <reason>`) wakes the same wait with `child <label>: refused <reason>`. Race: a plan, result, update or closed notice that arrives before the wait starts is not replayed; check `/foreman session list` (the registry's `last`) first. A local child's file ask is not replayed. A remote child's notice goes to an armed child wait first: with one armed (for its label or `any`) the wait takes the notice and the parent gets no message; without one the parent gets the `pi-foreman-remote-notice` message above, so a notice is never dropped for want of a wait.

### Parallel rounds

Every orchestrator session works in its own worktree (`git worktree add …`) and never switches the shared main checkout. Its commits and pushes happen from the session's worktree, so two sessions running in parallel cannot move each other's branch or working tree. Run `npm ci` in the new worktree after `git worktree add`; never symlink `node_modules` to another checkout (`.gitignore` ignores `node_modules` either way, but a later `npm ci` would wipe the linked tree; the gate has no install rule, so `npm ci` runs without a dialog). Children on POSIX may run the exact `npm ci` in their own worktree.

A security revision after the final review is cap-exempt: one more Opus builder is allowed.
Builders commit per numbered item.
A child bundle holds at most 3 items.

### Worktree for a new session

`--worktree [--base REF]` (tool: `worktree: true`, `base`) makes `open` create the session's own round worktree and open the session there; `--cwd` (default the opener's cwd) only has to be inside a git checkout, a linked worktree there resolves to the main checkout.

- Path: `<close.worktreeDir>/<label>` (default `../<repo>.worktrees/<label>`; a custom root, relative, absolute or `~`, is described in [close](close.md#the-worktree-root), e.g. `/srv/build/<repo>/<label>`). The label `worktrees` is refused (`label_reserved`): pi-subagents puts its isolation worktrees in `<root>/worktrees/`. A refused root falls back to the default; a root that already holds another repo's worktrees is refused (`root_collision`). The terminal `foreman session open` checks only the Python subset of the root rules. Branch: `<prefix>/<label>`, the prefix from `sessions.worktree.branchPrefix` (default `round`; user or overlay config only; same characters as a label).
- Base: `--base` (a branch, tag or commit that does not start with `-` and resolves to a commit after the fetch), else the default branch of `origin`: `git fetch origin`, then `refs/remotes/origin/HEAD`, else `git ls-remote --symref origin HEAD`. The worktree is `git worktree add <path> -b <branch> <base>`.
- Refused before any change: the path exists, the branch exists, no remote `origin`, a bad `--base`, a `--cwd` outside a git checkout, `--base` without `--worktree`, `--worktree` with `--machine` (the worktree would be on the remote machine).
- Install: only when the new worktree holds `package-lock.json` or `npm-shrinkwrap.json`, `npm ci` runs there (`npm.cmd` on Windows; 540 s limit). A failed install removes nothing: the exit code is reported (`install: failed:<code>`) and the session opens anyway; rerun `npm ci` in the worktree.
- `--dry-run` prints path, branch, base and the install step and creates nothing (it skips the fetch and uses the refs already known).
- Output: the info JSON gains `worktree: {path, branch, base, install}` (`install` is `npm ci`, `none` or `failed:<code>`). After a successful open the adapter records the worktree in the opener's manifest (as for a `git worktree add` run through the session, so it is a round worktree and its `.workflow` is readable for the opener's children) and traces `session_worktree {label, path, branch, base, install}`. The session's cwd is the worktree, so the [trust grant](#trust-dialog-for-a-fresh-worktree) applies.
- Removal: the opener's `foreman close` and `foreman worktree sweep` remove it only under the usual preconditions (clean, merged, no stash, no live session inside), and a worktree stays while the opened session's registry entry is `pending`, `open` or `closing`; close that session first.

### Nested submodule worktrees

A tool outside pi-foreman (never pi-foreman itself) may create a worktree of a monorepo and nest worktrees of its submodules
inside it. A checkout counts as part of the surrounding tree when its `.git` file points into the monorepo's
`modules/` admin area and that admin dir points back at the checkout (a linked submodule worktree), or a submodule's
`core.worktree` names it (a plain submodule checkout); the rule applies recursively. For a session started in the main
monorepo or in such a worktree, and for its round worktrees, that whole tree is one workspace: owned paths, path rules, the
round detection and the children's write roots all treat the nested checkouts as inside it,
but never anything above the session's workspace or round, and never another round's tree. A forged `.git` file that points at
another round's admin dir fails the back-link check. A session started inside a submodule checkout does not lift: its workspace
is that submodule.

- `git submodule update`, `sync`, `init`, `foreach` and `status` are allowed for children when the cwd, every path argument (everything after
  `--` included, even tokens starting with `-`) and the value of `--reference` (`--reference x` and `--reference=x`) lie inside
  the round's own tree. The URL rule applies only to `sync`, `init` and `update --init` or `--require-init` (which implies `--init`): a `.gitmodules` URL is resolved the way git
  resolves it (relative to the superproject's remote) and must equal the URL already configured, and a child's first init of an
  unconfigured submodule is refused (run it as the foreman or owner). Glob or pathspec-magic paths (`*`, `?`, `[`, leading `:`)
  count as every submodule; the value of any other option (`--depth 1`, `-j 2`, `--filter x`, `--ref-format f`, in the separate, `=` or attached form) is not a
  path, and an unknown option counts as every submodule. `update`, `sync`, `init` and `status` with `--recursive` are refused for
  children even inside the tree (the foreman or owner runs those). `foreach '<cmd>'` classifies the inner command like any child command.
- `<repo>` for a submodule is the submodule's own checkout name. Each submodule checkout gets its own PR gate and reviewer:
  PASS records are keyed by the checkout's own top level, not the lifted root.
- Cleanup never deletes nested checkouts pi-foreman did not create ([close](close.md#the-worktree-root)).

**Isolation worktrees (`worktree: true`).** pi-subagents' leaves are not placed by `close.worktreeDir`; no base dir is set
(setting `PI_SUBAGENTS_WORKTREE_DIR` would force the native provider and fail under worktrunk). For a round at
`<root>/<label>` the leaves land in `<root>/worktrees/<label>/…`, under the root, which is why the label `worktrees` is
reserved. A session in the main checkout gets its leaves beside the main checkout, not under the root; under worktrunk they
land where worktrunk puts them. A leaf of a superproject round has uninitialised submodule directories, not the nested
worktrees, so nested-submodule work runs without `worktree: true`; a `worktree: true` launch whose cwd is a nested checkout is
refused. `/foreman doctor` prints the root's lines: the effective root (spelled and real) and whether it is default or
configured, whether it exists and is writable, refusals and collisions as `FAIL`, a `WARN` for no symlink support or a
different case sensitivity than the main checkout, and an `INFO` for a different device.

### Trust dialog for a fresh worktree

Pi asks `Trust project folder?` (`<cwd>`, "This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.") when the cwd has project resources (`.pi/settings.json`, `extensions`, `skills`, … or a `.agents/skills` directory in the cwd or an ancestor) and `<agent dir>/trust.json` holds no decision for it or a parent. A new round worktree has none, so every `foreman session open` into one would stop at the dialog.

When the `--cwd` of `open` (not `--dry-run`) is the root of a linked git worktree under the managed root (`close.worktreeDir`, default `../<repo>.worktrees`), `open` writes `{"<realpath of cwd>": true}` into `<agent dir>/trust.json`: an atomic read-modify-write under Pi's own lock directory that keeps every other entry, for that exact path only (never a parent folder), and not when the store already has an exact entry for it or cannot be parsed. The registry entry records `trusted: <path>`; whenever pi-foreman removes the worktree (session close cleanup, `foreman worktree sweep`, the `foreman_worktree_remove` tool) it deletes that entry again, and only entries it recorded, so your own trust decisions stay. Builder worktrees from pi-subagents run headless: Pi only shows the dialog in an interactive run and treats an undecided folder as untrusted without asking otherwise, so nothing is written for them.

Alternatives: start `pi` with `--approve`, or set `defaultProjectTrust` to `always` in your Pi settings (every folder, so broader than the entry above).

### Safety

- Only you start these: they are user commands, children refuse them, and no model tool exists in v1.
- Only the parent may close: `foreman:close` is accepted over intercom only when the sender id equals the
  contents of `$PI_FOREMAN_HANDOFF_DIR/parent`, read at check time (no `PI_FOREMAN_HANDOFF_DIR` or no such file:
  `PI_FOREMAN_PARENT_INTERCOM`; a file with no valid id refuses). To re-point the parent, see [re-point an orphaned child](#safety).
  `close.from` must include `intercom-parent` (default), and cross-machine messages are refused.
- A close is refused while a child run is active; the session's own pending `foreman_wait`s are cancelled instead (trace `waits_cancelled`).
- The `parent` and `child` files of every handoff dir are write-protected (baseline `protect.writeAsk`): a child
  agent of either session is denied any write to them and any shell command naming them, and a foreman's
  write or edit tool asks; a foreman's shell may still read them. `brief.md`, `result.md` and `plan.md` stay
  writable, so the opened foreman writes its result and plan as the footer says.
- **Re-point an orphaned child by hand.** There is no command for it. Edit the handoff dir's `parent` file by hand: write a valid intercom id of the new parent to a temp file in the same dir and rename it over `parent` (atomic). The child's routing, close check and replies re-read the file on every call, so they follow the new id. The edit does not move the registry entry in `sessions.json`, which keeps the old `parent`: the new parent gets no question reminders, no child counts, no close cascade and no `foreman_wait kind:child` for that child. The new parent briefs it with `foreman session brief <label|handoff dir>`. The `parent` file is write-protected (previous item), so the edit asks the owner.
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

`sessions.backend` (`auto` by default, `herdr`, `hc` or `terminal`; user or overlay config only) chooses between these for a
local open. `auto` tries Herdr first, then herdr-core (`hc run`, when `HC_TERMINAL_ID` is set) and then the printed
command. A forced backend that cannot run is refused `[backend_unavailable]`. An hc child is always run with `--keep`, so it
survives core loss and reboot, and shows in herdr-app as a sub-agent of the opener's tab. See
[herdr-app and herdr-core](herdr.md#herdr-app-and-herdr-core) (experimental).

**Finding `pi`.** The child's command resolves `pi` on the PATH the child gets (the opener's). When there is none, an open
from a running Pi (the tool and `/foreman session open`) falls back to that Pi: the open script receives
`PI_FOREMAN_PI_ARGV` (a JSON list: the Node binary and Pi's CLI file, both absolute) and runs those words instead of a bare
`pi` (in the printed PowerShell line as `& '<node>' '<cli>'`). `foreman session open` from a terminal has no running Pi to
fall back to and keeps the PATH lookup; so does an open on another machine (`pi.cmd` or PATH there). The variable is never
passed on to the child.

**Start check.** Under herdr-core, an open waits `PI_FOREMAN_START_CHECK_SECONDS` (3 s; the tool and `/foreman session open`
always pass 3, the `bin/foreman*` wrappers set 3 only when the variable is unset and keep a value already set; 0 or unset means no check), then reads the terminal with
`hc get`. A child that already finished makes the open fail with `session <label> did not start: exit <code>` and the last
20 terminal lines, not "opened". The registry entry is kept with status `failed` as a record (`prune` leaves it), and the dead
terminal stays readable (`hc read <address>`) until you close it with `hc rm`. A Herdr pane, the printed command and an open
on another machine (`--machine`) have no state to read and get no check.

### Providers in opened sessions

The opened command is a plain `pi [--model ID] '<prompt>'`: it loads the same packages as any start, so
`claude-bridge/*` models are there only if pi-claude-bridge is in `settings.json` packages. One R13 session opened by another session
opened with `--model anthropic/…` had no `claude-bridge/*` entries in `/model` until `/reload`. Not reproduced
(no live run); best hypothesis from reading Pi's startup: Pi resolves the `enabledModels` scope (or `--models`)
once at start, and a provider an extension registers later (after the scope is resolved, e.g. in `session_start`)
is missing from that scoped list; `/reload` resolves it again. No generic fix in pi-foreman. Workaround: run
`/reload` in the opened session, or add the bridge models to `enabledModels`. `/foreman doctor` prints
`providers: <list>`, the providers the model registry holds in that session; a missing `claude-bridge` there
means the bridge is not loaded or has not registered yet.

### Opener intercom id

The id written to `parent` is, in order: `PI_INTERCOM_SESSION_ID` (the id pi-intercom resolved and
published, which also covers an id claimed through `intercom:session-identity`), `PI_INTERCOM_STABLE_ID`,
`stableId` in `<agent dir>/intercom/config.json`, then the Pi session id. The CLI cannot know the Pi session id
and takes `--parent-id` instead.

### Other platforms

Not in v1. The equivalents would be tmux `new-window -c DIR -n LABEL CMD` and Windows Terminal
`wt -w 0 new-tab -d DIR --title LABEL pwsh -NoExit -Command CMD`.

### Planned, not shipped

A `foreman_session` model tool as an opt-in of the user layer. The functions behind the commands take plain
dependencies so a tool could call them; none is registered.

## Remote child sessions

Experimental: remote child sessions are new and their behaviour may still change.

`foreman session open <label> <brief> --machine <name> --cwd <dir on that machine> [--trust]` opens the child on a machine known to hc (`hc machine ls`), over `hc exec --on <name>`; the remote verb then starts the child with `hc run` locally on that machine (never `hc run --on`); no SSH is involved. The child's notices reach this session as labels on its hc terminal (see Return path below). It works from the CLI and from `/foreman session open` (which forwards `--machine` and `--trust`). `--cwd` is required and is passed unchanged: it is a path on the other machine, never resolved here; the brief file is a local path. `--print-all` is not supported with `--machine` in this version: it is refused (`remote_option`) before any hc call, and nothing is written. `--plan-mode` and `--first-command` are sent to the remote, which checks them (a refusal there names its own code); `--focus` runs `herdr-app do agent.focus` here, on the child's address. The open result (also with `--dry-run`) carries one line saying how to fetch the child's files without opening another remote session: `fetch remote files: <hc> file read --on <name> <remote handoff dir>/result.md` (`<hc>` is the hc binary this side resolved: PATH or `HC_BIN`).

**Config (user or overlay config only).** A project or session layer cannot set `sessions.machines`; it is ignored there.

- `sessions.machines.<name>` is the allowlist; `<name>` must also be a machine in `hc machine ls --json` (exact case). hc holds the connection and its credentials; pi-foreman stores none.
- `sessions.machines.<name>.foremanArgv` is the list of words that start the foreman dispatcher on that machine, run by `hc exec` without a shell (default `["foreman"]`; 1 to 8 words, a word may hold a space but no quotes or shell characters, the first word does not start with `-`). On a Windows machine use `["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "<foreman root>/bin/foreman.ps1"]`, so the execution policy does not block the script.
- `sessions.machines.<name>.space` is the herdr-app space id the child is shown in (default: the space of `herdr-app ls` whose machine is this one; `space.new` creates it when there is none, and a failure is `no_remote_space`). `space.new` prints `{"space": "<id>", ...}`; when it prints no id (timeout, odd output), `herdr-app ls` is re-listed for up to 10 s (`PI_FOREMAN_SPACE_WAIT` seconds) for the new space of the machine. If the remote open then fails, a space this open created is closed again with `space.close`.
- `sessions.machines.<name>.parentName` is this machine's name as the remote's hc and pi-intercom know it (default: this machine's lowercased short hostname).
- **Naming convention.** Use one name per machine everywhere: the `hc machine` name, the `sessions.machines.<name>` key and the remote's pi-intercom `crossMachine.machineName` are all the lowercased short hostname. The child's intercom address is `child@<that name>`; `open` prints it, and warns when the remote reports another name. Two fixes: `hc machine add <hostname>`, or `foreman machine setup <name>`, which runs the remote `setup --addon <each add-on installed here> --intercom-hc --machine-name <name>` (`--no-addons` instead of `--addon` when none is installed here, so the remote gets no default add-ons) over `hc exec --on` (configuration only; it does not update pi-foreman, use `pi update` there for that). The `hc exec` runs with `--timeout 600` (`--timeout <seconds>` lowers it; 600 is the cap). The remote's output shows while it runs (stderr line by line). A nonzero exit or an `[hc] timed out after N ms` line is reported as "setup failed" with the exact rerun command and a nonzero exit, never as done. `open` also prints an info line when the add-ons differ, and a hint (`foreman setup --intercom-hc`) when this machine's `crossMachine.transport` is not `hc`.
- **After the result.** The child no longer sends `closed` itself: the entry stays `open` (radar: "result delivered, idle") and its hc terminal stays up until the parent closes the session. Then the parent's watcher polls `hc get` until the terminal has finished (up to 120 s) and removes it with `hc rm`; a terminal that is still live at the bound is killed only when its foreground process is a shell, else it is reported and left.

**Verbs.** `foreman session open … --machine`, and `foreman session brief <label> <file|text>` for a remote entry. `open` runs `hc exec --on <name> --timeout <s> -i --json -- <foremanArgv…> session remote <verb> --json` (argv, no local shell; JSON on stdin; the reply is a JSON envelope with the exit code and base64 output), first `probe` (15 s), then `open` (60 s); a brief is `deliver` (20 s) and a close is `close` (20 s). `--dry-run` probes and asks the remote for a dry run; nothing is written on either side. It reads `herdr-app ls` (never `space.new`) and prints `space: <id> (exists)`, `space: <id> (pinned)`, `space: will be created with space.new`, or `warning: cannot check the remote space: <reason>`. The remote verbs are `foreman session remote probe|open|deliver|close --json`; `foreman session remote notice` is the child-side command below. The remote `open` starts the child with `hc run --json --bg` on the remote machine and puts it in the space above. `brief` keeps an allowlisted file name (`brief-<n>.md`, `ruling.md`, `ruling-plan.md`, `ruling-<n>.md`, `steer-<n>.md`); any other file or text is delivered as `brief-<n>.md`.

**Return path.** The child reports with `foreman session remote notice <plan|result|update|ask|closed|refused>` inside its hc terminal. The command sets labels on the child's own terminal (`hc label $HC_TERMINAL_ID …`; `hc` from PATH or `HC_BIN`): `fm.notice=<seq>:<kind>:<sha256>:<bytes>` for `plan`, `result`, `update` and `ask`; for `closed` the same word with the sha256 and size of `result.md` (`fm.notice=<seq>:closed:-:0` when there is no `result.md`) plus `fm.close=ready|open`; `fm.notice=<seq>:refused:<slug>` for `refused --reason <slug>` (`[a-z0-9-]`, 1 to 40 characters). `<seq>` counts up from 1 in `notice-seq` of the handoff dir. The command prints `{"ok":true,"seq":n,"label":"…"}`. The parent watches the local `hc events --json` stream (one listener per machine that has open remote entries), fetches the named file with `hc file read --on <machine> <remote handoff>/<file>` within `sessions.remote.fetchTimeoutSeconds` (default 30, 5 to 600), checks its sha256 and size against the label, mirrors it (below) and wakes `foreman_wait` kind `child`. Only this session's own remote children are watched. Heartbeats keep the stream healthy; when it ends, errors or stays silent for 90 s, the parent polls `hc get <machine>/<terminal> --json`, every 5 s while an ask or plan is pending and every 60 s otherwise. A remote entry's state (radar and the herdr-app sidebar) follows the hc terminal: blocked is blocked, an open ask label is ask, a lost or errored terminal is finished.

**Local attach pane.** After a remote open that reports `open`, when this session runs inside an hc terminal (`HC_TERMINAL_ID` set) and `hc` is found, the parent starts a local terminal running `hc attach <machine>/<t>`: `hc run --json --bg --no-notify --rm [--outlive-parent] --cwd <this cwd> --name fm-<machine>-<slug>-<hex4> -- hc attach <machine>/<t>`, through the same path a local hc child uses. It has no `herdr.space` or `herdr.tab` label, so herdr-app shows it like a local child (a floating sub-agent of the parent's tab), and it carries the parent nesting hc gives every local child. It uses `--rm`, not `--keep`: detaching (Ctrl+\) or the remote child ending ends the terminal and hc removes it, so nothing is left behind. The command prints `attach: <local address>` and the registry entry stores `attach: {address}`. Without an hc terminal here, or when the attach run fails (then with a warning on stderr), it prints `attach: hc attach <machine>/<t>` for you to run by hand; the exit code never depends on the attach. The name is `fm-<machine>-<slug>-<hex4>`: the machine lowercased with characters outside a-z0-9-_ replaced by `-`, the child slug, the last 4 hex of the child id, at most 32 characters (slug cut first, then machine), e.g. `fm-build01-attach-live-test-6dae`, so herdr-app shows the machine. `--focus` runs `herdr-app do agent.focus` on the local attach terminal (also without a herdr-app space); without an attach terminal it focuses the remote terminal as before. `foreman session close-remote` and the watcher's `closed` notice run a best-effort `hc kill` on the stored attach address.

**Remote ask.** The watcher stores the ask number and topic from the mirrored `ask.md` header (`# Ask <n>: <topic>`); radar shows `ask <n>: <topic>` for it, never the notice counter. `foreman session brief <label>` clears the pending ask at once when it delivers a brief, or a `ruling-<n>` of an older footer (n at least the ask's n, or the ask's n is unknown); a plan ruling or a steer does not. The watcher's own clear (the `answers` counter of the entry going up; a missing counter counts as 0) stays as a second path. The ask row with number and topic stays for a remote ask on the parent's side. While the ask is open and older than `sessions.blockedNoticeSeconds`, the parent is reminded once, and the reminder starts a turn (see [a child that waits on the owner](#a-child-that-waits-on-the-owner)); the brief is the answer.

#### Reports from remote and parent-opened sessions

A session opened by `foreman session open` is a foreman session of its own: its faults are reported with `foreman_report` as in any session (see [retro](retro.md#reporting-at-the-source)) and stored in the notes of the repository it runs in. For the parent to see them, the tool also appends each report row of that session, and of the subagent children it launches, to `reports.jsonl` in the session's handoff dir (the child learns the dir from its launch binding, a session from `PI_FOREMAN_HANDOFF_DIR`). A session without a parent writes no copy. The copy is best effort: a failure never fails the report call and never loses the local row; it is traced as `report_handoff_failed` (the id only).

When the parent's watcher applies a remote `result`, `update` or `closed` notice, it also reads `reports.jsonl` from the same remote handoff dir with the same `hc file read`, and imports it into the report store of the repository of the parent session. This adds no notice kind and no footer text, and the three mirrored files stay `plan.md`, `result.md` and `ask.md`; the fetched report file is also written to the session's mirror dir as `reports.jsonl` before the import, but it is not one of the mirrored notice files and no notice names it. Nothing is imported at a `plan`, `ask` or `refused` notice. A missing, unreadable, empty or oversized (above 512 KiB) file changes nothing, and the notice is handled exactly as without it; one `reports_import` trace event per import carries counts only (`lines`, `added`, `known`, `malformed`, `notReport`, `otherRepo`, `invalid`, the boolean `oversized`; a failed import carries `failed: true`). A failed import leaves the mirrored file: run `foreman reports import <mirror dir>/reports.jsonl` later (a failed mirror write does not stop the import). The import checks every row again (see [retro](retro.md#reports-from-parent-opened-sessions)) and takes only rows whose `repo` equals the repository of the parent's store: a row without a repository, or a parent without one, matches nothing. Rows keep their own `session`, so a remote session and its children count as one session. `foreman reports import <file>` does the same for a file you copied by hand. A local child that works in the same checkout or in a worktree of the same repository writes to the parent's store (the store sits in the main checkout) and needs no import; its handoff copy is ignored. A local child started with `--cwd` in a separate clone of the repository has a store of its own: nothing imports it automatically, and `foreman reports import <handoff dir>/reports.jsonl` brings its rows over.

**Click in the sidebar.** In the herdr-app Agents tree a click on a remote session card focuses the local `hc attach <machine>/<t>` terminal that already follows it, else starts one (`hc run --json --bg --no-notify --rm --name fm-<machine>-<slug>-<hex4> -- hc attach <machine>/<t>`). A hand-made `hc attach` of a target a radar session represents is no row of its own: the card is its row. The attach terminal that `foreman` opened is matched exactly: the registry entry stores its address (`attach.address`), `foreman radar --json` puts it on the remote node as `attach`, and the sidebar merges the terminal at that address into the card whatever its name; a click on the card focuses it.

**Dead local child.** Radar draws a local child as `closed` in its own output (so the sidebar shows it as an ended child, with a Restart action when `foreman session restart` accepts it); it never writes `closed` into the registry (only `foreman session prune` and a close flow do). That happens in two cases. A registry entry (`open` or `closing`) whose process is not running and whose launcher terminal (hc address or Herdr pane) is provably not listed. A handoff-only session (a handoff dir with no registry entry and no live file) whose handoff dir and the files in it show no activity for 15 minutes. An unreadable terminal listing, a live process, a recent handoff dir, an entry with an unknown terminal and every remote session keep it shown. Radar gives a remote session node its terminal address (`<machine>/<t>`, from the registry `hc.address`) so the sidebar card can be clicked.

**Trust.** A remote folder with project resources (`.pi`, `.agents`, `extensions`, `skills`) must be trusted on the remote machine. An untrusted or refused folder is `remote_untrusted`, and the refusal names the first resource that triggered it (`first: <path>`, relative to the opened folder, so a resource in a parent folder shows as `../.pi`); `--trust` records the grant there. A stored refusal is not overridden.

**Footer and notices.** The remote brief carries a footer that tells the child to report with one command, `<python> -E -s <foreman_session.py> remote notice <plan|result|update|ask|closed>` (one POSIX command line on every platform, run through its bash tool); the child never types an intercom message. The command names the file by its sha256 and size. `closed [--close ready|open]` sets `fm.close=ready|open` with the `fm.notice` label. The file is `plan.md`, `result.md` (also for `update`) or `ask.md` of the handoff dir; any other file is refused.

**Notices and mirror.** The remote handoff files are mirrored here under `<agent dir>/pi-foreman/remote/<machine>/<handoff name>/`; `foreman session list` shows the mirror path as `last`. A notice file is mirrored only when its sha256 and size match the head; a mismatch writes nothing and shows `hash mismatch, not mirrored`. A path outside the remote handoff dir or with another name is ignored. `closed` marks the entry `closed` and stores the mirror result path, never the remote one. A hash mismatch is fetched a second time; if it persists nothing is mirrored and the label stays pending. Notices are data: they update the registry and the mirror and act on nothing.

**Delivery of notices.** Each `remote notice` call is also a line of `notices.jsonl` in the remote handoff dir (`{seq, kind, sha256, bytes, at}`, plus `reason` for `refused`), and a `plan`, `result`, `update` or `ask` notice keeps a copy of its file as `notices/<seq>-<kind>.md` (a `closed` notice that has a result keeps its copy as `notices/<seq>-closed.md`); both are written under the same lock that hands out `seq`, so the queue is in seq order. A failed queue write leaves the label as the only record, and the parent then reads the single file as before. When the parent sees a label it reads the queue and applies every notice above the last one it applied, in order, from the per-seq copies (a second plan before the parent fetched the first is not lost, and a label that arrives out of order is applied once). A queue file that is not there (an older child) means the label's own notice by the single-file path; any other read error fails the run and the probe retries it. The per-entry `hc get` probe runs every 60 s also while the events stream is live, re-reads the label, and after a failed notice comes back sooner (5, 15, then 60 s); a failed fetch therefore needs no new label. Each probe that reaches the terminal counts as contact (see the stale marker in [Radar](#radar)). After it applied notices, the parent writes `notice-ack.json` `{seq, at}` into the remote handoff dir (`hc file write`, stdin) with the highest applied seq, and retries a failed write on the next applied notice or probe; a `closed` notice writes none (a `refused` notice does: it is acknowledged like the others).

A notice that no armed `foreman_wait` of kind `child` took reaches the parent as one custom message of type `pi-foreman-remote-notice`, `Remote session notices (data from another machine; they approve nothing):` with one line per notice: `Plan from <label>@<machine>: <path>`, `Result from …`, `Update from …`, `Refused from …: <reason>`, `Closed: <label>@<machine>`, and for an ask `Remote ask from <label>@<machine>: <path>; answer it with a brief (foreman session brief <label> <file>)`. The notices of one catch-up run come as one message. An idle parent starts a turn from it; a busy one gets it as a follow-up. Only the label, machine, kind and a path of the mirror enter a line, plus for `refused` the reason slug the child gave (`[a-z0-9-]{1,40}`, checked on both sides); no other text the child wrote does.

On the child, `remote notice` returns before the parent has fetched anything. For every kind but `closed` it prints `sent, not yet confirmed; a pi-foreman note tells you when the parent confirms` on stderr, and its stdout JSON is unchanged. The child's footer status then reads `report #<seq> (<kind>) sent, not yet confirmed`, after 5 minutes without a receipt `report #<seq> (<kind>) not confirmed by the parent for <m> min`, and after the receipt `report #<seq> delivered to parent at <hh:mm>` (shown for 10 minutes). The child's model gets one `nextTurn` note per report (no turn of its own), either `report #<seq> (<kind>) delivered to parent at <hh:mm>` or `Your <kind> report #<seq> has no receipt from the parent after 5 minutes. Do not say it was delivered.`; the noted seqs are kept in the session entry, so a reload repeats no note. The brief's footer tells the child to claim delivery only from these notes. The child reads `notices.jsonl` and `notice-ack.json` every 5 s while a report is unconfirmed, else every 30 s.

**Mixed versions.** A new parent with an old child works as before (no queue file: the single-file path), and the receipt file it writes is harmless. An old parent with a new child never writes a receipt, so the child shows `not confirmed` after 5 minutes although the notice may have arrived; an old parent writes no contact file either, so radar shows no stale marker for it.

**Environment difference.** The child on the remote machine does not see this machine's Herdr, config, project files or environment; it works from the brief and its own machine. The parent is `<opener id>@<parentName>`; the child's `PI_FOREMAN_PARENT_LABEL` comes from `parentName`.

**Intercom across machines.** Read in source (pi-intercom 0.18.1, `index.ts`) and in `intercomguard.ts`; not shown live, because nothing across machines was run. A plain intercom `send` to `<name>@<machine>` works when `crossMachine` is set up (see [pi-intercom](#pi-intercom)), and the answer comes back as a new message, not as a reply to the send. A blocking `ask` to a `name@machine` target is refused ("Cross-machine ask is not supported. Use send"). pi-foreman itself refuses any `name@machine` target unless `intercom.allowRemote` is set (default `false`, tighten-only, see [safety](safety.md)); without it even a send is refused. The setting is read on the machine that sends: set `intercom.allowRemote` to `true` in the config of the parent's machine for a message from the parent to the child, and in the config of the remote machine for a message from the child to the parent. A bare child id of a remote entry is refused with "send to `<child>@<machine>`; needs `intercom.allowRemote` on this machine". The footer of a remote child does not use intercom at all: it reports with `remote notice` and is answered by a brief, as above.

**Failures.** `remote <name> unreachable: <hc error>` (hc exec failed, timed out or gave no JSON reply) is reported as not sent; the order may still have arrived, so a close keeps the entry's status and records the attempt (see [Remote child sessions](#remote-child-sessions)). Refusal codes: `machine_not_allowed` (not in `sessions.machines`), `machine_unknown` (not in `hc machine ls`), `hc_missing` (no `hc` binary here; `HC_BIN` names one), `backend_unavailable`, `cwd_required`, `no_return_path` (a bad opener id or parent name), `no_remote_space` (no herdr-app space for the machine and `space.new` failed; the message gives the herdr-app error, timeout, non-JSON output or missing id, and what to do: run `herdr-app` on this computer, check `hc machine ls`, or pin `sessions.machines.<name>.space`), `remote_launcher` (no `hc` on the remote machine), `remote_protocol` (the two sides speak different protocols; update both), `remote_missing` (`pi` or pi-intercom not found in the remote hc environment), `remote_untrusted`, `remote_option` (`--print-all` given with `--machine`), `owner_declined` and `no_ui` (the confirm window: declined, or no interactive session; raised in Pi before anything is spawned), `too_large` (over 64 KB), `not_remote` and `not_open` (`close-remote` on a session that is not a remote one; without `--force`, on an entry that is not `open`, `pending` or `closing`, where the message is "is <status>, not open"; with `--force`, `closing` and an `open` entry with an unanswered close attempt are force-closed, any other `open` entry is refused and the message says to try a normal close first, a `pending` entry gets a normal close, and other statuses get the same "is <status>, not open" refusal), and on the remote `bad_request`, `bad_name`, `bad_cwd`, `wrong_session` (the handoff's parent is not this session), `no_handoff`, `no_entry`, `bad_parent`, `not_remote`, `refused` (a remote refusal that has no specific code) and `internal` (an unexpected error on the remote); a reply from the remote without any code is shown here as `remote_refused`. A failed brief sets `lastError` on the entry and exits 1. Return path failures: on the child `remote notice` exits 1 with `{"ok":false,"error":"not_hc"}` (no `hc`, or `HC_TERMINAL_ID` unset) or `{"ok":false,"error":"label_failed","detail":…}` (`hc label` failed); a `refused` slug outside `[a-z0-9-]{1,40}` is `bad_request`. On the parent a failed `hc file read` is `fetch_failed` and a persisting mismatch is shown as `hash mismatch, not mirrored`; in both cases the label stays pending. Text from hc and the remote is printed with control characters removed.

**Limits of this version.** `--print-all` is refused with `--machine`. A remote entry's state in the radar and sidebar comes from `remoteLive`, the hc terminal status the parent's watcher stores (an open ask first; the registry status only as the fallback before the first hc status; see [Radar](#radar)), not from a local live file, and its result is read from the mirror. A remote close is only as fast as the child's reply: the entry stays `closing` until the child answers `foreman:close` with `remote notice closed` or `remote notice refused`, which sets the `fm.notice`/`fm.close` labels on its hc terminal, and the parent's watcher builds the `child <label>: closed` or `child <label>: refused <reason>` wake from that label. If no answer arrives the attempt expires (see [Remote child sessions](#remote-child-sessions)).

**Address.** Every remote child has the address `<label>@<machine>` (the machine is the `--machine` name). `open` prints `address: <label>@<machine>`, the lists show it, and the result wake and notice of a remote child end with `; close with: foreman session close-remote <label>@<machine>`. `foreman session brief`, `foreman session close-remote` (also with `--force`), `/foreman session brief` and `/foreman session close` accept it, but only after an exact match of a label or child id fails (split at the last `@`; the newest entry of that label on that machine). A bare label still means the newest entry of that name. In `brief` a registry entry named `x@y` wins over a handoff directory of that name. An unknown address is refused by the CLI with the known addresses of that label or machine; inside Pi it is passed on as every unknown target is, because `name@machine` is also an intercom target. This is a pi-foreman address, not an intercom address (the child's intercom address stays `child@<name>`). `foreman_wait` kind `child` keeps taking the label only.

**Remote close.** `foreman session close-remote <label|child id|label@machine> [--path P.md] [--json]` closes a child opened with `--machine`. `/foreman session close` and `/foreman close` run it for each such entry, and the CLI prints the same result. The parent runs the remote `close` verb over `hc exec`. That writes `close.json` in the child's handoff dir (the parent's opener id, the result path if given, and the time) and sends the child `foreman:close` by pi-intercom. The child accepts the order only if the file parses, names the parent recorded at spawn, is at most 15 minutes old and has not been used: it is then renamed `close.json.seen`. A cross-machine message never closes. The child runs its ordinary close sequence and answers with `remote notice closed` or `remote notice refused`, which sets the `fm.notice`/`fm.close` labels on its hc terminal; the parent's watcher builds the `child <label>: closed` or `child <label>: refused <reason>` wake from that label and records it on the entry. A refusal on this side (a bad `--path`, `not_remote`, `not_open`) changes nothing.

The send has two outcomes. Confirmed (the remote answered and woke the child): the entry is `closing`, `closeSentAt` and the tried time `closeTriedAt` (seconds since the epoch) are set and the command exits 0; it does not end the local attach terminal, which ends where the entry becomes `closed`. Not confirmed (the remote could not wake the child, or the remote call failed, timed out or gave no usable reply): the entry keeps its status, `lastError` and stderr carry `close for <label>@<machine> not sent (<reason>)`, the tried time is set and the command exits 1 with nothing on stdout. A refusal before an order exists (an unknown label, a machine not listed, no `hc`, or a coded refusal by the remote) sets no tried time. A refused or failed close removes nothing on either machine. A repeat is always safe, also on a `closing` entry: a new order replaces the old one.

Every remote call of one `close-remote` shares one deadline below the limit the in-Pi command gives it, order and its slack included; the reap uses what is left and otherwise prints the same `remote terminal still running; prune will remove it`. The remote side sends the child its wake with a limit below the call that carries it.

An attempt has an age. A `closing`, `open` or `pending` remote entry whose tried time is older than the order's lifetime plus a margin for the child's close turn is settled by the next `foreman session list` or `foreman session prune` (one pass, one total time limit, one read of the entry's own recorded terminal; the age field alone decides). The terminal is finished or gone: the entry is `closed`, the terminal removed and the attach terminal ended. The terminal is live and carries the child's `closed` label: the first sighting (the time and the label's sequence number) is only recorded; a run at least the watcher's wait (120 s) later that reads the same label closes the entry (note `closed: notice read from the terminal`), ends the program in the foreground whatever it is and removes the terminal (a result the watcher never fetched stays on the other machine). A sighting without a recorded sequence number, with another number or in the future counts as a first one again. A `closed` entry whose last notice is older than the wait and whose label number matches the recorded `noticeSeq` needs no earlier sighting. The terminal is live without that label (the child refused, never got the order, or hangs): nothing is ended or removed, the tried time is cleared and a `closing` entry is `open` again with `close order expired without an answer`. The terminal cannot be read: the entry is unchanged and named in the warning. Without a `closed` label nothing on the other machine is ever ended or removed by this pass.

A child that is gone (a hung Pi): `close-remote --force <label>` also accepts an `open` entry that has a tried time or the expiry mark (set when the pass reopens a `closing` entry) and no notice since, that is, whose last notice is missing or older than the later of the two. A fresh `open` entry, one that answered after the attempt, and one whose tried time was cleared are refused with `not_open`; a normal close must be tried first. A not-sent line that set a tried time on an `open` entry, and the expiry line, end with the `--force` hint; when the pass clears the tried time of an `open` entry at expiry it records the expiry mark and prints that line too, so the hint is true (a `pending` entry gets neither). `--force` stays within the same deadline: when the time runs out it counts as a failed call, the entry is marked `closed` and the warning says the remote terminal may still exist.

**Remote terminal cleanup.** The remote terminal is kept (`--keep`), so it stays `finished` until something removes it. After a confirmed close, `close-remote` polls it briefly (`hc get`) and runs `hc rm` once it is finished (`not_found` counts as done); when it still runs it prints `remote terminal still running; prune will remove it`. `foreman session prune` does the same for `machine` entries in `closing`, and for `closed` ones whose terminal is left over, then marks a `closing` entry `closed`; a terminal that still runs is left alone, except in the expiry pass described under Remote close above. If the remote terminal cannot be removed (the machine is unreachable or `hc rm` fails), `close-remote` and `prune` print `remote terminal could not be removed (hc get/rm failed); prune or close-remote --force retries` on stderr and leave the entry as it is, so the next `prune` retries; `prune` names every such entry on one line. `close-remote --force <label>` accepts a `closing` entry, and an `open` one under the conditions above: it kills the remote terminal if it runs, removes it, ends the attach terminal and marks the entry `closed`. When it cannot remove the terminal it warns (`remote terminal <address> of <label> was not removed: …; <label> is marked closed anyway`), still marks the entry `closed` and does not retry it, since `prune` skips a closed entry it has already reaped. The leftover terminal then needs `hc rm <address>` (the address is in the warning). The same removal runs in the parent's watcher on a `closed` notice, but only while that parent session is alive, which is why the CLI paths exist. Every `machine` entry is skipped when worktree removal looks for a session in use.

**Leftovers of `closed` entries.** The list pass (and `prune`) also cleans the terminal of a `closed` machine entry that is not marked `reaped`, under the same total time limit (60 s, one read at most 10 s). A terminal that is gone is marked `reaped`; a finished one is removed and marked, and only with the closed label and the entry's recorded number when the terminal's labels are read (not settled from the repo: whether the real tool reuses terminal ids after a removal and returns labels for a finished terminal; a tool that shows none leaves a finished leftover to `prune`, which removes it without a label check). A live one carrying the closed label with the recorded number is ended and removed once the wait has passed, whatever program is in the foreground. A live one without that label, with a `refused` or malformed one, or with another number is not touched: it is named once and gets `leftAloneAt`, so the list does not read it again; `prune` ignores that field. A terminal is not touched when another entry that is not `closed` records the same address. A `closed` entry from an older registry has no `reaped` field: the first list reads it once, within the limit, and continues at the next run. The normal `close-remote` reap and the watcher's reap set `reaped` too, so those entries cost no read later.

**Retry pause.** A failed read, removal or kill records `passRetryAt` on that entry and on every other entry of the same machine the run skipped for it; the list pass leaves those entries alone for ten minutes and names them without a read, so a machine that is offline costs the list one capped read per ten minutes. `prune`, `close-remote` and `--force` ignore the pause. An invalid or future `passRetryAt` is no pause; a damaged time field is ignored, never a crash.

**Busy terminal.** At the watcher's bound (two minutes after a verified `closed` notice) a shell in the foreground is ended as before; any other program is ended only when the read at that moment still carries the closed label with the sequence number of the notice the watcher applied (otherwise it is reported and left), and the terminal is then polled and removed. The pass ends a live terminal under the same two conditions: the closed label on the terminal at that read, and the wait passed. The foreground name is only printed, control-stripped. Residual risk: where a terminal tool reports the child's detached cleanup as the foreground program and the cleanup takes longer than the wait, a worktree and a branch stay behind, and `foreman worktree sweep` removes them (one platform was checked by experiment: the tool reported the foreground job, not the detached process; Windows is not checked).

**Terminal address.** A terminal address recorded on a remote entry is used only as `<machine>/<id>` with the entry's own machine and an id of 1 to 64 of letters, digits, `.`, `_`, `-`. At open the reported address is accepted as a bare id or `<machine>/<id>` of that machine and stored as `<machine>/<id>`; anything else (another machine, `/`, `@`, an over-long id) makes the open fail with `remote reported no usable terminal address`: the entry is `failed`, no attach is opened, and the message says a session may still run on that machine and must be ended there by hand. The watcher does not watch an entry whose recorded address is not of that form and names it once. The handoff path the remote reports must be at most 1024 characters, without control characters and without a leading `-`, else the open fails as an invalid reply.

**Local copy.** The mirror under `<agent dir>/pi-foreman/remote/<machine>/<handoff name>/` holds only `plan.md`, `result.md`, `ask.md` and their `.partial` forms. It is kept like a local child's handoff folder: a close, the pass and `prune` delete nothing there.

**Trust of the remote close.** The remote only receives the parent's hc calls. It gets no credential and never connects back. `close.json` is trusted only as far as the remote handoff dir is: any process running as the remote user can write it (see [safety](safety.md)).

**Permission ask.** The footer's notice command is not a built-in allow ([permissions](permissions.md#built-in-allows)), so it runs under default allow; only a judge-first call in the remote pane can raise a permission ask, and with nobody at that pane it is denied at once.

### Windows remotes

A Windows machine works as a remote with the setup below. `<root>` is the folder of the pi-foreman checkout on that machine.

- **Core and hc.** The remote needs herdr-core running and `hc.exe`. `hc.exe` at `%LOCALAPPDATA%\Programs\herdr-core\hc.exe` is not on the PATH of a non-interactive session, so use that full path in every remote `hc` invocation (the child's notice command honours `HC_BIN` for it).
- **Starting the core.** Start it from a desktop session of the user that owns the machine, never over SSH. An elevated user with a desktop session starts it from a desktop terminal or the Herdr app. To start it at every logon, create a Task Scheduler task: trigger "At log on" of that user, action "Start a program" with the full `hc.exe` path above and the argument `server start`, "Run only when user is logged on".
- **Git for Windows.** Pi's bash tool needs it, and the remote brief's notice command is a POSIX command line run through that tool. Install Git for Windows on the remote.
- **Pi.** The Pi CLI is found as `pi.cmd` there; `remote_missing` means it is not on the PATH of the hc environment.
- **foremanArgv.** Use the PowerShell form `["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "<root>/bin/foreman.ps1"]`. A word may hold only ASCII letters, digits and the characters `. _ : / \`, space and `-` (1 to 200 characters). Parentheses, `+`, `@`, quotes and non-ASCII letters are refused (`machine_not_allowed`), so a root under `C:/Program Files (x86)` or a profile path with a non-ASCII letter does not work. Keep the checkout at a plain path such as `C:/pi-foreman`. The rule is kept on purpose: widening the word class would change the validator on both sides of the hc call.
- **Machine names.** `sessions.machines.<name>` is compared with `hc machine ls` exactly, case included.
- **Line endings.** A file fetched from the remote keeps its CRLF bytes; its sha256 and size are taken over the exact bytes, so the label matches and the mirror is byte-identical.

**Live check (owner, once per Windows machine).** Run in order and stop at the first failure:

1. `foreman session open <label> <brief> --machine <machine> --cwd <dir> --dry-run` succeeds (the probe reports platform `win32` and finds `pi`).
2. Run the same command without `--dry-run`.
3. The radar shows `<label>@<machine>` and the herdr-app sidebar shows its row in the machine's space.
4. A plan, an ask and a ruling make a round trip: the notice arrives (`foreman session list` shows the mirror path), `foreman session brief <label> <file>` reaches the child, and the child continues.
5. The child's result arrives and the entry shows `closed` after `foreman:close` (`foreman session close-remote <label>`); the attach terminal ends only then.
6. `close-remote` on a `closed` entry is refused with `not_open`, and the mirror holds `result.md`. On a child whose Pi was quit it prints `not sent`, exits 1 and removes nothing; the next `foreman session list` after the attempt expired closes the entry and removes the finished terminal.
7. The open output has `address: <label>@<machine>`, the lists show it, and the result wake ends with `close with: foreman session close-remote <label>@<machine>`. `foreman session brief <label>@<machine> <brief>` reaches the child; `close-remote` with an unknown machine in the address is refused and names the known addresses.
8. Close the child, wait until the list shows it `closed`, then end the parent's Pi at once (inside the watcher's two-minute removal window; if `hc get <machine>/<t>` already reports the terminal missing, repeat with a new child). Run `foreman session list` in a shell, and again after three minutes if the terminal was still live. Expected: `hc get` reports the terminal missing, and a further `list` makes no call to the machine.
9. On the Windows machine, read the terminal's foreground (`hc get <machine>/<t> --json`, `foreground.name`) during a close after a merge: if the child's detached cleanup shows up as the foreground, the busy-terminal rule can end it at the bound (see Busy terminal above). To settle whether the real tool reuses terminal ids, remove a terminal, start another, and compare the ids; also read the labels of a finished terminal with `hc get <machine>/<t> --json`.

## Commands

In a Pi session (the foreman, not children):

- `/sync [--dry-run]` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config. The retro runs first (`sync.runRetro`, [retro](retro.md)); `--dry-run` reports what would be committed and pushed and changes nothing (other arguments are ignored with a warning). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active. It does nothing until you list repositories in `sync.repos` of your user or overlay config (a project or session cannot). The known limit is in [safety](safety.md). It also prints the CLOSE report and cleans up what the session created ([close](close.md)).
- `/retro` prints friction metrics of the session (usage lines logged with cost 0, as the Claude bridge does, are priced from the Pi model registry's rates like the footer) and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you. It creates no report entries; faults are reported with `foreman_report` and listed with `foreman reports` ([retro](retro.md)); `retro.enabled` null turns this on in tui and rpc sessions only. `/retro --model <id>` picks the model that writes the findings. `/retro --model --known-limits <file>` appends the file's first 2000 characters to that prompt as rig facts the foreman must not list under Missing (a missing file adds nothing).
- `/foreman steward on|off|status` makes this session the steward of the repository's report list, ends that, or shows it (see [retro](retro.md#steward)). It needs `steward.enabled`, a main session of the owner (not a child, not a session a parent opened) and the one steward lock of the repository.
- `/foreman close [result-path]` is how a sub-orchestrator (a session opened with `/foreman session open`) exits: result file, sync (retro, then repository commits), exit. The top orchestrator runs `/sync` by hand; subagents never sync ([retro](retro.md)). It is refused while a long wait is pending, a child run is still active (nothing is cancelled) or a PR this session watches is still open (wait for the merge, or `pr_unwatch`). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session). Its CLOSE report, cleanup of the worktrees and scratch the session created, and handovers to the parent are in [close](close.md).
- `/foreman cost [workspace]` prints the usage summary (tokens, list-price cost, child launches) of this session, or of all sessions in the given workspace. `--json` prints one object instead (by role, model and role×model: tokens, USD to the cent, and per row how many calls used a recorded cost, were re-priced from `config/prices.json` (long-context tier included) or unpriced); `--all` scopes it to every session of this workspace.
- `/foreman dialogs --json` prints the blocking dialogs this session's trace recorded, counted per family as `{family: {count, lines: [...]}}` with the redacted, path-scrubbed command lines (200 characters at most). Asks of the removed permission layer (`ask-*` records, found only in traces of earlier versions) count in `state_usage_read`, `trace_read`, `pi_scratch_read`, `toolchain_probe`, `own_run_dir`, `own_bg_output`, `own_bash_output_log`, `owned_scratch`, `hub_ledger_read`, `other`; every other blocking surface has one family: `permission_prompt` (a permission-system prompt this session shows), `child_dialogs` (a forwarded child prompt, counted only here), `checkpoint` (also the owner approval of a launch deferred at critical load, `surface` `pressure_override`, see [resources](resources.md#owner-approval-at-critical)), `ask_user_question`, `guard_ask` (a guard ask a human answered), `drift_ask`, `script` (the owner dialog of `foreman_script`). `self_ruling_refusal` (a block) and `auto_review_allow` (an ask allowed without a dialog) are listed but are no dialogs. The extra key `total` sums every family except those two. An opened child session counts its own dialogs in its own trace (`foreman_dialogs({trace})` on each; sum them). With the trace off (`trace.enabled`) it says so instead of printing zero counts. The foreman-only tool `foreman_dialogs({trace?})` returns the same JSON (default: this session's trace; `trace` names another trace file), and `foreman dialogs <trace>` (`bin/foreman`, `.cmd`, `.ps1`) prints it for a trace file from a shell; it runs `extensions/core-adapter/dialogs-cli.ts` through `node --experimental-strip-types` and needs Node 22.6 or newer.
- `foreman rounds [--workspace here|KEY] [--branch B] [--pr N] [--since 30d] [--json]` (`bin/foreman`, `.cmd`, `.ps1`) prints the review rounds per change, counted from the findings store; the same line is appended to a closed session's result (see [review](review.md#review-rounds)). It runs `extensions/core-adapter/rounds-cli.ts` through `node --experimental-strip-types` and needs Node 22.6 or newer.
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The foreman's footer in a TUI session is two lines (`footer.style`: `"foreman"`, the default, or `"pi"` for Pi's own footer and the one-line usage status; child sessions never install it). Line 1: the model and thinking level, the git branch (dropped first when the line is narrow), a context bar of 10 cells (one filled cell per 10%, green below 50%, yellow below 80%, red from 80%) scaled to the compaction point Pi uses for the model, so a full bar means compaction fires (`14% of 200k`; the context window when the point is unknown or compaction is off), then `CH n%` (the session's cache-hit share: cache-read tokens over all prompt tokens) and the cache-timer bar (`footer.cacheBar`, default on). Line 2: the usage text and the other extensions' status texts, dimmed. For example `claude-opus-5-5 • high · main · ■□□□□□□□□□ 14% of 200k · CH 98% · ■│■■■■■■■■■ 3h ♨ ½ · ↓ claude-sonnet-5-5`.

The cache bar has 10 cells that drain with the share of the current cache lifetime still ahead (from the last cache touch until the cache is taken as cold, 0.95 x the TTL later; green above 50%, yellow above 20%, red at or below), so it refills at each warm. While a warm is coming, one vertical mark (`│`, `|` with `ui.symbols: "ascii"`) is inserted into the bar where the next warm fires (a warm goes out at about 90% of the TTL, so at 10 cells it sits after the first cell and at 5 cells it leads the bar); the bar keeps its cell count and the line is one column wider. Then comes the time: while a warm is coming it is the estimated total warm time, the time left until the cache goes cold now plus the warms the budget still allows in this stretch times the warm interval (`mm:ss` below 60 minutes, from 60 minutes whole hours rounded down: `1h`, `2h`); without a coming warm it is the plain countdown to cold (`mm:ss`, `h:mm:ss` above an hour, counting every second). The total is an estimate: a turn, a miss or a tier change alters it. Then `♨` while a warm is coming, followed by the tier glyph (`½` the half tier, `¼` the quarter tier; `1/2` and `1/4` with `ui.symbols: "ascii"`; left out while no tier is known), and `↓ <id>` for the idle rung the next notice turn runs on once the cache is cold. For example `■│■■■■■■■■■ 2h ♨ ½` (plenty of warms left), `■│■■■■□□□□□ 06:40 ♨ ¼` (the last warm is coming), `■■■■■■■■■□ 04:12 ♨ miss`, `■■■■□□□□□□ 02:05 ½` (warming ended). States: for the idle stretch a warm that missed ended (or a failed warm replay ended) the warm part reads `♨ miss` (`♨ err`) instead of `♨` and the tier glyph, with the plain countdown and no mark, until the next real request; *cold* shows empty red cells and `❄ cold` with the tier glyph; a *running turn* shows cells, the plain countdown and, when a fresh idle stretch would allow warms under the tier that holds now, `♨` and the tier glyph, with no mark; *downshifted* shows the idle model's own bar without the `↓` step; a model change starts the bar cold until the first request on the new model ends. With `ttl_long` (without an owned keep-alive), keep-alive disabled or the budget used up, the bar shows the plain countdown and the tier glyph only (no `♨`, no mark) and goes cold at expiry. It is hidden when the provider has no cache entry or an unknown TTL, no model is selected, or `footer.cacheBar` is false. On a narrow terminal line 1 drops the branch, then the `↓ <id>` step, then shrinks both bars to 5 cells (the warm part and the mark stay), then cuts the line with `…`. The glyphs come from `ui.symbols`. The countdown only repaints the footer once a second; it sends no request.

The usage footer (tokens and list-price cost) is on by default (`footer.usage`). It shows no run, wait or PR parts, and Pi draws no widget for subagent runs, background tasks, waits or PRs: the herdr-app mod is the only run and PR display (see [herdr](herdr.md#open-prs)), and pi-subagents has its own async display. Outside Pi,
the `foreman` launcher in `bin/` (`.cmd` and `.ps1` on Windows) runs the same scripts: `foreman update-check`, `foreman retro [args]`, `foreman sync [args]`, `foreman reports [args]` ([retro](retro.md)), `foreman findings list|dismiss|export` and `foreman retro models` ([review](review.md)), `foreman session` (below), `foreman radar` ([Radar](#radar)), `foreman bench` ([benchmark](bench.md), including `foreman bench review`) and `foreman knowledge` ([Knowledge sources](#knowledge-sources)). The keys
and their layer rules are in the tables of [ceremony](ceremony.md) and [safety](safety.md) and in the schema
`config/foreman.schema.json`.

While an idle prompt-cache keep-alive window is open (`providers.<p>.cache`, on by default for the built-in providers `claude-bridge` and `github-copilot` when their TTL is known) the
status line shows a keep-alive glyph (`♨`, or a nerd-font icon with `ui.symbols`). The refresh requests are not part of the
per-turn cost; `/foreman cost` sums them on a `keep-alive` line, split into Pi's and the foreman's own warms ([cache](cache.md)).
This status slot applies to `footer.style: "pi"`; the foreman footer carries the cache bar instead. The same status slot shows one glyph at a time, next to the keep-alive glyph: a cold-cache glyph (`❄`, nerd-font icon
with `ui.symbols`) while the prompt cache has expired, and a downshift glyph (`↓`) while the foreman runs on its idle
model ([ladder](ladder.md#idle-rung-foreman-downshift)). The glyphs live in `config/symbols.json` (`keepalive`, `cold`,
`downshift`); the Herdr sidebar leaves all three out.

## Knowledge sources

The bundled skills and design notes digest a few outside pages: skill-authoring guidance, per-model prompting guides and an article on folding subagents. `config/knowledge.json` lists them, one entry per source: `id`, `url`, `target` (the repo file that digests it), `sha256` (of the normalised page text, or of the raw bytes for a PDF), `checkedOn` (the day the digest was last read against it) and, for index pages, `discover: {pattern, label}`. The digests are written in our own words; the full text is never committed.

- `foreman knowledge check [--json] [--agent-dir D]` fetches each source (10 s timeout), reduces HTML to its main text (scripts, styles, navigation, header, footer, aside and comments dropped; Markdown is used as is), hashes it and compares with the manifest. Each source is `unchanged`, `changed`, `new` (no hash yet), `unreachable` or, for a discover entry, `discovered`. A discover entry also lists links that match its pattern and are not in the manifest, such as a new model page; these are reported and never added automatically. It exits 0 whatever it finds, and 2 when the manifest is unreadable.
- The normalised text of every source is cached per user in `<agent dir>/pi-foreman/knowledge/<id>.md` (the full text for a skill to read when its digest needs a recheck; a PDF source is cached as `<id>.pdf`, the file as it was fetched), and the result of the run goes to `<agent dir>/pi-foreman/state/knowledge-check.json` (`checkedAt`, `results`).
- `foreman knowledge accept <id>... | --all` copies the hash from the last check into the manifest and sets `checkedOn` to today. Run it after you reread the digest against the cache. An id without a usable result is refused with the reason.
- `foreman knowledge nudge` prints one line when the last check is older than `knowledge.nudgeDays` (your `foreman.json` over the defaults, default 30) or never ran. `foreman update-check` prints it on stderr, and `/foreman update-check` and `/sync` append it to their output.

The agent dir is `--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. A new source goes into `config/knowledge.json` and gets accepted.

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

Glyphs come from the `ui.symbols` set (`unicode` shown; `emoji`, `nerd` (Nerd Font icons) and `ascii` are the others, tables in
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

Remote entries (opened with `--machine`) are shown as `label@machine`, with a state from `remoteLive` (the hc terminal status the parent's watcher stores) and not from a local live file. An open ask shows first as `ask`; a blocked, working or idle terminal shows as such, and a terminal whose hc state is lost shows as finished. The registry status is only the fallback before the first hc status arrives. Stale marker: the parent's watcher records every contact with a remote child's terminal in `state/remote-contact/<child>.json` (`{child, contactAt}`, rewritten at most once a minute; the probe above keeps it fresh). When the last contact is older than 3 minutes (`REMOTE_STALE_S` = 180), radar adds the field `remoteStale: <seconds since contact>` to the node of an open, pending or closing entry; the node's `state` and glyph keep their words, an open ask still wins, and without a contact file (an older parent) there is no field. A parent that is gone or a remote that is unreachable therefore turns stale within about 4 minutes.

Options: `--once` prints one plain snapshot (no ANSI) and exits 0; without it the screen is redrawn with ANSI codes
every `--interval` seconds (default 3) until `q` or Ctrl-C (no curses, so Windows works; a stdout that is not a
terminal behaves like `--once`, which also prints the footer). `--json` prints one snapshot as a JSON line and exits;
`--follow` prints one such line every `--interval` seconds until stopped (no ANSI, no keys; the Herdr sidebar plugin
reads it): `{"v":1,"now","symbols","roots":[node]}`, each node with `key`, `kind`, `name`, `role`, `rung`, `state`,
`sym`, `glyph`, `paneId`, `pid`, `cwd`, `age_s`, `blocked_s`, `own` and `tot` (`in`, `out`, `uncached`, `cost`), `done_children` and
`children`. The header also has `recentRunSeconds` (`radar.recentRunSeconds`, default 8: how long a finished run stays visible
as `✓ role` before it joins the done count), run nodes have `ended_s` (seconds since the run ended, or `null`) and session
nodes have `sid` (session id). `uncached` is fresh input plus cache writes; `in` still includes cache reads. `--symbols unicode|emoji|nerd|ascii` overrides `ui.symbols`. `--agent-dir` (default `PI_CODING_AGENT_DIR`, else `~/.pi/agent`). `--since HOURS`
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
| `blockedOn`, `blockedKind`, `blockedNote`, `ownerBlockedSince` | optional, present only while a classified source is open: `blockedOn` is `owner` while any dialog or owner question is open, else `parent`; `blockedKind` is a fixed word (`approval`, `question`, `checkpoint`, `script`, `confirm`, `dialog`, `parent-ask`, `hold`), never dialog text; `blockedNote` is present only with kind `hold`: the hold's one-line note (what the owner has to do or decide, capped at 200 characters; nothing reads it yet); `ownerBlockedSince` is the ISO time the owner waits began (empty to non-empty; an older dialog closing while a younger one stays open keeps it). `state` and `blockedSince` keep their meaning |
| `lastCheckpoint` | optional: the owner's last answer to this session's plan checkpoint, `{decision, at}` (`approve`, `revise` or `reject`, ISO time); no plan text; the parent reads it for its answer line |
| `tokensIn`, `tokensOut`, `cost` | the session's own model usage as its footer shows it (`↑` in incl. cache reads and writes, `↓` out, list cost); runs are not included |
| `runs` | subagent runs: `launchId`, `role`, `rung` (`model`, `strong` or `null`), `state` (`working`, `ask`, `done`), `tokensIn`, `tokensOut`, `cost` (used when the usage file has no line for that `launchId`), `model` (the launch's explicit model as given, else `null`) |

Rows of finished or lost sessions disappear from radar after `--since` hours; those files are not deleted, except a closed session's lost or stale file (see below).

**Plan publication.** A session that saves a plan (the foreman's `.workflow/scratch/plan-<topic>.md` or `plan-<topic>.html`, or `<handoff dir>/plan.md` in a child; a child with an HTML plan keeps the page as the shown plan and copies the generated `plan-<topic>.md` to its handoff `plan.md`) gets a
show dir `<scratchDir>/show/<sessionId>/` with `plan.json` (path, title, version `v`, time, hashes) and two snapshots, `plan.ruled.md` and
`plan.prev.md`, rolled at the ruling points: a `foreman_checkpoint`, a `[plan-review]` launch, and a child's `Plan from` message to its parent. The
live file then carries `show: {dir, plan?, note?}` (`plan` and `note` are version hints), which radar passes through on the session node; the
[herdr-app plan panel](herdr.md#plan-panel) reads the session's `pages/pages.json` from that dir and lists its pages. Plans written through the shell are not observed, and a remote child's live file is
on the remote machine, so a parent shows no plan for it.

A `done` session expires sooner: once its last activity (newest of `heartbeatAt`, `lastEventAt`, the trace mtime) is older
than `radar.doneTtlMinutes` (default 30; `--done-ttl MINUTES` overrides it) its row is hidden, unless a shown descendant
keeps it, and on each refresh radar deletes the presence file of a `done` session whose `heartbeatAt` and `lastEventAt`
are both older than the TTL (file mtime when neither parses). Only presence files with `state: "done"`, and the lost or stale file of a closed session (below), are ever
deleted; unparseable or unreadable files are skipped. `working`, `blocked`, `lost` and `stale` rows never expire by age
(only by `--since`). A session that is not `done` and has had no heartbeat for 15 minutes shows the state `stale`
(the waiting glyph); between 90 seconds and 15 minutes it shows `lost`. A session whose registry entry is `closed` (matched by
its child id or handoff dir) and whose file is neither done nor fresh shows as closed; a fresh heartbeat wins over the registry.
Radar deletes such a file once its last activity is older than the done TTL and the session is provably closed (pid dead
and pane gone), the same condition as for a done file.

Exception: a presence file that a pane note names (`state/panes/<terminal>.json`, written by a session in a kept `hc` terminal) is kept while its
last activity is within 14 days, so a crash restart can read it (see [Crash restart](#crash-restart)).

## Crash restart

A session in a kept `hc` terminal is restarted in its pane after a crash of the machine, the herdr core or the terminal: a hook in your shell
startup file runs `foreman pane-resume`, which shows a 5 s countdown and starts `pi --session <file>` in the session's folder (design, hook and limits:
[herdr](herdr.md#crash-restart); the hook: [install](install.md#the-resume-hook)).

What comes back by itself: the history; the identity of an opened child (intercom id, parent, label, model); the plan phase and
the `PI_BG_*` variables the session was opened with (on Windows not `PI_BG_SHELL` and `PI_BG_SHELL_PATH`: pi-foreman sets those itself at every start, and the shell's own values stay); the ceremony state, including the plan phase and a checkpoint approval. What does not: waits
(`foreman_wait`), running child runs and background tasks. The restarted session gets one appended message with the time of the last sign of life, and
once, ten seconds after the start, one message holding everything it found: the child runs that pi-subagents still lists as running although the machine restarted and the
background tasks that are gone (on a start or resume only, not on /new or /reload). A session idle for more than 14 days is not restarted and its note is swept. `sessions.hc.resume` `off` turns it off.
On Windows the hook is a block in the PowerShell profiles and in Git Bash; the one of `hc`'s configured shell runs (see [herdr](herdr.md#crash-restart)).

## pi-intercom

`pi-intercom` is bundled with the package (pinned); `foreman setup` filters it out with `--no-intercom` and otherwise writes
`<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if absent
(see [install](install.md)). Sessions then address each other by name or id; the close request above travels over
it as plain text `foreman:close`, accepted only from the recorded parent session. `foreman setup --intercom-hc
[--machine-name <name>]` sets `crossMachine.transport: "hc"` (and `crossMachine.machineName`) in that file, so a child on
a remote machine can send to `<uuid>@<parentName>` over hc; the remote needs `hc machine add <parentName>`
([safety](safety.md#known-limit-remote-machine-trust-boundary)). The package pins a fork of `pi-intercom` for this
(see [install](install.md)).

An inbound intercom message starts a turn in every session, subagent children included, under the session's normal guards
(none of the gates is relaxed for it). pi-foreman detects the message itself (custom message type `intercom_message`), so it works with
both delivery paths of `pi-intercom` 0.18.1: on Pi 1.2.0 and newer an idle session is started by the message (no wake line), on
Pi before 1.2.0 `pi-intercom` wakes it with the legacy line `New intercom message above.`. An accepted `foreman:close` to an idle
session makes that started turn the close turn (no extra turn); to a busy session the close turn follows the run.

## Herdr

Herdr's Pi integration (`herdr integration install pi`, installed by you, never by the installer) shows a session
as working, idle or blocked. pi-foreman emits `herdr:blocked` on `pi.events` while any dialog waits for you, so
the pane reads blocked ("?") instead of working. The foreman tree in Herdr's Agents panel is a separate plugin:
[Herdr sidebar](herdr.md). In a Herdr pane the session also pushes its own sidebar tokens (`sidebar.py push`, on every state change and every 5 s; the header carries a dense braille frame while it works or waits on something; `ui.spinner: false` turns that off); see [who publishes what](herdr.md#who-publishes-what). Design record: `design/architecture.md`
[session features](../design/architecture.md#session-features-phase-4).

### Blocked shim

One tracker per Pi process counts what is waiting for you:

- any Pi dialog, from every extension (Pi's `ui_prompt_start` .. `ui_prompt_end`);
- each permission ask (`permissions:ui_prompt` .. `permissions:decision`, by request id), including a child's ask
  forwarded to this session;
- an open `ask_user_question` or `plan_mode_question` tool call, from its `tool_call` until its `tool_execution_end` (released as well on `turn_start` and `agent_end`), which counts even when Pi sends no `ui_prompt_*` events;
- pi-foreman's own asks (checkpoint, guard confirms).

It emits `herdr:blocked {active:true,label}` when the first one opens and `{active:false}` when the last one closes,
so Herdr's counter stays balanced however they overlap. The end of a turn releases permission, question and own asks that never
got their decision (an open Pi dialog stays until Pi closes it); shutdown releases everything. Pi can orphan a
dialog that a second dialog replaces (it never sends that dialog's end); typed input then releases the stale dialog.
While such a dialog is unsettled Pi sends no `ui_prompt_start` for later ones, so pi-foreman's own asks also hold the
presence file's `state` at `blocked` directly (with or without Herdr); a Pi dialog's end or typed input does not
release an own ask that is still open (typed input does close an own `ask.md`, see [ask by file](#ask-by-file-parent-that-is-not-a-pi-session)).

Label: for a permission ask `<agent> · <tool> <first word>` (the requesting child's agent when forwarded; a path is
cut to its basename; leading `env` and `NAME=value` assignments are skipped (a quoted or `$(…)` value up to its closing quote or paren),
nothing after an `=` is shown, and a word that is not a plain command name is dropped;
never the full command), else the dialog title, else pi-foreman's ask title, else the dialog
kind (a question call: its first question's header, else `question`); at most 80 characters, control characters removed. A later ask keeps the first label (Herdr shows that one).

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

Background shell commands run with `bg_run`, the tool of the bundled [background-tasks add-on](herdr.md#bundled-add-on-background-tasks) (status, logs and kill beside it); the add-on wakes the session when a task ends. The command passes the same guards as a bash call, with no bypass: the gate's rules and the
shell-write guard. A command that is empty or not a string is refused.
On Windows the command runs in Git Bash, so write POSIX syntax; only when no bash is found it runs under `cmd.exe` (the session says so once, at start), see the
[known limit](safety.md#known-limit-background-runs-on-windows).

`foreman_wait` `pid` and `ci` waits take an optional `log`: a file inside the workspace, its `.workflow/`, `<agent dir>/pi-foreman/state/wait/`
or the session scratch dir. A path outside those, or one that is not a string, is refused and no wait is registered. The log is named in the wake line.

`/foreman waits` lists the session's pending waits: id, kind, note, age, time left and the last 5 lines of the log. The note is also what
the presence file (`waits[].note`) and the Herdr sidebar line 2 show.

`/foreman waits` also lists the add-on's running tasks.

## Further session keys

| Key | Meaning and layer rule |
|---|---|
| `sync.runRetro` | Run the retro step during `/sync`, before the repository commits (default `true`). |
| `sessions.hc.resume` | `auto` (default) or `off`: restart a Pi session in its kept `hc` terminal after a crash (see [Crash restart](#crash-restart)). User or overlay config only. |
| `radar.doneTtlMinutes` | A presence file that a pane note names is kept for up to 14 days. Minutes after which `foreman radar` hides a finished session and deletes its presence file (default 30). Radar reads the harness, organisation and user layers, no project file. |
| `retro.proposalMinReviews` | Reviews needed before a retro proposal (default 5). User or overlay config only. |
| `retro.enabled`, `retro.report`, `retro.startNote`, `retro.workspaceKey`, `retro.expireDays` | Retro and report switches (see [retro](retro.md)). `retro.enabled` null is on in tui and rpc, off in json and print. `workspaceKey` is user or overlay config only. |
| `steward.enabled`, `steward.minNew`, `steward.maxWaitHours`, `steward.checkMinutes`, `steward.maxProposals` | The optional report steward (see [retro](retro.md#steward)). `steward.enabled` (default false) allows `/foreman steward on`; the others set when the steward is woken (3 new reports, 24 hours, checked every 30 minutes) and how many rounds it proposes at once (3). |
| `compaction.maxTokens` | Cap in tokens on where `foreman setup` makes Pi compact (default 200000, minimum 50000, null = no cap); a project can only lower it, and a session layer value is ignored with a warning (setup applies it). See [cache](cache.md#where-compaction-fires). `compaction.priceTiers` and `compaction.threshold` were removed: a warning, the keys are ignored. |
| `wait.batchWindowSeconds` | Window in which wait notices are batched (default 300). |
| `wait.maxActive` | Concurrent waits allowed (default 8); a project or session can only lower it. |
| `wait.ci` | CI waits on or off (default `true`); a project or session can only set false. |
| `close.autoClean`, `close.worktreeDir` | Cleanup at close and the worktree convention directory (see [close](close.md)). `autoClean` can only be turned off by a project or session; `worktreeDir` is user or overlay config only and accepts relative, absolute and `~` values with `<repo>` (see [close](close.md#the-worktree-root)). |
| `sessions.blockedNoticeSeconds` | Seconds before the parent gets one information-only message: a child waits on its owner, or has waited for the parent's answer to its question (default 600, `0` is off); user or overlay config only (see [a child that waits on the owner](#a-child-that-waits-on-the-owner)). |
| `herdr.blockedShim` | Show any open dialog or permission ask as blocked in Herdr (default `true`); any layer may set it. |
| `herdr.groupTag` | Herdr group tag on opened child and parent panes (default `true`); any layer may set it. |
| `ui.symbols` | Glyph set for radar and the Herdr sidebar plugin: `unicode` (default, broadest support), `emoji`, `nerd` (Nerd Font) or `ascii`; an unknown value reads as `unicode`; any layer may set it. |
| `ui.spinner` | Animate the working glyph (dense braille frames, 250 ms steps; the sidebar also ticks while a session waits on something) in the Herdr sidebar (default `true`); `false` shows static glyphs everywhere; any layer may set it. |
