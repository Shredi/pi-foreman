# Herdr sidebar plugin

> Covers the `pi-foreman.sidebar` Herdr plugin: install, the rows snippet to merge into Herdr's config,
> the `fm_*` pane tokens, the activity lines, the spinner, who publishes, the Agents view sort, the `ui.symbols`
> glyph sets, and the known limits of Herdr's plugin API.

The plugin `integrations/herdr/pi-foreman-sidebar/` shows the pi-foreman session tree in Herdr's Agents panel: per Pi
pane a header (tree connector, a state glyph or spinner frame, label, age or blocked timer), one line each for what runs (agents),
what it watches (tasks, PRs, CI) and what it waits on, a row of status dots for its pull requests, and a line with tokens and cost. It needs Herdr
0.9.0 or later on Linux or macOS and Python 3.13+. Pane-level session features (blocked shim, group tag) are in
[sessions](sessions.md#herdr).

```text
  ⣻  pi-foreman                   12s
  │  ◆ builder sonnet-5.5 ×2 · revie…
  │  ⚙ pr #12 · npm test 3m
  │  ◷ timer 5m
  │  ● #17 · ◉ #21 · ○ #19 · ○ deploy
  │  ↑287k ↓7.4k · $3.32 · ✓3
  ├─ ⣽  r31-sidebar                6m
  │  │  ◆ reviewer opus-5.5
  │  │  $0.47 · ✓1
  │  └─ ✋ r31-perms               1m
  │        ? ask 1: rule scope
  │        $0.12
  ├─ ⏸  r32-cache                  2m
  │     ◷ child r32b 4m
  │     $1.02 · ✓2
  └─ ✓  r31-git                   40m
        $0.88 · ✓4
```

The mock-up is the `unicode` set at width 40 (blank cells shown as spaces); `⣻` and `⣽` are spinner frames of two
working sessions. The header holds the state glyph or frame alone, the same for every reason; what a session waits on
is the icon that leads its detail line (`◆` a run, `⚙` a task or PR watch, `◷` a timer, file or child-session wait,
`?` an open ask). The first session shows all six rows: header, agents, tasks and watches, waits, the dots row and
the meta line (the waits line is drawn only while a wait is pending).

## Install

1. Link or install the plugin:

   ```sh
   herdr plugin link <path to pi-foreman>/integrations/herdr/pi-foreman-sidebar
   # or
   herdr plugin install <owner>/pi-foreman/integrations/herdr/pi-foreman-sidebar
   ```

2. Print the rows snippet for your glyph set (the `configure` action, or `python3 sidebar.py configure [--symbols <set>]`
   in the plugin folder; the default is your configured `ui.symbols`, `unicode` when unknown) and merge it into Herdr's
   `config.toml`. Herdr takes at most 16 rules per token, so the snippet is written for one set: every glyph in its
   rules is that set's glyph. The header cell has a base colour (`fg`, green, the colour of a session on its own turn);
   if your Herdr refuses a cell-level `fg` on reload, delete that one attribute: the own-turn line then keeps your
   theme colour and the rules still apply. The `emoji` set uses the same text circles on the pr cells, so the same rules colour them;
   the `ascii` set has no rules and no `fg`. The plugin never writes
   `config.toml`.
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

`python3 sidebar.py sample [--pane <id>] [--variant pr|mixed] [--reason <r>] [--symbols <set>] [--width <n>] [--minutes <m>] [--dry-run] [--clear]`
shows a synthetic session (live agents, a PR watch, an open ask, the pressure suffix and the PR dots: `pr` one dot per
state, `mixed` PRs, an external item and `+3`) on one pane so you can judge the colour rules in the snippet live.
`--reason none|ask|review|agent|task|wait|blocked|idle|done` composes the session so that its header shows that reason
or static state (default: the mixed sample); the glyph set is `--symbols`, else your `ui.symbols`. `--reason all
--dry-run` prints one line per reason and state for every glyph set (or the one `--symbols` names): the ticking header
at one frame, then the non-ticking one. The pane
is `--pane`, else `HERDR_PANE_ID` (1 to 100 of `A-Za-z0-9._:-`, not `.` or `..`). It composes the session through the
same code as real data, writes `sample/<pane>.json` (the session tokens and the expiry, default 10 minutes) into the
plugin state folder and publishes once; while that file is fresh, `push` and the daemon use it for that pane instead of
the real row, and the Agents view is untouched. `--clear` removes the file (the next push restores the real row), expiry
does the same by itself, and `--dry-run` prints the sample for every glyph set (or the one `--symbols` names) and writes nothing.

## Rows

The snippet adds six rows under `[ui.sidebar.agents.rows_by_agent]`, key `pi`, so only Pi panes use them; other
agents keep your default rows. Herdr allows one rows table per key: if you already have
`[ui.sidebar.agents.rows_by_agent]`, add the `pi = [...]` entry to it. Disable other plugins that set the Agents view
or ship row templates for `pi`; two owners of the view replace each other's sort.

Five rows hold one token each (`$fm_hd`, `$fm_a1`, `$fm_a2`, `$fm_a3`, `$fm_meta`), so Herdr draws no separator and the
plugin owns every column of the line, including the tree. A row without a value is not drawn: an idle session is one or
two lines.

The pr row holds four cells, `$fm_pr1` to `$fm_pr4`, one dot each, so a rule can colour each dot by its own glyph. Herdr
puts its separator (` · `, 3 columns) between the non-empty cells of a row; an empty cell costs nothing. The first cell
carries the row's tree continuation (the `│` or blank cells that keep the tree lines going) and takes the row's colour:
Herdr styles whole cells, so that continuation takes the colour of the first dot too. Do not put a `state_icon` or another cell in front of `$fm_hd`. Herdr 0.9.3 draws the second and later rows
of an entry 2 cells further right than the first and has no setting for it, so `$fm_hd` starts with 2 blank cells
(`DETAIL_INDENT` in `sidebar.py`) and the detail rows are 2 cells shorter: every `│` sits under the connector or glyph
it continues.

**Upgrading from an earlier snippet:** re-run `configure` (the action, or `python3 sidebar.py configure [--symbols <set>]`),
merge the new snippet over your old `pi = [...]` rows and run `herdr server reload-config`. An old merged snippet keeps
working (no token was removed), but only the new one matches the header (state glyph rules, no reason icon rules), and each glyph set needs its own
run. Run it again after you change `ui.symbols`. The old three-row snippet is gone; the old
tokens still publish (see Tokens) but the new snippet does not use them. Nothing else changes in your `config.toml`.

### The tree

- Each nesting level is 3 cells: a connector (`├─ ` or `└─ `), a continuation (`│` plus two blank cells, or three
  blank cells after a last child) and, under a session that has row children, a child marker (`│`).
- The state slot has one fixed width per glyph set (see Header glyphs and colours): 2 cells for `unicode` and `emoji`, 1 for `nerd` and `ascii`. A narrower
  cell is padded with blank cells (U+2800, which Herdr does not trim), so the label column never moves when a session
  switches between the spinner and a static glyph.
- The label and the activity lines start at the same column; every `│` leads to a later `├─` or `└─` in the same
  column. Siblings are ordered by start time, then session id, whatever order they arrive in.
- A deep tree keeps its prefix whole: with little room the age drops first, then the label is cut to one character and `…`.
  Only the label or the line text is ever cut, with `…`.
- The last child with a pane gets `└─` and a blank continuation. Sessions without a pane (closed ones whose presence
  file still names a pane) take no slot; a session that builds the tree itself counts only the panes in the daemon's
  fresh `winners.json`.
- The daemon writes the tree positions (`layout.json`, `tree.json` in the state folder); a session that pushes itself
  uses them while they are younger than 10 s and otherwise builds the tree from all presence files itself, so a missing
  daemon no longer leaves stale connectors. Sibling connectors converge within one 5 s refresh; a session's own
  changes show at once.

### Activity lines

| Line | Content |
|---|---|
| `fm_a1` agents | `◆ builder sonnet-5.5 ×2 · reviewer opus-5.5`: running child runs by role and model, and child sessions without a pane row of their own while they are live; a finished run shows `✓ role` for `radar.recentRunSeconds` |
| `fm_a2` tasks and watches | `⚙ pr #12 · npm test 3m`: PR watches, CI waits (`foreman_wait` kind `ci`), `foreman_bg` commands and the `bg_run` add-on's tasks of this session |
| `fm_a3` waits | `? ask 1: topic` for an open ask, then `◷ child r32b 4m`: timer, file, child and pid waits |
| `fm_pr1`..`fm_pr4` | `● #17 · ◉ #21`: status dots of pull requests and external items (see Dots) |
| `fm_meta` | `↑287k ↓7.4k · $3.32 · ✓3`, plus the host pressure suffix |

A done session shows `done · n runs` on `fm_a1`, a lost one `lost`. A child session without its own pane row (a closed
or idle one, a stale registry entry) is listed on `fm_a1` only while it is live: a session whose state is `idle`,
`waiting`, `done`, `lost`, `closed` or `closing` leaves the line and the hidden `+n` count, one that works (starting and
pending included), waits on something external or waits for you stays. The same test decides the agent reason of
the parent (its detail line). A live, self-publishing working session shows a spinner frame in the state cell (see Spinner);
waiting is working: while a `foreman_wait` or `foreman_bg` is pending the state stays `working`
and Herdr's status stays working, and the wait shows on its activity line.

#### Dots

The dots row shows one circle and a short label per tracked item, in the glyph set's `pr-fail`, `pr-run`, `pr-ok` and
`pr-none` keys (see Symbols). The `emoji` set uses the same text circles as `unicode`, one cell each, so the row keeps its
line height and the pr rules colour them. A pull request dot is labelled `#<number>`; a PR of another repository than the current one
is labelled `owner/name#<number>`, cut to 20 characters; an external item (see
[External status](#external-status)) shows its own label. The PR widget above the editor is the detailed view of the same
data (checks by name, review state, the shared watch); see [tools](tools.md#pr-widget). Sidebar tokens stay plain text:
no hyperlinks and no colour codes.

| State | Circle (`unicode`) | Meaning of a pull request |
|---|---|---|
| `fail` | ● | a check failed, or the PR has a merge conflict |
| `run` | ◉ | checks are pending |
| `ok` | ○ | checks are green and the PR is mergeable: only review or merge is left |
| `none` | ◌ | no checks, or the state is unknown |

The order is red, yellow, green, unknown, then by PR number (external items without a number after the PRs), then by
label. At most four cells fit the row; when items are hidden by the cell count or by the width, the last placed cell
becomes `+n` (n = items not shown). At most 14 dots reach the sidebar.

Which PRs are tracked: a PR registered by any of the paths in [tools](tools.md#registration-paths): a branch this session
pushed, an author search, a command that acted on a PR, the user's events feed, `pr_create`, a PR URL in a result,
`pr_track`, a PR under `pr_watch` and the PR of the current branch. A PR is identified by host, owner, repo and number. At
most six are tracked. A closed or merged PR disappears from the row.

Cost: on gh one GraphQL batch per tick and host covers every tracked PR (state, mergeability, review and checks), every
`tools.prWatchSeconds` (floor 30 s), plus a few `pr_find` lookups for pushed branches and one author search every second
tick, on top of the polls `pr_watch` makes itself. On glab and template hosts each tracked PR costs two calls (checks and
mergeability), at most 12 for six PRs. A PR that a watch covers reuses the watch's checks snapshot. See
[tools](tools.md#call-budget) and [tools](tools.md#watch). `tools.prDots: false` keeps the poller from starting at all (the
PR tools stay on).

### Data

The live file (`state/live/<session>.json`) and `foreman_radar.py --json` carry these fields for the activity lines. They
are additive: older readers ignore them, and each is present only when there is data.

| Field | Where | Content |
|---|---|---|
| `started` | radar session node | start time, used for sibling order (oldest first within a rank) |
| `bg` | a wait | `true` for a `foreman_bg` command |
| `prs` | the `pr_watch` wait | the watched PR numbers |
| `tasks` | live file, radar session node | this session's own `bg_run` add-on tasks: `id`, `label`, `pid`, `ageSeconds` |
| `asks` | live file, radar session node | `[{n, topic}]` while the session's own handoff ask is open |
| `dots` | live file, radar session node | the dots row: `[{n, state, label, src}]`, at most 14; `n` is the PR number or `null`, `state` one of `fail`, `run`, `ok`, `none`, `label` at most 20 characters, `src` `pr` or `ext` (the external status hook). The radar copies it unchanged to the session node; the `prs` field of the `pr_watch` wait is separate and unchanged |

The sidebar sorts them into lines: child runs go to `fm_a1` (agents); `tasks`, waits with `bg` and the `pr_watch` wait
(with its `prs`) go to `fm_a2` (tasks and watches); other waits and `asks` go to `fm_a3` (`? ask <n>: <topic>`, then the
waits); `dots` go to the pr row (`fm_pr1`..`fm_pr4`), pull request and external items mixed in one order.

### Header glyphs and colours

The state slot of `fm_hd` holds one glyph: a spinner frame while the session animates, else the state glyph. The
reason icon (what the session waits on) is not in the header; it leads the detail lines below. The sidebar decides from
the session's state (`sym`) and its reason whether the glyph animates.

Reason of a session, first match wins:

| Reason | Icon (`unicode`) | When |
|---|---|---|
| `ask` | ? | a child run is in state `ask` (rare: a forwarded child prompt normally opens a dialog, and the session is then blocked) |
| `review` | ◎ (the agents line shows the run with `◆`) | a live run with role `reviewer` or `senior-reviewer` |
| `agent` | ◆ | any other live run, or a live child session without a pane row (see Activity lines) |
| `task` | ⚙ | a PR or CI wait, a wait flagged `bg`, or a background task |
| `wait` | ◷ | any other wait: timer, file, child, pid |
| none | blank | the session's own turn |

State and cell:

| `sym` | Cell (`unicode`) | Animated |
|---|---|---|
| `working` (a turn or run; registry `starting` and `pending` too) | spinner frame | yes |
| `waiting-external` (only waits pending) | spinner frame | yes |
| `idle` with a reason (a run runs while the session has no turn) | spinner frame | yes |
| `waiting-owner`, `blocked` (a dialog, checkpoint or ask waits for you) | ✋ | no |
| `waiting`, `idle` without a reason | ⏸ | no |
| `done` | ✓ | no |
| `lost` | ✗ | no |
| blocked longer than 15 minutes | `!` right after the age (`16m!`), red | no |

A session that waits for you never animates, so ✋ stays whatever else runs. The age at the right is the time since the
session's last event (the blocked time while blocked); how long a wait itself has run is on the waits line.

**Non-ticking header.** The animation is a template (`fm_hd_tpl`) that the session's own publisher fills with the
current frame. A pane the daemon publishes, `ui.spinner: false` and a publisher whose gate is off send no frames; the
header then shows the set's static glyph of the state alone: ⏳ for working, `↻` for waiting-external and ⏸ for idle
in `unicode`. Without a frame, an idle session with a reason looks like a truly idle ⏸ line; its detail line tells
them apart.

**Slot width.** The slot is as wide as the widest spinner frame or static state glyph of the set: 2 cells for
`unicode` (⏳ and ✋ are wide) and `emoji` (⏳, ✋, ✅, ❌ and `⏸️` count 2), 1 for `nerd` and `ascii`. Every cell is padded
with blank cells (U+2800) to that width, so the label column is the same in every row of a set, with or without a
reason, for a frame or a static glyph. The width counts `⏸️` and other VS16 sequences as 2 cells; a terminal that
draws them in one cell shifts that row's label by one, so check the slot in yours (`sample --reason all --dry-run`).

The snippet colours the whole header line by a glyph it contains (Herdr rules match substrings of the value), with a
base colour for the own-turn line. Rules, first match wins: `!` red and bold, blocked `✋` and asking `?` yellow, lost `✗`
red, done `✓` and idle `⏸` dim grey. That is six rules per set, within Herdr's 16. No rule matches a spinner
frame, so the frame takes the base green. The reason icons have no header rule: `fm_a1` colours `◆` blue and `fm_a3`
colours an open ask yellow. The `ascii` set has no colour rules and no base colour, because its glyphs would collide
with label text. A `!` or a state glyph in a label also triggers its rule (labels are slugs, so this is rare).
`fm_a1`, `fm_a2`, `fm_a3` and `fm_meta` are dim with no colour, so they follow your theme. The hex values are
placeholders; pick the ones that suit your theme.

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

With another `ui.symbols` set the glyphs follow the tables in Symbols. After updating, re-run `configure`, merge the new
snippet again and run `herdr server reload-config`; your own `config.toml` is never edited by pi-foreman.

## Tokens

All tokens come from the source `plugin:pi-foreman.sidebar`, with a 15 s TTL (60 s for `run --once`), refreshed
every 5 s by the session or, for a pane it does not push, the daemon; values are at most 80 characters.

| Token | Value |
|---|---|
| `fm_hd` | tree prefix, state slot (2 cells, 1 for `nerd` and `ascii`), label; the age or blocked timer right-aligned, `!` right after it when blocked longer than 15 minutes |
| `fm_a1` | agents (see Activity lines) |
| `fm_a2` | tasks and watches |
| `fm_a3` | waits and an open ask |
| `fm_pr1`..`fm_pr4` | PR status dots, one cell each: a circle (`pr-fail`, `pr-run`, `pr-ok`, `pr-none` of the glyph set) and the label (`#21`), ordered red, yellow, green, unknown; cells that do not fit collapse into a last `+n` cell |
| `fm_meta` | `↑in ↓out · $cost · ✓n` and the pressure suffix; `in` counts uncached input only (fresh input plus cache writes, from the usage file), `↑~n` marks the raw total incl. cache reads when no usage file has the split; radar and its JSON keep the raw total. When it does not fit, the `↑↓` counts drop as a whole first, then the text is cut; hidden below 20 columns |
| `fm_state` | `working`, `waiting`, `asking`, `blocked`, `done` or `lost`, for your own rules |
| `fm_block_s` | seconds blocked, set only while blocked, for your own `gt`/`lt` rules |
| `fm_sort` | parent-first sort key (`r001`, `r001.c001`) |

The older tokens `fm_sym`, `fm_l1`, `fm_l2`, `fm_l3` and `fm_cost` were removed in Round 53 (a pane takes at most 16 tokens);
the daemon nulls them once at shutdown and on clears, and a session's final push nulls them too.

Width: `--width`, else `HERDR_SIDEBAR_WIDTH`, else `ui.sidebar_width` from Herdr's `config.toml` (read only), else 26
(Herdr's default). Herdr may auto-scale the panel between `ui.sidebar_min_width` and `ui.sidebar_max_width`; set the
width you see when it differs. Each token has `width − 2 (panel frame) − 1 (safety column)` cells; the plugin measures
glyphs like `wcwidth` and Herdr's renderer (a variation selector makes a glyph 2 cells; `⏳` and `✋` are 2, `⏸` and `⚙`
are 1). Nothing wraps.

A session is joined to its pane by the presence file's `paneId` (pi-foreman writes `HERDR_PANE_ID` there), else by the
pane's foreground pid, else by a working directory only one Pi pane has. When several presence files name the same pane
(sessions restarted in it), the live one wins. A finished, stale or lost session never joins by working directory, and the
daemon clears the `fm_*` keys of a Pi pane no session is joined to (once), so a new pane in the folder of an earlier
session does not show that session's row. When a session leaves radar its tokens are cleared at once; if the
daemon dies they expire with the TTL.

A pane whose push stamp is fresh but that carries no `fm_hd` (agent.list shows none) is composed by the daemon instead
of staying blank.

## Who publishes what

The Pi session publishes its own pane, so a spawn, a finished run or a state change shows within a fraction of a second
instead of after the next poll. The composing stays in Python and the publishing is TypeScript: on run start and end, ask open and close, state change, its own asks,
permission prompts and decisions, and every 5 s the session runs `python3 sidebar.py push --json --session <id> --pane <pane>`
(also `--symbols`, `--agent-dir`), which prints `{tokens, fm_hd_tpl, stamp, pane}` and reports nothing, and then sends
`pane.report_metadata` over Herdr's socket itself (JSON lines; `HERDR_SOCKET_PATH`, else
`<XDG_CONFIG_HOME or ~/.config>/herdr/herdr.sock`; source `plugin:pi-foreman.sidebar`, TTL 15 s). Only after a successful
report it writes the push stamp (atomically, with the pane id as content); `push --json` writes no stamp and removes
the session's `.tokens` file. The session keeps its own last-sent map and sends an unchanged set again after 10 s. If
the socket report fails, it runs a plain `push` (which reports from Python) for that cycle, so a pane with a fresh stamp
is always published by one of the two. Pushes are debounced to at most 4 per second with one in flight, and take well
under a second. At session end `push --final` publishes a last composed row (done
glyph, done count, totals; normal 15 s TTL) and removes only the push stamp, so the daemon takes the keys over at its
next tick and the row never goes blank. `--clear` is for the hand smoke and the daemon's cleanup of a lost pane. The session pushes only when `HERDR_ENV=1` and `HERDR_PANE_ID` are set, in TUI mode, with Python
found. Both publishers use the source `plugin:pi-foreman.sidebar`. Herdr token reports are per-key patches with a TTL
per key (15 s here), so each publisher owns fixed keys and omits the others.

| Session | Daemon | Session keys (`fm_hd` `fm_a1` `fm_a2` `fm_a3` `fm_pr1`..`fm_pr4` `fm_meta` `fm_state` `fm_block_s`) |
|---|---|---|
| pushed under 15 s ago, radar sees it live | only `fm_sort`, and the tree layout (`layout.json` in the state folder, read by `push` for the `├─`/`└─` prefix) | published by the session |
| older session without push, no push for 15 s (hung), lost, stale or done | every key, as before | not published |

The push stamp is `push/<session id>.stamp` in the state folder; the daemon takes a pane over within one tick when it
goes stale. A usage byte-offset cache (`push/<session id>.usage.json`) keeps the push short on long sessions.

### Spinner

A live session that works, waits on something external or runs a child shows dense braille frames (`⣾⣽⣻⢿⡿⣟⣯⣷`; `| / - \`
in the `ascii` set) in the state slot of `fm_hd`. The frame is
`floor(epoch ms / 250) mod frames`, so every pane and the TUI show the same frame at the same time; the rate is bounded
at 4 frames a second. Python composes the header with a `{spin}` slot (`fm_hd_tpl`); the TypeScript publisher swaps the
current frame in and, every 250 ms while the session is neither blocked nor done and Python gave it a template, sends only
`fm_hd`. A session with no template (idle with no reason) does not tick. A long wait (a PR watch can run for hours) ticks
like a working turn, so it sends `fm_hd` four times a second: that is the cost of showing a live wait. The timer stops
when the session is blocked or done, and at shutdown. Panes the daemon publishes keep the static header (see Header glyphs
and colours). `ui.spinner: false` (in `foreman.json`)
turns the animation off everywhere: static glyphs in the sidebar and the widget. See
[sessions](sessions.md#further-session-keys).

Recent runs: a run that ended shows as `✓ role` on line 2 for `radar.recentRunSeconds` (default 8), then moves into
the `✓n` count. Tokens: `fm_meta` counts uncached input (see its row above); radar's TUI and JSON keep the raw totals.

Opened sessions: a registry entry (`sessions.json`) whose handoff dir matches a live session is merged into that node, so
a working child shows once under its parent, never as a second `✗ lost` row. An `open` entry with a `result.md` and no
live file shows as idle. The opener id is `--parent-id`, `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`, then the
config `stableId`; a child that closes marks its own entry `closed`. A remote child (`--machine`, see [remote child sessions](sessions.md#remote-child-sessions)) is shown as `label@machine · state · age` with its pull age; its state comes from the pull, not from a local live file, so it is `lost` when no pull has succeeded in the window.

Ask signal: when a session opened by `foreman session open` writes `ask.md` (first line `# Ask <n>: <topic>`) in its own
handoff dir, pi-foreman touches `<handoff>/.ask` and opens a blocked source, so Herdr shows `blocked` with the label
`ask <n>: <topic>` (`herdr:blocked`, the same channel as a dialog; never `herdr agent prompt`). Writing `.seen` in that
dir, or shutdown, releases it; a ruling wait that ends as `superseded by brief <path>` (see [sessions](sessions.md)) does not release it. A parent that is not a Pi session polls `*.md` and `.ask`; the file contract is in
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

### Attention highlight

Herdr marks an agent that needs you from its agent status, and it has no separate switch for the highlight in its
config reference (`herdr --default-config`): the highlight follows the status. pi-foreman raises that status through the
`herdr:blocked` event whenever the sidebar draws ✋ or `?` for a session: a dialog or permission prompt, a checkpoint,
the ask-by-file `.ask` of a child session, and a forwarded child prompt that a child run is waiting on. See
[blocked shim](sessions.md#blocked-shim), including when the shim steps aside (Herdr's own integration, version 10 or
later, takes over) and the `herdr.blockedShim` switch.

Two Herdr keys change how the attention shows. Both are commented in the snippet, because the plugin never writes your
`config.toml`; check the names against your Herdr's reference (`herdr --default-config`) before you uncomment them:

| Key | Values | Effect |
|---|---|---|
| `ui.agent_panel_sort` | `"spaces"` (default, grouped by space), `"priority"` (the attention queue) | order of the Agents panel; with `priority`, agents that need you come first |
| `ui.sound.request_path` | path to an mp3 | the sound for needs-attention notifications (a blocked session); `path` and `done_path` set the others |

With pi-foreman's own view (see above) the foreman panes come first whatever `agent_panel_sort` says.

## Symbols

`ui.symbols` in `foreman.json` picks the glyph set for radar, the children widget and this plugin (via
`foreman radar --json`): `unicode` (default, the broadest terminal support), `emoji`, `nerd` or `ascii`; an unknown value
reads as `unicode`. See [sessions](sessions.md#further-session-keys). The sets live in `config/symbols.json`.

`nerd` needs a terminal font that contains the Nerd Font symbols (a patched Nerd Font, or the symbols-only font as a
fallback); otherwise the glyphs render blank. `emoji` needs a font with colour emoji. `ascii` works everywhere but
has no colour rules in the snippet. The plugin installs no fonts. Check the glyphs of a set in your terminal (zsh, bash 4.2+;
each glyph must show between its bars, with no blank or box):

```sh
python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))[sys.argv[2]]; print("".join("|%s|" % v if isinstance(v, str) else "|%s|" % "".join(v) for v in s.values()))' config/symbols.json emoji
```

| State | `unicode` | `emoji` | `nerd` | `ascii` |
|---|---|---|---|---|
| working (no spinner; the glyph of a non-ticking header) | ⏳ | ⏳ | U+F252 | `*` |
| waiting, idle | ⏸ | ⏸️ | U+F04C | `.` |
| asking (a run waits for you) | ? | ❓ | U+F128 | `?` |
| blocked, waiting-owner | ✋ | ✋ | U+F256 | `#` |
| done | ✓ | ✅ | U+F00C | `+` |
| lost | ✗ | ❌ | U+F00D | `x` |
| keep-alive | ♨ | ♨️ | U+F06D | `^` |
| waiting-external | ↻ | 🔄 | U+F017 | `@` |

Activity glyphs and the spinner:

| Key | `unicode` | `emoji` | `nerd` | `ascii` |
|---|---|---|---|---|
| `spinner` (frames) | `⣾⣽⣻⢿⡿⣟⣯⣷` | same | same | `\| / - \` |
| `review` | ◎ | 🔍 | U+F002 | `&` |
| `agent` | ◆ | 🤖 | U+F544 | `>` |
| `task` | ⚙ | ⚙️ | U+F013 | `=` |
| `wait` | ◷ | ⏱️ | U+F017 | `~` |
| `ask` | ? | ❓ | U+F128 | `?` |
| `recent` | ✓ | ✅ | U+F00C | `+` |
| `pr-fail` | ● | ● | U+F111 | `x` |
| `pr-run` | ◉ | ◉ | U+F192 | `*` |
| `pr-ok` | ○ | ○ | U+F10C | `o` |
| `pr-none` | ◌ | ◌ | U+F1DB | `.` |

## External status

The dots row can also show items from a program you run yourself, for example a deployment or build status that has no
pull request. Two keys under `sidebar` in `foreman.json`:

| Key | Default | Meaning |
|---|---|---|
| `sidebar.statusCommand` | unset (off) | one command line, split like a POSIX shell (quotes and backslashes, no expansion, no shell runs) |
| `sidebar.statusSeconds` | `60` | seconds between two runs (integer 10..3600) |

```json
{ "sidebar": { "statusCommand": "/path/to/your-status-program --short", "statusSeconds": 60 } }
```

- **Where it may be set.** User config or an overlay only. A value in the project config or the session config is ignored
  with a warning, because the command runs a program.
- **The program.** The first word is looked up on `PATH`, or is an absolute path. Its real path (symlinks resolved)
  must lie outside the workspace; a `.cmd` or `.bat` file is refused. Otherwise nothing runs (the trace says `program_missing`).
- **The run.** In the session's working directory, without a shell and in its own process group, with the environment
  plus `PI_FOREMAN_SESSION_ID` (the session id) and `PI_FOREMAN_BRANCH` (the current branch). After 10 s the whole process
  group is killed. Stdout is read up to 16 KB and stderr up to 4 KB; more is cut or, for stdout, rejects the output.
  The next run starts `sidebar.statusSeconds` after the previous one ended; only one runs at a time.
- **The output.** Exit code 0 and a JSON array of objects `{label, state}` on stdout. The first 8 items are kept. The
  label is cut to 20 characters and stripped of control characters (and secrets the trace redaction knows). `state` is
  one of `fail`, `run`, `ok`, `none`; any other value is `none`. Other keys are ignored. Anything that is not such an
  array (or a non-zero exit, or a timeout) is rejected: the previous items stay for one more interval, then the row
  loses its external items.
- **Display data only.** The items go to the sidebar and nowhere else: they never reach the model, never become a
  message and keep no link. The program and its output are untrusted.
- **Trace and doctor.** Each run writes a `sidebar_status` trace event with its outcome (`ok`, `bad_output`, `failed`,
  `timeout` or `program_missing`) and the item count, plus the first line of stderr (redacted, at most 200 characters) when the program fails; never the
  output. `foreman doctor` shows an INFO line `sidebar status: off` or `sidebar status: on (<program>)`.

The items join the pull request dots in the same row and order (see Dots). Overlay authors: see
[overlays](overlays.md#external-sidebar-status).

## Optional add-on: background tasks

Nothing in pi-foreman requires it. `pi-background-tasks` runs shell commands in the background with status, logs and kill (`bg_run`). It is an optional add-on in `config/addons.json` (exact pin, consent only). Install it with `foreman setup --addon background-tasks` (or the picker), or by hand with `pi install npm:pi-background-tasks@2.6.10`, and set the variable in your shell profile:

    export PI_BG_FEATURES=process

The add-on reads `PI_BG_FEATURES` when Pi starts, not at install, so a prefix on `pi install` does nothing. `PI_BG_FEATURES=process` selects the process features only. Its other feature, an attribution hook, overrides the provider
named `anthropic` and decides by provider name (`model.provider === 'anthropic'`). A `claude-bridge` provider serving `claude-*` ids is not
treated as an Anthropic route by that check, but the override takes over the global `anthropic` provider slot, so keep attribution off.
`foreman setup` prints the consent line and this variable hint; see [Profiles, features and add-ons](install.md#profiles-features-and-add-ons).

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
