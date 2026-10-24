# Herdr sidebar plugin

> Covers the `pi-foreman.sidebar` Herdr plugin: install, the rows snippet to merge into Herdr's config,
> the `fm_*` pane tokens, the Agents view sort, the `ui.symbols` glyph sets,
> and the known limits of Herdr's plugin API.

The plugin `integrations/herdr/pi-foreman-sidebar/` shows the pi-foreman session tree in Herdr's Agents panel: per Pi
pane a state glyph, the label, age or blocked timer, the children (subagent runs) and tokens and cost. It needs Herdr
0.9.0 or later on Linux or macOS and Python 3.13+. Pane-level session features (blocked shim, group tag) are in
[sessions](sessions.md#herdr).

```text
⏳ · › pi-foreman… 12s
⏳ builder · ✓ explorer
↑38k ↓2.3k · $0.47    ✓1
✋ · └─ › ladder-p… 6m
⠀⠀ ⏳ explorer
⠀⠀ ↑9.1k ↓700 · $0.12
```

## Install

1. Link or install the plugin:

   ```sh
   herdr plugin link <path to pi-foreman>/integrations/herdr/pi-foreman-sidebar
   # or
   herdr plugin install <owner>/pi-foreman/integrations/herdr/pi-foreman-sidebar
   ```

2. Print the rows snippet (the `configure` action, or `python3 sidebar.py configure` in the plugin folder) and merge it
   into Herdr's `config.toml`. The plugin never writes that file.
3. `herdr server reload-config`.

The daemon starts with Herdr (`[[startup]]`); the `pane.agent_detected` hook restarts it if it died. Actions: `start`,
`stop`, `configure`. It finds `foreman` in this order: `--foreman PATH` or `PI_FOREMAN_BIN`, then `bin/foreman` of the
checkout the plugin is linked from, then `foreman` on `PATH`. If none is found it logs one line and exits with status
2\. Log (`sidebar.log`) and pid file live in one state folder, whoever starts the daemon:
`HERDR_PLUGIN_STATE_DIR` (set by Herdr for its hooks and actions), else
`${XDG_STATE_HOME:-~/.local/state}/herdr/plugins/pi-foreman.sidebar` when its `herdr/plugins` folder exists, else
`pi-foreman.sidebar` in the system temp folder. `python3 sidebar.py status` prints the folder it uses, so `status`
and `stop` by hand reach the daemon Herdr started.

The daemon logs its start, the first radar line, every change of the joined pane count (`joined N of S sessions
(A agents listed)`, with a short reason when none joined) and a report that starts or stops failing; a steady state logs nothing. A
radar child that prints no line for three intervals, or twice its last snapshot duration if longer (plus a startup
grace), is killed with a stack dump in the log and
restarted. On Linux and macOS `kill -USR1 <pid>` writes the daemon's thread stacks to the log.

### Hand smoke

In the plugin folder, inside a Herdr pane:

```sh
python3 sidebar.py run --dry-run   # compose only: prints the tokens per pane, reports nothing
python3 sidebar.py run --once      # publish once, 60 s TTL: "<pane> ok" or "<pane> error: ..." per pane, then the tokens
herdr agent list                   # within 60 s the pi pane carries the fm_* tokens
```

`--dry-run` joins through `agent.list` when the socket answers, else by the presence `paneId` alone. `--once` never
touches the Agents view and exits 1 when a report failed. When nothing joined, the `joined 0 of …` line on stderr says
why.

## Rows

The snippet adds three rows under `[ui.sidebar.agents.rows_by_agent]`, key `pi`, so only Pi panes use them; other
agents keep your default rows. Herdr allows one rows table per key: if you already have
`[ui.sidebar.agents.rows_by_agent]`, add the `pi = [...]` entry to it. Disable other plugins that set the Agents view
or ship row templates for `pi`; two owners of the view replace each other's sort.

Row 1 opens with `$fm_sym`, a static glyph of the session state; there is no spinner, no timer and no frames. The sidebar
pushes the glyph when the state changes (and re-sends an unchanged row after 10 s only because tokens expire after the
15 s TTL). Waiting is working: while a `foreman_wait` or `foreman_bg` is pending the state stays `working` (⏳) and
Herdr's status stays working; the wait shows on line 2 (below).

| State | Glyph in `fm_sym` |
|---|---|
| working, or waiting on a `foreman_wait` | ⏳ |
| idle | ⏸ |
| ask open (a run waits for you) | ? |
| blocked | ✋ |
| blocked longer than 15 minutes | `!` (red, `contains = "!"`) |
| done | ✓ |
| lost | ✗ |

### Presence states and their `state_icon` glyphs

The presence file (`state/live/<session>.json`) carries `presence`, one of five names; each has its own icon key in
`config/symbols.json`. Precedence: `done` > `waiting-owner` > `working` > `waiting-external` > `idle` (a finished
session is `done` whatever else is still open). The legacy `state` field is unchanged for older readers (`blocked` is
`waiting-owner`; `waiting-external` still reads `working`), and `presence` is absent from files written by older versions.

| `presence` | `state_icon` glyph (unicode / nerd) | Meaning |
|---|---|---|
| `working` | ⏳ / `\uf252` | the foreman turn runs, or a child run is live, with nothing for you to do |
| `waiting-owner` | ✋ / `\uf256` | an open ask, checkpoint dialog or UI prompt waits for you |
| `waiting-external` | ↻ / `\uf017` | only external waits are pending: `foreman_wait`, `foreman_bg` pid waits, `pr_watch` |
| `idle` | ⏸ / `\uf04c` | none of the above |
| `done` | ✓ / `\uf00c` | the session ended |

With `ui.symbols: nerd` the glyphs follow the table at the end of this page. The optional variant in the snippet puts Herdr's
`state_icon` cell in front (set `--lead-cells`). A nested session's tree prefix (`├─`, `└─`)
starts its `fm_l1`. The colours in the snippet are placeholders. After updating, merge the new snippet again and run
`herdr server reload-config`; your own `config.toml` is never edited by pi-foreman.

## Tokens

All tokens come from the source `plugin:pi-foreman.sidebar`, with a 15 s TTL (60 s for `run --once`), refreshed
every 5 s by the session or, for a pane it does not push, the daemon; values are at most 80 characters.

| Token | Value |
|---|---|
| `fm_sym` | static state glyph (⏳ ⏸ ? ✋ ✓ ✗, see Rows), `!` when blocked longer than 15 minutes |
| `fm_l1` | tree prefix of a nested session (`├─`, `└─`), `› label`, the age or blocked timer right-aligned to the width |
| `fm_l2` | children: glyph, role and short model per active run (`builder sonnet-5.5 ×2`; the rung is shown only when no model is, or on panels 60 columns or wider; the base rung `model` never), a finished run as `✓ role` for `radar.recentRunSeconds` (default 8) before it joins the `✓n` count; with no active run and a pending `foreman_wait`: `⏳ <note> 4m` (`+n` for more waits); else `no children`, `no active children`, `done · n children` or `lost` |
| `fm_l3` | `↑in ↓out` of the session and its children; `in` counts uncached input only (fresh input plus cache writes, from the usage file), `↑~n` marks the raw total incl. cache reads when no usage file has the split; radar and its JSON keep the raw total. Dropped before the cost when the row is too narrow |
| `fm_cost` | `$cost` and `✓n` finished children |
| `fm_state` | `working`, `waiting`, `asking`, `blocked`, `done` or `lost`, for your own rules |
| `fm_block_s` | seconds blocked, set only while blocked, for your own `gt`/`lt` rules |
| `fm_sort` | parent-first sort key (`r001`, `r001.c001`) |

Width: `--width`, else `HERDR_SIDEBAR_WIDTH`, else `ui.sidebar_width` from Herdr's `config.toml` (read only), else 26
(Herdr's default). Herdr may auto-scale the panel between `ui.sidebar_min_width` and `ui.sidebar_max_width`; set the
width you see when it differs. Below 24 columns `fm_l3` drops the token counts; below 20 `fm_l3` and `fm_cost` are
cleared. The layout counts 2 columns of panel frame and Herdr's ` · ` separator (3 columns) between two cells of a row.
Row 1 reserves 2 columns for `state_icon` and also the cells you put before `$fm_sym` (an icon token, say): none by default, each counted 1 column
plus a separator; set `--lead-cells N` or `HERDR_SIDEBAR_LEAD` to the number you add. Line 1 stops
2 columns short of its budget; when it is short of room the label is cut (`…`), down to `›…`, and only then the age is
dropped.

A session is joined to its pane by the presence file's `paneId` (pi-foreman writes `HERDR_PANE_ID` there), else by the
pane's foreground pid, else by a working directory only one Pi pane has. When several presence files name the same pane
(sessions restarted in it), the live one wins. A finished, stale or lost session never joins by working directory, and the
daemon clears the `fm_*` keys of a Pi pane no session is joined to (once), so a new pane in the folder of an earlier
session does not show that session's row. When a session leaves radar its tokens are cleared at once; if the
daemon dies they expire with the TTL.

A pane whose push stamp is fresh but that carries no `fm_l1` (agent.list shows none) is composed by the daemon instead
of staying blank.

## Who publishes what

The Pi session publishes its own pane, so a spawn, a finished run or a state change shows within a fraction of a second
instead of after the next poll. It runs `python3 sidebar.py push --session <id> --pane <pane>` (also `--symbols`,
`--final`, `--clear`) on run start and end, ask open and close, state change, its own asks, permission prompts and decisions, and
every 5 s. Pushes are debounced to at most 4 per second with one in flight, and take well under a second. At session end `push --final` publishes a last composed row (done
glyph, done count, totals; normal 15 s TTL) and removes only the push stamp, so the daemon takes the keys over at its
next tick and the row never goes blank. `--clear` is for the hand smoke and the daemon's cleanup of a lost pane. The session pushes only when `HERDR_ENV=1` and `HERDR_PANE_ID` are set, in TUI mode, with Python
found. Both publishers use the source `plugin:pi-foreman.sidebar`. Herdr token reports are per-key patches with a TTL
per key (15 s here), so each publisher owns fixed keys and omits the others.

| Session | Daemon | Session keys (`fm_sym` `fm_l1` `fm_l2` `fm_l3` `fm_cost` `fm_state` `fm_block_s`) |
|---|---|---|
| pushed under 15 s ago, radar sees it live | only `fm_sort`, and the tree layout (`layout.json` in the state folder, read by `push` for the `├─`/`└─` prefix) | published by the session |
| older session without push, no push for 15 s (hung), lost, stale or done | every key, as before | not published |

The push stamp is `push/<session id>.stamp` in the state folder; the daemon takes a pane over within one tick when it
goes stale. A usage byte-offset cache (`push/<session id>.usage.json`) keeps the push short on long sessions.

Spinner: removed. `ui.spinner` is deprecated, still accepted and ignored; `fm_sym` is a static glyph.

Recent runs: a run that ended shows as `✓ role` on line 2 for `radar.recentRunSeconds` (default 8), then moves into
the `✓n` count. Tokens: line 3 counts uncached input (see `fm_l3`); radar's TUI and JSON keep the raw totals.

Opened sessions: a registry entry (`sessions.json`) whose handoff dir matches a live session is merged into that node, so
a working child shows once under its parent, never as a second `✗ lost` row. An `open` entry with a `result.md` and no
live file shows as idle. The opener id is `--parent-id`, `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`, then the
config `stableId`; a child that closes marks its own entry `closed`.

Ask signal: when a session opened by `foreman session open` writes `ask.md` (first line `# Ask <n>: <topic>`) in its own
handoff dir, pi-foreman touches `<handoff>/.ask` and opens a blocked source, so Herdr shows `blocked` with the label
`ask <n>: <topic>` (`herdr:blocked`, the same channel as a dialog; never `herdr agent prompt`). Writing `.seen` in that
dir, or shutdown, releases it. A parent that is not a Pi session polls `*.md` and `.ask`; the file contract is in
[sessions](sessions.md#ask-by-file-parent-that-is-not-a-pi-session).

## Remote clients and Pi pane status

Herdr holds one `agent_status` per pane. A remote client (a phone or web app installed as a Herdr plugin, or `herdr --remote`
over SSH) shows that status for each pane. It does not read pi-foreman's state directly.

- Herdr learns working and idle for a Pi pane from its Pi integration. That is a setting on the machine that runs Herdr:
  `herdr integration install pi` (check with `herdr integration status`). Nothing is installed or configured on the phone
  or the remote client for this.
- pi-foreman adds the blocked state (a child's ask, a guard prompt, any dialog) through its `herdr:blocked` event on
  `pi.events`. See [blocked shim](sessions.md#blocked-shim), which also covers when the shim steps aside.
- Known gap: Pi's trust dialog before the session starts is not covered, so it does not show as blocked
  ([blocked shim](sessions.md#blocked-shim)).
- The sidebar plugin's `fm_*` metadata tokens are display-only. Remote clients do not use them for agent status.

## Agents view

While at least one foreman session is joined, the daemon sets the Agents view (`agent.view.set`, label `pi-foreman`)
to sort by `fm_sort`, then Herdr's attention order: foreman panes first, parents above children, all other panes after
them unchanged. With no foreman session it clears the view (`agent.view.clear`, only if it still owns it), so the
panel falls back to Herdr's own sort. `agent.view.set` needs the plugin linked or installed; a daemon started by hand
without that publishes tokens only and retries the view at most once a minute. The choice is saved in the plugin state
folder and reapplied at startup, because Herdr forgets the view on a server restart.

## Symbols

`ui.symbols` in `foreman.json` picks the glyph set for radar, the children widget and this plugin (via
`foreman radar --json`): `unicode` (default) or `nerd`. See [sessions](sessions.md#further-session-keys).

`nerd` needs a terminal font that contains the Nerd Font symbols (a patched Nerd Font, or the symbols-only font as a
fallback); otherwise the glyphs render blank. Test the terminal Herdr runs in with `printf '\uf252\n'` (zsh,
bash 4.2+): an hourglass means `nerd` works. `unicode` is the safe default. The plugin installs no fonts.

| State | `unicode` | `nerd` |
|---|---|---|
| working | ⏳ | U+F252 |
| waiting (idle, stale) | ⏸ | U+F04C |
| asking (a run waits for you) | ? | U+F128 |
| blocked | ✋ | U+F256 |
| done | ✓ | U+F00C |
| lost | ✗ | U+F00D |

## Optional add-on: background tasks

Nothing in pi-foreman requires it. `pi-background-tasks` runs shell commands in the background with status, logs and kill (`bg_run`). Install it with

    PI_BG_FEATURES=process pi install npm:pi-background-tasks

`PI_BG_FEATURES=process` installs the process features only. Its other feature, an attribution hook, overrides the provider
named `anthropic` and decides by provider name (`model.provider === 'anthropic'`). A `claude-bridge` provider serving `claude-*` ids is not
treated as an Anthropic route by that check, but the override takes over the global `anthropic` provider slot, so keep attribution off.
`foreman setup` prints this install line.

The add-on reads `PI_BG_FEATURES` when Pi starts, so `foreman session open` passes every `PI_BG_*` variable of the opener
(`PI_BG_FEATURES` first; names and values checked, one that fails is skipped with a note) into the child's launch line, and
writes that exact line to `<handoff>/launch.txt`: relaunching a child is a copy of that file. `/foreman doctor` prints the
effective `INFO PI_BG_FEATURES: <value>` (with the add-on present or the variable set) and a `WARN` when `attribution` is in
it while the `anthropic` credential is not OAuth (an api-key entry in the agent dir's `auth.json`, else `ANTHROPIC_API_KEY`):
Pi then fails Anthropic turns with "Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token
is required". The doctor reads only the credential's type, never its value.

What pi-foreman does when the add-on is present (detected by its `bg_run` tool or its package directory; `/foreman doctor` prints
`INFO background-tasks: present` or `absent`; with the package installed it adds an info line comparing the add-on's declared
peer range for `@earendil-works/pi-coding-agent` with the running Pi version, never a failure):

- `foreman_bg` is not used: it refuses with a pointer to `bg_run`, so detached tasks have one owner;
- `/foreman waits` also lists the add-on's running tasks (read from `.pi/tasks/*/*.json`, with the last 5 lines of each output);
- `bg_run` passes the same bash guards as `bash` (overlay rules, shell-write, destructive and git guards), reading the command from its
  `command` field; a missing or non-string `command` is denied.

## Known limits

- Subagent runs inside a Pi session are text on that session's row, not rows: Herdr has rows only for real panes.
  Nested sessions opened in their own panes (`foreman session open`) are rows of their own, indented under the parent.
- Row templates are static config: the plugin cannot add or remove rows; empty tokens leave their cells empty.
- Herdr does not restore tokens or the Agents view after a server restart: a daemon that kept running republishes the
  tokens within 5 s and the view within 60 s; after a full restart the startup hook starts a new daemon.

## Wishes for Herdr

- a parent/child relation on panes, so nesting does not need a sort key;
- virtual rows, so subagent runs could be rows;
- row templates chosen per pane at runtime.
