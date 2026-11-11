# Herdr sidebar plugin

> Covers the `pi-foreman.sidebar` Herdr plugin: install, the rows snippet to merge into Herdr's config,
> the `fm_*` pane tokens, the activity lines, the spinner, who publishes, the Agents view sort, the `ui.symbols`
> glyph sets, and the known limits of Herdr's plugin API.

The plugin `integrations/herdr/pi-foreman-sidebar/` shows the pi-foreman session tree in Herdr's Agents panel: per Pi
pane a header (tree connector, a state glyph or spinner frame, label, age or blocked timer), one line each for what runs (agents),
what it watches (tasks, PR watches, CI) and what it waits on, a row of status dots for external status items, and a line with tokens and cost. It needs Herdr
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
shows a synthetic session (live agents, a PR watch, an open ask, the pressure suffix and the dots row: `pr` one dot per
state, `mixed` several, an external item and `+3`) on one pane so you can judge the colour rules in the snippet live.
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

**Checking the PR colours:** `python3 sidebar.py configure --check [--symbols <set>] [--config <path>]` (`check` is an alias) reads the Herdr `config.toml` (default: Herdr's config dir) and compares the `$fm_pr1..4` colour rules with the glyphs of the set. It prints one line: `ok` when they match, `stale: ...` naming the expected and configured glyphs otherwise. It exits 0 when ok, 1 when stale or a token is missing, 2 when the file is unreadable or has no `pi` rows; it writes nothing. The daemon runs the same check once at start and logs one line when the rules are stale. After changing `ui.symbols`, re-run `configure` and merge the snippet.

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
| `fm_pr1`..`fm_pr4` | `● #17 · ◉ #21`: status dots of external items (see Dots) |
| `fm_meta` | `↑287k ↓7.4k · $3.32 · ✓3`, plus the host pressure suffix and ` · owner present|away|grace|unknown` (the owner's presence as the cache warms see it) |

In the herdr-app mod's Agents tree a `closed`, `lost` or `finished` child session is ended: its row is dropped unless a live session sits below it (then it stays dimmed). A registry entry whose process and terminal are both gone counts as ended (an unreadable terminal listing counts as present). A hand-made `hc attach <machine>/<t>` terminal shows as the attach of that remote session (`<label>@<machine>`) when the target is a known remote session terminal (`fm-<label>-xxxx`), else it has no row. A hand-made attach of a target a radar session node represents is no row either: the remote session card is its row, and a click on that card focuses the attach terminal (or opens one). The "No foreman radar on <machine>" hint is not printed for a machine whose sessions the local radar already shows. A local registry child whose process is gone and whose terminal is provably unlisted is shown as closed and so dropped (an unreadable listing keeps it); so is a handoff-only session (no registry entry, no live file) whose handoff dir shows no activity for 15 minutes.

A done session shows `done · n runs` on `fm_a1`, a lost one `lost`. A child session without its own pane row (a closed
or idle one, a stale registry entry) is listed on `fm_a1` only while it is live: a session whose state is `idle`,
`waiting`, `done`, `lost`, `closed` or `closing` leaves the line and the hidden `+n` count, one that works (starting and
pending included), waits on something external or waits for you stays. The same test decides the agent reason of
the parent (its detail line). A live, self-publishing working session shows a spinner frame in the state cell (see Spinner);
waiting is working: while a `foreman_wait` or `foreman_bg` is pending the state stays `working`
and Herdr's status stays working, and the wait shows on its activity line.

#### Dots

The dots row shows one circle and a short label per external status item (see [External status](#external-status)), in the
glyph set's `pr-fail`, `pr-run`, `pr-ok` and `pr-none` keys (see Symbols). The `emoji` set uses the same text circles as
`unicode`, one cell each, so the row keeps its line height and the pr rules colour them. Pull requests are not drawn here
and no longer tracked in the Pi session: the herdr-app mod is the only PR display (see Open PRs below; users without it keep
`pr_status` and `pr_checks`). Sidebar tokens stay plain text: no hyperlinks and no colour codes.

| State | Circle (`unicode`) | Meaning of a pull request |
|---|---|---|
| `fail` | ● | the item failed |
| `run` | ◉ | the item is running |
| `ok` | ○ | the item is fine |
| `none` | ◌ | no state, or the state is unknown |

The order is red, yellow, green, unknown, then by label. At most four cells fit the row; when items are hidden by the cell count or by the width, the last placed cell
becomes `+n` (n = items not shown). At most 14 dots reach the sidebar.

### Data

The live file (`state/live/<session>.json`) and `foreman_radar.py --json` carry these fields for the activity lines. They
are additive: older readers ignore them, and each is present only when there is data.

| Field | Where | Content |
|---|---|---|
| `started` | radar session node | start time, used for sibling order (oldest first within a rank) |
| `bg` | a wait | `true` for a `foreman_bg` command |
| `prs` | the `pr_watch` wait | the watched PR numbers |
| `unreviewed` | the `pr_watch` wait | `[{n, repo, host}]`, present only for watched PRs whose head moved past the session's last reviewer PASS (see [tools](tools.md#watch)); the herdr-app mod matches it to the PR chip by number, repository and host and shows `unreviewed head` on the chip and its hover card; the sidebar's `fm_a2` item reads `pr #<n> unreviewed head`. A PR the session only follows has no entry; a PASS on the head or the end of the PR removes it |
| `tasks` | live file, radar session node | this session's own `bg_run` add-on tasks: `id`, `label`, `pid`, `ageSeconds` |
| `asks` | live file, radar session node | `[{n, topic}]` while the session's own handoff ask is open |
| `dots` | live file, radar session node | the dots row: `[{n, state, label, src}]`, at most 14: the external status items (`src` `ext`); `n` is `null`, `state` one of `fail`, `run`, `ok`, `none`, `label` at most 20 characters. The extension writes no `pr` dots any more; the radar still reads one from an older live file (`url`) and the herdr-app mod draws one aggregate dot for it (the job list of the hover card comes from the `openPrs` feed). The radar copies the dots to the session node unless the live file is stale (heartbeat older than 90 s, the lost rule) or its session is done, so a finished session keeps no PR dot from before a merge; the herdr-app mod counts a PR seen twice once and skips a merged or closed one. The `prs` field of the `pr_watch` wait is separate and unchanged |
| `repo`, `branch` | live file, radar session node | `owner/name` of the origin remote and the checked-out branch (each present only when known); the herdr-app mod attaches a feed PR to the session with equal repo and head branch, and also one the session watches (`prs`, see above) whose repo or head repo is the session's |

The sidebar sorts them into lines: child runs go to `fm_a1` (agents); `tasks`, waits with `bg` and the `pr_watch` wait
(with its `prs`) go to `fm_a2` (tasks and watches); other waits and `asks` go to `fm_a3` (`? ask <n>: <topic>`, then the
waits); `dots` go to the pr row (`fm_pr1`..`fm_pr4`).

### Header glyphs and colours

The state slot of `fm_hd` holds one glyph: a spinner frame while the session animates, else the state glyph. The
reason icon (what the session waits on) is not in the header; it leads the detail lines below. The sidebar decides from
the session's state (`sym`) and its reason whether the glyph animates. State (`fm_state`) and spinner come from one
source, the session's push (`sidebar.py push --json`): the publisher ticks only while the last push carried a `{spin}`
template, and sends the static header again when the ticking stops, so no frozen frame stays.

Reason of a session, first match wins:

| Reason | Icon (`unicode`) | When |
|---|---|---|
| `ask` | ? | a child run is in state `ask` (a forwarded child prompt waits for you; the header shows `needs-you`) |
| `review` | ◎ (the agents line shows the run with `◆`) | a live run with role `reviewer` |
| `agent` | ◆ | any other live run, or a live child session without a pane row (see Activity lines) |
| `task` | ⚙ | a PR or CI wait, a wait flagged `bg`, or a background task |
| `wait` | ◷ | any other wait: timer, file, child, pid |
| none | blank | the session's own turn |

State and cell:

| `sym` | Cell (`unicode`) | Animated |
|---|---|---|
| `needs-you` (an own dialog or ask, an open `ask.md` with no `ruling-<n>.md`, or a child's ask forwarded to this session) | ❓ (`?` in `ascii`) | no: beats the spinner |
| `working` (a turn or run; registry `starting` and `pending` too) | spinner frame | yes |
| `waiting-external` or `idle` while the session has work of its own: a child run or live child session, a `bg_run` or `foreman_bg` task, a running `pr_watch` or `foreman_wait` | spinner frame | yes |
| `waiting-external` with no local work | ↻ | no |
| `waiting-owner`, `blocked` (legacy: the turn ended and it is your move) | ✋ | no |
| `waiting`, `idle` with nothing active | ⏸ | no |
| `done` | ✓ | no |
| `lost` | ✗ | no |
| blocked longer than 15 minutes | `!` right after the age (`16m!`), red | no |

The spinner means something in this session is still active: its own turn, or any of its own background work. It stops
only when nothing is active, and a still symbol takes its place. A session that waits for you never animates, so ❓
stays whatever else runs; it clears when the dialog is answered or times out, the ruling file appears, or the forwarded
ask is answered or its run ends. The age at the right is the time since the
session's last event (the blocked time while blocked); how long a wait itself has run is on the waits line.

**Non-ticking header.** The animation is a template (`fm_hd_tpl`) that the session's own publisher fills with the
current frame. A pane the daemon publishes, `ui.spinner: false` and a publisher whose gate is off send no frames; the
header then shows the set's static glyph of the state alone: ⏳ for working, `↻` for waiting-external and ⏸ for idle
in `unicode`. Without a frame, an idle session with a reason looks like a truly idle ⏸ line; its detail line tells
them apart. Needs-you is never a frame: it shows ❓ in every pane.

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

The presence file (`state/live/<session>.json`) carries `presence`, one of six names; each has its own icon key in
`config/symbols.json`. Precedence: `done` > `needs-you` > `working` > `waiting-external` > `idle` (a finished
session is `done` whatever else is still open). The legacy `state` field is unchanged for older readers (`blocked` is
an own dialog; `waiting-external` still reads `working`), and `presence` is absent from files written by older versions.
The radar derives `needs-you` from the file too (an open `asks` entry, or a child run in state `ask`), so a parent whose
turn ended still shows ❓ while a forwarded child ask waits.

**Away field.** The presence file gains the optional `away: true`, written only while a foreman warm window is open and
the presence probe says the owner is away (read at write time, so it cannot go stale); the radar JSON carries it and
`fm_meta` shows ` · away` for files without `owner`. Absent in files of older versions.

**Owner field.** The presence file also carries `owner`: `present`, `away`, `grace` or `unknown`, the owner's presence as the
cache-warm tiers read it (the presence probe, from `presence.ts`, plus a 15-minute grace after the owner goes away; a failed
or unsampled probe is `unknown`; a child session is always `present`). It is read at write time, for debugging the away
rule; `presence` and `away` are unchanged. The radar JSON carries `owner` when the file has a valid value.

| `presence` | `state_icon` glyph (unicode / nerd) | Meaning |
|---|---|---|
| `working` | ⏳ / `\uf252` | the foreman turn runs, or a child run is live, with nothing for you to do |
| `needs-you` | ❓ / `\uf128` (`?` in `ascii`) | an own permission dialog, `ask_user_question`, guard or drift ask or checkpoint, an open `ask.md` with no `ruling-<n>.md`, or a child's ask forwarded to this session waits for you |
| `waiting-owner` | ✋ / `\uf256` | older files only: an open ask or dialog (now `needs-you`) |
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
| `fm_pr1`..`fm_pr4` | status dots of external items, one cell each: a circle (`pr-fail`, `pr-run`, `pr-ok`, `pr-none` of the glyph set) and the label, ordered red, yellow, green, unknown; cells that do not fit collapse into a last `+n` cell |
| `fm_meta` | `↑in ↓out · $cost · ✓n` and the pressure suffix and ` · owner <state>` (the presence file's `owner`: `present`, `away`, `grace` or `unknown`; files without it keep ` · away` for `away: true`; kept like the pressure suffix when space runs out); `in` counts uncached input only (fresh input plus cache writes, from the usage file), `↑~n` marks the raw total incl. cache reads when no usage file has the split; radar and its JSON keep the raw total. When it does not fit, the `↑↓` counts drop as a whole first, then the text is cut; hidden below 20 columns |
| `fm_state` | `working`, `waiting`, `asking`, `blocked`, `done`, `lost`, `waiting-owner`, `waiting-external`, `idle` or `needs-you`, for your own rules |
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
pane's foreground pid, else by the Pi session id that Herdr's `agent_session` (the Pi session file path) names, else by a
working directory only one Pi pane has. The session id survives a Herdr restart, which changes pane ids. Parent links come
from the persisted records, not from memory: the registry `parent`, the handoff `parent` file and the handoff `live.json`
(`piSessionId`); a parent may be named by its intercom id or its Pi session id. A live child with no pane is shown on its
parent's agents line, never as a root, and the `N children` count of the group tag counts the same children. When several presence files name the same pane
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
turns the animation off everywhere: static glyphs in the sidebar. See
[sessions](sessions.md#further-session-keys).

Recent runs: a run that ended shows as `✓ role` on line 2 for `radar.recentRunSeconds` (default 8), then moves into
the `✓n` count. Tokens: `fm_meta` counts uncached input (see its row above); radar's TUI and JSON keep the raw totals.

Opened sessions: a registry entry (`sessions.json`) whose handoff dir matches a live session is merged into that node, so
a working child shows once under its parent, never as a second `✗ lost` row. An `open` entry with a `result.md` and no
live file shows as idle. The opener id is `--parent-id`, `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`, then the
config `stableId`; a child that closes marks its own entry `closed`. A remote child (`--machine`, see [remote child sessions](sessions.md#remote-child-sessions)) is shown as `label@machine · state · age`; its state is `ask` when an ask is set, else the hc terminal status the watcher stores in `remoteLive` (the registry status only before the first hc status), not a local live file.

Ask signal: when a session opened by `foreman session open` writes `ask.md` (first line `# Ask <n>: <topic>`) in its own
handoff dir, pi-foreman touches `<handoff>/.ask` and opens a blocked source, so Herdr shows `blocked` with the label
`ask <n>: <topic>` (`herdr:blocked`, the same channel as a dialog; never `herdr agent prompt`). Writing `.seen` in that
dir, or shutdown, releases it; a ruling wait that ends as `superseded by brief <path>` (see [sessions](sessions.md)) does not release it. A parent that is not a Pi session polls `*.md` and `.ask`; the file contract is in
[sessions](sessions.md#ask-by-file-parent-that-is-not-a-pi-session).

## Remote clients and Pi pane status

Herdr holds one `agent_status` per pane. A remote client (a phone or web app installed as a Herdr plugin, or `herdr --remote`)
shows that status for each pane. It does not read pi-foreman's state directly.

- Herdr learns working and idle for a Pi pane from its Pi integration. That is a setting on the machine that runs Herdr:
  `herdr integration install pi` (check with `herdr integration status`). Nothing is installed or configured on the phone
  or the remote client for this.
- An `ask_user_question` or `plan_mode_question` call counts as blocked from its tool call to its end (`tool_execution_end`) on its own, without Pi's `ui_prompt_*` events; `turn_start` and `agent_end` release it too (labelled by the first question's header, else `question`). See [blocked shim](sessions.md#blocked-shim).
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

`ui.symbols` in `foreman.json` picks the glyph set for radar, the footer and this plugin (via
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
| needs-you (a dialog or ask waits for you) | ❓ | ❓ | U+F128 | `?` |

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
| `rule` | ─ | ─ | ─ | `-` |

## External status

The dots row shows items from a program you run yourself, for example a deployment or build status. Two keys under `sidebar` in `foreman.json`:

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

The items fill the dots row in this order (see Dots). Overlay authors: see
[overlays](overlays.md#external-sidebar-status).

## Optional add-on: background tasks

Nothing in pi-foreman requires it. `pi-background-tasks` runs shell commands in the background with status, logs and kill (`bg_run`). It is a default add-on in `config/addons.json` (exact pin); a plain `foreman setup` installs it and writes the variable below into your shell profile (skip with `--skip-addon background-tasks` or `--no-env`). By hand: `pi install npm:pi-background-tasks@2.6.10`, then set the variable in your shell profile:

    export PI_BG_FEATURES=process

On Windows pi-foreman also sets `PI_BG_SHELL=bash` and `PI_BG_SHELL_PATH=<Git Bash>` when its extension loads, unless you set either yourself, so `bg_run` runs under Git Bash instead of `cmd.exe`; `foreman setup` keeps pi-foreman ahead of the add-on in `packages` for that. The add-on reads `PI_BG_FEATURES` when Pi starts, not at install, so a prefix on `pi install` does nothing. `PI_BG_FEATURES=process` selects the process features only. Its other feature, an attribution hook, overrides the provider
named `anthropic` and decides by provider name (`model.provider === 'anthropic'`). A `claude-bridge` provider serving `claude-*` ids is not
treated as an Anthropic route by that check, but the override takes over the global `anthropic` provider slot, so keep attribution off.
`foreman setup` reports what it wrote or leaves a hint; see [Profiles, features and add-ons](install.md#profiles-features-and-add-ons).

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

## herdr-app and herdr-core

**Experimental.** herdr-app is the desktop app on herdr-core, a terminal host driven by the `hc` command. Its panes set
`HC_TERMINAL_ID` (an address such as `t1`), `HC_SCOPE` and `HC_TERMINAL_SOCKET` and no `HERDR_*` variable, so the TUI-only
pieces above (the `herdr:blocked` shim, the group tag, the sidebar plugin and its tokens) stay off there by construction. A Pi
in such a terminal reports its own state to herdr-core, so no shim is needed.

**Detection.** `foreman session open` reads `HC_TERMINAL_ID` and finds `hc` on PATH, or at `HC_BIN`. The rule lives in one
place, `backend_of` in `scripts/foreman_session.py`. With `HERDR_PANE_ID` set the TUI wins, even inside an herdr-app terminal.

**Presence field.** The presence file of a session (`<agent dir>/pi-foreman/live/<session id>.json`) gains `hcTerminal`: the
trimmed `HC_TERMINAL_ID`, only when `HERDR_PANE_ID` is empty (a herdr TUI inside an herdr-app terminal would otherwise stamp
every Pi with the same terminal), else `null`. `foreman radar --json` passes it through as `hcTerminal` on each node. The
machine stays on the radar node, as before: an address is relative to its viewer.

**Backend.** `sessions.backend` (user or overlay config only) picks where a local `foreman session open` runs the child:

| Value | Behaviour |
|---|---|
| `auto` (default) | `herdr` when `HERDR_PANE_ID` is set and herdr is found, else `hc` when `HC_TERMINAL_ID` is set and `hc` is found, else the printed command |
| `herdr` | the herdr tab; refused `[backend_unavailable]` without the binary or a server |
| `hc` | `hc run`; refused `[backend_unavailable]` without `hc`; without `HC_TERMINAL_ID` it runs parentless and the receipt says `not nested: no parent terminal` |
| `terminal` | the printed command |

The remote `open --machine` path runs over `hc exec --on`; the remote then runs `hc run` locally on that machine (see [sessions](sessions.md#remote-child-sessions)). `sessions.hc.outliveParent` (default `true`) passes `--outlive-parent`,
so a parent crash never kills a child with uncommitted work; set `false` to let hc end the child with its parent. A child
nests under the terminal that opened it; `--focus` is ignored for a local child (it has no pane of its own; a remote child's `--focus` runs `herdr-app do agent.focus` here, on the local attach terminal when one started) and `foreman close` still asks
the child over intercom. The child runs as `hc run --json --bg --no-notify --keep --cwd <dir> --name fm-<slug>-<hex> [--outlive-parent] -- env -u HERDR_ENV -u HERDR_PANE_ID PATH=<opener PATH> K=V… pi …` (argv, no shell). On Windows the argv after `--` is
`powershell -NoProfile -Command "Remove-Item Env:HERDR_ENV,Env:HERDR_PANE_ID …; $env:PATH = '…'; <the usual PowerShell line>"`.
Three decisions:

- `--no-notify` is always passed and not configurable. Without it hc types notes about a child (blocked, error, exit) into the
  parent terminal, which for a Pi parent is input to its editor. Intercom is the report channel.
- The child gets the core's environment, not the opener's, so the opener's `PATH` is passed explicitly (`pi` and `node` then
  resolve). The two `-u` options drop a TUI pane identity the core may carry, so the child's presence file never records a
  foreign `paneId`.
- `--keep` is always passed and not configurable. After core loss or a reboot a kept child comes back as a shell in its last
  folder at the same address; its command is not rerun. A child that exits or is killed is finished, not restarted, and
  `hc rm` removes it.

A local child gets no `herdr.space` or `herdr.tab` label, so herdr-app shows it as a sub-agent (a floating window) of the
parent's tab, not in a tab of its own. Keeping it as a tab stays available to the user in herdr-app.

A remote child (`--machine`) lives under the remote machine's hc. When the opener runs inside an hc terminal, a second, local
terminal is started for it: `hc run … --rm … -- hc attach <machine>/<t>`, named `fm-<machine>-<slug>-<hex4>` (machine lowercased, other characters `-`; at most 32 characters, slug cut first, then machine; so herdr-app shows the machine), with no herdr labels, so
it floats in the parent's tab like a local child. It uses `--rm` instead of `--keep`: Ctrl+\ (detach), the remote child
ending, or `close-remote` ends it and no terminal stays. The registry entry records it as `attach: {address}`. Without an hc
terminal the open prints `attach: hc attach <machine>/<t>` to run by hand. See
[remote child sessions](sessions.md#remote-child-sessions).

`foreman session list` shows the address (`hc:t2`); the registry entry has `backend: "hc"` and `hc: {address, parent, space}`
(`space` is `null` for a local child; a remote child records its machine's space, the id as `herdr-app ls` prints it, with the `machine/` prefix; `space.new` returns it as a string `space`).
`launch.txt` keeps the usual shell line, so a relaunch is a copy. The final screen of a finished child stays readable (no `--rm`).

**The `pi-foreman` mod.** `integrations/herdr-app/pi-foreman/` is an Agents view for herdr-app (own code on the public mod API;
it replaces the shipped `agents` block of your cloned layout). Grouped by space, each agent that joins a top-most foreman session
gets: label · tier · cost of the session and every nested session (with "N sessions"); the open ask (red when blocked) or the
waits; one two-part dot per PR (see Open PRs below) in a chip on the right of the title row, the same place for the top-level row and every child row: up to two chips, with more PRs one chip of the most urgent PR reading "#n +k" (there is no separate PR line or "N PRs" summary). Resting on a chip shows a tooltip naming the state and the PR ("#16 · CI failing", "CI running", "CI passing", "no CI checks"; `.tooltip(text)`, Herdr 0.1.14) and opens its hover card (0.3 s delay), which adds the details and lists the other PRs of a "+k" chip. The host has no flip or offset for a HoverCard and only clamps it into the window, so the mod picks the card's `anchor` from the chip's window position (`on_mouse_move` bounds, the drawable size from the global `window.viewport_size()`, read as `globalThis.window` because main.js imports herdr's `window` under the same name, and read during `render` (where the host guarantees window measurements) and kept on the instance for the handler; `placeCard` in model.js). The card opens below the chip when it fits there, otherwise on the side with more room, otherwise beside the chip. It is never taller than the room on its side; long text is cut off. The card never covers the chip, which stays clickable. A chip click opens the PR without also focusing the pane (`cx.stop_propagation()`). Known limit: the mod sees only the Herdr window's size, not the screen's (the mod API has no display size). With the window dragged partly below the screen edge, the card can open below the chip off screen. Dot colours: green every finished job passed, red a job failed, amber jobs running with none finished (the outer ring turns while any job runs), grey no CI data; merged or closed PRs drop (feed-twin state, or absence from a fresh feed that covers the repo). Non-root sessions (any depth) are bordered cards holding their header, status lines, PR chips and their own agent rows; nested child cards sit outside the parent's card, the root is uncarded and the tree line is continuous. A selected card gets the raised background and an accent border; the root keeps its filled header row. Workers are one
tree row "🤖 role model" (no status circle inside a card). An "Open PRs" section at the bottom lists the PRs of the `openPrs` radar field that no
session shows. The mod is the only PR and run display: Pi itself draws no PR or run widget and no PR or run parts in its footer,
and there is no fallback. Users without herdr-app keep `pr_status`, `pr_checks` and `foreman radar --json`; the feed is GitHub
only (through `gh`, one search per host of `tools.prGithubHosts`), so GitLab users get no PR display.

Background tasks post hc records too: `foreman_bg` runs and, with the pi-background-tasks add-on, `bg_run` tasks write the same OSC 7501 escape pi-subagents writes (key `background-tasks/<id>`, app `pi-foreman`, state working while the task runs, done or error when it ended; no `hc` call, so it works locally, remotely and on Windows). Only under herdr or hc (`HERDR_PANE_ID` or `HC_TERMINAL_ID`) in a TUI session on a terminal, and `PI_PROGRAM_STATUS=0` turns it off. Every record is cleared on session shutdown; after a reload the add-on's running tasks are posted again: the status request goes out at session start and, when the add-on is not ready yet (package load order) or does not answer, repeated after 2 seconds and on the first agent turn until one succeeds. A `foreman_bg` wait that hits its time limit while the process still runs leaves its record working; one cancelled by a session close ends as done "Killed"; one the agent cancels with `foreman_wait` removes its record (pi-foreman no longer watches that process). Trace event `bgrecord`.

The mod reads `foreman radar --json` (every 3 s locally, 15 s per remote space) and, per agent terminal, `hc get <terminal> --json`
(prop `hc` names the binary like `foreman`, default `hc`; failures are ignored) for the `pi-subagents` child records and the `pi-foreman` background-task records in state working or
blocked: they count as running agents (`N agents: titles`, same filled spinner as working) or as a need, also for a terminal with no radar node; radar's
running child runs stay the source and a record with the title of a radar run is not counted twice. It joins a not-done node to an agent on
`hcTerminal` first (the `machine/` prefix for remote spaces; when both sides have a pid they must match), else by the terminal's foreground pid (from the herdr terminal record; the pid fallback skips done, ended and remote nodes and terminals already matched). Without a radar it shows one
dim line and retries every 30 s. A pane-less child terminal (a session started with `hc run`) joins a node the same way (`hcTerminal`, else the foreground pid) and shows the same detail rows under its child line, once, with records polled for it too; only a child that matches no node stays a bare line. The prop `foreman` names the binary: a string for this computer, or an object keyed by machine
name with the key `local`; a missing entry means plain `foreman`. A chip click runs the platform opener (`open`, `xdg-open`,
`rundll32 url.dll,FileProtocolHandler`; never a shell) on an `https://` URL made of URL characters only (no whitespace, no
`& | ^ < > " '`). The URL is the `url` of the feed PR (`https://` only); the click opens the PR page. An opener that exits non-zero or cannot run raises an error notice "Could not open the link" with the exit code and the first error line; a successful open is silent (the Plan panel's links do the same). Session status glyph (hc status of the joined terminal first, else radar; most urgent first):
"Needs you" pill (ask or hc `blocked`), spinner (working; also while child agents run, `N agents: roles`), filled dot (hc `done`, not yet seen), small square (background tasks), hollow muted ring (waits), hollow dot
(idle). Agent rows show 🤖; inside a card they carry no status circle, outside one they keep it. Status lines under a session read `⏳ note · age` (wait) and `⚙ name · age` (bg). Ended sessions are hidden under an agent. Under a session or agent row, each running async agent gets its own line (small
spinner, red when blocked; `explorer · Running bash` from the hc record `msg`; only for agents radar does not already show as a worker row), at most 4, then `+N more`. Install:

1. Copy `integrations/herdr-app/pi-foreman/` to `~/.config/herdr-app/mods/pi-foreman/`.
2. `herdr-app do layout.clone '{"name":"main","as":"foreman"}'`
3. In `~/.config/herdr-app/layouts/foreman.json` change the sidebar list block's `"mod": "agents"` to `"mod": "pi-foreman"` and add
   `"props": { "foreman": "<absolute path>" }` (optional when `foreman` is on the PATH of your environment).
4. `herdr-app check ~/.config/herdr-app/mods/pi-foreman`, then switch to the layout.

Tests: `node --test "integrations/herdr-app/pi-foreman/*.test.mjs" "integrations/herdr-app/pi-foreman-plan/*.test.mjs"` (both are part of `npm run test:node`).

### Versions

Minimum: Herdr app 0.1.13 with core 0.1.18. Recommended and tested: app 0.1.14 with core 0.1.19 (exec timeouts, per-copy state).
On 0.1.13 the mods load, but an `exec` may not honour `timeout`, so a hung program is only stopped by the mods' own watchdogs,
and top-level state is shared between copies of a mod. Every `exec` of a mod passes a `timeout`
(radar read 30 s, PR poll 600 s, `hc get` 10 s local / 15 s remote, `hc run` attach 15 s, URL opener 10 s). If a host rejects
that option, the call is repeated once without it and the mod stops passing it (that behaviour on 0.1.13 is not verified here).
A run stopped by its timeout is no option error; the PR poll and the attach post one error notification per failure. A missing `foreman` (the program does not start: "cannot start ...: program not found" or "cannot run ...: No such file or directory") is a setup state, not a failed poll: the PR poll posts no notice for it, and the radar shows its hint.

Herdr 0.1.14 runs a mod's top level once per source version, shared by all copies of the mod, so per-copy state lives in
`init`. Three things stay app-global on purpose: the keys `pi-foreman.radar`, `pi-foreman.show` and `pi-foreman.show-pending`, and the Agents order.

### Agent row labels

A row is labelled with its tab name. When two or more agents of a space share a tab name, each uses its own terminal title instead
(falling back to the tab name when it has none), so the rows stay distinguishable.

### Detached processes

What outlives a closed tab, and what does not:

- `foreman_bg` runs are detached with their own process group and survive a tab close. `/foreman close` (and an intercom
  `foreman:close`) now sends SIGTERM to the group of each still-running run of that session (Windows: best-effort `taskkill /T`).
  `session_shutdown`, a reload and a cancelled wait do not kill them. Runs started before a `/reload` are not killed by a later
  close either: waits are not restored after a reload, so the session no longer knows them.

- A selfclean helper (`selffinish`) outlives pi on purpose.
- A local `hc run --keep --outlive-parent` session survives by design; `prune` only marks it.
- The mod's own `hc run` attach is not killed on tab close (the mod has no `close()`); the remote `hc events` ends with pi.
- Presence and status probes are killed when they time out.
- The sidebar daemon is started in its own session; `stop` sends SIGTERM and it exits itself when its socket is lost.
- Gap: `worktree sweep` protects a tree only while a live session file uses it, so a `foreman_bg` run inside a removed tree is not protected.

### Open PRs

The `openPrs` field of `foreman radar --json` is the shared open-PRs feed and the only source of PR data for the mod. It is on
by default (`radar.openPrs.enabled: false` turns it off). It lists your open PRs (author), the open PRs with your review
requested (`mine`), and the open PRs of configured bot authors inside a configured scope. The mod draws one dot per PR: an
outer ring that animates while any job runs, and an inner fill that is amber while no job has finished, red once one has
failed, green when every job finished and passed, and dim when unknown. Hovering the dot shows a card (title, the first
~200 characters of the description, the jobs grouped failed, running and passed, capped, and a CONFLICTING mark when the PR has
a merge conflict); a click opens the PR. Runs of a [PR source](tools.md#sources) appear as `<source>/<name>` in the chip and the dots; a counting source that has not answered for the current commit shows `<source>/(no answer)` with a running ring. The cut to 20 names keeps GitHub's names first. A PR whose repository and head branch equal the `repo` and `branch` of a live session
is shown under that session; fork PRs match through `headRepo` (the head repository), so a fork PR gets a chip only on the session whose repo is the fork. An open PR whose number is in a live session's `pr_watch` `prs` (`pr_create` arms such a watch) also gets its chip there when its repo or head repo is the session's, whatever branch the session is on now, so a renamed or switched branch keeps the chip; a PR matching both ways shows one chip. A PR nobody owns or shows (for example one only tracked with `pr_follow`) is listed under **Open PRs**; merged and closed PRs drop.

Owner and overlay config only (a project cannot change the GitHub search):

```json
{ "radar": { "openPrs": { "enabled": true, "refreshSeconds": 120, "mine": true,
                         "authors": ["renovate[bot]"], "scope": ["example-org", "acme/widgets"] } } }
```

| Key | Default | Meaning |
|---|---|---|
| `radar.openPrs.enabled` | `true` | search GitHub through `gh` |
| `radar.openPrs.refreshSeconds` | `120` | minimum seconds between two searches (60..86400) |
| `radar.openPrs.mine` | `true` | list PRs you authored and PRs with your review requested |
| `radar.openPrs.authors` | `[]` | other authors, for example `renovate[bot]` (a GitHub App `<name>[bot]` is searched as `author:app/<name>`) |
| `radar.openPrs.scope` | `[]` | owners (`example-org`) or `owner/repo`; authors are searched only inside it, never unscoped |

A Pi session (not a child) or `foreman prs poll` refreshes `<agent dir>/pi-foreman/state/open-prs.json` in the background, at most once per
`refreshSeconds` across all sessions on the machine: one refresher per machine (an exclusive lock file with a stale timeout, then an atomic rename). One
`gh api graphql` search runs per query: `author:@me`, `review-requested:@me`, and one per author and scope entry. `foreman
radar --json` reads the file and never calls the network, so its 3 s polls cost nothing. It adds `openPrs` (`repo`, `number`,
`title`, `url` (https only), `state`, `author`, `headRefName`, `headRepo`, `baseRefName` (what a conflict is against), `bodyText` (the description with secret-shaped tokens redacted, cut to 500 characters), `mergeable` (`MERGEABLE`, `CONFLICTING` or `UNKNOWN`), `checks` as `{n, state, label}` with the states `fail`, `run`, `ok`, `none`, at most 20 check names) and
`openPrsAt`, the time of the last refresh in which a search succeeded (absent until a search succeeded; meanwhile the list shows only tracked PRs, without an age); the mod shows its age on the section header. When `gh` is missing, not
logged in or rate limited, the last file stays and carries `error` and `errorAt` (when only some queries fail, the others' PRs are kept and `error` counts the failed ones); radar and the sessions go on. Only `tools.prHost`
`auto` or `gh` is searched. Remote spaces: the radar on that machine reads its own file.

**Tracked PRs and the PR tracker.** `pr_follow {repo, number, host?}` (a host of `tools.prGithubHosts`, default the first entry), `pr_create` and `pr_watch` add a PR to the tracked list; no tool removes one. `foreman prs poll [--json]` is the tracker: herdr-app runs it per machine, 30 s after its previous run ended (run it by hand or from a scheduler without herdr-app; without a tracker, `pr_watch` watches stay armed and say `no PR tracker running`). One run polls up to 50 tracked PRs with `pr_batch` through `gh` and then calls the search refresh (`refreshOpenPrs`, the same throttle), so a Pi session is not needed. A merged or closed PR is written to the state file and dropped from the list; the ended entry stays 15 minutes so every session sees the ending. Gone and failed PRs stay with an `error`. Four files under `<agent dir>/pi-foreman/state/`:

| File | Writer |
|---|---|
| `open-prs.json` | `refreshOpenPrs` (a Pi session or `foreman prs poll`), under `open-prs.json.lock` |
| `tracked-prs.json` `{v:1, prs:[{repo, number, addedAt, host?}]}` (at most 200 lines; `host` is absent for `github.com`) | Pi adds, the poll drops, each under `tracked-prs.json.lock` |
| `tracked-prs-state.json` (snap, meta, `okAt`, `error`, `endedAt` per PR; `trackedAt`; `off`) | the poll only |
| `tracked-prs-comments.json` | the poll only |

`foreman radar --json` merges the tracked PRs into `openPrs`, sorted by repo (case-insensitive) and number, independent of session nodes: every search entry is listed; a tracked entry with a search twin replaces it while it is display-fresh (`okAt` within 15 minutes) and keeps the twin's `author` and `bodyText`; a tracked entry without a twin is listed whatever its age and carries `tracked: true`. A tracked-only entry never makes its repository "covered" in the mod, so it cannot drop a session chip the search alone would have kept. `openPrsAt` stays the search's success time. Merged and closed (ended) PRs are not listed; neither are tracked PRs while the state file's `off` is true (they show again once the feed is back on). The mod itself only runs the CLI and the radar; it never writes.

When the list is full (200), `pr_follow` says so; remove a stuck or unwanted line by editing `tracked-prs.json` by hand, and the next poll prunes its state. `radar.openPrs.enabled: false`, or a `tools.prHost` other than `auto`/`gh`, switches tracking and `pr_follow` off too (the state file gets `off: true`).

`tools.prGithubHosts` (user or overlay config, set by `foreman setup`; no built-in default) names the GitHub hosts the tracker and the search cover, for example `github.com` and a GitHub Enterprise host. The poll makes one `pr_batch` per host; the search runs its queries (at most 20 in all, shared round-robin) for each listed host, `github.com` with the unchanged command and another host with `--hostname <host>`, and `open-prs.json` entries of another host carry `host`. A host whose search fails keeps its previous entries and does not hide the others. Unset, the poll and the search make no `gh` call and record the one error `no GitHub hosts configured: run \`foreman setup\` (tools.prGithubHosts)`; an invalid list records an error naming the key. A tracked line whose host has left the list is skipped by the poll and pruned. `foreman radar --json` joins a tracked PR to its search twin by host, repository and number, so the same `owner/name#N` on two hosts stays two entries.

**Renovate.** The Renovate GitHub App opens PRs as `renovate[bot]`: list it under `authors` with the owners or repositories in
`scope`. A self-hosted Renovate that uses a personal token opens them as that user, which `mine` already covers.

### Retirement inventory

Nothing is removed this round: the TUI path keeps working. This is what herdr-app makes redundant and when each piece can go.

| Piece | Files | Under herdr-app | Removable now | Later, precondition |
|---|---|---|---|---|
| Sidebar plugin + token daemon | `integrations/herdr/pi-foreman-sidebar/`, `sidebarlive.ts` | replaced by the mod | no | TUI support dropped |
| `fm_*` tokens | `sidebarlive.ts`, `sidebar.py` | not used (no token API) | no | same |
| `herdr:blocked` shim | `herdr.ts` | not needed (Pi's own state report is native) | no | TUI integration ≥ 10 as floor |
| Group tag | `herdrmeta.ts`, `report_group_tag` | not needed (native `parent`) | no | TUI support dropped |
| Braille activity frame | `sidebarlive.ts` `syncSpin`, radar | not needed (native spinner) | no | TUI support dropped |
| Presence + radar | `livestate.ts`, `foreman_radar.py` | still the single source | never | n/a |
| Radar prune via `herdr pane list` | `foreman_radar.py` `provably_closed` | never answers, so done files are not pruned (as in plain terminals today) | no | `hc ls --json` as a second witness |
| Pane joins (`paneId`, `pane.agent_detected`) | `sidebar.py`, `livestate.ts` | replaced by `hcTerminal` | no | TUI support dropped |
| `herdr pane open` backend | `foreman_session.py` `open_in_herdr` | replaced by `hc run` | no | TUI support dropped |
| Remote sessions | `remotesession.ts`, `cmd_open_remote` | replaced by `hc exec --on` and a local `hc run` on the remote | no | done |

## Plan panel

**Experimental.** Two more herdr-app mods show what a session wants you to read, rendered, next to the Files and Changes panels:
`integrations/herdr-app/pi-foreman-plan/` (the panel) and the Agents mod's "📄 Plan" header button that opens it. The panel shows the plan of the foreman that owns the tab, rendered natively (headings, tables, code, task lists, links)
with the blocks added or changed since the last ruling tinted and labelled NEW or CHANGED, a Diff view with the exact +/- lines, and one
tab per child session that published a plan or a note. It only reads; approval stays in the Pi session. It needs the `pi-foreman` Agents mod
(above): that mod publishes the radar the panel joins on, and it adds the "📄 plan vN · age" row under a session that has a plan, whose
click opens the panel on it, even when the panel is closed: the click also leaves the request in `pi-foreman.show-pending`, which the
panel reads when it mounts, applies once and clears. The panel follows a click in the next render. A plan already read shows at once; a plan
not read yet keeps the previous body, the tab labels and the header on screen until it is parsed ("Loading plan…" only when nothing is shown
yet), so a switch does not blank or reflow the panel. A child with a plan and a note has a Plan | Note switch on its tab (Plan by default; Note when it has only a note). A child tab that is not on screen shows a ● on its label while its plan or note version is above the one last rendered there; showing the tab clears it, and on the Plan | Note switch the button of a part with unseen content carries its own ● until that part is shown. A sidebar pin of kind plan or note on a child selects that part when the child has it. The header says Loading while the body still shows another tab or part. The other tabs' plans are read in the background after the first paint. A document with
code fences is painted as plain markdown first and the editors and diagrams follow. Parsed documents are cached per copy by path and content hash. Clicked rows, chips and buttons in the Agents mod show a pending state (a lit row, a trailing …)
in the same render. Install the panel together with the Agents mod; the two are one install.

Install:

1. Copy `integrations/herdr-app/pi-foreman-plan/` to `~/.config/herdr-app/mods/`, next to `pi-foreman/`; copy `pi-foreman/` again, the Agents
   mod gained the plan rows and the header button.
2. In your cloned layout (`~/.config/herdr-app/layouts/foreman.json`) add the panel to the `panel-body` stack, next to `files` and `changes`:

   ```json
   { "id": "plan", "type": "block", "content": { "mod": "pi-foreman-plan" } }
   ```

3. The "📄 Plan" button in the Agents header brings the panel forward on its Plan child; the plan and note rows under a session do the same
   and pin it to that document. (A floating button over the panel's tab strip covered the Changes tab in the live check, and the shipped
   `tabs` mod has no slot for a third panel button, so the button lives in the Agents header.)
4. `herdr-app check ~/.config/herdr-app/mods/pi-foreman-plan`, then switch to the layout.

**Anchor.** The panel belongs to the tab it sits in: it shows the foreman of the agent terminal that owns the tab's pane, joined to its radar
session like the Agents mod does, not the terminal that has keyboard focus. A floating or peek child window (a child session opened with
`hc run` has no tab labels and shows over the parent's tab) never switches the panel away; focusing it at most selects that child's tab
inside the panel. Child plans are tabs joined by the radar `parent` field, not by herdr tab membership. With two agent panes in one tab the
focused pane's agent is the anchor. A click on a plan or note row in the sidebar pins the panel to that session and document until the tab's
foreman changes; a pin already stored when the panel copy starts (herdr persists shared values) is stale and ignored.

**Data.** The panel reads `shared("pi-foreman.radar")` (published by the Agents mod after each radar poll, only when the sessions changed;
herdr-app persists shared values in `shared.json`), and for the session on screen the two files `plan.json` and `note.json` in the `show.dir`
that radar carries from the session's presence file, then the plan the JSON names and its two snapshots `plan.ruled.md` and `plan.prev.md`.
Every 5 s it re-reads only the two JSON files and re-reads the documents only when those bytes changed or the watch on the plan's folder
fired (`watchFolder`, local only; remote spaces poll). It writes nothing. Marks compare the plan with `plan.ruled.md` while it was edited after
the last ruling, otherwise with `plan.prev.md`; only the body above the first appendix heading (`## Ruling`, `## Addendum`, `## Decision log`) is
compared, and without a snapshot, or when the snapshot belongs to another plan path, there are no marks and no badge. The markdown is
sanitised before it renders: `![` is escaped everywhere, code spans and fences included (no images load), HTML tags go except `del`, `br`, `sub`, `sup`, `kbd` (`<mark>` renders as bold), and a link opens
only when it is `https://`, through the platform opener (never a shell).

### Notes

The foreman can put a document in front of you with the `foreman_show({title, markdown})` tool: a design, a comparison, a report. It is for
things you should read rendered, not for status or questions, and it takes the text itself, never a path. Each call replaces the previous
note (title up to 120 characters, text up to 256 KiB, larger input is refused with the limit named). The harness writes `note.md`, `note.json`
(`v`, `title`, `at`, `hash`, `prevHash`, `fences`, `diagrams`) and, only while the title stays the same, the previous text as `note.prev.md`; the
panel shows it on a Note tab and bumps the `note` row's version. A new title drops the previous version, so there is nothing to compare.

**Contract for the mod.** `note.json` is written last, atomically, and its `v` rises by one with every call (it continues across a reload of the
session), with `at` the ISO time of the write. A mod that sees a `v` or `at` it has not shown yet has a new note and can switch to the Note tab
by itself. Code fence info strings (`ts`, `python title=x`, ...) are kept exactly as written in `note.md`; the mod highlights by language. The
harness cannot see the Herdr layout, only the pane (`HERDR_PANE_ID` or `HC_TERMINAL_ID`): the `foreman_show` result says so when no pane is
detected, and otherwise only that the note shows if the layout has a `pi-foreman-plan` block.

**Diagrams.** A fence whose first info word is `mermaid` (opening fence at column 0, closing fence of the same character and at least the same length)
is rendered by the harness after the document is published, never on the tool-result path: a `worker_threads` worker with a 2 s limit per
fence, in the dark and the light theme, into `show/<session>/diagrams/<sha256 of the fence text>-dark.svg` and `-light.svg`. `plan.json` and
`note.json` list the finished ones under `diagrams` (`{sha, dark, light}`, paths relative to the show dir) and their shas under `fences`; the mod
swaps a fence for its SVG only when its own hash of the fence text is in that list. Limits: 16 KiB per fence, 200 nodes plus edges, 32 fences per
document, 512 KiB per SVG. The SVG is flattened (no `<style>`, no remote font, literal colours) and checked against an element allow-list; anything
refused, over a limit, timed out, or rendered without the optional `beautiful-mermaid` package stays a code block. The package is an optional
dependency; a missing one is traced once per session (`show_diagram`, `module_missing`).

Limits: a plan written through the shell is not observed; remote child sessions have no live file on this computer, so a parent shows no tab
for them; marks stop above 4000 lines per side or 1500 changed lines (the header says so); sidecars of older versions stay in the session's show
dir until the session's live file is gone and the dir is pruned; the mod copies each checked SVG to
`mods/pi-foreman-plan/cache/<sha>-<theme>.svg` in the app home (the host reads images only from there) and, with no delete API, never prunes it.

**What the mod does.** A new note (radar `show.note` above the last seen value; a first sight only records it) selects the panel block and shows
its hidden panel, then switches to the Note tab; a child's note opens the panel on that child's tab, on its Note part. Block and panel ids come from the shown layout, with the `foreman.json` ids as fallback. If the
layout has no `pi-foreman-plan` block, this mod cannot run, so the Agents mod (`pi-foreman`, present in every layout) posts one notification per note version saying to add it (layout checked by name, cached). Fences render in a read-only highlighted editor; a listed mermaid fence
shows its SVG after the mod's own allow-list check, else a `mermaid` code block.

Tests: `node --test "integrations/herdr-app/pi-foreman-plan/*.test.mjs"`.

## Known limits

- The herdr-app mod's PR row ids are host-blind: two PRs with the same `owner/name#N` on two GitHub hosts get the same row id in the mod and can collide there. The feed and the tracker keep them apart; the mod's ids are to follow.
- Subagent runs inside a Pi session are text on that session's row, not rows: Herdr has rows only for real panes.
  Nested sessions opened in their own panes (`foreman session open`) are rows of their own, indented under the parent.
- Row templates are static config: the plugin cannot add or remove rows; empty tokens leave their cells empty.
- Herdr does not restore tokens or the Agents view after a server restart: a daemon that kept running republishes the
  tokens within 5 s and the view within 60 s; after a full restart the startup hook starts a new daemon.

## Wishes for Herdr

- a parent/child relation on panes, so nesting does not need a sort key;
- virtual rows, so subagent runs could be rows;
- row templates chosen per pane at runtime.
