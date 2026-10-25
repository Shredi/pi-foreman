# Session close

> Covers the ownership manifest, the CLOSE report, cleanup at close, handovers to the parent and `foreman worktree sweep`.
> Read it when a session ends, when `/sync` reports `CLOSE: open`, or when a parent has to take or drop a child's leftovers.
> Cleanup removes only paths the manifest lists and only when every precondition passes; anything else is handed over.

A close cancels the session's own pending `foreman_wait`s (trace `waits_cancelled {count, note}`, notice `cancelled waits: <ids>`); it is refused only while a child run is still active.

## Artifact classes

| Class | Examples | Owner | Lifetime |
| --- | --- | --- | --- |
| session-private | worktrees and scratch dirs a session made for itself, `<state>/scratch/<session>/` | the creating session (a child's entries carry its launch id as `owner`) | removed at that session's close when the preconditions pass, else a handover |
| round-shared | a topic dir `.workflow/scratch/<topic>/` several sessions of one round write into | the session that created it; a parent takes or drops its children's | removed by whoever holds the manifest entry at close |
| durable | handoff dirs, files directly in `.workflow/scratch/` (plan, ledger, result) | the repository or the parent | never removed by close; handoff entries are always `kept:` |

## Locations

- Worktrees: the convention is `../<repo>.worktrees/<branch>` (config `close.worktreeDir`), for example
  `../myrepo.worktrees/feature-x`. Agent worktrees under `<repo>/.claude/worktrees` also count as convention.
  So does pi-subagents' default root for managed worktrees (`worktree: true` launches),
  `../worktrees/<repo>/pi-worktree-<runId>-<n>`; the launch-wait result prints the exact path
  (`worktree: <path> (branch <b>)`). Any other linked worktree is `off-convention:` in a sweep.
- Worktree setup hook: `foreman setup` registers `bin/foreman-worktree-setup` as pi-subagents'
  `worktreeSetupHook` (Linux and macOS, only when unset; see [install](install.md)). pi-subagents symlinks the main
  checkout's `node_modules` into each managed worktree before the hook runs; for a repository with a lockfile the hook
  replaces that link with a plain copy (or runs `npm ci` when the main checkout has none), so a builder's `npm ci`
  never rewrites the main checkout. The hook is global for the user: it runs for every pi-subagents worktree and is a
  no-op without the symlink and lockfile. `/foreman doctor` warns about a symlinked `node_modules` in any live worktree.
- Scratch: `<state>/scratch/<session>/` (an implicit private entry, no recording needed) and topic dirs
  `.workflow/scratch/<topic>/`. Files directly in `.workflow/scratch/` are never recorded and never removed.
- Handoff dirs of `/foreman session open` are durable.

A child's managed worktree (a `worktree: true` launch) is pi-subagents' to remove: at run end it captures a patch of the changes under `<run result dir>/worktree-diffs/step-N` (the "Result path" of the launch result is that dir) and then removes the worktree. A builder that hit its turn cap or its time limit therefore leaves its uncommitted work recoverable from that patch, not in the removed tree. `agents/builder.md` says the builder never commits unless its brief says so, so a brief that wants commits must say so.

## Manifest

`<state>/sessions/<session>/manifest.json` (`<state>` = `<agent dir>/pi-foreman/state`, or `PI_FOREMAN_STATE_DIR`):
`{v, session, entries: [{path, kind, class, owner, branch?, base?, ts, removed?}], dropped: [path]}`.
Kinds are `worktree`, `scratch` and `handoff`; classes `private`, `round`, `durable`. Entries are additive and
deduplicated by real path; `scripts/foreman_close.py` is the only writer.

Entries get there silently, with no model turn and no tokens:

- The adapter watches successful bash calls. `git [-C d] worktree add ...` records the worktree (branch from
  `-b`/`-B`, else the path's basename when there is no commit-ish and no `--detach`). `mkdir [-p]` of a new dir under
  `.workflow/scratch/<topic>/` or `<state>/scratch/<x>/` records that topic dir.
- A write or edit into a new `.workflow/scratch/<topic>/` subdir records the topic dir.
- `foreman close record --kind worktree|scratch|handoff --path P [--branch B] [--base B] [--owner O] [--class private|round|durable] [--session S]`
  appends one by hand.

A child's entries go into its parent session's manifest with `owner` = the child's launch id.

## CLOSE report

`foreman close [--session S] [--cwd D] [--state D] [--dry-run] [--result PATH] [--json]` prints at most 40 lines:

| Line | Meaning |
| --- | --- |
| `CLOSE: ready` or `CLOSE: open` | The verdict. |
| `uncommitted:`, `unmerged:` | Dirty repositories; branches this session created that are not merged. |
| `open item:` | An open `- [ ]` item of the bound ledger. |
| `pending child:` | A child session or run that is not done. |
| `removed:` / `would remove:` | Cleaned up (`would remove:` with `--dry-run`). |
| `kept:` | Durable entry, left alone. |
| `handover: <path> — <reason>` | Own entry that could not be removed. |
| `child handover: <path> — <reason> (from <session>)` | A child's handover, not yet taken or dropped. |

Ready means nothing is uncommitted, unmerged, open, pending or an untaken child handover. The session's own
handovers block only a top session (no parent); with a parent they are passed up and do not block.

`close.json` next to the manifest holds `{v, session, parent, ts, dryRun, uncommitted, unmerged, openItems,
pendingChildren, removed, wouldRemove, kept, handovers, childHandovers, ready, lines}`; `--dry-run` writes
nothing. `--result PATH` appends `## Close` with the lines to that file. Exit 0 ready, 3 open, 1 lock timeout
(another writer holds the manifest lock), 2 usage or config error. `/foreman close` runs the report (with
`--trusted-project` in a trusted project, as `/sync`) and traces `close` with decision `report`.
A removed entry is marked `removed: <ts>` in the manifest, so a second run of the same session lists it as
`removed:` again (never as a handover); other entries whose path is already gone are skipped.

## Child sessions

`/foreman close` first asks the session's own child sessions (registry entries opened with `foreman session open`, status
`open` or `pending`) to close, waits up to `close.childWaitMs`, and prints one line per child (`closed`, `refused`,
`timeout`, `not sent`) under the CLOSE report. This never fails the parent's close. See
[sessions](sessions.md#closing-the-children-with-the-parent).

## Pushed branches without a PR

`/foreman close` also starts a check for branches this session pushed. For each pushed branch, in this order:

1. The base branch is skipped.
2. A PR of that head branch tracked in this session (open, or since merged or closed) ends the check.
3. One `pr_find {head, state: all}` in the push directory: a PR of any state ends the check (an open one is tracked).
4. `foreman_close.py merged` asks whether the branch is already in the base branch; if so the check ends.

Otherwise the session gets one warning, `pi-foreman: pushed branch <name> has no tracked PR (open one, or pr_track <number>
once it exists)`. The notice is display only, through the UI, and never a message the model sees. The check is
fire-and-forget: it never delays the close and the notice appears when the check ends. One check runs at a time. Each branch
gets the notice once; a branch whose check failed (for example the host did not answer) is checked again after 10 minutes.
The finish gate starts the same check when a triaged session finishes, so a session that was never triaged gets the notice
only from `/foreman close`.

The `merged` subcommand: `foreman close merged --ws <dir> --ref <ref> --base <branch>` prints `{"merged": true|false}`. `<ref>`
is a full ref (`refs/remotes/<remote>/<name>`, else `refs/heads/<name>`). It needs no session, and it checks only the base
branch (no upstream clause, unlike the close cleanup). `--base` is passed only when `safety.ops.baseBranch` is set;
otherwise the remote's default branch applies.

## Cleanup preconditions

Cleanup runs when `close.autoClean` is on and not `--dry-run`. Per manifest entry:

- Worktree: clean including ignored files (outside `safety.ops.worktreeDisposable`), branch merged into the base
  branch or contained in its pushed upstream, not locked, no stash entry referencing the branch, no live session
  of another id with its cwd inside. Removal is `git worktree remove` without `--force`, then `git branch -d`
  (never `-D`).
- Scratch: a directory inside `.workflow/scratch/` or `<state>/scratch/`, not a symlink, no live session inside.
  Removal uses `trash` when available, else removes exactly that path and nothing else.
- A failed precondition turns the entry into a handover with the reason (`worktree_dirty`, `ignored_files`,
  `not_merged`, `worktree_locked`, `stash_references_branch`, `in_use (session X)`, `in_use_by_caller` (sweep only),
  `symlink`, `outside_scratch`,
  `autoClean off`, ...).

## Commands

- `foreman close --dry-run`: the full report with `would remove:`; nothing is removed or written.
- `foreman close --take PATH` (on the parent): a child's handover becomes the parent's own manifest entry.
- `foreman close --drop PATH`: stop listing it; nothing is removed.
- Untaken child handovers are re-listed on every run and keep the parent's report open.
- `foreman worktree sweep [--cwd D] [--dry-run]`: removes every linked worktree of the repository that passes
  the same preconditions, listed in a manifest or not (`removed:`, `would remove:`, `skipped: <path> — <reason>`).
  A worktree outside `close.worktreeDir`, `.claude/worktrees` and `../worktrees/<repo>` also gets an `off-convention: <path>` line
  (information only). A branch with no commits beyond its base counts as merged, so a fresh empty worktree is swept.
  The worktree that contains `--cwd` (default: the current dir) is skipped with `in_use_by_caller`.
  Warning: sweep removes a freshly created worktree that has no commits beyond its base yet; use `--dry-run` first.

## Sync

`foreman sync` and `/sync` run the same report and cleanup and show the block at the top of their output (at most
15 lines, JSON key `close`; the rest is in `close.json`). With `--dry-run` the block is the dry-run report. A
failure of the block is one line, never an exit code.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `close.autoClean` | `true` | Remove manifest worktrees and scratch at close when the preconditions pass. A project or session may only set `false`; then every entry is a handover with reason `autoClean off`. |
| `close.worktreeDir` | `../<repo>.worktrees` | Worktree convention directory. User or overlay config only. |
| `close.childWaitMs` | `60000` | How long `/foreman close` waits for the session's own child sessions to close (see Child sessions). `0` sends and does not wait. User or overlay config only. |

## Known gaps

- Unread intercom messages are not reported (the adapter has no API for them).
- Recording skips bash chains it cannot parse, `~` paths and an unknown cwd; use `foreman close record` for those.
- Only manifest paths are cleaned at close; other worktrees need `foreman worktree sweep`.
