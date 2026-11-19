# Retro and reports

> Covers reporting a fault at the source (`foreman_report`, the report store, states, expiry, the start note, `foreman reports`, migrating the old backlog, the optional steward, lessons), what retro reads and prints, the report lines, the compaction retro section, bench and privacy.
> Faults are written down by the session that hits them and kept in a local store; the trace counts, it creates no entries.
> The harness never acts on the entries: you decide what to change.

## Reporting at the source

A session that hits a fault writes it down at that moment, with one `foreman_report` call. Every role has the tool (foreman, explorer, builder, reviewer), in a child as in a main session; it is on by default (`retro.report`, `false` takes the tool away and nothing is written). It calls no model and appends one line.

After an upgrade a child gets the tool once `/foreman setup` has rewritten the role tool lists; until then a child without the tool breaks nothing, it just cannot report. With `retro.report` false the foreman session loses the tool; a child keeps the tool its list declares (a declared tool that is missing aborts the child) and the call answers one line, `foreman_report is off (retro.report)`, and writes nothing.

The fields are data, nothing parses the text:

| field | values |
| --- | --- |
| `kind` | `harness-bug`, `permission`, `rule`, `prompt`, `agent`, `routing`, `skill` |
| `subject` | the tool, command, rule or file the fault is about, up to 40 characters |
| `what` | what happened, up to 300 |
| `effect` | `blocked`, `slowed`, `wrong-result`, `note` |
| `suggest` | optional fix, up to 200 |

A report is for a fault of the harness, a rule, a prompt, a permission, routing or a skill that blocked or slowed the work or gave a wrong result. A finding about the task's own code goes into the result of the run, not here. The answer is one line: `recorded <id>`, `seen <id>` (this session reported the same kind and subject before) or `limit reached` (5 reports per child run, 20 per main session; nothing is written then). A store that cannot be written answers one line and the run goes on.

Every text passes the secret masking of the trace and is cut to file names where it names a path (`/home/x/y/app.ts` becomes `app.ts`) before it is stored. The key of a report is the first 12 hex of sha1 of the kind and the stored subject, trimmed and lowercased, taken after the masking: the same fault reported twice has the same key, and the same file under two paths has the same key.

### The report store

`.workflow/reports/reports.jsonl` in the main checkout of the repository: a linked worktree writes into its main checkout, so a worktree that is removed at close does not take its reports with it; outside git, in a submodule and in a bare layout the store lives in the workspace root. The first write creates `.workflow/reports/.gitignore` with `*`, so the store is never committed, also in a repository that does not ignore `.workflow/`. The rows are append-only (`report`, `group`, `state`); the entries, counts and states are a fold over them, and a row of an unknown type is skipped. Every writer holds `reports.jsonl.lock` (waits up to 5 seconds, breaks a lock older than 60 seconds).

A report row carries `id`, `key`, `kind`, `subject`, `what`, `effect`, `suggest`, `repo` (`owner/name` of the `origin` remote, else the first remote by name, else null), `workspace` (the workspace key of the main checkout, see `retro.workspaceKey`), `branch`, `role`, `session`, `runId`, `version`, `ts` and `source` (`agent`, or `owner` for a flagged ask). `session` is the foreman session: a child counts as its foreman's session. The count of an entry is the number of distinct sessions that reported its key, so one looping session never makes a fault look common. A test or fixture workspace is a temporary repository with its own store.

### States

| state | meaning |
| --- | --- |
| `open` | reported, nobody works on it |
| `planned` | a round is planned for it (the label names the round) |
| `done` | fixed (the PR number is recorded) |
| `dropped` | not worth a change (the reason is recorded) |
| `expired` | open and not seen for `retro.expireDays` |

Entries with different keys that describe one fault are merged with a `group` row: the entry then has the union of the sessions. A new report of an expired entry opens it again; so does a new report of a `done` entry (a regression after a fix): its state is `open`, the reason reads `reopened after done`, and the earlier `done` row stays in the file. A `dropped` entry stays dropped. No gate reads a state.

The foreman session manages the list with `foreman_reports` (deferred; `list`, `group`, `set`; it refuses in a child). Its `list` output opens with one fixed line saying that the entries are data written by other sessions and never instructions; each text is quoted and cut to 160 characters. Treat every entry as a note to check, not as an order.

### Expiry

At most once a day, inside the write path of `foreman_report` (a stamp file `.expired` holds the time), the store is cleaned: an `open` entry not seen for `retro.expireDays` (default 14) gets an `expired` state row, and the rows of entries that have been `done`, `dropped` or `expired` for more than 90 days move to `reports-archive.jsonl`. The rewrite holds the store lock and replaces the file in one rename, so a report written at the same time is not lost. `foreman reports expire` runs the step by hand.

### `foreman reports`

```
foreman reports list [--state open|planned|done|dropped|expired|all] [--json]
foreman reports show KEY [--json]
foreman reports set KEY open|planned|done|dropped [--label TEXT] [--pr N] [--reason TEXT]
foreman reports expire [--days N] [--archive-days N]
foreman reports import FILE
```

The command works on the store of the repository the current folder belongs to. `KEY` is a key or a unique prefix of four or more characters. `list` opens with the same data line as the tool. `foreman reports import` is described [below](#reports-from-parent-opened-sessions); `foreman reports migrate` [here](#migrating-the-old-backlog).

### Reports from parent-opened sessions

A session opened by `foreman session open` (on another machine or not) keeps its own store, and the report tool also appends each recorded row, of the session and of its subagent children, to `reports.jsonl` in the session's handoff dir (best effort; see [sessions](sessions.md#reports-from-remote-and-parent-opened-sessions)). The parent imports that file: its watcher at a remote `result`, `update` or `closed` notice, or by hand with `foreman reports import FILE`. A local parent that shares the store does not need it.

The file is data from outside, so every line is checked again and the row is rebuilt from its fields, never copied:

- Only rows of type `report` come in; `state`, `group`, `lesson` and `emitted` rows are skipped.
- `repo` must equal the `repo` of this store. A row or a store without a repository is no match.
- `kind` and `effect` must be in the lists above, `id` ten hex characters, `session` and `ts` present (a time more than a day ahead, or older than the archive age of 90 days, is refused), and `role` one of `foreman`, `explorer`, `builder`, `reviewer`, `owner` or `child` (an unknown role is refused as invalid; the report tool refuses it as well). Text over the caps (40, 300, 200) or a line over 4096 characters is skipped, not cut; the texts pass masking and the file-name cut again, and the key is computed again from the stored subject. Unicode format characters (category Cf: bidi overrides, zero-width marks) are removed from every stored report text, local or imported.
- `count`, `firstSeen`, `lastSeen` and `source` never survive, so an imported row counts as one report of its own `session`.
- The file may be CRLF; a file above 512 KiB, a malformed line or a missing file imports nothing and is no error for the notice (the command exits 1 for a missing or oversized file).

The watcher writes the fetched file to the session's mirror dir as `reports.jsonl` (next to `result.md`; not a notice file) before it imports. If the import fails (the store lock stays busy, say), the mirror stays and `foreman reports import <mirror dir>/reports.jsonl` imports it later. One `reports_import` trace event per import carries counts only: `lines`, `added`, `known`, `malformed`, `notReport`, `otherRepo`, `invalid` and the boolean `oversized`; a failed import carries `failed: true`.

Known limits: a forged session id can inflate the count of an imported entry (nothing gates on counts); once the file passes 512 KiB no further import takes it; the fetch runs in the watcher's serial queue, so a hanging read delays the next notice (the fetch timeout bounds it); a notice that reaches the parent only through the intercom relay triggers no fetch (use the command).

A second import of the same file adds nothing (rows are known by `id`, also in the archive); writers hold the store lock, so imports and local reports at the same time lose nothing. The command prints how many rows it imported, knew and skipped.

### Flagged asks

`/foreman flag-ask [note]` also writes a report: kind `permission`, subject the command family, `what` the command after the masking and the file-name cut, 300 characters at most, effect `slowed`, source `owner`; the note becomes `suggest`. The complete command stays in the trace only.

### Start note

A main session that no parent opened gets one message at its first prompt when the store holds open entries seen by two or more sessions (count of 2 or more): the same fixed data line as `list`, then up to five entries (most sessions first; each text quoted and cut to 160 characters), then a line pointing at `foreman_reports`. If more qualify, the last line says how many more. Nothing is sent when no entry qualifies, in a child, in a session a parent opened, or with `retro.startNote` false (default true; `retro.report` false also turns it off). The note is a message, never system text, so it does not touch the cached prompt prefix; it is sent once per session and a session entry records it, so a reload or resume does not repeat it. It replaces the older rule of looking at a backlog for "ripe" entries: the working-ahead rule in [ceremony](ceremony.md#working-ahead) now reads the report list.

### Migrating the old backlog

Before reports, retro wrote a per-workspace backlog (`<agent dir>/pi-foreman/state/retro/backlog/<workspace key>.md`, `global.md`, and in some repositories `.workflow/retro-backlog.md`). Nothing writes it any more. `foreman reports migrate` moves what is worth keeping into the report store of the current repository:

```
foreman reports migrate [--from DIR] [--workspace GLOB]... [--all] [--exclude GLOB]... [--min-count 2] [--within-days 30] [--archive] [--apply]
```

- It reads the old format (one fenced `retro-entry` block per entry) from `--from` (default the old central directory), its `global.md`, and this repository's `.workflow/retro-backlog.md` when present (named in the output and left in place). A malformed block is skipped and counted.
- The default is a dry run: it prints, per old workspace, how many entries it would keep and how many it leaves. The old keys were made per worktree path, so no rule maps them to a repository: without `--workspace` (a glob on the workspace key, repeatable) or `--all` the command only lists the workspaces and imports nothing. `--exclude` removes workspaces from the selection.
- It keeps entries with a count of at least `--min-count` (default 2) or of kind `harness-bug`, last seen within `--within-days` (default 30). Kind `flagged-ask` becomes `permission`; `review-model` entries are left. Their text passes the same masking as a new report.
- With `--apply` the kept entries become `report` rows with `source: "migrated"`: the old id is the key, `count` is the old count (the fold honours it), the old dates are in `firstSeen` and `lastSeen` (`show` prints them), and `ts` is the time of the migration, so the expiry clock starts at the move and an entry last seen 20 days ago survives the next expiry run. A second run imports nothing new.
- `--archive` (with `--apply`) renames the whole folder that `--from` names (the old central directory by default) to `backlog-archive-<date>` beside it, with every file in it, also the workspaces you did not select. It does not check which folder that is. Nothing is deleted.

## Steward

Off by default. Without a steward nobody groups reports that use different words for the same fault; the start note above is then the whole path to the main session. With `steward.enabled` true, `/foreman steward on` makes the current main session the steward of this repository's report list. The steward groups reports, starts one helper on the strongest ranked model to check each group, and proposes rounds. You confirm each round; the steward never starts one alone.

```
/foreman steward on | off | status
```

- `on` is refused with one line while `steward.enabled` is false, in a child, and in a session a parent opened. It takes a lock in the store folder (`.workflow/reports/steward.lock`): one steward per repository, whichever worktree the session works in. A second session is refused while the lock is live.
- The harness sends `instructions/steward.md` once, as a message at that moment, with `steward.maxProposals` put into its text. It is never system text, so the cached prompt prefix only grows. A reload or resume does not send it again, but a compaction does: after each compaction of the steward session the filled-in text goes out again as a message (the limit is then still the configured one); a session that is not the steward gets nothing.
- The steward lock lives for days. The watch refreshes it at every check, so the age break that frees a lock of a dead session (three missed checks, at least ten minutes) never hits a live steward. `off` and the end of the session give the lock back; a stale lock of a dead session can be taken.
- A watch checks the report list every `steward.checkMinutes` (default 30). It wakes the session with a `pi-foreman-steward` message when at least `steward.minNew` (default 3) ungrouped open entries were seen since the last pass, or when `steward.maxWaitHours` (default 24) passed since the last pass and at least one such entry exists. With no new entry it never wakes. The wake text holds counts only, never report text. A check that throws is traced (`steward {action: tick_failed}`) and never stops the watch. A busy session is not woken: a pending question to you counts as busy, and the next check tries again. A wake counts as a pass; the same reports do not wake twice.
- The watch is stored in the session like a PR watch, so it survives a reload or resume. If another session holds the lock by then, or `steward.enabled` is false, the watch is not restored and the session says so once.
- The steward reads the retro counters of its own session with `foreman_reports` action `retro` (the JSON of `foreman retro --json` without the permission proposals, `session_tools` and `flagged_asks`: counters plus the tool and skill names of `tool_usage`; no report text and no command text), so it never has to name the trace and usage files. The action is steward-only: any other session, a child, and a session with `steward.enabled` false get a one-line refusal, and the tool otherwise acts as before. In every pass the steward first binds a standing ledger (`foreman_ledger`, topic `steward`: status first, `init` only when none exists) so the spawn gate lets the launch through.
- Limits: a stale lock taken over by two sessions at the same moment can let both hold it until the next check, which corrects it. A lesson set from the shell carries no `repo`.
- The steward session gets no start note. The `steward` permissions profile is a separate thing and stays as it is.
- `model: "top"` is the launch keyword of the steward's analysis helper (see [ladder](ladder.md#the-keyword-top)); the harness allows it only while this session is the steward.

## Lessons

`foreman_reports` with `set`, state `done`, takes an optional `lesson` (300 characters at most, masked and cut to file names like any report text). Use it only for a lesson that stays true beyond this case. The harness appends the lesson to `.workflow/reports/lessons.md` and emits `foreman:lesson` on `pi.events` with `{id, text, group, repo, pr}`; nothing in this repository reads the event, an add-on does (see [overlays](overlays.md#lessons)). What leaves the store is the lesson text and the group's name (the report's subject, or the name the steward gave it); no other report text and no finding does. `foreman reports set KEY done --lesson TEXT` appends the lesson from the shell but cannot emit; the next main session emits every lesson that was not emitted yet at its start, after `foreman:ready`. Each lesson is emitted once per store. A crash between the append and the emit loses that emit; the lesson stays in `lessons.md`.

## Sources

Retro (`/retro`, `foreman retro`, and the retro step of `/sync`) reads local files only:

- the trace (`trace.enabled`, see [safety](safety.md)): allowlisted events such as asks, denials, rung changes and `report` (kind, subject, effect and id of each `foreman_report` call, no text);
- the usage file the footer and `/foreman cost` use (tokens and list-price cost per request and role);
- the Pi session JSONL (tool calls, for repeated bash families, repeated reads and bulk reads).

It calls no model unless you run `/retro --model <id>`. Nothing here depends on a model provider: cost comes
from usage records and the Pi model registry rates, whichever provider logged them.

## What retro reports

Retro prints counters and proposals; it creates no report entries and writes no store file (the trace-derived entries of the older backlog loop are gone). What it prints:

- approvals and denials, with the denials a later approve overrode;
- trace counters: guard blocks, revisions, turn causes, `friction:` counters (rereviews, read-budget hits, rung-ups, child read-budget hits, headless review defers, turns), `reports:` (the `foreman_report` calls of the session by kind), pressure and critique counters;
- spawn cost per role, cost outliers, repeated bash families, read counts, top tools;
- flagged asks (see below);
- permission proposals: the allow rules `/retro` suggests, with `--proposals-out`;
- the report lines below, and `foreman retro models`.

The trace does not carry the key of a report, so these counters add no counts to entries. To see what was reported, use `foreman reports list`.

## Report lines

Besides the approval and trace lines, the report carries these lines when there is data:

- `git: pack 4 calls (status 2, log 1, move 1) vs bash git 2`: git tool pack calls from the trace against bash `git`
  commands from the session (see [tools](tools.md#trace-and-retro)). PR ops are not counted here.
- `explorer: 4 launches, m-opus 1 (25 %, fact-critical 1); m-sonnet 2; m-haiku 1`: explorer launches by model, the share
  on the top-rank models, and the `fact-critical` marker count. Sources: usage lines (single launches), `research_rung`
  events and `launch_entry` events (tasks and chain entries without a marker; see [ladder](ladder.md#trace-records)).
- `critique: raised 4, applied 2; per round raised/diff lines: 3/120, 1/14`: the critique counter (below); shown when
  the trace has at least one counted review. The JSON report has `trace.critique_raised`, `trace.critique_applied` and
  `trace.critique_rounds` (`[{raised, lines}]`, `lines` null when the review had no diff, `?` in the text; 0 for an empty diff).
- `pr: 4 calls (create 1, checks 2, watch 1)`: PR tool calls from `tool_pack` events, listing counts of at least 1 in
  the order create, status, checks, comments, watch. The JSON report has `trace.pr_pack`.
- `N decisions cost a dialog or a classifier call in the last 7 days; run foreman perms suggest`: the last line of the `/retro` text (not of `foreman retro`), shown when the gate decision log holds 10 or more such decisions (classifier calls and cache hits, dialogs, child asks, and `danger-*` calls that ran only because the mode is `allow`). `foreman perms suggest` groups them into candidate rules; see [permissions](permissions.md#commands). The threshold is a constant, not a config key.

- `cache: keepalives 3 ($0.07), warm compactions 2, cold resumes 1`: cache keep-alive usage lines (`kind: "keepalive"`,
  count and summed cost; left out of the per-role rows), `compaction` trace events with reason `warm_idle`, and
  cold resumes. A cold resume is approximate: the first foreman turn after a gap longer than the provider's cache TTL
  (`providers.<p>.cache.ttlSeconds` or the built-in one) whose `cacheRead` is under 50 % of the previous foreman
  line's prompt (input + cacheRead + cacheWrite); keep-alive lines count as the previous line, so a bridged gap is
  not cold. When the idle model downshift ran, the line ends with `, downshifted turns K` (`foreman_model` trace events with reason `idle_cold`; the JSON key `downshiftedTurns` exists only then). Without a TTL the count is 0. The line shows when a cache policy applies or any count is above 0; the JSON
  report has `cache` (`keepalives`, `keepaliveCost`, `warmCompactions`, `coldResumes`, `ttlSeconds`).

- `tools: declared never used: X, Y (0 of N sessions); found: Z (M of N)` and `skills: listed never read: ...; found: ...`:
  usage over the last 60 days. The harness writes one `tool-usage` line (names only: declared, hidden, used, found,
  skills listed, hidden and read, and each tool's package) into the session's usage file on the first turn and again
  at the end of a turn whenever `used`, `found` or `skillsRead` changed; a child writes its own into the foreman's
  file with its role. The retro reads every file in `state/usage` (it needs `--agent-dir`), takes the last line per
  session and counts. Cost readers (`/foreman cost`, the footer, `usage_metrics`) skip these lines. A tool used only
  through codemode is not seen as used. With fewer than 20 sessions the lines show counts and no suggestion. The JSON
  report has `tool_usage`.

### Always on or searchable

With at least 20 sessions (and at least 20 in the role being judged) the retro prints suggestions after those lines;
it applies nothing and creates no report entry:

- A tool or skill declared (listed) but used (read) in under 10% of the sessions that declared it: make it searchable
  (`tools.deferred` add, `skills.hidden` add). A child role gets no such line for a tool: a child declares every
  allowlisted tool, so `roles.<x>.searchable` saves it no tokens.
- Searchable but found in 25% or more of the sessions that hid it: make it always on again (remove it from
  `tools.deferred` or `skills.hidden`). A child hides no tool, so a child role gets no such line for a tool.
- A tool never used in a child role: remove it from the key it is in, `roles.<x>.searchable` when the role's
  config lists it there, else `roles.<x>.tools` (both keys when the retro cannot read the config).
- A tool never used is printed with its package: `never used (foreman, 24 sessions): doc_to_md (example-package) ->
  pi remove npm:example-package` when none of the package's tools was used, `PI_BG_FEATURES=process` for the
  add-on's optional tools (`fusion_*`, `bg_delegate`, `bg_run_pi_attested`), else `tools.deferred`. A
  skill never read points to `skills.hidden` or removing the skill directory. Packages the harness ships or bundles
  are never suggested for removal.

The lessons brief ends with the same rule as one line.

## Critique counter

A round is one counted review run (primary `reviewer` on an `item` or `pre-pr` occasion; plan
reviews, second opinions and panel shadows do not count). At its run end the foreman traces `critique {kind: raised,
role, runId, count, lines}`: `count` is the number of findings of kind `now` and `later` in the review's verdict record
(see [review](review.md#critique)), `lines` the added plus removed lines of the diff the review was launched on
(working tree and untracked files against the builder's base; absent for a review with no diff, 0 for an empty diff). "Applied" is the
signal the harness can see, not proof of a change: the first builder launch after that review and before the next
counted review traces `critique {kind: applied, role: builder, count}` with the review's `now` count, because the
foreman sends those findings back to the builder in that revision. A new counted review replaces `now` lines no builder
launch took. `later` lines are never applied here; the foreman records them in result.md.

## Child traces

When the foreman's retro is on, a child traces too. A single-launch child (the `agent` launch of one role) writes its
trace even in `json` and `print` mode when its `trace.enabled` is null; an explicit `false` wins. A bound child writes
`trace-<launchId>.jsonl`, and every record it writes carries `role` and `runId` (the launch id) unless the event sets
its own. `/retro` and `/sync` read the foreman trace plus each child trace of this session's launches;
`foreman_retro.py` and `foreman_sync.py` take `--trace` more than once for this. Child traces are found for launches
since the foreman process started. Launches through `tasks` or `chain`
have no binding, so their children are not covered.

## Reviewer models

`foreman retro models [--since 30d] [--source live|panel|bench] [--json]` reads the reviewer findings store
(`<agent dir>/pi-foreman/state/findings/`) and prints per model and rung: reviews, findings, accepted, rejected, unique,
late misses, USD, USD per accepted finding, median and p90 seconds, plus the time to clean per ledger item. It only prints;
it writes no report entry. Columns, outcomes and the store are in [review](review.md).

## Retro section of a compaction

The summary of the idle warm compaction is asked to end with a `## Retro` section (at most 10 lines), which goes into
`.workflow/retro/<session>.md` with a counters line. Only that compaction carries the instruction. A compaction Pi
starts at its own threshold, on overflow, or a typed `/compact` cannot, so its summary has no Retro section; the
entry is still written and says `(the compaction summary has no Retro section)`. See
[cache](cache.md#where-compaction-fires).

## Who runs retro

- The top orchestrator runs `/sync` by hand. `/sync` runs retro first, then the repository commits.
- A sub-orchestrator (a session opened with `/foreman session open`) exits through `/foreman close`: result file,
  then sync (retro before commits), then exit. See [sessions](sessions.md).
- Subagents never sync and never run retro; they report faults with `foreman_report`.

## Switches

- `retro.report` (default true): the `foreman_report` tool, the start note and the store writes. `false` turns them off.
- `retro.startNote` (default true): the start note alone.
- `retro.expireDays` (default 14): when an open entry expires (above).
- `steward.enabled` (default false), `steward.minNew` (3), `steward.maxWaitHours` (24), `steward.checkMinutes` (30), `steward.maxProposals` (3): the [steward](#steward).
- `retro.workspaceKey`: overrides the workspace key written on a report row (user or overlay config only).
- `retro.enabled`: `null` (default) is on in `tui` and `rpc` sessions and off in `json` and `print` mode; an explicit
  `true` or `false` wins. It switches the retro run and, through `trace.enabled`, the trace.
- A bench row that opts into the existing `post_steps: ["retro"]` model digest runs it by design; its cost is booked
  separately as `retro_usd`, not as this round's retro.
- `trace.enabled`: `null` (default) follows the effective `retro.enabled`, so a session that retros also traces.
  An explicit `true` or `false` wins; `false` turns the trace off even when retro is on.
- `/retro --model` is refused when retro is off or the session is not interactive.
- `retro.proposalMinReviews`: see [sessions](sessions.md).

## Flagged asks

`/foreman flag-ask [note]` flags the last ask you answered in this session as unnecessary (the Permission System dialog choices are fixed, so the flag is a command). It writes one `ask_flag` trace event: command family, the complete command (only secret-looking values are masked by the trace redactor), effect class, asking rule, session and time, and one report (above, `source` owner, command masked and cut). A flag never allows anything: no rule reads it back. `/retro` (section "Flagged asks") shows the flags grouped by family. With tracing off the notice says whether the report was written, already existed, or nothing was written.

## Bench

A bench cell has its own workspace key, `bench/<task-id>`, so its reports do not mix with real work. The bench
waiter runs retro after the session ends; it calls no model and spends no tokens. Its usage records are marked
`kind: "retro"` and are left out of the cost and token columns of the bench tables. See [bench](bench.md).

## Privacy

- Retro reads local files and writes local files. Nothing is sent anywhere.
- Report text passes secret masking and a basename cut before it is stored; the store is never committed (it ignores itself).
- The trace carries allowlisted fields only; a `report` event holds kind, subject, effect and id, never the text.
- `retro models` reads local findings records only; the trace carries a finding's file as a basename.
- The one place a complete command is kept is the trace event of a flagged ask (secret-looking values masked); the report holds it masked and cut to 300 characters.
