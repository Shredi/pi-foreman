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

### Trace and retro

| Event | Fields | Meaning |
|---|---|---|
| `tool_pack` | `pack` (`git`), `op` | one pack call while the pack is on; `op` is `status`, `log`, `diff_stat`, `branch_state`, `move`, `copy` or `worktree_remove`, or a PR tool name (`pr_create`, `pr_status`, `pr_checks`, `pr_comments`, `pr_watch`). A call the drift preflight blocked is not counted. |
| `pr_watch` | `outcome` (`started`, `checks`, `comment`, `timeout` or `error`) | a watch started or ended; the PR number is never traced |

`foreman retro` prints `git: pack N calls (status a, ...) vs bash git M` after the trace lines: pack calls from the
trace, bash git calls (`git` as the command word) from the session. The JSON report has `trace.git_pack` and
`session_tools.bash_git_calls`. PR tool calls are not in that line: a separate `pr: N calls (create a, status b, checks c,
comments d, watch e)` line follows it (counts of at least 1), and the JSON report has `trace.pr_pack`.

## PR tools

Five host-neutral tools for pull requests (merge requests on GitLab): `pr_create`, `pr_status`, `pr_checks`,
`pr_comments` and `pr_watch`. They sit in the git pack's trace family (`tool_pack`, `pack: git`) but are switched
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

`pr_create` and `pr_watch` act and are for the foreman only: they are not registered in children and are refused if a
child calls them (`[pr_refused:child]`). Children whose role has bash get the three read tools. Unknown keys give
`bad_request`; a string argument with a leading `-` is refused before it reaches the host.

| Tool | Args | Answer |
|---|---|---|
| `pr_create` | `title` (1..256 chars, one line), `body` (up to 64 KiB) required; `base`, `head` (branch names), `draft` | `number`, `url`, `head`, `base` (null when the host picks the default) |
| `pr_status` | `number` (default: the current branch's PR) | `number`, `url`, `state` (`open`, `closed`, `merged`), `draft`, `mergeable` (`mergeable`, `conflicting`, `unknown`), `reviewDecision` (`approved`, `changes_requested`, `review_required` or null), `headSha`, `baseRef`, `updatedAt` |
| `pr_checks` | `number` | `pending`, `failed`, `passed` (each entry `name`, `status`, `conclusion`, `url`, `startedAt`, `completedAt`), `summary`, `truncated`, `total` |
| `pr_comments` | `number`, `since` (ISO 8601 timestamp with zone; keeps newer comments) | `comments [{id, kind, author, createdAt, body, bodyCut?, path?, line?, resolved?, state?}]`, `truncated`, `total`; `kind` is `issue`, `review` (inline) or `review_summary` |
| `pr_watch` | `number`, `until` (`checks`, `comment` or `any`, default `any`), `timeoutSeconds` (1..3600, default 3600) | `watching`, `number`, `until`, `timeoutSeconds`, `intervalSeconds`; see [Watch](#watch) |

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

A templates object has the keys `create`, `status`, `checks` and `comments`, one command line each (split like a POSIX
shell, no shell is run). It lives in user or overlay config; a project config cannot set it.

```json
{"tools": {"prHost": {
  "create": "gh pr create --title {title} --body-file {bodyFile} --head {head} --base {base} {draft}",
  "status": "gh pr view {number} --json number,url,state,isDraft,mergeable,reviewDecision,headRefOid,baseRefName,updatedAt",
  "checks": "gh pr checks {number} --json name,state,bucket,link,startedAt,completedAt",
  "comments": "/opt/pr-tools/comments.py {repo} {number} {since}"
}}}
```

- Placeholders: `{repo}` (`owner/name`, derived from the branch's remote URL, only when the template uses it),
  `{number}`, `{since}`, `{base}`, `{head}`, `{title}`, `{bodyFile}` (a temporary UTF-8 file with the body, removed
  afterwards) and `{draft}` (`--draft` when true). A placeholder must be a whole word and becomes exactly one argument.
- A placeholder without a value is dropped. When the word before it is an option (`--base {base}`), the option goes too.
- The first word is a program name found on `PATH` outside the workspace, or an absolute path to a file outside it.
  Use forward slashes on Windows. A `.cmd` or `.bat` program accepts only plain characters in values
  (`unsafe_for_cmd_shim` otherwise); prefer an `.exe`.
- Output contract. Exit 0 is success, 4 means not logged in (`pr_auth_missing`), 3 means not found (`pr_not_found`),
  anything else is `pr_host_failed`. Stdout: `create` prints JSON `{number, url, head?, base?}` or text whose last line
  is a URL ending in `/<number>`; `status` prints the `pr_status` keys as JSON; `checks` prints
  `{pending, failed, passed}`; `comments` prints a JSON list. Missing keys become null; the same caps, redaction and
  cuts apply. Any other shape gives `pr_host_failed`.

### Auth

The tools use the host CLI's own login (`gh auth login`, `glab auth login`). pi-foreman never reads or asks for tokens;
a missing login gives `pr_auth_missing` with the command to run yourself.

### Watch

`pr_watch` starts a background poll of `pr_checks` and/or `pr_comments` (per `until`) every `tools.prWatchSeconds`
seconds, after taking a baseline. It ends at the first change (checks finished or a new failure; a new comment), at
`timeoutSeconds`, or after three polls in a row that failed. Each end sends exactly one `pi-foreman-pr` message with
the summary, up to 10 failed checks and up to 10 new comments (cut to 4 KB), and clears the watch. It starts a turn
when the foreman is idle and follows up when it is busy; the message is data, not an instruction. One watch per PR and
session (`duplicate` otherwise). Watches are cleared at session shutdown. The Herdr sidebar's PR dots poll at the same
interval, `tools.prWatchSeconds` (floor 30 s; see [herdr](herdr.md#dots)).

### Limits

- gh gives no resolved state for review comments; glab gives no review summaries.
- Minimum versions: gh 2.40 (`pr checks --json`), glab 1.36 (`mr view --output json`, `api --input`); older ones fail
  with `pr_host_failed`. The gh and glab commands follow their public docs and have not been run against a real host.
- No merge op, no auto-fix of CI, no review-bot handling.
- pi-foreman never pushes: `pr_create` needs a branch that is already on the remote.

## Other tools

`foreman_dialogs` (the permission dialogs of the trace per family, the JSON of `/foreman dialogs --json`; read only, see [sessions](sessions.md#commands)),
`foreman_wait` (timers, files, processes, CI runs, children) and `foreman_bg` (a detached shell run with a pid wait) are foreman-only; see
[sessions](sessions.md#background-runs). `foreman_bg` and the optional add-on's `bg_run` are guarded like `bash`.

Anything beyond git belongs in an overlay; see [overlays](overlays.md).
