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
the worktree (the git top level of the cwd), a live `$FOREMAN_SCRATCH` dir of the asking role, or `/tmp` (not on
Windows). A path that starts with `~` or holds `=~` or `:~` (bash expands those too), holds a `..` component, is drive-relative (`C:x`) or resolves elsewhere
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
| `tmp-scratch` | one `cp`/`mkdir` writing only under `/tmp/`; every `cp` source a contained read (worktree, scratch dir, `/tmp`, read roots), a recursive source from the worktree only, lowercase `-r` on Linux only, into an existing dir each `dest/<name>` checked and no recursive copy |
| `child-scratch` | `cp`/`mkdir`/`rm`/`cd` inside a live `$FOREMAN_SCRATCH` dir of the asking role; the chain composer must allow the whole command too (every segment a deterministic allow, `cp` sources checked as reads, the earlier-write rule) |
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

## Known limits

The splitter and the classes work on the command string; they are not a sandbox. Git config in the repository
(`diff.external`, a pager) still applies to `git diff`/`git log`. Shell forms are POSIX; on Windows only forward-slash
paths are recognised, and `/tmp` never counts.

- `npm ci` and a bare `npm install` are build-test: they run the packages' lifecycle scripts and reach the registry.
- `make -n <test target>` is a read, but make still runs `+` recipe lines and `$(shell ...)` while it parses the Makefile.
- `cd <rel>` is resolved as `./<rel>`; an exported `CDPATH` can send it elsewhere.
- Paths are checked when the ask is reviewed, not when the command runs: another local user can swap a `/tmp` path
  for a symlink in between. The `tmp-scratch` allow has the same gap.
- `/tmp` counts as a read place (parent ruling). Every deterministic copy into it reads only from contained places,
  so it cannot carry an outside file there, but other programs' files in the shared `/tmp` (a Kerberos ticket cache
  `/tmp/krb5cc_<uid>`, another tool's temp files) are readable without a model call.
