# Retro backlog

> Covers what retro reads, what counts as friction, the `Friction:` report line and trace event, the backlog store, recurrence and aging, `foreman backlog`, the lessons flow, bench, and privacy.
> Retro findings survive sessions in a local backlog, count recurrences and age out.
> The harness never acts on them: you decide what to change.

## Sources

Retro (`/retro`, `foreman retro`, and the retro step of `/sync`) reads local files only:

- the trace (`trace.enabled`, see [safety](safety.md)): allowlisted events such as asks, denials, rung changes and `friction`;
- the usage file the footer and `/foreman cost` use (tokens and list-price cost per request and role);
- the Pi session JSONL (tool calls, for repeated bash families, repeated reads and bulk reads).

It calls no model unless you run `/retro --model <id>`. Nothing here depends on a model provider: cost comes
from usage records and the Pi model registry rates, whichever provider logged them.

## What counts as friction

Each finding is a candidate with a kind (`agent`, `routing`, `skill`, `rule`, `permission`, `prompt`, `harness-bug`, `review-model`; the last only from `foreman retro models`, below).
Retro files a candidate for these classes, from these inputs:

- permission asks (kind `permission`; trace `ask` events): asks are grouped per run (a child's `ask` carries `role`
  and `runId`), and the candidate is per role: "runs hit >= N permission asks" when at least one of that role's runs
  has `retro.askThreshold` asks (default 2). The foreman's own asks (no role or runId) count as one `session` bucket;
- denials the user later overrode (`permission`; the review log);
- read-budget hits (`agent`; trace `read_budget` and `recheck_budget` denials, and `child_read_budget` warn or deny
  per role);
- rereviews (`agent`; trace `rereview`, per role);
- rung-ups (`routing`; trace `rung_up`, per role and reason; see [ladder](ladder.md));
- cost outliers (`routing`; usage lines grouped by role and launch id, `kind: "retro"` lines left out): a role with at
  least 3 runs where a run costs more than 2x the role's median;
- repeated bash families (`rule`, or `permission` when a proposal covers it; the session file's tool calls): a family
  that ran at least 3 times in the session;
- permission proposals (`permission`; the allow rules `/retro` suggests);
- `Friction:` lines from role reports (kind from the event; trace `friction`).

Two read rules come from the session file's `read` tool calls (kind `agent`, basenames only): the same file read at
least 3 times (`repeated reads of <basename>`, the count as evidence), and 50 or more read calls in one session
(`bulk reads: >=50 read calls in one session`, the count as evidence). The command family behind an ask is not available either (the `ask` event carries
the tool family, not the command), so ask candidates name tool families only.

Candidate and evidence text name roles and families, never run ids, times or paths; any path-like token is cut to its
basename before it is filed.

The report `/retro` prints is unchanged; the backlog is an extra output.

## Child traces

When the foreman's retro is on, a child traces too. A single-launch child (the `agent` launch of one role) writes its
trace even in `json` and `print` mode when its `trace.enabled` is null; an explicit `false` wins. A bound child writes
`trace-<launchId>.jsonl`, and every record it writes carries `role` and `runId` (the launch id) unless the event sets
its own. `/retro` and `/sync` read the foreman trace plus each child trace of this session's launches;
`foreman_retro.py` and `foreman_sync.py` take `--trace` more than once for this. Child traces are found for launches
since the foreman process started. Launches through `tasks` or `chain`
have no binding, so their children are not covered.

## Reviewer models

`foreman retro models [--since 30d] [--source live|panel|bench] [--json] [--no-backlog]` reads the reviewer findings store
(`<agent dir>/pi-foreman/state/findings/`) and prints per model and rung: reviews, findings, accepted, rejected, unique,
late misses, USD, USD per accepted finding, median and p90 seconds, plus the time to clean per ledger item. A shadow
reviewer model whose unique accepted findings reach `retro.panelThreshold` files a candidate of kind `review-model` in
the backlog ("consider it as primary or rung"). Columns, outcomes and the store are in [review-climb](review-climb.md).

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
| `foreman backlog show <id> [--workspace KEY]` | Prints every field of one entry. |
| `foreman backlog expire [--now ISO]` | Applies the aging rules above to every store. |
| `foreman backlog mark <id> planned\|done\|open [--workspace KEY]` | Sets the status and stamps `marked`. |
| `foreman backlog move <id> --to repo\|central [--workspace KEY]` | Moves an entry between the central and the repository store; counts merge if it exists there. |

`show`, `mark` and `move` look for the id in the current workspace (or `--workspace KEY`) and `global.md` first, then in every other store. Ids repeat across workspaces, so when several other stores hold it the command exits 2 and asks for `--workspace KEY`.
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
  `true` or `false` wins. Off means no backlog writes. The tui/rpc versus headless default is decided by the extension,
  which passes `--no-backlog`; running `foreman retro` from a shell writes the backlog unless you give `--no-backlog`
  or `retro.enabled` is false.
- A bench row that opts into the existing `post_steps: ["retro"]` model digest runs it by design; its cost is booked
  separately as `retro_usd`, not as this round's retro.
- `trace.enabled`: `null` (default) follows the effective `retro.enabled`, so a session that retros also traces.
  An explicit `true` or `false` wins; `false` turns the trace off even when retro is on.
- `/retro --model` is refused when retro is off or the session is not interactive.

Other keys: `retro.workspaceKey`, `retro.backlogDir`, `retro.repoBacklog`, `retro.expireDays` and
`retro.askThreshold` (above), `retro.proposalMinReviews` ([sessions](sessions.md)), and `retro.panelThreshold`
(default 3, user or overlay only: unique accepted findings of a shadow reviewer model that make a `review-model`
backlog candidate). `retro.workspaceKey`,
`retro.backlogDir` and `retro.repoBacklog` come from user or overlay config only; a project or session value is
ignored.

## Bench

A bench cell has its own workspace key, `bench/<task-id>`, so its findings do not mix with real work. The bench
waiter runs retro after the session ends; it calls no model and spends no tokens. Its usage records are marked
`kind: "retro"` and are left out of the cost and token columns of the bench tables. See [bench](bench.md).

## Privacy

- Retro reads local files and writes local files. Nothing is sent anywhere.
- The trace carries allowlisted fields only (`note` for `friction` events, 120 characters, paths reduced to basenames).
- `retro models` reads local findings records only; the trace carries a finding's file as a basename.
- Backlog evidence holds counts, family names and basenames, not command lines or file contents.
- Nothing is committed unless a `retro.repoBacklog` entry says `commit: true` and `/sync` covers that repository.
