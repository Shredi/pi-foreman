# Session close

> Covers the ownership manifest, the CLOSE report, cleanup at close, handovers to the parent and `foreman worktree sweep`.
> Read it when a session ends, when `/sync` reports `CLOSE: open`, or when a parent has to take or drop a child's leftovers.
> Cleanup removes only paths the manifest lists and only when every precondition passes; anything else is handed over.

## Artifact classes

| Class | Examples | Owner | Lifetime |
| --- | --- | --- | --- |
| session-private | worktrees and scratch dirs a session made for itself, `<state>/scratch/<session>/` | the creating session (a child's entries carry its launch id as `owner`) | removed at that session's close when the preconditions pass, else a handover |
| round-shared | a topic dir `.workflow/scratch/<topic>/` several sessions of one round write into | the session that created it; a parent takes or drops its children's | removed by whoever holds the manifest entry at close |
| durable | handoff dirs, files directly in `.workflow/scratch/` (plan, ledger, result) | the repository or the parent | never removed by close; handoff entries are always `kept:` |

## Locations

- Worktrees: the convention is `../<repo>.worktrees/<branch>` (config `close.worktreeDir`), for example
  `../myrepo.worktrees/feature-x`. Agent worktrees under `<repo>/.claude/worktrees` also count as convention.
  Any other linked worktree is `off-convention:` in a sweep.
- Scratch: `<state>/scratch/<session>/` (an implicit private entry, no recording needed) and topic dirs
  `.workflow/scratch/<topic>/`. Files directly in `.workflow/scratch/` are never recorded and never removed.
- Handoff dirs of `/foreman session open` are durable.

## Manifest

`<state>/sessions/<session>/manifest.json` (`<state>` = `<agent dir>/pi-foreman/state`, or `PI_FOREMAN_STATE_DIR`):
`{v, session, entries: [{path, kind, class, owner, branch?, base?, ts}], dropped: [path]}`.
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
  A worktree outside `close.worktreeDir` and `.claude/worktrees` also gets an `off-convention: <path>` line
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

## Known gaps

- Unread intercom messages are not reported (the adapter has no API for them).
- Recording skips bash chains it cannot parse, `~` paths and an unknown cwd; use `foreman close record` for those.
- Only manifest paths are cleaned at close; other worktrees need `foreman worktree sweep`.
