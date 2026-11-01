# Permissions: the tool gate

> Covers how pi-foreman decides every tool call: the permission files and rule syntax, the prose whitelist, the order of the steps, the four modes, the dangerous class, the classifier, the floors, the owner dialog, child asks, profiles, the decision log, the config keys and the migration from the older gates.
> Read it when a call is denied or asks and you expected it to run, before you write a rule or a whitelist sentence, or when you upgrade from a release with the review-model gate.
> The floors run first and nothing here (rule, whitelist, classifier, dialog, mode) can allow what a floor refuses.

pi-foreman decides tool calls with its own gate, `extensions/core-adapter/gate.ts` plus the mode step in `index.ts`. It is the first `tool_call` handler in load order and decides every tool call of every session kind. The default is simple: a call that no rule decides **runs**, unless it falls into the [dangerous class](#the-dangerous-class) (deploys, forge writes, publishing, installs, network writes, destructive git, process control, writes outside the worktree and a few more). Dangerous calls go to a cheap [classifier](#the-classifier) that reads a short list of sentences you wrote; whatever it cannot cover asks you in a dialog. Reads, GET fetches, routine git, role launches and PR creation never ask.

A guard rail, not a sandbox: a prompt-injected agent can still find commands the parser marks opaque. Opaque lines are dangerous class, never a default allow, and the floors run on the raw text so obfuscation reaches a dialog or a deny, not an allow.

## Files and locations

One short JSON file holds the whole policy. Three files can exist; all use the same keys.

| File | Location | What it may contain |
|---|---|---|
| user | `<agentDir>/pi-foreman/permissions.json` | every key, including `mode` and `profiles` |
| project | `<main checkout>/.workflow/permissions.json` | everything except `mode` and `profiles` (see the trust rule) |
| tracked | `<worktree>/.pi/permissions.json` | `deny`, `ask` and `classifier.deny` only |

A missing user file is `mode: "auto"` with empty lists. The project file lives in the **main checkout**, found with `git worktree list`, so every worktree of a repository shares it.

```json
{
  "mode": "auto",
  "allow": ["Bash(npm run build *)", "Read(~/notes/**)"],
  "ask": ["Bash(git push *)"],
  "deny": ["Bash(rm -rf *)", "mcp__prod__*"],
  "additionalDirectories": ["~/reference"],
  "classifier": {
    "allow": ["Deploy to the staging cluster named stage-eu."],
    "deny": ["Anything that touches the production database."]
  },
  "profiles": { "release": { "mode": "auto", "allow": ["Bash(gh release *)"] } }
}
```

- **The trust rule of the project file.** `.workflow/permissions.json` is yours alone: it must be untracked and ignored by git (`git ls-files --error-unmatch` fails and `git check-ignore` succeeds) and neither the file nor `.workflow` may be a symbolic link. Only then are its widening keys honoured (`allow`, `additionalDirectories`, `classifier.allow`). Otherwise the file is tighten-only (`deny`, `ask`, `classifier.deny`) and one notice says why. Add `.workflow/` to `.git/info/exclude` to make it trusted. A file anyone can push cannot widen what the gate allows.
- **The tracked file** `.pi/permissions.json` is reviewed code that every contributor can change, so it can only tighten: `deny`, `ask` and `classifier.deny`. Other keys are dropped with one notice.
- **Invalid files.** An invalid user file (not JSON, wrong shapes) makes the mode `ask` and the other files still apply; an invalid project or tracked file contributes nothing. One in-session notice names the file and the error at the first gate decision, and `/foreman doctor` warns. A bad entry inside a valid file (an unparseable rule, a sentence over 300 characters, a non-string) is skipped on its own, with a notice that names it.
- **Reading.** The files are read at the first decision, when their modification time changes, after a remember write and on `/foreman perms reload`. A child re-reads them at each decision, so a remember in the parent applies to running children.
- **Protected.** The agent cannot write any of the three files (floor, see [Floors](#floors)); you edit them, or the dialog's remember step does for the project file.
- `additionalDirectories` (user and trusted project file, `~/` and relative paths allowed; relative means to the main checkout) are added to the owned roots, which widen reads and count as inside for role launches. Under mode `auto` reads outside the roots are not dangerous anyway; the key matters under mode `ask`.

## Pattern rules

`allow`, `ask` and `deny` hold rules in the form `Tool` (every call of the tool) or `Tool(pattern)`. A bad rule is an error with a reason, never a silent no-match.

| Rule tool | Matches | The pattern meets |
|---|---|---|
| `Bash` | `bash`, `foreman_bg`, `bg_run`, `powershell` | each segment of the line, as `program arg arg` (single spaces, quotes stripped) |
| `Read` | `read`, `grep`, `find`, `ls` | the resolved absolute path |
| `Edit` | `edit`, `write`, `foreman_move`, `foreman_copy` | the resolved absolute path (a move checks source and destination) |
| `Write` | `write`, `foreman_move`, `foreman_copy` | the resolved absolute path |
| `fetch` | the `fetch` tool | the URL |
| `mcp__server__tool`, `mcp__server__*`, `mcp__server` | MCP tools by name, server prefix or whole server | the JSON payload, when a pattern is given |
| any other name, for example `intercom` | the tool of exactly that name | the JSON payload, when a pattern is given |

The lowercase tool names (`bash`, `read`, ...) are not rule names: a rule `bash(...)` is refused, write `Bash(...)`.

**Pattern syntax.** One glob over the whole text: `*` is any run of characters, `?` one character, the whole string must match. In `Bash` patterns a trailing ` *` also matches the bare prefix, so `Bash(git status *)` matches `git status` and `git status -s`. Path patterns: `~/x` is under home, `//x` is the absolute path `/x` (`//c:/x` on Windows), `/x` and `x` are relative to the **main checkout** (not the worktree), `**` crosses directories, `*` stays within one path part. Matching is lexical: a symlink is not followed. On Windows and macOS case is folded, and on Windows backslashes equal slashes.

```
Bash(npm run test *)        any "npm run test ..." segment
Bash(git push origin *)     a push to origin
Read(~/notes/**)            reads below ~/notes
Edit(docs/**)               edits below docs/ of the main checkout
fetch(https://api.example.com/*)
mcp__chrome__take_*         MCP tools of the chrome server whose name starts with take_
```

**How a line is judged.** A shell line is split into its segments (chains, pipelines, `$(...)`, `bash -c`). A `deny` rule that matches **any** segment denies the line; else an `ask` rule that matches any segment asks; else the line is allowed when **every** segment is readable and either matches an `allow` rule or a [built-in allow](#built-in-allows). An opaque segment is never allowed by a rule. A segment that redirects output (except to `/dev/null`) is matched by an `allow` rule only when the pattern names the redirect (`>`). Non-shell tools: deny, then ask, then allow rule, then built-in allow.

**Exec flags.** An allow rule on a program that hands the rest of the line to another program allows more than it says: `Bash(find *)` allows `find . -exec rm {} \;`, `Bash(ssh *)` allows `-o ProxyCommand=...`, `Bash(git *)` allows `--upload-pack=...`. Spell the flags out (`Bash(find . -name *)`), or deny them with a `deny` rule. The remember step never proposes a rule for a segment that carries `-e`, `-c`, `-x`, `-exec`, `-execdir`, `--exec`, `--upload-pack` or `-o ProxyCommand`; it remembers the sentence only.

## The prose whitelist

`classifier.allow` and `classifier.deny` hold plain sentences that describe a *type* of request. The classifier reads them; nothing else does. Entries are up to 300 characters. They are numbered in the order of the merged files: allow entries `A1`, `A2`, ..., deny entries `D1`, `D2`, ..., and `/foreman perms list` shows the numbers and the file each came from.

```json
"classifier": {
  "allow": [
    "Deploy to the namespace staging of the kubectl context stage-eu.",
    "Install npm packages that the repository's package.json already lists."
  ],
  "deny": [
    "Never publish packages from this machine."
  ]
}
```

Write what you would tell a colleague: name the target (host, namespace, package, path) and the kind of action. An entry that is too general ("deploys are fine") lets the classifier clear things you did not mean; one that is too narrow escalates to the dialog, which costs a click. Deny entries are written by you only: the remember step never writes one, and the tracked file may carry them (`classifier.deny`) because they only tighten.

The classifier sees only these sentences, never your pattern rules. A deny sentence is final at its level: the call is denied with `pi-foreman: denied by whitelist rule D1: <sentence>`.

## The steps

Every call goes through these steps, in this order. Each step ends the call or passes it on.

1. **Parse.** `shellast.ts` parses `bash` input with `unbash` into segments: the commands of chains, pipelines, `$(...)`, backticks and subshells, `bash -c`/`sh -c`/`eval` with a literal string, and the wrappers `env`, `timeout`, `nice`, `nohup`, `xargs`, `time`, `command`, `stdbuf`, `setsid`, `watch`, `flock -c`. Each segment has its argv, redirect targets, heredoc presence and effective cwd. Variables resolve only through the closed grammar of [Variables in bash lines](#variables-in-bash-lines). A segment the walker cannot state exactly is **opaque**: an unresolved variable, a glob in a target, a process substitution, a runner with a non-literal script, nesting deeper than 4, a parser error, a function definition, `alias`, `trap`, an assignment outside a short allowlist of harmless names, a shell fed by heredoc or stdin, and PowerShell or cmd. The `powershell` tool is one opaque segment. Quoted string arguments of a parsed segment are data, not commands.
2. **Floors.** A deny with a reason that names the allowed alternative. No model, no dialog, no rule, no mode lifts it. See [Floors](#floors). One kind of floor hit asks instead of denying: a text match on an opaque line (below).
3. **Self-modification rules.** Writes that change how Pi or pi-foreman runs (the project's `.pi/settings.json`, the agent `settings.json`, pi-foreman session state, the session dir) are a dialog by rule, never cleared by the classifier and never run under mode `allow`. A child or headless session is denied with the rule name.
4. **Deny rules.** A matching `deny` rule denies.
5. **Ask rules.** A matching `ask` rule opens the dialog (no remember option). An opaque-line floor ask (an opaque line that names a permissions file, a child push, a git config key, a remote, a force or protected-branch push, or the foreman config next to a gate key) opens the dialog here too.
6. **Allow rules and built-in allows.** The line is allowed when every segment matches an `allow` rule or a [built-in allow](#built-in-allows).
7. **Dangerous class.** What is left is checked against the [dangerous class](#the-dangerous-class).
8. **Mode.** What is left is decided by the [mode](#modes): not dangerous runs under `auto` and `allow`, asks under `ask`, is denied under `deny`; dangerous goes to the classifier (`auto`), the dialog (`ask`), runs (`allow`) or is denied (`deny`).
9. **Dialog or deny.** An escalation opens the [owner dialog](#the-owner-dialog), in a child's case in the parent's pane. With nobody to ask it is a deny that says the owner is absent.
10. **Decision log.** Every decision is one JSON line. See [Decision log](#decision-log).

A handler failure denies (fail safe). A call with no session to decide it in is denied.

## Modes

`mode` is one of `auto`, `ask`, `allow`, `deny`. The mode is only the last step: floors, self-modification rules, `deny` rules, `ask` rules and the built-in and rule allows come before it in every mode.

| Mode | A call no rule decided | A dangerous-class call |
|---|---|---|
| `auto` (default) | runs | the classifier; what it cannot clear opens the dialog |
| `ask` | opens the dialog | opens the dialog (no classifier call) |
| `allow` | runs | runs (no classifier call, so whitelist deny sentences do not apply) |
| `deny` | denied: `pi-foreman: denied: permissions mode is deny (no rule allows this call)` | denied the same way |

**Resolution order.** Session override (`/foreman perms mode`) > profile mode > user file mode > `auto`. The project and tracked files cannot set a mode. An invalid user file reads as `ask`. The footer shows `perms: <mode>` whenever the mode is not `auto`.

`gate.mode: "floors-only"` (a temporary switch of an earlier release) is retired: a session that still has it shows a notice and runs as mode `allow`, a session override that `/foreman perms mode` replaces. Remove the key.

A child takes the mode, the session override and the profile of its launch.

## The dangerous class

A built-in table in `defaults.ts` (`DANGER_RULES`). A call that falls into one entry is dangerous: no built-in allow ever covers it, and under mode `auto` the classifier answers for it. An `allow` or `deny` rule of yours decides before the table is consulted. The first matching entry names the call in logs, dialogs and the classifier prompt.

| Id | What it matches | Example that matches |
|---|---|---|
| `danger-write-outside` | A path tool or a shell write (redirect, write-class command) outside the worktree, the session's scratch dir and the OS temp dir (`gate.tmpAccess`) | `cp build.zip ~/Desktop/`, `write` to `/etc/hosts` |
| `danger-deploy` | `ssh`; `scp`, `sftp`, `rsync` with a remote operand; `kubectl`/`oc` with a verb other than get, describe, logs, explain, version, `config view`; `helm` install, upgrade, uninstall, rollback; `terraform`/`tofu` apply, destroy, import; `pulumi` up, destroy; `ansible*`; `docker`/`podman` push, run, exec, rm, compose up/down/restart; `systemctl`, `service`, `launchctl` verbs other than the read ones; `crontab` edit; `gcloud`, `aws`, `az`, `flyctl`, `vercel`, `netlify`, `wrangler` with a non-read verb | `kubectl apply -f deploy.yaml` |
| `danger-forge` | `gh`/`glab` verbs other than the read set (`pr create\|view\|list\|diff\|checks\|status`, `issue view\|list`, `repo view\|clone`, `run view\|list\|watch\|download`, `release view\|list\|download`, `auth status`, `config get\|list`, `search`); `gh api` with a non-GET method, fields or input, or a GraphQL `mutation` | `gh pr merge 42` |
| `danger-publish` | `npm`/`pnpm`/`yarn`/`bun` publish, `cargo publish`, `twine upload`, `gem push`, `docker push`, `gh release upload` | `npm publish` |
| `danger-net-write` | `fetch` with a method other than GET/HEAD or a body; `curl` with a method other than GET/HEAD, `-d`/`--data*`, `-F`, `-T`, `--json`; `wget --post-*`; `http`/`xh` with a body or write method; `nc`, `ncat`, `socat`; a `curl`/`wget`/`fetch` download that the [web read](#web-reads) checks refuse (auth material, a URL with userinfo, output not going to scratch or a reader) | `curl -X POST https://example.com/hook -d @body.json` |
| `danger-install` | `npm`/`pnpm`/`yarn`/`bun` install, i, ci, add, remove, `dlx`; `npx`, `bunx`, `uvx`; `pip`/`pip3`/`uv pip` install; `python -m pip install`; `cargo`/`gem` install; `brew` verbs other than the read ones; `apt`, `apt-get`, `dnf`, `yum`, `pacman`, `choco`, `winget`, `scoop` install and remove | `npm install left-pad` |
| `danger-git` | `reset --hard`, `clean -f`, a `checkout` or `restore` that discards changes, `branch -d/-D`, a `push` to a URL instead of a remote name, `rebase`, `commit --amend` on a branch with an upstream, `stash drop\|clear`, `worktree remove\|prune`, `filter-branch`, `filter-repo`, `reflog expire`, `gc --prune` | `git reset --hard HEAD~3` |
| `danger-process` | `kill`, `pkill`, `killall`, `taskkill`, `chown`, `mount`, `chmod -R`, `defaults write\|delete`, `reg add\|delete`, `launchctl load\|unload`, detaching (`nohup`, `setsid`, `disown`, a trailing `&`) outside `bg_run` | `pkill -f server` |
| `danger-inject` | `herdr pane send-keys\|send-text`, `tmux send-keys` and `osascript` keystrokes with ordinary text (slash commands and bare keys are a [floor](#floors)) | `herdr pane send-text 2 'please rerun the tests'` |
| `danger-opaque` | Any segment the parser cannot state exactly, once the floors found nothing | `eval "$cmd"` |
| `danger-mcp-act` | An MCP tool whose name is not a read (`list_*`, `get_*`, `search_*`, `read_*`, `take_*`, `find_*`, `describe_*`; `navigate_page` to a plain URL) | `mcp__chrome__click` |
| `danger-launch-outside` | A `subagent` launch with a `cwd` or worktree outside the owned roots, or a workflow script, `tasks` or `chain` form | `subagent` with `cwd: "/srv/other-repo"` |

Everything else that no rule decides is safe under `auto`: reads of unfloored paths, GET fetches, `curl` and `wget` reads, build and test commands, in-worktree writes, routine git (including a push of the own branch to a named remote and merges), `gh pr create`, `pr_create` (the ceremony's PR gate and reviewer PASS still apply), intercom, `foreman_session_open`, harness tools. `codemode` is not special: each call its script makes passes the gate on its own.

## The classifier

One cheap model call for a dangerous-class call under mode `auto`. It exists to answer one question: does one of **your** sentences plainly cover this call?

- **When it runs.** Only for dangerous-class calls in mode `auto`, after the rules found nothing. Never for a floor, a self-modification rule, an ask rule, a pattern-rule match or a role launch. With no whitelist entries at all it does not run and the call goes straight to the dialog.
- **What it sees.** A fixed system text; the allow and deny sentences (`A1..`, `D1..`), each fenced as data with the file it came from; the dangerous-class reason; the session kind, role, cwd, worktree, branch and remotes; your last message (cut to 600 characters, fenced); and the command in fences with a random nonce. Never tool output, never your pattern rules, never earlier history. The sentences, your message and the command are data: nothing in them instructs the model.
- **What it may answer.** One JSON object `{"verdict": "allow"|"deny"|"escalate", "entry": "A3"|"D1"|null, "reason": "<=200 chars"}`. `allow` runs only when it cites an existing **allow** entry; `deny` denies only when it cites an existing **deny** entry (text: `pi-foreman: denied by whitelist rule D1: <sentence>`). Every other answer escalates to the dialog: an uncited verdict, a cited entry of the wrong kind or an unknown id, extra fields, invalid JSON, a timeout, a provider error or no model. The model never allows on its own judgment.
- **Cache.** An allowed call is cached for the session by tool and exact payload, so the identical call does not ask again. `/foreman perms reload` and every remember write clear the cache.
- **Timeout.** `gate.reviewTimeoutMs` (default 15000, minimum 100). A timeout escalates.
- **Model.** The `review` rung of the role map (`providers.<p>.roles.review.model`, `roles.review`), the inexpensive rung by default; the config key keeps its name from the older gate. The call uses no prompt cache and its usage is logged with role `classifier`.
- **No model configured.** The dangerous class asks you directly. `/foreman doctor` and `/foreman setup` print `WARN no classifier model for provider <p>: ...` and the first dangerous call of a session shows the same text once as a notice naming the key to set. A child or headless session denies such a call.

## Built-in allows

A built-in allow is a named rule that allows without a model. A shell line is allowed by built-ins only when every segment matches one and none is opaque; a segment in the dangerous class never matches. The shipped rules (`defaults.ts`):

| Rule | Allows |
|---|---|
| `default-own-tool` | pi-foreman's own tools that carry no file path and no shell or message payload: `plan_mode_question`, `plan_mode_complete`, `ask_user_question`, `foreman_ledger`, `foreman_triage`, `foreman_checkpoint`, `foreman_dialogs`, `foreman_wait`, `contact_supervisor`, `subagent_supervisor`, `bg_wait`, `bg_status`, `bg_logs`, `bg_kill`, `pr_status`, `pr_checks`, `pr_comments`, `pr_watch`, `pr_track`, `pr_untrack`, `git_status`, `git_log`, `git_diff_stat`, `git_branch_state`, `subagents_enable` |
| `default-role-launch` | the foreman session's own single `subagent` launch of one of `explorer`, `planner`, `builder`, `reviewer`, `senior-reviewer`, `finalizer`, with no `action`, `tasks`, `chain` or `workflow`, and a `cwd`/`worktree` inside the owned roots. The adapter's role, ceremony and spawn gates run after the gate and still refuse a launch they refuse. A launch outside the owned roots, a workflow script and the `tasks`/`chain` forms are `danger-launch-outside` |
| `default-read` | the read class of `effects.ts` (`ls`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `find`, print-only `sed`, ...) on paths inside the session's roots |
| `default-build-test` | the project's own build and test commands from its manifest, run from the worktree (not a dependency install) |
| `default-write-in` | `mkdir`, `touch`, `cp`, `mv`, `rm`, `tee` inside the worktree, scratch and `/tmp` (`gate.tmpAccess`, default on) |
| `default-git-read`, `default-git-add`, `default-git-commit` | read-only git; `add`; `commit` with a message (secrets-in-commit still runs; an amend of a branch with an upstream is dangerous) |
| `default-git-fetch`, `default-git-pull` | `fetch`; `pull --ff-only` |
| `default-git-switch` | `switch`/`checkout` of the own branch |
| `default-git-push` | `git push [-u] origin <own branch>\|HEAD` with an empty environment prefix, and no force, delete, mirror, tag, `:` refspec, `-o`, `--repo`, `--receive-pack`, `--exec`, `-c`, or `remote.origin.push`. The own branches are the cwd branch and the branches checked out in the other worktrees of the same repository. Never for a child (floor) |
| `default-gh-read` | read-only `gh`/`glab` (`run view\|list`, `pr view\|checks\|diff\|list\|status`, `issue view\|list`, `repo view`, `api` with no method, no GraphQL and no `-f/-F/--input`; `run download` only into scratch) |
| `default-assign` | the closed allowlist of harmless assignments |
| `builtin-web-read` | a plain download, see [Web reads](#web-reads) |
| `path-read-*`, `path-write-*` | the path tools, computed from the session's roots, see [Owned paths](#owned-paths) |

Children get the same built-ins minus pushes, parent `.workflow` writes and anything outside their worktree.

### Owned paths

Path tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `foreman_move`, `foreman_copy`) go through `pathrules.ts`. The allowed places are computed at runtime from the session's roots:

- the worktree, the session's scratch dir and the OS temp dirs (`gate.tmpAccess`; for a child only its own `$FOREMAN_SCRATCH`);
- reads of the Pi install dir, the global npm root, the bundled package roots and the owned roots (state dirs, handoffs, sibling worktrees, your `additionalDirectories`);
- the registered parent's `.workflow` dir, read-only, for a session opened by another session;
- the session's own handoff dir: `plan.md` and `result.md` may be written;
- a child never writes a handoff dir's `parent` or `child` files, the parent's `.workflow`, or anything outside its own worktree and scratch dir, and never opens a pull or merge request (`pr_create`, `gh pr create`, `glab mr create`). These child denies run before any allow rule, built-in allow or classifier verdict, in every mode.

A path write outside every root is `danger-write-outside`. Secret paths are floors and never reach this step.

### Web reads

A plain download needs no dialog. `fetch` GET/HEAD, or `curl`/`wget` writing into scratch (or to stdout read by a reader such as `head`, `grep`, `jq`), passes four deterministic checks:

- (a) GET/HEAD only: no body, no upload, no other method, an http(s) URL;
- (b) no auth or cookie material (`-u`, `-n`, `@file` headers, `Authorization`, `Cookie`), no userinfo in the URL;
- (c) nothing runs the download: no pipe or substitution into a shell or interpreter, no config file;
- (d) the output goes into scratch (`-o` with `--output-dir` is resolved), or to a non-executing reader.

A candidate that passes is a read: it runs under every mode but `deny` with no classifier call. A candidate that fails is `danger-net-write`. There is no host list. Loopback hosts (`127.0.0.1`, `::1`, `localhost`, any port) are plain URLs here: a GET to them is a read. Starting a local app is a different call and follows the normal rules. Running a downloaded file is a normal call too.

### Variables in bash lines

`shellvars.ts` resolves `$NAME` / `${NAME}` only when every statement of the line is in a closed grammar: a sole `NAME=literal` assignment of a plain absolute path (or a `$FOREMAN_SCRATCH` prefix), or a simple command from a fixed list of programs with plain words, `$NAME` words, `2>&1`, `>/dev/null` or one plain redirect target. Anything else leaves the variable unresolved and the segment opaque. The cases are pinned by `tests/fixtures/shellvars-grammar.json` and `tests/fixtures/shellvars-cases.json`.

### Split literals

The git guard (`scripts/git_guard.py`, also for the main role) denies, never asks, a bash line whose quoted, ANSI-C or escaped pieces of one word (`'.g''it'`) or whose `"a"+"b"` literal chain spell a guarded path component (`.git`, `.git.`, `GIT~1`, any case) that no single piece spells; the reason is `split literal reassembles a guarded token`. For a child the guard also denies string fragments joined by `+`, `..`, `.concat(...)`, `[...].join(...)` or `.replace(All)` whose reassembly is a whole guarded command token (`rm`, `dd`, `git`, `push --force`, `reset --hard`, ...). Cases: `tests/fixtures/split-literal-cases.json`.

## Floors

Floors deny with a reason and no model call, for every session kind and every mode. No config key turns them off, and there is no dialog. They run on the raw text of every tool before parsing and again on the parsed segments, so an unparseable command can be denied but never allowed by default.

- secrets and key paths (`~/.ssh`, `~/.gnupg`, `~/.aws`, cloud and kube credentials, `.env`, `.npmrc`, `.pypirc`, `.netrc`, git credential stores, Pi's auth file) for read and write;
- writes to the three `permissions.json` files (matched by the basename below a `.workflow` or `.pi` directory too, so `mv x .workflow/permissions.json` is caught), pi-foreman's config files when the line carries a `safety.permissions*`, `safety.policy*` or `gate.*` key, `managed.json`, `state/round-parents.json`, `state/bridge-trust.json`, `state/approvals/**`, `state/gate/**`, Pi session files, and (for any child tool write) `state/child-asks/**`. Reading `permissions.json` is not a floor, and a read-only look at the config file is fine;
- force, mirror and delete pushes, pushes to the default or a protected branch, and **any `git push` from a subagent child** (children never push; the foreman pushes). Only parsed `git push` segments count: the word inside a quoted string, a heredoc body or a read-only interpreter snippet is data;
- `git config` of the keys listed in `extensions/core-adapter/git-floor-keys.json` (hooksPath, sshCommand, credential helpers, `url.*.insteadOf`, remote urls, push configuration), in every form: `git config` in any scope, the `-c key=value` prefix, `--config-env`, `GIT_CONFIG_*` environment words, and `git remote add|set-url|rename|remove|set-branches|set-head`; `core.attributesFile` outside `.workflow/` or with a verb other than `merge`;
- deletes and recursive overwrites outside the session's worktree, scratch and `/tmp`; `rm` of `/`, home or a system dir;
- `sudo`, `su`, `doas`; shutdown, disk formatting, `dd` to a device;
- whole-filesystem scans (`find /`, `grep -r ... /`, `du /`, `ls -R /`);
- a download piped into a shell; package publish (`publish`, `twine upload`, `docker push`, `gh release create|upload|edit|delete`, ...);
- **`terminal-inject`**: typing into another terminal pane (`herdr pane send-keys|send-text`, `tmux send-keys`, `osascript` keystrokes) is denied when any line of the payload starts with `/` (a slash command), the payload is 2 characters or fewer (a dialog answer) or a token is a key name (`Enter`, `Escape`, `Tab`, `Space`, arrows, `C-x`, `M-x`, `F1`, ...). Such input would drive the dialogs and commands of another session, which only its owner may do. Ordinary text longer than that is `danger-inject`;
- **`perms-profile`**: a shell line that sets or exports `PI_FOREMAN_PERMS_PROFILE`, or passes `--profile` to `foreman session open` or `foreman_session.py`. The profile is the owner's choice, made in the owner's own terminal;
- the existing guards, unchanged: the git guard, the shell-write guard, the destructive guard, secrets-in-commit, `protect.deny`, `childDeny`, own-ruling writes and foreign session dirs.

**Opaque-text matches ask instead of denying.** On a line the parser could not state exactly, a text match for a child push, a git config key, a remote change, a force or protected-branch push or a permissions file asks the owner (never the classifier, never run under mode `allow`). The same words on a parsed segment are a deny. The `rawFloors` list (download piped into a shell, privilege, shutdown, disk, `GIT_CONFIG_*`, `--config-env`), publish and `rm` of system dirs stay denies on the raw text.

**The honest gap.** A non-opaque script or snippet that *itself* deploys (a `./deploy.sh` that calls `kubectl apply`, a Python file that posts to an API) is just a command the parser reads: the gate judges the line, not the file's contents, so under `auto` it runs unless a rule says otherwise. The same holds for a build or test command whose scripts do something dangerous. Put such scripts behind an `ask` rule (`"ask": ["Bash(./deploy.sh *)"]`) if that matters to you. This is an owner decision, not a bug: a script the agent runs (`./x.sh`, `npm run x`, `make x`) is routine under `auto`, and the gate and the floors read only the command text, never the script body.

## The owner dialog

When a call escalates and a human is at the pane, `pi-foreman: <tool> asks` opens a select dialog. The title carries the cause, the classifier's reason if it escalated, the cwd and the **full command**, heredoc bodies included. The cause is one of: `danger-<name>: <reason>`, `rule <text>` (an ask rule), `no rule matches` (mode `ask`), `self-modification <rule>` or a floor-ask text.

A command of up to 60 lines is shown whole. A longer one shows its first 40 and last 20 lines plus a line naming a trace file `<agentDir>/pi-foreman/state/gate-ask-<n>.txt` that holds the full text. Control characters are shown as `?`. The text that reaches the agent never hides anything.

| Option | Result |
|---|---|
| allow once | the call runs; nothing is stored |
| allow and remember | the call runs and the owner may store a sentence (and a pattern rule); offered for dangerous-class escalations only |
| deny with comment | the call is denied with `pi-foreman: denied by the user: <your text>`, which the agent reads |
| deny and stop | the call is denied and the agent is told to stop and ask what to do next |

A dismissed dialog is a deny. A repeated identical deny is handled as before (`repeatedDeny`).

**Allow and remember.**

1. If the project file may not widen (it is tracked, not ignored, or a symlink), the dialog says why, names `.git/info/exclude`, and the call runs once without writing.
2. A select shows the proposed sentence, written from the call (`Run "kubectl" "apply" against the host ... in the namespace "staging"`; variable parts quoted and capped at 80 characters): `use this sentence`, `edit the sentence` (opens an editor prefilled; up to 300 characters) or `cancel` (denies).
3. Only when a complete pattern rule can be derived (every segment readable, no exec flag), a second select asks `also add pattern rule Bash(kubectl apply *)?` yes or no.
4. The write goes to the **project file** (`classifier.allow`, and `allow` for the rule), preserving the file's other keys and order. The permission files are reloaded, the classifier cache is cleared, the call runs.

Self-modification, ask-rule and floor-ask dialogs, and mode-`ask` dialogs for calls outside the dangerous class, offer no remember option.

## Presence

A dialog never waits for a fixed time while you are at the machine. Before it opens, the gate refreshes the presence sample (`presence.*`, the same idle-input probe that gates cache warms; see [cache](cache.md#presence-gate)):

- **Away** (no keyboard or mouse input for `presence.awayAfterMinutes`) denies at once with `pi-foreman: denied: the owner is away from the machine ... The owner is absent; do not wait or retry, report this line and continue with what you can.`
- Otherwise the dialog opens with an abort signal. A watchdog re-probes every 60 seconds; if you turn away while the dialog is open it closes and the call is denied with the same text.
- A probe that fails or has no data is `unknown`, which counts as present. `presence.enabled: false` turns the probe and the watchdog off.
- A session opened with `--machine` probes the idle time of the remote machine, not of the machine you sit at.

## Session kinds and who answers

| Kind | What it is | Who answers an escalation |
|---|---|---|
| owner | a pane with a human and no parent | a dialog in the pane |
| session opened by another session | a session started with `foreman session open` | a dialog in its own pane |
| child | a subagent run (builder, reviewer, ...) | its parent, see below |
| headless | no UI (print or json mode) | nobody: the call is denied at once |

With nobody to ask, the agent reads: `pi-foreman: denied: nobody is at this session (no pane). The owner is absent; do not wait or retry, report this line and continue with what you can.` A floor is never asked.

### Child asks

`gate.childAsk` is `"parent"` (default) or `"deny"`. A child's gate runs the same steps with the mode, profile and session override of its launch. When a child's call escalates (a dangerous-class call the classifier could not clear, an ask rule, a self-modification hit is denied outright for a child) and `gate.childAsk` is `parent`:

1. When the parent adapter launches a child it creates an ask dir `<agentDir>/pi-foreman/state/child-asks/<parent session id>/<launch id>/` and passes it in the launch binding. The child gate writes `ask.md` there with `fs`, never through a tool: the cause (`danger-<name>`, `rule <text>`, `no rule matches`), the reason line, tool, cwd, role, run and the **whole** command. It then waits for `ruling-<n>.md`.
2. A floor denies any child tool write under `state/child-asks/`, so a child can never write its own ruling. A ruling is accepted only as `ruling-<n>.md` for an `n` the child gate itself wrote, with an mtime not before its ask. A stale ruling is ignored.
3. The parent adapter polls the ask dirs of its running children (500 ms) and opens **one dialog in the parent's own pane** naming the child role and run, the tool, the full command, the cause and the classifier's reason. Remember is offered for dangerous-class asks. A parent that has no UI writes `DENY`.
4. Dialogs from several children queue, one at a time. A child that has timed out drops its pending dialog; a late answer is logged, not applied.
5. `ALLOW` lets the call run once. Anything else, or the deadline, denies. The parent model never answers a child ask.

The child stops waiting after `gate.askTimeoutMs` (default 900000, 15 minutes), sooner when the parent's presence turns away. With `"deny"`, or when the binding has no ask dir (a headless parent), the child is denied with a text that tells it to report to the foreman.

A parent's remember applies to its running children, which re-read the permission files at each decision.

## Profiles

A profile is a named set of rules that an owner selects for a session. Profiles are owner-selected only: there is no tool parameter.

- **Where defined.** The `profiles` key of the user `permissions.json` (same shape as the file: `mode`, `allow`, `ask`, `deny`, `additionalDirectories`, `classifier`), plus the built-in `steward`.
- **How selected.** `foreman session open <label> <brief> --profile <name>` on the command line (it sets `PI_FOREMAN_PERMS_PROFILE` in the new session), or the config key `permissions.profile` in the user, organisation or default config layer (a project or session layer value is dropped with a notice). The command-line choice wins over the key. An unknown name is refused and the refusal lists the known names; `--profile` with `--machine` is refused.
- **Effect.** The profile's lists are added to the user file's; its `mode`, when set, wins over the user file's. A child of a profiled session inherits the profile. An agent cannot select a profile: the `perms-profile` floor denies setting the variable or passing the flag from a shell line.
- **`steward`.** Runs mode `auto` (ask-free) and allows `herdr pane send-text`, `herdr pane send-keys`, `herdr pane read`, `herdr pane list`, `pgrep`, `ps` and `intercom`. The limit: a steward can type a prompt into another pane, but the `terminal-inject` floor stops it from answering dialogs, pressing keys or running slash commands there.

## Commands

All in the owner pane of the session:

- `/foreman perms mode` shows the mode and where it came from. `/foreman perms mode auto|ask|allow|deny` sets the session override until the session ends or you set it again (a child cannot change it).
- `/foreman perms reload` re-reads the files and clears the classifier cache; it prints notices about bad entries.
- `/foreman perms list` shows the mode, every merged pattern rule with its file, every sentence with its number (`A1..`, `D1..`) and file, and the additional directories.
- `/foreman doctor` prints the classifier model, the mode and counts, the decision-log path, and warns about an invalid user file, a tracked or unignored project file, and leftover keys of the older gates.

## Decision log

One JSON line per gate decision in `<agentDir>/pi-foreman/state/gate/log.jsonl`: `id, ts, session, kind (owner|child|headless), role, tool, layer, verdict, rule, reason, shape, cwdHash`, plus `latencyMs`, `model` and `cached` when a model decided.

| Layer | Written when | `rule` holds |
|---|---|---|
| `floor` | a floor or a self-modification rule denied | the floor or rule name |
| `rule` | a pattern rule decided | the pattern text |
| `default` | a built-in allow | the built-in name |
| `classifier` | the classifier allowed, denied or escalated | `prose:A3`, `prose:D1`, or the escalation cause |
| `cache` | the classifier's cached allow was reused | `prose:A3` |
| `mode` | the mode decided (no rule, dangerous under `allow` or `deny`) | `mode:no-rule`, `mode:allow:danger-...`, `mode-deny` |
| `dialog` | an owner answered | the `danger-*` name or the cause |
| `child-ask` | a parent answered or timed out for a child | the run id and the outcome |

Lines of the older gate (`review`, `autoreview` usage role) stay readable. `shape` is the normalised, redacted command: program and option words kept, literal paths reduced to a class (`<worktree>/...`, `<scratch>/...`, `<tmp>/...`, `<home>/...`, `<parent>/.workflow/...`, `<abs>`), URLs to the host, every quoted string and secret-like value replaced by `<v>`. The log rotates to `log.1.jsonl` at `gate.logMaxBytes` (default 20 MB). Classifier calls are logged to the usage log with role `classifier`; the trace carries `guard`, `dialog` and `review` events.

## Config keys

The permission policy lives in `permissions.json`; these are the `foreman.json` keys around it.

| Key | Meaning | Project layer |
|---|---|---|
| `permissions.profile` | the profile name to run with (string or null), see [Profiles](#profiles) | ignored with a notice |
| `gate.reviewTimeoutMs` | classifier call timeout (default 15000, minimum 100) | lower only |
| `gate.askTimeoutMs` | how long a child waits for its parent's ruling (default 900000); nothing else uses it | lower only |
| `gate.childAsk` | `parent` (default) or `deny` | `deny` only |
| `gate.tmpAccess` | writes (the owner also reads) under the OS temp dirs (default true) | `false` only |
| `gate.logMaxBytes` | log rotation size | user or overlay only |
| `gate.mode` | retired: `floors-only` means mode `allow` and shows a notice; remove it | user or overlay only |
| `providers.<p>.roles.review`, `roles.review` | the classifier model | user or overlay only |
| `safety.preBash` | pre-bash hooks | user or overlay only |
| `gate.policy.userFile`, `safety.policy.files` | removed, see [Migration](#migration) | no effect |

Every other `gate.*` key is user or overlay only; a project value is dropped with a warning. A project cannot remove a user `deny` rule: project and tracked lists add to the user's.

## Known limits

- Another extension loaded before the gate, or one that mutates `event.input` after it, could change the input between the decision and the execution. The gate is first in load order; the doctor warns when any extension precedes it.
- Extension-registered providers: the classifier call goes through Pi's registry, so a provider an extension registers at runtime must be loaded before the first classification.
- The `bash` tool is parsed as bash. When the resolved shell is not a bash binary (a custom `shellPath`, or the Unix `sh` fallback) the gate treats the tool as opaque.
- The decision is made on the command string, not at run time: another local user can swap a `/tmp` path for a symlink in between.
- Git config in the repository (`diff.external`, a pager) still applies to `git diff` and `git log`.
- Windows: shell writes to the system temp dir are dangerous class; no default-allowed tmp on win32 yet.
- The gate judges a command line, not the files it runs (see the honest gap under [Floors](#floors)). Under mode `allow` the classifier does not run, so whitelist deny sentences do not apply; `deny` rules and floors still do.

## Windows

The `bash` tool on native Windows runs Git Bash, so the bash AST applies as on Linux and macOS. The optional `powershell` tool has no parser: every `powershell` call is opaque. The floors run on its raw text (with the PowerShell-aware shell-write grammar), then it is `danger-opaque`, never a built-in allow. Inside a bash line, `powershell`, `pwsh`, `cmd`, `cmd.exe`, `wsl` and any invocation of a `.ps1`, `.cmd` or `.bat` file are opaque segments. On win32 a path has two spellings (backslashes, 8.3 short names such as `RUNNER~1`); `effects.ts` `realSpelling()` compares the real spellings, so a read root stored by its realpath still matches, and `pathnorm.ts` is the one normaliser the floors, the path rules and the pattern rules share. `/tmp` never counts on Windows. The gate tests run on the three CI operating systems with path fixtures for both separators and drive letters.

## Parser and prior art

The gate parses with `unbash` 6 (pinned exact, upgraded only with the tests green). Its AST types are isolated in `shellast.ts`, because the v5 to v6 change shows node shapes can move.

| Option | Install | Platforms | Accuracy | Verdict |
|---|---|---|---|---|
| `unbash` 6 (ISC) | one dependency, pure TypeScript, no transitive deps | Windows-neutral pure JS | GNU Bash 5.3 syntax, typed AST with positions, tolerant parser with a partial AST plus errors; zsh, PowerShell and cmd unsupported (documented) | **chosen**: about 15x faster than tree-sitter wasm, no native or wasm build |
| `tree-sitter-bash` over `web-tree-sitter` (wasm) | grammar plus wasm runtime; what the old permission package used | wasm, any platform | full grammar | not chosen: wasm dependency, about 15x slower |
| a regex or quote-aware splitter (the old `shellchain.ts`) | none | any | splits on `&&`, `||`, `;`, `|`; refuses `$(`, backticks, subshells and heredocs | not chosen: refuses most real lines; kept only as a thin layer over the AST |

Packages that build on `unbash` were considered and not used (`pi-bouncer`, `@cad0p/pi-steering` with `@cad0p/unbash-walker`, `pi-access-guard`, `pi-guards`): each pins an older `unbash`, none covers the rule files, role-aware built-ins, parent reads or the ask-to-parent flow, and running one beside the gate would double the dialogs. Two designs come from `pi-bouncer` as reference: its always-deny set and rule names, and its rule that an unparseable command is never allowed. pi-foreman writes its own small walker (`shellast.ts`) instead of depending on `unbash-walker`. The pattern-rule syntax follows the Claude Code permission rules.

## Developing pi-foreman itself

When the session's working directory is the package root or inside it (symlinks resolved; case-insensitive on Windows and macOS), the write protection of the package root narrows to the config files (`config/permissions*.json`, `config/foreman.defaults.json`, `package.json`); other writes in the checkout (docs, extensions, tests, scripts) pass. The session writes a `protect_selfhost` trace event.

## Migration

### From the review-model gate

The gate that asked a review model to judge every undecided call against policy prose is replaced. What changes for you:

| Before | Now |
|---|---|
| `<agentDir>/pi-foreman/policy.md`, `config/permissions.policy.md`, `<cwd>/.workflow/policy.md` with `## allow/deny/ask` entries | not read. Move the entries into `permissions.json`: allow sentences to `classifier.allow`, deny sentences to `classifier.deny`, ask-style entries to `ask` rules |
| `gate.policy.userFile` | removed |
| `safety.policy.files[]` | removed |
| the review model judged every undecided call | undecided calls run under `auto`; the classifier sees only the dangerous class and only clears what a sentence of yours covers |
| `foreman perms candidates`, `export-eval`, `/foreman perms adopt`, the live eval | gone; the remember step in the dialog grows the whitelist |
| `ask.md` from a session opened by another session to its parent for a gate ask | gone; such a session asks in its own pane. The handoff files `plan.md`, `ruling.md`, `result.md` and `brief-<n>.md` stay |
| `gate.mode: "floors-only"` | retired; maps to mode `allow` with a notice. Set `"mode": "allow"` in `permissions.json` |
| `gate.askTimeoutMs` | now only bounds how long a child waits for its parent |

`foreman setup` prints one line per removed key it finds: `<key>: removed (policy files are no longer read; rules and the whitelist live in permissions.json)`, and names a leftover user `policy.md` once: `<path>: policy.md is no longer read; move its entries into permissions.json classifier.allow/deny`. `/foreman doctor` prints a `FAIL` line for a leftover key and warns about an invalid `permissions.json` and a tracked project file. A first permissions file can be as short as `{ "mode": "auto" }`, or empty of keys; the dangerous class and the dialog do the rest.

### From the permission package

This release line removed `@gotgenes/pi-permission-system`. `foreman setup` migrates the user's `foreman.json` keys and prints one line per key:

| Old key | New |
|---|---|
| `providers.<p>.review.model` | `providers.<p>.roles.review.model` |
| `providers.<p>.review.timeoutMs` | `gate.reviewTimeoutMs` |
| `safety.permissions.autoReview.rulesFile` | removed (policy files are no longer read) |
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

It backs up `settings.json` to `state/migration/settings.json.pre-gate` and drops the package entry. The doctor prints a `FAIL` line per leftover (a leftover key, the rendered permission config, the package entry, a package install) with the fix.

**The way back** is the previous pi-foreman release: install it (`npm install pi-foreman@<previous>`), copy the backups back (`foreman.json.pre-gate` over your `foreman.json`, `permission-system-config.json` back to `<agentDir>/extensions/pi-permission-system/config.json`, and `settings.json.pre-gate` over `settings.json` if you ran the settings step), and run its `foreman setup`. The previous release rejects `gate.*` keys, so the backup copy is the way back, not an automatic restore.
