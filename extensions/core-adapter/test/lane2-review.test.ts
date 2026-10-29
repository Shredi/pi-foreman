// R6 lane 2f: the builders of the owned and readable roots.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { childReadable, sessionOwnedRoots } from "../roundsurface.ts";

test("2a: sessionOwnedRoots lists scratch, round and isolation worktrees, handoffs, npm root, state scratch and own async runs", () => {
  // the "linux" platform argument asserts POSIX semantics, so the fixture is built with path.posix on every host
  const rt = path.posix.resolve("/w/repo.worktrees/round");
  const got = sessionOwnedRoots({ scratch: ["/t/s/c1"], rounds: [rt], handoffs: ["/a/handoffs/h1"], npmRoot: "/n/lib/node_modules", stateScratch: "/a/state/scratch/s1", asyncRuns: new Set(["/t/async/run-a", "relative/run-b", "/a/handoffs/h1"]) }, "linux");
  assert.deepEqual(got, ["/t/s/c1", rt, "/w/repo.worktrees/worktrees/round", "/a/handoffs/h1", "/n/lib/node_modules", "/a/state/scratch/s1", "/t/async/run-a"]);
  assert.deepEqual(sessionOwnedRoots({ scratch: [], rounds: [], handoffs: [] }, "linux"), []);
});

test("2f: childReadable names the bound ledger, its LEDGER-*.md siblings, the handoff dirs and the round worktrees", () => {
  const got = childReadable("/m/.workflow/LEDGER-r.md", ["/a/handoffs/h1"], ["/w/repo.worktrees/round"], "linux");
  assert.deepEqual(got, ["/m/.workflow/LEDGER-r.md", "/m/.workflow/LEDGER-*.md", "/a/handoffs/h1", "/a/handoffs/h1/*", "/w/repo.worktrees/round", "/w/repo.worktrees/round/*"]);
  assert.deepEqual(childReadable(null, [], [], "linux"), []);
});
