# AGENTS.md

Instructions for coding agents working on this repository.

## What this is

`pi-foreman` is a generic orchestration harness for the pi coding agent: Pi extensions,
agent roles, skills, a Python core (requirements ledger, guards) and an installer.
Status: early, design phase.

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

## Planned layout (not yet present)

`extensions/` Pi extensions (TypeScript) · `agents/` role definitions · `core/` vendored
Python core · `design/` architecture docs · `tests/` · `setup.mjs` installer.
