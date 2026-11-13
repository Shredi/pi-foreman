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
| user | `<agentDir>/pi-foreman/permissions.json` | every key, including `mode`, `profiles`, `workFolders` and `floors` |
| project | `<main checkout>/.workflow/permissions.json` | everything except `mode`, `profiles`, `workFolders` and `floors` (see the trust rule) |
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
- **`floors.noteTools`** (user file and its profiles only; a project or tracked file's value is dropped with the usual notice): a list of tool names whose prose fields are notes, not commands, so the raw-text floors skip them. Built-in list, always on: `scratchpad` (note in `text`) and `memory_write` (note in `content`), the note tools of the public `pi-memory` package. The key adds to it (there is no removal), and it goes **by tool name**: any extension that registers a tool of a listed name gets the exemption. Only the prose fields (`text`, `content`, `note`, `message`, `markdown`, `brief` and the other free-text names of the gate) are exempt; path-like fields keep the secret-path floor and every other string field keeps the raw-text floors. Example: `{ "floors": { "noteTools": ["my_journal_add"] } }`.
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
   **Protected targets.** A call that touches a [protected target](#protected-targets) (and passed the floors, the self-modification rules and the deny rules) goes to the protected check instead of the ask rules, the allow rules, the dangerous class and the mode.
5. **Ask rules.** A matching `ask` rule opens the dialog (no remember option). An opaque-line floor ask (an opaque line that names a permissions file, a child push, a git config key, a remote, a force or protected-branch push, or the foreman config next to a gate key) opens the dialog here too.
6. **Allow rules and built-in allows.** The line is allowed when every segment matches an `allow` rule or a [built-in allow](#built-in-allows).
7. **Dangerous class.** What is left is checked against the [dangerous class](#the-dangerous-class).
8. **Mode.** What is left is decided by the [mode](#modes): not dangerous runs under `auto` and `allow`, asks under `ask`, is denied under `deny`; dangerous goes to the classifier (`auto`), the dialog (`ask`), runs (`allow`) or is denied (`deny`). A not dangerous call that [work folders](#work-folders) relax runs under `auto` when the mode is `ask` or `deny` and was not set by a session override.
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
| `danger-git` | `reset --hard`, `clean -f`, a `checkout` or `restore` that discards changes, `branch -d/-D` (except a merged branch: `default-git-branch-merged`), a `push` to a URL instead of a remote name, `rebase`, `commit --amend` on a branch with an upstream, `stash drop\|clear`, `worktree remove\|prune`, `filter-branch`, `filter-repo`, `reflog expire`, `gc --prune`; for both roles the program-running options `--upload-pack` on `fetch`, `pull` and `clone` (and clone's `-u`), `--receive-pack` and `--exec` on `push` (every spelling git accepts, shortened ones included), and the verbs `send-pack`, `http-push` and `credential fill`; for a subagent only, the forms that move, overwrite or delete a branch, ref, tag or worktree entry shared with the main checkout: `update-ref`, `prune`, `reflog delete`, `tag -d\|--delete`, `branch -f\|--force\|-m\|-M\|--move\|-C`, `switch -C\|--force-create`, `checkout -B`, `worktree add -B`, `worktree move`. Floors come first. Not a complete list | `git reset --hard HEAD~3` |
| `danger-process` | `kill`, `pkill`, `killall`, `taskkill`, `chown`, `mount`, `chmod -R`, `defaults write\|delete`, `reg add\|delete`, `launchctl load\|unload`, detaching (`nohup`, `setsid`, `disown`, a trailing `&`) outside `bg_run` | `pkill -f server` |
| `danger-inject` | `herdr pane send-keys\|send-text`, `tmux send-keys` and `osascript` keystrokes with ordinary text (slash commands and bare keys are a [floor](#floors)) | `herdr pane send-text 2 'please rerun the tests'` |
| `danger-opaque` | Any segment the parser cannot state exactly, once the floors found nothing | `eval "$cmd"` |
| `danger-mcp-act` | An MCP tool whose name is not a read (`list_*`, `get_*`, `search_*`, `read_*`, `take_*`, `find_*`, `describe_*`; `navigate_page` to a plain URL) | `mcp__chrome__click` |
| `danger-launch-outside` | A `subagent` launch with a `cwd` or worktree outside the owned roots, or a workflow script, `tasks` or `chain` form | `subagent` with `cwd: "/srv/other-repo"` |

Everything else that no rule decides is safe under `auto`: reads of unfloored paths, GET fetches, `curl` and `wget` reads, build and test commands, in-worktree writes, routine git (including a push of the own branch to a named remote, from the session's checkout or a worktree it created, and merges), `gh pr create`, `pr_create` (the ceremony's PR gate and reviewer PASS still apply), intercom, `foreman_session_open`, harness tools. `codemode` is not special: each call its script makes passes the gate on its own.

## The classifier

One cheap model call for a dangerous-class call under mode `auto`. It exists to answer one question: does one of **your** sentences plainly cover this call?

- **When it runs.** Only for dangerous-class calls in mode `auto`, after the rules found nothing. Never for a floor, a self-modification rule, an ask rule, a pattern-rule match or a role launch. With no whitelist entries at all it does not run and the call goes straight to the dialog.
- **What it sees.** A fixed system text; the allow and deny sentences (`A1..`, `D1..`), each fenced as data with the file it came from; the dangerous-class reason; the session kind, role, cwd, worktree, branch and remotes; your last message (cut to 600 characters, fenced); and the command in fences with a random nonce. Never tool output, never your pattern rules, never earlier history. The sentences, your message and the command are data: nothing in them instructs the model.
- **What it may answer.** One JSON object `{"verdict": "allow"|"deny"|"escalate", "entry": "A3"|"D1"|null, "reason": "<=200 chars"}`. `allow` runs only when it cites an existing **allow** entry; `deny` denies only when it cites an existing **deny** entry (text: `pi-foreman: denied by whitelist rule D1: <sentence>`). Every other answer escalates to the dialog: an uncited verdict, a cited entry of the wrong kind or an unknown id, extra fields, invalid JSON, a timeout, a provider error or no model. The model never allows on its own judgment.
- **Cache.** An allowed call is cached for the session by tool and exact payload, so the identical call does not ask again. `/foreman perms reload` and every remember write clear the cache. The [protected check](#protected-targets) has its own prompt, verdicts and cache; it never reads these.
- **Not for protected targets.** A call that matches a protected target runs the protected check, not this classifier.
- **Timeout.** `gate.reviewTimeoutMs` (default 15000, minimum 100). A timeout escalates.
- **Model.** The `review` rung of the role map (`providers.<p>.roles.review.model`, `roles.review`), the inexpensive rung by default; the config key keeps its name from the older gate. The call uses no prompt cache and its usage is logged with role `classifier`.
- **No model configured.** The dangerous class asks you directly. `/foreman doctor` and `/foreman setup` print `WARN no classifier model for provider <p>: ...` and the first dangerous call of a session shows the same text once as a notice naming the key to set. A child or headless session denies such a call.

## Built-in allows

A built-in allow is a named rule that allows without a model. A shell line is allowed by built-ins only when every segment matches one and none is opaque; a segment in the dangerous class never matches. The shipped rules (`defaults.ts`):

| Rule | Allows |
|---|---|
| `default-own-tool` | pi-foreman's own tools that carry no file path and no shell or message payload: `plan_mode_question`, `plan_mode_complete`, `ask_user_question`, `foreman_ledger`, `foreman_triage`, `foreman_checkpoint`, `foreman_dialogs`, `foreman_script` (its own owner dialog is the control), `foreman_wait`, `contact_supervisor`, `subagent_supervisor`, `bg_wait`, `bg_status`, `bg_logs`, `bg_kill`, `pr_status`, `pr_checks`, `pr_comments`, `pr_watch`, `pr_unwatch`, `git_status`, `git_log`, `git_diff_stat`, `git_branch_state`, `subagents_enable` |
| `default-role-launch` | the foreman session's own single `subagent` launch of one of `explorer`, `builder`, `reviewer`, with no `action`, `tasks`, `chain` or `workflow`, and a `cwd`/`worktree` inside the owned roots. The adapter's role, ceremony and spawn gates run after the gate and still refuse a launch they refuse. A launch outside the owned roots, a workflow script and the `tasks`/`chain` forms are `danger-launch-outside` |
| `default-read` | the read class of `effects.ts` (`ls`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `find`, print-only `sed`, ...) on paths inside the session's roots |
| `default-build-test` | the project's own build and test commands from its manifest, run from the worktree (not a dependency install) |
| `default-write-in` | `mkdir`, `touch`, `cp`, `mv`, `rm`, `tee` inside the worktree, scratch and `/tmp` (`gate.tmpAccess`, default on) |
| `default-git-read`, `default-git-add`, `default-git-commit` | read-only git; `add`; `commit` with a message (secrets-in-commit still runs; an amend of a branch with an upstream is dangerous) |
| `default-git-fetch`, `default-git-pull` | `fetch`; `pull --ff-only` |
| `default-git-switch` | `switch`/`checkout` of the own branch |
| `default-git-branch-merged` | `git branch -d\|-D <b>` (one plain name, no other flag) when `<b>` is merged (its tip is in `origin/<default>`, or its PR is `MERGED` at that tip), is not the default or a protected branch, and the repo is not a work folder outside the worktree. No current-branch condition, because the gate judges a post-merge chain before it runs. Never for a child |
| `default-git-push` | `git push [-u] origin <own branch>\|HEAD` with an empty environment prefix, and no force, delete, mirror, tag, `:` refspec, `-o`, `--repo`, `--receive-pack`, `--exec`, `-c`, or `remote.origin.push`. The own branch is the branch checked out in the worktree the push runs in: the cwd after a `cd`, or the `-C <path>` of `git -C <path> push ...` (its branch, protected-branch and push-config facts are those of that worktree). That worktree must be the session's own checkout or a worktree this session created (the session manifest); a linked worktree it did not create is not own, and a push from it is no default. A push from a second worktree of the session (`cd <wt> && git push -u origin <b>`, `git -C <wt> push origin <b>`) is routine even when `<wt>` lies outside the session's roots. A branch checked out in another worktree of the session stays own. Never for a child (floor) |
| `default-gh-read` | read-only `gh`/`glab` (`run view\|list`, `pr view\|checks\|diff\|list\|status`, `issue view\|list`, `repo view`, `api` with no method, no GraphQL and no `-f/-F/--input`; `run download` only into scratch) |
| `default-assign` | the closed allowlist of harmless assignments |
| `builtin-web-read` | a plain download, see [Web reads](#web-reads) |
| `path-read-*`, `path-write-*` | the path tools, computed from the session's roots, see [Owned paths](#owned-paths) |

Children get the same built-ins minus pushes, parent `.workflow` writes and anything outside their worktree.

Details of the read and write rows:

- **Quoted pattern words.** A `grep`, `egrep`, `fgrep` or `rg` segment is still a read when its only unknown words (`$PAT`, `$(...)`) are double-quoted strings in a pattern position or the value of an option that does not name a file (`grep -n "$PAT" src/a.ts`, `rg --type "$T" foo src/`). A `$(...)` word there is no longer opaque, but the line is not a default read either: the inner command is judged on its own (`$(sudo id)` still hits the `privilege` floor). An unquoted unknown word, an unknown path operand or redirect target, a file option (`-f`, `--file`) and a wrapper keep the segment opaque. `sed` and `awk` are excluded: their script text is the pattern position and the gate cannot tell a read-only script from a writing one when it is unknown. The floors read the line as written; only the allow step relaxes the words.
- **The null device.** A redirect to `/dev/null` (`>/dev/null`, `2>/dev/null`, `&>/dev/null`) is no write on every platform. `NUL` in any case (`>NUL`, `2>nul`) is the null device on win32 only; on macOS and Linux it names a file, so it is a write like any other.
- **`rm` of a symlink.** A plain `rm`, `unlink` or `rmdir` (no `-r`, no trailing slash) is judged on the link itself, not on its target, wherever the write roots are checked.
- **Local `npx`.** `npx <bin>` is not `danger-install` when it runs a bin that is already installed: the segment's directory is known, the nearest ancestor holding a `package.json` has `node_modules/.bin/<bin>` (or `<bin>.cmd`), and the line has no `-p`/`--package`, no `@version`, no `--yes` and no path-like bin name. It is never a default allow: it runs under the mode step like any call that no rule decides. Any other `npx` stays an install.

### Read tools

The path tools `read`, `grep`, `find` and `ls` are judged on their path field. An extension tool that reads files is an ordinary tool to the gate until the user names it in `gate.readTools`, a map from the tool name to the name of its path field (`null` when it has no path field and reads the cwd). A mapped tool is then judged like `read`/`grep` on that field: `Read(...)` rules cover it, the secret-path floor applies to the field (search patterns such as `pattern` or `patterns` are not paths and are not floored; `glob` is), and a path inside the session's roots or an owned path gets the `path-read-*` allow. Example for pi-fff:

```json
{ "gate": { "readTools": { "ffgrep": "path", "fffind": "root" } } }
```

The key is user or overlay config only; a project value is dropped with the usual warning. The names of the built-in tools (the path tools including `foreman_move` and `foreman_copy`, the shell tools and pi-foreman's own tools) cannot be remapped: such an entry is ignored and named in the same `config_warning` record (`ignored`). A mapped tool keeps the secret-path floors on all its other path-like fields (`paths`, `root`, `file`, arrays), exactly as when unmapped. A name in the map that no registered tool carries (for example `ffgrep` while pi-fff runs in `override` mode, which registers `grep`, `find` and `multi_grep`) is ignored and leaves one `config_warning` trace record per session; it never fails a call.

### Owned paths

Path tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `foreman_move`, `foreman_copy`) go through `pathrules.ts`. The allowed places are computed at runtime from the session's roots:

- the worktree, the session's scratch dir and the OS temp dirs (`gate.tmpAccess`; for a child only its own `$FOREMAN_SCRATCH`);
- reads of the Pi install dir, the global npm root, the bundled package roots and the owned roots (state dirs, handoffs, sibling worktrees, your `additionalDirectories`);
- the registered parent's `.workflow` dir, read-only, for a session opened by another session;
- the session's own handoff dir: through the path tools the session may write `plan.md` and `result.md`; a subagent child may also write `ask.md`/`ask-<n>.md`, `.ask`, `.seen`, `.steer-last-read.json` and anything below `work/` in its launch's handoff dir; everything else there (the bare `work` entry included) belongs to the parent. The session's own shell guard (`shell_write_guard.py`) applies the longer list to the handoff dir where that session is the child side (its `PI_FOREMAN_HANDOFF_DIR`), when it has one. On Windows names are compared case-folded; streams and 8.3 names are refused;
- a child never writes a handoff dir's `parent` or `child` files, the parent's `.workflow`, or anything outside its own worktree, scratch dir and those handoff names, and never opens a pull or merge request (`pr_create`, `gh pr create`, `glab mr create`). These child denies run before any allow rule, built-in allow or classifier verdict, in every mode.

A path write outside every root is `danger-write-outside`. Secret paths are floors and never reach this step.

**The foreman's checkout (`child-write-foreman-checkout`).** A child launched through a single `subagent` call knows the foreman's checkout (`FOREMAN_CHECKOUT` in its launch binding). A shell write of the child that lands inside that checkout, its `.workflow/` included, is a deny named `child-write-foreman-checkout`: a redirect, a write-class operand (`cp`, `mv`, `tee`, ...), a git write verb run from it or given `-C`, `--git-dir` or `--work-tree` for it, and `git clone` into it. The reason says the foreman's files change through the foreman and points the child at its own worktree and `$FOREMAN_SCRATCH`. Reads are never fenced (`cat`, `ls`, `grep`, `git status`, `git log` on the checkout pass the fence). The read-only `git branch` list forms (`--show-current`, `-a`, `-r`, `-v`, `-vv`, `--list`) and `git stash list|show` without `--output`, `git worktree list` (`--porcelain`, `-v`, `-z`), the `git config` read forms (`--get`, `--get-all`, `--get-regexp`, `--list`, `<key>`) and the `git tag` list forms (bare, `-l`, `-n[N]`, `--contains`, `--points-at`, `--merged`, `--sort`, `--format`) name no write target, also under `git -C <dir>` or after `cd <dir> &&`, so they are no `child-write-outside` either; `git stash` alone, `stash push|pop|drop|clear|apply`, `branch -d|-D|-m|-f`, `branch <name>`, `worktree add|remove|prune`, `config <key> <value>`, `config --unset`, and `tag <name>`, `tag -d|-a|-s|-f` still do. The child's own worktree and scratch dir are never part of it, so a worktree nested inside the checkout stays the child's own. Write and edit tool paths into the checkout are not named separately: they get the general `child-write-outside`.

**Realpath comparison.** The child's scratch dir and the checkout are each compared in two spellings, the one in the launch binding and its realpath (a symlinked temp dir such as macOS `/var` -> `/private/var`), and the target of a write is compared in its real spelling too. A `cd` or redirect through either spelling of the scratch dir is a write-in; a link inside the scratch dir that leads out of it is not. A scratch dir or target that does not exist yet is compared through its deepest existing ancestor plus the missing tail, on both sides, so `mkdir -p` into a run dir not yet created is a write-in in either spelling. A `cp` source is a read: only the destination (the last operand, or `-t DIR`) is a write target, while an `mv` source is deleted and stays a write. On Windows the comparison folds case and treats `\`, `/` and the `C:` drive forms alike; on Linux it compares case exactly.

### Work folders

`workFolders` in the **user** file names folders you work in (`~/git`, `~/notes`). A project or tracked file cannot set it (the dropped-key notice names it), and neither can a profile.

```json
{ "workFolders": [{ "path": "~/git", "mode": "auto" }, { "path": "~/notes", "mode": "read" }] }
```

- **Reads.** Every read inside a folder (either mode) is a built-in allow, `.git` included; floors still guard secret files. Path tools and shell reads (`cat`, `ls`, `grep`) alike. Children get none. Folders relax reads only: `git add`, `commit`, `push`, `pull`, `fetch` and `switch` in a repo inside a folder keep their usual rule (no built-in allow outside the worktree and scratch).
- **`mode: "auto"`** (default when omitted) also relaxes a write that no other root covers: it is not `danger-write-outside`, and when the resolved mode is `ask` or `deny` it runs as under `auto`. With the mode `auto` or `allow` it runs without the classifier. `mode: "read"` leaves writes as they are. Any other value warns and counts as `read`.
- **Protected places stay as they are**, in every spelling (symlinks, `.GIT`): a `.git` directory, `.pi` (except its `scratch` and `tasks` subtrees), the agent dir, the Pi install dirs and the pi-foreman package root.
- **Shell writes** relax only when every segment is a built-in default with the folders as extra write roots: `touch`, `mkdir` and `cp` into a folder. Output redirects (`echo x > <folder>/notes.txt`) keep the worktree's parity: they stay `danger-write-outside`, like a redirect into the worktree. `tee` and `tar -x -C` / `unzip -d` / `rsync` / `patch -d` / `make -C` are never defaults, and `rm` and `mv` keep today's behaviour, so they stay `danger-write-outside`.
- **Never consulted** for a dangerous-class call, a path in two folders or in one folder and outside it, a `/foreman perms mode` session override, or a floors-only session. Nested folders: the innermost entry wins. A worktree inside a folder keeps its own rules.
- **Validation.** `~` expands; a relative path, the filesystem root, your home dir and any parent of it are dropped with a warning; a folder outside your home dir is kept with a warning. `/foreman perms list` prints a Work folders block with the folders, modes, the real spelling when it differs, and the warnings. The allowed trace event reads `mode:folder:auto` with `mode` and `source: workFolder` and no path.

### Web reads

A plain download needs no dialog. `fetch` GET/HEAD, or `curl`/`wget` writing into scratch (or to stdout read by a reader such as `head`, `grep`, `jq`), passes four deterministic checks:

- (a) GET/HEAD only: no body, no upload, no other method, an http(s) URL;
- (b) no auth or cookie material (`-u`, `-n`, `@file` headers, `Authorization`, `Cookie`), no userinfo in the URL;
- (c) nothing runs the download: no pipe or substitution into a shell or interpreter, no config file;
- (d) the output goes into scratch (`-o` with `--output-dir` is resolved), or to a non-executing reader.

A candidate that passes is a read: it runs under every mode but `deny` with no classifier call. A candidate that fails is `danger-net-write`. There is no host list. Loopback hosts (`127.0.0.1`, `::1`, `localhost`, any port) are plain URLs here: a GET to them is a read. Starting a local app is a different call and follows the normal rules. Running a downloaded file is a normal call too.

### Variables in bash lines

`shellvars.ts` resolves `$NAME` / `${NAME}` only when every statement of the line is in a closed grammar: a sole `NAME=literal` assignment of a plain absolute path (or a `$FOREMAN_SCRATCH` prefix), or a simple command from a fixed list of programs with plain words, `$NAME` words, `2>&1`, `>/dev/null` or one plain redirect target. Anything else leaves the variable unresolved and the segment opaque. The cases are pinned by `tests/fixtures/shellvars-grammar.json` and `tests/fixtures/shellvars-cases.json`.

For a **child session** with a scratch dir, two more cases resolve outside that grammar, so a line with a heredoc, a pipe or other statements is no longer opaque for these variables alone:

- **One literal assignment.** `NAME=/abs/path` or `NAME=$FOREMAN_SCRATCH[/sub]` at the start of a statement (line start, after `;` or a newline, or after `&&` following another such assignment: not in a pipeline, subshell, group, loop, function, `$(...)` or after `||`) resolves later `$NAME` and `${NAME}` words. `NAME` is assigned exactly once and the line mentions it in no other way (no `export`, `read`, `for NAME`, `${NAME:-x}`, no use before the assignment). It does not apply when the line runs `eval`, `source`, a function definition, a runner or a computed program name. `$PWD`, `~` and `$HOME` are not forms of it.
- **`$FOREMAN_SCRATCH` itself** resolves on a heredoc or pipe line too, as long as the line mentions `FOREMAN_SCRATCH` only as `$FOREMAN_SCRATCH` or `${FOREMAN_SCRATCH}` and never rebinds it, under the same code-running guard.

The foreman and an opened session never get these two.

### Split literals

For a child, the overlay denies, never asks, a script file the child runs when it joins string fragments with `+`, `..`, `.concat(...)`, `[...].join(...)` or `.replace(All)` (and, in a script file, `String.fromCharCode` or base64 literals) into a whole guarded command token (`rm`, `dd`, `git`, `push --force`, `reset --hard`, ...); the reason is `split literal reassembles a guarded token`. A bash line is not checked for this: a quoted path spelled in pieces is joined by the parser and read like the plain path, and a line the parser cannot read is judged. Cases: `tests/fixtures/split-literal-cases.json`.

## Floors

Floors deny with a reason and no model call, for every session kind and every mode. No config key turns them off, and there is no dialog. They run on the raw text of every tool before parsing and again on the parsed segments, so an unparseable command can be denied but never allowed by default.

- secrets and key paths (`~/.ssh`, `~/.gnupg`, `~/.aws`, cloud and kube credentials, `.env`, `.npmrc`, `.pypirc`, `.netrc`, git credential stores, key files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `id_rsa*`, `id_ecdsa*`, Pi's auth file) for read and write; the key-file name globs are one list, `config/secret-paths.json` (a JSON array of globs, `*` is any run of characters inside one path segment), read by this floor and by `scripts/foreman_sync.py`; overlays can read the same file. The one exception is a read of an SSH public key: a `*.pub` file directly in `<home>/.ssh` (not in a subdirectory), whose real path is also directly in the real `~/.ssh` and whose content is a regular file of at most 16 KiB with every line starting with an OpenSSH public key type. A symlink or hardlink to a private key, a missing file or any other content stays denied, and so does every write, move, remove or copy onto it. It passes the floor and the built-in `*/.ssh/*` path rule (a rule that names `.pub` still denies) and is traced as `floor-pubkey-read`. When the file cannot be read, both fall back to the same list built into the code;
- writes to the three `permissions.json` files (matched by the basename below a `.workflow` or `.pi` directory too, so `mv x .workflow/permissions.json` is caught), pi-foreman's config files when the line carries a `safety.permissions*`, `safety.policy*` or `gate.*` key, `managed.json`, `state/round-parents.json`, `state/bridge-trust.json`, `state/approvals/**`, `state/gate/**`, Pi session files, and (for any child tool write) `state/child-asks/**`. Reading `permissions.json` is not a floor, and a read-only look at the config file is fine;
- force, mirror and delete pushes, pushes to the default or a protected branch, and **any `git push` from a subagent child** (children never push; the foreman pushes). Only parsed `git push` segments count: the word inside a quoted string, a heredoc body or a read-only interpreter snippet is data;
- a delete (`rm`, `unlink`, `rmdir`, `find -delete`, `rsync --delete`) outside the worktree, scratch and `/tmp` is `floor-delete-outside`. A plain `rm`, `unlink` or `rmdir` of a symbolic link is judged on the link, not on what it points to: removing the `node_modules` link of a worktree is inside the worktree even though the link leads out;
- `git config` of the keys listed in `extensions/core-adapter/git-floor-keys.json` (hooksPath, sshCommand, credential helpers, `url.*.insteadOf`, remote urls, push configuration), in every form: `git config` in any scope, the `-c key=value` prefix, the values of `git clone -c` and `--config` (shortened and clustered spellings included), `--config-env`, `GIT_CONFIG_*` environment words, and `git remote add|set-url|rename|remove|set-branches|set-head`; `core.attributesFile` outside `.workflow/` or with a verb other than `merge`;
- deletes and recursive overwrites outside the session's worktree, scratch and `/tmp`; `rm` of `/`, home or a system dir;
- `sudo`, `su`, `doas`; shutdown, disk formatting, `dd` to a device;
- whole-filesystem scans (`find /`, `grep -r ... /`, `du /`, `ls -R /`);
- a download piped into a shell; package publish (`publish`, `twine upload`, `docker push`, `gh release create|upload|edit|delete`, ...);
- **`terminal-inject`**: typing into another terminal pane (`herdr pane send-keys|send-text`, `tmux send-keys`, `osascript` keystrokes) is denied when any line of the payload starts with `/` (a slash command), the payload is 2 characters or fewer (a dialog answer) or a token is a key name (`Enter`, `Escape`, `Tab`, `Space`, arrows, `C-x`, `M-x`, `F1`, ...). Such input would drive the dialogs and commands of another session, which only its owner may do. Ordinary text longer than that is `danger-inject`;
- **`perms-profile`**: a shell line that sets or exports `PI_FOREMAN_PERMS_PROFILE`, or passes `--profile` to `foreman session open` or `foreman_session.py`. The profile is the owner's choice, made in the owner's own terminal;
- **`perms-adopt`**: a shell line that runs `foreman perms adopt` (any `foreman` spelling) or `permssuggest-cli.ts adopt`. Adoption writes your user permissions file and is your command in your own terminal or pane; an agent runs `foreman perms suggest` and hands you the report;
- the existing guards, unchanged: the shell-write guard, the destructive guard, secrets-in-commit, `protect.deny`, `childDeny`, own-ruling writes and foreign session dirs.

**Opaque-text matches.** On a line the parser could not state exactly, a text match for a child push, a git config key, a remote change, a force or protected-branch push or a policy or config file (`policy-file`, `config-keys`) cannot be told from quoted prose, so what happens depends on the session kind:

- **Child:** a deterministic deny with the hint "Rephrase without a variable or loop, or let the foreman do it." A child never asks its parent about a text-only hit.
- **Owner or an opened session:** a dialog (never the classifier, never run under mode `allow`).

The same words on a parsed segment are a deny for every kind. The `rawFloors` list (download piped into a shell, privilege, shutdown, disk, `GIT_CONFIG_*`, `--config-env`), publish and `rm` of system dirs stay denies on the raw text, with one rule for the three program floors below.

**Restart, privilege and disk tools: one rule.** `sudo`, `su`, `doas`, `pkexec`; `shutdown`, `reboot`, `halt`, `poweroff`; `mkfs*`, `fdisk`, `sfdisk`, `parted`, `wipefs`, `diskpart` are judged by the **program of each parsed segment** (wrapper-stripped: `env`, `xargs`, `nohup`, `timeout`, `nice`, `command`, `time`, `sh -c`, `eval`, subshells, `$( )`, backticks, `if`/`while`/`for`/`case` bodies, absolute paths, `.exe`, quoted or escaped spellings). The command-position word match for these three groups applies only to a line that is **not clean**: the parse failed, a segment is opaque (a function body, `exec`, `coproc`, `[[ ]]`, a variable as the program), a segment feeds text to an interpreter (a shell or runner given code, `-exec`), or the line carries a here-document or here-string whose body the text scan below does not blank (any program but `cat`/`tee`: a shell, `at`, `docker exec -i c sh`, `make -f -`, `git commit -F -` alike; no list of interpreters is kept). A clean line is read by its programs alone, so a search such as `grep -rn a\|reboot src` (an escaped pipe before a word) passes. The price: on a clean line there is no second net against a parser mistake. Lines no judge reads as the program stay open (remote login, `docker exec`, `find -exec`, `telinit`, `busybox <applet>`, an alias then its call, `eval "$x"`, text piped into a shell, `powershell -Command`, `cmd /c`); they are pinned as documented gaps in `g8-matrix.test.ts`. Every other raw entry (download into a shell, `dd` to a device, injected git config, profile, adopt) is unchanged.

**Script source is not word-matched.** The source of a `codemode` script is no longer scanned as raw text; its structured path fields keep the secret-path floor, and so does every other string field of the `codemode` input (only `code` is exempt). What a script does is decided call by call: every tool call it makes goes through Pi's nested tool pipeline (`tool_call` with a `parentToolCallId`), where this gate applies the floors, rules, dangerous class and classifier to it like a direct call. That rests on two things, both stated as risks: the runner of the pinned Pi range (`1.5.x`, enforced at setup) gating nested calls, and the exemption going by the tool name `codemode` (a different extension registering a tool of that name that runs its text itself would not be word-matched). Probe after a Pi update: a script with one nested shell call carrying a floored line must be refused.

**Notes are not commands.** The prose fields of `foreman_show` (`markdown`) and `foreman_session_open` (`brief`), and of the note tools above, skip the raw-text floors. A command or a path in any other field of those tools is floored as before; MCP tools and every unlisted tool keep the raw-text floors on all fields.

**Denial text.** A floor denial keeps its sentence and appends the tool and the matched fragment: `... No review, policy entry or dialog lifts this floor. (tool: bash; matched: reboot)`. The fragment is the regex match (raw and opaque-text floors), the program and the operand that decided (segment floors) or the path as written (path and secret-path floors, never file content), cut to 80 characters with control characters removed. It is the agent's own text. The decision log carries it as `fragment`, written through the same redacting field writer as `tool`.

What the text floors read, so that data is not mistaken for a command:

- **Masked text.** Every text floor reads the line with its data blanked: the body of a `cat` or `tee` heredoc (the `privilege` floor included, so a `sudo` inside a note is no hit even when the same line then runs the file it wrote), and quoted strings. A heredoc body fed to a shell or interpreter (`bash <<EOF`, `python3 - <<EOF`, `cat <<EOF | bash`) stays visible. Quoted strings stay visible when a segment of the line runs text: a shell or interpreter with `-c`/`-e`, a runner such as `xargs`, `awk`, `ssh`, `osascript`, `deno eval|run`, `find -exec`.
- **`git` in command position only.** A `git push`, `git config` or `git remote` counts at the start of a statement, after a shell keyword (`do`, `then`, `if`, ...) or a wrapper (`env`, `xargs`, `timeout`, `sudo`, ...), with git's own options (`-C <dir>`, `-c k=v`, `--git-dir`) before the verb. A line that runs text or builds its program through `$(...)` has no known command position, and there `git` counts anywhere.
- **Search patterns are not paths.** The secret-path floor skips the pattern of `grep`, `egrep`, `fgrep` and `rg` (the first operand and `-e` values), and the script of `sed` and the program of `awk` only when it can only read (a sed script with `w`, `r`, `e`, `a`, `i` or `c` commands, or an awk program with redirection, a pipe, `getline` or `system`, is not skipped). `-f`/`--file` values and every other operand stay paths. `rg --files` and `rg --type-list` take no pattern, so every operand of those is a path.

**The honest gap.** A non-opaque script or snippet that *itself* deploys (a `./deploy.sh` that calls `kubectl apply`, a Python file that posts to an API) is just a command the parser reads: the gate judges the line, not the file's contents, so under `auto` it runs unless a rule says otherwise. The same holds for a build or test command whose scripts do something dangerous. Put such scripts behind an `ask` rule (`"ask": ["Bash(./deploy.sh *)"]`) if that matters to you. This is an owner decision, not a bug: a script the agent runs (`./x.sh`, `npm run x`, `make x`) is routine under `auto`, and the gate and the floors read only the command text, never the script body. The gap is still open. Beside it there is one approved path for a change the guards close to every agent: `foreman_script`, where the owner approves a script in a dialog and the harness runs it (see [safety](safety.md#owner-scripts)); it does not close the gap, and nothing reads that script's body either.

## The owner dialog

When a call escalates and a human is at the pane, `pi-foreman: <tool> asks` opens a select dialog. The title carries the cause, the classifier's reason if it escalated, the cwd and the **full command**, heredoc bodies included. The cause is one of: `danger-<name>: <reason>`, `rule <text>` (an ask rule), `no rule matches` (mode `ask`), `self-modification <rule>` or a floor-ask text.

A command of up to 60 lines is shown whole. A longer one shows its first 40 and last 20 lines plus a line naming a trace file `<agentDir>/pi-foreman/state/gate-ask-<n>.txt` that holds the full text. Control characters are shown as `?`. The text that reaches the agent never hides anything.

| Option | Result |
|---|---|
| allow once | the call runs; nothing is stored |
| allow and remember | the call runs and the owner may store a sentence (and a pattern rule); offered for dangerous-class escalations only |
| allow and remember this exact command | the call runs and one exact rule per segment, `Bash(<program> <args>)` without a wildcard, goes into the project file's `allow`; no sentence is written. Offered next to *allow and remember* only when every segment is readable (no opaque segment), no segment redirects output except to `/dev/null` (that redirect is dropped from the rule) and no word carries a glob character (`*`, `?`, parentheses) |
| deny with comment | the call is denied with `pi-foreman: denied by the user: <your text>`, which the agent reads |
| deny and stop | the call is denied and the agent is told to stop and ask what to do next |

A dismissed dialog is a deny. A repeated identical deny is handled as before (`repeatedDeny`).

**Allow and remember.**

1. If the project file may not widen (it is tracked, not ignored, or a symlink), the dialog says why, names `.git/info/exclude`, and the call runs once without writing; the same wording (the call ran once, nothing was stored) follows every refused write (an untrusted file, invalid JSON, a key that is not a list, a write error, an invalid rule).
2. A select shows the proposed sentence, written from the call (`Run "kubectl" "apply" against the host ... in the namespace "staging"`; variable parts quoted and capped at 80 characters): `use this sentence`, `edit the sentence` (opens an editor prefilled; up to 300 characters) or `cancel` (denies).
3. Only when a complete pattern rule can be derived (every segment readable, no exec flag), a second select asks `also add pattern rule Bash(kubectl apply *)?` yes or no.
4. The write goes to the **project file** (`classifier.allow`, and `allow` for the rule), preserving the file's other keys and order. The permission files are reloaded, the classifier cache is cleared, the call runs.
5. A notice names the project (the name of the main checkout, then the file path) and the stored sentence and rule. The file is always the one of the session that shows the dialog, wherever the command ran. When the session's mode without its session override is not `auto`, the notice adds that the sentence is only used under mode `auto` and which mode the sessions here otherwise run.

**Allow and remember this exact command.** The rule is the normalised text of each segment (single spaces, quotes stripped), so `git commit -m "a b"` is stored as `Bash(git commit -m a b)`. The same project-file trust check as above applies; if it fails the call runs once. Rules are written one by one: if a later one is refused, the notice lists the rules stored and the rules not stored. A per-segment rule matches that segment wherever it stands: also inside other lines (`git fetch origin && make deploy` is covered for its `git fetch origin` segment) and from other directories. It does not make a line allowed unless every segment of that line is covered.

Self-modification, ask-rule and floor-ask dialogs, and mode-`ask` dialogs for calls outside the dangerous class, offer no remember option.

## Presence

A dialog never waits for a fixed time while you are at the machine. Before it opens, the gate refreshes the presence sample (`presence.*`, the same idle-input probe that gates cache warms; see [cache](cache.md#presence-gate)):

- **Away** (no keyboard or mouse input for `presence.awayAfterMinutes`) denies at once with `pi-foreman: denied: the owner is away from the machine ... The owner is absent; do not wait or retry, report this line and continue with what you can.`
- Otherwise the dialog opens with an abort signal. A watchdog re-probes every 60 seconds; if you turn away while the dialog is open it closes and the call is denied with the same text.
- A probe that fails or has no data is `unknown`, which counts as present. `presence.enabled: false` turns the probe and the watchdog off.
- A session opened with `--machine` probes the idle time of the remote machine, not of the machine you sit at.
- Away applies to a real ask only: a dialog of an owner or opened session, or a child's wait for its parent's ruling. A floor decision (a deny, or a built-in or rule allow) is deterministic: it runs no presence probe and is never turned into the away text, whether the owner is away or not.

## Session kinds and who answers

| Kind | What it is | Who answers an escalation |
|---|---|---|
| owner | a pane with a human and no parent | a dialog in the pane |
| session opened by another session | a session started with `foreman session open` | a dialog in its own pane |
| child | a subagent run (builder, reviewer, ...) | its parent, see below |
| headless | no UI (print or json mode) | nobody: the call is denied at once |

With nobody to ask, the agent reads: `pi-foreman: denied: nobody is at this session (no pane). The owner is absent; do not wait or retry, report this line and continue with what you can.` A child whose parent has a pane but whose asks are off reads a different text (see Child asks). A floor is never asked.

### Child asks

`gate.childAsk` is `"parent"` (default) or `"deny"`. A child's gate runs the same steps with the mode, profile and session override of its launch. When a child's call escalates (a dangerous-class call the classifier could not clear, an ask rule, a self-modification hit is denied outright for a child) and `gate.childAsk` is `parent`:

1. When the parent adapter launches a child it creates an ask dir `<agentDir>/pi-foreman/state/child-asks/<parent session id>/<launch id>/` and passes it in the launch binding. The child gate writes `ask.md` there with `fs`, never through a tool: the cause (`danger-<name>`, `rule <text>`, `no rule matches`), the reason line, tool, cwd, role, run and the **whole** command. It then waits for `ruling-<n>.md`.
2. A floor denies any child tool write under `state/child-asks/`, so a child can never write its own ruling. A ruling is accepted only as `ruling-<n>.md` for an `n` the child gate itself wrote, with an mtime not before its ask. A stale ruling is ignored.
3. The parent adapter polls the ask dirs of its running children (500 ms) and opens **one dialog in the parent's own pane** naming the child role and run, the tool, the full command, the cause and the classifier's reason. Remember is offered for dangerous-class asks; when the parent's own mode is `allow` a sentence would never be used, so only the exact-command rule is offered there. A parent that has no UI writes `DENY`.
4. Dialogs from several children queue, one at a time. A child that has timed out drops its pending dialog; a late answer is logged, not applied.
5. `ALLOW` lets the call run once. Anything else, or the deadline, denies. The parent model never answers a child ask.

The child stops waiting after `gate.askTimeoutMs` (default 900000, 15 minutes), sooner when the parent's presence turns away. A child denied because child asks are off (its own `gate.childAsk` is `"deny"`, or its parent launched it with them off) reads `pi-foreman: denied: this call needs the owner's answer and child asks are off (gate.childAsk is "deny"). Report this line to the foreman, who can run it or ask the owner. The call was: <cause>.` A child whose parent has no pane (a headless parent) reads the no-pane text above, followed by `The call was: <cause>.` Both are denies; nothing else about the decision changes.

A parent's remember applies to its running children, which re-read the permission files at each decision.

**What a child never asks about.** A child's parent is never asked about a text-only floor hit on a line the parser could not read (a push, a git config key, a remote, a policy or config file): that is the deterministic deny with the rephrase hint described under [Floors](#floors). A line that only reads (every program in the read class, no runner, no inline code, no output redirect except an fd dup or the null device) is not stopped by the `policy-file` and `config-keys` text floors, so `ls -la config/` is decided locally and does not ask. A loop (`for f in config/*.json; do grep -n foo "$f"; done`) binds no variable: its body stays opaque, hence dangerous class, for a literal list and for one the gate cannot read (`for f in $(ls)`) alike, and it opens no dialog. A heredoc into the child's own scratch dir that names `git config` in its body is data and does not ask either. Only the cases in the list above (a dangerous-class call the classifier could not clear, an ask rule) open the parent's dialog.

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
- **The rule workshop** turns what the decision log shows you answering again and again into rules. `foreman perms ...` runs in a terminal (bash, cmd and PowerShell entry points; Node >= 22.6); the same three work as `/foreman perms suggest|review|adopt`.
  - `foreman perms suggest [--since <days>] [--min <n>] [--json]` (default: the last 7 days, groups with at least 3 hits in at least 2 sessions) reads `state/gate/log.jsonl` and `log.1.jsonl`. It takes the decisions that cost something (classifier calls, cache hits, dialogs, child asks, and `danger-*` calls that ran only because the mode is `allow`) and groups them by program and subcommand (segments with an exec flag, a flag in first position or an opaque form group by program, subcommand and option words). Each group gets a candidate `Bash(<program> <subcommand> *)` rule built by the same code as the dialog's pattern rule, or, where no rule is safe, a classifier sentence. Each candidate carries a safety note: exec-flag exposure, how many distinct logged segments the rule covers, and whether it also covers lines you or a parent denied.
  - **Replay.** Every candidate rule is matched against every logged shell shape of the period. The report shows *would-allow* counts and `conflicts: n` for denied shapes the rule would allow, and marks those candidates `review`. The log keeps redacted shapes, so the counts are approximate: **would-allow is a lower bound** (an opaque, truncated or multi-segment shape never matches a single-segment rule).
  - The report is a markdown file `.workflow/scratch/perms-suggest-<date>.md` in the current directory plus a table on stdout. Nothing is written to a permissions file.
  - `foreman perms adopt <report> <n>...` appends the chosen candidates to the **user** file (`allow`, or `classifier.allow` for a sentence; `3:s` picks candidate 3's sentence). The report is a file an agent can write, so adopt re-validates every chosen entry (rule grammar, the `Bash(<program> [<subcommand>] *)` shape, no exec flag or glob, sentence length and control characters), prints the exact text and asks for a `y` on the terminal. It refuses when stdin or stdout is not a TTY, and a floor keeps agents from running it. The write is atomic and keeps the file's other keys and their order. The slash form asks one select per candidate: rule, sentence or skip.
  - Each adopted entry is recorded in `<agentDir>/pi-foreman/permissions.meta.json` (`{added, source: "suggest", shapes}`), so `permissions.json` keeps its grammar. `foreman perms review` lists them with their age and the log hits since adoption (`rule` lines naming the pattern) and flags a rule older than 60 days with no hit; it writes nothing.
  - `/retro` adds one line when 10 or more decisions cost a dialog or a classifier call in the last 7 days. The thresholds (60 days, 10 decisions) are constants, not config keys.
- `/foreman doctor` prints the classifier model, the mode and counts, the decision-log path, and warns about an invalid user file, a tracked or unignored project file, and leftover keys of the older gates.

## Protected targets

A protected target is a host, a path or a command glob that you want a small model to judge call by call instead of an ask rule that interrupts every time. Entries live in the `protected` list of the user file and of the trusted project file (`.workflow/permissions.json`); every other file ignores the key.

```json
{ "protected": [ { "host": "prod-*.example.net", "note": "production" }, { "path": "ops/playbooks/**" }, { "command": "deploy-*" } ] }
```

Each entry has exactly one of `host`, `path`, `command` (1 to 300 characters) and an optional `note` (200 characters). Entries are numbered `P1..` in file order. A bad entry is skipped with a notice.

- **What the check sees.** The matched entries with their notes, the session task (the bound ledger's title and open items, else the first user message, cut to 800 characters), the effect classes of the call and the `deny` sentences (`D1..`). The command is fenced as data.
- **What it may answer.** `{"verdict": "allow"|"ask"|"deny", "effect": "read"|"write"|"deploy"|"network"|"unknown", "confidence": "high"|"low", "entry": "D1"|null, "reason": "..."}`. An accepted `allow` replaces your ask rules, the dangerous-class whitelist and the ask/deny mode for this call. Floors and `deny` rules still come first.
- **What is accepted.** `allow` needs high confidence and a line the parser states exactly. A read verdict is accepted only when no segment writes; a write, deploy or network verdict only while you are present and `gate.protected.check` is `model`. A `deny` is accepted only when it cites a `D` entry. Everything else asks: a low confidence, an `unknown` effect, an invalid or extra-field reply, a timeout, a provider error, no model.
- **Owner away.** Away means a child or headless session, presence off, no live pane sample, a stale sample or a presence probe that says away. Away, only read-only verdicts allow; the rest asks (a child's ask goes to the parent pane per `gate.childAsk`; a headless session with no pane has nobody to ask and refuses).
- **The ask.** `P2 (production) is protected. The check rates this write with high confidence: <reason>.` There is no remember option.
- **Cache.** A read-rated allow is cached for the session by tool, cwd, role, payload and entries; the owner-away rule is re-applied on every hit, the mode test comes before the cache, and a permissions change, `/foreman perms reload` or a protect change clears it.
- **Editing.** The foreman calls `foreman_protect {action, kind, glob, note?, file?}` when you ask it to protect a target; you confirm in a dialog (a timeout, a cancel or no pane is a refusal) and the adapter writes the file. A child never has the tool. You can run `/foreman perms protect add|remove <kind> <glob> [--note <text>] [--user]` yourself. An untrusted project file, a duplicate add and a missing remove are refused.
- **Log and trace.** Decision log layer `protected` (an accepted allow carries the model's reason); trace event `protected_check` for every verdict, with the redacted command, the matched rule (`protected:P<n>`), the entry and the matched globs. A guard block (`deny`, `blocked`) in the trace carries the redacted command, the guard name as `rule` and the matched rule text as `reason`.
- **Cost and latency.** An uncached check is one call to the small review model: about 1.2k to 2k input tokens, roughly 0.1 cent on a small model, 1 to 4 s, capped by `gate.reviewTimeoutMs` (a timeout asks). Read-rated allows are cached per entry set until the next permissions reload, so a repeated identical read costs nothing. Writes are never cached.
- **What matches.**

  | Entry kind | Matches | Effect classes added |
  |---|---|---|
  | `host` | the hosts of `ssh`, `scp`, `sftp`, `rsync` (also after the host: `ssh prod -o X cmd`, combined flags such as `-vp 22`, `--`, `-J` jump hosts), `curl`, `wget`, and a `fetch` call that is not a plain GET or HEAD | every non-ssh shell host match carries `write-out`; ssh adds the classes of its remote command |
  | `path` | the write targets of write-class segments and the path tools (`write`, `edit`) | `write-out` |
  | `command` | the program basename of any segment, regardless of effect class | those of the segment |

  A plain GET or HEAD never matches. A read-class segment (`cat`, `grep`, `git log`, ...) never touches a host or path entry. A command-running ssh option (`-o ProxyCommand=`, `LocalCommand=`, `RemoteCommand=`, `-F`) makes the remote command opaque, so only an ask is possible.
- **Known limits.** A segment of class `unknown` (for example `sed -i`) rests on the model's own rating. A future `gate.protected.*` sub-key needs its own tighten row. Exotic ssh layouts the parser does not read fall back to the older, stricter path (opaque remote), never toward allow.

## Decision log

One JSON line per gate decision in `<agentDir>/pi-foreman/state/gate/log.jsonl`: `id, ts, session, kind (owner|child|headless), role, tool, layer, verdict, rule, reason, shape, cwdHash`, plus `fragment` on a floor denial (the matched text, redacted), and `latencyMs`, `model` and `cached` when a model decided. For a dialog the `reason` of an allow holds the answer (for example `allow-once`, `allow-remember`, `allow-remember-refused` when the remember write was refused and the call ran once, `parent-allow` on the child's line); a deny keeps its deny text.

| Layer | Written when | `rule` holds |
|---|---|---|
| `floor` | a floor or a self-modification rule denied | the floor or rule name |
| `rule` | a pattern rule decided | the pattern text |
| `default` | a built-in allow | the built-in name |
| `classifier` | the classifier allowed, denied or escalated | `prose:A3`, `prose:D1`, or the escalation cause |
| `protected` | the protected check allowed or denied | `protected:P2`, or `protected:P2;classifier.deny:D1` for a deny |
| `cache` | the classifier's cached allow was reused | `prose:A3` |
| `mode` | the mode decided (no rule, dangerous under `allow` or `deny`) | `mode:no-rule`, `mode:allow:danger-...`, `mode-deny` |
| `dialog` | an owner answered | the `danger-*` name or the cause |
| `child-ask` | a parent answered or timed out for a child | the run id and the outcome (an answer carries the dialog answer, for example `allow-once`) |

Lines of the older gate (`review`, `autoreview` usage role) stay readable. `shape` is the normalised, redacted command: program and option words kept, literal paths reduced to a class (`<worktree>/...`, `<scratch>/...`, `<tmp>/...`, `<home>/...`, `<parent>/.workflow/...`, `<abs>`), URLs to the host, every quoted string and secret-like value replaced by `<v>`. The log rotates to `log.1.jsonl` at `gate.logMaxBytes` (default 20 MB). Classifier calls are logged to the usage log with role `classifier`; the trace carries `guard`, `dialog` and `review` events.

## Config keys

The permission policy lives in `permissions.json`; these are the `foreman.json` keys around it.

| Key | Meaning | Project layer |
|---|---|---|
| `permissions.profile` | the profile name to run with (string or null), see [Profiles](#profiles) | ignored with a notice |
| `gate.reviewTimeoutMs` | classifier call timeout (default 15000, minimum 100) | lower only |
| `gate.askTimeoutMs` | how long a child waits for its parent's ruling (default 900000); nothing else uses it | lower only |
| `gate.childAsk` | `parent` (default) or `deny` | `deny` only |
| `gate.protected.check` | `model` (default: the check may allow reads and, while you are present, writes), `read-only` (only a read-only verdict allows) or `ask` (every protected call asks) | tighten only (`ask` < `read-only` < `model`) |
| `gate.tmpAccess` | writes (the owner also reads) under the OS temp dirs (default true) | `false` only |
| `gate.logMaxBytes` | log rotation size | user or overlay only |
| `gate.readTools` | extension tool name to path field (or null), judged like read/grep, see [Read tools](#read-tools) (default `{}`) | user or overlay only |
| `gate.mode` | retired: `floors-only` means mode `allow` and shows a notice; remove it | user or overlay only |
| `providers.<p>.roles.review`, `roles.review` | the classifier model | user or overlay only |
| `safety.preBash` | pre-bash hooks | user or overlay only |
| `gate.policy.userFile`, `safety.policy.files` | removed, see [Migration](#migration) | no effect |

Every other `gate.*` key is user or overlay only (`gate.protected.check` may tighten); a project value is dropped with a warning. A project cannot remove a user `deny` rule: project and tracked lists add to the user's.

## Known limits

- Another extension loaded before the gate, or one that mutates `event.input` after it, could change the input between the decision and the execution. The gate is first in load order; the doctor warns when any extension precedes it.
- Extension-registered providers: the classifier call goes through Pi's registry, so a provider an extension registers at runtime must be loaded before the first classification.
- The `bash` tool is parsed as bash. When the resolved shell is not a bash binary (a custom `shellPath`, or the Unix `sh` fallback) the gate treats the tool as opaque.
- The decision is made on the command string, not at run time: another local user can swap a `/tmp` path for a symlink in between.
- Git config in the repository (`diff.external`, a pager) still applies to `git diff` and `git log`.
- The git floors and the dangerous class read plain git command lines. Not a complete list of what they do not read: `git clone --template=<dir>` (its hooks run during the clone), `git submodule foreach`, `git bisect run`, `git difftool -x`, `git ls-remote --upload-pack`, a one-off `-c alias.*`, `git fetch <remote> +a:b`, `git checkout <file>`, commands inside a script file, an alias or a runner, and forms that remove a config variable (`env -u GIT_CONFIG_COUNT ...`). The ref-moving entries apply to subagents only; the main session's own forms are not in the class. The stripped git credentials of a subagent are a speed bump, not a boundary: only an operating-system sandbox or a separate operating-system user would be one, and pi-foreman builds neither. Branch protection on the server, administrators included, is the boundary (see [safety](safety.md)).
- Windows: `/tmp` is no write base. For the foreman the system temp dir is the write target, in its real and its long spelling (an 8.3 `RUNNER~1` expands); a child's shell writes there stay dangerous class.
- `tasks` and `chain` launches carry no launch binding, so their children get no `FOREMAN_CHECKOUT` and no `child-write-foreman-checkout` fence; they still get `child-write-outside` for a write outside their worktree and scratch dir.
- The bundled pi-subagents (`long-running-guard.js`, `isMutatingTool`) has no exception for `/dev/null`, so a bash call that redirects to it counts as a mutating tool for its "mutating tool failures" attention signal. That signal is upstream of the gate: the gate's null-device rule (no write) does not change it.
- The gate judges a command line, not the files it runs (see the honest gap under [Floors](#floors)). Under mode `allow` the classifier does not run, so whitelist deny sentences do not apply; `deny` rules and floors still do.

## Windows

The `bash` tool on native Windows runs Git Bash, so the bash AST applies as on Linux and macOS. The optional `powershell` tool has no parser: every `powershell` call is opaque. The floors run on its raw text (with the PowerShell-aware shell-write grammar), then it is `danger-opaque`, never a built-in allow. Inside a bash line, `powershell`, `pwsh`, `cmd`, `cmd.exe`, `wsl` and any invocation of a `.ps1`, `.cmd` or `.bat` file are opaque segments. On win32 a path has two spellings (backslashes, 8.3 short names such as `RUNNER~1`); `effects.ts` `realSpelling()` compares the real spellings, so a read root stored by its realpath still matches, and `pathnorm.ts` is the one normaliser the floors, the path rules and the pattern rules share. `/tmp` never counts on Windows. `NUL` (any case, `>NUL`, `2>nul`) is the null device on Windows only; elsewhere it is a file name. The fence against the foreman's checkout accepts `\`, `/` and `C:` drive spellings and folds case on Windows, and `$FOREMAN_SCRATCH` resolves to the drive form of the scratch dir. The gate tests run on the three CI operating systems with path fixtures for both separators and drive letters.

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
| `foreman perms candidates`, `export-eval`, the live eval | gone; the remember step in the dialog and the rule workshop (`foreman perms suggest|adopt|review`, see Commands) grow the whitelist |
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
