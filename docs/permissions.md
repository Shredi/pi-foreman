# Permissions: effect classes and chains

> Covers how the review link decides a child's forwarded bash ask without a model call: effect classes, chain composition and the deterministic allow labels.
> Read it when a child command is reviewed or denied that you expected to run, or before you widen an allow.
> The overlay deny and protect rules and the git guard run first; nothing here can allow what they refuse.

## Where this applies

A child (subagent) bash command the permission system asks about is forwarded to the foreman's review link
(`foreman-review`, see [safety](safety.md)). Before any model call, the link tries a deterministic allow. It applies to
forwarded child asks only; the foreman's own asks go to the review model as before. The child runs in the foreman's
cwd, so relative paths resolve there.

The permission system forwards one unit of a chained command with the whole command as evidence. Every
deterministic allow must hold for that unit and for the full command.

## Shell tools that count as bash

`foreman_bg` (the foreman's detached run) and the optional background-tasks add-on's `bg_run` are shell tools: every overlay
deny/ask rule, the shell-write guard, the destructive guard and the git guard see their `command` as a bash command, and
`shellTools` in `config/permissions.baseline.json` maps both to the bash rules for the permission system (`commandArgument: command`,
the same alias `powershell` has). A missing or non-string `command` is denied.

The harness's own tools carry a tool-level `allow` in the baseline `tools` block, so the foreman gets no permission dialog (formerly
"not on the chair allow list, escalated") for `subagents_enable`, `bg_status`, `bg_logs`, `bg_kill`, `bg_wait` and the `foreman_*` tools.
`bg_run` and `foreman_bg` stay gated as bash above. Children keep their role's `tools` list, which holds none of them.

The add-on's own task output (`<repo>/.pi/tasks/<own session id>-<pid>/**`) is readable through the read tool and a strictly read-only
shell command (`cat`, `tail`, `grep`, ...) for the foreman and its children, although the write protection covers `.pi`; another
session's `<id>-<pid>` dir, a symlink or `..` leading out, and every write there stay protected. `/foreman waits` prints each task's
output file relative to the worktree (a `  log .pi/tasks/<id>-<pid>/<task>.output` line after the tail).

## Effect classes

`extensions/core-adapter/effects.ts` sorts a command by what it does:

| Class | What | Goes to the model |
|---|---|---|
| read | `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `tree`, `diff`, `grep`, `rg`, `find`; print-only sed; `git status/log/diff/show`; `git add/clean/mv/rm` with `-n`/`--dry-run`; `npm install/ci/update/... --dry-run` (not `publish`/`pack`), `make -n <test target>`; `cd` into an allowed place | no |
| build-test | the project's own commands, from its manifest at the worktree root, run from that root | no |
| write-in | `mkdir`, `touch`, `cp`, `mv`, `rm`, `tee`, `sed -i ''`/`-i<suffix>` with one plain `s///` script given by `-e`, the test restore | no |
| write-out | one of those writes, or a redirect, that reaches outside the allowed places | yes |
| unknown | everything else, and every command the chain splitter refuses | yes |

Paths. Every path argument (operands, `--opt=value` values, input redirects) of a read or a write must resolve inside
the worktree (the git top level of the cwd) or a live `$FOREMAN_SCRATCH` dir of the asking role; a write may also go
under `/tmp` (not on Windows), a read never does (the shared `/tmp` holds other programs' files). A path that starts with `~` or holds `=~` or `:~` (bash expands those too), holds a `..` component, is drive-relative (`C:x`) or resolves elsewhere
(`/etc/passwd`, another absolute path) is outside, and the command goes to the model review. The realpath of the
nearest existing ancestor must stay inside too, so a symlink cannot lead out. The cwd a classified program runs in
must be such a place as well (`cd /etc && ls` goes to the model). `cd` with no operand, an option or `-` (`cd`,
`cd -P`, `cd --`, `cd -`) or a `~` operand goes to `$HOME` or `$OLDPWD`: the whole command goes to the model. Outside a
git repository there is no worktree; only the scratch dir and `/tmp` count.

Read roots. `safety.permissions.readRoots` (list of dirs, default `[]`) adds places a read may reach: a read inside a
listed dir is a read too. `~` and `%USERPROFILE%` at the start mean the home dir; an empty, relative or missing entry is
dropped, and so is a filesystem root (`/`, a drive root `C:\`, a UNC share root `\\server\share`), the home dir
itself and any dir that contains it (`/Users`, `~/..`, `/private` when the home realpath lies below it), checked on the
path as written and on its realpath, case-folded on macOS and Windows (each would make every read below it deterministic). Each root is taken by its realpath and the realpath rule above applies, so a symlink inside a root cannot lead
out. Roots count for reads only: writes, `rm` and the build-test cwd stay in the worktree, scratch dir and `/tmp`. Only
the user and overlay config may set it; a project or session value is ignored with a warning. pi-foreman is generic and
must be safe without an overlay; an overlay adds e.g. the folder holding the user's repos.

Writes must lie strictly below an allowed place (never the worktree root itself) and never under `.git`; the `.git`
check runs on the path as written and again on the realpath of its nearest existing ancestor. On Windows a component
with a trailing dot or space (`.git.`) or an 8.3 short-name shape (`GIT~1`) counts as `.git`. `rm` and `mv`
never count `/tmp` (as `tmp-scratch`: `rm -rf /tmp/...` stays reviewed). Allowed flags are fixed per program
(`cp -Rapfnv`, `rm -rRfdv`, `mkdir -pv`, `touch -acm`, `mv -fnv`, `tee -aip`); any other flag is unknown. A recursive
`cp` (`-R`, `-a`) copies only from the worktree: `-R` and `-a` keep the symlinks of the source tree on GNU and BSD, and
`/tmp` is shared. A lowercase `cp -r` is unknown: BSD (macOS) `cp -r` follows every symlink in the tree.
For `cp` and `mv` the path really written is checked: a destination that is a symlink is write-out (cp writes through
it), and into an existing directory each `dest/<basename of source>` must be a contained write that is not a symlink
(a committed `d/f -> outside` makes `cp f d` write-out). A recursive `cp -R`/`-a` into an existing directory is unknown:
the tree below it is not walked.

`sed -i` is write-in only in a shape GNU and BSD (macOS) sed read the same way: `-i ''` (an empty separate word) or an
attached suffix (`-i.bak`, `--in-place[=suffix]`), the script given by `-e`/`--expression` as one plain `s///` (no `w`
or `e` flag, nothing after it), no option after the first file operand, and every file operand an existing regular
file (not a symlink) inside the allowed places with no blank in its name. A bare `-i` is unknown: BSD sed takes the next
word as the backup suffix and the word after it as the script (`sed -i 's/a/b/' 'w /x' f` writes `/x` on macOS). A
print-only sed with an option after its first operand is unknown too (BSD stops option parsing there, GNU does not).

Read guards. `find` with `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint*`, `-fls`, `-L`/`-H`/`-follow`; `rg --pre`
or `--follow`; `grep -R`; `diff -r`/`--recursive` (it follows symlinks below its operands); `tree -o`; git global
options (`git -c`, `git -C`); `git status/log/diff/show` with `-c`, `--output`, `--ext-diff` or `--textconv`; and any
option that names a program (`rg --hostname-bin`, `--*-command`, `--exec*`) are unknown. `-n`/`--dry-run` counts as a
dry run only for `git add/clean/mv/rm`, only before `--`, and only without a value-taking option (`-e`/`--exclude`,
`--chmod`, `--pathspec-from-file`, also abbreviated) that could take it as its value: `git clean -fdx -e -n` deletes.
`git commit -n` means `--no-verify` and is unknown.

Build-test, from the manifest only (no per-task list):

- `package.json` scripts `test`, `build`, `lint`: `npm test`, `npm run <script>`; also `npm ci` and a bare
  `npm install` (no package names, no `-g`);
- `Makefile` targets named `test*`: `make <target>`;
- `Cargo.toml`: `cargo test`, `cargo build`, `cargo clippy`, `cargo fmt --check`;
- `go.mod`: `go test`, `go build`, `go vet`;
- `make -n` (also `--dry-run`, `--just-print`, `--recon`) with `test*` targets only is a read, with no other option
  than `-s`/`--silent`, `-k`/`--keep-going` and `-j[N]`; any other option is unknown, also an abbreviated long one
  (GNU make takes `--eva=`, `--fil=`, `--dir=`); `--eval`/`-E` is unknown;
- pytest config (`pytest.ini`, `tox.ini [pytest]`, `setup.cfg [tool:pytest]`, `pyproject.toml [tool.pytest]`):
  `pytest`, `python -m pytest`.

A build command that is not in the manifest is left to the permission rules (`safety.permissions.projectCommands`).
After a `cd` that leaves the worktree root (`cd /x && npm test`, `cd src && make test-unit`) a build tool (`npm`,
`cargo`, `go`, `make`, `pytest`, `python`) is unknown and the rules do not allow it either. `cargo publish` is unknown,
`--dry-run` included (it runs `build.rs` and reaches the registry).
An `npm`, `cargo`, `go` or pytest command with an option that writes where it chooses or names a program goes to the
model, manifest or not: `-o`, `-exec`, `-toolexec`, `--basetemp`, `--junitxml`, `--target-dir`, `--out-dir`,
`--manifest-path`, `--prefix`, `--script-shell`, `--config`, `--cache`, profile outputs, `go vet -vettool`, pytest
`-o`/`-p`, and the like.

## Chains

`extensions/core-adapter/shellchain.ts` splits a command on top-level `&&`, `||`, `;` and `|`, quote-aware. The whole
command is refused (model review) when it holds `$(`, a backtick or a newline anywhere; an unquoted `(`, `)`, `{`, `}`,
`$`, `\`, glob, `!`, `#` or lone `&`; a heredoc or herestring; or a runner program in any segment (`eval`, `xargs`,
`sh`/`bash`/`zsh` and other shells, `env`, `sudo`, `nohup`, `nice`, `time`, `exec`, `source`, ...) or an `X=y` prefix.
`timeout N` is the only wrapper that is unwrapped, and only around an allowed segment.

Redirects go only to `/dev/null`, into a scratch dir (`$FOREMAN_SCRATCH` is expanded), or under `/tmp/`; fd dups
such as `2>&1` are fine. Every segment must then be allowed on its own: a deterministic label below, or a unit the
permission rules allow when the effect layer does not know the program (`echo`, `pwd`, `git blame`, ...). A `cd`
moves the cwd the later segments resolve against. A segment that names a path at or below a destination an earlier
segment wrote (a `cp`/`mv`/`ln`/`install`/`rsync` target, `tee` file or output redirect) goes to the model: the copy may
have planted a symlink there that the review-time check cannot see (`cp -R /tmp/pkg vendor && cat vendor/link`). A user's `ask` or `deny` pattern that catches the command or any
segment wins.

Examples that run without a model call: `sed -n '1,40p' f; grep -n x f`, `timeout 900 cargo test -p x | tail -50`,
`cd <worktree> && grep -rn x . | head`. Examples that go to the model: `ls | xargs rm`, `cat ~/.ssh/id_rsa`,
`cat /etc/passwd`, `ls > ~/x`, `find . -exec ...`, `git commit -n`.

## Deterministic labels

The `review` trace's `decision` is one of these when no model was called:

| Label | Allows |
|---|---|
| `tmp-scratch` | one `cp`/`mkdir` writing only under `/tmp/`; every `cp` source a contained read (worktree, scratch dir, read roots), a recursive source from the worktree only, lowercase `-r` on Linux only, into an existing dir each `dest/<name>` checked and no recursive copy |
| `child-scratch` | `cp`/`mkdir`/`rm`/`cd` inside a live `$FOREMAN_SCRATCH` dir of the asking role; the chain composer must allow the whole command too (every segment a deterministic allow, `cp` sources checked as reads, the earlier-write rule) |
| `own-handoff` | a chain segment `mkdir [-pv]`, `cp [-fpnv]` (no recursion), `cat [-n]` or `ls [-alh1d]` whose operands stay below this session's own handoff dirs (`parent`/`child` file matches, owned paths) or its round worktree: write operands (`mkdir` paths, the `cp` destination) contained there with symlinks resolved, never below `.git`, never a handoff dir's `parent` or `child` file; read operands the same or any contained read, a trailing `<dir>/*` accepted on a read; no redirects, `$`, `~` or `..`. Applies to a child's forwarded ask and to the foreman's own ask (without the model); every other segment of the chain must pass on its own |
| `timeout-wrapper` | `timeout N <allowed segment>` in the chain |
| `test-restore` | `git restore [--worktree\|-W] [--] <paths>` or `git checkout -- <paths>`, every path a relative test path (the `isTestPath` rule) inside the worktree, no `..`, no `--source`/`-s`/`--staged`, glob or `:` pathspec magic |
| `sed-read` | a print-only `sed -n '<addr>p' <file>` in the chain |
| `effect-write-in`, `effect-build-test`, `effect-read` | a chain whose segments are of those classes |

A chain takes the first label of the list above (after the scratch labels) that one of its segments carries. The git
guard still decides `git restore`/`git checkout` first (tracked, modified test files only).

## Traces

- `review {decision, model, class, ...}`: `class` is the effect class of the full command (bash asks).
- `chain_allow {segments, decision, role}`: a chain of two or more segments was allowed without the model.
- `review_defer_headless {role, cmd}`: a forwarded ask deferred with no human to ask and was denied.

## Owned paths

The foreman session owns a few places outside the workspace. Access to them is granted by default, in two layers:

1. **Policy grants** (permission system, "PS"). `foreman setup` renders `external_directory` (and
   `external_directory_read`) from the `externalDirectory` block of `config/permissions.baseline.json` into the one
   global policy file `<agentDir>/extensions/pi-permission-system/config.json`. `/foreman doctor` re-renders it with
   the same generator and reports drift. PS has no per-session or per-role scope, so these grants hold for every role
   of the user's pi processes. A review-link answer cannot grant them: PS turns an `allow` on the `external_directory`
   family into `defer`.
2. **Overlay narrowing** (adapter). The overlay can only block. For a child (path tools and shell operands alike) it
   denies: `handoffs/**` except `plan.md` and `result.md` (so `ruling.md` at any depth is the foreman's), the session's
   `subagent-artifacts`, `<agentDir>/foreman.json`, `<agentDir>/pi-foreman/claude-config/**` (credentials, also for
   reads), `*.worktrees/*` except below the child's own workspace root (sibling round worktrees), and
   `<tmp>/pi-foreman-scratch/**` except the asking child's own `$FOREMAN_SCRATCH` subtree (another child's dir). The
   operands of `git worktree remove` are left to PS, which asks. The `parent` and `child` handoff files and all
   write-protect rules keep asking or denying. A child's write permissions are therefore unchanged by this section.
   The baseline rows `npm ci` and `npm install` are per user like every policy grant, so PS would allow them to
   children too; the child layer narrows them: a child's `git fetch`, `npm ci`, `npm install` and `npm i` ask
   (`npm install` rewrites `package-lock.json` and `node_modules`), the foreman keeps the two npm rows. `npm ci` and
   `npm install` run the project's lifecycle scripts without a prompt for the foreman. Exception: a child whose cwd is
   its owned worktree root (a `roundRoots` entry, itself, not a subdir) runs a bare `npm ci` / `npm install` there unasked,
   with only `--no-audit`, `--no-fund`, `--ignore-scripts`, `--prefer-offline`, `--offline`, `--legacy-peer-deps`,
   `--no-progress`, `--silent`, `--loglevel=x` and a `--prefix` that names that root; `-g`, a foreign `--prefix`, a package
   name, any other option, a `cd`, another cwd, or a `git fetch` in the line ask as before. There is no `git fetch` row
   (`--upload-pack=<cmd>` runs code): a `git fetch` asks for every role.

The write-only protect rules (package root, `protect.ask`) are skipped for a shell command only when every unit is a
pure read-only verb and the command has no write redirect at all (any target but `/dev/null` and fd dups, so `> $f`
counts): a protected path named in an assignment (`f=...`) or a `for`/`select`/`case` list is still scanned and
protected as soon as a redirect could write through it; the skip covers only the minimal reader set `cat head tail wc grep egrep fgrep rg ls stat file diff cmp md5sum sha1sum sha256sum shasum` (plus `cd`, and `sed` when it provably only reads: see "Ask families of lane 2"), and a `$`, `${` or backtick in any argument of the unit (any quoting) loses the skip, so awk/gawk, sort, uniq, less, find, xargs, tee and interpreters keep full protection on protected operands whatever their flags; so a read of a protected file combined with any write redirect (e.g. `cat config/foreman.defaults.json > out.txt`) stays protected for children.

Heredoc bodies are scanned like any shell text (a `.pi` or `$x` in prose heredocs still trips the guards; write such text with the write tool).

| Pattern (`external_directory`, read and write) | Why |
|---|---|
| `<agentDir>/pi-foreman/handoffs/*` | the session's handoff dirs (plan, ruling, result) |
| `<agentDir>/sessions/*/subagent-artifacts[/*]` | child run artifacts |
| `*.worktrees[/*]` | the round worktree convention dir `../<repo>.worktrees/<branch>`. PS has no workspace-relative token, so the pattern is broader than one repo: any dir named `*.worktrees` |
| `<tmp>/pi-foreman-scratch[/*]` | the children's scratch root (`<realpath tmpdir>/pi-foreman-scratch`, as `childscratch.ts`). Per user: every child's dir, not only one's own; the overlay lets a child use only its own `$FOREMAN_SCRATCH` and denies the rest of the root |
| `<agentDir>/foreman.json`, `<agentDir>/settings.json` (bare keys) | reads, including a word in a `for f in ...; do cat "$f"; done` list (PS checks it in both directions). Writes still hit `protect.ask` |

| Pattern (`external_directory_read`) | Why |
|---|---|
| `<agentDir>/pi-foreman[/*]` | reads of the handoff, state and config files of pi-foreman |
| `<npm root -g>[/*]` | global packages, for bash reads (PS already allows the read tools there) |
| `externalDirectory.probe`, each `[/*]` | toolchain probes: `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin`, `~/.npm/_npx`, `~/.npm-global/bin`, `%APPDATA%/npm` (Windows only). `~` is the home dir at render time; an entry that does not resolve is dropped. Read keys only. The overlay narrows them for every role: only a shell line whose every unit is a plain `ls`, `stat` or `which` (no pipe into another command, no redirect, substitution, env or wrapper prefix) and the `ls` tool pass; any other command naming a path there, and the read/grep/find/write/edit tools, ask (a child: deny). A found binary run as the command word is left to PS's bash rules, which ask. After an update that adds this list, `/foreman doctor` reports drift until `foreman setup` is run again |

Last: `ask` for `<agentDir>/pi-foreman/handoffs/*/parent` and `.../child` stay on the write side (`protect.writeAsk`
asks too). Reads of those two files are allowed by the read pattern above.

`git worktree add|list|prune|lock|unlock|move|repair *` are in the global bash allow. PS has no main-session scope
(the main session has no agent file, and agent frontmatter overrides only apply to agents), so children are kept off
them by the git guard and the overlay, not by the policy. `git worktree remove *` asks.

**Global npm root, resolution order** (generator at setup time; `owned.ts` `resolveNpmRoot` in the adapter):
`npm root -g` (4 s cap), else `npm_config_prefix` (POSIX `<prefix>/lib/node_modules`, Windows
`<prefix>\node_modules`), else the prefix of the running node binary (POSIX) or `%AppData%\npm\node_modules`
(Windows). There is no environment override of the result; a root that does not resolve drops its patterns.
The policy is rendered when `foreman setup` runs: change the npm prefix, then run it again.

**Drift (R3b point 8c).** At session start the adapter compares the resolved root with the npm root the rendered policy
(`<agent dir>/extensions/pi-permission-system/config.json`) grants, its `<root>` and `<root>/*` read keys. When the policy
grants a different root, the session writes one `npm_root_drift` trace event and shows one warning
(`npm root drifted: run \`foreman setup\``, with both roots). A policy with no npm root grant (an open or unrendered
policy) stays silent. The adapter never rewrites the policy; reads under the
resolved root are asked until `foreman setup` re-renders it. Pi's permission system has no session-scoped grant for
this, so the warning is the whole mechanism. Children do not show the warning, but they write the trace event.

**Trade-off.** The patterns are static and per user, not per session. A second pi session of the same user can read
and write the first one's handoff dirs. Narrower grants would need PS to take the session id as a token.

**Session grants (`b`/`s` on an ask) and a directory that did not exist.** PS derives the session pattern from the
asked path (`deriveApprovalPatterns`, `src/path/approval-pattern.ts`): an existing directory yields `D` and `D/*`;
anything else (a file, or a path that does not exist when asked) yields its parent's `<parent>/*`. `D/*` does not match
the bare `D`. So a grant answered on a read of `<dir>/file` while `<dir>` did not exist is `<dir>/*`, and a later
`cd <dir> && npm ci` (token `<dir>`, no trailing slash) or a `ls <dir>` asks again. This lives inside PS; the adapter
records and compares no grants. Workaround: create the directory first, or answer the grant on the bash ask for the
directory itself. Owned paths above are not affected: the policy patterns carry the bare directory form too.

### Variables in bash lines

A session grant for a directory covers a bash line that names a path under it through a variable
(`D=<dir>/x; mkdir -p $D`, `mkdir -p $FOREMAN_SCRATCH/x`). The adapter (`extensions/core-adapter/shellvars.ts`
`resolveVars`, used by the path collection in `permoverlay.ts`) replaces `$NAME` / `${NAME}` in a word by its value
only when the whole line is inside a CLOSED GRAMMAR (the same in both implementations, pinned by
`tests/fixtures/shellvars-grammar.json`). A line is eligible only if EVERY statement is one of:

- (a) a sole assignment `NAME=literal`: the literal is a plain path of letters, digits and `/ . _ - ~`, starting with `/`,
  `~` or a `$FOREMAN_SCRATCH` / `$HOME` prefix (only an absolute value, or the harness `$FOREMAN_SCRATCH`, is certain;
  the rest stays unresolved). `NAME` is not `IFS`, `HOME` or `FOREMAN_*` (a `FOREMAN_*` name comes from the harness
  env, never from the line). It stands at the start of the line or after `;` / a newline, or after `&&` that follows
  another assignment: a conditional assignment (`cmd && D=/a`, `cmd || D=/a`) makes the line ineligible.
- (b) a simple command whose first word is one of `cd mkdir cp mv cat ls tee touch tar node npm npx python3 git test echo
  true` and whose other words are plain words (letters, digits and `/ . _ ~ = : @ % + , -`), `$NAME`, `"$NAME"` or
  `${NAME}` (also inside a word), `2>&1`, `>/dev/null`, or `>` / `>>` with one such plain word.

Statements are split on `;`, `&&`, `||` and newline only. A line holding `|`, `&` (other than `&&`), `(`, `)`, `{`,
`}`, `[`, `]`, a backtick, `#`, `<`, `>` outside those redirects, `$(`, `${` with anything but a bare name, a backslash
or a single quote is ineligible, as is any statement outside (a) and (b) (`export`, `read`, `declare -n`, `printf -v`,
`exec {H}>`, `coproc`, `for`, `if`, `case`, `eval`, `trap`, ...). An eligible line resolves a later `$NAME` with the last
assignment before it; a name nothing assigns stays as written. An ineligible line resolves nothing and everything
asks as before: the word is checked as written.

Two forms extend this (ledger item 7d). `cd <literal>` (one plain operand, no option) updates the tracked cwd, which
starts as the directory the line runs in; `NAME=$PWD` / `NAME=$PWD/sub` takes it (an unknown cwd leaves `NAME`
unresolved, and `$PWD` anywhere but an assignment value keeps the line ineligible). `NAME=$FOREMAN_SCRATCH[/sub]` and
`NAME=<literal under an owned dir>` resolve for every later `$NAME` / `"$NAME/…"` operand and redirect in the line, so
`cd <round worktree>; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt` never asks. A heredoc opener (`<<EOF`,
unquoted, a word of its own) ends the checked text at its line: `S=$FOREMAN_SCRATCH; python3 - "$S/probe.test.ts" <<EOF`
resolves `$S`, but the line keeps its class (an interpreter reading a heredoc is still reviewed or asked as before);
the body and what follows the heredoc resolve nothing. Cases in `tests/fixtures/shellvars-cases.json`, read by both
implementations.

The foreman's shell write guard (`scripts/shell_write_guard.py`, `grammar_statements`) applies the same grammar.

### Split literals

The git guard (`scripts/git_guard.py`, also for the main role) denies, never asks, a bash line whose quoted, ANSI-C or
escaped pieces of one word (`'.g''it'`, `$'.'"git"`) or whose `"a"+"b"+…` literal chain (also inside `python3 -c`, `node
-e` code or a heredoc body) spell a guarded path component (`.git`, `.git.`, `GIT~1`, any case) that no single piece
spells; the reason is `split literal reassembles a guarded token`. A plain `.git`, `.github`, `'.gi'` alone and
`"a"+"b"` are not affected. The adapter starts the guard in the main role for such lines too (`mainNeedsGitGuard`).

For a child (R6 lane 1c) the guard also denies string-literal fragments joined by `+`, `..`, `.concat(…)`, `[…].join(…)`
or `.replace(All)` whose reassembly is a whole guarded command token that no single fragment spells: `rm`, `dd`,
`truncate`, `mkfs`, `shred`, `cd`, `git` (so `git clean`), `push --force`, `reset --hard`, `checkout --`; same reason text.
Words that merely contain them (`format`, `perm`, `add`), `git add`, a token written whole in one literal and unsplit
`echo rm …` are not affected. `>` of a tracked file stays on the redirect guard. Cases: `tests/fixtures/split-literal-cases.json`,
read by `tests/test_git_guard_split_literal.py` and `gitguard-split.test.ts` (`splitliteral.ts` mirrors the Python).

### Read-only children run only tracked code (R6 lane 1)

Besides the script rule above, a test run of a child that may only read its cwd (round worktree) names only operands
that resolve, symlinks followed, inside the round worktree and are git-tracked: positional paths of `node --test`,
`pytest`, `python3 -m pytest|unittest` (a dotted module is its tracked `.py`), every positional of `npm test|run <script>` (with or
without `--`), values of the module-loading options `--require`/`-r`/`--import`/`--loader`/`--test-reporter`/
`--test-reporter-destination`/`--test-global-setup` (built-in reporter names and `stdout`/`stderr` stay allowed) and of
`-C`/`-f`/`-I`/`-s`/`-t`/`-c` and similar, also attached (`make test -C/x`, `--directory=`, `--file=`). A `make` `K=V`
word is no operand; its value is checked only when it contains a `/`. A pytest `-p` value is a plugin name, not a path. A glob is
allowed iff every file it matches is tracked inside the worktree (`**` and `{}` are denied). A word with `$VAR`, `${VAR}`, `$(…)`, a
backtick or a leading `~` is expanded (`$FOREMAN_SCRATCH`, `$HOME`, `~`) and then checked like any path operand; one that cannot be
expanded is denied (a plain unknown word such as a test name is fine). Only the `make` long options `--keep-going`, `--jobs[=N]`,
`--silent`, `--quiet`, `--always-make`, `--print-directory`, `--no-print-directory`, `--dry-run`, `--ignore-errors` and similar pass;
any other (or abbreviated) one is denied. Untracked paths are denied with a reason. A builder in its own worktree may run its own new untracked test.

`git config` is a read only as `git config <key>`, `get`/`list`, `--get|--get-all|--get-regexp <key> [<re>]`,
`--get-urlmatch <name> <url>` or `--list`/`-l`, with `--local --worktree --global --system --includes --no-includes -z
--null --show-origin --show-scope --name-only --type=<t> --bool --int --bool-or-int --path --expiry-date --default <v>`.
`--file`/`-f`, `--blob`, `set`, `unset`, `--add`, `--unset*`, `--replace-all`, `--rename-section`, `--remove-section`,
`--edit` and two operands without a `--get*` mode are writes and are denied for a role without write roots (also with `--global`/`--system`, from any cwd).

Probe-file scan: for a child of any role, a script run with `node`, `python`, `python3`, `bash`, `sh` or `npx` from a path
that is not git-tracked in a round worktree (scratch, `$FOREMAN_SCRATCH`, tmp, an untracked file) is read before it
runs (every word of the command is looked at, not only the first positional); a directory operand there (`node $FOREMAN_SCRATCH`,
`python3 <dir>`, `python3 -m pkg`) would run `index.js`, the `package.json` main or `__main__.py` unscanned and is denied
(`runs an untracked directory`) unless it is inside a round worktree and tracked-clean; one that reassembles a guarded token from fragments (above), `String.fromCharCode(…)` or a base64 literal that
decodes to one is denied. Files of the round worktree that are tracked in HEAD and unmodified against it (a staged or
modified one is scanned) are not read. `npx tsx|node|ts-node|python3|bash <file>` and `<interp> < file` stdin files are scanned
like a named script. Known limit: modules a scanned script imports are not read. A script path held in a variable other than
`$FOREMAN_SCRATCH` is not resolved.

### Hub ledger read

`paths.hubWorkflow` (a string or a list of absolute dirs, default none; user or overlay config only, a project or session
value is ignored with a warning) names hub checkouts whose `.workflow/` path family (the dir and everything below) is
readable, read-only, for the foreman and its children in a round worktree: the read tool and read-only bash, no dialog,
and the rendered `external_directory_read` carries the two patterns, so no ask either. Writes stay denied. A sibling
that is not configured is handled as before. Relative entries, `..` components and a filesystem root are dropped.

### Round surfaces

What the foreman session owns for the length of a round is one shared set (`roundsurface.ts`, ledger items 7c, 7e),
the same for the foreman and every child it launches, and nothing else is inherited session-wide:

- **Handoff dir.** The session's own handoff dirs (`ownHandoffDirs`), as before; the `own-handoff` deterministic allow
  and the child overlay use them.
- **Round worktree, from the manifest.** The unremoved `worktree` entries the foreman session itself recorded in its
  manifest (`<agentDir>/pi-foreman/state/sessions/<id>/manifest.json`, owner = the session id, never a child's). Every
  child of the round may read it; only the foreman and the `builder` child whose cwd is in it write it. A child of any
  other role (explorer, reviewer, senior-reviewer, finalizer, planner) gets it read-only: reads pass, writes are denied
  (path tools, bash redirects, `mkdir`, `cp`), and a forwarded ask of such a child gets no own-dir allow there. A child in
  an isolation worktree of the round may read the round worktree and never writes it. Other round worktrees stay denied.
  The child's scratch dir stays writable.
- **Own isolation worktree only.** The isolation worktrees pi-subagents makes under
  `<repo>.worktrees/worktrees/<round>/pi-worktree-*` are not a root as a set. A child whose cwd is in one of them owns
  that isolation worktree (its git top level), whatever its role, and nothing else of the dir; a sibling child's `pi-worktree-*` stays denied
  for the path tools and bash redirects (`*.worktrees/*`), and a child in the round worktree cannot reach them at all.
- **Bound ledger as read root.** The ledger file bound to the session is a read root for every forwarded ask, and
  `LEDGER-*.md` in its dir is a readable glob. Read only.
- **Round worktree add by the foreman.** The foreman's own `git [-C <main>] worktree add <repo>.worktrees/<round> [-b
  <round>] [<base>]` is allowed without a question (label `round-worktree`); a child's `git worktree` stays denied, and
  `git worktree remove` still asks.
- **Isolation worktree as the child's own root.** The worktree pi-subagents makes for a child
  (`<repo>.worktrees/worktrees/<round>/pi-worktree-*`) is that child's own workspace root; its writes there follow the
  normal child rules.

### Ask families of lane 2 (R6)

- **Owned roots in the reviewer prompt (2a).** The permission reviewer's request lists the roots the foreman session owns under
  "Owned roots (owned — allow reads and writes)": its live child scratch dirs, the round worktrees and their isolation dirs (read-write
  only for the main session and the builder; read only for any other forwarded child), its handoff dirs and `state/scratch/<session>`.
  The global npm root and the pi-subagents async run dirs of its OWN child runs are listed apart as "owned, read only": reads below
  them count, a write never does and stays a defer (`roundsurface.ts` `sessionOwnedSplit`). A model `defer` (never a deny, never a soft-deny) for a bash command is turned into an
  allow (label `owned-roots`) only when the effect layer, with the read-write roots added as scratch dirs and the read only roots as read roots, finds EVERY path operand and write
  target inside the workspace, scratch or an owned root, and no ask or deny rule catches the command. /tmp does not count as owned here;
  one non-owned write target (also under /tmp) keeps the defer.
- **The `*` path rule matches path operands only (2b).** A catch-all `*` deny does not fire on a word of command prose or on a sed
  expression (`sed 's/=.*//'`), and never denies a READ below an owned root (the scratch dir, the round roots, the ledger and handoff
  read roots). A more specific rule (a secret inside an owned root) still denies. The prose exemption applies only to a word that is not a
  write target: a write target (a redirect target, `tee`/`cp`/`touch` operand) and the path of the `write` / `edit` tools are always path
  operands, so a `*` deny still matches them even with white space in the name.
- **sed as a reader (2b).** `sed` skips the protected-file write ask only without `-i`/`--in-place`, `-f`/`--file`,
  and with a script that has no `w`/`W`/`r`/`R`/`e`/`a`/`i`/`c` command and no `s///w` or `s///e` flag. Inline `python -c` is never a
  reader: a blocklist cannot classify python as read-only, so inline python over the state dir or any protected file still asks (fail
  closed). awk is not a protected reader.
- **`../x` after `cd` (2c).** A relative word with `..` that follows `cd <dir> &&` (or `;`) resolves from the cd'd directory, not the
  session cwd. A cd that may not run first (`||`, a missing directory, a `$` or glob in the target) does not move the base.
- **State dir reads (2d).** Only reads of `<agent dir>/pi-foreman/state` lose the protected-configuration ask; writes there still ask.
- **`git apply` and `patch` (2e).** They read the patch file and write the cwd worktree: a patch under `<main>/.workflow/scratch/` or
  the child's own scratch applied inside an owned worktree does not ask; in a worktree the child does not own it is as closed as any
  other write; for a read-only child it stays a write (denied). `git apply --check|--stat|--numstat|--summary` writes nothing.
- **Ledger and handoff read roots (2f).** The bound round ledger, its `LEDGER-*.md` siblings, the session's own handoff dirs and its
  round worktrees are readable for every child (`MatchCtx.readable`, `roundsurface.ts` `childReadable`); a write there stays closed.
- **Nested worktree ownership (2-I).** Ownership is the innermost git worktree of the cwd: an isolation worktree nested below a
  round worktree is its own root and the round worktree is not.
- **Directory operands (2-0).** A directory operand of a test run inside the round roots is scanned file by file.
- **Session-wide grants (2g).** The review link is keyed by the foreman session, so an answer it gives holds for every fresh reviewer
  child of that session. A grant of the permission system itself ("approve for this session") lives in
  `@gotgenes/pi-permission-system`, which the adapter does not own: its default scope is the asking subagent only, and the adapter
  cannot make it session-wide. Limit: a second reviewer child is asked again unless the user chose the "whole serving session" scope.
- **The backtick over-block is deliberate.** A backtick in a read-only child's test-run line is refused even when it would be harmless:
  it cannot be expanded and checked, so the line fails closed.

### Search patterns are not paths

The patterns of `grep`, `egrep`, `fgrep`, `rg` and `git grep` are never path operands, in any role (read, write,
external directory): `-e <re>`, the word after `--` when no `-e` is given, the bare first operand, the pattern in a
cluster such as `-nE "<re>"`, and the separate values of their other options (`-A 3`, `-m 5`, `--glob <g>`, `-t <type>`).
A regex that looks like an absolute path therefore raises no external-path ask. Options that read a file keep their
value as a path word: `-f`, `--file`, `--exclude-from`, `--ignore-file`, `--pre`. The remaining operands are paths
as before.

### Known limit: the permission system package

The permission system package (`node_modules/@gotgenes/pi-permission-system`) runs its own path extraction before the
adapter. Its `shell-variable-expansion.ts` resolves only `HOME` and `PWD`, so `D=<dir>/x; mkdir -p $D` can still raise
an `external_directory` ask there even when the adapter resolved the variable. Its `token-collection.ts` has
pattern-first handling for `grep`/`egrep`/`fgrep`/`rg` but not for `git grep`, so a `git grep` pattern that looks like
a path can still ask. A review-link answer cannot grant external-directory asks (see "Policy grants" above). A
change on the package side is a separate round.

## Developing pi-foreman itself

When the session's working directory is the package root or inside it (symlinks resolved; case-insensitive on
Windows and macOS), the baseline's `protect.writeAsk` entries for `{pkgRoot}` and `{pkgRoot}/*` are replaced by
`protect.writeAskSelfHost`: only `config/permissions*.json`, `config/foreman.defaults.json` and `package.json`
under the package root still ask in the main session and are denied to children. Other writes in the checkout (docs,
extensions, tests, scripts) pass. The child ban on naming a protected path in a shell narrows the same way, to these
three paths. Every other protect list is unchanged (`.git`, agent dir, `.pi`, handoffs). The session writes a `protect_selfhost` trace event and a top
session shows one notice: "pi-foreman: dev checkout: package-root write protection narrowed".

## Known limits

The splitter and the classes work on the command string; they are not a sandbox. Git config in the repository
(`diff.external`, a pager) still applies to `git diff`/`git log`. Shell forms are POSIX; on Windows only forward-slash
paths are recognised, and `/tmp` never counts.

- `npm ci` and a bare `npm install` are build-test: they run the packages' lifecycle scripts and reach the registry.
- `make -n <test target>` is a read, but make still runs `+` recipe lines and `$(shell ...)` while it parses the Makefile.
- `cd <rel>` is resolved as `./<rel>`; an exported `CDPATH` can send it elsewhere.
- Paths are checked when the ask is reviewed, not when the command runs: another local user can swap a `/tmp` path
  for a symlink in between. The `tmp-scratch` allow has the same gap.
- `/tmp` counts for writes only. Reads under `/tmp` go to the model review: the shared `/tmp` holds other programs'
  files, such as a Kerberos ticket cache `/tmp/krb5cc_<uid>`. Children read their own files through `$FOREMAN_SCRATCH`.
