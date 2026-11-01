# pi-foreman mod for herdr-app

An Agents view for herdr-app with the foreman rows built in under each agent that is a pi-foreman session. It replaces the
shipped `agents` block in your cloned layout. Own code on the public mod API (`agents`, `terminals`, `focused`,
`setAgentOrder`, `run`, `theme`, `exec`); no shipped mod source is copied.

## What it shows

Agents are grouped by space, in the order `agents()` gives (the same order goes to `setAgentOrder`). Under an agent that joins
a top-most foreman session, one tree:

- the agent row itself carries the session's tier, cost (the session plus every nested session, `$x.xx`, as the TUI sidebar prints it) and "N sessions" when N > 1; a joined radar node is merged into this row, there is no second session row; the open ask (red while the session is blocked), else the background task or the waits, sits on a line under it;
- the PR chips of the session: one per PR (number, a red "!" when it conflicts, and its two-part dot), failing first, then pending, then green, newest first, wrapping, followed by "N PRs · k failing · m pending" or "N PRs · all green";
- the session's own agents (builder, reviewer, explorer …; radar runs and the running `pi-subagents` records of `hc get`) and its child sessions (nested foreman sessions, live `hc` children; a pane-less child (`hc run` session) whose `hcTerminal` matches is a full session with its own agents) are siblings, most urgent first. A session row has the name (no pi logo, no leading "π"), tier, own cost, up to two PR chips inline (more go on a line under it) and the status glyph on the right; an agent row has a small agent icon and the role, muted and a little smaller, and the glyph on the right. A click on a live `hc` child runs `terminal.peek`;
- connectors join the rows: a tee for a middle child, a rounded elbow for the last, a pass cell for an ancestor that continues; 1px lines in the translucent dim tone. Every parent row, the agent row included, has a chevron that folds it; a folded row shows the most urgent status below it.

A PR chip is a pill `⎇ #n` with one dot: the outer ring turns while any job runs; the inner fill is amber while no job has finished, red once one failed, green when every finished job passed, dim when unknown. Resting on a chip opens a hover card: the title, a short excerpt of the description, "conflicts with <base>" (or "conflicts with its base branch"), and the jobs grouped failed / running / passed (at most 5 each, then "+N more"). A click opens the PR. The data (title, description, mergeable flag, base, per-job names and states) comes from the `openPrs` field of radar, which reads `gh`; a session's PR takes it from its twin there.

Status legend of a session's glyph (the hc status of its terminal first, then radar; most urgent first): **Needs you** pill
(ask, or hc blocked) > spinner (working) > hollow spinner (own agents still run, also after the turn ended; each agent has its own row; also the running `pi-subagents` child records of `hc get <terminal> --json`, for a terminal with no radar node too, radar's runs not counted twice; a blocked record shows as **Needs you**) > filled dot (hc done: finished turn not yet seen, no agents running) > small square (background task; `bg: <name> <age>`) > hollow muted ring (waiting on something external;
`wait: <note> <age>`) > hollow dot (idle). Ended sessions are not drawn under an agent. Each running async agent that radar does not already show (radar runs keep their own agent row) is an agent row of its own (`title · msg` from the hc record; at most 4, then `+N more`). Without a joined terminal the radar state decides.

A click on an agent row focuses its pane. The footer reads "N agents · k need you". An **Open PRs** section at the bottom lists
PRs no agent works on, one chip row per repo: the `openPrs` field of radar when the installed pi-foreman provides it, else only
the tracked PRs of sessions that have ended or joined no agent. It is hidden when empty. With `radar.openPrs.enabled` (user or
overlay config, on by default) radar also lists your open PRs, those with your review requested and those of configured bot
authors inside a configured scope; the header shows the age of that list ("updated 12m ago"), and a PR that an agent row
already shows is not repeated. See `docs/herdr.md#open-prs`.

## Install

1. Copy this folder to `~/.config/herdr-app/mods/pi-foreman/`.
2. `herdr-app do layout.clone '{"name":"main","as":"foreman"}'`
3. In `~/.config/herdr-app/layouts/foreman.json` change the sidebar list block's `"mod": "agents"` to `"mod": "pi-foreman"` and
   add `"props": { "foreman": "<absolute path to foreman>" }` (optional when `foreman` is on the PATH of your environment).
4. `herdr-app check ~/.config/herdr-app/mods/pi-foreman`, then switch to the layout.

## Props

`hc`: the binary that runs `get <terminal> --json`, same forms as `foreman`; a missing entry means plain `hc`.

`foreman`: the binary that runs `radar --json`. A string is used for this computer; an object is keyed by machine name, with the
key `local` for this computer (`{ "local": "/abs/path/foreman", "alpha": "/other/path/foreman" }`). A missing entry means plain
`foreman`, resolved the way `exec` resolves it (your real environment; over SSH, the remote one).

## Data

`foreman radar --json` and, for each agent terminal, `hc get <terminal> --json` (child records of `pi-subagents`; argv only, a failure
is ignored), every 3 s for this computer and every 15 s per remote space (`exec` with `on` set to the space's machine). A poll
that has not come back after 45 s is dropped and started again, and a radar `exec` is given up after 35 s. A failed or garbled
read keeps the last good data for up to 5 polls; if a machine then still has no `foreman`, exits non-zero or prints bad JSON, the space shows one dim line "No foreman radar on
<machine> (set props.foreman)" and the mod retries every 30 s. The mod calls only `hc get`, never writes a file and never fetches.

A radar node joins an agent when its `hcTerminal` equals the agent's terminal address (`machine/` prefix for a remote space),
the node is not done, and, when both sides carry a pid, the pids match. `hc ls --json` has no pid, so the not-done filter may
be the only guard against an address reused after a core restart.

## PR links

The only other thing the mod runs is the platform opener (`open` on macOS, `xdg-open` on Linux, `rundll32 url.dll,FileProtocolHandler`
on Windows, never through `cmd` or a shell), on a chip click, and only for an `https://` URL made of URL characters: no
whitespace, no `& | ^ < > " '`, no control characters. The URL is taken from radar: a `url` on the PR, else `<repository
URL>/pull/<number>` from an `https://` `repoUrl`/`repo` that radar provides. The mod never derives a URL from a git remote.
A chip opens the PR page when the installed pi-foreman reports PR URLs (the `url` of a PR dot in `foreman radar --json`); with an older pi-foreman that gives neither, chips stay plain.

## Limits

- Tier comes from a node's `tier` (else `rung`) field; radar leaves it empty for sessions today, so the tier is blank until it does.
- A nested session that is itself an agent row is shown there and left out of its parent's tree.
- The mod is the only PR and run display: Pi itself shows no PR or run widget and no PR or run part in its footer.
- Needs `foreman` on the PATH of the machine's environment, or the `foreman` prop.
