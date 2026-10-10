# Retro backlog

> Covers what retro reads, what counts as friction, the `Friction:` report line and trace event, the backlog store, recurrence and aging, `foreman backlog`, the lessons flow, bench, and privacy.
> Retro findings survive sessions in a local backlog, count recurrences and age out.
> The harness never acts on them: you decide what to change.

## Sources

Retro (`/retro`, `foreman retro`, and the retro step of `/sync`) reads local files only:

- the trace (`trace.enabled`, see [safety](safety.md)): allowlisted events such as asks, denials, rung changes and `friction`;
- the usage file the footer and `/foreman cost` use (tokens and list-price cost per request and role);
- the Pi session JSONL (tool calls, for repeated bash families and bulk reads).

It calls no model unless you run `/retro --model <id>`. Nothing here depends on a model provider: cost comes
from usage records and the Pi model registry rates, whichever provider logged them.

## What counts as friction

Each finding is a candidate with a kind (`agent`, `routing`, `skill`, `rule`, `permission`, `prompt`, `harness-bug`).
Retro files a candidate where the inputs carry a signal:

- permission asks: a run with at least `retro.askThreshold` asks (default 2);
- denials that the user later overrode;
- read-budget hits;
- rereviews of the same change;
- rung-ups (a role climbed the model ladder, see [ladder](ladder.md));
- cost outliers per role;
- repeated bash families (the same command shape again and again);
- bulk reads (many files read one by one);
- permission proposals (the allow rules `/retro` suggests);
- `Friction:` lines from role reports.

The report `/retro` prints is unchanged; the backlog is an extra output.

## The `Friction:` line and event

Every role's output contract ends with a `Friction:` line: what blocked, was retried or was missing, in at most
three lines, or `none`. When a child run ends, the foreman's extension reads the report and, for a non-empty
`Friction:` line (not `none`), emits one `friction` trace event with the fields `role`, `runId`, `kind` and `note`.

- `note` is cut to 120 characters, and any path-like token (a separator, `~/x`, `C:\x`) is reduced to its basename.
- `kind` is a keyword guess from the note (permission, skill, routing, rule, agent, harness-bug; default `prompt`).
  Retro treats it as a hint.
- Only the foreman session emits it, from the run-end report. Subagents write the line; they never write the trace.
- The trace allowlist admits `note` for `friction` events only.

## The store

A backlog is a markdown file with one fenced block per entry:

```retro-entry
id: 3f9a1c2b7d40
kind: permission
candidate: builder asks for the same test runner every run
workspace: example-repo-1a2b3c4d
first_seen: 2026-10-01T09:12:44Z
last_seen: 2026-10-09T16:03:10Z
count: 3
sessions: [s-41, s-47, s-52]
evidence: 4 asks in one run; family: npm test
status: open
```

`id` is the first 12 hex characters of a SHA-1 over `kind`, a newline and `candidate`, so the same finding
always lands on the same entry. `sessions` keeps the last 20 session ids. Unknown keys in a file are kept.

Where a finding goes:

- Central store: `<retro.backlogDir>/<workspace key>.md`. `retro.backlogDir` null means
  `<agentDir>/pi-foreman/state/retro/backlog`. This is the default.
- Workspace key: `retro.workspaceKey` when set, else `<basename>-<first 8 hex of a SHA-1 of the workspace root>`
  (for example `example-repo-1a2b3c4d`). A `/` in the key makes subdirectories (`bench/<task-id>.md`). Keys are
  cleaned to `A-Za-z0-9._-` segments; `..` is refused. An entry names the key, never a path.
- `global.md` in the central directory: every finding of kind `harness-bug`, whatever the workspace, since a
  harness bug is not about one workspace.
- Repository store: `retro.repoBacklog` is a list of `{path, commit}` (path absolute or a glob, for example
  `~/work/example-repo`). Findings for a matching workspace go to `<workspace>/.workflow/retro-backlog.md`
  instead of the central file.
  - `commit: true`: `/sync` adds the file to that repository's sync commit, even if `.workflow/` is ignored. This
    needs the workspace to be a `sync.repos` entry too; if it is not, `/sync` prints a warning and commits nothing.
  - `commit: false`: `/sync` appends `/.workflow/retro-backlog.md` once to the repository's `.git/info/exclude`,
    so the file never shows up as untracked. The tracked `.gitignore` is not touched.

Writes are atomic (temp file, then replace) under a lock file next to the store.

## Recurrence and aging

- A finding seen again bumps `count` and `last_seen`. The same session counts once: its id is in `sessions`, so
  repeating a finding inside one session does not raise the count.
- `retro.expireDays` (default 14): an `open` or `planned` entry without a sighting for that long becomes
  `expired`. `foreman backlog expire` applies this.
- A new sighting of an `expired` entry revives it to `open`.
- `done` and `expired` entries are removed (by `foreman backlog expire`) once 90 days have passed since their last
  sighting or their `marked` time, whichever is later. `marked` is set by `foreman backlog mark`.

## Commands

`foreman backlog` (`bin/foreman`, `.cmd` and `.ps1` on Windows) runs `scripts/foreman_backlog.py`. Global options:
`--agent-dir D`, `--cwd DIR`, `--json`.

| Command | What it does |
|---|---|
| `foreman backlog list [--workspace KEY \| --all] [--min-count N] [--kind K] [--status S]` | Lists entries, most frequent first. Default: this workspace's open and planned entries. `--all` spans every store. |
| `foreman backlog show <id>` | Prints every field of one entry. |
| `foreman backlog expire [--now ISO]` | Applies the aging rules above to every store. |
| `foreman backlog mark <id> planned\|done\|open` | Sets the status and stamps `marked`. |
| `foreman backlog move <id> --to repo\|central` | Moves an entry between the central and the repository store; counts merge if it exists there. |
| `foreman backlog brief [--workspace KEY] [--min-count 2] [--out PATH]` | Writes a lessons brief (below). |

## The lessons flow

`foreman backlog brief` writes `.workflow/scratch/brief-lessons-<date>.md` in the current directory (or `--out`).
It lists open entries seen at least twice, grouped by kind, with entries that share a role or command family shown
together as complementary, and ends with an instruction block: plan first, group complementary findings, fix each
group with one change, mark finished entries done.

The harness never starts a session from it. You start one yourself, for example:

```
/foreman session open lessons .workflow/scratch/brief-lessons-2026-10-10.md --plan-first
```

See [sessions](sessions.md) for the command. Where that session puts its output (a harness change, a skill, a
rule) is that session's decision.

## Who runs retro

- The top orchestrator runs `/sync` by hand. `/sync` runs retro first, then the repository commits, so a
  committed repository backlog is current.
- A sub-orchestrator (a session opened with `/foreman session open`) exits through `/foreman close`: result file,
  then sync (retro before commits), then exit. See [sessions](sessions.md).
- Subagents never sync and never run retro.

## Switches

- `retro.enabled`: `null` (default) is on in `tui` and `rpc` sessions and off in `json` and `print` mode; an explicit
  `true` or `false` wins. Off means no backlog writes.
- `trace.enabled`: `null` (default) follows the effective `retro.enabled`, so a session that retros also traces.
  An explicit `true` or `false` wins; `false` turns the trace off even when retro is on.
- `/retro --model` is refused when retro is off or the session is not interactive.

Other keys: `retro.workspaceKey`, `retro.backlogDir`, `retro.repoBacklog`, `retro.expireDays` and
`retro.askThreshold` (above), and `retro.proposalMinReviews` ([sessions](sessions.md)). `retro.workspaceKey`,
`retro.backlogDir` and `retro.repoBacklog` come from user or overlay config only; a project or session value is
ignored.

## Bench

A bench cell has its own workspace key, `bench/<task-id>`, so its findings do not mix with real work. The bench
waiter runs retro after the session ends; it calls no model and spends no tokens. Its usage records are marked
`kind: "retro"` and are left out of the cost and token columns of the bench tables. See [bench](bench.md).

## Privacy

- Retro reads local files and writes local files. Nothing is sent anywhere.
- The trace carries allowlisted fields only (`note` for `friction` events, 120 characters, paths reduced to basenames).
- Backlog evidence holds counts, family names and basenames, not command lines or file contents.
- Nothing is committed unless a `retro.repoBacklog` entry says `commit: true` and `/sync` covers that repository.
