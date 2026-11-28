# pi-foreman mod for herdr-app

An Agents view for herdr-app with the foreman rows built in under each agent that is a pi-foreman session. It replaces the
shipped `agents` block in your cloned layout. Own code on the public mod API (`agents`, `terminals`, `focused`,
`setAgentOrder`, `run`, `theme`, `exec`, `setShared`, `readTextFile`); no shipped mod source is copied.

## What it shows

Agents are grouped by space (one heading per space id, groups in the order their first agent appears in `agents()`, agents in that order inside a group; the unchanged `agents()` order goes to `setAgentOrder`). Under an agent that joins
a top-most foreman session, one tree:

- the agent row itself carries the session's tier, cost (the session plus every nested session, `$x.xx`, as the TUI sidebar prints it) and "N sessions" when N > 1; a joined radar node is merged into this row, there is no second session row; the open ask (red while the session is blocked), else the background task or the waits, sits on a line under it;
- the PRs of the session as a list below its row: one line per PR whose head branch (and head repository, for a fork) is the session's branch and repo, or a PR the session watches (`pr_watch`, armed by `pr_create`) in the session's repo whatever its branch now is; a line is the state badge (the number, never wrapped), a red "!" only when it conflicts, then the title right after, cut with … at the sidebar edge (no column: titles start right after their own badge), failing first, then pending, then green, newest first; whatever the number of PRs, no chip sits on the session's title row and there is no summary line; a click anywhere on the session row opens the session; a PR counts once however many sessions show it, by its URL, else repo and number; a PR nobody owns lands in Open PRs; a merged or closed PR is neither listed nor counted;
- the session's own agents (builder, reviewer, explorer …; radar runs and the running `pi-subagents` records of `hc get`) and its child sessions (nested foreman sessions, live `hc` children; a pane-less child (`hc run` session) whose `hcTerminal` matches is a full session with its own agents, joined by that address alone while the node is live; a node joins on `hcTerminal` first, else on the terminal's foreground pid, skipping done, ended and remote nodes and terminals already matched) are siblings, most urgent first. The root row is uncarded (a selected root keeps its filled header row). Every other session is a bordered card holding its header row (name without pi logo or leading "π", tier, own cost, status glyph on the right), its status lines `⏳ note · age` (wait) and `⚙ name · age` (bg) and its own agent rows; its child session cards follow outside it. A selected card gets the raised background and an accent border. An agent row shows 🤖 and the role, muted and a little smaller; inside a card it has no status circle (the header shows the state), directly under the root it keeps the glyph. A click on a live `hc` child runs `terminal.peek`;
- connectors join the rows: a tee for a middle child, a rounded elbow for the last, a pass cell for an ancestor that continues; 1px lines in the translucent dim tone, continuous from under the parent's chevron through its status and PR rows to the last child. Every parent row, the agent row included, has a chevron that folds it; a folded row shows the most urgent status below it.

A "?" (an outlined round button) in the Agents title bar, next to Plan, lists on hover every PR badge with its words (always visible). A PR line is a badge, the number in the state's colour (a tinted box with coloured text and border; `PR #n` on a session row, `#n` in Open PRs; it never shrinks), then (one small gap) the title in normal brightness; the badge pulses while any job runs or the checks are not settled (also after a check failed: a red badge pulses until all finished) and is amber while any check runs or is not settled (also when some have passed), red once one failed, green (a plain badge, "CI passing") only when all finished and passed, dim (grey) when unknown; a ready-to-merge PR shows a check mark instead (below). With the host's head and merge state in the feed (a tracked PR) the badge shows the PR's state: violet while it is work in progress (a draft on the host, or the session's review fact for the host's head is `wip`; it pulses while its checks run; a draft with a failed check is red); amber and pulsing while checks run or are not settled; amber and still when the checks passed but the merge state is blocked or behind (the tooltip says "CI passing, merge blocked" or "CI passing, branch behind"); an outlined amber badge, still, when the checks passed, the tracker names required checks still to come (`waiting`) and the merge is not behind (blocked, or not known to be mergeable; the tooltip says "checks passed, waiting on required checks"); red when a check failed (it pulses while a job still runs; the tooltip says "CI failing, still running"); blue when the checks are green but the head is not reviewed (the session's fact says `unreviewed` or is about another head than the host's, so a stale fact never shows ready on a newer head, or the session's watch reports the head past its last reviewer PASS; the words "unreviewed head" are in the tooltip and the hover card, not on the line); a green check mark (bold ✓ in the badge, never pulsing) once it is ready to merge (checks settled green, or no checks confirmed for a PR the session opened, which also waits for checks that recent merged pull requests ran and the host has not yet reported: the badge stays amber, or grey when the pull request has no check at all, until they have (also after the 10 minutes in which the watch sends its missing-check line), and it never turns green before; mergeable; merge state not blocked, behind, dirty or unknown; the session's fact is `ok` on the host's head). A still green badge is only "CI passing": checks passed, nothing more known (an older feed, or a PR not known to be mergeable); with waiting required checks the outlined badge replaces it. The session's fact (`review` on the `pr_watch` wait of the live file) exists only for PRs the session opened with its PR tool; any other PR (the owner's own, a followed one, one in another repository, a session that ended) is judged on host facts alone: draft, running, red, or green and mergeable shown as ready to merge with no review claim. An older live file without `review`, or an older feed without head and merge state, shows the badge as before. Resting on a PR line shows a tooltip with the state in words ("#16 · CI failing", "#16 · CI failing, still running", "CI running", "CI passing", "no CI checks", "work in progress", "CI passing, merge blocked", "CI passing, branch behind", "CI passing, not reviewed", "checks passed, waiting on required checks", "ready to merge": what the badge's colours mean) and, after 0.3 s, a hover card that never covers the line (below it; above it near the bottom of the window; beside it when neither fits), so the line stays clickable: the title, the state again, a short excerpt of the description, "conflicts with <base>" (or "conflicts with its base branch"), and the jobs grouped failed / running / waiting (the required checks the tracker names, in the outlined state only) / passed (at most 5 each, then "+N more"). A click opens the PR only (it does not also focus the agent's pane); a line with no known page shows a notice instead. Known limit: the mod sees only the Herdr window's size, not the screen's (the mod API has no display size), so with the window dragged partly below the screen edge the card can open below the line off screen. The data (title, description, mergeable flag, base, per-job names and states) comes from the `openPrs` field of radar, which reads `gh`; a session's PR takes it from its twin there.

Status legend of a session's glyph (the hc status of its terminal first, then radar; most urgent first): **Needs you** pill
(ask, or hc blocked) > spinner (working, or own agents still run, also after the turn ended; each agent has its own row; also the running `pi-subagents` child records of `hc get <terminal> --json`, for a terminal with no radar node too, radar's runs not counted twice; a blocked record shows as **Needs you**) > filled dot (hc done: finished turn not yet seen, no agents running) > small square (background task; `⚙ <name> · <age>`) > hollow muted ring (waiting on something external;
`⏳ <note> · <age>`) > hollow dot (idle). Ended sessions are not drawn under an agent. Each running async agent that radar does not already show (radar runs keep their own agent row) is an agent row of its own (`title · msg` from the hc record; at most 4, then `+N more`). Without a joined terminal the radar state decides.

A click on an agent row focuses its pane. The footer reads "N agents · k need you". An **Open PRs** section at the bottom lists
PRs no agent works on, one foldable group per repo: the `openPrs` field of radar when the installed pi-foreman provides it, else only
the tracked PRs of sessions that have ended or joined no agent. It is hidden when empty. A group's heading shows the repository and `N PRs` with ` · k failing` and ` · c conflicts` when there are some; a click on it folds or opens the group. Under it every PR is one line: its badge (the number in the state's colour), the conflict mark when it conflicts, then the title right after. Groups with a failing check or a conflict come first and show at most 8 PR lines, conflicts and failures first, then one "+N more" line that opens the rest of the group (until it is folded again); the other groups fold when they hold more than 15 PRs, and a group opened by hand shows all its PRs (a fold or open by hand lasts while Herdr is open). A folded group builds no PR lines. A PR's hover card is built when the pointer rests on its line, not for every line on every render. A group that fails to build falls back to the repository name and `N PRs`. There is no cap on groups and no scroll box of its own: the Agents list scrolls. With `radar.openPrs.enabled` (user or
overlay config, on by default) radar also lists your open PRs, those with your review requested and those of configured bot
authors inside a configured scope; the header shows the age of that list ("updated 12m ago", whole minutes, "<1m" under one), and a PR that an agent row
already shows is not repeated. See `docs/herdr.md#open-prs`.

**Status strip.** Above the session list a strip shows how busy the computer is: the load guard's dot in the head line (with its reason words when amber or red; green up to the guard's limit, amber past it, red past twice; "Status" when the dot is off), then one row each for CPU (a sparkline), memory (a bar and "26 / 32 GB"), every disk ("Disk", "Disk C:", "Disk /" or the last folder; "124 GB free") and every usage limit ("Claude week", "Fable week"). All rows share the columns name, bar, percent and one extra text; the bars are pixel boxes, not text cells, with a `│` marker at the expected pace on usage rows; the reset reads "Thu 21:00" within 7 days, else "1 Dec"; a dash for a source that failed or a disk that was not found; a full red bar past 100 %. Colours are traffic lights: a calm value (cpu, memory, disk, level `ok`, a usage row with a value) is green, amber and red as the guard says; dash rows, a missing disk, the stale line and the labels stay grey. A click on its header folds it to one line, `● ok  CPU 42%  Mem 71%  Disk 78%`. With no session measuring it reads "● no session measuring"; an older foreman, or `sidebar.strip.enabled: false`, draws no strip. It shows the local computer only (a remote machine's `strip` is ignored). The data is the `strip` field of `foreman radar --json`; which parts show, the disks and the usage rows are configured in foreman's `sidebar.strip` (see `docs/herdr.md#status-strip`), not in a prop.

## Install

1. Copy this folder to `~/.config/herdr-app/mods/pi-foreman/`.
2. `herdr-app do layout.clone '{"name":"main","as":"foreman"}'`
3. In `~/.config/herdr-app/layouts/foreman.json` change the sidebar list block's `"mod": "agents"` to `"mod": "pi-foreman"` and
   add `"props": { "foreman": "<absolute path to foreman>" }` (optional when `foreman` is on the PATH of your environment).
4. `herdr-app check ~/.config/herdr-app/mods/pi-foreman`, then switch to the layout.

The copy is the first install only. To update it, run `foreman setup --mods` in a terminal (`--dry-run` lists the changes first): it copies
the files that differ from the package into each installed mod, never the test files or the app's `cache/`, then prints the next step
(save reloads a mod, or restart the app; then `herdr-app check` the folder). `/foreman doctor` warns when the installed copy differs, and
`foreman setup` offers the refresh. A session cannot write user config, so run it in a terminal (or have the foreman propose it as an owner script).

## Props

`hc`: the binary that runs `get <terminal> --json`, same forms as `foreman`; a missing entry means plain `hc`.

`foreman`: the binary that runs `radar --json`. A string is used for this computer; an object is keyed by machine name, with the
key `local` for this computer (`{ "local": "/abs/path/foreman", "alpha": "/other/path/foreman" }`). A missing entry means plain
`foreman`, resolved the way `exec` resolves it (your real environment; through hc on that machine, the remote one).

## Data

`foreman radar --json` and, for each agent terminal, `hc get <terminal> --json` (child records of `pi-subagents`; argv only, a failure
is ignored), every 3 s for this computer and every 15 s per remote space (`exec` with `on` set to the space's machine). A poll
that has not come back after 45 s is dropped and started again, and a radar `exec` is given up after 35 s. A failed or garbled
read keeps the last good data for up to 5 polls; if a machine then still has no `foreman`, exits non-zero or prints bad JSON, the space shows one dim line "No foreman radar on
<machine> (set props.foreman)" and the mod retries every 30 s. The mod runs `foreman radar --json`, `foreman prs poll --json`, `hc get` and the opener; it never writes a file, and `foreman prs poll` fetches.

`foreman prs poll --json` (the PR tracker) runs per machine 30 s after its previous run ended and is given up after 20 min. It polls the
tracked PRs and the PR search and writes the files the radar reads, so the PR lines and badges follow GitHub even when no Pi session runs;
a PR leaves the list only when GitHub reports it merged or closed. `pr_watch` gets its news only from this tracker: without it
(herdr-app, or `foreman prs poll` run by hand or a scheduler) watches stay armed and say so. Tracked PRs show in the Open PRs list
without an age label until a PR search succeeded.

A radar node joins an agent when its `hcTerminal` equals the agent's terminal address (`machine/` prefix for a remote space),
the node is not done, and: a live node (not lost, stale or ended) joins by the address alone. A lost or stale node also needs the pids to match
when both sides carry one, which guards that join against an address reused after a core restart. The agent's pid is the terminal's
foreground pid from herdr `terminals()`; after `pane-resume` it is the launch shell's, not pi's, so a live node's pid is not compared (D100).
A pane-less child terminal joins the same way.
An agent with no `hcTerminal` match joins the live local node whose pid equals the terminal's foreground pid; done, ended and
remote nodes and nodes already matched are skipped.

## PR links

The only other thing the mod runs is the platform opener (`open` on macOS, `xdg-open` on Linux, `rundll32 url.dll,FileProtocolHandler`
on Windows, never through `cmd` or a shell), on a PR line click, and only for an `https://` URL made of URL characters: no
whitespace, no `& | ^ < > " '`, no control characters. The URL is taken from radar: a `url` on the PR, else `<repository
URL>/pull/<number>` from an `https://` `repoUrl`/`repo` that radar provides. The mod never derives a URL from a git remote. An opener that exits non-zero or cannot run raises an error notice "Could not open the link" with the exit code and the first error line.
A PR line opens the PR page when the installed pi-foreman reports PR URLs (the `url` of a PR dot in `foreman radar --json`); with an older pi-foreman that gives neither, lines stay plain.

## Plan panel feed

After each radar poll the mod publishes the parsed sessions with `setShared("pi-foreman.radar", …)` (only when their content changed;
herdr-app keeps shared values in `shared.json`) for the sibling mod `pi-foreman-plan`. A session whose radar node carries `show`
gets a "📄 plan vN · age" and a "📝 note · age" row; the version and age come from `plan.json` / `note.json` in `show.dir`, read
with `readTextFile` (every 30 s or when the version hint moves). A click on a row pins the panel to that session's tab and brings it forward
(`layout.select` on the `panel-body` stack, then `layout.show`). When a session's note version rises and the shown layout (read
with `layout()`, cached by `shared("layout")` name) has no `pi-foreman-plan` block, the mod posts one notification per version
saying how to add it. Install the two mods together. See `docs/herdr.md#plan-panel`.

## Limits

- Tier comes from a node's `tier` (else `rung`) field; radar leaves it empty for sessions today, so the tier is blank until it does.
- A nested session that is itself an agent row is shown there and left out of its parent's tree.
- The mod is the only PR and run display: Pi itself shows no PR or run widget and no PR or run part in its footer.
- Needs `foreman` on the PATH of the machine's environment, or the `foreman` prop.
