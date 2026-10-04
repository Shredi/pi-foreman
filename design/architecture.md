# pi-foreman architecture

## 0. Status and scope

| Item | Value |
|---|---|
| Status | Design, Phase 1c, reviewed by the owner on 2026-10-03 (decisions in §16). Phase 2 builds the walking skeleton from it. |
| Evidence date | 2026-10-03, Pi `@earendil-works/pi-coding-agent` 1.0.0, Node 22, hands-on runs in throwaway directories |
| Evidence format | "hands-on 2026-10-03, Pi 1.0.0, `<package>@<version>`: result". Tests that did not run are marked "not tested". |
| Latency run | https://github.com/Shredi/pi-foreman/actions/runs/37120750064 |
| Upstream core | Python core from `Shredi/fable5-opus5-orchestrator` (MIT), a fork of `Rylaa/fable5-opus5-orchestrator` (now `Rylaa/fable5-opus5.5-orchestrator`), credited in `NOTICE` |

## 1. Goals and non-goals

| Goals | Non-goals |
|---|---|
| A generic orchestration harness on Pi: a main-session foreman, five subagent roles, a ledger, safety layers and proportional ceremony | A new agent runtime, subagent engine or permission engine. Those are adopted packages. |
| Same behaviour on Linux, macOS and Windows | Native TypeScript guards, unless measured latency ever demands them (§7) |
| Role → model + thinking per provider. Switching provider switches the whole map. | Automatic escalation to a more expensive provider |
| Overlays add without patching. Flow is one-way. | Shipping private or organisation content, or taking content back from overlays |
| One Python core shared by two harnesses: the Claude Code orchestrator plugin and pi-foreman | A third harness. The Codex CLI port is retired, and the OpenAI/Codex subscription is now a Pi provider. |
| Routine safe operations run without a dry-run/apply step | Removing human approval for anything that fails a precondition |
| Benchmarks decide defaults such as codemode and models | Benchmark runs in this phase (design only, §12) |

## 2. Layers and the overlay contract

| Layer | Form | Pins | Owns |
|---|---|---|---|
| L1 pi-foreman (public) | npm Pi package `pi-foreman`: `extensions/`, `agents/`, `skills/`, `core/` (vendored), `scripts/` (own Python), `config/` (defaults + schema), `setup.mjs` | Pi 1.0.x, its third-party packages (§13), core tag | Mechanisms, neutral roles, default policy |
| L2 private overlay | A user's own Pi package plus `foreman.json` in the Pi agent dir | `pi-foreman@x.y.z` exactly | Model maps, extra roles, MCP servers, repository list, personal preferences |
| L3 organisation overlay | Organisation-owned Pi package declaring `pi.foreman.config` in its `package.json` | `pi-foreman@x.y.z` exactly | Provider gateways (via `registerProvider`), internal tools and skills, default policy for its users |

**One-way rule.** Overlays consume a released version and never write into the pi-foreman package directory. The installer refuses to merge overlay keys into L1 files. Nothing from an overlay is copied back into L1. Changes to L1 come as public issues or PRs written from scratch.

### Extension points

| Point | How an overlay contributes | Conflict rule |
|---|---|---|
| Roles | Role files in its package via `pi.subagents.agents`; listed in `roles.<id>.file` | New id: added. Existing id: `promptAppend` adds text; `file` replaces the prompt (L2/L3 only). Ids stay neutral. |
| Providers and models | `providers.<p>` block; the provider itself as a Pi extension (`registerProvider`) | Per leaf, last layer wins (§3) |
| Display names | `displayNames` preset or per-id map | Last layer wins |
| Skills | `skills/` in the overlay package (Pi skills format) | Pi's own resolution; a same-name skill in an overlay shadows L1 with a warning |
| Permission rules | `safety.permissions` entries, generated into the permission-system config, plus the adapter overlay (§5) | Last layer wins (§3); a project file may only add `deny`/`ask` entries |
| Guards and child extensions | `safety.requiredChildExtensions` (paths in the overlay package) | Last layer wins (§3); a project file may only add entries |
| MCP servers | Pi `mcp.json` or `registerMcpServer` from the overlay extension | Pi's rule: a same-name `mcp.json` entry wins |
| Events | Listen on `pi.events` `foreman:*` (`role_launch`, `role_result`, `ledger_phase`, `ceremony_tier`, `retro`) | Read-only notifications. Veto power only through the overlay's own `tool_call` handler or permission rules. |
| Ceremony, fan-out, fallback | `ceremony.*`, `fanout.max`, `providers.<p>.fallback` | Preferences, last layer wins |

**Merge rule.** Every key merges plain last-wins in the order L1 → L3 → L2 → project → session. There are no organisation safety bounds: a user's L2 may change any value an L3 sets. The one exception is the repository's project file `.pi/foreman.json`: it may only tighten `safety.*` keys (a permissive boolean can only become stricter, safety lists can only gain entries), because a cloned repository is not trusted. A loosening attempt is ignored with a warning naming the key.

## 3. Config schema

| File | Layer | Read when |
|---|---|---|
| `<pi-foreman>/config/foreman.defaults.json` | L1 | Always |
| `foreman.json` from the L3 package (`pi.foreman.config`) | L3 | The package is installed |
| `<pi agent dir>/foreman.json` (honours `PI_CODING_AGENT_DIR`) | L2 | Always |
| `.pi/foreman.json` | Project | Only after Pi project trust is resolved |
| `/foreman set …`, launch flags | Session | Not persisted |

| Key class | Examples | Merge (L1 → L3 → L2 → project → session) |
|---|---|---|
| Scalar or list | `displayNames.*`, `providers.*.roles.*.model/thinking`, `roles.*.codemode`, `ceremony.*`, `fanout.max`, `maxThinking`, `safety.*` | Last wins |
| Map | `providers`, `roles`, `safety` | Deep merge; leaves are last-wins |
| Project file on `safety.*` (and some other keys, §5 table) | `safety.children.mayPush`, `safety.review.required`, `safety.permissions.deny/ask`, `safety.requiredChildExtensions`, `safety.git.protectedBranches` | Tighten only: booleans move to the stricter value, lists gain entries, nothing is removed |

**Keys:** `version`, `displayNames`, `roles.<id>.{file, promptAppend, tools, codemode, launch}`, `providers.<p>.roles.<id>.{model, thinking, codemode}`, `providers.<p>.{costTier, fallback}`, `fanout.max`, `maxThinking`, `ceremony.{default, heavySignals, overrides}`, `safety.{permissions, review, git, children, requiredChildExtensions, ops, subagents}`, `bridge.isolateClaudeConfig`, `providers.<p>.review`, `python.path`, `trace.{enabled, dir}`. Which layer may set which key: §5.

**Validation.** A JSON Schema is shipped in `config/foreman.schema.json`. A stdlib Python validator (`scripts/foreman_config.py`, a supported subset of the schema) runs in three places: the installer, CI, and once at `session_start`, through the adapter (about 50 ms). Rules:
- An unknown key gives a warning.
- An invalid safety key fails closed: the L1 safety values apply, and the user is notified.
- Every role must resolve to a model for the active provider or name a `fallback`. Otherwise the result is a launch error, never a silent default.

**Generation.** pi-foreman's `providers.*` block is the single source. `/foreman apply` and the installer generate pi-subagents' `subagents.agentOverridesByProvider` (and `agentOverrides.<id>.tools` as JSON arrays) into the user's Pi `settings.json`, in a managed block. A hand edit to that block is backed up and then overwritten. pi-subagents keeps resolving the map by the parent's active provider (hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0: the same `/run builder` under `--provider openrouter` and `--provider claude-bridge` gave different child models). Phase 2 checks runtime agent registration as a way to avoid writing settings.

```json
{
  "version": 1,
  "displayNames": "classic",
  "fanout": { "max": 3 },
  "providers": {
    "github-copilot": {
      "costTier": 1,
      "roles": {
        "foreman":  { "model": "github-copilot/claude-sonnet-5.5", "thinking": "high" },
        "explorer": { "model": "github-copilot/gpt-5.4-mini",      "thinking": "low"  }
      },
      "fallback": { "provider": "openrouter", "confirm": true }
    }
  },
  "roles": { "builder": { "codemode": true, "launch": "detached" } },
  "safety": { "permissions": { "ask": ["git push*"] }, "children": { "mayPush": false } }
}
```

## 4. Role model

| Id | Display (preset "classic") | Purpose | Runs as | Default tools (strict allowlist) | Codemode default |
|---|---|---|---|---|---|
| `foreman` | Picard | Triage, plan, ledger, delegate, integrate. Never trusts a child's request blindly. | Main session | All active tools + `subagent` | on |
| `explorer` | Dora | Read-only search, briefs | Child, detached | `read, ls, grep, find, bash`, codemode | on |
| `builder` | Bob | Implements one scoped change | Child, detached | `read, ls, grep, find, bash, edit, write` | off |
| `reviewer` | Watson | Diff review against ledger items | Child, detached | `read, ls, grep, find, bash` | off |
| `senior-reviewer` | Sherlock | Plan review for heavy tasks, security review | Child, detached | Same as reviewer | off |
| `finalizer` | Gandalf | Close-out: verification, commit preparation, summary | Child, detached | `read, ls, grep, find, bash, edit` | off |

- Display names come only from config. A second preset, `"plain"`, shows the ids. No code path compares a display name.
- **The foreman is the main-session role.** It has its own provider-map entry. At `session_start`, pi-foreman looks up `providers.<active>.roles.foreman` and calls:
  - `pi.setModel(model)`. This returns `Promise<boolean>`, and false means the provider has no auth: the extension notifies and keeps the current model.
  - `pi.setThinkingLevel(level)`. Pi clamps the level to the model.

  A later `model_select` by the user is respected and never overridden. Children follow the parent's provider automatically.
- **Thinking levels** in Pi 1.0: `off | minimal | low | medium | high | xhigh | max`. Per-model `thinkingLevelMap` entries remap or null levels. `maxThinking` caps every launch.

### Provider map (illustrative examples, not defaults; benchmarks set real values)

| Role | claude-bridge (private) | openrouter | openai-codex (subscription) | github-copilot (Copilot-class, primary target) |
|---|---|---|---|---|
| foreman | `claude-opus-5-5` / high | a strong paid model / high | `gpt-6-sol` / high | `claude-sonnet-5.5` / high |
| explorer | `claude-sonnet-5-5` / low | a `:free` or cheap model / low | `gpt-5.5` / low | `gpt-5.4-mini` / low |
| builder | `claude-sonnet-5-5` / medium | a coding model / medium | `gpt-6-sol` / medium | `claude-sonnet-5.5` / medium |
| reviewer | `claude-sonnet-5-5` / medium | a coding model / medium | `gpt-5.5` / medium | `gpt-5.5` / medium |
| senior-reviewer | `claude-opus-5-5` / high | a strong paid model / high | `gpt-6-sol` / xhigh | `claude-opus-5.5` / high |
| finalizer | `claude-sonnet-5-5` / low | a coding model / low | `gpt-5.5` / low | `gpt-5.4-mini` / low |

How thinking reaches each provider (Pi 1.0.0 catalogue and source):

| Provider | Thinking behaviour | Status |
|---|---|---|
| Copilot Claude models | Adaptive thinking with `effort` | Code read, not run |
| Copilot GPT models | `reasoning.effort` | Code read, not run |
| Copilot Gemini-flash and Kimi models | Send no effort at all, so the level has no effect | Code read, not run |
| Codex subscription | Login through Pi's built-in `openai-codex` provider | Not run |
| claude-bridge | Passed through | Hands-on 2026-10-03, Pi 1.0.0, pi-claude-bridge@0.9.1: `:high` → child `thinking_level_change high` |

- **Per-launch override.** pi-subagents 0.75.0 accepts a level only on a full id. `explorer[model=<provider>/<model>:low]` works. `explorer[model=:high]` fails for native children with "Unknown subagent model" (hands-on 2026-10-03). So the adapter writes every launch's `model` (top level, or each `tasks`/`chain` entry) as the role's mapped `<provider>/<model>:<thinking>` for the active provider; a level the foreman passed is kept, clamped by `maxThinking`, and a different model it passed is replaced and traced as `model_override`. If a provider rejects suffixed ids, `subagents.disableThinking` applies.
- **Explicit fallback.** `providers.<p>.fallback` names one provider. Fallback happens only on auth failure or unavailability. A fallback to a higher `costTier` needs a one-time confirmation per session. A role never escalates upward on its own.
- **Fan-out width.** `fanout.max` sets the number of concurrent children (default 3). It is an ordinary preference.

## 5. Safety policy

| Layer | Mechanism | Scope | On error |
|---|---|---|---|
| 1. Permission map | `@gotgenes/pi-permission-system` 39.0.2 (PS): allow/ask/deny, bash wildcards, path and MCP rules. The installer generates PS's global file from L1 → L3 → L2 rules; it owns that file (changes are backed up, then overwritten), and user rules belong in `foreman.json`. The adapter also enforces an overlay by itself, before and independent of PS (below). | Main + children (required child extension) | Fail-closed (package behaviour) |
| 2. Destructive/secret guard | Vendored core `destructive_guard.py` via the adapter (§7) on `bash`/`powershell`. The adapter checks the payload first and sets two opt-in switches for the core: `FABLE_ORCH_GUARD_FAIL_CLOSED=1` (an internal error exits non-zero) and `FABLE_ORCH_GUARD_BIN` (empty: no PATH rewrite). Until the re-pin it drops the core's PATH rewrite itself. PowerShell and cmd patterns are in the core since 0.23.0 (vendored at `8376da1`). | Main + children (required child extension) | Fail-closed: a missing interpreter, a timeout, a non-zero exit or a shell call without a command string blocks it, with a reason that explains the fix. This is stricter than the core's own fail-open, on purpose. |
| 3. Model review of `ask` | Own chain link `foreman-review` on PS's authorizer seam. It reads `providers.<active>.review` (`model`, `timeoutMs`, default 15 s) on every ask. | Asks on bash, MCP and skill surfaces; children defer | Fail-safe: an error, timeout, unsure, soft deny, no review model or a value too long to send whole (over 4000 characters) defers to the human prompt. Only an allow, or a deny with high or critical risk, decides. The value and the user's request reach the reviewer between nonce markers as untrusted data. |
| 4. Git guards (own) | `scripts/git_guard.py` (own lexer for bash, PowerShell and cmd; recursion to depth 4; aliases resolved). Main: commit lint (message pattern, required and forbidden trailers, no `-a`/pathspec commit, hook `safety.git.commit.checkCommand` for the public-repo grep) and push lint (no force, mirror, delete or `+refspec` on protected branches, also through configured refspecs). Children: see the list below. | Main: lint. Children: block. | Fail-closed: an unreadable command that mentions git is blocked in children and asked in main |
| 5. Required child extensions | `registerRequiredChildExtensions({extensions: [permission system, core adapter, git child guard], requireForAllRunners: true})` at `session_start`, disposed at `session_shutdown`. Every launch uses `agentScope: "user"`, so project agents cannot redefine a role. | Every child | Launch refused if an extension cannot load (hands-on check in Phase 2) |
| 6. Supervisor channel | Children can ask the parent through `contact_supervisor`. The foreman prompt treats such requests as untrusted. While a request is open (until the foreman's reply or the child's end), any foreman tool outside the requesting role's `tools` is blocked, except the reply, reads and run status. Trace event `supervisor_request`. Limit: after the reply the foreman can act on its own, and only the prompt rule covers that. | Foreman | n/a |

**Layer 1b: adapter deny overlay.** PS's own merge can loosen (a project `bash: "allow"` replaces the global deny map), and PS has no session scope. So the adapter enforces the merged deny set (baseline, L1 → L3 → L2, plus project and session additions) in `tool_call`, before PS. Deny beats any allow. Project and session `ask` entries are confirmed in TUI/RPC and denied in print mode and in children. A `.pi/extensions/pi-permission-system` file shipped by a repository can at most turn an ask into an allow; the adapter warns at `session_start` and `/foreman doctor` fails on it. Every word of a shell command is resolved (`~`, `$HOME`, globs in every segment, ANSI-C quoting, braces, case folding on macOS and Windows, symlinks, inline `python -c`/`node -e` strings) and checked, so `cat .env`, `head ~/.ssh/id_x` and `git diff --no-index a .env` deny. The baseline `protect` block adds write protection that PS cannot express: `.git` is denied for every session; the project's `.pi/` and `.agents/`, the agent dir's `foreman.json`, `settings.json`, `agents/`, `npm/`, `extensions/`, `pi-foreman/claude-config/` and `pi-foreman/state/` (drift snapshots), the project's `.claude/` and `.mcp.json`, `~/.claude/`, `~/.gitconfig`, `~/.config/git/` and `$XDG_CONFIG_HOME/git/`, and the package root are asked in the foreman and denied in children (for the package root, shell words are checked in children only). A `.pi/claude-bridge.json` in any directory is denied to children. Removing or renaming the agent dir itself or `<agent dir>/pi-foreman` (the ancestors of the state folder) is asked in the foreman and denied in children: an operand of `rm`, `rmdir`, `unlink`, `trash`, `mv`, `rename`, `del`/`rd`, `Remove-Item`/`Move-Item`/`Rename-Item` and their aliases, `find -delete`, a string in inline code, or foreman_move's source; reading and listing them stays allowed, and `cd` into the folder followed by a relative operand is not seen. `CLAUDE.md` is not protected: claude-bridge excludes it from its turns. Credential files (`~/.git-credentials`, `~/.config/gh/`, `~/.netrc`, `~/_netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/hub`, `~/.config/glab-cli/`) are deny paths, and `gh auth token`, `gh auth status --show-token`, `git credential fill` and `security find-*-password` with `-w`/`-g` are baseline command denies. Paths resolve symlinks of the deepest existing ancestor, so a new file below a symlinked directory is checked at its target; a `<rev>:<path>` word is also checked by its path part. Where the overlay matcher differs from PS:
- It looks up deny rules inside `-c` strings, `eval`, `find -exec` and wrappers. PS floors those to `ask`.
- It checks path-shaped words whether or not the file exists. PS checks a bare name only when it exists.
- It uses a hand-written lexer, not PS's bash grammar. Heredoc bodies are lexed as plain words, so more words are checked, never fewer.
- Path patterns fold case on macOS and Windows and ignore the separator on Windows.
- It ignores per-agent frontmatter and `yoloMode`.
- Not modelled by either: other shell variables, command output used as a path, `cd` tracking, hard links. A recursive command over an ancestor directory (`grep -r x ~`) is not caught.

**Children, git guard.** Blocked: `push` (also through an alias, a computed word or `-c`), `reset --hard/--merge/--keep`, `checkout -- <path>`, `checkout -f/--force`, `switch -f/--force/--discard-changes`, `restore`, `clean` without `-n`, `stash drop/clear`, `branch -D`, moves of protected refs (`branch -f/-m`, `checkout -B`, `switch -C`), `worktree remove --force`, `update-ref -d`, `reflog expire`, `gc --prune`, `read-tree -u`, `checkout-index -f`, `fetch +ref:ref`, `send-pack`, and `git config`/`-c` for `remote.*`, `push.*` and `include.*`. Dynamic program words (`X='git push'; $X`) that mention git are unreadable and therefore blocked.

**Not a sandbox.** The guards work on command strings. Allowing the repo's test and build commands (`npm test`, `pytest`) means allowing code the agent may just have written, such as a changed `package.json` script or a `conftest.py`. So a child with write tools and the allowed test and build commands can run any code as the user. Assume it can read the user's secrets (ssh keys, the `gh` keyring, credential helpers) and push as the user; the stripped environment and the git guard only stop the plain forms. The larger risk is on the foreman side: the foreman's own tests, builds, git hooks, `core.fsmonitor` and claude-bridge turns run whatever a child planted in the workspace, with the foreman's full credentials and without a guard in the way. Mitigations in place: `.git` writes are denied to every session; the foreman is asked before its next git command when the git config or hooks changed since a child was launched (snapshot drift); the project's `.claude/` and `.mcp.json`, `~/.claude/`, the bridge config folder, `~/.gitconfig` and the git config dirs are protected, and `/foreman doctor` fails on project Claude Code hooks, command-running settings (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, status lines, `fileSuggestion`, `processWrapper`, `env`, `enabledPlugins`, `extraKnownMarketplaces`) or `.mcp.json` when claude-bridge is active, and, with any provider, on a project `.pi/claude-bridge.json` that sets an executable path (`provider.pathToClaudeCodeExecutable` or any key named like a path, command, script or helper), `askClaude.enabled`, `askClaude.defaultMode: "full"` or `provider.strictMcpConfig: false` (session start notifies the same); on Windows the protection strips trailing dots and spaces from each path segment, and an 8.3 short name (`CLAUDE~1`) that fits a protected name where that name sits counts as that name (also for the deny paths, `~\SSH~1\id_x`); credential files and token-printing commands are denied; the guard interpreter is never taken from inside the workspace. The real boundary for children is an OS boundary (§15 #10).

**Known limits (string-level).** These pass the overlay and the guards today and are accepted until the OS boundary exists:
- Paths built from variables (`G=.gi; echo x >> ${G}t/config`).
- `cd`/`pushd` targets are not tracked (`cd ~ && cat .s?h/id_ed25519`).
- Code inside `python -c` beyond adjacent literals (`chr(46)+'env'`) and heredoc-fed scripts (`python3 - <<EOF`).
- PowerShell and cmd variants: `iex` on a concatenated string, cmd `for` loop variables, `pwsh -File x.ps1` (like `sh x.sh`).
- Git leftovers in children: `submodule deinit/update --force`, `worktree add --force`, `filter-branch`, `sparse-checkout set`, `lfs prune`, `tag -d`.
- Push through wrappers that re-add the stripped environment or bring their own transport (`uv run env -u … git push`, `npx`, `gh api`).
- Computed program names in main mode (asked, not blocked).
- The supervisor window closes at the end of a run; after that only the prompt rule covers the foreman.
- A project `safety.requiredChildExtensions` path may point inside the repository.
- A nested `.git` created through `foreman_copy`.
- Very long commands make the guards time out; the call is then blocked (fail-closed), not reviewed.
- The PowerShell lookup can fall back to the project's `node_modules`.
- Files outside the protected set that run later: `.husky/*`, `.github/workflows/*`, `.envrc`, `.vscode/tasks.json`, `~/.zshrc`, `~/.local/bin/*` (writes outside the workspace ask through the permission system; inside it they pass).
- Credential sources not in the deny list: cloud CLI default credentials (for example gcloud ADC), `ssh-add -L`, `git credential-osxkeychain get`; and agent-dir files such as `models.json`, `prompts/`, `skills/`.
- Git config drift gate (security review T1): it covers the repository's own config, worktree config (`config.worktree`), in-repo includes and hooks, the submodule git dirs (`.git/modules/**` config and hooks), `info/attributes` and the project's Claude Code settings (`.claude/settings*.json`, `.mcp.json`) and claude-bridge config (`.pi/claude-bridge.json`); the snapshot is persisted per workspace in `<agent dir>/pi-foreman/state/`, so it survives `/new`, `/resume` and a restart. That folder is in the protect set (asked in the foreman, denied in children, for file tools and shell words). Each workspace's first stored snapshot also writes a seen marker next to it that pi-foreman never removes: a snapshot that is missing while its marker exists, or that is unreadable, truncated or does not parse, counts as drift (asked; blocked without a UI), never as a fresh baseline. A true first session (no snapshot, no marker) takes the baseline and says so in a notice. Code that deletes both the snapshot and the marker (a child's `npm test` is not gated) gets a first-session notice, not an ask. Code that rewrites the stored snapshot to match the state it planted passes silently in every later session: the snapshot is not signed, so across sessions the protection is the protect set around the state folder, not the snapshot (within one session the in-memory snapshot still catches it, and each foreman approval or child launch overwrites the file). Not covered: global or system config, includes pointing outside, and git run indirectly by the foreman (inside `npm test`). Any change asks, including a child's allowed `user.name`. A change a child makes while the foreman's own git command runs is absorbed by the re-snapshot after it. The foreman shell sets only `core.fsmonitor=false` and `protocol.ext.allow=never` and keeps the repository's hooks on purpose; only `safe_ops.py` also empties `core.hooksPath`. So `filter.*`, `diff.external`, `diff.*.textconv`, `core.pager` and hooks are covered only by the drift ask. Further limits: submodules whose `.git` is a directory inside their work tree are not snapshotted; two foreman sessions on one workspace share the stored snapshot (last write wins). The Claude settings check (foreman on claude-bridge) runs before every model request, through Pi's `context` event (Pi 1.0.0 emits it in the agent loop right before the provider call). That covers every run start: typed and RPC prompts, runs a detached child's completion notice starts (`sendMessage` with `triggerTurn`, which skips Pi's `input` and `before_agent_start` events), queued follow-ups, steers, and retries or continuations inside a run. On drift it asks; denied or no UI aborts the run before the request reaches the provider (Pi checks the aborted signal while it resolves the provider's auth, before it calls the provider), with a notify, a message in the session and, without a UI, stderr. Typed and RPC prompts are also checked on Pi's `input` event, so they are refused before a run starts. A switch to claude-bridge (`model_select`) checks and notifies. Cache-warming refreshes of a claude-bridge request are stopped while drift is pending. The snapshot also covers the bridge's own project config, `.pi/claude-bridge.json` (pi-claude-bridge 0.9.1 merges it over `<agent dir>/claude-bridge.json`; it is the only project-level bridge config file). Its `provider.pathToClaudeCodeExecutable` is the program the bridge starts: the bridge reads it at extension load for its turns and AskClaude, and re-reads it on every compaction summary, branch summary and one-shot call (the review link). So: compaction and branch summaries on claude-bridge are checked in Pi's `session_before_compact` and `session_before_tree` events and cancelled on drift that is denied or has no UI; the review link never calls a claude-bridge model while drift is pending, it defers to the human. Pi stops at the first handler that cancels, in extension load order, and the bridge's own handler for those two events starts Claude Code, so the cancel works only when pi-foreman loads before pi-claude-bridge. The installer moves the pi-foreman entry in settings.json `packages` before any pi-claude-bridge entry (shown in the dry run, with a backup), and `/foreman doctor` fails when the bridge is listed first. The user-level `<agent dir>/claude-bridge.json` is in the same snapshot (without `startupNoticeShown`, which the bridge writes there itself) and in the protect set (asked in the foreman, denied in children). The doctor judges it with the same keys, but an executable path there is a warning, not a failure, since the user may have set it on purpose. Not covered: with the bridge loaded first (for example a `-e` extension or a hand-edited order), a compaction between two requests of a run (after a tool result pushes the context over the threshold) or a manual `/compact` or `/tree` summary can start the planted program before any check; a compaction before a typed prompt is covered by the `input` check; `/bug` report summaries (interactive, user-started) go straight to the provider with no event; AskClaude, once enabled in the user's bridge config, runs Claude Code with the project's setting sources and `bypassPermissions` whatever the session's provider is, and its tool calls get no drift check. A changed `.pi/claude-bridge.json` takes effect for normal turns only at the next Pi start, where the session-start check reports it. A change made inside a run reaches the bridge's Claude Code process only at its next fresh start, and that process loaded its settings when the run began. In print mode a stored drift blocks claude-bridge runs until it is approved in a session with a UI.
- A filter, textconv or `core.hooksPath` that already points at a tracked script: the drift check sees the config change, not later edits to the tracked script, so a child that edits the script runs its code in the foreman's next git command (security re-check L3).
- Writes into protected folders by commands that never name them (security re-check M3): `git apply`, `patch -p1 < x.diff`, `tar -xf`, `unzip -o`, `cp -R stage/. .`, `rsync -a stage/ ./`. They are not on the allowlist, so a child needs one approved ask, and the reviewer sees only the command text.
- A dangling symlink as a path word (security re-check L1): `cl -> .claude` made before `.claude` exists cannot be resolved, so a write to `cl/settings.json` passes. Creating the link needs another bypass first.
- Windows 8.3 short names of files whose deny rule is a wildcard name (`*.env`, `*.pem`, `*.key`): only literal folder and file names (`.ssh`, `.aws`, `.claude`) are matched against short names, so `ENV~1` for `.env` passes.
- Project Claude Code settings: `env`, `enabledPlugins` and `extraKnownMarketplaces` are flagged as a whole; the doctor cannot tell a harmless `env` entry from one that runs code.
- The installer (`setup.mjs`) resolves Python without the workspace check the adapter applies.
- Order of checks: the permission system's handler runs before the adapter's (package load order). A command it asks about reaches the human or the review link first; the adapter's guards (destructive guard, git guard) run only after an approval and can still block it. Live run 2: `git push --force origin main` was denied by the review link before push lint saw it.

**Child env (security review S9).** A child's env has `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN` and similar variables removed, the credential helper reset, `core.sshCommand=false` and an invalid `pushInsteadOf` set. This is a speed bump, not a boundary: the plain `git fetch`/`git push` and `gh` calls fail, but code a child runs can still reach the `gh` keyring, ssh keys or credential helpers (see "Not a sandbox"). The foreman does the network git. `safety.children.mayPush: true` (L1/L3/L2 only) lifts it.

**Layer 3, why an own link.** `pi-permission-ai-guard` 0.13.0 reads its config once at `session_start` and builds its reviewer pool once; its session overrides cover only mode and notification level. Switching to a provider with another review model therefore needs a restart (probe: after a switch, the old reviewer still decided). Its verdict paths did behave: allow no prompt, deny-high denied, soft deny, defer, garbage, empty reply, provider error and hang all reached the human prompt. So `foreman-review` (about 150 lines) keeps those semantics, with its own try/catch and timeout, and ai-guard is not installed. A failure of the link shows the human prompt, never a block or a silent allow. Each decision is logged to PS's review log without the command, and `scripts/review_log_stats.py` counts approvals per session.

Evidence:
- Layer 1, hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0 + pi-permission-system@39.0.2:
  - A **detached** child's `ask` reached the parent as `extension_ui_request` with the options "Yes / Yes, for this session / No / No, provide reason", and both approve and deny round-tripped.
  - A **foreground** child (`async:false`) ran ungated without the required extension, and with it the ask was auto-denied ("no interactive UI"). So every role launches detached (`roles.*.launch`).
  - `@gotgenes/pi-subagents`@22.0.0 forwards foreground asks and is the fallback (§13).
- Layer 3, hands-on 2026-10-03 and 2026-10-04, Pi 1.0.0, ai-guard@0.13.0 + PS@39.0.2: the verdict paths worked (see above), the provider switch did not. Replacement `foreman-review`: replay covers allow, deny-high, deny-low, defer, garbage, empty, error, hang and a provider switch without restart.
- Layer 5, hands-on 2026-10-03, pi-subagents@0.75.0: a required child extension blocked a marker command in the child, and the control run without it did not block.

### Precondition-checked operations (replaces the dry-run/apply helper step)

The tools are registered by pi-foreman. The logic is own Python in `scripts/safe_ops.py`, so the Claude Code plugin can reuse it. Each tool re-checks its preconditions immediately before acting. If every precondition holds, it runs **without approval**. If any fails, it returns `precondition failed: <which>` and does nothing. The agent may then take the normal path, which goes through layers 1–3.

| Tool | Preconditions (all required) | Action |
|---|---|---|
| `foreman_worktree_remove` | The path is a linked worktree of the current repo (not the main one). `git status --porcelain` is empty, including untracked files. There are no ignored files, except paths under `safety.ops.worktreeDisposable`. The worktree HEAD is merged into the base branch, or contained in its pushed upstream. No stash entries reference the branch. | `git worktree remove <path>` (no `--force`), then `git branch -d` (never `-D`) |
| `foreman_move` | The real paths of source and destination are inside the workspace root, with symlinks resolved. The destination does not exist. Neither path is inside `.git/`. A tracked source is clean. | `git mv` if tracked, otherwise a rename with no-overwrite semantics |
| `foreman_copy` | Same path rules. The destination does not exist. The source is a regular file or directory under a size cap. | Exclusive-create copy (`COPYFILE_EXCL` semantics) |

All three are recorded in the trace (§10, field `precondition`, name only) and counted by `/retro`.

- **Who gets them.** The builder has `foreman_move` and `foreman_copy`. `foreman_worktree_remove` is for the foreman only. The overlay treats the tools' paths like file-tool paths: `foreman_copy .env x` and a move into `.git/` deny.
- **Ignored files.** `git worktree remove` deletes ignored files, and they can hold results that exist nowhere else (this repo's `.workflow/` is one). So any ignored file outside `safety.ops.worktreeDisposable` (default `node_modules/`, `target/`, `dist/`, `build/`, `__pycache__/`, `.venv/`) fails the precondition. A project cannot extend that list.
- **Directory-move limit.** The standard library has no `RENAME_NOREPLACE`. A directory or untracked symlink is moved by check-then-rename, so another process could create the destination in between. Files use `os.link` plus unlink, and tracked paths use `git mv`, so the window exists for directories only. Symlinks are resolved once; a swap after the check is not detected.

### Safety and loosening keys by layer

Direction: **tighten** keys may be set by every layer; the project file (`.pi/foreman.json`) and the session may only make them stricter. **Loosen** keys are set by L1, L3 and L2 only; the project file ignores them with a warning, and the session drops them.

| Key | Layer | Direction | Project / session |
|---|---|---|---|
| `safety.children.mayPush` | 1, 4 | `true` loosens | only `false` |
| `safety.review.required` | 3 | `true` is strict | only `true` |
| `safety.permissions.deny`, `ask`, `paths.deny`, `paths.ask` | 1 | tighten | entries are added |
| `safety.permissions.allow` | 1 | loosen | cannot be extended (intersection) |
| `safety.permissions.projectCommands` | 1 | loosen (allows commands) | ignored |
| `safety.requiredChildExtensions` | 5 | tighten | entries are added |
| `safety.git.protectedBranches` | 4 | tighten | entries are added |
| `safety.git.commit.requiredTrailers`, `forbiddenTrailers` | 4 | tighten | entries are added |
| `safety.git.commit.messagePattern` | 4 | loosen (a pattern can accept anything) | ignored |
| `safety.git.commit.checkCommand` | 4 | runs a program | ignored |
| `safety.ops.copyMaxBytes` | ops | lower is tighter | only a lower value |
| `safety.ops.worktreeDisposable`, `safety.ops.baseBranch` | ops | loosen | ignored |
| `safety.subagents.allowWorkflow` | launch | `true` loosens (workflow scripts and `schedule.*` can name any agent) | ignored |
| `python.*` (also `python.path`) | 2, 4 | chooses the executable that runs every guard | ignored |
| `roles.*.tools` | 5 | narrow only | intersection with the L1 → L3 → L2 list |
| `roles.<new id>`, `providers.*.roles.<new id>` | 5 | a new launchable role | ignored |
| `roles.*.launch`, `roles.*.file` | 5 | loosen | ignored |
| `roles.*.codemode`, `providers.*.roles.*.codemode` | 5 | `true` adds a tool | only `false` |
| `providers.*.review` | 3 | a review model approves asks | ignored |
| `bridge.isolateClaudeConfig` | bridge | `false` loosens | ignored |
| `trace.dir` | trace | writes outside the workspace | only inside the workspace (symlinks resolved) |

Each layer is validated on its own: an invalid safety entry is dropped from that layer only, with a warning. Documented limit: `maxThinking` is plain last-wins, so a project can raise the thinking ceiling. It costs money and grants no access. Subagent management actions are a fail-closed allowlist; `resume` passes only for a run this session launched, with the same role and mapped model. Checking launches made inside workflow scripts is Phase 4 (§15).

### Bridge isolation

A claude-bridge turn loads the host's Claude Code setup (settings, hooks, plugins, `CLAUDE.md`) through the SDK child, which also pulls the host orchestrator profile into the prompt. `bridge.isolateClaudeConfig` (`"auto"` by default: on when the active provider is `claude-bridge`) makes the adapter set `CLAUDE_CONFIG_DIR` to `<agent dir>/pi-foreman/claude-config/` (mode 0700) at `session_start` and `model_select`. `/foreman doctor` checks that the folder holds no `settings*.json`, `plugins/`, `hooks/`, `CLAUDE.md`, `agents/`, `skills/` or `commands/`, and that a login is present (presence only, never the value). One-time login: run `CLAUDE_CONFIG_DIR=<folder> claude`, then `/login`, or set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Hands-on 2026-10-04, Pi 1.0.0, pi-claude-bridge@0.9.1, Sonnet: with the key the host profile was absent and the same question wrote 325 cache tokens instead of 2372; without a login the turn fails with "Not logged in". The folder also receives cloud-fetched `remote-settings.json` and `policy-limits.json`; the doctor lists them as INFO. Isolation covers the user level only: the bridge still loads the project's `.claude/settings*.json` and `.mcp.json`, so with claude-bridge active the adapter notifies at `session_start` and on a switch to claude-bridge (`model_select`), and `/foreman doctor` fails, when they hold `hooks`, a command-running key such as `apiKeyHelper` or `awsAuthRefresh`, or MCP servers, and children cannot write them (§5 layer 1b).

## 6. Ledger, gates and proportional ceremony

The ledger, spawn gate, write gate and stop gate come from the vendored core (§7). The foreman triages every task once, records the tier in the ledger header, and escalates automatically on new signals. It never de-escalates automatically. The user can override the tier with `/ceremony <tier>`.

| Tier | Signals (configurable `ceremony.heavySignals`) | Ledger | Plan review | Children | Finalizer |
|---|---|---|---|---|---|
| trivial | One file, no behaviour change, no risky keyword | No | No | None, or one explorer | No |
| standard | Several files in one area, one phase | Yes | Foreman self-check | explorer → builder → reviewer | No |
| heavy | Several phases or areas, deletes or migrations, safety, auth, CI or release work, a public API, or more than N files | Yes | senior-reviewer before any build, owner checkpoint | Full set; builders may fan out | Yes |

**Tiers and the gate.** The core's spawn gate stays the enforcement; the tier is only the foreman's routing. A trivial task has no ledger and at most one short `explorer` launch, which stays below the gate's threshold. Standard and heavy tasks write the ledger first; the gate denies further launches until the session has its own ledger, and the stop gate blocks ending while items are open.

The foreman creates the ledger with the `write` tool, never through the shell, so the write binds the session to it; the tier is a line `Tier: <tier>` directly under the ledger title, and a bound ledger without that line counts as `standard`.

**`/retro` friction metrics.** These are read from the Pi session JSONL, the permission-system review log and the trace. Content is never printed.

| Metric | Definition |
|---|---|
| Approvals per session | Human-answered asks, split into those auto-reviewed and those reaching a human |
| Overridden denials | A deny later followed by an approval of the same command family |
| Spawn cost | Children per role, tokens and cost per role (from provider usage), wall time |
| Precondition-op hit rate | Runs vs `precondition failed`, by tool |
| Supervisor requests | `contact_supervisor` calls and how they were handled |
| Permission-map proposals | A command family reviewed safe at least 5 times in at least 2 sessions with no deny. The proposal is shown as a diff to the user's L2 rules and never applied automatically. |

## 7. Core and TypeScript adapter

- **Vendoring.**
  - `core/` holds selected paths of `Shredi/fable5-opus5-orchestrator` extracted from the GitHub tarball at a pinned full commit SHA (a core tag once one exists). `core/VERSION` records the pin and `core/MANIFEST` the SHA-256 of every vendored file. `scripts/pull_core.py` updates both (Python rather than make, so it runs on Windows). No `git subtree`: no foreign history in this repo.
  - `core/` is never edited. A test compares the tree with `core/MANIFEST`. Fixes land in the fork, get tagged, and are pulled. The core's own tests run in pi-foreman CI as a conformance suite (pytest, a CI-only dependency).
  - Two harnesses share the core: the Claude Code orchestrator plugin, where it originates, and pi-foreman.
- **Adapter** (`extensions/core-adapter/`, TypeScript). It mirrors the adapter pattern of the orchestrator's earlier Codex port: `normalise` → tool-name map → `runGuard` → output translation.

| Pi tool | Core name | Guards fired |
|---|---|---|
| `bash`, `powershell` | `Bash` | destructive guard, git guard (pre); both fail closed |
| `write` | `Write` | write gate (pre), ledger bind (post) |
| `edit` | `Edit` | ledger bind (post). Not write-gated, as in the core's own hook config: the gate would deny the Edit that binds an existing ledger. |
| `subagent` | `Agent` | spawn gate (pre; the input is the task text) |
| `read`, `grep`, `find`, `ls` | `Read`/`Grep`/`Glob` | none today (Claude-only read guard not ported) |
| `codemode` | none | Inner tool calls pass through `tool_call` individually (Pi: nested `ctx.executeTool` calls are hooked). Replay test in Phase 2. |
| MCP tools | none | Permission system gates each built-in MCP tool call (PS ≥ 38) |

| Pi event | Core script | Translation |
|---|---|---|
| `before_agent_start` | none: pi-foreman's own `instructions/foreman.md` | System-prompt section, main session only. The core's `inject_instructions` is not called: its text names Claude model tiers and it reads Claude config dirs. |
| `tool_call` | permission overlay, `destructive_guard`, `git_guard` (own, `scripts/git_guard.py`), `ledger_guard_write`, `ledger_guard_spawn` | Result handling below |
| permission asks | `foreman-review` chain link (own, layer 3) | allow, deny or defer to the human prompt |
| `tool_result` | `ledger_bind` | Side effect only |
| `agent_before_settle` | `ledger_guard_stop` | Block → `{continue: true}` plus the reason as a message |

How `tool_call` results are translated:
- `deny` → `{block: true, reason}`.
- `updatedInput` → mutate `event.input` in place.
- `ask` depends on the mode:

| Mode | `ask` handling |
|---|---|
| TUI | `ctx.ui.confirm` |
| RPC | `ctx.ui.confirm` arrives as `extension_ui_request` |
| print or JSON | Deny with "needs approval, no UI" |
| Detached child | Core-guard `ask` → deny with "ask the foreman". Permission-system asks are forwarded to the parent (§5). Routing core-guard asks through that forwarding is a Phase 3 item. |

**`runGuard`:**
- Spawns `<python> core/scripts/<guard>.py`, with the hook JSON on stdin and a 5 s timeout.
- Environment:
  - `FABLE_ORCH_HARNESS=pi`.
  - `FABLE_ORCH_SESSION_BINDING=1` (core ≥ 0.22.1) switches the core's gates off legacy ledger discovery, so a session only ever sees its own ledger. `FABLE_ORCH_METRICS_DIR` puts the core's metrics into pi-foreman's state dir.
  - The session id variables are set to the Pi session id.

**Session binding.** `ctx.sessionManager.getSessionId()` (Pi 1.0.0 `SessionManager.getSessionId(): string`) becomes `session_id` in every payload. Shell tools already receive `PI_SESSION_ID`, so `ledger` CLI calls from bash bind to the same session. The adapter puts pi-foreman's `bin/` (shims `ledger`, `ledger.cmd`, `ledger.ps1` that run `core/scripts/ledger.py` with the resolved Python) on `PATH` for the `bash` and `powershell` tools.

**Python resolution.** The adapter tries these in order:
1. `python.path` from config
2. `PI_FOREMAN_PYTHON`
3. Windows: `py -3`, then `python`. Unix: `python3`, then `python`.

The interpreter must report version ≥ 3.9. The Windows Store alias stub is rejected. The result is cached per session. If no interpreter is found, layer 2 fails closed for shell tools and `/foreman doctor` explains the fix.

**Latency** (CI run above: 50 warm spawns from Node, `destructive_guard`):

| Runner | Warm p50 | Warm p95 |
|---|---|---|
| ubuntu | 34–39 ms | 35–41 ms |
| macOS | 41–47 ms | 68–75 ms |
| windows | 55–60 ms | **65–71 ms** |

The threshold was a Windows warm p95 above 150 ms, and the measurement is far below it. So the **Python core is used everywhere** and no native TypeScript guards are needed. Not measured: `py -3` launcher overhead on a real Windows host, and the blocked-command path.

## 8. Codemode

| Aspect | Design |
|---|---|
| Mechanism | Pi 1.0 built-in. It is off by default. It is enabled per session by the tool list: children get `codemode` in their `tools` JSON array (a comma string is rejected), and the foreman adds it through `pi.setActiveTools` at `session_start`. There is no per-model flag in Pi. |
| Evidence | Hands-on 2026-10-03, Pi 1.0.0, pi-subagents@0.75.0: a child with `tools: ["read","ls","codemode"]` ran a codemode script successfully |
| Default | The mechanism works for all six roles. The shipped default is `on` (direct tools plus codemode) only for `foreman` and `explorer`, and `off` for the other four until benchmark numbers exist. `codemode.mode: only` is never a default. |
| Switch | `providers.<p>.roles.<id>.codemode` (per role × provider) overrides `roles.<id>.codemode`. The benchmark rig flips it per configuration, and the generator writes the resulting tool arrays. |
| MCP | Built-in MCP servers default to `codemode` exposure. `autoEnableCodemode` stays as Pi sets it. |

## 9. Subagent launch contract

Every role is launched detached (`async: true` in the role frontmatter) with these properties:
- The required child extensions from §5. The policy extensions are required in every child.
- A strict tool allowlist. Extension tools are not inherited and must be listed with their path. Hands-on 2026-10-03: an unlisted tool was absent, and a listed one ran.
- A model resolved from the provider map.

An explicit `async: false` in a call would beat the frontmatter, so the adapter rewrites every `subagent` call to `async: true` (and drops `foregroundOnly`), and the generated `subagents` block sets `forceTopLevelAsync: true`.

Launches are limited to the configured child role ids (the keys of `roles` except `foreman`, overlay roles included): the adapter refuses any other agent, such as a pi-subagents builtin, in `agent`, `tasks[]`, `chain[]` or `chain[].parallel[]`, and lets management calls (`action`) pass.

Results return through pi-subagents' async notifications. The foreman waits, bounded by `fanout.max`. pi-subagents writes run state (`run-history.jsonl`, `missions/`) to the Pi agent dir, so the replay rig and tests always set `PI_CODING_AGENT_DIR` to a temp dir.

## 10. Replay rig and tests

| Part | Design |
|---|---|
| Trace | Opt-in JSONL in the state dir. **Allowlisted fields only:** `ts`, `event`, `role`, `toolFamily` (mapped core name), `guard`, `decision`, `latencyMs`, `model`, `tokensIn`/`tokensOut`, `cost`, `exit`, `tier`. Never prompts, tool arguments, paths or outputs. The writer drops any non-allowlisted key, and a unit test asserts it. |
| Fake provider | `pi.registerProvider("foreman-fake", …)` streams scripted assistant messages (text and tool calls) from a fixture. It is also registered as a required child extension, so children run on it too. |
| Driver | Python, stdlib. It starts `pi --mode rpc --approve` with a temp `PI_CODING_AGENT_DIR` and a temp project, sends prompts and UI answers, and compares the trace to a golden sequence. `pi -p` is not used for subagent runs, because it exits before detached children finish (hands-on 2026-10-03). |
| Suites | Python `unittest` for `scripts/`; the core conformance suite (pytest, CI-only); the `core/MANIFEST` pin check; `node --test` for the adapter's pure functions; replay scenarios: guard deny, ask in TUI/RPC/print, child cannot push, precondition pass and fail, provider switch, ceremony tiers |
| CI | GitHub Actions matrix `ubuntu-latest`, `macos-latest`, `windows-latest` × Python 3.9 and 3.13, on every push and PR. CI installs the pinned Pi and pi-subagents and runs the replay scenarios on the fake provider only: no secrets and no real model calls. |

## 11. Installer

`node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--remove]`

| Step | Behaviour |
|---|---|
| 1. Check | Node and Pi versions. Pi must match the pinned range (1.0.x). |
| 2. Python | Same resolution as §7. If no Python ≥ 3.9 is found, the installer stops with OS-specific instructions. |
| 3. Packages | `pi install npm:<pkg>@<exact>` for pi-foreman and each pinned package from `packages.lock.json`. Pi and pi-permission-system are pinned in lockstep, because a PS major tracks Pi majors. `--project` uses `-l` and notes that project packages load only after trust; headless runs need `--approve`. |
| 4. Settings merge | User `settings.json`: add or update only the entries pi-foreman manages, and write the generated `subagents` block (§3). Never remove or reorder user keys. Back up to `settings.json.bak-<timestamp>` before the first change. |
| 5. Policy | Generate the permission-system global file from the L1 → L3 → L2 rules. The installer owns it: a hand edit is backed up and overwritten, and user rules go into `foreman.json`. `authorizerChain` is `["foreman-review"]`. `/foreman doctor` reports drift. |
| 6. Config | Write a commented `foreman.json` template only if it is absent |
| 7. Doctor | `/foreman doctor` checks: Python, the generated block in sync, required child extensions resolvable, auth per provider in the map |

- `--dry-run` prints the planned changes as a diff and writes nothing.
- A second run is a no-op. CI asserts that on all three OSes.
- Overlays install with `--overlay`, pinned exactly. The installer never edits overlay files.

## 12. Benchmark design (design only, no runs)

| Aspect | Design |
|---|---|
| Runner | Harbor (`harbor-framework/harbor`, Apache-2.0). It has agent adapters for `pi` and `claude-code` and runs tasks in Docker. `foreman bench` is a thin wrapper, not an own runner. |
| Tasks | Three sizes (small, medium, big), 2–3 each, from already-solved commits: start at the parent commit and check with the tests the fix added. Private tasks stay outside this repo. The repo ships the runner config and synthetic samples. |
| Configurations | Plain Pi; pi-foreman; codemode on/off per role; pi-foreman per provider map; Claude Code without a harness and with the orchestrator plugin (reference) |
| Metrics | Success (hidden tests), tokens, cost, wall time, tool calls, approvals, guard blocks |
| Protocol | 3 repeats per configuration, a budget cap per run, median and range reported. Providers that log or train on data are never used on private code. |
| Decision rule | A default changes only if success is not worse and cost or time improves beyond the observed range. With this suite size the result can show "not worse, at this cost", not a small advantage. |

## 13. Adopt / wrap / own

| Capability | Choice | Version tested | Evidence summary |
|---|---|---|---|
| Runtime | adopt Pi | `@earendil-works/pi-coding-agent` 1.0.0 | All runs; signatures read from installed types |
| Subagents | **adopt** `pi-subagents`, every role detached | 0.75.0 | Hands-on: package roles discovered and launched; provider switch changes child model; full-id thinking override; codemode in child; required child extension blocks; strict tool allowlist. FAIL: foreground ask forwarding. |
| Subagents (fallback) | fallback `@gotgenes/pi-subagents`, used only if the primary blocks | 22.0.0 | Hands-on: forwards foreground asks. Role and provider features not tested. |
| Permission map | **adopt** `@gotgenes/pi-permission-system` | 39.0.2 | Hands-on: ask rules, detached-child forwarding, authorizer chain resolves |
| Model review | **own** chain link `foreman-review` (replaces `pi-permission-ai-guard`) | n/a | ai-guard 0.13.0 ran with PS 39.0.2 and all verdict paths behaved, but its reviewer cannot switch with the provider without a restart. Replay covers all paths and the switch. |
| Model review (rejected) | `@mzwing/pi-permission-auto-review` / `pi-verdict` | 0.7.0 / 0.14.0 | Auto-review needs Node ≥ 24 and PS 33–36. pi-verdict runs its own gate beside PS (double prompts). Load test only. |
| Destructive/secret guard | **own** (vendored core) | core 0.23.0 @ fork SHA `8376da1` (latency run: `1be4960`) | CI latency run on three OSes |
| Ledger, gates, git guards, permission overlay, bridge isolation, precondition ops, ceremony, `/retro`, trace, installer | **own** | n/a | Design |
| Claude provider (private) | adopt `pi-claude-bridge` in L2 | 0.9.1 | Hands-on: child turns, thinking level reached |
| Copilot, Codex subscription | Pi built-in providers | Pi 1.0.0 | Source read: Copilot device-flow `/login github-copilot` or `COPILOT_GITHUB_TOKEN`. Not run. |
| MCP | **adopt Pi built-in (pending hands-on in Phase 2)**; `pi-mcp-adapter` 5.0.0 opt-in overlay only | Pi 1.0.0 (docs, types) | The adapter replaces the built-in, rewrites user settings, and hides per-tool gating behind one proxy tool. Not run. |
| Codemode | adopt Pi built-in | Pi 1.0.0 | Hands-on in child |
| Background tasks | **none**; `pi-background-tasks` avoided | 2.6.9 (source read) | 2.6.9 impersonates the Claude Code client on the `anthropic` provider, and its Pi peer range is `^0.81–0.84` |
| Claude Code child runner | **not used**, not even in an overlay | pi-subagents 0.75.0 (docs) | Async only, no Pi guards inside. The Claude bridge is the only Claude path. |
| Plan mode, intercom, todo, web search | candidates, not adopted yet | not tested | Decided with evidence in Phases 2 and 4 |
| Benchmark runner | adopt Harbor (pending hands-on in Phase 2b) | not run | Design only |

## 14. Changes from the master plan

| # | Change | Reason |
|---|---|---|
| 1 | The core is shared by **two** harnesses, not three. The OpenAI/Codex subscription is a first-class Pi provider example. | The Codex CLI harness is retired, because Pi covers that provider. |
| 2 | Subagent roles launch **detached**, with permission system, guard and git child guard as required child extensions (`requireForAllRunners`) | Foreground children run ungated, or are auto-denied |
| 3 | A per-launch thinking change restates the full `provider/model:level`, not a bare `:level` | A bare level fails for native children in pi-subagents 0.75.0 |
| 4 | pi-foreman's `providers.*` is the source, and the pi-subagents block is generated from it | The foreman entry, codemode switch, fallback and fan-out need one file. pi-subagents' mechanism is still used. |
| 5 | Model review is an own chain link, `foreman-review`; ai-guard is not installed (supersedes the first plan: pinned ai-guard with the own link as fallback) | ai-guard cannot switch the reviewing model with the provider without a restart |
| 6 | `pi-background-tasks` dropped | Client impersonation by default, and the peer range excludes Pi 1.0 |
| 7 | MCP decided: Pi built-in, adapter as opt-in only | Per-tool gating, no settings mutation, native to Pi 1.0 |
| 8 | The foreman is a main-session role with its own provider-map entry, applied via `setModel`/`setThinkingLevel` | It is not a subagent, but it must follow the provider switch |
| 9 | Python core everywhere, including Windows | Measured Windows warm p95 is 65–71 ms, under the 150 ms threshold |
| 10 | The replay rig and tests drive Pi in RPC mode, not `pi -p` | `pi -p` exits before detached children finish |
| 11 | No Claude Code children at all; the Claude bridge is the only Claude path | Pi guards do not apply inside them |
| 12 | `contact_supervisor` requests are treated as untrusted | Hands-on: a cooperative parent ran a tool that the child's allowlist excluded |
| 13 | Asks get a real prompt in TUI and RPC. Only print mode and children deny. | Unlike Codex, Pi has an interactive confirm API |
| 14 | The precondition-op logic is own Python in `scripts/`, not in the vendored core, and the vendoring script is Python, not make | The core is never edited, and make is not available on Windows by default |
| 15 | Skills in `.agents/skills/` are for Pi only | Claude Code 2.1.288 does not load them (headless check). See open items. |
| 16 | The adapter enforces the merged deny set and a write-protection block itself, before PS. The installer owns the generated PS file. | PS's merge can loosen and it has no session scope |
| 17 | Children get an env without push credentials; the foreman does network git | Allowed test commands run agent-written code (security review S9) |
| 18 | Project and session layers cannot loosen `python.*`, `roles.*.tools`, new role ids, `roles.*.launch/file`, codemode, `providers.*.review`, `bridge.*`, `trace.dir` outside the workspace (table in §5) | A cloned repository is not trusted. Confirmed by the owner. |
| 19 | `workflow`, `schedule.*` and agent-definition actions are blocked by default (`safety.subagents.allowWorkflow`) | They can name any agent and skip the role allowlist and the model check |
| 20 | The builder gets `foreman_move` and `foreman_copy`; worktree removal needs no ignored files outside `worktreeDisposable` | Ignored files can hold the only copy of a result |
| 21 | Bridge sessions run with an own empty Claude config folder | Owner decision: the host setup leaked into bridge turns |

## 15. Open items for the owner

| # | Item | How to check |
|---|---|---|
| 1 | Does thinking reach Copilot models? | With the Copilot provider active, run `/run explorer[model=github-copilot/<model>:low]` and then `:high`. Check `thinking_level_change` in the child session file and that the request is not rejected. Try one Claude, one GPT and one Gemini-flash model (the last should show no effect). |
| 2 | The forwarded-ask dialog in the interactive TUI | In the TUI, start a detached child that hits an `ask` rule. Check that the dialog appears and that both answers round-trip. Headless RPC already passed. |
| 3 | The `py -3` launcher on a real Windows host | `/foreman doctor` timing |
| 4 | Closed: ai-guard replaced by `foreman-review` (§5, §14 #5) | n/a |
| 5 | Required child extension missing at launch | Hands-on in Phase 2. The expected result is that the launch is refused. |
| 6 | Closed: the PowerShell/cmd pass and the opt-in fail-closed and guard-bin switches are in core 0.23.0. The baseline still asks for `Remove-Item -R*`, `ri`, `rd /s`, `del /s` as a second layer. | Done (re-pinned to `8376da1`) |
| 7 | Closed: vendored core re-pinned to 0.23.0 (`8376da1`) | Conformance 644 passed |
| 8 | Phase 4: check launches inside workflow scripts and scheduled runs. No `tool_call` fires for those children. | Needs an upstream veto hook per workflow child launch, or the child extension asserting its own role and model against the map at `session_start` (the robust check). Until then `allowWorkflow` stays off. |
| 9 | Core guard review at the fork (internal error paths, the fail-closed switch) | The security review did not read `destructive_guard.py` (a safety classifier stopped it); the parent's verifier covers it at the fork |
| 10 | Phase 4: an OS boundary for children (container, OS sandbox or a separate user) | String guards cannot stop code a child runs through allowed test/build commands (§5 "Not a sandbox"). Check: a child's planted test cannot read `~/.ssh`, the `gh` keyring or write outside its worktree. |

## 16. Decisions (owner review, 2026-10-03)

| # | Decision |
|---|---|
| 1 | Subagents: `pi-subagents` 0.75.0, every role detached, policy extensions required in every child. The fallback package is used only if this one blocks. |
| 2 | Permission map `@gotgenes/pi-permission-system` 39.0.2, pinned with Pi. Model review `pi-permission-ai-guard` 0.13.0, pinned; Phase 3 wires and tests it (superseded 2026-10-04: own link `foreman-review`, §14 #5). |
| 3 | MCP: Pi built-in. No background-tasks package. |
| 4 | Codemode works for all six roles; the shipped default is on only for `foreman` and `explorer` until benchmark numbers exist. The switch per role and per role × provider stays. |
| 5 | Display preset "classic": Picard, Dora, Bob, Watson, Sherlock, Gandalf. |
| 6 | Skills under `.agents/skills/` are for Pi sessions only. |
| 7 | No Claude Code children at all. The Claude bridge is the only Claude path. |
| 8 | No organisation safety bounds. Every key merges last-wins (L1 → L3 → L2 → project → session); only `.pi/foreman.json` is limited to tightening safety keys. |
| 9 | A guard failure blocks the shell call and explains the fix (fail closed). |
| 10 | All changes in §14 are accepted. |
| 11 | Phase 2 (plan review): pi-foreman injects its own `instructions/foreman.md`; the core's injector is not called. The core is vendored as a pinned tarball with a hash manifest, not a subtree. pytest is a CI-only dependency. CI runs replay on the fake provider on all three systems. |
