# Herdr sidebar plugin

> Covers the `pi-foreman.sidebar` Herdr plugin: install, the rows snippet to merge into Herdr's config,
> the `fm_*` pane tokens, the Agents view sort, the `ui.symbols` glyph sets,
> and the known limits of Herdr's plugin API.

The plugin `integrations/herdr/pi-foreman-sidebar/` shows the pi-foreman session tree in Herdr's Agents panel: per Pi
pane a state glyph, the label, age or blocked timer, the children (subagent runs) and tokens and cost. It needs Herdr
0.9.0 or later on Linux or macOS and Python 3.9+. Pane-level session features (blocked shim, group tag) are in
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

Colour rules test only the cell's own value, so the state colour sits on the glyph cell: one `equals` rule per glyph of
both symbol sets. A nested session's tree prefix (`├─`, `└─`) starts its `fm_l1`, so the glyph cell holds the glyph
alone. A session blocked for more than 15 minutes gets a `!` after its glyph (`✋!`), which the first rule (`contains = "!"`)
colours red; the `!` also reads without colour. The colours in the snippet are placeholders.

## Tokens

All tokens come from the source `plugin:pi-foreman.sidebar`, with a 15 s TTL (60 s for `run --once`), refreshed
every 5 s; values are at most 80 characters.

| Token | Value |
|---|---|
| `fm_sym` | state glyph, plus `!` when blocked longer than 15 minutes |
| `fm_l1` | tree prefix of a nested session (`├─`, `└─`), `› label`, the age or blocked timer right-aligned to the width |
| `fm_l2` | children: glyph, role and rung per active run (`×n` for repeats), a finished run as `✓ role` for `radar.recentRunSeconds` (default 8) before it joins the `✓n` count; `no children`, `no active children`, `done · n children` or `lost`; the base rung `model` is not shown |
| `fm_l3` | `↑in ↓out` of the session and its children; `in` counts uncached input only (fresh input plus cache writes, from the usage file), `↑~n` marks the raw total incl. cache reads when no usage file has the split; radar and its JSON keep the raw total. Dropped before the cost when the row is too narrow |
| `fm_cost` | `$cost` and `✓n` finished children |
| `fm_state` | `working`, `waiting`, `asking`, `blocked`, `done` or `lost`, for your own rules |
| `fm_block_s` | seconds blocked, set only while blocked, for your own `gt`/`lt` rules |
| `fm_sort` | parent-first sort key (`r001`, `r001.c001`) |

Width: `--width`, else `HERDR_SIDEBAR_WIDTH`, else `ui.sidebar_width` from Herdr's `config.toml` (read only), else 26
(Herdr's default). Herdr may auto-scale the panel between `ui.sidebar_min_width` and `ui.sidebar_max_width`; set the
width you see when it differs. Below 24 columns `fm_l3` drops the token counts; below 20 `fm_l3` and `fm_cost` are
cleared. The layout counts 2 columns of panel frame and Herdr's ` · ` separator (3 columns) between two cells of a row.
Row 1 also reserves the cells you put before `$fm_sym` (an icon token, say): none by default, each counted 1 column
plus a separator; set `--lead-cells N` or `HERDR_SIDEBAR_LEAD` to the number you add. Line 1 stops
2 columns short of its budget; when it is short of room the label is cut (`…`), down to `›…`, and only then the age is
dropped.

A session is joined to its pane by the presence file's `paneId` (pi-foreman writes `HERDR_PANE_ID` there), else by the
pane's foreground pid, else by a working directory only one Pi pane has. When several presence files name the same pane
(sessions restarted in it), the live one wins. When a session leaves radar its tokens are cleared at once; if the
daemon dies they expire with the TTL.

A working session cycles a braille spinner in `fm_sym` while `ui.spinner` is true (default; `false` shows the static
working glyph). The glyph cell's own `fg` in the snippet colours the spinner frames.

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
