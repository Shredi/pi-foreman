// One list of the child-written handoff names: the TypeScript list equals `tests/fixtures/handoff-names.json` (the Python list is compared with it in
// tests/test_handoff_names_fixture.py), no parent-written name is on it, and the shell guard payload carries it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HANDOFF_CHILD_NAMES } from "../pathrules.ts";
import { shellWriteGuardPayload } from "../shellwriteguard.ts";

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "handoff-names.json"), "utf8")) as { childWritten: string[]; parentWritten: string[] };

test("the TypeScript list equals the fixture", () => {
  assert.deepEqual([...HANDOFF_CHILD_NAMES].sort(), [...fixture.childWritten].sort());
});

test("no parent-written name is on the list", () => {
  for (const n of fixture.parentWritten) assert.ok(!HANDOFF_CHILD_NAMES.includes(n), n);
  for (const n of ["ruling", "brief", "steer", "parent", "child", "close.json", "live.json", "launch.txt", "notice-seq.lock"]) assert.ok(!HANDOFF_CHILD_NAMES.some((h) => h.startsWith(n)), n);
});

test("the payload carries the list with a handoff dir, and no list without one", () => {
  const pc = { sessionId: "s1", cwd: "/w", home: "/h" };
  const withDir = shellWriteGuardPayload({ command: "true" }, pc, "/w", "bash", [".workflow"], [], { handoffDir: "/h/handoffs/x" });
  assert.deepEqual(withDir.handoff_names, fixture.childWritten);
  assert.equal(shellWriteGuardPayload({ command: "true" }, pc, "/w").handoff_names, undefined);
});
