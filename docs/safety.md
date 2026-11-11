# Safety and permissions

> Covers the shell-write guard, git guard, PR gate, the tool gate with its rules and classifier, child environment stripping, bridge isolation and the known `/sync` limit.
> Read it when a command is refused or asked about, or before you loosen a rule.
> A project file can only tighten these rules; the scanners work on command strings and are not a sandbox.

## Shell-write guard

Shell writes into project files (redirects, `tee`, `sed -i`, writing scripts) are refused for the foreman at every tier; `.workflow/` (and the scratch dir in `scratchpad` mode) stays open. A child is denied heredoc and stdin-script file writes (`cat > f <<EOF`, `python3 - <<EOF`, `node -e` opening a file for write), the in-place flags of perl, ruby and awk (`perl -pi`/`-i`/`-pie`, `ruby -i`, `awk -i inplace`) unless every file argument lies in the child's own scratch dir, and inline `-c`/`-e` code with a write call (`open(` with a write mode, `write_text(`, `write_bytes(`, `writeFile(`, `writeFileSync`, and perl's write-mode `open(FH, ">f")`), each with the reason "use the write or edit tool"; the scratch exemption covers in-place flags only, inline write code is denied even with a scratch argument, and reads with those interpreters stay allowed. One exception to the heredoc rule: a `cat` or `tee` heredoc or here-string whose every target is strictly inside the child's own scratch dir (a literal absolute path, `$FOREMAN_SCRATCH/...`, or `$NAME/...` after one literal assignment of such a path, compared by realpath on both sides) is allowed (the git guard's `stdin_write_problem` check); a heredoc into any other file stays denied. The scanner works on the command string and is not a sandbox; known blind spots are listed in `design/architecture.md` [section 5](../design/architecture.md#5-safety-policy). The destructive and secret guard runs on `bash`/`powershell` for the foreman and its children. `foreman_bg` and the optional background-tasks add-on's `bg_run` count as `bash` for every shell guard and for the permission baseline (`shellTools`); a missing or non-string `command` is refused ([sessions](sessions.md#background-runs)).

The foreman may move its checkout by branch only (r29): `git switch <b>` and `git checkout <b>` to an existing local branch, `git switch -C <b> <ref>` and `git reset --hard <ref>` are allowed when the working tree has no tracked change and HEAD is an ancestor of `<ref>` or is contained in a remote branch (the clean-tree and pushed-upstream checks of `foreman_worktree_remove`). The guard still refuses them when a check fails and names the failed precondition (trace `shell_write_allow` `reason: branch_move` on an allow). Only a plain single `git` command of these shapes qualifies (no chain, quotes, globs, `-f`, paths or `--`), optionally behind one leading `cd <dir> &&` where `<dir>` is `.`, `./` or an absolute path whose realpath is the session cwd or its git toplevel (r31; any other relative word, such as `..` or `sub/..`, a missing dir or a symlink that resolves elsewhere is not). "Contained" for `switch -C` and `reset --hard` also holds when `<ref>` already has HEAD's content: `git merge-tree --write-tree` of the two gives `<ref>`'s tree (squash merge), `git cherry` shows no unmerged commit (rebase merge), or `gh pr view` reports the branch's PR `MERGED` with HEAD as its head (5 s timeout; no gh, a detached HEAD or any error means no). These moves, and a plain `switch|checkout <b>` against `<b>`, are refused when a path that the move changes against HEAD exists untracked or ignored in the tree (it would be overwritten), or lies under a path that is not a directory, and the refusal names the file. A refusal records its failed precondition in the `shell_write_refused` trace as `precondition`. Force flags (`-f`, `--force`), `--` and chains stay refused; `git branch -f <b> <sha>`, `git branch` and `git fetch` were never refused. Children get no branch moves.

One chain is allowed (auto-merge, after a PR merged): `git switch <default> && git pull --ff-only [&& git branch -d|-D <b>]`, optionally behind one `cd <dir> &&`, each statement plain words and nothing else. `<default>` must be the remote default branch (`origin/HEAD`) and the switch passes the same clean-tree, existing-branch and untracked-clash checks as a lone switch; trace `shell_write_allow` `reason: post_merge`. The branch delete in the chain, and a lone `git branch -d|-D <b>`, are the default rule `default-git-branch-merged` instead of `danger-git` when `<b>` is merged: its tip is in `origin/<default>`, or `gh pr view` reports its PR `MERGED` at that tip. The merged fact is looked up before the gate runs (the gate never spawns gh), per segment directory; no gh, no default branch or any error means not merged. `<b>` may not be the default or a protected branch, and a child never gets the rule.

Protected targets (a host, a path or a command glob you list in `permissions.json`) are judged per call by a small model that can allow reads, and writes only while you are present; floors and deny rules still come first, and every error, timeout or doubt asks ([permissions](permissions.md#protected-targets)). The `foreman_protect` tool changes the list only after your confirmation and is never given to a child. The trace `guard` record of a guard block (`deny` or `blocked`) now carries the redacted command and the reason, like the other deny records; allows still drop the command.

## Git guard and PR gate

`scripts/git_guard.py` lints commits and pushes (own lexer for bash, PowerShell and cmd): the foreman's commit lint, push lint (no force, mirror, delete or `+refspec` on protected branches) and the limits for children, who never open PRs and may not push unless `safety.children.mayPush` allows it. A PR (`gh pr create`, `glab mr create`, `hub pull-request`, `tea pr create`, a push with merge-request options or to `refs/for/*`) is refused unless a reviewer PASS was recorded for the current head (an `item` or `[pre-pr]` review; `[plan-review]`, `[second-opinion]` and panel shadow reviews never count, see [review](review.md#review-occasions)) (`ceremony.reviewBeforePr`; a project or session cannot turn it off). A later commit makes the review stale, so the order is builder, reviewer, commit, PR with the reviewer run on the committed head, or review twice. The PASS sha is accepted when it is the commit of the branch the PR opens from, of its same-named remote branch (`<branch>@{push}`, `origin/<branch>`, or the upstream only when its branch name equals `<branch>`), or, only when no head is named (ref `HEAD`), of HEAD in the checkout, so a push from another branch that leaves the local branch ref behind does not refuse a reviewed head. An explicitly named head (`--head`, `owner:branch`, `--source-branch`, `pr_create {head}`) opens the gate only through its own commit or its same-named remote counterpart; a PASS on the checkout's own HEAD never opens a PR for another branch at another commit. A reviewed local head whose same-named remote branch is another, unreviewed commit is refused (`stale_review`); an upstream of another name (a worktree branch created from `origin/main` tracks the base) neither refuses nor accepts. Push-option PR forms (`git push -o merge_request.create`) accept only a PASS on the commit being pushed (the local ref or HEAD), never via its remote counterpart; the other forms also accept the same-named remote branch. For ref `HEAD` the current branch name is used; a detached HEAD has no remote counterpart. Outside a repository the head is unknown and no PR goes through. Children never open PRs.

Sibling checkouts (a PR from another worktree or clone than the session's): a review record keeps the checkout it ran in (realpath of the git toplevel). The `pr_create {cwd}` tool opens a PR from such a checkout only when a counting reviewer PASS is recorded for exactly that checkout and equals its current HEAD (`[pr_refused:cwd_unreviewed]`, `cwd_stale`); the upstream rule applies there too, a headless PASS stays unbound, and a PASS recorded in one sibling checkout opens no other sibling (the session checkout still opens by SHA). `gh pr create --repo X --head B` from the session checkout is accepted only when exactly one checkout with a recorded PASS has a remote matching X and its local branch B at the PASS head (`repo_unmatched`, `repo_ambiguous`). `cd <dir> && gh pr create` stays refused (`pr_compound`). Each refusal names `pr_create {cwd}`; children and a disabled gate behave as before.

The gate checks only at PR creation; a head pushed later is not refused by it. The session's PR watch reports it instead (`head <sha> not reviewed (last PASS on <sha>)`, see [tools](tools.md#watch)).

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

The read PR tools take `repo` and `host`. `host` is an allow-rule: it must equal the current repository's host, or the host of a remote of the checkout; any other host is refused with `[pr_refused:pr_host_refused]` before the op runs, in the foreman and in children alike. `repo` is accepted for any `owner/name` on an accepted host. `pr_create`, `pr_watch`, `pr_unwatch` and `pr_follow` act, so they are foreman-only: `CHILD_DENIED_TOOLS` names them, and a child that calls one is refused with `[pr_refused:child]`. The host ops (`pr_find`, `pr_repo`, and `pr_batch`, which the watch polls through) are not model tools. See [tools](tools.md#pr-tools).

Git config drift (a changed `.git/config`, hooks, includes) asks before the foreman's next git run; added or removed `branch.<name>.remote` and `branch.<name>.merge` keys (from `worktree add -b`, `push -u`, `checkout -b`) are routine and ignored, a changed value is still reported.

## The tool gate

Every tool call is decided by pi-foreman's own gate (`extensions/core-adapter/gate.ts`), the first `tool_call` handler: parse the shell line, floors (always on, no config switch), self-modification rules, `deny`, `ask` and `allow` pattern rules, built-in allows (a plain `git push [-u] origin <branch>` is one only for the branch checked out in the worktree it runs in, by `cd` or `git -C`, and only when that worktree is the session's own checkout or one the session created; force, `:` refspecs, `--delete`, `--all`, `--mirror`, `--tags`, protected branches and pushes from other worktrees are not), then the dangerous class (deploys, forge writes, publishing, installs, network writes, destructive git, process control, writes outside the worktree). A call that no rule decides and that is not dangerous runs under the default mode `auto`. A dangerous call goes to a cheap classifier that may only clear it by citing one of your prose whitelist sentences; everything else opens a dialog. The whole pipeline, the file locations, rule syntax, the four modes, the session kinds, the child-ask flow, the config keys and the migration from the review-model gate are in [permissions](permissions.md). The policy is `<agentDir>/pi-foreman/permissions.json`, plus a project `.workflow/permissions.json` (widening keys only when untracked and git-ignored) and a tracked `.pi/permissions.json` that can only tighten. The user file can also name `workFolders`: reads there are allowed, and an `auto` folder runs uncovered writes as under mode `auto`, except in `.git`, `.pi`, the agent dir and the install dirs.

The foreman session's own single launch of a role (`explorer`, `builder`, `reviewer`) is a named default allow (`default-role-launch`), so a fresh install with no classifier model can still delegate. Floors and denies run before it, and the adapter's role, ceremony and spawn gates run after it and still refuse. Management actions that write, workflow scripts, unknown agents, `tasks`/`chain` forms and a child's own launches are not covered. Without a classifier model, `foreman doctor`, `/foreman setup` and the first dangerous call of a session warn and name the key to set (`providers.<p>.roles.review.model`); every dangerous call then asks.

The write protection (`protect`: `.git`, agent and harness configuration) checks the path arguments of a shell
command, reads included: operands, option values and redirect targets. It skips the pattern and script operands of
read commands (the grep/egrep/fgrep/rg pattern and `-e` values, a sed script without `w`/`r`/`e`/`a`/`i`/`c`
commands, an awk program without redirection, pipe, `getline` or `system`, find's `-name`/`-iname`/`-path`/`-regex`
values when there is no `-exec`/`-delete`, echo/printf text), but only when every command of the line is a read or
filter command (grep, rg, sed, awk, find, echo, printf, cat, head, tail, wc, sort, uniq, cut, tr, ls, cd, ...) and
there is no `$(...)`, backtick or process substitution: `echo .git/HEAD | xargs touch` is still refused. A `*` skips
dot entries as in bash (unless the command mentions `dotglob` or `GLOBIGNORE`) and `\` is no path separator outside
Windows. The secret path denies still check every word; the only read they let through below `~/.ssh` is a valid SSH public key file directly in it (see [permissions](permissions.md)), never a write.

Protected files guard against mistakes by children, not against a hostile child: a child may run its own scratch
scripts, so the rule is not a sandbox. A protected file named by a read-only unit passes only for plain readers (cat,
grep, and a strict allowlist of read-only git subcommands) with no env prefix, wrapper (`env`, `command`, `nice`), loop
(`for`, `select`) or assignment anywhere in the line; any write form on the file stays denied.

`codemode` is not on the gate's default list: each call its script makes (`tools.read`, `tools.bash`, ...) passes the gate on its own, as a direct call would (`tests/replay/test_replay_codemode.py`).

Who sees an ask:

- The owner pane gets one gate dialog (full command, cause, the classifier's reason). A classifier that cannot clear the call (timeout, provider error, no model, invalid verdict, no citing sentence) opens the same dialog.
- A session opened by another session asks in its own pane.
- A child's ask goes to its parent's pane through an ask dir the parent adapter owns (`gate.childAsk`, `parent` by default, `deny` keeps a plain deny); `gate.askTimeoutMs` bounds the child's wait and a timeout denies. A child can never write that dir.
- A headless session, or an owner who is away, denies an ask at once. A floor decision never counts as an ask: it is decided without a presence probe and keeps its own reason ([permissions](permissions.md#presence)).
- A child's text-only hit on a line the parser could not read (a push, a git config key, a remote, a policy file) is a deny with a rephrase hint, never a parent ask ([permissions](permissions.md#floors)).
- A child's `rm` / `rm -f` of an editor backup (`*~`, `*.bak`, `*.orig`, `*.swp`, `.#*`) is denied with reason `editor_backup`; the child reports the file instead.
- Every decision is a line in `<agentDir>/pi-foreman/state/gate/log.jsonl`; classifier calls are logged to the usage log with role `classifier`.

Child traces: with the foreman's retro on, a bound child writes `trace-<launchId>.jsonl` and each record carries `role`
and `runId` (the launch id); see [retro](retro.md). `tasks` and `chain` launches are not covered.

## Owned paths

The gate's path rules allow the foreman's own artifacts outside the workspace without a prompt, computed at runtime from the session's roots: the handoff
dirs, the session's `subagent-artifacts`, the worktree root's round dir (`close.worktreeDir`, default `../<repo>.worktrees`; see below), the children's scratch root, reads of
`<agentDir>/pi-foreman` and the global npm root. The
gate and the git guard keep children out of the foreman-only dirs (handoffs except the child-written names of its own handoff dir, sibling
worktrees, other children's scratch dirs, `pi-foreman/claude-config`) and off `git worktree`, and the `parent` and
`child` handoff files still ask. The list and the reasons are in [permissions](permissions.md#owned-paths).

The git guard also denies a bash line whose quoted, escaped or `"a"+"b"` pieces spell a guarded path component (`.git`) that no single piece spells (`split literal reassembles a guarded token`; see [permissions](permissions.md#split-literals)).

There is no `git fetch` allow row (`--upload-pack=<cmd>` runs code): it asks for every role; `npm ci` and `npm install`
are allowed for the foreman only. A child's `npm ci` or `npm install` asks unless its launch sets `install: true` (builder); the ask text names the flag. The foreman's rows are unchanged.

The `live.json` file in each handoff dir (`handoffs/*/live.json`, written by the adapter at session start) is write-ask next to `parent` and `child`, so neither the session's model nor a child can forge it.

### Session files

Pi session `*.jsonl` files are denied for write, edit, `foreman_move`, `foreman_copy` and shell write words (redirects, `tee`, `sed -i`, the destination of `cp` and `mv`), for the foreman and for children. The adapter appends its state entries itself. Reads stay allowed. The session's `subagent-artifacts` dir stays writable.

A `$NAME` in a bash line resolves to a same-line assignment only inside a closed grammar: every statement (split on
`;`, `&&`, `||`, newline) is a sole `NAME=<plain absolute path>` or a simple command from `mkdir cp mv cat ls tee touch
tar node npm npx python3 git test echo true` with plain words (letters, digits, `/ . _ ~ = : @ % + , -`, `$NAME`,
`${NAME}`, `2>&1`, `>/dev/null`, `>`/`>>` with a plain word). A pipe, `&`, parentheses, braces, brackets, backtick, `#`,
`<`, `$(`, `${` beyond a bare name or any other statement form makes the line resolve nothing, and it asks as before. The
exact rules are in [permissions](permissions.md#variables-in-bash-lines), including the two extra cases a child with a scratch dir gets (one literal assignment, `$FOREMAN_SCRATCH` on a heredoc or pipe line).

## Child scratch

Each single-child launch gets a scratch dir under the OS temp dir (`$FOREMAN_SCRATCH`, see
[ceremony](ceremony.md)). Writes and removes are allowed inside that dir only, never the dir itself or anything
outside it:

- Overlay: a child may `cd` into its own scratch dir (literal or `$FOREMAN_SCRATCH`); every other rule applies there too.
- Overlay: a child with a bound scratch dir is denied, not asked, any write below `/tmp` or the resolved OS temp dir outside that scratch dir and its own workspace: a write or edit tool path, a shell redirect (`> /tmp/out.txt`), and the targets of `tee`, `touch`, `mkdir`, `mv`, `cp` (last operand), `install` and `ln`. The reason names the path and the scratch dir (`write to /tmp/out.txt denied for a child: use FOREMAN_SCRATCH (<scratch dir>)`). Reads from `/tmp` and the foreman's own `/tmp` rules are unchanged.
- Gate (default `default-write-in`): `cp`, `mkdir`, `rm` and `cd` with every destination or operand inside a live scratch dir of the asking role, and path-tool writes inside such a dir, are allowed without the model. POSIX shell forms only.
- The destructive guard still refuses `rm -r` with a variable operand: use the literal path.
- The harness removes the dir at run end only after a realpath check that it is a real directory below the
  `pi-foreman-scratch` root and neither inside nor around the repository.

## Worktree children

A single `subagent` launch with `worktree: true` records the flag in the child's launch binding, and the child gets `FOREMAN_CHECKOUT=<the foreman's checkout>` in its environment. Its builder brief says it works only in its own worktree, reads the plan and ledger in the foreman's checkout, never cds into or edits that checkout and commits on its worktree's branch. Children write files (scratch included, at the absolute `$FOREMAN_SCRATCH` path) with the write and edit tools; `cat`/`tee` heredoc and here-string writes stay denied by the child rule unless every target is inside the child's own scratch dir (see the shell-write guard above). A child's shell write into the foreman's checkout, its `.workflow/` included, is denied as `child-write-foreman-checkout` (a redirect, a write-class operand, a git write verb run from or aimed at the checkout, `git clone` into it); reads are never fenced (nor are the read-only forms of git write verbs: `git branch` list, `git stash list|show`, `git worktree list`, `git config` reads, `git tag` list forms, also under `-C <dir>` or after `cd <dir> &&`) and the child's own worktree and scratch dir are not part of the fence ([permissions](permissions.md#owned-paths)). Only single launches carry a binding: a `tasks` or `chain` launch gets the brief line but not the flag, so it has no `FOREMAN_CHECKOUT` and no checkout fence (its writes outside the worktree and scratch dir are still `child-write-outside`).

## Child shell time limit

A child's `bash` call with no `timeout` gets `ceremony.childBashTimeoutSeconds` (600 s); an explicit `timeout` above `ceremony.childBashTimeoutMaxSeconds` (1800 s) is capped to it. The default is clamped to the cap too. The effective ceiling is the lower of `childBashTimeoutMaxSeconds` and `ceremony.childTimeoutSeconds` (1800 s), because pi-subagents stops any child tool call past that per-call limit. The limit bounds a hung command, not a permission: the overlay and guards decide the same way with or without it. The foreman's own shell calls are not limited by these keys (trace `bash_timeout {action: applied|capped, requested}`).

## Child environment and extensions

Subagent children get a stripped environment: `childenv.ts` removes the intercom identity variables, so a child
cannot pose as its parent session (see [sessions](sessions.md)). Required child extensions
(`safety.requiredChildExtensions`) load the guards into every child; a project file may only add entries.

## Bridge isolation

With the Claude bridge, `CLAUDE_CONFIG_DIR` points at an empty folder so the host's Claude Code settings, hooks,
plugins and `CLAUDE.md` do not load into bridge turns (`bridge.isolateClaudeConfig`; a project file cannot set it).
Login steps are in [install](install.md). Rationale: `design/architecture.md`
[bridge isolation](../design/architecture.md#bridge-isolation).

### Bridge project-config trust

A project `.pi/claude-bridge.json` that sets an executable path, `AskClaude` or `strictMcpConfig: false` raises an error notice at session start and a
doctor FAIL. The owner can trust the file as it is with the slash command `/foreman trust bridge`: a confirm dialog shows the risky keys and the
file's sha256, and a yes writes the record `<agentDir>/pi-foreman/state/bridge-trust.json` (user layer). While the hash of the file matches, the notice
and the FAIL stay silent; any edit of the file is untrusted again. The dialog is the owner's alone (no model answer), there is no CLI
subcommand, and the file is a policy floor: a tool or shell write to it is refused.

## Pre-bash hooks

`safety.preBash.hooks` is an ordered list run before every `bash` tool call (user and overlay config only; a project or session value is ignored,
because a hook runs code). An entry ending `.mjs`, `.cjs` or `.js` is a module (absolute path, or relative to the agent dir) whose default export
(or `preBash`) takes `{command, cwd, tool, session, role}` and returns `{ block: true, reason }` to block. Any other entry is a command, split on
whitespace and run without a shell, with the same JSON on stdin; exit 2 blocks (stderr is the reason), exit 0 passes. A hook can only block, never
allow: the guards and the permission checks run after it. **Fail-open by default:** a hook error (a throw, any other exit code, a start failure, the
5 s timeout) is traced as `prebash_hook_error` and ignored. **Strict mode** (`safety.preBash.strict: true`): a hook error blocks the call. An explicit
block blocks in both modes.

Plan mode (a read-only explorer launch needs no ledger) is detected from the latest `plan-mode` custom entry (`{ enabled }`) on the session branch.

## Known limit: a reader chained with `find`

The reader skip for protected operands (see Owned paths) covers a command whose every unit is a minimal reader. A read-only line chained with `find` (`cat protected/file; find . -name x`) loses the skip for the protected file, because `find` is not in the reader set. The set is not widened; split the line or use the read tool.

Protected files (the baseline's `protect.writeAsk` paths, such as `config/foreman.defaults.json`, `config/permissions.baseline.json` and `package.json`) are the foreman's to apply and commit. A child's `git add` or `git commit` naming one is denied with the text "The foreman stages and commits this file; report the needed change.", and every builder brief (not a rung-up handoff entry) ends its ledger block with one `Protected files (...)` line saying the same, so a builder reports the change instead of retrying.

## Known limit: network reads (R31c)

The gate's web-read rule ([permissions](permissions.md#web-reads)) takes any host, by owner decision. Residuals:

- A GET to any host can carry data in its URL (path or query). The allow checks the command shape, not where the data goes.
- `curl -L` follows redirects and the resolver may point a name anywhere; the allow sees the first URL only.
- `~/.curlrc` (and the `wget` startup files and HSTS cache) still apply; the allow does not read them.
- Output goes only into the session or the role scratch dir; each child role has its own scratch dir, so a child can read a file another child of the same role left there.

## Known limit: MCP scope in children

The permission gate judges every `mcp__` call on its payload; the MCP scope (`roles.<id>.mcp`, see [roles](roles.md#rolesidmcp)) decides which tools exist in a child. Both apply. Residuals:

- Children read the trusted project's `.pi/mcp.json` the way Pi does. A shell write to `{cwd}/.pi/*` is guarded by the permission baseline, but a project you trust can still name servers there; they load only when a role's ceiling lists them.
- Group launches (`tasks`, `chain`) that need MCP are refused until the pinned pi-subagents forwards per-entry bindings; launch those roles singly.
- With `safety.subagents.allowWorkflow` on, a workflow script could pass `extensionBindings` per child and forge a binding. A script (inline or file) whose text names `extensionBindings` or `pi-foreman/1` is therefore refused (`launch_refused`, reason `workflow_binding`); only bindings the adapter writes exist. The text scan is best-effort: a computed key (`"extension" + "Bindings"`) defeats it. A script path is read from the launch `cwd` (as pi-subagents resolves it); a script that cannot be read, and a named workflow resource, which the adapter cannot read at all, are refused whenever a role has an MCP ceiling (`roles.<role>.mcp`). `allowWorkflow` is off by default, which is the real protection.

## Known limit: stale "needs attention" notices

pi-subagents delivers `subagent_control_notice` custom messages with `pi.sendMessage` (`triggerTurn` for async runs), and a queued message cannot be withdrawn. The idle wake that carries them is handled at `input` (R26 item 2): when every unseen notice is for a run whose end event already arrived, the input returns `handled` and no turn starts (trace `notify_deduped {reason: "run_ended", runId}`). A wake that also carries a notice for a live run, or any owner prompt, still starts a turn, and the stale notice in it is hidden from the model and the display (`context`, `message_end`). `notices.ts` (`staleNoticeRunIds`, `dropEndedRunNotices`) holds the rules. Pi's hooks cannot cancel a queued custom message itself, so a mixed wake still runs; fixing that needs a Pi hook to withdraw a queued custom message (for example a `message_start` handler that can cancel it), or a run-end check in pi-subagents' `control-notices.js` before it calls `sendMessage`.

## Known limit: `/sync`

`/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config (see [sessions](sessions.md)). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. **Known limit:** a child agent or other code running as your user can plant repository state (config, remotes, commits) between syncs; /sync refuses every planted state it knows (git's local file transport is off, remote names must be plain names), but it is not a boundary against such code. List only repositories you trust children not to touch.

## Worktree root and nested checkouts

- **Owned root.** Only a session in the main checkout owns the whole worktree root (`close.worktreeDir`, spelled and real path); a round session keeps its own tree and never owns sibling rounds. For a custom root every child gets a block glob (`<repo>` becomes `*`) next to the default `*.worktrees/*` one, so other repos' rounds under a shared root stay closed; a child's own round stays open. The setting is user or overlay config only, and a value that would cover the main checkout, home, the agent dir, the install dirs, the temp root or `/` is refused (`root_blocks_protected`) and falls back to the default. A root already holding another repo's worktrees is refused (`root_collision`, a snapshot). See [close](close.md#the-worktree-root).
- **Nested-checkout rule.** A git checkout inside a workspace or round tree counts as part of it only when its `.git` file points into that repo's `modules/` admin area and the admin dir points back at that exact `.git` file (linked submodule worktree), or the submodule's `core.worktree` names the checkout (plain submodule). A forged `.git` file aimed at another round's admin dir fails this check; forging it would need a write under `.git/`, which children cannot make. The lift stops at the session's workspace or round. A round worktree never lifts into the main checkout or another round.
- **Inside such a tree** the git guard lets a child commit and `restore` in a nested checkout and the push guard treats it as its own. `git submodule update`, `sync`, `init`, `foreach` and `status` are allowed for children only with the cwd, every path argument (everything after `--` included, even tokens starting with `-`) and the value of `--reference` (separate or `=` form) inside the tree; other `submodule` verbs keep their rules. The URL rule applies only to `sync`, `init` and `update --init` or `--require-init` (which implies `--init`), because they write URLs into shared git config: a `.gitmodules` URL must resolve to the URL already configured, and a child's first init of an unconfigured submodule is refused. Glob or pathspec-magic path arguments (`*`, `?`, `[`, leading `:`) count as every submodule, as does an unknown option; the value of any other option (`--depth 1`, `-j 2`, `--filter x`, `--ref-format f`; separate, `=` or attached form) is not a path. `update`, `sync`, `init` and `status` with `--recursive` are refused for children even inside the tree; the foreman or owner runs those. Every other foreign repository stays refused. Cleanup never deletes nested checkouts pi-foreman did not create.

## Known limit: worktrees on Windows

On Windows pi-subagents cannot spawn a script hook without a shell, so the `foreman-worktree-setup` hook does not run there. Managed worktrees keep a symlinked `node_modules`, and builders must not run `npm ci` in them (it would rewrite the main checkout's `node_modules`). `/foreman doctor` WARNs on a symlinked `node_modules` in a live worktree.

## Known limit: background runs on Windows

On Windows a `foreman_bg` command runs in the bash tool's shell (Git Bash, `-c`), so the guards' bash reading matches what runs. Only when no bash is found (or the shell wants the command on stdin) it falls back to `cmd.exe` (`cmd /d /s /c "<command>"`), and the add-on's `bg_run` runs under Git Bash too: on Windows pi-foreman sets `PI_BG_SHELL=bash` and `PI_BG_SHELL_PATH=<Git Bash>` in its extension factory (before the add-on loads) unless either is already set, and only `cmd.exe` is used when no bash resolves; in those cases the overlay rules, the shell-write guard, the destructive guard and the git guard classify the command as bash. cmd syntax the bash scanner does not model (`&` as a separator, `^` escapes, `%VAR%` expansion, cmd built-ins such as `del`, `rd` or `copy`) can therefore pass with a verdict that is wrong for what actually runs. In those cases keep background commands to plain program calls (`node …`, `npm test`).

## Known limit: remote machine trust boundary

A remote child (see [sessions](sessions.md#remote-child-sessions)) runs on a machine that hc reaches; the parent talks to it only through `hc exec` and `hc run`, and `sessions.machines` is the allowlist (the names also have to appear in `hc machine ls`). hc holds the connection and the credentials; pi-foreman stores none and the remote never connects back on its own. The one credential the hc intercom transport (`setup --intercom-hc`) adds is `hc machine add <parentName>` on the remote machine: it lets a remote child send intercom messages to the parent, and whoever runs as that user on the remote can then reach the parent machine through hc as well. Add it only for a remote you trust, and leave it out if the child needs no intercom. The handoff dir on the remote machine is the trust boundary: any process running as that user there can write or change its files (a `close.json`, a notice file), and the parent cannot tell that from the child. Files are fetched as data and act on nothing. Treat remote files like any peer message, and list only machines whose users you trust.

## Known limit: registry without a lock

`sessions.json` is read, changed and written back without a lock (`foreman session brief`, the open and close verbs all do this, the write itself is atomic). Two of them running at once can lose one update. The loss is accepted for now.

## Owner scripts

An approved owner script runs with the owner's rights, and no guard reads it: no floor, no permission rule, no classifier and no sandbox applies inside the run. The owner's answer in the dialog is the only control. The owner chose this (2026-11-10) for changes the guards close to every agent, such as user config, global installs and protected files.

**Mechanics.** The foreman writes a script into the scratch dir and calls `foreman_script` with `action: "propose"`, the path, a description (at most 600 characters), the risk and the undo (at most 300 each). The script must be a regular file below the scratch dir (no symlink, one hard link, at most 64 KiB, UTF-8). The dialog shows the three texts, each made one line with control and escape characters removed and never cut (a text over its limit refuses the proposal), then the path, the line count and the short sha256 that the harness adds. It does not show the script body, and no reviewer or classifier reads it. The dialog lists approve first, then revise (with a note), then reject. That order is the owner's decision of 2026-11-11: the owner answers these dialogs on a phone, one tap, no second step. In the terminal the first row is preselected, so a stray Enter approves; the plan checkpoint keeps approve last. One notice before the choices holds the summary and, as its last line, whether the tool can undo the script (see Undo). It is one notice because the terminal replaces an info notice by the next one sent right after it, which would hide the description, risk and undo. Every foreman session may propose, also one opened by another session; a subagent child never (the tool is not registered there and refuses with `script_child`). No ruling file, no parent verdict and no timeout approves: without a UI, in print or json mode, or when the dialog is dismissed, the proposal stays pending and nothing runs. The dialog counts as the `script` family of `foreman_dialogs`.

The approval is tied to the script's bytes and lives in the session's memory only; nothing is written to the state directory, so a reload or restart drops it. If the file changes while the dialog is open, the proposal stays pending. One proposal per session: a new `propose` drops the earlier one and its approval, and `dry`, `run`, `status` and `undo` take no path.

**The run.** Only the harness starts the script. For every run it writes the approved bytes to a new private file (mode 0700, in a new temp dir), runs that file with POSIX `sh` (`/bin/sh`; on Windows Git Bash, never `cmd.exe`, else `no_posix_shell`) from the workspace root, and removes the file afterwards. The path in the scratch dir is never executed, so the script must not rely on `$0` or sibling files, and its shebang is ignored. The dry run gets `--dry-run` as its only argument and `DRY_RUN=1`; the real run gets neither. The foreman cannot add arguments or environment. The environment is the harness's own without the intercom identity; credentials stay. The run blocks the tool call; the limit is 600 s (`timeoutSeconds` up to 3600). On the limit, on an abort and after a normal exit the process group is killed. Output goes to `<scratch dir>/script-<name>-<hash8>-<dry|run|undo>-<n>.log` (the name keeps its `.sh`), where `n` counts per kind (dry-1, dry-2, run-1, undo-1) and a log is never overwritten. The tool result carries the exit code, the log path and the last lines.

**Undo.** A script that supports undo carries the whole line `# foreman-undo: supported`. The harness looks for it once, at propose, in the proposed text, and stores the result. Undo is allowed only when the line was in the proposed text and is in the bytes that really ran: a silent fix that removes the line ends the ability (`undo_no_marker`, `status` shows undo not available), one that adds it does not give it. `undo` runs the bytes of the latest real run (never the file on disk, never another session's proposal) with the single argument `undo` and no `DRY_RUN`, after any real run that started the script, whatever its exit. There is no second dialog; each attempt shows the owner a warning notice (name, short hash, attempt n of 3), writes a `script_run` trace record of kind `undo` and a log of kind `undo`. It exits 0 once and counts once; a failed undo may be retried, three attempts in all. It is available for 60 minutes after the real run. It is refused for a script without the marker (`undo_no_marker`), before a real run (`undo_not_run`), after it is done (`undo_done`), after three attempts (`undo_attempts`), after the hour (`undo_expired`), with no proposal (`undo_no_proposal`) and for a subagent child (`script_child`). After the hour, or after a new propose replaced the proposal, the way is a new propose.

**Status.** `status` prints a JSON report. After a real run that used the approval up it says `approvalUsed: true`, `attemptsLeft: 0`, the hash that ran (`ranHash`) and when (`ranAt`, ISO time); `hash` keeps its meaning, the hash of the proposed text, and `ranHash` is the hash of the bytes that ran. Its `undo` part shows `supported`, `available`, `used` and `attempts`; `availableUntil` appears only with undo supported and not yet used, and `attemptsLeft` only with undo supported (0 once used).

**The dry run is the script's own promise.** The harness only checks that the text contains `--dry-run` or `DRY_RUN` (a comment satisfies it); whether the script really changes nothing on that run is up to the script. On approve the dry run runs at once. A real run needs a dry run of the same bytes with exit 0. The foreman is told to read the dry-run output and, when it shows an unexpected state or a different change than described, to stop and propose again with a corrected description.

**Silent-fix bound.** When the script changed after approval, the harness measures the new text against the bytes the owner approved (never against the last fix, so fixes cannot add up): at most `safety.scripts.silentFixLines` changed lines (added plus removed in a minimal line diff, default 5; 0 turns it off; a project or session layer can only lower it) and at most 400 bytes in the added lines. Within the bound the new bytes run after a new dry run, and the owner gets a notice (the script name, the old and new short hash, the changed lines) and the trace a `script_fix` record. Outside it the call refuses with `script_changed` and the foreman proposes again.

**Expiry and attempts.** An approval covers dry runs, and real runs until one exits 0, at most 3 real attempts; then it is used up (`script_consumed`). It expires 60 minutes after the dialog (`script_expired`).

**Limits.**

- Standard input is closed and there is no terminal, so a prompt (a password prompt, `sudo`) fails.
- The secret redaction covers only the tool result; the log file in the scratch dir is not redacted.
- A process that detached itself from the script's process group outlives the run. On Windows nothing is killed after a normal exit (the tree kill needs a live root), only on the limit or an abort.
- A description that does not match the script is not detected. The owner approves a summary the foreman wrote; the hash ties the approval to the bytes, not to the description.
- Anyone who can write the scratch dir of the checkout can edit the script within the silent-fix bound; that edit then runs after a notice only, without a new dialog.
- The shell floors are unchanged: the same change through `bash` is still stopped, and the opaque-script gap described under [permissions](permissions.md#floors) stays open.

Trace records: `dialog` with surface `script`, `script` (decision, by, hash), `script_fix` (from, to, added, removed), `script_run` (kind dry, run or undo, hash, exit, seconds; attempts for undo).

## Further safety and runtime keys

Key-by-key layer rules for `safety.*`: `design/architecture.md`
[safety and loosening keys by layer](../design/architecture.md#safety-and-loosening-keys-by-layer).

| Key | Meaning and layer rule |
|---|---|
| `gate.*`, `permissions.profile` | The tool gate's keys (`safety.policy.files` and `gate.policy.userFile` are removed); the project layer may only tighten them. See [permissions](permissions.md#config-keys). |
| `safety.permissions.paths.deny`, `safety.permissions.paths.ask` | Path patterns tools and shell commands may never touch / need approval, on top of the baseline secret paths; a project can add entries only. |
| `safety.review.required` | Require a review before close-out; a project can only set true. |
| `safety.git.protectedBranches` | Branch patterns that never receive a force push, mirror push or delete from the foreman; a project can add entries only. |
| `safety.git.commit.messagePattern` | Regular expression the commit subject must match; `null` switches the check off; a project cannot set it. The pattern applies to foreman and child commits alike. A child's `-F` message file (R14) lies only under `<worktree>/.workflow/scratch/` or the child's own `$FOREMAN_SCRATCH` (by realpath; `.pi/` is the main session's dir and is refused); the message-file exemption from the write protection covers `git commit -F` only, and a child `git tag -F` under a protect rule is denied ([permissions](permissions.md#owned-paths)). A child whose message the guard cannot read is denied (the foreman is asked). `-F -` / `-F /dev/stdin` passes for a child only with a literal same-line heredoc, linted on its body; other stdin or computed sources are denied. Several `-F`, or `-F` with `-m`, count as unread. A child's `git commit -F <file>` is read only on an allowlisted line: the whole input at the top level with no substitution, group, heredoc, here-string, pipe, redirect, `\|\|` or `&`, made of an optional first `cd <dir in the worktree>`, any `git add` / `git status` / `git diff --cached` and exactly one `git commit -F <file>`; any other line with `-F` is a child deny (write the message file in an earlier command). A child's `git commit --amend --no-edit` is a deny with its own reason. The foreman is asked when a `-F` target is written, copied, moved or linked on the same line. |
| `safety.git.commit.requiredTrailers`, `safety.git.commit.forbiddenTrailers` | Regular expressions each required trailer line must match / no trailer line may match; a project can add entries only. |
| `safety.git.commit.checkCommand` | argv run before each foreman commit with the staged diff on stdin and the message in `PI_FOREMAN_COMMIT_MESSAGE`; a non-zero exit blocks the commit. |
| `safety.ops.copyMaxBytes` | Size cap for `foreman_copy`; a project can only lower it. The foreman's `foreman_copy` may also read from its own session handoff dir (into the workspace; the destination stays confined to it); children may not. |
| `safety.ops.worktreeDisposable` | Path components whose ignored files `foreman_worktree_remove` may delete (`name/` = a directory at any depth; an entry without a trailing `/` matches a file only, so write folder entries with a trailing `/`, and a folder entry covers everything inside the folder; a pattern with an inner `/`, like the default `.pi/tasks/`, is anchored at the worktree's top level). The defaults also cover `.DS_Store`, `Thumbs.db` and the caches of common Python and JavaScript tools (`.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.nox/`, `.coverage`, `.coverage.*`, `htmlcov/`, `*.egg-info/`, `*.tsbuildinfo`, `.eslintcache`, `.nyc_output/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.parcel-cache/`). Entries are globs matched against one path component. An entry belongs on the list only if a tool writes it, the next run rebuilds it and it never holds a person's work. A wholly ignored folder is walked file by file (symlinks are never followed) and the refusal `ignored_files (a, b, c, +N more)` names the first files. Not settable by a project. |
| `safety.ops.baseBranch` | Base branch for the merged check of `foreman_worktree_remove`; `null` = origin HEAD, else main, else master. |
| `safety.preconditionOps` | Settings container for the precondition-checked operations; a project cannot set it. |
| `safety.preBash.hooks`, `safety.preBash.strict` | Hooks run before each bash call and the strict switch; see [Pre-bash hooks](#pre-bash-hooks). A project or session cannot set them. |
| `intercom.allowRemote`, `intercom.allowOpenPane` | Allow remote intercom / opening a pane (both default `false`); a project or session can only set false. |
| `close.from` | Sources a close request is accepted from (default `herdr`, `intercom-parent`); a project or session can only narrow it. |
| `close.autoClean` | Remove manifest worktrees and scratch at close when the preconditions pass (default `true`); a project or session can only set false. See [close](close.md). |
| `close.worktreeDir` | Worktree root (default `../<repo>.worktrees`): relative, absolute or `~` with `<repo>`; it decides an owned read-write root; user or overlay config only. |
| `shell.msysNoPathconv` | Default `true`. On Windows it sets `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*` for the bash tool and `foreman_bg`, so Git Bash passes native paths and `/switch` arguments unchanged; `false` turns both off (a `/reload` removes them). No effect elsewhere. |
| `python.path` | Python 3.13+ interpreter; `null` auto-detects. It runs every guard, so a project or session value is ignored. |
| `trace.enabled`, `trace.dir` | The allowlisted trace and its directory. `trace.enabled` defaults to `null`, which follows the effective `retro.enabled` (on in tui and rpc, off in json and print); an explicit `true` or `false` wins, so `false` always turns it off. The directory (`null` = the state dir; a project or session value must resolve inside the workspace). |
