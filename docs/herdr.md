# Herdr sidebar plugin

> Covers the `pi-foreman.sidebar` Herdr plugin: install, the rows snippet to merge into Herdr's config,
> the `fm_*` pane tokens, the Agents view sort, the `ui.symbols` glyph sets,
> and the known limits of Herdr's plugin API.

The plugin `integrations/herdr/pi-foreman-sidebar/` shows the pi-foreman session tree in Herdr's Agents panel: per Pi
pane a state glyph, the label, age or blocked timer, the children (subagent runs) and tokens and cost. It needs Herdr
0.9.0 or later on Linux or macOS and Python 3.9+. Pane-level session features (blocked shim, group tag) are in
[sessions](sessions.md#herdr).

```text
⏳ › pi-foreman 01a1253f      12s
⏳ builder strong  ? reviewer
↑341k ↓2.3k $0.47          ✓1
├─ ✋ › ladder-polish       6m
│⠀ ⏳ explorer
│⠀ ↑64k ↓0.7k $0.12
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
2\. Log and pid file are in Herdr's plugin state folder.

## Rows

The snippet adds three rows under `[ui.sidebar.agents.rows_by_agent]`, key `pi`, so only Pi panes use them; other
agents keep your default rows. Herdr allows one rows table per key: if you already have
`[ui.sidebar.agents.rows_by_agent]`, add the `pi = [...]` entry to it. Disable other plugins that set the Agents view
or ship row templates for `pi`; two owners of the view replace each other's sort.

Colour rules test only the cell's own value, so the state colour sits on the glyph cell: one `equals` rule per glyph of
both symbol sets. A session blocked for more than 15 minutes gets a `!` after its glyph (`✋!`), which the first rules
colour red; the `!` also reads without colour. The colours in the snippet are placeholders.

## Tokens

All tokens come from the source `plugin:pi-foreman.sidebar`, with a 15 s TTL, refreshed every 5 s; values are at most
80 characters.

| Token | Value |
|---|---|
| `fm_pre` | tree prefix of a nested session (`├─`, `└─`), empty for a root |
| `fm_sym` | state glyph, plus `!` when blocked longer than 15 minutes |
| `fm_l1` | `› label` and the age or blocked timer, right-aligned to the sidebar width |
| `fm_l2` | children: glyph, role and rung per active run (`×n` for repeats); `no children`, `no active children`, `done · n children` or `lost`; the base rung `model` is not shown |
| `fm_l3` | `↑in ↓out` of the session and its children |
| `fm_cost` | `$cost` and `✓n` finished children |
| `fm_state` | `working`, `waiting`, `asking`, `blocked`, `done` or `lost`, for your own rules |
| `fm_block_s` | seconds blocked, set only while blocked, for your own `gt`/`lt` rules |
| `fm_sort` | parent-first sort key (`r001`, `r001.c001`) |

Width: `--width`, else `HERDR_SIDEBAR_WIDTH`, else `ui.sidebar_width` from Herdr's `config.toml` (read only), else 34.
Below 34 columns `fm_l3` drops the token counts; below 28 `fm_l3` and `fm_cost` are cleared.

A session is joined to its pane by the presence file's `paneId` (pi-foreman writes `HERDR_PANE_ID` there), else by the
pane's foreground pid, else by a working directory only one Pi pane has. When several presence files name the same pane
(sessions restarted in it), the live one wins. When a session leaves radar its tokens are cleared at once; if the
daemon dies they expire with the TTL.

## Agents view

While at least one foreman session is joined, the daemon sets the Agents view (`agent.view.set`, label `pi-foreman`)
to sort by `fm_sort`, then Herdr's attention order: foreman panes first, parents above children, all other panes after
them unchanged. With no foreman session it clears the view (`agent.view.clear`, only if it still owns it), so the
panel falls back to Herdr's own sort. `agent.view.set` needs the plugin linked or installed; a daemon started by hand
without that publishes tokens only and retries the view at most once a minute. The choice is saved in the plugin state
folder and reapplied at startup, because Herdr forgets the view on a server restart.

## Symbols

`ui.symbols` in `foreman.json` picks the glyph set for radar, the children widget and this plugin (via
`foreman radar --json`): `unicode` (default) or `nerd` (a Nerd Font in the terminal). See
[sessions](sessions.md#further-session-keys).

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
- Tokens and the Agents view are not restored after a Herdr server restart; the startup hook republishes them.

## Wishes for Herdr

- a parent/child relation on panes, so nesting does not need a sort key;
- virtual rows, so subagent runs could be rows;
- row templates chosen per pane at runtime.
