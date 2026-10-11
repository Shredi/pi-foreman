# Tools

> Covers the optional git tool pack (`tools.git`): the four read tools, their caps and guards, child inheritance, and the trace and retro output.
> Read it before you switch the pack on, or when you wonder where other tools belong.
> The pack is off by default; the project and session layers can only switch it off.

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

`foreman_move`, `foreman_copy` and `foreman_worktree_remove` are unchanged and always registered; see
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
| `tool_pack` | `pack` (`git`), `op` | one pack call while the pack is on; `op` is `status`, `log`, `diff_stat`, `branch_state`, `move`, `copy` or `worktree_remove` |

`foreman retro` prints `git: pack N calls (status a, ...) vs bash git M` after the trace lines: pack calls from the
trace, bash git calls (`git` as the command word) from the session. The JSON report has `trace.git_pack` and
`session_tools.bash_git_calls`.

## Other tools

Anything beyond git belongs in an overlay; see [overlays](overlays.md).
