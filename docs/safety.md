# Safety and permissions

> Covers the shell-write guard, git guard, PR gate, permission baseline with model auto-review, child environment stripping, bridge isolation and the known `/sync` limit.
> Read it when a command is refused or asked about, or before you loosen a rule.
> A project file can only tighten these rules; the scanners work on command strings and are not a sandbox.

## Shell-write guard

Shell writes into project files (redirects, `tee`, `sed -i`, writing scripts) are refused for the foreman at every tier; `.workflow/` (and the scratch dir in `scratchpad` mode) stays open. A child is denied heredoc and stdin-script file writes (`cat > f <<EOF`, `python3 - <<EOF`, `node -e` opening a file for write), the in-place flags of perl, ruby and awk (`perl -pi`/`-i`/`-pie`, `ruby -i`, `awk -i inplace`) unless every file argument lies in the child's own scratch dir, and inline `-c`/`-e` code with a write call (`open(` with a write mode, `write_text(`, `write_bytes(`, `writeFile(`, `writeFileSync`, and perl's write-mode `open(FH, ">f")`), each with the reason "use the write or edit tool"; the scratch exemption covers in-place flags only, inline write code is denied even with a scratch argument, and reads with those interpreters stay allowed. The scanner works on the command string and is not a sandbox; known blind spots are listed in `design/architecture.md` [section 5](../design/architecture.md#5-safety-policy). The destructive and secret guard runs on `bash`/`powershell` for the foreman and its children. `foreman_bg` and the optional background-tasks add-on's `bg_run` count as `bash` for every shell guard and for the permission baseline (`shellTools`); a missing or non-string `command` is refused ([sessions](sessions.md#background-runs)).

## Git guard and PR gate

`scripts/git_guard.py` lints commits and pushes (own lexer for bash, PowerShell and cmd): the foreman's commit lint, push lint (no force, mirror, delete or `+refspec` on protected branches) and the limits for children, who never open PRs and may not push unless `safety.children.mayPush` allows it. A PR (`gh pr create`, `glab mr create`, `hub pull-request`, `tea pr create`, a push with merge-request options or to `refs/for/*`) is refused unless a reviewer PASS was recorded for the current head (an `item` or `[pre-pr]` review; `[plan-review]`, `[second-opinion]` and panel shadow reviews never count, see [review](review.md#review-occasions)), which is the checkout the reviewer ran in (`ceremony.reviewBeforePr`; a project or session cannot turn it off). A later commit, a finalizer's included, makes the review stale, so for heavy tasks the order is builder, finalizer, reviewer, PR, or review twice. Outside a repository the head is unknown and no PR goes through. Children never open PRs.

Safety line for children: no recursive deletes, no discards outside the child's own diff. A child may undo its own
change to a test file: `git restore [--worktree|-W] [--staged|-S] [--] <paths>` or `git checkout -- <paths>` is
allowed only when every path is a plain file path (no glob, `.`, `..`, directory, `:(` magic or leading `-`) that
matches the test-path rule (`isTestPath` in `diffscan.ts`, mirrored by `is_test_path` in the guard), lies inside the
repository, is tracked and shows modified against HEAD. `--source`/`-s`, a tree-ish, `-p`, `--merge`,
`--ours/--theirs`, `--pathspec-from-file`, `-f`, xargs input, a `cd` earlier in the command, any git global option
(`-C`, `--git-dir`, `--work-tree`, `-c`, `--namespace`, ...), any `GIT_*` text in the command and a repository other
than the working directory's are refused. The restore must be a command of its own: the whole command is one plain
call whose first word is literally `git`, with no chain (`;`, `&&`, `||`, `|`, `&`, newline), nesting (`bash -c`,
`eval`), assignment or wrapper in front, `$`, backtick, brace, `%` or redirect anywhere (bash or PowerShell, not
cmd); otherwise it is refused and the
refusal names the allowed form. Each allowed path leaves a `test_restore` trace line (path in `cmd`) in the child's
trace. Children are not stopped from committing; after a child commit "vs HEAD" means its changes since that commit.

Git config drift (a changed `.git/config`, hooks, includes) asks before the foreman's next git run; added or removed `branch.<name>.remote` and `branch.<name>.merge` keys (from `worktree add -b`, `push -u`, `checkout -b`) are routine and ignored, a changed value is still reported.

## Permission baseline and auto-review

The installer generates the permission-system config from `config/permissions.baseline.json` plus
`safety.permissions` (user and overlay layers; a project file may only add `deny` and `ask` entries) and owns that
file: a hand edit is backed up and overwritten, so put your rules into `foreman.json`. The baseline has no `sed`
rule (no glob separates a print from `1wout` or `1etouch x`, so every sed asks).

The write protection (`protect`: `.git`, agent and harness configuration) checks the path arguments of a shell
command, reads included: operands, option values and redirect targets. It skips the pattern and script operands of
read commands (the grep/egrep/fgrep/rg pattern and `-e` values, a sed script without `w`/`r`/`e`/`a`/`i`/`c`
commands, an awk program without redirection, pipe, `getline` or `system`, find's `-name`/`-iname`/`-path`/`-regex`
values when there is no `-exec`/`-delete`, echo/printf text), but only when every command of the line is a read or
filter command (grep, rg, sed, awk, find, echo, printf, cat, head, tail, wc, sort, uniq, cut, tr, ls, cd, ...) and
there is no `$(...)`, backtick or process substitution: `echo .git/HEAD | xargs touch` is still refused. A `*` skips
dot entries as in bash (unless the command mentions `dotglob` or `GLOBIGNORE`) and `\` is no path separator outside
Windows. The secret path denies still check every word.

`codemode` is allowlisted: each call its script makes (`tools.read`, `tools.bash`, ...) passes the overlay, the
guards and the permission system on its own, as a direct call would (`tests/replay/test_replay_codemode.py`).

Asks go through a model review link (`foreman-review`) using `providers.<p>.review.model` (see
[roles](roles.md) for the automatic pick). Child asks are forwarded to it:

- The review prompt treats read-only inspection (also chained) as allowed; it defers only for writes outside the
  workspace, network or destructive steps.
- The review link allows a forwarded child ask without a model call when it holds a print-only sed
  (`sed -n '<addr>p' <file>`: no s/w/e/r commands, no -i/-f; trace label `sed-read`) or `timeout N <allowed
  command>` and every other unit is allowed (PS floors wrappers).
- Scratch copies under `/tmp` (trace label `tmp-scratch`): the whole command is one simple command, nothing chained,
  piped or redirected, that is `cp [-r|-R|-a|-p] <src>... <dest>` or `mkdir [-p] <dest>...` with every destination
  under `/tmp/` (no `..`, not `/tmp` itself, not a symlink, no symlink leading out; into an existing dir each
  `dest/<name>` the same, and no recursive copy into it). Every `cp` source must be a contained read
  ([permissions](permissions.md)), a recursive one from the worktree only. No `rm` in any form: `rm -rf /tmp/...` stays
  reviewed. POSIX only; on Windows it never matches. A user `ask`/`deny` pattern that catches the command wins.
- A child's `rm` / `rm -f` of an editor backup (`*~`, `*.bak`, `*.orig`, `*.swp`, `.#*`) is denied with reason `editor_backup`; the child reports the file instead.
- The permission system forwards only one unit of a chained command (the first most restrictive one), with the
  whole command as `full command` evidence. Every deterministic allow (`sed-read`, `timeout-wrapper`, `tmp-scratch`,
  `child-scratch`, `test-restore`, `effect-read`, `effect-build-test`, `effect-write-in`) must hold for both the unit
  and that full command; `cp -r . /tmp/x && rm -rf ../src` goes to the model review.
- Chains (`&&`, `||`, `;`, `|`) and effect classes (read, build-test, write-in; only write-out and unknown reach the
  model): see [permissions](permissions.md).
- Headless defer: with no UI, or `review.headless: true` (default false), a forwarded child ask is denied with a
  text naming the allowed forms, trace `review_defer_headless {role, cmd}`. The `review` trace carries the model's
  defer `reason`.
- Child asks never reach the owner pane by default: a forwarded child ask the review defers is denied with the same text (`review.childDefer`, default `deny`, trace `review_defer_child {decision, role, cmd}`), because the parent drains forwarded asks one at a time and an owner dialog would hold every later child ask. `review.childDefer: "owner"` keeps the old defer. The foreman's own asks still defer to the owner.
- Review model calls are logged to the usage log with role `autoreview`.

Child traces: with the foreman's retro on, a bound child writes `trace-<launchId>.jsonl` and each record carries `role`
and `runId` (the launch id); see [retro](retro.md). `tasks` and `chain` launches are not covered.

## Owned paths

The generated permission policy allows the foreman's own artifacts outside the workspace without a prompt: the handoff
dirs, the session's `subagent-artifacts`, the `../<repo>.worktrees` round dir, the children's scratch root, reads of
`foreman.json`, `settings.json`, `<agentDir>/pi-foreman` and the global npm root, and `git worktree add|list|prune|lock|unlock|move|repair`
(`remove` still asks). The grants are per user, not per session, and children's write permissions are unchanged: the
overlay and the git guard keep children out of the foreman-only dirs (handoffs except `plan.md`/`result.md`, sibling
worktrees, other children's scratch dirs, `pi-foreman/claude-config`) and off `git worktree`, and the `parent` and
`child` handoff files still ask. The list and the reasons are in [permissions](permissions.md#owned-paths).

The git guard also denies a bash line whose quoted, escaped or `"a"+"b"` pieces spell a guarded path component (`.git`) that no single piece spells (`split literal reassembles a guarded token`; see [permissions](permissions.md#split-literals)).

There is no `git fetch` allow row (`--upload-pack=<cmd>` runs code): it asks for every role; `npm ci` and `npm install`
are allowed for the foreman only.

A `$NAME` in a bash line resolves to a same-line assignment only inside a closed grammar: every statement (split on
`;`, `&&`, `||`, newline) is a sole `NAME=<plain absolute path>` or a simple command from `mkdir cp mv cat ls tee touch
tar node npm npx python3 git test echo true` with plain words (letters, digits, `/ . _ ~ = : @ % + , -`, `$NAME`,
`${NAME}`, `2>&1`, `>/dev/null`, `>`/`>>` with a plain word). A pipe, `&`, parentheses, braces, brackets, backtick, `#`,
`<`, `$(`, `${` beyond a bare name or any other statement form makes the line resolve nothing, and it asks as before. The
exact rules are in [permissions](permissions.md#variables-in-bash-lines).

## Child scratch

Each single-child launch gets a scratch dir under the OS temp dir (`$FOREMAN_SCRATCH`, see
[ceremony](ceremony.md)). Writes and removes are allowed inside that dir only, never the dir itself or anything
outside it:

- Overlay: a child may `cd` into its own scratch dir (literal or `$FOREMAN_SCRATCH`); every other rule applies there too.
- Overlay: a child with a bound scratch dir is denied, not asked, any write below `/tmp` or the resolved OS temp dir outside that scratch dir and its own workspace: a write or edit tool path, a shell redirect (`> /tmp/out.txt`), and the targets of `tee`, `touch`, `mkdir`, `mv`, `cp` (last operand), `install` and `ln`. The reason names the path and the scratch dir (`write to /tmp/out.txt denied for a child: use FOREMAN_SCRATCH (<scratch dir>)`). Reads from `/tmp` and the foreman's own `/tmp` rules are unchanged.
- Shell-write guard: a planner child, which may write nowhere outside its allowed dirs, may also write inside its own
  scratch dir.
- Review link (label `child-scratch`): a forwarded child ask is allowed without the model when every unit of the
  command is `cp [-rRapf] <src>... <dest>`, `mkdir [-p] <dir>...`, `rm [-rRf] <path>...` or `cd <dir>` with every
  destination or operand inside a live scratch dir of the asking role, or a unit the rules allow, joined only by
  `&&` or `;`; and an outside-directory ask for a write or edit path inside such a dir. POSIX shell forms only. The
  link knows the asking child's role, not its launch, so two concurrent launches of one role share the allowance.
- The destructive guard still refuses `rm -r` with a variable operand: use the literal path.
- The harness removes the dir at run end only after a realpath check that it is a real directory below the
  `pi-foreman-scratch` root and neither inside nor around the repository.

## Child environment and extensions

Subagent children get a stripped environment: `childenv.ts` removes the intercom identity variables, so a child
cannot pose as its parent session (see [sessions](sessions.md)). Required child extensions
(`safety.requiredChildExtensions`) load the guards into every child; a project file may only add entries.

## Bridge isolation

With the Claude bridge, `CLAUDE_CONFIG_DIR` points at an empty folder so the host's Claude Code settings, hooks,
plugins and `CLAUDE.md` do not load into bridge turns (`bridge.isolateClaudeConfig`; a project file cannot set it).
Login steps are in [install](install.md). Rationale: `design/architecture.md`
[bridge isolation](../design/architecture.md#bridge-isolation).

## Known limit: a reader chained with `find`

The reader skip for protected operands (see Owned paths) covers a command whose every unit is a minimal reader. A read-only line chained with `find` (`cat protected/file; find . -name x`) loses the skip for the protected file, because `find` is not in the reader set. The set is not widened; split the line or use the read tool.

Protected files (the baseline's `protect.writeAsk` paths, such as `config/foreman.defaults.json`, `config/permissions.baseline.json` and `package.json`) are the foreman's to apply and commit. A child's `git add` or `git commit` naming one is denied with the text "The foreman stages and commits this file; report the needed change.", and every builder brief (not a rung-up handoff entry) ends its ledger block with one `Protected files (...)` line saying the same, so a builder reports the change instead of retrying.

## Known limit: stale "needs attention" notices

pi-subagents delivers `subagent_control_notice` custom messages with `pi.sendMessage` (`triggerTurn` for async runs), and a queued message cannot be withdrawn. The idle wake that carries them is handled at `input` (R26 item 2): when every unseen notice is for a run whose end event already arrived, the input returns `handled` and no turn starts (trace `notify_deduped {reason: "run_ended", runId}`). A wake that also carries a notice for a live run, or any owner prompt, still starts a turn, and the stale notice in it is hidden from the model and the display (`context`, `message_end`). `notices.ts` (`staleNoticeRunIds`, `dropEndedRunNotices`) holds the rules. Pi's hooks cannot cancel a queued custom message itself, so a mixed wake still runs; fixing that needs a Pi hook to withdraw a queued custom message (for example a `message_start` handler that can cancel it), or a run-end check in pi-subagents' `control-notices.js` before it calls `sendMessage`.

## Known limit: `/sync`

`/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config (see [sessions](sessions.md)). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. **Known limit:** a child agent or other code running as your user can plant repository state (config, remotes, commits) between syncs; /sync refuses every planted state it knows (git's local file transport is off, remote names must be plain names), but it is not a boundary against such code. List only repositories you trust children not to touch.

## Known limit: worktrees on Windows

On Windows pi-subagents cannot spawn a script hook without a shell, so the `foreman-worktree-setup` hook does not run there. Managed worktrees keep a symlinked `node_modules`, and builders must not run `npm ci` in them (it would rewrite the main checkout's `node_modules`). `/foreman doctor` WARNs on a symlinked `node_modules` in a live worktree.

## Known limit: background runs on Windows

On Windows a `foreman_bg` command runs under `cmd.exe` (`cmd /d /s /c "<command>"`), and the add-on's `bg_run` also runs its commands under `cmd.exe`, while the overlay rules, the shell-write guard, the destructive guard and the git guard classify the command as bash. cmd syntax the bash scanner does not model (`&` as a separator, `^` escapes, `%VAR%` expansion, cmd built-ins such as `del`, `rd` or `copy`) can therefore pass with a verdict that is wrong for what actually runs. Keep background commands on Windows to plain program calls (`node …`, `npm test`). Running them through `bash.exe -c` (Git Bash), so the guards and the shell agree, is a later item.

## Further safety and runtime keys

Key-by-key layer rules for `safety.*`: `design/architecture.md`
[safety and loosening keys by layer](../design/architecture.md#safety-and-loosening-keys-by-layer).

| Key | Meaning and layer rule |
|---|---|
| `safety.permissions.deny`, `safety.permissions.ask` | Bash patterns that are always denied / need approval, on top of the baseline; a project can add entries, not remove them. |
| `safety.permissions.allow` | Bash patterns allowed without asking, on top of the baseline; a project or session cannot extend it. |
| `safety.permissions.projectCommands` | The repo's own test and build commands as bash patterns, allowed without asking; not settable by project/session. |
| `safety.permissions.paths.deny`, `safety.permissions.paths.ask` | Path patterns tools and shell commands may never touch / need approval, on top of the baseline secret paths; a project can add entries only. |
| `safety.review.required` | Require a review before close-out; a project can only set true. |
| `safety.git.protectedBranches` | Branch patterns that never receive a force push, mirror push or delete from the foreman; a project can add entries only. |
| `safety.git.commit.messagePattern` | Regular expression the commit subject must match; `null` switches the check off; a project cannot set it. The pattern applies to foreman and child commits alike. A child's `-F` message file (R14) lies only under `<worktree>/.workflow/scratch/` or the child's own `$FOREMAN_SCRATCH` (by realpath; `.pi/` is the main session's dir and is refused); the message-file exemption from the write protection covers `git commit -F` only, and a child `git tag -F` under a protect rule is denied ([permissions](permissions.md#owned-paths)). A child whose message the guard cannot read is denied (the foreman is asked). `-F -` / `-F /dev/stdin` passes for a child only with a literal same-line heredoc, linted on its body; other stdin or computed sources are denied. Several `-F`, or `-F` with `-m`, count as unread. A child's `git commit -F <file>` is read only on an allowlisted line: the whole input at the top level with no substitution, group, heredoc, here-string, pipe, redirect, `\|\|` or `&`, made of an optional first `cd <dir in the worktree>`, any `git add` / `git status` / `git diff --cached` and exactly one `git commit -F <file>`; any other line with `-F` is a child deny (write the message file in an earlier command). A child's `git commit --amend --no-edit` is a deny with its own reason. The foreman is asked when a `-F` target is written, copied, moved or linked on the same line. |
| `safety.git.commit.requiredTrailers`, `safety.git.commit.forbiddenTrailers` | Regular expressions each required trailer line must match / no trailer line may match; a project can add entries only. |
| `safety.git.commit.checkCommand` | argv run before each foreman commit with the staged diff on stdin and the message in `PI_FOREMAN_COMMIT_MESSAGE`; a non-zero exit blocks the commit. |
| `safety.ops.copyMaxBytes` | Size cap for `foreman_copy`; a project can only lower it. The foreman's `foreman_copy` may also read from its own session handoff dir (into the workspace; the destination stays confined to it); children may not. |
| `safety.ops.worktreeDisposable` | Path components whose ignored files `foreman_worktree_remove` may delete (`name/` = a directory); not settable by a project. |
| `safety.ops.baseBranch` | Base branch for the merged check of `foreman_worktree_remove`; `null` = origin HEAD, else main, else master. |
| `safety.preconditionOps` | Settings container for the precondition-checked operations; a project cannot set it. |
| `intercom.allowRemote`, `intercom.allowOpenPane` | Allow remote intercom / opening a pane (both default `false`); a project or session can only set false. |
| `close.from` | Sources a close request is accepted from (default `herdr`, `intercom-parent`); a project or session can only narrow it. |
| `close.autoClean` | Remove manifest worktrees and scratch at close when the preconditions pass (default `true`); a project or session can only set false. See [close](close.md). |
| `close.worktreeDir` | Worktree convention directory (default `../<repo>.worktrees`); user or overlay config only. |
| `python.path` | Python 3.9+ interpreter; `null` auto-detects. It runs every guard, so a project or session value is ignored. |
| `trace.enabled`, `trace.dir` | The allowlisted trace and its directory. `trace.enabled` defaults to `null`, which follows the effective `retro.enabled` (on in tui and rpc, off in json and print); an explicit `true` or `false` wins, so `false` always turns it off. The directory (`null` = the state dir; a project or session value must resolve inside the workspace). |
