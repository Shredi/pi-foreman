# AGENTS.md

Instructions for coding agents working on this repository.

## What this is

`pi-foreman` is a generic orchestration harness for the pi coding agent: Pi extensions,
agent roles, skills, a Python core (requirements ledger, guards) and an installer.

Three layers:
1. This generic harness (public).
2. A user's private overlay: model map, extra agents, repository list.
3. An organisation-owned overlay: provider gateways, internal tools and skills.

Overlays live outside this repo and only consume released versions of it. Flow is one-way:
overlays never patch the harness, and nothing from an overlay is ever copied back here.

## Constraints

- Must run on Linux, macOS and Windows.
- Python (standard library only, 3.9+) for all scripts. TypeScript only for Pi extensions.
- Pi's file formats are the single source: `AGENTS.md`, skills under `.agents/skills/`,
  role definitions in the package's `agents/` folder. `.claude/agents/` exists only for the
  Claude Code sessions that build this repo. Checked 2026-10-03 (Claude Code 2.1.288): Claude
  Code does not load skills from `.agents/skills/` (headless probe, skill not listed).
- Role ids are neutral: `explorer`, `builder`, `reviewer`, `senior-reviewer`, `finalizer`,
  `foreman`. Display names are a config preset, never hard-coded.
- Generic only. pi-foreman is a harness anyone can use. Nothing specific to the owner's own
  setup goes in here: no particular hosts, machines, operating-system quirks of one
  installation, remote-spawn paths to a named server, homelab tooling, private task suites or
  model-map details. Retro findings or feature ideas that only serve one person's environment
  belong in that person's overlay repo (a separate repo that pins a pi-foreman release and adds
  its own extensions, config and docs), never in this repo. When a change needs a hook for such
  an overlay, add the generic hook here and keep the specific use in the overlay. Before
  proposing or implementing anything, ask: would a stranger's installation need this? If not,
  it is overlay material.

## Public-repo rule

This repo is public. Never write anything private into files, commit messages or issues:
no employer or customer names, no internal hostnames or IP addresses, no paths under a
personal home directory, no names of private repositories, no personal contact details
beyond the commit author. Before committing, grep the tree case-insensitively for such
strings and fix any hit.

## Git and safety

- Stage explicit paths; never `git commit -a`.
- No secrets in the tree or history.
- Prefer recoverable deletes (trash) over `rm`.
- Probe destructive commands with `echo`, never with test inputs.

## Working notes

Notes and ledgers live in `.workflow/` (gitignored).

## Docs by area

Repo layout and test commands: `docs/development.md`. Read the page for the area you touch, on demand:

- `docs/install.md`: installer flags, what setup writes, config layers, updating Pi, Claude bridge login.
- `docs/roles.md`: roles, display-name presets, model ladder, rank policy, presets.
- `docs/ladder.md`: ladder rungs, live rung, context and failure climbs, `rung_top`, reviewer climb, traces.
- `docs/ceremony.md`: tiers, finish gates, planner and checkpoint, budgets, key table.
- `docs/safety.md`: shell-write and repository guards, PR gate, permissions and auto-review, known limits.
- `docs/permissions.md`: effect classes of child bash asks, chain composition, deterministic allow labels, traces.
- `docs/sessions.md`: `/sync`, `/retro`, `/foreman close`, footer, `bin/foreman`, intercom, Herdr.
- `docs/retro.md`: retro sources, friction classes, `Friction:` line and trace event, backlog store and CLI, lessons brief.
- `docs/herdr.md`: Herdr sidebar plugin `pi-foreman.sidebar`, rows snippet, tokens, Agents view, symbols.
- `docs/bench.md`: `foreman bench`, columns, price tiers.
- `docs/overlays.md`: private and organisation overlays, one-way flow, extension points.
- `docs/development.md`: layout, tests, replay rig, CI, Windows notes, keeping docs current.
