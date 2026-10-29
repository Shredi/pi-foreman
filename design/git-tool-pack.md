# Git tool pack

## 0. Status and scope

| Item | Value |
|---|---|
| Status | Design for the `git-tools` build wave, 2026-10-11. Builders implement against this file without further decisions. |
| Rule | The harness ships at most one optional built-in tool pack, and that pack is git. Every other tool belongs in an overlay (`docs/overlays.md`). |
| Evidence | Read 2026-10-11 against pi-subagents@0.75.0 `src/runs/background/async-execution.js`: the runner env is `process.env` minus git routing variables (`GIT_DIR`, `GIT_CONFIG_*` …) and `PI_SUBAGENT_EXTENSION_BINDINGS`. A `PI_FOREMAN_*` variable reaches the child. `childenv.ts` strips only the intercom and `CDPATH` variables. Every depth-0 launch is async (`forceTopLevelAsync`). |
| Minimum git | 2.24 (`--end-of-options` in `log` and `diff`). Older git fails the op with `git_failed`; bash git is unaffected. |

## 1. Config

| Key | Type | Default | Project / session layer |
|---|---|---|---|
| `tools.git` | boolean | `false` | tighten-only: only `false` is accepted |

- `config/foreman.schema.json`: a new top-level property `"tools": {"type": "object", "additionalProperties": false, "description": "Optional built-in tool packs (docs/tools.md).", "properties": {"git": {"type": "boolean", "description": "true = the git tool pack: git_status, git_log, git_diff_stat, git_branch_state for the foreman and for children whose role has bash. User or overlay config; the project and session layers may only set false. Re-run foreman setup after a change."}}}`.
- `config/foreman.defaults.json`: `"tools": {"git": false}`, placed after `trace`.
- `scripts/foreman_config.py`: append `(("tools", "git"), "false_only")` to `LAYER_TIGHTEN`, and a docstring row `tools.git  only false is accepted (true adds tools)`. Do not use `IGNORED_KEYS`, because a project must stay able to switch the pack off. `foreman_docs.layer_rule` then renders `tighten-only (only false is accepted)` with no generator change.

## 2. Python read ops (`scripts/safe_ops.py`)

Add `"status"`, `"log"`, `"diff_stat"` and `"branch_state"` to `OPS`. The request and answer envelope stays the same: `{"op", "args", "cwd", "config"}`, where `config` is the merged `safety.ops`. An answer is `{"ok": true, "action": <op>, ...}` or the existing precondition and error forms.

**Git invocation.** A new helper `git_read(args, root)` returns `git(["--no-pager", "--no-optional-locks"] + args, root)`. `git()` already prepends `git_hardening()`: `core.fsmonitor=false`, `protocol.ext.allow=never` and an empty `core.hooksPath`. The env already sets `GIT_LITERAL_PATHSPECS=1`, `GIT_CONFIG_NOSYSTEM=1` and `LC_ALL=C`, and drops `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`. Every read op runs with `cwd = root = workspace_root(req["cwd"])`. `log` and `diff` also pass `--no-color --no-ext-diff --no-textconv`.

**Validation.** All of these raise `bad_request` (Precondition). Python validates even though the TS schemas repeat the limits.

| Arg | Rule |
|---|---|
| args | A dict. An unknown key raises `bad_request (unknown arg <k>)`. |
| `n` | An int, not bool, with `1 <= n <= 200`. The default is 20. Out of range raises `bad_request`, with no clamping. |
| `rev`, `range` | A str of length 1..200 that fullmatches `RANGE_RE = r"^[A-Za-z0-9._/@^~-]+(?:\.\.\.?[A-Za-z0-9._/@^~-]+)?$"`. Every part of `re.split(r"\.\.\.?", v)` must be non-empty and must not start with `-`. There is no `:`, `{` or space, so `HEAD:file`, `@{u}` and options are refused. |
| `branch` | A str of length 1..200 that fullmatches `BRANCH_RE = r"^(?!-)[A-Za-z0-9._/-]+$"`, and `git check-ref-format --branch <v>` must exit 0. |
| `path` | A non-empty str of at most 1024 characters, with no NUL and no leading `-`. `has_git_component(v)` raises `inside_git_dir`. `full = realpath(join(cwd, v))` must satisfy `is_inside(root, full, allow_equal=True)`, else `outside_workspace`. git receives `relpath(full, root)` with `/` separators after `--`. The path need not exist, so the log of a deleted file works. |

**Caps.** `MAX_ENTRIES = 200` and `MAX_BYTES = 16 * 1024`. `cap(result, key)` works in three steps:
1. Set `total = len(result[key])` and keep the first 200 entries.
2. While `len(json.dumps(result)) > MAX_BYTES` and entries remain, drop the last entry.
3. Set `result["truncated"] = kept < total` and `result["total"] = total`. Every list op always carries both keys.

| Op | Args | Argv after `git_read` prefix | Answer (besides `ok`, `action`) |
|---|---|---|---|
| `status` | none | `status --porcelain=v2 --branch -z --untracked-files=normal` | `branch` (str, or null when detached), `head` (sha, or null when unborn), `upstream` (str or null), `ahead` and `behind` (int, or null without an upstream), `counts {staged, unstaged, untracked, conflicted}`, `files [{path, xy, orig?}]`, `truncated`, `total` |
| `log` | `n?`, `rev?`, `path?` | `log -z --no-color --no-ext-diff --no-textconv --format=%H%x1f%h%x1f%aI%x1f%an%x1f%s -n <n> --end-of-options <rev or HEAD> -- [<path>]` | `commits [{sha, short, date, author, subject}]`, `truncated`, `total` |
| `diff_stat` | `range?`, `path?` | `diff --numstat -z --no-renames --no-color --no-ext-diff --no-textconv --end-of-options <range or HEAD> -- [<path>]` | `files [{path, added, deleted, binary}]`, `totals {files, added, deleted}` (computed before capping), `truncated`, `total` |
| `branch_state` | `branch?` | see below | `branch`, `head`, `upstream`, `ahead`, `behind`, `base`, `mergedIntoBase`, `baseAhead`, `baseBehind` |

- **status parsing.** Records are split on `\0`.
  - The headers are `# branch.oid` (`(initial)` gives a null head), `# branch.head` (`(detached)` gives a null branch and `detached: true`), `# branch.upstream` and `# branch.ab +A -B`.
  - A `1` record is `rec.split(" ", 8)[8]`. A `2` record is `rec.split(" ", 9)[9]`, and the next field is `orig`. A `u` record is `rec.split(" ", 10)[10]` and counts as conflicted. A `?` record is `rec[2:]`, counts as untracked and gets `xy` `??`.
  - `staged` counts the 1/2 records with `X != "."`, and `unstaged` those with `Y != "."`.
  - `counts` covers every record. `files` is then capped.
- **log.** When `rev` is absent and `rev-parse --verify --quiet HEAD` fails (an unborn branch), the answer is `commits: []` with total 0. When `rev` is given, each range part must pass `rev-parse --verify --quiet <part>^{commit}`, else `unknown_revision`. Records are split on `\0`, then on `\x1f` into 5 fields. A non-zero exit raises `ActionError("git_failed")`.
- **diff_stat.** With no `range`, `HEAD` must verify, else `no_commits`. Each numstat record has the form `A\tD\tpath`. `-\t-` gives `binary: true` with `added` and `deleted` 0. `range` parts are verified like `rev`. A non-zero exit raises `git_failed`.
- **branch_state.** It runs in these steps:
  1. Pick the ref. Without `branch`, `symbolic-ref --quiet --short HEAD` gives the name; on failure, `branch` is null and the ref is `HEAD`. With `branch`, `rev-parse --verify --quiet refs/heads/<b>^{commit}` must succeed, else `unknown_branch`.
  2. Resolve `head` with `rev-parse --verify --quiet <ref>^{commit}`; on failure, raise `no_commits`.
  3. Find the upstream with `rev-parse --abbrev-ref --symbolic-full-name <b>@{upstream}`. When there is no branch or the call fails, set null. Otherwise run `rev-list --left-right --count <head>...<upstream>` and read `ahead`/`behind` from `A\tB`.
  4. Call `resolve_base(root, ops_config(cfg)["baseBranch"])`. On `Precondition`, the four base fields are null and the op still succeeds. Otherwise `base` is the ref and `mergedIntoBase` is the result of `merge-base --is-ancestor <head> <base_sha>` (exit 0). `baseAhead` and `baseBehind` come from `rev-list --left-right --count <head>...<base_sha>`.

**Error codes.**

| Kind | Codes |
|---|---|
| Existing | `bad_request`, `git_missing`, `not_a_git_repo`, `outside_workspace`, `inside_git_dir` |
| New preconditions | `unknown_revision`, `unknown_branch`, `no_commits` |
| Action errors | `git_failed`, `timeout` (60 s, existing) |

Update the module docstring's op list. `handle()` needs no change.

**Known limit.** git may run configured clean or smudge filters for `status` and `diff`. That is the same exposure as bash `git status`. For the foreman, the drift preflight (§3) asks before any run after `.git/config` changed. Children are not gated here, the same as for their bash git.

## 3. TypeScript (`extensions/core-adapter/gitpack.ts`, new)

```ts
export const GIT_PACK = "git";
export const PACK_ENV = "PI_FOREMAN_TOOL_PACKS";
export type GitReadOp = "status" | "log" | "diff_stat" | "branch_state";
export const GIT_PACK_TOOLS: { name: string; op: GitReadOp; label: string; description: string; parameters: Record<string, unknown> }[];
export const GIT_PACK_TOOL_NAMES: readonly string[]; // git_status, git_log, git_diff_stat, git_branch_state
export function envNamesPack(env: Env, pack?: string): boolean;          // env[PACK_ENV] split on ",", trimmed, exact match
export function gitPackOn(i: { config: unknown; isChild: boolean; env: Env }): boolean; // get(config,"tools.git") === true && (!isChild || envNamesPack(env))
export function applyGitPack(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, on: boolean, isChild: boolean, env: Env): void;
export interface GitPackSession { python: string | null; isChild: boolean; packOn: boolean; opsConfig: unknown; trace(rec: Record<string, unknown>): void }
export interface GitPackDeps { session(ctx): Promise<GitPackSession>; script: string; spawner: Spawner; env(): Record<string, string>; timeoutMs?: number;
  preflight?(ctx, op: GitReadOp, callId: string): Promise<{ block: true; reason: string } | undefined> }
export function registerGitPack(pi: Pick<ExtensionAPI, "registerTool">, deps: GitPackDeps): string[];
```

- **Parameter schemas.** They are plain JSON Schema with `additionalProperties: false`. `git_status` takes `{}`. `git_log` takes `n` (integer 1..200), `rev` (string 1..200) and `path` (string 1..1024). `git_diff_stat` takes `range` (string 1..200) and `path`. `git_branch_state` takes `branch` (string 1..200). Descriptions name the caps and say that bash git still works.
- **Registration.** `registerTool({... defaultActive: false})` for all four, in the foreman and in children.
- **Execute order.**
  1. Resolve `deps.session(ctx)`. An exception is an adapter error.
  2. If `!s.packOn`, fail with `<tool>: the git tool pack is off (tools.git); use bash git. Nothing was done.` and `{decision: "pack_off"}`, with no trace.
  3. Emit `s.trace({event: "tool_pack", pack: "git", op})`.
  4. Call `deps.preflight`. A block fails with `{decision: "blocked"}`.
  5. Call `runSafeOp({op, args: params, cwd: ctx.cwd, config: s.opsConfig, ...})`. `ran` gives text `<tool>: ` + `JSON.stringify(result without ok)` and details `{decision: "ran", result}`. `precondition` and `error` give `failure()` texts like safeops.ts, without "the normal tools remain available".
- **safeops.ts (wiring only).** Widen `RunSafeOpInput.op` to `SafeOp | GitReadOp` (an `import type` from gitpack.ts). Export the existing `failure` helper, or copy it. Add `packOn?: boolean` to `SafeOpsSession`. In `execute`, emit `{event: "tool_pack", pack: "git", op: t.op}` once per call, right after the foremanOnly check, when `s.packOn === true`. Names and registration are unchanged.
- **index.ts (wiring only).**
  - Add `gitPack: boolean` to `Session`.
  - After the ledger activation (around line 446), add `s.gitPack = gitPackOn({config: config.config, isChild: s.isChild, env: process.env}); applyGitPack(pi, s.gitPack, s.isChild, process.env);`.
  - Add `packOn: s.gitPack` to the `registerSafeOps` session.
  - Right after `registerSafeOps`, call `registerGitPack(pi, {...})` with the same `script`, `spawner` and `env`.
  - The preflight is `safeOpDriftPreflight(s.gitDrift, s.isChild, ctx.cwd, os.homedir(), "git_" + op, driftAsk(ctx), trace, callId)`. That gives the label `foreman_git_status` and so on, gates the foreman only, and returns undefined in children.
- **applyGitPack.**

  | Session | `on` | Effect |
  |---|---|---|
  | Foreman | true | Add the missing names via `setActiveTools([...active, ...missing])`. Set `env[PACK_ENV] = "git"`. |
  | Foreman | false | `delete env[PACK_ENV]`, so a stale inherited value never leaks. |
  | Child | false | `setActiveTools(active.filter(n => !GIT_PACK_TOOL_NAMES.includes(n)))`, only when something is removed. |
  | Child | true | No change. The role's allowlist decides, so a child never gains a tool its role lacks. |

  A child never writes `PACK_ENV`.
- **`config/permissions.baseline.json`.** Add `"git_status"`, `"git_log"`, `"git_diff_stat"` and `"git_branch_state"` as `"allow"`, after `foreman_copy`. They are unconditional, since inactive tools are harmless. (The former `test_permissions_gen.py` assertion is gone with the permission package; the gate's own tests cover the allow.)

## 4. Child inheritance

1. **Handshake.** The foreman with `tools.git: true` exports `PI_FOREMAN_TOOL_PACKS=git`, and pi-subagents passes it to children (see the Evidence row in §0). The child computes `gitPackOn`: the env must name `git` and the child's own merged config must have `tools.git === true`. A project `false` therefore switches the pack off in children too.
2. **Allowlists.** Add `GIT_PACK_TOOLS = ("git_status", "git_log", "git_diff_stat", "git_branch_state")` and `with_git_pack(cfg, role, tools)` to `scripts/foreman_config.py`, next to `with_ledger_tool`. When `(cfg.get("tools") or {}).get("git") is True` and `"bash" in tools`, `with_git_pack` appends each missing name. Call it in `resolve_role`, after `with_ledger_tool` and only for `role != "foreman"`, and in `generate_subagents` after `with_ledger_tool`.
   - **Roles.** The rule is: roles whose list has `bash`. Of the defaults, that is explorer, builder, reviewer, senior-reviewer and finalizer; overlay roles follow the same rule. These roles already run git through bash, so the pack only replaces a path they have. The planner has no bash, so it gets no git, and adding it there would widen the role.
3. **Re-run setup.** Child tool arrays come from the generated `subagents` block, as for codemode, so enabling the pack needs `foreman setup` again. docs/tools.md says so. A stale array that still lists the tools while the config is off is harmless: the child gate removes them, and `execute` refuses with `pack_off`.

## 5. Trace

- Add `"pack"` and `"op"` to `TRACE_FIELDS` in `trace.ts`, at the end of the list. Neither exists today.
- The event `tool_pack {pack: "git", op}` is emitted once per pack call while the pack is on. `op` is one of `status`, `log`, `diff_stat`, `branch_state`, `move`, `copy` or `worktree_remove`.
- Add a row for `tool_pack` to the trace event table in docs/tools.md.

## 6. Retro (`scripts/foreman_retro.py`)

- **`trace_metrics`.** Add a `tool_pack` Counter, counting `str(r.get("op") or "?")` for each record with `event == "tool_pack"` and `pack == "git"`. Store it as `m["git_pack"] = dict(counter)`.
- **`session_metrics`.** Add `bash_git_calls`. It counts the `bash` and `powershell` calls whose `bash_family(cmd)` equals `"git"` or starts with `"git "`. That is the word `git`, so `gitleaks` is not counted.
- **`git_pack_line(rep)`.** It returns `None` when both `rep["trace"]` and `rep["session_tools"]` are None, or when both counts are 0.
  - Format: `git: pack N calls (status a, log b, diff_stat c, branch_state d, move e, copy f, worktree_remove g) vs bash git M`.
  - Only ops with a count of at least 1 are listed, in that order, and an unknown op is listed last. With N = 0 the parenthesis is left out. A missing side prints `n/a` in place of the number.
- **Placement.** `render_text` appends the line directly after the trace block's `friction:` line, or after `trace: no data`, before `spawn cost`. The line then sits within the first 10 lines and the `L[:30]` cap never cuts it.
- **JSON.** The JSON report carries the counts through `trace.git_pack` and `session_tools.bash_git_calls`. No new top-level key is added.

## 7. Features and docs

- **`config/features.json`.** Add the following entry after `git-guard`, then run `FOREMAN_DOCS_UPDATE=1 python scripts/foreman_docs.py features`:

  ```json
  {"id": "git-tools", "title": "Git tool pack", "purpose": "Structured, capped git read tools (git_status, git_log, git_diff_stat, git_branch_state) for the foreman and for children with bash; the checked move, copy and worktree-remove tools count as pack members in the trace.", "doc": "docs/tools.md#git-tool-pack", "keys": ["tools.git"], "commands": [], "switch": {"key": "tools.git", "on": "true"}, "state": "off", "enable": "{\"tools\": {\"git\": true}}"}
  ```

  Use `off`, not `dormant`: that is the value existing features with an `on: "true"` switch use.
- **`docs/tools.md` outline.**

  | Heading | Content |
  |---|---|
  | `# Tools` | Purpose, and the one-pack rule. |
  | `## Git tool pack` | The key, the layer rule, the enable snippet, and that `foreman setup` must be re-run. |
  | `### Read tools` | A table per tool: args, answer fields, caps (200 entries / 16 KB, `truncated`/`total`), `log` n default 20, max 200. |
  | `### Guards` | Hardening, arg validation and `--end-of-options`, the workspace rule, the drift preflight, the filter limit, and that bash git is unchanged. |
  | `### Write tools in the pack` | `foreman_move`, `foreman_copy` and `foreman_worktree_remove`: unchanged and always registered, they only count in the trace. Link docs/safety.md. |
  | `### Children` | The env handshake and the bash-role rule. |
  | `### Trace and retro` | The `tool_pack` event and the retro `git:` line. |
  | `## Other tools` | Belong in an overlay. Link docs/overlays.md. |

- **Links.** AGENTS.md "Docs by area" gets the line `` - `docs/tools.md`: optional git tool pack (`tools.git`), read tools, caps, guards, child inheritance, trace. ``. `llms.txt` gets a matching bullet.

## 8. Tests (one focused test per behaviour)

Python tests use a `tempfile.mkdtemp` repo built with `git init`. They never hard-code `main`: they read the branch from `symbolic-ref --short HEAD` and pass `config: {"baseBranch": <it>}`. They clean up only that directory, and pass paths with forward slashes.

| File | Tests |
|---|---|
| `tests/test_safe_ops_git.py` (new) | status counts (staged/unstaged/untracked/conflict-free) and branch fields; status cap at 250 untracked files (200 kept, `truncated`, `total` 250); 16 KB cap from long commit subjects; log default 20, and `n` 0 and 201 give `bad_request`; log `rev` `--output=x` gives `bad_request` and creates no file; diff_stat ranges: `HEAD~1..HEAD` ok, `a..-x` and `HEAD:f` give `bad_request`, an unknown sha gives `unknown_revision`; path `../x` gives `outside_workspace`, `.git/config` gives `inside_git_dir`; branch_state ahead/behind against an upstream set with `branch --set-upstream-to`, plus `mergedIntoBase`; a POSIX-only (skip-marked) planted `diff.external` script and `core.fsmonitor` are not run by diff_stat/status |
| `tests/test_config_layers.py` | A project `tools.git: true` is dropped with a warning; `false` is kept |
| `tests/test_foreman_config.py` | `tools.git` on: `resolve_role` and `generate_subagents` add the 4 tools to the bash roles and not to the planner; off: none |
| `tests/test_foreman_retro.py` | `git:` line from a fixture trace with `tool_pack` events and session bash git calls (incl. `cd x && git status`, excluding `gitleaks`) |
| `tests/test_permissions_gen.py` | Removed in r41 with the permission package; the gate's tests cover the allow |
| `extensions/core-adapter/test/gitpack.test.ts` (new) | 4 tools registered with `defaultActive: false`; foreman on activates them and sets the env; foreman off clears the env; a child with env and config on keeps them; a child missing the env, and one with config off, have them removed; `pack_off` refusal; `tool_pack` traced with pack and op over a fake spawner; preflight block |
| `extensions/core-adapter/test/safeops.test.ts` | `tool_pack` is emitted when `packOn` and not when off |
| `extensions/core-adapter/test/trace.test.ts` | `pack` and `op` survive `sanitizeTrace` |

`tests/test_features_doc.py` covers the regenerated docs/features.md. Replay goldens that print the permission map or retro output may change. Regenerate only those, after review.
