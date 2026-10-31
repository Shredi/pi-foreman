# pi-foreman mod for herdr-app

An Agents view for herdr-app with the foreman rows built in under each agent that is a pi-foreman session. It replaces the
shipped `agents` block in your cloned layout. Own code on the public mod API (`agents`, `terminals`, `focused`,
`setAgentOrder`, `run`, `theme`, `exec`); no shipped mod source is copied.

## What it shows

Agents are grouped by space, in the order `agents()` gives (the same order goes to `setAgentOrder`). Under an agent that joins
a top-most foreman session:

- line 1: label · tier · cost of the session plus every nested session (`$x.xx`, as the TUI sidebar prints it), and "N sessions" when N > 1;
- line 2: the open ask (red while the session is blocked), else the waits;
- a PR line: one chip per PR (number and its check dots), failing first, then pending, then green, newest first; a red
  border marks a failing check; the chips wrap, followed by "N PRs · k failing · m pending" or "N PRs · all green";
- nested foreman sessions (any depth) as tree rows: label, own cost, up to two PR chips inline, status glyph; more than two PRs
  go on a wrapping line under the row;
- workers (builder, reviewer, explorer …) as one tree row "role model", with a spinner while they run;
- live `hc` children of the agent keep their tree rows below (click: `terminal.peek`).

Status legend of a session's glyph (the hc status of its terminal first, then radar; most urgent first): **Needs you** pill
(ask, or hc blocked) > spinner (working) > filled dot (hc done: finished turn not yet seen) > hollow spinner (child agents run;
line `N agents: roles`; also the running `pi-subagents` child records of `hc get <terminal> --json`, for a terminal with no radar node too, radar's runs not counted twice; a blocked record shows as **Needs you**) > small square (background task; `bg: <name> <age>`) > hollow muted ring (waiting on something external;
`wait: <note> <age>`) > hollow dot (idle). Ended sessions are not drawn under an agent. Each running async agent that radar does not already show as a row (radar runs keep their worker row) has its own indented line below its session or agent row (small spinner, red when blocked; `title · msg` from the hc record, radar fallback `role · age`; at most 4, then `+N more`). Without a joined terminal the radar state decides.

A click on an agent row focuses its pane. The footer reads "N agents · k need you". An **Open PRs** section at the bottom lists
PRs no agent works on, one chip row per repo: the `openPrs` field of radar when the installed pi-foreman provides it, else only
the tracked PRs of sessions that have ended or joined no agent. It is hidden when empty. With `radar.openPrs.enabled` (user or
overlay config, off by default) radar also lists your open PRs, those with your review requested and those of configured bot
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
is ignored), every 3 s for this computer and every 15 s per remote space (`exec` with `on` set to the space's machine). If a machine has no `foreman`, exits non-zero or prints bad JSON, the space shows one dim line "No foreman radar on
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
- Needs `foreman` on the PATH of the machine's environment, or the `foreman` prop.
