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
| read | `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `tree`, `diff`, `grep`, `rg`, `find`; print-only sed; `git status/log/diff/show`; `git add/clean/mv/rm` with `-n`/`--dry-run`; `npm install/ci/publish/pack/... --dry-run`, `cargo publish --dry-run`, `make -n`; `cd` into an allowed place | no |
| build-test | the project's own commands, from its manifest at the worktree root, run from that root | no |
| write-in | `mkdir`, `touch`, `cp`, `mv`, `rm`, `tee`, `sed -i` with one plain `s///` script, the test restore | no |
| write-out | one of those writes, or a redirect, that reaches outside the allowed places | yes |
| unknown | everything else, and every command the chain splitter refuses | yes |

Paths. Every path argument (operands, `--opt=value` values, input redirects) of a read or a write must resolve inside
the worktree (the git top level of the cwd), a live `$FOREMAN_SCRATCH` dir of the asking role, or `/tmp` (not on
Windows). A path that starts with `~`, holds a `..` component, is drive-relative (`C:x`) or resolves elsewhere
(`/etc/passwd`, another absolute path) is outside, and the command goes to the model review. The realpath of the
nearest existing ancestor must stay inside too, so a symlink cannot lead out. The cwd a classified program runs in
must be such a place as well (`cd /etc && ls` goes to the model). Outside a git repository there is no
worktree; only the scratch dir and `/tmp` count.

Writes must lie strictly below an allowed place (never the worktree root itself) and never under `.git`. `rm` and `mv`
never count `/tmp` (as `tmp-scratch`: `rm -rf /tmp/...` stays reviewed). Allowed flags are fixed per program
(`cp -rRapfnv`, `rm -rRfdv`, `mkdir -pv`, `touch -acm`, `mv -fnv`, `tee -aip`); any other flag is unknown.

Read guards. `find` with `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint*`, `-fls`, `-L`/`-H`/`-follow`; `rg --pre`
or `--follow`; `grep -R`; `tree -o`; git global options (`git -c`, `git -C`); `git status/log/diff/show` with `-c`,
`--output`, `--ext-diff` or `--textconv` are unknown. `-n` counts as a dry run only for `git add/clean/mv/rm`:
`git commit -n` means `--no-verify` and is unknown.

Build-test, from the manifest only (no per-task list):

- `package.json` scripts `test`, `build`, `lint`: `npm test`, `npm run <script>`; also `npm ci` and a bare
  `npm install` (no package names, no `-g`);
- `Makefile` targets named `test*`: `make <target>`;
- `Cargo.toml`: `cargo test`, `cargo build`, `cargo clippy`, `cargo fmt --check`;
- `go.mod`: `go test`, `go build`, `go vet`;
- pytest config (`pytest.ini`, `tox.ini [pytest]`, `setup.cfg [tool:pytest]`, `pyproject.toml [tool.pytest]`):
  `pytest`, `python -m pytest`.

A build command that is not in the manifest is left to the permission rules (`safety.permissions.projectCommands`).

## Chains

`extensions/core-adapter/shellchain.ts` splits a command on top-level `&&`, `||`, `;` and `|`, quote-aware. The whole
command is refused (model review) when it holds `$(`, a backtick or a newline anywhere; an unquoted `(`, `)`, `{`, `}`,
`$`, `\`, glob, `!`, `#` or lone `&`; a heredoc or herestring; or a runner program in any segment (`eval`, `xargs`,
`sh`/`bash`/`zsh` and other shells, `env`, `sudo`, `nohup`, `nice`, `time`, `exec`, `source`, ...) or an `X=y` prefix.
`timeout N` is the only wrapper that is unwrapped, and only around an allowed segment.

Redirects go only to `/dev/null`, into a scratch dir (`$FOREMAN_SCRATCH` is expanded), or under `/tmp/`; fd dups
such as `2>&1` are fine. Every segment must then be allowed on its own: a deterministic label below, or a unit the
permission rules allow when the effect layer does not know the program (`echo`, `pwd`, `git blame`, ...). A `cd`
moves the cwd the later segments resolve against. A user's `ask` or `deny` pattern that catches the command or any
segment wins.

Examples that run without a model call: `sed -n '1,40p' f; grep -n x f`, `timeout 900 cargo test -p x | tail -50`,
`cd <worktree> && grep -rn x . | head`. Examples that go to the model: `ls | xargs rm`, `cat ~/.ssh/id_rsa`,
`cat /etc/passwd`, `ls > ~/x`, `find . -exec ...`, `git commit -n`.

## Deterministic labels

The `review` trace's `decision` is one of these when no model was called:

| Label | Allows |
|---|---|
| `tmp-scratch` | one `cp`/`mkdir` writing only under `/tmp/` |
| `child-scratch` | `cp`/`mkdir`/`rm`/`cd` inside a live `$FOREMAN_SCRATCH` dir of the asking role |
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
