# pi-foreman-plan mod for herdr-app

A panel that lists the pages and milestones of the foreman that owns the tab, and of each of its child sessions (one tab each). A page is
a standalone HTML file the foreman writes (plan, note, result); a click opens it in the system browser through a copy the mod writes into its own slot folder. It writes only those page copies and the clearing of the sidebar's pending request (`pi-foreman.show-pending`); own code on the public
mod API (`shared`, `readTextFile`, `writeTextFile`, `watchFolder`, `agents`, `panes`, `focused`, `exec`, `theme`, `window`).

It installs together with `pi-foreman/` (the Agents mod): that mod publishes the radar this panel reads and adds the sidebar rows that open it.

## Install

1. Copy this folder to `~/.config/herdr-app/mods/pi-foreman-plan/` and copy `../pi-foreman/` again.
2. Add the panel to the `panel-body` stack of your layout:
   `{ "id": "plan", "type": "block", "content": { "mod": "pi-foreman-plan" } }`
3. `herdr-app check ~/.config/herdr-app/mods/pi-foreman-plan`, then switch to the layout.

Updating: `foreman setup --mods` refreshes both installed mods from the package (see the pi-foreman install in docs/herdr.md); the `cache/` folder is kept.

The Agents mod's header has a "📄 Plan" button that brings the panel forward.

## The list

- Per tab, pages newest first with a state chip ("plan v3 · waits for you") and their age, then the milestones (plan review, checkpoint
  answer, PR opened, PR ready, PR merged, result written), newest first. A milestone with an `https://` link opens it.
- A page that arrives (a new id, or a higher version of a page; the first good read of a session's index only records; a missing index counts as empty, a failed read is retried) opens the panel (selects the
  block, shows the hidden panel around it) on the tab of the session that wrote it. Block and panel ids are found by searching the shown
  layout for this mod, with the `foreman.json` ids (`panel-body`, `plan`, `panel`) as fallback. When the layout has no such block this mod is
  not running; the Agents mod (`pi-foreman`) posts the notification that says to add `{ "mod": "pi-foreman-plan" }` to a stack.
- A page not opened yet at its current state has a ● on its entry; a tab that is not on screen gets a ● on its label while one of its
  pages is unseen.

## Anchor

The panel shows the foreman of the agent terminal that owns the tab's pane, never the keyboard focus. A focused floating child at most
selects that child's tab. Child sessions are tabs joined by the radar `parent` field.

## Data

`shared("pi-foreman.radar")` (herdr-app persists it in `shared.json`), then for each session of the tab `pages/pages.json` in its
`show.dir`. Every 5 s the index files are re-read (local ones also on a folder watch). An entry counts only when its `file` matches
`^(?:plan|result|note-\d{1,6})\.html$`; any other entry is dropped before a path is built.

## Opening a page

The page is read (local or remote, at most 1 MiB). For a local session its relative `src` and `poster` values (no scheme, not starting with
`/` or `#`) are made absolute against the session's `pages/` folder, so relative pictures and videos load. The text is written into one of
eight fixed files, `mods/pi-foreman-plan/cache/pages/slot-<0-7>.html` in the app home (round robin, overwritten, never deleted), and the
platform opener runs on that copy only: `open`, `xdg-open` or `rundll32 url.dll,FileProtocolHandler`, no shell, and only that exact path is
accepted (`pageOpenerArgv`; the compare ignores case on macOS and Windows). The opener runs the handler of the file type, so opening our own
`.html` copy keeps it to the browser, also when the source file is a symlink. An opener that fails raises an error notice with the exit code
and the first error line. Beyond the copies and the clearing of the sidebar's pending request (`pi-foreman.show-pending`) the mod writes
nothing; the only process it starts is the platform opener, for page copies and for `https://` links.

## Limits

- Plans written through the shell are not observed; remote child sessions show no tab.
- The rewrite for local copies covers `src` and `poster` only, not `srcset`, `<link href>` or CSS `url()`; links and `#` anchors stay as written.
  A `result.md` written by `cp` or a heredoc gets no page.
- The page runs in the browser as written, with no script or network restriction.
- Older versions of this mod left `cache/<sha>-<theme>.svg` files; nothing reads them now and they can be deleted.
- `model.js` holds copies of a few helpers from `../pi-foreman/model.js` (the loader refuses cross-mod imports); `model.parity.test.mjs` keeps them equal.

Tests: `node --test "integrations/herdr-app/pi-foreman-plan/*.test.mjs"`.
