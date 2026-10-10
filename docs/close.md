# Session close

> Covers the ownership manifest, the CLOSE report, cleanup at close, handovers to the parent and `foreman worktree sweep`.
> Read it when a session ends, when `/sync` reports `CLOSE: open`, or when a parent has to take or drop a child's leftovers.
> Cleanup removes only paths the manifest lists and only when every precondition passes; anything else is handed over.

## Manifest

`<state>/sessions/<session>/manifest.json` lists what a session created:
`{v, session, entries: [{path, kind, class, owner, branch?, base?, ts}], dropped: [path]}`.
Kinds are `worktree`, `scratch` and `handoff`; `handoff` entries are durable and always `kept:`.
A directory `<state>/scratch/<session>/` counts as a scratch entry without being recorded.
`foreman close record --kind K --path P [--branch B] [--owner O] [--session S]` appends an entry.

## Report and cleanup

`foreman close [--session S] [--cwd D] [--state D] [--dry-run] [--result PATH] [--json]` prints
`CLOSE: ready|open` and the lines `uncommitted:`, `unmerged:`, `open item:`, `pending child:`,
`removed:` (`would remove:` with `--dry-run`), `kept:`, `handover:` and `child handover:`, writes
`close.json` next to the manifest and appends `## Close` to `--result`. Exit 0 ready, 3 open, 2 usage.
`foreman sync` shows the same block at the top of its output (report only, nothing removed).

| Key | Default | Meaning |
| --- | --- | --- |
| `close.autoClean` | `true` | Remove manifest worktrees and scratch at close when the preconditions pass. A project or session may only set `false`; then every entry is a handover with reason `autoClean off`. |
| `close.worktreeDir` | `../<repo>.worktrees` | Worktree convention directory. User or overlay config only. |

## Handovers

`foreman close --take PATH` and `foreman close --drop PATH` run on the parent: take makes a child's
handover the parent's own manifest entry, drop stops listing it. Untaken child handovers keep the
parent's report open.

## Sweep

`foreman worktree sweep [--cwd D] [--dry-run]` removes every linked worktree that passes the same
preconditions, listed or not, and lists worktrees outside `close.worktreeDir` and
`.claude/worktrees` as `off-convention:`.
