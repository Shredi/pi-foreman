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
- The worktree root is `close.worktreeDir` ([below](#the-worktree-root)); the default and every example here use `../<repo>.worktrees`.
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

## Close refused while a PR is open

A session that holds a [PR watch](tools.md#watch) on a PR that is not merged or closed refuses every close (`/foreman close`,
an intercom `foreman:close`, a remote parent's close order): `pi-foreman: close refused: PR #n open and watched (merge it,
or pr_unwatch)`. Merge or close the PR, or end the watch with `pr_unwatch`, then close again. The check is part of the same
refusals as a running child run or a pending `foreman_wait`, so a parent's close of a child gets the refusal as a reply.

A PR merged after the last poll does not block: before refusing, a close runs one fresh `pr_status` per watched PR and ends
the watches of merged or closed PRs (without a message). While that lookup runs the close counts as in progress, so a second
close (say from Herdr and from intercom) is refused as `a close is already in progress`. With no watch held the close needs
no lookup and starts at once. A lookup that fails keeps the watch, and so the refusal.

## Self-finish on merge

A child foreman session (`PI_FOREMAN_HANDOFF_DIR` set) whose watched PR is merged closes itself; nobody sends `foreman:close`.
When the watch reports `merged`, the adapter starts the normal close sequence with the source `pr-merged` (it is not a
`close.from` source). The sequence is the one above, with these differences:

- The close prompt asks for the result file `<handoff dir>/result.md`: the PR number, the merge commit and anything left open.
- After the result file the session tells its parent `PR #n merged, closing` and the usual `Result from <label>: <path>`.
- **Target worktree.** The session cwd may be a subfolder: it is first resolved to its worktree root (the `git worktree list --porcelain` entry containing it, longest match, by real path) and that root is the worktree in every check and message. A cwd in no listed worktree refuses the cleanup with a line naming the cwd, removes nothing and prints no remove command; the cwd's `.workflow/` is still snapshotted. The adapter runs one `pr_status` first. When the session's cwd has the PR head ref checked out, that
  worktree is the target. Otherwise (a round that worked in a second worktree while the session sits in the main checkout)
  the target is the worktree of `git worktree list --porcelain` (run in the session cwd) that has `refs/heads/<head ref>`
  checked out; its path is compared by real path, separators and, on Windows, case. The main (first) worktree and a head ref
  equal to the PR base branch are never a target: the adapter refuses with a line naming the worktree and branch, and
  `selfclean` refuses with `main_worktree` or `default_branch` (the repository's base branch). A head branch checked out in
  no worktree gives `merged fact: not verified (PR #n head branch <b> is not checked out in a worktree of this repository)`
  and `cleanup: not started; nothing is removed`; the cwd snapshot is still taken. The session records nothing for this.
- **Verified-merged fact.** A squash or rebase merge leaves the branch tip outside the base branch, so `not_merged` would
  refuse. The fact is passed only when the PR is `merged`, its head ref is the target's branch and its `headSha` equals the
  target's branch tip. The fact is a `--verified-merged <sha>` flag of
  `foreman_close.py selfclean`. With it `not_merged` does not apply and the local branch is deleted with `git update-ref -d`
  against `<sha>`, for exactly that branch, and only while the branch tip and `HEAD` still are `<sha>` when the removal runs (a
  moved tip keeps the branch). Without it the rules
  of [Cleanup preconditions](#cleanup-preconditions) stay (`git branch -d`, merged into the base or its pushed upstream).
- **`.workflow/` archive.** Before the checks the target worktree's `.workflow/` is snapshotted into
  `<handoff dir>/workflow/`; a session cwd that is another worktree gets `<handoff dir>/workflow-cwd/` by the same rule.
  The snapshot keeps only what the session itself produced. The age rule (only files written since the pi process started;
  the session's bound ledger is always kept) applies to the `.workflow/` of the repository's main worktree, the folder shared
  by all rounds, whether it is reached as the target or as the session cwd (decided from `git worktree list`, by real path).
  A linked worktree's own `.workflow/` belongs to its round: all its regular files are kept whatever their age (a file the
  opener wrote before the session started does not block the cleanup). In both, never the top-level folders `closed/` and `archive/` (matched in any case; so a snapshot never contains a
  snapshot), never a symlink or junction (links are not followed or copied), never the destination itself. The total is
  capped at 16 MiB over both snapshots of one close (ledgers, plans and notes are kilobytes; the cap keeps a handoff dir cheap
  to copy); a file that would cross the cap is skipped, smaller later ones still go in. There is no config key for it.
  The line `workflow archive: <dir> (<n> files)` goes into the report; a session cwd that is another worktree and has files
  in its snapshot adds `workflow archive (session cwd): <dir> (<n> files)` (the `workflow-cwd/` dir) for the second snapshot. When something was left out,
  `workflow archive left out: <what (why)>; ...` follows (`closed/ (other rounds)`, `archive/ (earlier snapshots)`, `N links`,
  `N unreadable or special entries` (unreadable folders, files that fail `stat`, FIFOs, sockets, devices),
  `N files older than the session` (main worktree only), `N files over the 16 MiB cap: a, b, ...`). Only when nothing of the target's `.workflow/` was
  left out does it no longer count for `ignored_files`; otherwise the refusal `ignored_files` keeps the worktree.
  When the adapter refuses up front (the target is the main checkout, or the head ref is the PR base branch), the session
  cwd's `.workflow/` is still snapshotted by the same rule, with the same lines; nothing is removed. Every other precondition stays: clean tree, no stash entry referencing the branch, not locked, no other live
  session with its cwd inside.
- **Checks before the exit.** The preconditions are checked in the session. A refusal (`worktree_dirty`, `stash_references_branch`,
  `ignored_files`, `not_merged`, `in_use (session X)`, ...) is written into `result.md` under `## Merge cleanup` and into the
  message to the parent (`PR #n merged, closing (cleanup: not started (<reason>); ...)`; for `ignored_files` the reason names the first files: `ignored_files: a, b, c, +N more`, and the owner copies or deletes them); nothing is spawned, and the worktree
  and the branch stay. Each such line names the real worktree root (and the branch, where one is checked out) and what the owner does:
  the action for the reason (commit or discard changes, copy or delete the ignored files, wait for the merge), then the owner
  reads the cleanup preconditions here before removing anything. For any other reason (an unknown one, or a check that gave no
  answer) the line names the worktree and branch, the reason, and says the owner reads the cleanup preconditions here before
  removing anything. A worktree with no commit checked out says the owner commits the round's work in it and a later close
  checks it again. No refusal line names a removal command or tool (neither `foreman worktree sweep`, `git worktree remove`
  nor `git branch -D`).
  For the main checkout and the default or PR base branch (`main_worktree`, `default_branch`, or the up-front refusal) the line
  says the main checkout is never removed and the branch stays while it is checked out there (a base branch in a linked worktree:
  the worktree stays and the branch is kept) and there is nothing for the owner to do. When the head branch is checked out in no
  worktree, nothing is removed and the line names the session's worktree root and says the branch is checked out in no worktree
  and nothing is done with it: for the main checkout, that it is never removed and there is nothing for the owner to do; for a
  linked worktree that has the default branch checked out (the check refuses it as `default_branch`), that the worktree and
  that branch are never removed and there is nothing for the owner to do; for any other linked worktree, that the worktree stays
  and the owner reads the cleanup preconditions here before removing anything; the same holds for a session cwd in no worktree
  of the repository and for a linked worktree with no branch checked out (which also says the owner checks out the round's
  branch in it first). No line tells the owner to check out a branch named by the PR status.
- **Detached cleanup.** The last step of the close spawns a detached process (`foreman_close.py selfclean --wait-pid`; node
  `spawn` with `detached` and `unref`, no console window on Windows). It waits for the session's pi process to exit, checks
  again, runs `git worktree remove` (never `--force`) and the branch delete, and writes `<handoff dir>/cleanup.json`:
  `{"status": "removed" | "failed", "reason"?, "worktree", "branch", "branchDeleted"?, "ts"}`. It needs no parent adapter and
  no closed notice, so it also works when the close was started by Herdr. It gives up after 10 minutes if the process does not exit.
- **Remote branch.** Nothing is deleted on the remote and no guard is lifted. If the remote head branch still exists, the report
  lists `kept: remote branch <b> (enable delete head branch on merge)`. Turn on the host's setting *Automatically delete head
  branches* (GitHub: repository settings, General, Pull Requests) so merging the PR removes it.
- **Closed unmerged.** A PR that is closed without a merge starts no close and no cleanup. The watch message says
  `report to the parent: PR #n closed unmerged`, and the session waits for the parent.

## Pushed branches without a PR

`/foreman close` also starts a check for branches this session pushed. For each pushed branch, in this order:

1. The base branch is skipped.
2. One `pr_find {head, state: all}` in the push directory: a PR of any state ends the check.
3. `foreman_close.py merged` asks whether the branch is already in the base branch; if so the check ends.

Otherwise the session gets one warning, `pi-foreman: pushed branch <name> has no pull request (open one)`. The notice is display only, through the UI, and never a message the model sees. The check is
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

- Worktree: clean including ignored files (outside `safety.ops.worktreeDisposable`; the defaults, listed in the `safety.ops.worktreeDisposable` row of [safety.md](safety.md), cover pi's task logs, OS litter and the caches of common Python and JavaScript tools; an entry is a glob matched against one path component, an entry without a trailing `/` matches a file only (write folder entries with a trailing `/`), and it belongs on the list only if a tool writes it, the next run rebuilds it and it never holds a person's work; a wholly ignored folder is walked file by file, symlinks are never followed, and a walk over 20 000 entries or an unreadable folder counts as an ignored file). The refusal names the first files: `ignored_files (a, b, c, +N more)` in the handover reason and in the sweep's `skipped:` line. Branch merged into the base
  branch or contained in its pushed upstream, not locked, no stash entry referencing the branch, no live session
  of another id with its cwd inside. Removal is `git worktree remove` without `--force`, then `git branch -d`
  (`-D` only with the verified-merged fact of a [self-finish](#self-finish-on-merge)). Cleanup of a manifest entry never uses `-D`.
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
- `foreman close selfclean --ws <worktree> --branch <b> [--verified-merged <sha>] [--archive <dir>]`: the checks of a
  [self-finish](#self-finish-on-merge) as one JSON object (`ok`, `reason`, `archived`, `archivedBytes`, `leftOut`, `archivedCwd`, `remoteBranch`; exit 0 ok, 3 refused; `--since <epoch s>` is the pi process start for the age rule of the main worktree's `.workflow/`; `--session-cwd <dir>` is a session cwd that is another worktree, snapshotted too).
  With `--wait-pid <pid> --exempt-workflow --out <file>` it is the detached removal. An adapter-internal command, not a model tool.
- `foreman worktree sweep [--cwd D] [--dry-run]`: removes every linked worktree of the repository that passes
  the same preconditions, listed in a manifest or not (`removed:`, `would remove:`, `skipped: <path> — <reason>`).
  A worktree outside `close.worktreeDir`, `.claude/worktrees` and `../worktrees/<repo>` also gets an `off-convention: <path>` line
  (information only). A branch with no commits beyond its base counts as merged, so a fresh empty worktree is swept.
  The worktree that contains `--cwd` (default: the current dir) is skipped with `in_use_by_caller`.
  Warning: sweep removes a freshly created worktree that has no commits beyond its base yet; use `--dry-run` first.
  A worktree on the default branch (`default_branch`) or on a `safety.git.protectedBranches` match (`protected_branch`)
  is skipped, also with `--dry-run`, and that branch is never deleted.

## The worktree root

`close.worktreeDir` (user or overlay config only) names the folder a repo's linked worktrees live in. One resolver
defines it for the TypeScript adapter and the Python scripts; `<repo>` is the basename of the main checkout, a trailing
`.git` dropped (a submodule resolves to its own checkout, not the superproject).

| Value | Resolves to |
| --- | --- |
| `../<repo>.worktrees` (default), `.claude/worktrees`, `../<repo>-wt` | relative to the main checkout |
| `/srv/build/<repo>` | absolute; each repo gets its own folder under `/srv/build` |
| `~/worktrees/<repo>` | `~` is your home directory |

An absolute or `~` value must contain `<repo>`. The root may sit on another filesystem than the repository, or behind a
symlink; both the spelled and the real path are recognised everywhere.

**Refusals.** A refused value falls back to the default layout; the session shows one notice and `/foreman doctor` prints a
`FAIL` line. The codes:

- `no_repo_placeholder`: an absolute or `~` value without `<repo>`.
- `root_blocks_protected`: the root, or the block glob made from it (`<repo>` becomes `*`, and `*` crosses `/`), would cover
  something children must keep reaching: the main checkout, your home directory, the agent dir, the pi-foreman package,
  the Pi install, the global npm root, the temp root or `/`. `~/<repo>` and `~/Documents/<repo>` are refused;
  `/srv/build/<repo>` and `~/<repo>.wt` pass.
- `root_inside_superproject`: a relative value for a submodule session would land inside the superproject's working tree; use
  an absolute root.
- `root_collision`: when a worktree is created, the root already holds a worktree of a different repository. This is a
  snapshot of what is there: two repos that start at the same moment on an empty shared root can both pass. The root is
  one owned folder, so it must stay single-repo; rename one checkout or use a relative value. Doctor runs the same scan.

The terminal `foreman session open --worktree` checks only the Python subset of these (main checkout, home, agent dir,
temp root, `/tmp`, `/`; it does not know the pi-foreman package root, the Pi install root or the global npm root). The
adapter checks all of them at session start, at a `--worktree` open (before Python runs) and in doctor. The global npm root
resolves in the background at session start; until it has answered (or failed) the root counts as unresolved: no custom
root is owned, and a `--worktree` open is refused with `root_unresolved` ("still resolving"; retry in a moment).

**Across filesystems.** `git worktree add` needs nothing special, and a worktree is removed with `git worktree remove`
(never the trash command, never `--force`). The trash command is used only for scratch dirs: if it fails (typically a
different mount) the removal is reported as `remove_failed` and the dir stays in place; when no trash command exists a
scratch dir is removed with `shutil.rmtree`, and the report then carries a note line for it (`notes`), not a
removed-path entry. `npm ci` runs only in a worktree pi-foreman creates and only when it holds a lockfile; a
`package.json` without one is skipped, and the open output says `install: skipped (package.json without a lockfile)`.

**Nested submodule trees.** An outside tool may build a monorepo worktree and nest submodule worktrees inside it
([sessions](sessions.md#nested-submodule-worktrees)). Cleanup removes only entries the manifest records. Inner entries go
first (the empty directory is recreated so the outer worktree shows no ` D <path>`), then the outer one; the pre-checks of
the whole group run before anything is removed, so one dirty inner checkout blocks the group and nothing is deleted. An
outer worktree that still contains a nested checkout pi-foreman did not create is handed over with
`contains nested checkouts not created by pi-foreman: <paths>; remove by hand`. Nothing is ever forced; if git refuses the
outer worktree its message is reported. A dry run lists `would remove <inner…> then <outer>` for a fully recorded group.
`foreman worktree sweep` skips any worktree that contains nested checkouts or is itself nested in another checkout.

## Sync

`foreman sync` and `/sync` run the same report and cleanup and show the block at the top of their output (at most
15 lines, JSON key `close`; the rest is in `close.json`). With `--dry-run` the block is the dry-run report. A
failure of the block is one line, never an exit code.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `close.autoClean` | `true` | Remove manifest worktrees and scratch at close when the preconditions pass. A project or session may only set `false`; then every entry is a handover with reason `autoClean off`. |
| `close.worktreeDir` | `../<repo>.worktrees` | The worktree root: relative (to the main checkout), absolute or `~`, the latter two with `<repo>` (for example `/srv/build/<repo>`). Decides an owned read-write root. See [the worktree root](#the-worktree-root). User or overlay config only. |
| `close.childWaitMs` | `60000` | How long `/foreman close` waits for the session's own child sessions to close (see Child sessions). `0` sends and does not wait. User or overlay config only. |

## Known gaps

- Unread intercom messages are not reported (the adapter has no API for them).
- Recording skips bash chains it cannot parse, `~` paths and an unknown cwd; use `foreman close record` for those.
- Only manifest paths are cleaned at close; other worktrees need `foreman worktree sweep`.
