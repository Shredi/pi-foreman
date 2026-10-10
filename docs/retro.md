# Retro backlog

> Placeholder: the docs wave expands this page.
> Retro findings survive sessions in a local backlog and age out.
> `foreman backlog` lists, marks, moves and briefs them.

## Config keys

- `retro.enabled`: run retro and record findings; null means auto (on in tui/rpc, off in json/print).
- `retro.workspaceKey`: backlog key of the workspace; null means `<basename>-<hash>`; `/` makes subdirectories.
- `retro.backlogDir`: central backlog directory; null means `<agentDir>/pi-foreman/state/retro/backlog`.
- `retro.repoBacklog`: `[{path, commit}]` workspaces whose backlog lives in `<workspace>/.workflow/retro-backlog.md`.
- `retro.expireDays`: days without a sighting before an open or planned entry expires (14).
- `retro.askThreshold`: permission asks in one run that make a finding (2).

## Commands

`foreman backlog list|show|expire|mark|move|brief`.
