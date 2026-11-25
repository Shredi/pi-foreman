<p>
  <img src="banner.svg" alt="pi-foreman" width="1100">
</p>

# pi-foreman

pi-foreman turns the [pi coding agent](https://pi.dev) into a small crew. You talk to one session, the
"foreman". It does not rush into editing your files. It sizes the task, writes down a checklist, hands the
work to focused helper agents (one explores, one builds, one reviews), checks what they bring back, and only
says "done" when the checklist is ticked and a reviewer has passed the change.

What that gives you: fewer wrong edits, a second pair of eyes before anything is called finished, guard rails
around git and the shell, a cost footer so you see what a task used, and the chance to use cheaper models for
the helpers while a stronger one stays in charge.

## Install

Linux, macOS and Windows. Do the steps in order. From step 3 on everything is typed inside Pi, except saving the config file in step 4.

**1. Install the prerequisites** (Node 22.19+, Python 3.13+, git) and Pi, with the block for your system:

macOS (Homebrew):

```sh
brew install node python@3.13 git
npm install -g @earendil-works/pi-coding-agent@1.6
```

Linux, Debian 13 or Ubuntu 25.04 and later (their `python3` is 3.13):

```sh
sudo apt-get update && sudo apt-get install -y curl git python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g @earendil-works/pi-coding-agent@1.6
```

On another Linux distribution, install Node 22.19+, Python 3.13+ and git with its package manager, then the last line.

Windows (PowerShell):

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.13
```

Open a new terminal, then:

```powershell
npm install -g @earendil-works/pi-coding-agent@1.6
```

**2. Install the package.**

```sh
pi install git:github.com/Shredi/pi-foreman
```

**3. Run setup.** Start `pi`, then type:

```
/foreman setup --profile standard
```

`/foreman setup --dry-run` shows the changes first and writes nothing. Other profiles, flags, add-ons and
what setup writes are in [docs/install.md](docs/install.md).

**4. Map your models.** For a built-in provider, log in first: type `/login` in Pi to connect a subscription or API key. Then tell pi-foreman which model
does which job: save this as `foreman.json` in Pi's agent folder (`~/.pi/agent`, or `%USERPROFILE%\.pi\agent`
on Windows, or the folder in `PI_CODING_AGENT_DIR`), with your own provider and model ids instead of the
placeholders:

```json
{
  "version": 1,
  "providers": {
    "my-provider": {
      "roles": {
        "foreman": { "model": "my-provider/big-model" },
        "explorer": { "model": "my-provider/small-model" },
        "builder": { "model": "my-provider/mid-model" },
        "reviewer": { "model": "my-provider/mid-model" }
      }
    }
  },
  "ceremony": { "reviewModel": "my-provider/other-model" }
}
```

A role is a job with its own model: the foreman is the session you talk to, the explorer reads and searches,
the builder makes one scoped change, the reviewer checks it. Give the foreman your strongest model and the
helpers cheaper ones. When you start a session, the foreman switches to its mapped model (and `thinking`
level, if you set one), unless you started Pi with `--model` or picked a model yourself. A reviewer never
reviews on the foreman's own model: when the mapped reviewer would be the same model, `ceremony.reviewModel`
names the model that reviews instead. Check the file with:

```
/foreman config validate
```

Or start from a preset instead of the file: `/foreman config apply-preset <name>` with `claude-bridge`,
`claude-bridge-sonnet-reviewer`, `google` or `openai` (the provider presets; add `--dry-run` to see the result first;
[docs/presets.md](docs/presets.md) has the rest, and `inexpensive` needs ranks).

**5. Run setup again.** Setup is what writes the mapped models and Pi's compaction points into Pi's settings.

```
/foreman setup
```

**6. Check.**

```
/foreman doctor
```

**7. First session.**

1. Start `pi` in a repository.
2. Type a task, for example "add a --verbose flag to the CLI".
3. Watch the foreman pick a tier (trivial, standard or heavy), launch a builder, then a reviewer, and tick its
   checklist as the work is verified. A footer shows tokens and cost.
4. Type `/foreman close` to end the session cleanly.

To work on pi-foreman itself, see [Developing](docs/install.md#developing).

## Recommended settings

The defaults suit most setups. Change one when the "when to change" column fits you. Every key is in
[docs/features.md](docs/features.md).

| Setting | Default | When to change |
|---|---|---|
| `compaction.maxTokens` | `200000` | Lower it (minimum 50000) to make Pi compact earlier; `/foreman setup` turns it into Pi's per-model compaction point, so run it again after a change. |
| Cache lifetime and warming, `claude-bridge` | foreman 3600 s, helpers 300 s (`bridge.promptCacheTtl` `1h` / `5m`) | The foreman session is warmed out of the box, so an idle session does not resume cold. Helpers are not warmed unless `providers.claude-bridge.cache.keepalive.children` is `true`. Set `bridge.promptCacheTtl.main` to `5m` on extra-usage credits or an API key, where the 1-hour cache costs more. |
| Cache lifetime and warming, `github-copilot` | warmed for `claude-*` (300 s) and `gpt-*`, `o1*`, `o3*`, `o4*` (1800 s) model ids | Any other Copilot model has no known lifetime and is not warmed; add a `providers.github-copilot.cache.byModel` row with a `ttlSeconds` to warm it. |
| Cache lifetime and warming, every other provider (Anthropic direct included) | no lifetime, no warming | Set both keys below; see the next paragraph. |
| `presence.awayAfterMinutes` | `11` | Minutes without keyboard or mouse input before you count as away; the warming budget is lower while you are. Allowed 1 to 1440. |
| `providers.<p>.roles.<role>.strong.model` | unset | Give a role a stronger second model. A helper climbs to it when its context grows, it runs out of turns or it is stuck, and a builder revision after a failed review goes straight to it. |
| `ladder.strongOnRevision` | `true` | Set `false` to keep a builder on its first model after a failed review. |
| `ladder.strongAbove` | `100000` | Tokens of context growth above a helper's first call before it steps up to its strong model (the explorer's own default is `200000`). |
| `ceremony.default` | `"standard"` | The tier when no signal applies; `/ceremony trivial\|standard\|heavy` sets it yourself. |
| `ceremony.trivialBound` | 2 files, 40 lines, 0 new files | The size of a trivial change; with `ceremony.foremanEdits` `bounded` it is also the most the foreman edits itself. |
| `ceremony.foremanEdits` | `"scratchpad"` | The foreman never changes project files itself; `bounded` lets it make trivial edits within `ceremony.trivialBound`. |

A provider outside that table has no cache lifetime, so nothing warms its idle sessions until you set the
lifetime and the keep-alive. This is easy to miss. In `foreman.json`:

```json
{ "providers": { "my-provider": { "cache": { "ttlSeconds": 600, "keepalive": { "enabled": true } } } } }
```

Use the lifetime your provider documents instead of `600`. Details: [docs/cache.md](docs/cache.md).

## Optional features

- Ready label: mark a pull request that passed review and checks with a label for you to look at, `tools.prReadyLabel` ([docs/tools.md](docs/tools.md#ready-label)).
- High-stakes reviewer: a reviewer launch on risky work can use its own model ([docs/review.md](docs/review.md#high-stakes)).
- Sidebar app: session status in the Herdr sidebar ([docs/herdr.md](docs/herdr.md#install)).
- Remote child sessions (experimental): open a child session on another machine ([docs/sessions.md](docs/sessions.md#remote-child-sessions)).

## Permissions

A tool call that no rule decides simply runs. Deploys, publishing, installs, network writes and similar dangerous calls go to a cheap classifier that may only clear them by citing a sentence you wrote in `permissions.json`; a call the classifier cannot clear is refused with its reason and nobody is asked; only a classifier answer naming one of six danger classes asks you in a dialog. Floors for secrets, force pushes and the like stay on in every mode. See [docs/permissions.md](docs/permissions.md).

## Learn more

| Page | What is in it |
|---|---|
| [docs/install.md](docs/install.md) | Package install, `/foreman setup`, developing, update and remove, config layers, Claude bridge login |
| [docs/roles.md](docs/roles.md) | Roles, model ladder, rank policy, presets |
| [docs/presets.md](docs/presets.md) | Shipped model presets and how to apply them |
| [docs/cache.md](docs/cache.md) | Prompt-cache lifetime, keep-alive, compaction |
| [docs/ceremony.md](docs/ceremony.md) | Tiers, review and finish gates, planning, budgets |
| [docs/safety.md](docs/safety.md) | Shell-write guard, what the gate floors cover for git, the PR gate, the tool gate, known limits |
| [docs/sessions.md](docs/sessions.md) | `/sync`, `/retro`, `/foreman close`, `/foreman session`, intercom, Herdr |
| [docs/herdr.md](docs/herdr.md) | The Herdr sidebar and herdr-app |
| [docs/bench.md](docs/bench.md) | Measuring the harness (bench) |
| [docs/overlays.md](docs/overlays.md) | Private and organisation overlays |
| [docs/development.md](docs/development.md) | Layout, tests, CI, working on pi-foreman |
| [design/architecture.md](design/architecture.md) | The design record and rationale |
| [CHANGELOG.md](CHANGELOG.md) | What changed |

Setting up with an agent: point it at [docs/features.md](docs/features.md).

## License

MIT, see `LICENSE`. Upstream attributions are in `NOTICE`.
