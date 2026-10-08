# pi-foreman

A generic orchestration harness for the [pi coding agent](https://pi.dev). It is planned to ship Pi extensions (TypeScript), agent roles, skills and a Python core (requirements ledger, guards) together with an installer.

**Status:** early, design phase.

## Install

Needs Node 22+, Pi 1.0.x on `PATH` and Python 3.9+. From a checkout of this repo:

```sh
node setup.mjs --dry-run   # show the planned diff and `pi install` commands, write nothing
node setup.mjs             # install into the user-level Pi agent dir
node setup.mjs --project   # install project-locally (.pi/settings.json)
node setup.mjs --remove    # remove only what the installer manages
```

Options: `--overlay npm:<pkg>@<exact-version>` installs an organisation overlay (ranges are refused),
`--agent-dir <dir>` overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`, `--no-intercom` skips `pi-intercom`
(installed by default, see below). Project packages load only after
the project is trusted; headless runs need `pi --approve`. A second run changes nothing and says "up to date".

The installer installs `pi-subagents` (pinned in `packages.lock.json`) and registers this checkout with
`pi install <path>`. The permission packages are pinned but installed from Phase 3. It writes the generated
`subagents` block into `settings.json` (backup `settings.json.bak-<timestamp>` first) and creates
`<agent dir>/foreman.json` only if absent. Unless `--no-intercom`, it installs `pi-intercom` (pinned) and
writes `<agent dir>/intercom/config.json` (`{"inboundTrigger":"always","busyDelivery":"human-first"}`) only if
absent; an existing file that sets `brokerCommand`, `brokerArgs` or `crossMachine` gets a warning. Map each provider you use to models there:

```json
{
  "version": 1,
  "providers": {
    "my-provider": {
      "roles": {
        "foreman": { "model": "my-provider/big-model", "thinking": "high" },
        "builder": { "model": "my-provider/mid-model", "thinking": "medium" }
      }
    }
  }
}
```

Then re-run `node setup.mjs` to regenerate the block, and run `/foreman doctor` in Pi. Tests:
`node --test "tests/installer/*.test.mjs"`.

### Claude bridge: log in once

When the active provider is `claude-bridge`, pi-foreman points `CLAUDE_CONFIG_DIR` at an empty folder,
`<agent dir>/pi-foreman/claude-config/`, so the host's Claude Code settings, hooks, plugins and
`CLAUDE.md` do not load into every bridge turn (config key `bridge.isolateClaudeConfig`: `"auto"` by
default, `true`, or `false`; a project file cannot set it). The folder starts without a login, and the
installer does not log in. Do one of these once:

```sh
CLAUDE_CONFIG_DIR=<agent dir>/pi-foreman/claude-config claude    # then /login
claude setup-token                                                 # then export CLAUDE_CODE_OAUTH_TOKEN
```

`/foreman doctor` fails if the folder holds host config and reports whether a login is present
(never its value).

## Commands

In a Pi session (the foreman, not children):

- `/sync` pulls, commits (explicit paths only) and pushes the repositories listed in `sync.repos` of your user config, then runs the retro. It never forces a push, runs no repository hooks and refuses a repo whose local config sets any key outside a short allowlist of harmless keys (so filters, hooks, ssh/credential helpers, url rewrites, `http.*`, submodules and similar are refused), or that holds a secret or a linked file. Remote urls must be https, ssh, git or scp-like (local paths, `file://` and helper transports are refused); submodule gitlinks are ignored and refused; the config is re-checked before commit and push. It is refused while a child run of this session is still active. It does nothing until you list repositories in `sync.repos` of your user or overlay config (a project or session cannot). **Known limit:** a child agent or other code running as your user can plant repository state (config, remotes, commits) between syncs; /sync refuses every planted state it knows (git's local file transport is off, remote names must be plain names), but it is not a boundary against such code. List only repositories you trust children not to touch.
- `/retro` prints friction metrics of the session and writes permission-allow proposals (never for commands that run code, such as interpreters, wrappers, runners, eval, ssh or git config, nor for commands naming a protected path) to `<agent dir>/pi-foreman/state/retro/`; nothing is applied for you.
- `/foreman close [result-path]` ends the session cleanly: result file, sync, exit. It is refused while a long wait is pending or a child run is still active (nothing is cancelled). A parent can send the same request with `herdr agent prompt` or, from its own session id, as an intercom message `foreman:close` (also to an idle session).
- `/foreman update-check` lists newer versions of the pinned packages with release-note links. It changes nothing.

The usage footer (tokens, list-price cost, child launches) is on by default (`footer.usage`). Outside Pi,
`bin/foreman update-check|retro|sync [args]` (`.cmd` and `.ps1` on Windows) runs the same scripts. Keys and
their layer rules are in `design/architecture.md` §7.

## Triage and delegation

The foreman records a tier (trivial, standard, heavy) before it changes files itself, and the adapter checks the claim instead of trusting it:

- In `bounded` mode, at trivial the foreman may change at most `ceremony.trivialBound` itself (default 2 files, 40 changed lines, no new file). The call that would cross it is refused, the tier rises to standard and a builder does the rest. A project or session can only lower the bound.
- Shell writes into project files (redirects, `tee`, `sed -i`, writing scripts) are refused for the foreman at every tier; `.workflow/` (and the scratch dir in `scratchpad` mode) stays open. The scanner works on the command string and is not a sandbox; known blind spots are listed in `design/architecture.md` §5.
- Standard needs a completed builder run and a reviewer verdict before the foreman may finish, heavy also a finalizer (`ceremony.required`, a project can only add steps). A refused finish names what is missing; after two refusals per prompt it passes with a visible warning.
- The foreman's own edits follow `ceremony.foremanEdits`; a PR needs a reviewer PASS on the current head (`ceremony.reviewBeforePr`). In `readonly` and `scratchpad` mode the foreman never changes project files itself, so a refused edit makes the task standard and a builder does the work. The scratch dir is for notes, drafts, commit messages and review pages. `.workflow/` stays writable in every mode, because the harness keeps the ledger and state there. A PR (`gh pr create`, `glab mr create`, `hub pull-request`, `tea pr create`, a push with merge-request options or to `refs/for/*`) is refused unless a reviewer PASS was recorded for the current head, which is the checkout the reviewer ran in. A later commit, a finalizer's included, makes the review stale, so for heavy tasks the order is builder, finalizer, reviewer, PR, or review twice. Outside a repository the head is unknown and no PR goes through. Children never open PRs.
- Plans: heavy runs ledger, `planner`, `foreman_checkpoint`, builder(s), finalizer, reviewer, PR. `planner` is a role (read-only tools plus `write`/`edit` limited to `.workflow/` and the scratch dir, never outside the workspace, single launch only). `foreman_checkpoint(path)` shows the plan `plan-<topic>.md` to the owner (revise, reject, approve; approve is never preselected) and records the approved hash, only if the file is unchanged when the owner answers; it is refused while a planner run is active; a heavy `builder` launch is refused until the current bytes are approved (`plan_required`, `checkpoint_pending`, `plan_changed`). The harness never approves on its own: print/json mode or a dismissed dialog leaves the checkpoint pending, and it never turns a timeout into approval. A rejected plan blocks the finish (the two-refusal valve ends the session visibly, never approving). Standard writes its own short plan to the scratch dir; no checkpoint. Plan mode is not part of the ceremony; the checkpoint is. A `subagent` launch with `output` or `outputMode` is refused for every role (`launch_refused:output_path`: the runner would write the reply to a file without a write check), and with `safety.subagents.allowWorkflow` on, workflow and `schedule.*` calls are still refused at heavy (`unchecked_heavy`).
- With `ceremony.launchWait` on (default `block`) a foreman launch returns when the child finishes, any child asks the foreman something, or `wait.maxSeconds` (or the role's `timeoutMinutes` plus 60 s, when shorter) passes, so no `bg_wait` turn is needed; every launch of one message is held in parallel, a launch from inside codemode never. A completion notice for a run already delivered that way is shortened to a stub (`ceremony.dedupeNotify`). `bg_wait` stays for a child the result says is still running; the trace and the bench table count polling bash calls (`pollBash`).
- Read budgets: the foreman's own read-class calls (`bash`, `read`, `grep`, `find`, `ls`, `codemode`; one codemode script counts once) warn and then are refused past `ceremony.foremanReads` until a fresh explorer launch has started (not a resume; once per phase; a second refusal needs the user's `/foreman budget lift`). The count resets to phase `before` with each user prompt. After a reviewer PASS only `ceremony.recheckBudget` own checks are allowed, then the foreman is told to finish; that budget resets on a reviewer FAIL, a builder launch, a foreman change of a project file after the PASS (not `.workflow/` or scratch notes), or a new user prompt. `foreman_triage` and the system prompt state the required finish steps up front.

| Key | Default | Direction |
|---|---|---|
| `ceremony.foremanEdits` | `scratchpad` (`readonly`, `scratchpad`, `bounded`) | project/session can only move toward `readonly` |
| `ceremony.scratchDir` | `.workflow/scratch` | project/session can only narrow it to a subpath |
| `ceremony.reviewBeforePr` | `true` | project/session cannot turn it off |
| `ceremony.foremanReads.<before\|after>.<warn\|deny>` | before 4/8, after 4/8 | project/session can only lower (minimum 1) |
| `ceremony.reviewGate` | `pass` (`pass`, `verdict`) | project/session can only move to `pass` |
| `ceremony.orientation` | `{enabled: true, maxLines: 120}` | free per layer |
| `ceremony.recheckBudget` | `3` | project/session can only lower (minimum 0) |
| `ceremony.launchWait` | `block` (`block`, `detach`) | project/session can only move to `block` |
| `ceremony.dedupeNotify` | `true` | project/session cannot turn it off |
| `roles.foreman.codemode` | `true` | project/session can only switch it off |
| `ceremony.required.heavy` | `[planner, builder, reviewer, finalizer]` | steps are added, never removed, by project/session |
| `roles.planner` | tools `read, ls, grep, find, write, edit`; `timeoutMinutes` 20; display "Hannibal" (classic) | project/session can only narrow `tools` |

`reviewGate: pass` means the required reviewer step needs a current PASS (a FAIL, or a revision after the last
PASS, re-opens it); `verdict` accepts any verdict. The orientation packet (tracked-file tree to depth 2,
head of AGENTS.md or README.md, detected build/test commands, explorer hint; at most `maxLines` lines) is added
to the foreman's system prompt once per session and does not count against the read budget.

## Benchmark (`foreman bench`)

`python scripts/foreman_bench.py run --preset bench/presets/smoke.json` runs the preset's rows over a
[Harbor](https://github.com/harbor-framework/harbor) task dir (`--tasks DIR` or `bench.tasks_dir`) in local
Docker; a second `run` resumes, `table` prints the counters (success, tokens, wall time, tool calls,
approvals, guard blocks). Needs `uv tool install harbor`; Harbor telemetry is always switched off. The
Harbor agents live in `bench/harbor_agent.py` and are not part of the installed package.
Trace-derived columns include `ceremony_incomplete`, `read_blocks`, `recheck_blocks`, `finish_refused`,
`launch_waits`, `rereviews` (reviewer launches while the review step was re-opened) and `orient_lines`
(lines in the orientation packet, 0 if none).
`--dry-run` prints the cell order, `--token-cap N` stops cleanly (exit 4) once finished cells used N
tokens (two consecutive infrastructure-error cells stop it with exit 5), `--setup-only` installs one cell's agent and runs zero-model checks without a prompt.
`bench/tasks/m1-recheck` re-checks the M1 standard task (ledger, explorer, builder, reviewer).

## License

MIT, see `LICENSE`. Upstream attributions are in `NOTICE`.
