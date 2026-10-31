# Tools

> Covers the optional git tool pack (`tools.git`), the PR tools (`tools.pr`, `tools.prHost`), their caps and guards, child inheritance, and the trace and retro output.
> Read it before you switch the pack on, or when you wonder where other tools belong.
> The git pack is off by default and the PR tools are on; the project and session layers can only switch either off.

pi-foreman ships at most one optional built-in tool pack, and that pack is git. Every other tool (CI, artifact
stores, ticket systems) belongs in an overlay; see [overlays](overlays.md).

## Git tool pack

Four structured, capped, read-only git tools: `git_status`, `git_log`, `git_diff_stat` and `git_branch_state`. They
return JSON the model can use without parsing porcelain output, and they run through the same hardened git
invocation as the checked move, copy and worktree-remove tools (`scripts/safe_ops.py`). The pack is off by default.

| Key | Default | Project / session layer |
|---|---|---|
| `tools.git` | `false` | tighten-only (only `false` is accepted) |

Enable it in your user or overlay config, then re-run `foreman setup`:

```json
{"tools": {"git": true}}
```

Setup is needed because child tool lists come from the generated `subagents` block (as for codemode). A stale list
that still names the tools while the config is off is harmless: the child removes them at start and every call
refuses with `pack_off`. The tools are always registered but inactive; the foreman activates them when the pack is
on. Needs git 2.24 or newer (`--end-of-options`); older git fails the op with `git_failed`, and bash git is unaffected.

### Read tools

All lists carry `truncated` (bool) and `total` (count before the cut). Caps: 200 entries and 16 KB of JSON.

| Tool | Args | Answer |
|---|---|---|
| `git_status` | none | `branch` (null when detached), `head` (null when unborn), `upstream`, `ahead`, `behind`, `counts {staged, unstaged, untracked, conflicted}`, `files [{path, xy, orig?}]` |
| `git_log` | `n` (1..200, default 20), `rev`, `path` | `commits [{sha, short, date, author, subject}]` |
| `git_diff_stat` | `range` (default: working tree against HEAD), `path` | `files [{path, added, deleted, binary}]`, `totals {files, added, deleted}` (before capping) |
| `git_branch_state` | `branch` (default: current) | `branch`, `head`, `upstream`, `ahead`, `behind`, `base`, `mergedIntoBase`, `baseAhead`, `baseBehind` (base fields are null when no base branch resolves; see `safety.ops.baseBranch`) |

### Guards

- Every git call runs with `--no-pager --no-optional-locks`, `core.fsmonitor=false`, `protocol.ext.allow=never` and an
  empty hooks path; `log` and `diff` also pass `--no-color --no-ext-diff --no-textconv`.
- Arguments are validated in Python: unknown keys, out-of-range `n` (no clamping), and `rev`/`range` values with `:`,
  `{`, spaces or a leading `-` give `bad_request`. Revisions follow `--end-of-options`, paths follow `--`. An unknown
  revision gives `unknown_revision`, an unknown branch `unknown_branch`, a repository without commits `no_commits`.
- `path` must resolve inside the git workspace root (`outside_workspace`) and not into `.git` (`inside_git_dir`). It need
  not exist, so the log of a deleted file works.
- For the foreman, the git-config drift preflight asks before any call after `.git/config` or hooks changed (label
  `foreman_git_status` and so on). Children are not gated, the same as for their bash git.
- Limit: git may run configured clean or smudge filters for `status` and `diff`, the same exposure as bash `git status`.
- Bash git is unchanged: the pack adds a path, it removes none.

### Write tools in the pack

`foreman_move`, `foreman_copy` and `foreman_worktree_remove` are unchanged and always registered (the foreman's `foreman_copy` may also read from its own session handoff dir); see
[safety](safety.md). While the pack is on they also emit a `tool_pack` trace event, so retro can compare tool use.

### Children

The foreman with `tools.git: true` exports `PI_FOREMAN_TOOL_PACKS=git`; pi-subagents passes it to children. A child keeps
the tools only when the variable names `git` and its own merged config has `tools.git: true`, so a project `false`
switches the pack off in children too. Children never write the variable. Roles whose tool list has `bash` (by default
explorer, builder, reviewer, senior-reviewer and finalizer, and overlay roles likewise) get the four names in their
list; the planner has no bash and gets none.

Every child role also gets `tool_search`, through which MCP tools load on demand within the role's `roles.<id>.mcp`
ceiling (see [roles](roles.md#rolesidmcp)). It is inactive in a child whose role allows no MCP server. On a `mcp.directProviders` provider the allowed deferred tools are declared before the child's first prompt instead, so they are callable there.

### Trace and retro

| Event | Fields | Meaning |
|---|---|---|
| `tool_pack` | `pack` (`git`), `op` | one pack call while the pack is on; `op` is `status`, `log`, `diff_stat`, `branch_state`, `move`, `copy` or `worktree_remove`, or a PR tool name (`pr_create`, `pr_status`, `pr_checks`, `pr_comments`, `pr_watch`). A call the drift preflight blocked is not counted. |
| `pr_watch` | `outcome` (`started`, `checks`, `comment`, `timeout`, `error` or `lost`) | a watch started or ended (`lost`: it could not be resumed after a restart); the PR number is never traced |
| `pr_track` | `path` (`push`, `search`, `interact`, `events`, `create`, `url`, `tool`, `watch`, `branch` or `untrack`), `dup`, `skipped`, `foreign`, `count` | a PR was registered (see [Registration paths](#registration-paths)); never the number, branch, host, repo, author or login |
| `pr_shared` | `outcome`, `source`, `count` | the shared PR watch did something (see [Shared PR watch](#shared-pr-watch)); never a PR number, repo, author or login |

`foreman retro` prints `git: pack N calls (status a, ...) vs bash git M` after the trace lines: pack calls from the
trace, bash git calls (`git` as the command word) from the session. The JSON report has `trace.git_pack` and
`session_tools.bash_git_calls`. PR tool calls are not in that line: a separate `pr: N calls (create a, status b, checks c,
comments d, watch e)` line follows it (counts of at least 1), and the JSON report has `trace.pr_pack`. Registrations have their own line,
`pr: tracked N (push a, search b, interact c, events d, create e, url f, tool g, watch h, branch i; foreign j)`, and the
JSON key `trace.pr_track`. Only paths with a count show; a `dup` or `skipped` registration is not counted, and `foreign` counts
PRs of another repository than the current one.

## PR tools

Seven host-neutral tools for pull requests (merge requests on GitLab): `pr_create`, `pr_status`, `pr_checks`,
`pr_comments`, `pr_watch`, `pr_track` and `pr_untrack`. They sit in the git pack's trace family (`tool_pack`, `pack: git`) but are switched
independently of `tools.git`. The generic layer never hardcodes a host: `gh` and `glab` are two built-in command
sets, and a templates object brings any other CLI. Nothing here merges a PR, fixes CI or pushes a branch.

| Key | Default | Project / session layer |
|---|---|---|
| `tools.pr` | `true` | tighten-only (only `false` is accepted) |
| `tools.prHost` | `"auto"` | not in project/session (the PR host program comes from the user or overlay config) |
| `tools.prDots` | `true` | any layer (`false` keeps the PR status dots poller from starting; the PR tools stay on, see [herdr](herdr.md#dots)) |
| `tools.prWatchSeconds` | `60` | any layer (integer 5..3600, seconds between two `pr_watch` polls) |
| `tools.prInteractions` | `[]` | not in project/session (up to 16 `{pattern}` objects: a regular expression of at most 200 characters, flag `u`, with the named group `n` and optional `repo` and `host`; a command segment that matches and exits 0 tracks that PR) |
| `tools.prShared.enabled` | `false` | not in project/session (the shared PR watch; user or overlay config only) |
| `tools.prShared.authors` | `[]` | not in project/session (at most 8 authors whose open PRs with a failed check show as failing) |
| `tools.prShared.seconds` | `180` | not in project/session (60..3600, floor for every endpoint) |
| `tools.prShared.events` | `true` | not in project/session (also read the user's events feed) |
| `widget.prs` | `true` | any layer (the PR widget above the editor, TUI only) |
| `widget.prLinks` | `true` | any layer (labels in the PR widget are terminal hyperlinks) |

`/foreman prs` cycles the PR widget between auto, collapsed and hidden for the session; `/foreman prs list` prints the tracked PRs and the shared snapshot as a notice.

`tools.prHost` is `"auto"` (`gh`, then `glab`, found on `PATH` outside the workspace), `"gh"`, `"glab"` or a templates
object. Re-run `foreman setup` after changing `tools.pr`: child tool lists come from the generated `subagents` block,
and a fresh install gets them because the default is on. Switch the tools off with `{"tools": {"pr": false}}`; every
call then refuses with `pr_off`. `/foreman doctor` prints one `PR tools:` line with the state and the host found.

### Ops

`pr_create`, `pr_watch`, `pr_track` and `pr_untrack` act and are for the foreman only: they are not registered in
children and are refused if a child calls them (`[pr_refused:child]`; all four are in `CHILD_DENIED_TOOLS`). Children
whose role has bash get the three read tools. Unknown keys give
`bad_request`; a string argument with a leading `-` is refused before it reaches the host.

| Tool | Args | Answer |
|---|---|---|
| `pr_create` | `title` (1..256 chars, one line), `body` (up to 64 KiB) required; `base`, `head` (branch names), `draft` | `number`, `url`, `head`, `base` (null when the host picks the default) |
| `pr_status` | `number` (default: the current branch's PR), `repo`, `host` | `number`, `url`, `title`, `state` (`open`, `closed`, `merged`), `draft`, `mergeable` (`mergeable`, `conflicting`, `unknown`), `reviewDecision` (`approved`, `changes_requested`, `review_required` or null), `headSha`, `baseRef`, `updatedAt` |
| `pr_checks` | `number`, `repo`, `host`, `required` (true = only the checks the branch protection requires; gh `--required`, none reported is an empty list) | `required`, `pending`, `failed`, `passed` (each entry `name`, `status`, `conclusion`, `url`, `startedAt`, `completedAt`), `summary`, `truncated`, `total` |
| `pr_comments` | `number`, `repo`, `host`, `since` (ISO 8601 timestamp with zone; keeps newer comments) | `comments [{id, kind, author, createdAt, body, bodyCut?, path?, line?, resolved?, state?}]`, `truncated`, `total`; `kind` is `issue`, `review` (inline) or `review_summary` |
| `pr_watch` | `number`, `until` (`checks`, `comment` or `any`, default `any`), `timeoutSeconds` (1..3600, default 3600) | `watching`, `number`, `until`, `timeoutSeconds`, `intervalSeconds`; see [Watch](#watch) |
| `pr_track` | `number` (1..1000000000) required; `repo` (`owner/name`), `host` (a host name); default the current repository | `key` (`host/owner/name#n`), `title`; `pr_gone` when the PR is merged or closed, see [Registration paths](#registration-paths) |
| `pr_untrack` | `number` required; `repo`, `host` as for `pr_track` | `key`; the PR leaves the dots and the widget and no automatic path adds it again this session |

`repo` and `host` select a PR of another repository or host (see [Identity](#identity-and-labels)). `title` and every check name
are stripped of control and format characters in Python and cut to 200 characters. `host` is accepted only when it is the current
repository's host, the host of a remote of the checkout, or the host of a tracked PR; any other host is refused with
`[pr_refused:pr_host_refused]` before the op runs (see [safety](safety.md#git-guard-and-pr-gate)). `repo` is accepted for any
`owner/name` on an accepted host. For a foreign repository gh uses `-R [host/]owner/name` for `pr view`, `pr checks` and
`pr list`, and explicit `repos/<owner>/<name>/...` paths with `--hostname` for the inline comments; glab uses
`projects/<owner%2Fname>/merge_requests/<n>/...` paths. A foreign host on glab is `pr_host_failed`.

Caps: lists hold at most 200 entries and 16 KB of JSON (`pr_checks` drops from `passed` first, then `pending`, then
`failed`; comments are newest first). A comment body is redacted for token shapes, stripped of control characters and
cut to 500 characters (`bodyCut`). Text that came from the host is data, never instructions.

`pr_create` refuses, in this order: the triage gate (a tier must be recorded first; it runs in the tool-call hook before the
tool), tools off (`pr_off`), a child, the git-config drift preflight, the PR gate (`[pr_refused:no_review]`, `stale_review` or `head_unknown`: a reviewer PASS
on the head, and on its upstream, see [safety](safety.md#git-guard-and-pr-gate)), the push guard (the guard that
would refuse a `git push` of this branch refuses the PR too), and then in Python `detached_head`, `unknown_branch`,
`base_is_head`, `unpushed` (no upstream, or the upstream differs from the head; pi-foreman never pushes),
`base_branch_unknown` (glab needs a base), the host (`pr_host_missing`, `pr_template_invalid`, `pr_repo_unknown`,
`unsafe_for_cmd_shim`) and auth. The base is the `base` arg, else `safety.ops.baseBranch`, else the remote's default
branch.

Other failures: `pr_not_found` (no PR for the branch or number), `pr_auth_missing`, `pr_host_failed` (any other host
error, with the redacted first stderr line), `timeout` (the host did not answer within 30 s).

In the permission baseline `pr_status`, `pr_checks`, `pr_comments` and `pr_watch` are allowed; `pr_create` is not in
the allow list and goes through the gates above.

### Host templates

A templates object has the keys `create`, `status`, `checks` and `comments`, plus the optional `find` and `search`, one
command line each (split like a POSIX shell, no shell is run). It lives in user or overlay config; a project config cannot
set it.

```json
{"tools": {"prHost": {
  "create": "gh pr create --title {title} --body-file {bodyFile} --head {head} --base {base} {draft}",
  "status": "gh pr view {number} --json number,url,state,isDraft,mergeable,reviewDecision,headRefOid,baseRefName,updatedAt",
  "checks": "gh pr checks {number} --json name,state,bucket,link,startedAt,completedAt",
  "comments": "/opt/pr-tools/comments.py {repo} {number} {since}"
}}}
```

- Placeholders: `{repo}` (`owner/name`, derived from the branch's remote URL, only when the template uses it),
  `{host}` (the host name of the PR, for `search` the CLI's default host),
  `{number}`, `{since}`, `{base}`, `{head}`, `{title}`, `{bodyFile}` (a temporary UTF-8 file with the body, removed
  afterwards), `{draft}` (`--draft` when true), and for `find` and `search` `{mode}` (`head` or `author`), `{author}` and
  `{state}` (`open` or `all`). A placeholder must be a whole word and becomes exactly one argument.
- A placeholder without a value is dropped. When the word before it is an option (`--base {base}`), the option goes too.
- The first word is a program name found on `PATH` outside the workspace, or an absolute path to a file outside it.
  Use forward slashes on Windows. A `.cmd` or `.bat` program accepts only plain characters in values
  (`unsafe_for_cmd_shim` otherwise); prefer an `.exe`.
- Output contract. Exit 0 is success, 4 means not logged in (`pr_auth_missing`), 3 means not found (`pr_not_found`),
  anything else is `pr_host_failed`. Stdout: `create` prints JSON `{number, url, head?, base?}` or text whose last line
  is a URL ending in `/<number>`; `status` prints the `pr_status` keys as JSON; `checks` prints
  `{pending, failed, passed}`; `comments` prints a JSON list. Missing keys become null; the same caps, redaction and
  cuts apply. Any other shape gives `pr_host_failed`.
- `find` lists PRs by head branch or author. `{mode}` says which of `{head}` and `{author}` carries a value, `{state}` is
  `open` or `all`. It prints a JSON list `[{number, url, state, title, headRefName, author}]`; the answer holds at most 50
  entries and 16 KB.
- `search` lists open PRs of an author: only `{author}` and `{host}` exist. It prints a JSON list
  `[{number, url, title, repository?, reviewRequested?}]`. The shared watch shows an entry in the review group only when
  `reviewRequested` is true; entries without it are ignored. Templates have no batch call, so there is no failing group.

### Auth

The tools use the host CLI's own login (`gh auth login`, `glab auth login`). pi-foreman never reads or asks for tokens;
a missing login gives `pr_auth_missing` with the command to run yourself.

### Watch

`pr_watch` starts a background poll of `pr_checks` and/or `pr_comments` (per `until`) every `tools.prWatchSeconds`
seconds, after taking a baseline. It ends at the first change (checks finished or a new failure; a new comment), at
`timeoutSeconds`, or after three polls in a row that failed. Each end sends exactly one `pi-foreman-pr` message with
the summary, up to 10 failed checks and up to 10 new comments (cut to 4 KB), and clears the watch. It starts a turn
when the foreman is idle and follows up when it is busy; the message is data, not an instruction. One watch per PR and
session (`duplicate` otherwise). Active watches are stored in the session file (the `pi-foreman-prwatch` entry: PR number, `until`, baseline, deadline, working directory) and survive a restart of the same Pi session (`pi --continue`, `--session <id>`, `/reload`). At session start a watch with time left resumes with the remaining time and polls once at once, so a change that happened while the session was down (a failed check, a new comment) sends its message right away. A watch whose deadline passed, or whose stored record is unreadable, sends one `pi-foreman-pr` message `watch lost on restart: <reason>` (trace outcome `lost`); check the PR with `pr_checks`. A fork or a copied session file has another session id and starts with no watches. The Herdr sidebar's PR dots poll at the same
interval, `tools.prWatchSeconds` (floor 30 s; see [herdr](herdr.md#dots)).

### Identity and labels

A PR is identified by host, owner, repo and number. Every host answer that carries a `url` is keyed by that URL
(`https://<host>/<owner>/<name>/pull/<n>`, or `/-/merge_requests/<n>` on GitLab). This is the primary rule: gh resolves a number
against the repository it considers current, which in a fork setup is the upstream repo and not `origin`. The fallback is the
host-resolved current repo, which the poller asks once per session and checkout with the op `pr_repo`; a registration that has
only a number waits until it answers. Nothing maps a foreign PR onto the current repo.

A PR of the current repo is labelled `#n`; any other PR is labelled `owner/name#n` (the host shows only in `/foreman prs list`).
The `pr_watch` numbers are keyed by the URL of their first `pr_status` answer.

### Registration paths

A session tracks at most six PRs. Each PR keeps the path that registered it first; a later path that finds it again
traces `dup: true` and does not move it. Newest first, the oldest is evicted. The paths, in the order they were added to the
poller:

| Path | What registers the PR |
|---|---|
| `push` | A `git push` the foreman ran. The push output names the pushed branches (`[new branch]` and ref updates; tags, deletions, rejections and `[up to date]` are skipped); a quiet push falls back to the checkout's branch when it has an upstream. The poller runs `pr_find {head}` in the push directory on its next tick and once more five minutes later. At most 8 pushed branches are remembered. |
| `search` | Every second tick, one `pr_find {author: "@me"}` in the session directory. Hits whose head branch is the current branch or a pushed branch register. |
| `interact` | A command that exited 0 and acted on a PR (see below). |
| `events` | The shared watch's events feed (see [Shared PR watch](#shared-pr-watch)): an item of the current repo or of a pushed branch's repo, younger than 24 hours. A backstop, because the feed can lag by hours. |
| `create` | `pr_create`. |
| `url` | A PR URL in the result of bash or of a PR tool except `pr_comments`. At most the first two distinct URLs per result register. The host must be the current repo's host, a remote's host of the checkout or the host of a tracked PR; other hosts are skipped. |
| `tool` | `pr_track`. |
| `watch` | A PR under `pr_watch`. |
| `branch` | The PR of the current branch (the backstop of the round-53 poller). |

Protection: `push`, `create`, `interact`, `tool` and `watch` entries are never evicted by a `url`, `events`, `search` or
`branch` registration. When the six places hold only protected entries, the weaker registration is dropped and traced with
`skipped: true`. `pr_untrack` adds the PR to a session-local ignore list that no automatic path changes; `pr_track` of an
ignored PR removes it from the list and tracks it. A PR that is merged, closed or not found is dropped from the dots and
keeps its head branch for the close notice.

`pr_track` runs one `pr_status` for the identity. An open PR registers with path `tool`. A merged or closed PR answers
`pr_gone` and registers nothing. The result carries `key` and `title`.

**Command results.** The paths `push` and `interact` read the exit status of the foreman's bash result: `details.exitCode`
when Pi gives it, else `!isError`. A command line is split into chain segments on `&&`, `||`, `;` and newlines, and each
segment is parsed alone. A segment that follows `cd <dir>` in the same chain counts as if it carried `-C <dir>`; a
directory that does not exist or is no repository skips the segment. A number-only interaction after a `cd`, or with a
`GH_REPO=` prefix, is not keyed to the session's repo: `GH_REPO` names it, otherwise `pr_repo` runs in that directory; when
neither resolves the registration is skipped (`skipped: true`).

**Interaction forms.** Built in, no CI-specific keyword anywhere:

- `gh pr <verb> <ref>` with verb `comment`, `review`, `checkout`, `merge`, `ready`, `edit`, `close` or `reopen`, and `<ref>` a number or a PR URL. `-R` / `--repo <[host/]owner/name>` sets the identity; a URL carries its own.
- `gh api` with method `POST`, `PATCH` or `PUT` (`-X` / `--method`, or implied by `-f`, `-F`, `--input`, `--raw-field`) on `repos/<owner>/<name>/(issues|pulls)/<n>` with an optional `/comments`, `/reviews` or `/requested_reviewers`. The literal placeholders `{owner}/{repo}` and `:owner/:repo` mean the current repo. `--hostname` sets the host.
- `glab mr <verb> <ref>` with verb `note`, `approve`, `checkout`, `merge`, `update`, `close` or `reopen`; `-R` / `--repo` likewise.

`gh pr view` and other reads do not register. `tools.prInteractions` adds patterns of your own, in the user or overlay
layer only (a project or session value is ignored with a warning):

```json
{"tools": {"prInteractions": [{"pattern": "^ci-tool nudge (?<repo>[\\w.-]+/[\\w.-]+)#(?<n>\\d+)"}]}}
```

At most 16 objects, each with a `pattern` of at most 200 characters. It is a regular expression with the flag `u`, compiled
once and matched against each segment cut to 4 KB. The named group `n` is the PR number (required); the optional groups
`repo` (`owner/name`) and `host` set the identity, else the current repo applies. A match on an exit-0 segment registers
that PR with path `interact`. The repository ships none.

### Host ops for the poller

These ops serve the poller, the shared watch and the close notice. They are not model tools; they run through
`safe_ops.py` like the others, with the same 30 s timeout, caps and redaction. All validate their arguments in Python
(unknown keys give `bad_request`; a value that could pass as an option is refused).

| Op | Arguments | Answer |
|---|---|---|
| `pr_repo` | none | `host`, `repo`, `url` of the host-resolved current repo (gh `repo view`, glab `repo view`, templates: derived from the branch's remote, else `origin`) |
| `pr_find` | exactly one of `head` (a branch name) or `author` (`@me`, or a login of 1..39 characters with an optional `[bot]` suffix); `state` `open` (default) or `all` | `prs [{number, url, state, title, headRefName, author}]`, `truncated`, `total`; 50 entries and 16 KB at most |
| `pr_search` | `author` (a login) or `reviewRequested` (`true` for you, or a login), exactly one of the two; `host` (templates only, gh refuses it) | `prs [{number, url, title, repository?}]`; gh `search prs` runs against the CLI's default host (it has no host option); glab answers `pr_unsupported`; a template uses the key `search` |
| `pr_batch` | `host?`, `prs [{repo, n}]` (1..50) | `prs [{repo, number, url, title, state, draft, mergeable, reviewDecision, headRefName, checks {pending, failed, passed, missing, truncated}}]`, `errors [{repo, number, kind}]` with `kind` `pr_not_found` or `pr_host_failed` |
| `pr_poll` | `endpoint` `notifications` or `events`; `host?`, `since?` (an HTTP date), `etag?`, `login?`, `page?` (1..3) | `status`, `lastModified`, `etag`, `pollInterval`, `items` (null on 304) |
| `pr_login` | none | `login` of the gh user |

`pr_batch`, `pr_poll` and `pr_login` are gh only and answer `pr_unsupported` for glab and templates. `pr_search`, `pr_poll`,
`pr_batch` and `pr_login` need no work tree: they run in the given directory, which only has to exist.

`pr_batch` sends one GraphQL request for all entries. Owner and name go in as variables with `-f`, the number with `-F`,
never interpolated into the query. A check lands in exactly one group, in this order: a check run that failed, timed out,
was cancelled, needs action or failed to start is `failed`; a required check that has not started (or a status that is
`EXPECTED`) is `missing`; any other unfinished check is `pending`; the rest is `passed`. `truncated` is true when the PR has
more than 100 checks; the counts then end with `+` in the widget. gh exits 1 when the reply carries `errors`: `pr_batch`
reads stdout whatever the exit code, keeps `data`, and reports the failing PRs in `errors`. Only an empty or unparseable
stdout, or a top-level `RATE_LIMITED`, fails the op.

`pr_poll` runs `gh api -i` with `If-Modified-Since` or `If-None-Match`, because gh exits 1 on 304, 403 and 404. It reads the
status line and headers from stdout whatever the exit code; only an unparseable stdout is `pr_host_failed`. Notification
items are threads with reason `review_requested` and subject type `PullRequest`, reduced to `{repo, n, title, url}` with the
URL built from the thread's repository `html_url`. Event items are `PullRequestEvent`, `PullRequestReviewEvent`,
`PullRequestReviewCommentEvent` and `IssueCommentEvent` on a PR, reduced to `{repo, n, url, at}`. At most 200 items and 64 KB.
`pr_find` and `pr_search` strip control and format characters from titles; URLs are kept only when they are plain `https://`
addresses.

### Call budget

Per poller tick (`tools.prWatchSeconds`) on gh: one `pr_status` for a new current branch, at most two `pr_find {head}`, one
`pr_find {author}` every second tick and one `pr_batch` per host, so `4 + hosts` calls at worst and typically one or two.
Once per session and directory add one `pr_repo`, and once per `pr_watch` number one `pr_status`. On glab and templates
each tracked PR costs two calls (`pr_status`, `pr_checks`; `missing` stays empty) and the total is at most 12 plus the finds.
A GraphQL `RATE_LIMITED` error or a 403 or 429 doubles the interval through the existing backoff.

### PR widget

The widget shows the tracked PRs above the editor. It is the detailed view of the data behind the Herdr dots
(see [herdr](herdr.md#dots)), fed by the same poller. It needs the tui and is never shown in children.

| Key | Default | Meaning |
|---|---|---|
| `widget.prs` | `true` | show the widget |
| `widget.prLinks` | `true` | wrap each label in a terminal hyperlink (OSC 8) to the PR page |

`/foreman prs` cycles `auto`, `collapsed` and `hidden` for the session. `/foreman prs list` prints every tracked PR with host,
repo and URL, then the shared snapshot (review, failing, touched), as a notice. Both work in the foreman session only.

The widget at 80 columns, one failing PR, one running PR with a queued required check, a green PR of this repo, a green PR of
another repo and the shared watch (every label is a hyperlink):

```text
── PRs (4) ─────────────────────────────────────────────────────────────────────
● #58 r58: PR widget, reliable tracking, bot watch · review? · ✗ 1 ◉ 2 ✓ 9
  ✗ failed: test (ubuntu)
  ◉ running: bench-smoke, test (windows)
◉ #57 r57: cache keep-alive per provider · approved · ◉ 1 ◌ 1 ✓ 11
  ◉ running: test (macos)
  ◌ missing: bench-smoke
○ #55 r55: ladder docs · approved · ✓ 12
○ acme/tools#204 fix: retry on 502 · review? · ✓ 6
watch: 2 need review · 1 failing
  ● acme/web#118 chore: lockfile maintenance
```

At 40 columns (below the 60-column breakpoint) the review word goes first, a title is cut with `…` only when the line would
still be too long, detail lines show counts instead of names, and the watch items drop so that only the summary stays:

```text
── PRs (4) ─────────────────────────────
● #58 r58: PR widget, rel… · ✗ 1 ◉ 2 ✓ 9
  ✗ failed 1 · ◉ running 2
◉ #57 r57: cache keep-al… · ◉ 1 ◌ 1 ✓ 11
  ◉ running 1 · ◌ missing 1
○ #55 r55: ladder docs · ✓ 12
○ acme/tools#204 fix: retry on 502 · ✓ 6
watch: 2 need review · 1 failing
```

`/foreman prs` once collapses it to the divider rule plus one line that counts only open PRs, `PRs: 1 fail · 1 run · 2 ok · watch 3` (`PRs: none`
without any). A PR merged in the last 60 seconds shows as `✓ merged #55 r55: ladder docs`, then disappears.

Rules:

- Order: failing, running, ok, no checks, then PRs of the current repo before foreign ones, then by number; merged and closed last.
- A PR with a failed check, a conflict, a running check or a missing required check expands to a block of at most four lines (a header and up to three detail lines at 60 columns or more, at most two count lines below). Other PRs take one line. Passed checks are never listed. Counts end with `+` when the host cut the check list (`✓ 12+`).
- Own PRs take at most eight lines; the last line becomes `+n more PRs` when the next block does not fit. The body, watch section included, takes at most ten lines below the divider (the divider is one more line) and nothing wraps.
- Colours follow the theme: failing red, running yellow, ok green; missing, stale, no-check and compact green lines are dim, so a failing PR stands out. Glyphs come from the symbol set (`pr-fail`, `pr-run`, `pr-ok`, `pr-none`, `lost`, `recent`, `ask`, `rule`; see [herdr](herdr.md#symbols)).
- Review words: `review?`, `changes!`, `approved`, `draft`; nothing when unknown.
- Watch section: a summary line `watch: 2 need review · 1 failing` (a zero part is left out). At 60 columns or more up to two item lines follow, failing before review items (`  ● ...` and `  ? ...`). Touched items never show. A snapshot older than three watch intervals, or marked degraded, makes the summary dim with ` · stale`.
- A label is a hyperlink only when the URL is a plain `https://` address that names the same host, repo and number as the key. With `widget.prLinks` off, outside the tui, or on any other URL, the label is plain text. Widths are measured without the OSC bytes.
- Host text (titles, check names, snapshot strings) loses control and format characters before it is stored and again before it is drawn.

### Shared PR watch

One leader session per machine polls the PR host for what no single session sees and publishes a snapshot that every
session renders in the widget. It is off by default and read from the user or overlay config only.

```json
{"tools": {"prShared": {"enabled": true, "authors": ["ci-bot", "ci-bot[bot]"], "seconds": 180, "events": true}}}
```

| Key | Default | Meaning |
|---|---|---|
| `tools.prShared.enabled` | `false` | run the watch |
| `tools.prShared.authors` | `[]` | up to 8 authors whose open PRs are checked for a failed check (the failing group) |
| `tools.prShared.seconds` | `180` | 60..3600, the floor for every endpoint and the leader's heartbeat |
| `tools.prShared.events` | `true` | also read the user's events feed |

Three sources, each on its own schedule, none faster than its `X-Poll-Interval`:

1. **Review requests.** `pr_poll notifications` with `If-Modified-Since`; a 304 keeps the previous items (`unchanged`, never a failure). A 200 reads pages 2 and 3 too (100 per page), so a request beyond the 300th notification is missed. The items go through `pr_batch` per host to drop closed and merged PRs and refresh titles. A notification you read in the browser disappears from the API, and its PR leaves the widget. When the token lacks the `notifications` scope (403 or 404), the leader switches for its lifetime to `pr_search {reviewRequested}` every `seconds` and traces `notifications_fallback` once.
2. **Failing PRs.** One `pr_search {author}` per configured author, then one `pr_batch` per host over the union (at most 50). A PR with a failed check is failing.
3. **Touched PRs.** With `events: true`, `pr_poll events` for the login (`pr_login`; kept in memory only) with `If-None-Match`; a 304 costs nothing. Items are reduced to host, repo, number, URL and time, at most 100, dropped after 24 hours; they feed the `events` registration path and never show in the widget. A host's `pull_request.html_url` gives the item its host when well-formed. A 403 or 404 turns the source off for the leader's lifetime (`events_unavailable`). The feed shows private activity only with the `repo` scope.

The leader is the session that holds the lease `<agentDir>/pi-foreman/state/prbot/lease.json`
(`{sessionId, pid, hostname, acquiredAt, renewedAt, expiresAt}`). The lease lives 3 × `seconds` (at least 300 s) and is
renewed on its own timer. Acquiring uses an exclusive create; a lease that is expired, unparseable for more than 10 s, or
held by a dead pid on this machine is stale and taken over after a random delay of up to 5 s and a re-read. A leader that
sees another session id steps down silently; the leader releases the lease at shutdown. Followers only re-read the lease
every `seconds`. Children never take part.

The snapshot `<agentDir>/pi-foreman/state/prbot/snapshot.json` is written through a temporary file whenever a source
changed, and the leader rewrites it once per `seconds` as a heartbeat. Shape: `{leader, at, intervalSeconds, degraded,
sources {notifications: ok|fallback|off, events: ok|off}, review [{host, repo, n, title, url}], failing [...], touched
[{host, repo, n, url, at}]}`: at most 40 review and failing items (failing first; a PR in both counts once as failing) and
100 touched. Readers check the mtime, accept at most 128 KB, apply a strict shape check and the URL rule, and treat an
unparseable file as absent. No token, login or credential is written to either file.

Failure: a rate limit (rate-limit text, 403, 429, a GraphQL `RATE_LIMITED`) or three failures in a row double that source's
interval up to 30 minutes and set `degraded`. A missing host CLI or login (`pr_host_missing`, `pr_auth_missing`) halts the
leader and releases the lease (`stopped`).

Host limits. The built-in sources are gh only and run against the CLI's default host. With the built-in glab the first
`pr_unsupported` turns all three sources off. With a templates host only the `search` template runs (once per configured
author; with no author nothing runs), its results show in the review group only when they carry `reviewRequested: true`, and
there is no failing group. Notifications need the `notifications` or `repo` scope. `isRequired` and the check rollup need
GitHub Enterprise Server 3.x or newer.

`/foreman doctor` prints `pr shared watch: off`, or `pr shared watch: on (leader|follower|stopped (host CLI missing or not
logged in); notifications ok|fallback|off, events ok|off, <n> authors)`, with `; failing group needs gh` appended on glab and
template hosts, and a `WARN` for a project or session value of `tools.prShared`. The trace event `pr_shared` has `outcome`
(`lease_acquired`, `lease_renewed`, `lease_lost`, `released`, `tick`, `unchanged`, `error`, `backoff`,
`notifications_fallback`, `events_unavailable` or `stopped`), `source` and `count`.

### Safety notes

- Host text in the results of `pr_status`, `pr_checks`, `pr_comments` and `pr_track` (titles, check names, comment bodies) reaches the model as data, like `pr_comments` today. Titles and check names lose control and format characters first. Treat all of it as untrusted.
- The close notice, the widget and the sidebar dots are display only. They go to the UI, never into a message the model sees. The shared snapshot is read by the extension, not by the model.

### Limits

- gh gives no resolved state for review comments; glab gives no review summaries.
- glab and template hosts have no batch call: each tracked PR costs two calls, `missing` is always empty, and there are no notifications, events or failing group.
- `gh search prs` has no host option; `pr_search` and the shared watch use the CLI's default host.
- The CI detail hook is not shipped; GitHub check names are the detail. Use `tools.prHost` templates (`find`, `search`) to adapt another host.
- Minimum versions: gh 2.40 (`pr checks --json`), glab 1.36 (`mr view --output json`, `api --input`); older ones fail
  with `pr_host_failed`. The gh and glab commands follow their public docs and have not been run against a real host.
- No merge op, no auto-fix of CI, no review-bot handling.
- pi-foreman never pushes: `pr_create` needs a branch that is already on the remote.

## Other tools

`foreman_dialogs` (the permission dialogs of the trace per family, the JSON of `/foreman dialogs --json`; read only, see [sessions](sessions.md#commands)),
`foreman_wait` (timers, files, processes, CI runs, children) and `foreman_bg` (a detached shell run with a pid wait) are foreman-only; see
[sessions](sessions.md#background-runs). `foreman_bg` and the optional add-on's `bg_run` are guarded like `bash`.

Anything beyond git belongs in an overlay; see [overlays](overlays.md).
