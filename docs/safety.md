# Safety and permissions

> Covers the shell-write guard, git guard, PR gate, permission baseline with model auto-review, child environment stripping, bridge isolation and the known `/sync` limit.
> Read it when a command is refused or asked about, or before you loosen a rule.
> A project file can only tighten these rules; the scanners work on command strings and are not a sandbox.

## Shell-write guard

Shell writes into project files (redirects, `tee`, `sed -i`, writing scripts) are refused for the foreman at every tier; `.workflow/` (and the scratch dir in `scratchpad` mode) stays open. The scanner works on the command string and is not a sandbox; known blind spots are listed in `design/architecture.md` [section 5](../design/architecture.md#5-safety-policy). The destructive and secret guard runs on `bash`/`powershell` for the foreman and its children.

## Git guard and PR gate

`scripts/git_guard.py` lints commits and pushes (own lexer for bash, PowerShell and cmd): the foreman's commit lint, push lint (no force, mirror, delete or `+refspec` on protected branches) and the limits for children, who never open PRs and may not push unless `safety.children.mayPush` allows it. A PR (`gh pr create`, `glab mr create`, `hub pull-request`, `tea pr create`, a push with merge-request options or to `refs/for/*`) is refused unless a reviewer PASS was recorded for the current head, which is the checkout the reviewer ran in (`ceremony.reviewBeforePr`; a project or session cannot turn it off). A later commit, a finalizer's included, makes the review stale, so for heavy tasks the order is builder, finalizer, reviewer, PR, or review twice. Outside a repository the head is unknown and no PR goes through. Children never open PRs.

## Permission baseline and auto-review

The installer generates the permission-system config from `config/permissions.baseline.json` plus
`safety.permissions` (user and overlay layers; a project file may only add `deny` and `ask` entries) and owns that
file: a hand edit is backed up and overwritten, so put your rules into `foreman.json`. The baseline has no `sed`
rule (no glob separates a print from `1wout` or `1etouch x`, so every sed asks).

Asks go through a model review link (`foreman-review`) using `providers.<p>.review.model` (see
[roles](roles.md) for the automatic pick). Child asks are forwarded to it:

- The review prompt treats read-only inspection (also chained) as allowed; it defers only for writes outside the
  workspace, network or destructive steps.
- The review link allows a forwarded child ask without a model call when it holds a print-only sed
  (`sed -n '<addr>p' <file>`: no s/w/e/r commands, no -i/-f; trace label `sed-read`) or `timeout N <allowed
  command>` and every other unit is allowed (PS floors wrappers).
- Headless defer: with no UI, or `review.headless: true` (default false), a forwarded child ask is denied with a
  text naming the allowed forms, trace `review_defer_headless {role, cmd}`. The `review` trace carries the model's
  defer `reason`.
- Review model calls are logged to the usage log with role `autoreview`.

## Child environment and extensions

Subagent children get a stripped environment: `childenv.ts` removes the intercom identity variables, so a child
cannot pose as its parent session (see [sessions](sessions.md)). Required child extensions
(`safety.requiredChildExtensions`) load the guards into every child; a project file may only add entries.

## Bridge isolation

With the Claude bridge, `CLAUDE_CONFIG_DIR` points at an empty folder so the host's Claude Code settings, hooks,
plugins and `CLAUDE.md` do not load into bridge turns (`bridge.isolateClaudeConfig`; a project file cannot set it).
Login steps are in [install](install.md). Rationale: `design/architecture.md`
[bridge isolation](../design/architecture.md#bridge-isolation).

## Known limit: `/sync`

`/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config (see [sessions](sessions.md)). It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. **Known limit:** a child agent or other code running as your user can plant repository state (config, remotes, commits) between syncs; /sync refuses every planted state it knows (git's local file transport is off, remote names must be plain names), but it is not a boundary against such code. List only repositories you trust children not to touch.

Key-by-key layer rules for `safety.*`: `design/architecture.md`
[safety and loosening keys by layer](../design/architecture.md#safety-and-loosening-keys-by-layer).
