// r9 item 1 (Windows CI ids 32, 33, 39): the background-run spawn flags per platform, injected. win32 spawns not detached
// (DETACHED_PROCESS leaves a console grandchild's output out of the log) and hidden; POSIX stays detached (own process group).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bgSpawnFlags } from "../bg.ts";

test("bgSpawnFlags win32: cmd.exe is spawned not detached and hidden (no DETACHED_PROCESS, no console window)", () => {
  assert.deepEqual(bgSpawnFlags("win32"), { detached: false, windowsHide: true });
});

test("bgSpawnFlags linux and darwin: detached as before (own process group)", () => {
  for (const p of ["linux", "darwin"]) assert.deepEqual(bgSpawnFlags(p), { detached: true, windowsHide: true }, p);
});
