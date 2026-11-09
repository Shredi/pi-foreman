# pi-foreman-plan mod for herdr-app

A panel that renders the plan (and note) of the foreman that owns the tab, with NEW / CHANGED marks against the last ruling, a Diff
view, and one tab per child session that published a plan or a note. Read-only; own code on the public mod API (`shared`, `readTextFile`,
`watchFolder`, `agents`, `panes`, `focused`, `exec`, `theme`, `window`).

It installs together with `pi-foreman/` (the Agents mod): that mod publishes the radar this panel reads and adds the sidebar rows that open it.

## Install

1. Copy this folder to `~/.config/herdr-app/mods/pi-foreman-plan/` and copy `../pi-foreman/` again.
2. Add the panel to the `panel-body` stack of your layout:
   `{ "id": "plan", "type": "block", "content": { "mod": "pi-foreman-plan" } }`
3. `herdr-app check ~/.config/herdr-app/mods/pi-foreman-plan`, then switch to the layout.

The Agents mod's header has a "📄 Plan" button that brings the panel forward.

## Note tab, diagrams, code

- A `Note` tab appears when the session published a note (`foreman_show`). A note newer than the one seen before opens the panel (selects
  the block, shows the hidden panel around it) and switches to that tab; the first sight of a session does not. A child's note opens the
  panel on that child's tab.
- A child with a plan and a note has a Plan | Note switch on its tab. A child tab with a plan or note newer than the last one shown there
  gets a ● on its label; a first sight counts as new, and rendering the tab clears it. Block and panel ids are
  found by searching the shown layout for this mod, with the `foreman.json` ids (`panel-body`, `plan`, `panel`) as fallback. When the layout
  has no such block this mod is not running; the Agents mod (`pi-foreman`) posts the notification that says to add
  `{ "mod": "pi-foreman-plan" }` to a stack.
- Code fences render in a read-only highlighted editor (language from the info string).
- A `mermaid` fence whose sha256 (same fence rule as the harness, `tests/fixtures/mermaid-fences.json`) is listed in `fences` of the JSON
  shows the rendered SVG; otherwise it stays a `mermaid` code block. The SVG is checked against an element allow-list (no script, href,
  url(), style, foreignObject), then copied to `mods/pi-foreman-plan/cache/<sha>-<theme>.svg` in the app home, where the host reads it.

## Anchor

The panel shows the foreman of the agent terminal that owns the tab's pane, never the keyboard focus. A focused floating child at most
selects that child's tab. Child plans and notes are tabs joined by the radar `parent` field.

## Data

`shared("pi-foreman.radar")` (herdr-app persists it in `shared.json`), then for the session on screen `plan.json` and `note.json` in its
`show.dir`, the plan they name, and `plan.ruled.md` / `plan.prev.md`. Every 5 s only the two JSON files are re-read; documents are
re-read when those bytes change or the folder watch fires. Nothing is written.

## Limits

- Plans written through the shell are not observed; remote child sessions show no tab.
- Marks stop above 4000 lines per side or 1500 changed lines.
- Markdown images never load (`![` is escaped everywhere, code spans and fences included); only checked diagram SVGs are shown; only `https://` links open, through the platform opener.
- HTML tags are removed except `del, br, sub, sup, kbd`; `<mark>` is shown as bold because the host paints it as a yellow background under the theme's text colour.
- The SVG cache has no delete, stat or realpath API: it is not pruned (it grows by two files per distinct diagram) and the cache path is
  built from the sha and theme only, with the content allow-list as the check.
- `model.js` holds copies of a few helpers from `../pi-foreman/model.js` (the loader refuses cross-mod imports); `model.parity.test.mjs` keeps them equal.

Tests: `node --test "integrations/herdr-app/pi-foreman-plan/*.test.mjs"`.
