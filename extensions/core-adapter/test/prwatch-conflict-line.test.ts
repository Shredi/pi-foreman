// The conflict line goes to a session with a handoff dir: a foreman session that pushes its own branch. It tells that session to merge the
// base and push; it does not send it to a parent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, prDelta, prMessage } from "../prwatch.ts";
import type { WatchSnapshot } from "../prwatch.ts";

const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [], ...o });

test("the conflict line names the base and the push, not the parent", () => {
  const delta = prDelta(baselineOf(snap()), snap({ mergeable: "conflicting" }), true).delta!;
  const lines = prMessage(7, delta).content.split("\n");
  const line = lines.find((l) => l.startsWith("merge "));
  assert.equal(line, "merge main into the branch and push it");
  assert.ok(!/parent/.test(line!), "the conflict line does not name the parent");
});
