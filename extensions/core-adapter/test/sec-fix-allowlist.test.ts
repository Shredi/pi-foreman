// SEC-fix-2 G2: asyncRunDirs refuses `.`/`..` run segments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asyncRunDirs } from "../roundsurface.ts";

test("G2: asyncRunDirs refuses `.` and `..` run segments", () => {
  const tmp = "/t/pi-subagents-uid-1";
  const got = asyncRunDirs([`${tmp}/async-subagent-runs/..`, `${tmp}/async-subagent-runs/.`, `${tmp}/async-subagent-results/...json`, `${tmp}/async-subagent-results/..json`, `${tmp}/async-subagent-runs/../x`], "linux");
  for (const d of got) assert.ok(!/\/\.\.?(\/|$)/.test(d) && !d.endsWith("/.."), d);
  assert.deepEqual(asyncRunDirs([`${tmp}/async-subagent-runs/r1`], "linux"), [`${tmp}/async-subagent-results/r1.json`, `${tmp}/async-subagent-runs/r1`]);
});
