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

`foreman retro` prints `git: pack N calls (status a, ...) vs bash git M` after the trace lines: pack calls from the
trace, bash git calls (`git` as the command word) from the session. The JSON report has `trace.git_pack` and
`session_tools.bash_git_calls`. PR tool calls are not in that line: a separate `pr: N calls (create a, status b, checks c,
comments d, watch e)` line follows it (counts of at least 1), and the JSON report has `trace.pr_pack`. PRs are no longer
registered in the session, so there is no registration line or registration trace.

## PR tools

Five host-neutral tools for pull requests (merge requests on GitLab): `pr_create`, `pr_status`, `pr_checks`,
`pr_comments` and `pr_watch`. They show nothing in Pi: the herdr-app mod is the only PR and run display (see
[herdr](herdr.md#open-prs)); without it, use these tools and `foreman radar --json`. They sit in the git pack's trace family (`tool_pack`, `pack: git`) but are switched
independently of `tools.git`. The generic layer never hardcodes a host: `gh` and `glab` are two built-in command
sets, and a templates object brings any other CLI. Nothing here merges a PR, fixes CI or pushes a branch.

| Key | Default | Project / session layer |
|---|---|---|
| `tools.pr` | `true` | tighten-only (only `false` is accepted) |
| `tools.prHost` | `"auto"` | not in project/session (the PR host program comes from the user or overlay config) |
| `tools.prWatchSeconds` | `60` | any layer (integer 5..3600, seconds between two `pr_watch` polls) |

Pi tracks no PRs for display any more: the PR registration tools, the PR list command, and the display, watch and pattern keys of the old tracker are gone. An old key in a config file warns as unknown.

`tools.prHost` is `"auto"` (`gh`, then `glab`, found on `PATH` outside the workspace), `"gh"`, `"glab"` or a templates
object. Re-run `foreman setup` after changing `tools.pr`: child tool lists come from the generated `subagents` block,
and a fresh install gets them because the default is on. Switch the tools off with `{"tools": {"pr": false}}`; every
call then refuses with `pr_off`. `/foreman doctor` prints one `PR tools:` line with the state and the host found.

### Ops

`pr_create` and `pr_watch` act and are for the foreman only: they are not registered in
children and are refused if a child calls them (`[pr_refused:child]`; both are in `CHILD_DENIED_TOOLS`). Children
whose role has bash get the three read tools. Unknown keys give
`bad_request`; a string argument with a leading `-` is refused before it reaches the host.

| Tool | Args | Answer |
|---|---|---|
| `pr_create` | `title` (1..256 chars, one line), `body` (up to 64 KiB) required; `base`, `head` (branch names), `draft` | `number`, `url`, `head`, `base` (null when the host picks the default) |
| `pr_status` | `number` (default: the current branch's PR), `repo`, `host` | `number`, `url`, `title`, `state` (`open`, `closed`, `merged`), `draft`, `mergeable` (`mergeable`, `conflicting`, `unknown`), `reviewDecision` (`approved`, `changes_requested`, `review_required` or null), `headSha`, `baseRef`, `updatedAt` |
| `pr_checks` | `number`, `repo`, `host`, `required` (true = only the checks the branch protection requires; gh `--required`, none reported is an empty list) | `required`, `pending`, `failed`, `passed` (each entry `name`, `status`, `conclusion`, `url`, `startedAt`, `completedAt`), `summary`, `truncated`, `total` |
| `pr_comments` | `number`, `repo`, `host`, `since` (ISO 8601 timestamp with zone; keeps newer comments) | `comments [{id, kind, author, createdAt, body, bodyCut?, path?, line?, resolved?, state?}]`, `truncated`, `total`; `kind` is `issue`, `review` (inline) or `review_summary` |
| `pr_watch` | `number`, `until` (`checks`, `comment` or `any`, default `any`), `timeoutSeconds` (1..3600, default 3600) | `watching`, `number`, `until`, `timeoutSeconds`, `intervalSeconds`; see [Watch](#watch) |

`repo` and `host` select a PR of another repository or host (see [Identity](#identity-and-labels)). `title` and every check name
are stripped of control and format characters in Python and cut to 200 characters. `host` is accepted only when it is the current
repository's host or the host of a remote of the checkout; any other host is refused with
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

A templates object has the keys `create`, `status`, `checks` and `comments`, plus the optional `find` (a `search` key is still accepted and no longer used), one
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
  afterwards), `{draft}` (`--draft` when true), and for `find` `{mode}` (`head` or `author`), `{author}` and
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

### Auth

The tools use the host CLI's own login (`gh auth login`, `glab auth login`). pi-foreman never reads or asks for tokens;
a missing login gives `pr_auth_missing` with the command to run yourself.

### Watch

`pr_watch` starts a background poll of `pr_checks` and/or `pr_comments` (per `until`) every `tools.prWatchSeconds`
seconds, after taking a baseline. It ends at the first change (checks finished or a new failure; a new comment), at
`timeoutSeconds`, or after three polls in a row that failed. Each end sends exactly one `pi-foreman-pr` message with
the summary, up to 10 failed checks and up to 10 new comments (cut to 4 KB), and clears the watch. It starts a turn
when the foreman is idle and follows up when it is busy; the message is data, not an instruction. One watch per PR and
session (`duplicate` otherwise). Active watches are stored in the session file (the `pi-foreman-prwatch` entry: PR number, `until`, baseline, deadline, working directory) and survive a restart of the same Pi session (`pi --continue`, `--session <id>`, `/reload`). At session start a watch with time left resumes with the remaining time and polls once at once, so a change that happened while the session was down (a failed check, a new comment) sends its message right away. A watch whose deadline passed, or whose stored record is unreadable, sends one `pi-foreman-pr` message `watch lost on restart: <reason>` (trace outcome `lost`); check the PR with `pr_checks`. A fork or a copied session file has another session id and starts with no watches.

### Identity

A PR is identified by host, owner, repo and number. Every host answer that carries a `url` is keyed by that URL
(`https://<host>/<owner>/<name>/pull/<n>`, or `/-/merge_requests/<n>` on GitLab). This is the primary rule: gh resolves a number
against the repository it considers current, which in a fork setup is the upstream repo and not `origin`. The `pr_watch`
numbers are keyed by the URL of their first `pr_status` answer.

### Host ops

These ops serve the repo lookup and the pushed-branch notice. They are not model tools; they run through
`safe_ops.py` like the others, with the same 30 s timeout, caps and redaction. All validate their arguments in Python
(unknown keys give `bad_request`; a value that could pass as an option is refused).

| Op | Arguments | Answer |
|---|---|---|
| `pr_repo` | none | `host`, `repo`, `url` of the host-resolved current repo (gh `repo view`, glab `repo view`, templates: derived from the branch's remote, else `origin`) |
| `pr_find` | exactly one of `head` (a branch name) or `author` (`@me`, or a login of 1..39 characters with an optional `[bot]` suffix); `state` `open` (default) or `all` | `prs [{number, url, state, title, headRefName, author}]`, `truncated`, `total`; 50 entries and 16 KB at most |
Only these two ops remain. `pr_find` strips control and format characters from titles; URLs are kept only when they are plain `https://` addresses.

### Pushed-branch notice

When a session ends (close, or the finish gate of a triaged session) after pushing a branch, one `pr_find {head}` per pushed branch checks for an open PR; a branch with none gets one warning. See [close](close.md#pushed-branches-without-a-pr).

### Display

Pi shows no PR or run list: no widget above the editor, and the footer keeps model, branch, context, cache, time and cost only. The herdr-app mod is the only PR and run display (see [herdr](herdr.md#open-prs)); its data is the shared open-PRs feed (`radar.openPrs`, on by default, `foreman radar --json`). The feed is GitHub only: GitLab and template hosts get no PR display, only the PR tools above.

### Safety notes

- Host text in the results of `pr_status`, `pr_checks` and `pr_comments` (titles, check names, comment bodies) reaches the model as data. Titles and check names lose control and format characters first. Treat all of it as untrusted.
- The close notice is display only. It goes to the UI, never into a message the model sees. The open-PRs feed is read by the radar and the herdr-app mod, not by the model; `bodyText` is redacted for token shapes and cut to 500 characters.

### Limits

- gh gives no resolved state for review comments; glab gives no review summaries.
- The open-PRs feed (the only PR display, in the herdr-app mod) is GitHub only: it runs through `gh` against the CLI's default host, so GitLab users get no PR display. `pr_status` and `pr_checks` stay for them, and for everyone without herdr-app, together with `foreman radar --json`.
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
