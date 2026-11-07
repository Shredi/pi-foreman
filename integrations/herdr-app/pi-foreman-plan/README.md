# pi-foreman-plan mod for herdr-app

A panel that renders the plan (and note) of the foreman that owns the tab, with NEW / CHANGED marks against the last ruling, a Diff
view, and one tab per child session that published a plan. Read-only; own code on the public mod API (`shared`, `readTextFile`,
`watchFolder`, `agents`, `panes`, `focused`, `exec`, `theme`, `window`).

It installs together with `pi-foreman/` (the Agents mod): that mod publishes the radar this panel reads and adds the sidebar rows that open it.

## Install

1. Copy this folder to `~/.config/herdr-app/mods/pi-foreman-plan/` and copy `../pi-foreman/` again.
2. Add the panel to the `panel-body` stack of your layout:
   `{ "id": "plan", "type": "block", "content": { "mod": "pi-foreman-plan" } }`
3. `herdr-app check ~/.config/herdr-app/mods/pi-foreman-plan`, then switch to the layout.

The Agents mod's header has a "📄 Plan" button that brings the panel forward.

## Anchor

The panel shows the foreman of the agent terminal that owns the tab's pane, never the keyboard focus. A focused floating child at most
selects that child's tab. Child plans are tabs joined by the radar `parent` field.

## Data

`shared("pi-foreman.radar")` (herdr-app persists it in `shared.json`), then for the session on screen `plan.json` and `note.json` in its
`show.dir`, the plan they name, and `plan.ruled.md` / `plan.prev.md`. Every 5 s only the two JSON files are re-read; documents are
re-read when those bytes change or the folder watch fires. Nothing is written.

## Limits

- Plans written through the shell are not observed; remote child sessions show no tab.
- Marks stop above 4000 lines per side or 1500 changed lines.
- Images never load (`![` is escaped); only `https://` links open, through the platform opener.
- The SVG cache, once diagrams ship, has no pruning API and grows without bound.
- `model.js` holds copies of a few helpers from `../pi-foreman/model.js` (the loader refuses cross-mod imports); `model.parity.test.mjs` keeps them equal.

Tests: `node --test "integrations/herdr-app/pi-foreman-plan/*.test.mjs"`.
