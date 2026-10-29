// R6 lane 2 security: the read only owned roots (global npm root, own children's async run dirs) are split apart from the read-write ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionOwnedSplit } from "../roundsurface.ts";

test("sessionOwnedSplit: the npm root and the async run dirs are read only, the rest read-write", () => {
  const got = sessionOwnedSplit({ scratch: ["/t/s/c1"], rounds: ["/w/repo.worktrees/round"], handoffs: ["/a/handoffs/h1"], npmRoot: "/n/lib/node_modules", stateScratch: "/a/state/scratch/s1", asyncRuns: ["/t/async/run-a"] }, "linux");
  assert.deepEqual(got.write, ["/t/s/c1", "/w/repo.worktrees/round", "/w/repo.worktrees/worktrees/round", "/a/handoffs/h1", "/a/state/scratch/s1"]);
  assert.deepEqual(got.read, ["/n/lib/node_modules", "/t/async/run-a"]);
});
