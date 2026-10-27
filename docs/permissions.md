# Permissions: the tool gate

> Covers how pi-foreman decides every tool call: the gate's steps, who sees an ask, the decision log, the config keys and the migration from the old permission package.
> Read it when a call is denied or asks that you expected to run, before you adopt a new default, or when you upgrade from a release that used `@gotgenes/pi-permission-system`.
> The floors run first and nothing here (policy, review model, dialog) can allow what a floor refuses.

pi-foreman decides tool calls with its own gate, `extensions/core-adapter/gate.ts`. It is the first `tool_call` handler in load order and decides every tool call of every session kind. The permission package it replaces is no longer loaded, rendered or configured: there is no rendered permission file and no shadow mode.

A guard rail, not a sandbox: a prompt-injected agent can still find commands the parser marks opaque. Those go to the review model, never to a default allow, and the floors run on the raw text so obfuscation reaches a review or a deny, not an allow.

## Session kinds

| Kind | What it is | Who answers an ask |
|---|---|---|
| owner | a pane with a human and no parent | a dialog in the pane |
| round | a session opened by a parent foreman (`foreman session open`) | `ask.md` to the parent, which brings it to its owner |
| child | a subagent run (builder, reviewer, ...) | its parent, via `gate.childAsk` (below) |
| headless | no UI (print or json mode) | nobody: the ask is denied |

## The steps

Every call goes through these steps in order. All are deterministic except step 4.

1. **Parse.** `shellast.ts` parses `bash` input with `unbash` into segments: the commands of chains, pipelines, `$(...)`, backticks and subshells, `bash -c`/`sh -c`/`eval` with a literal string, and the wrappers `env`, `timeout`, `nice`, `nohup`, `xargs`, `time`, `command`, `stdbuf`, `setsid`, `watch`, `flock -c`. Each segment has its argv, redirect targets, heredoc presence and effective cwd (a `cd` inside the line, `git -C`). Variables resolve only through the closed grammar of `shellvars.ts` (see [Variables in bash lines](#variables-in-bash-lines)). A segment whose program or targets the walker cannot resolve is **opaque**: an unresolved variable, a glob in a target, a process substitution, a runner with a non-literal script, nesting deeper than 4, a parser error, a function definition, `alias`, `trap` and similar builtins, an assignment outside a short closed allowlist of harmless names, a shell fed by heredoc or stdin, and PowerShell or cmd. The `powershell` tool is one opaque segment. The path tools yield a path and a direction, `fetch` a method and URL, and MCP and skill tools their name and input. An opaque segment is never a default allow.
2. **Floors.** A deny with a reason that names the allowed alternative. No model, no dialog, no override by policy, config or dialog; no config key turns them off. They run on the raw text of every tool before parsing and again on the AST, so an unparseable command can be denied but never allowed by default. See [Floors](#floors).
3. **Defaults.** Named allow rules (`default-<name>`, with tests), evaluated per segment. The whole line is allowed only when every segment matches a default and none is opaque. See [Defaults](#defaults). The path tools have their own runtime rules (`path-read-*`, `path-write-*`) computed from the session's roots.
4. **Review.** One call to the review model with the merged trusted policy and the facts the gate computed. It returns a closed JSON verdict. See [The review call](#the-review-call).
5. **Dialog.** Only when the verdict is `ask`, or when the review is unreachable, in a session with someone to ask. See [Who sees an ask](#who-sees-an-ask).
6. **Decision log.** Every decision of every layer is one JSON line. See [Decision log](#decision-log).
7. **Gradual growth.** `foreman perms candidates` lists what can become a default. See [Candidates](#candidates).

Self-modification writes (`selfMod`), git-config drift on non-routine keys and the bridge trust record are dialogs by rule and never cleared by the model.

## Floors

Floors deny with a reason and no model call, for every session kind:

- secrets and key paths (`~/.ssh`, `~/.gnupg`, `~/.aws`, cloud and kube credentials, `.env`, `.npmrc`, `.pypirc`, `.netrc`, git credential stores, Pi's auth file) for read and write;
- writes to pi-foreman's config and policy files of every layer, `safety.*` config, `managed.json`, `state/round-parents.json`, `state/bridge-trust.json`, `state/approvals/**`, `state/gate/**`, and (for any child tool write) `state/child-asks/**`;
- force, mirror and delete pushes, pushes to the default or a protected branch, and **any `git push` from a subagent child** (children never push; the foreman pushes). Round sessions opened with `foreman session open` keep going to review;
- `git config` of the keys listed in `extensions/core-adapter/git-floor-keys.json` (hooksPath, sshCommand, credential helpers, `url.*.insteadOf`, remote urls, push configuration), in every form: `git config` in any scope, the `-c key=value` prefix, `--config-env`, `GIT_CONFIG_*` environment words, and `git remote add|set-url|rename|remove|set-branches|set-head`; `core.attributesFile` outside `.workflow/` or with a verb other than `merge`;
- deletes and recursive overwrites outside the session's worktree, scratch and `/tmp`; `rm` of `/`, home or a system dir;
- `sudo`, `su`, `doas`; shutdown, disk formatting, `dd` to a device;
- whole-filesystem scans (`find /`, `grep -r ... /`, `du /`, `ls -R /`);
- a download piped into a shell; package publish;
- the existing guards, unchanged: the git guard, the shell-write guard, the destructive guard, secrets-in-commit, `protect.deny`, `childDeny`, own-ruling writes and foreign session dirs;
- an opaque segment whose raw text contains a floor pattern.

## Defaults

A default is a named rule that allows without a model. The shipped rules (`defaults.ts`):

| Rule | Allows |
|---|---|
| `default-own-tool` | pi-foreman's own tools that carry no file path and no shell or message payload: `plan_mode_question`, `plan_mode_complete`, `ask_user_question`, `foreman_ledger`, `foreman_triage`, `foreman_checkpoint`, `foreman_dialogs`, `foreman_wait`, `contact_supervisor`, `subagent_supervisor`, `bg_wait`, `bg_status`, `bg_logs`, `bg_kill`, `pr_status`, `pr_checks`, `pr_comments`, `pr_watch`, `pr_track`, `pr_untrack`, `git_status`, `git_log`, `git_diff_stat`, `git_branch_state`, `subagents_enable`. Every other tool (`foreman_bg`, `bg_run`, `foreman_move`, `foreman_copy`, `foreman_session_open`, `pr_create`, `subagent`, `intercom`, `fetch`, `codemode`, every MCP and skill tool) goes through the pipeline on its actual payload |
| `default-read` | the read class of `effects.ts` (`ls`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `find`, print-only `sed`, ...) on paths inside the session's roots |
| `default-build-test` | the project's own build and test commands from its manifest, run from the worktree |
| `default-write-in` | `mkdir`, `touch`, `cp`, `mv`, `rm`, `tee` inside the worktree, scratch and `/tmp` (`gate.tmpAccess`, default on) |
| `default-git-read`, `default-git-add`, `default-git-commit` | read-only git; `add`; `commit` with a message (secrets-in-commit still runs) |
| `default-git-fetch`, `default-git-pull` | `fetch`; `pull --ff-only` |
| `default-git-switch` | `switch`/`checkout` of the own branch |
| `default-git-push` | `git push [-u] origin <own branch>\|HEAD` with an empty environment prefix, and no force, delete, mirror, tag, `:` refspec, `-o`, `--repo`, `--receive-pack`, `--exec`, `-c`, or `remote.origin.push`. Never for a child (floor) |
| `default-gh-read` | read-only `gh`/`glab` (`run view\|list`, `pr view\|checks\|diff\|list\|status`, `api` with no method, no graphql and no `-f/-F/--input`; `run download` only into scratch), writing only to scratch, `/tmp` or a reader pipe |
| `default-assign` | the closed allowlist of harmless assignments |

Children get the same defaults minus pushes, parent `.workflow` writes and anything outside their worktree.

### Owned paths

Path tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `foreman_move`, `foreman_copy`) go through `pathrules.ts`. The allowed places are computed at runtime from the session's roots, not rendered into a file:

- the worktree, the session's scratch dir and the OS temp dirs (`gate.tmpAccess`; for a child only its own `$FOREMAN_SCRATCH`);
- reads of the Pi install dir, the global npm root, the bundled package roots and the owned roots (state dirs, handoffs, sibling worktrees);
- the registered round-parent `.workflow` dir, read-only, for the session whose parent it is;
- the session's own handoff dir: `plan.md` and `result.md` may be written;
- a child never writes a handoff dir's `parent` or `child` files, the parent's `.workflow`, or anything outside its own worktree.

A path outside every root is no allow; it falls through to the review. Secret paths are floors and never reach this step.

### Variables in bash lines

`shellvars.ts` resolves `$NAME` / `${NAME}` only when every statement of the line is in a closed grammar: a sole `NAME=literal` assignment of a plain absolute path (or a `$FOREMAN_SCRATCH` prefix), or a simple command from a fixed list of programs with plain words, `$NAME` words, `2>&1`, `>/dev/null` or one plain redirect target. Anything else leaves the variable unresolved and the segment opaque. The cases are pinned by `tests/fixtures/shellvars-grammar.json` and `tests/fixtures/shellvars-cases.json`.

### Split literals

The git guard (`scripts/git_guard.py`, also for the main role) denies, never asks, a bash line whose quoted, ANSI-C or escaped pieces of one word (`'.g''it'`) or whose `"a"+"b"` literal chain spell a guarded path component (`.git`, `.git.`, `GIT~1`, any case) that no single piece spells; the reason is `split literal reassembles a guarded token`. For a child the guard also denies string fragments joined by `+`, `..`, `.concat(...)`, `[...].join(...)` or `.replace(All)` whose reassembly is a whole guarded command token (`rm`, `dd`, `git`, `push --force`, `reset --hard`, ...). Cases: `tests/fixtures/split-literal-cases.json`.

## The review call

One call on the role map's `review` rung (`providers.<p>.roles.review.model`, `roles.review`), the inexpensive rung by default. The doctor warns when none is set.

**Policy.** The review reads the merged trusted policy: the shipped `config/permissions.policy.md`, the user's file (`<agentDir>/pi-foreman/policy.md`; `gate.policy.userFile` names another), and the overlay's `safety.policy.files[]`. Each file has `## allow`, `## deny`, `## ask` and `## context` sections of entries `- id: <kebab-id>` followed by prose. Precedence in the prompt: floors, `ask`, `deny`, `allow`. No matching entry is a deny that says so (`no-matching-entry`).

**Facts the gate computes.** The model never guesses them: surface, tool, role, session kind, cwd, worktree root, owned roots, branch and remotes, HEAD, the script state of a script the line runs (`tracked-unchanged`, `untracked`, `modified`, `outside-repo`), and the web-read facts below. The prompt also carries the owner's last message and up to 10 earlier ones (cut), the gate's own history of what the agent ran this session (commands and paths, never output), and the full command in nonce fences as untrusted data.

**Verdict.** Closed JSON: `{"verdict": "allow"|"deny"|"ask", "entry": "<id>", "reason": "<=300 chars"}`. The entry must exist in a trusted layer and lie in the section the verdict names. An unknown field, a foreign or wrong-section id or unparseable JSON is an invalid verdict, which counts as an unreachable review with the cause `invalid verdict` (below). A deny verdict is final at every level and its reason reaches the agent as the tool error.

**Project layer.** `<cwd>/.workflow/policy.md` (only `## deny` and `## ask`) runs as a second, tighten-only call after a trusted allow and may answer `deny`, `ask` or `none`. A project can therefore never create an allow. A call with a project layer costs two model calls.

**Timeout.** `gate.reviewTimeoutMs` (default 15000, minimum 100). A timeout is an unreachable review.

### Cache

Decisions are cached per session. The key is the exact input JSON plus the session context: the policy hashes, the review provider and model, session kind, role, cwd, branch, HEAD, MERGE_HEAD, the gate's facts, the tool and the payload. A cached deny holds for the session (and for every command of the same normalised shape); a cached allow holds only for the exact input and is dropped after the next state-changing call (anything but a pure read).

### web-read

A plain download needs no dialog. `fetch` GET/HEAD, or `curl`/`wget` writing into scratch (or to stdout read by a reader such as `head`, `grep`, `jq`), has these gate checks, computed deterministically and passed to the review as facts:

- (a) GET/HEAD only: no body, no upload, no other method;
- (b) no auth or cookie material, no userinfo in the URL;
- (c) nothing runs the download: no pipe or substitution into a shell or interpreter, no config file;
- (d) the output goes into scratch, or to a non-executing reader.

Check (e) is the review's: the URL must not smuggle data (a long or encoded query value, a secret-like value, file or session content). Any doubt is `ask`. A failed check names its letter and never makes the call routine. There is no host list. One review is cached per distinct URL. Running a downloaded file asks (`unseen-script-run`).

### MCP tools

MCP tools (`mcp__<server>__<tool>`, or the `mcp` proxy tool) are allowed after review only when the name and arguments together show a read: `list_*`, `get_*`, `search_*`, `read_*`, `take_snapshot`, `take_screenshot`, or read-only navigation to a plain URL (judged by the web-read rules). Tools that act (click, fill, type, submit, upload, evaluate, create, update, delete, ...) and read-looking calls with smuggled data are `ask` (`mcp-act`).

## Who sees an ask

An `ask` verdict, or an unreachable review (cause `timeout`, `provider error`, `no model configured` or `invalid verdict`), becomes:

- **Owner pane:** one dialog with the full command, the entry or the cause, and the reason. For an unreachable review it states plainly why; it is never a silent allow or deny. Choices: allow once, allow for session, deny with a typed reason, deny and stop the turn. `y` and `n` answer as the dialog shows.
- **Round session:** the gate files `ask.md` to its parent with the same fields and waits `gate.askTimeoutMs` (default 900000, 15 min) for `ruling-<n>.md`, then denies. The parent brings it to its owner.
- **Child:** see below.
- **Headless:** deny, with a reason that says what to report.

A self-modification ask stays a deny for children, and a floor never reaches the ask.

### Child asks

`gate.childAsk` is `"parent"` (default) or `"deny"`. With `"parent"`, a child's plain policy `ask` goes to the parent's pane:

1. When the parent adapter launches a child it creates an ask dir `<agentDir>/pi-foreman/state/child-asks/<parent session id>/<launch id>/` and passes it in the launch binding. The child gate writes `ask.md` there (the round ask format plus `role` and `run` lines) with `fs`, never through a tool, and waits for `ruling-<n>.md` up to `gate.askTimeoutMs`.
2. A floor denies any child tool write (write, edit, move, copy, a shell redirect, or an opaque line naming the path) under `state/child-asks/`, so a child can never write its own ruling. A ruling is accepted only as `ruling-<n>.md` for an `n` the child gate itself wrote, with an mtime not before its ask. A stale ruling is ignored.
3. The parent adapter polls the ask dirs of its running children (500 ms) and answers each new `ask.md` once. In an owner pane it opens one select dialog naming the child role and run, the tool and the payload, with `allow once` or `deny with reason`. A round parent forwards through its own round path (`ask.md` into its handoff dir with the child's role and run in the text) and copies its parent's ruling down. A headless parent writes `DENY`.
4. Dialogs from several children queue, one at a time. When a child has timed out its pending dialog is dropped; a late answer is logged, not applied.
5. `ALLOW` lets the call run once. Anything else, or the timeout, denies. No child tool and no tool at all writes inside `state/child-asks/`; the adapter alone writes the rulings there. The parent model never answers a child ask directly.

With `"deny"`, or when the binding has no ask dir (a headless parent, or a launcher that cannot answer), the child is denied with a text that names what to report to the foreman. An invalid verdict or an unreachable review is a deny for a child (`policy_invalid_verdict` for an invalid verdict). This replaces the old package's ask forwarding.

## Decision log

One JSON line per gate decision, every layer, in `<agentDir>/pi-foreman/state/gate/log.jsonl`: `id, ts, session, kind, role, tool, layer (floor|default|review|dialog|cache|child-ask), verdict, rule or entry, reason, shape, cwdHash`. `shape` is the normalised, redacted command: program and option words kept, literal paths reduced to a class (`<worktree>/...`, `<scratch>/...`, `<tmp>/...`, `<home>/...`, `<parent>/.workflow/...`, `<abs>`), URLs to the host, every quoted string and every secret-like value replaced by `<v>`. The log rotates to `log.1.jsonl` at `gate.logMaxBytes` (default 20 MB). A child's answered ask is logged with `layer: "dialog"` and reason `parent-allow`, `parent-deny` or `parent-timeout`; the parent logs one `child-ask` record with the child run id.

### Candidates

`foreman perms candidates` is read-only. It groups the log by shape and lists what can become a default: shapes the review allowed at least 5 times with 0 denies and 0 owner overrides, and shapes the owner approved in dialogs repeatedly. Columns: count, last seen, one example, proposed section. `foreman perms export-eval` turns the log into the eval fixture. Nothing adopts by itself: `/foreman perms adopt <id>` in the owner pane writes an entry to the user policy file's `## allow` behind a confirm dialog the model never clears. The user policy file and `state/gate/**` stay floored for every tool and shell write.

## Config keys

| Key | Meaning | Project layer |
|---|---|---|
| `gate.reviewTimeoutMs` | review call timeout (default 15000, minimum 100) | lower only |
| `gate.askTimeoutMs` | how long a round session or a child waits for a ruling (default 900000) | lower only |
| `gate.childAsk` | `parent` (default) or `deny` | `deny` only |
| `gate.tmpAccess` | writes (the owner also reads) under the OS temp dirs (default true) | `false` only |
| `gate.logMaxBytes` | log rotation size | user or overlay only |
| `gate.policy.userFile` | the user's own policy file (absolute, `~/...` or relative to the agent dir) | user or overlay only |
| `providers.<p>.roles.review`, `roles.review` | the review model | user or overlay only |
| `safety.policy.files[]` | extra policy files of an overlay | user or overlay only |
| `safety.preBash` | pre-bash hooks | user or overlay only |

Every other `gate.*` key is user or overlay only; a project value is dropped with a warning. A project cannot remove a user `deny` entry, and a project policy file can only add `deny` and `ask` entries.

## Known limits

- Another extension loaded before the gate, or one that mutates `event.input` after it, could change the input between the decision and the execution. The gate is first in load order; the doctor warns when any extension precedes it.
- Extension-registered providers: the review model call goes through Pi's registry, so a provider an extension registers at runtime must be loaded before the first review.
- The `bash` tool is parsed as bash. When the resolved shell is not a bash binary (a custom `shellPath`, or the Unix `sh` fallback) the gate treats the tool as opaque.
- The decision is made on the command string, not at run time: another local user can swap a `/tmp` path for a symlink in between.
- Git config in the repository (`diff.external`, a pager) still applies to `git diff` and `git log`.
- The live eval (`node scripts/foreman_perms.mjs eval --model <provider/id>`) calls the review model's provider directly (the Anthropic API for the default Haiku review model), needs a logged-in provider and Node >= 22.18, and never runs in CI; CI runs only the offline eval with fixture answers.

## Windows

The `bash` tool on native Windows runs Git Bash, so the bash AST applies as on Linux and macOS. The optional `powershell` tool has no parser: every `powershell` call is opaque. The floors run on its raw text (with the PowerShell-aware shell-write grammar), then the review model decides, never a default allow. Inside a bash line, `powershell`, `pwsh`, `cmd`, `cmd.exe`, `wsl` and any invocation of a `.ps1`, `.cmd` or `.bat` file are opaque segments and the whole line goes to review. On win32 a path has two spellings (backslashes, 8.3 short names such as `RUNNER~1`); `effects.ts` `realSpelling()` compares the real spellings, so a read root stored by its realpath still matches. `/tmp` never counts on Windows. The gate tests run on the three CI operating systems with path fixtures for both separators and drive letters.

## Parser and prior art

The gate parses with `unbash` 6 (pinned exact, upgraded only with the eval green). Its AST types are isolated in `shellast.ts`, because the v5 to v6 change shows node shapes can move.

| Option | Install | Platforms | Accuracy | Verdict |
|---|---|---|---|---|
| `unbash` 6 (ISC) | one dependency, pure TypeScript, no transitive deps | Windows-neutral pure JS | GNU Bash 5.3 syntax, typed AST with positions, tolerant parser with a partial AST plus errors; zsh, PowerShell and cmd unsupported (documented) | **chosen**: about 15x faster than tree-sitter wasm, no native or wasm build |
| `tree-sitter-bash` over `web-tree-sitter` (wasm) | grammar plus wasm runtime; what the old permission package used | wasm, any platform | full grammar | not chosen: wasm dependency, about 15x slower |
| a regex or quote-aware splitter (the old `shellchain.ts`) | none | any | splits on `&&`, `||`, `;`, `|`; refuses `$(`, backticks, subshells and heredocs | not chosen: refuses most real lines, so they all went to a model; kept only as a thin layer over the AST |

Packages that build on `unbash` were considered and not used (`pi-bouncer`, `@cad0p/pi-steering` with `@cad0p/unbash-walker`, `pi-access-guard`, `pi-guards`): each pins an older `unbash`, none covers the policy layers, role-aware defaults, round-parent reads or the ask-to-parent flow, and running one beside the gate would double the dialogs. Three designs come from `pi-bouncer` as reference: its always-deny set and rule names, its judge context (command, cwd, branch and remotes, the owner's recent messages, what the agent ran, never tool output) and its rule that an unparseable command is never allowed. pi-foreman writes its own small walker (`shellast.ts`) instead of depending on `unbash-walker`.

| Role of the old package | Now |
|---|---|
| decides every tool call from rendered rules | the gate, first in load order |
| permission dialog UI | pi-foreman's own dialog (owner pane) |
| subagent ask forwarding to the parent | replaced by the gate's own parent ask (child asks, above) |
| rendered config keys, managed hash, doctor drift | removed; path rules are computed at runtime |
| delegation envelope | dropped |
| authorizer link `foreman-review` | the gate's review step, without the link API |
| bash parsing with tree-sitter-bash | `unbash` via `shellast.ts` |

## Developing pi-foreman itself

When the session's working directory is the package root or inside it (symlinks resolved; case-insensitive on Windows and macOS), the write protection of the package root narrows to the config and policy files (`config/permissions*.json`, `config/permissions.policy.md`, `config/foreman.defaults.json`, `package.json`); other writes in the checkout (docs, extensions, tests, scripts) pass. The session writes a `protect_selfhost` trace event.

## Migration from the permission package

This release removes `@gotgenes/pi-permission-system`. `foreman setup` migrates the user's `foreman.json` keys and prints one line per key:

| Old key | New |
|---|---|
| `providers.<p>.review.model` | `providers.<p>.roles.review.model` |
| `providers.<p>.review.timeoutMs` | `gate.reviewTimeoutMs` |
| `safety.permissions.autoReview.rulesFile` | `gate.policy.userFile` |
| `review.childDefer: "owner"` | `gate.childAsk: "parent"` |
| `review.childDefer` (any other value) | `gate.childAsk: "deny"` |
| `review.headless` | removed ("a session with no pane above it denies an ask") |
| `review.fallback` | removed ("nothing reads it") |
| every other `safety.permissions.*` key | removed ("the permission package is gone; the gate decides") |

A key whose target is already set is dropped with the reason `<target> is already set`.

**Backups.** Before it changes anything, setup writes `<agentDir>/pi-foreman/state/migration/foreman.json.pre-gate` (your config) and `permission-system-config.json` (the package's rendered config), then removes the rendered config file.

**The package entry in `settings.json`** is a separate, explicit step that setup never runs. Preview it, then apply it:

```
node scripts/foreman_migrate_gate.mjs settings --dry-run
node scripts/foreman_migrate_gate.mjs settings
```

It backs up `settings.json` to `state/migration/settings.json.pre-gate` and drops the package entry.

**Doctor.** `/foreman doctor` prints one `FAIL` line per leftover, with the same text setup prints and the fix: a leftover `safety.permissions.*` or `review.*` key (`<key>: removed (...)`, fix: run `foreman setup`), the rendered permission config, the package entry in `settings.json` (fix: the two commands above) and a package install (`permission package install <dir>: remove it`).

**The way back** is the previous pi-foreman release: install it (`npm install pi-foreman@<previous>`), copy the backups back (`foreman.json.pre-gate` over your `foreman.json`, `permission-system-config.json` back to `<agentDir>/extensions/pi-permission-system/config.json`, and `settings.json.pre-gate` over `settings.json` if you ran the settings step), and run its `foreman setup`. The previous release rejects `gate.*` keys, so the backup copy is the way back, not an automatic restore. Setup prints these steps when it migrates.
