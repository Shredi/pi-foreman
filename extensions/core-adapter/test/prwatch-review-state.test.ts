import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, prDelta, prMessage } from "../prwatch.ts";
import type { CommentEntry, WatchSnapshot } from "../prwatch.ts";

const snap = (comments: CommentEntry[]): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123", base: "main", updatedAt: "t0", runs: [], comments });

function lines(c: CommentEntry): string[] {
  const base = baselineOf(snap([]));
  const { delta } = prDelta(base, snap([c]), false);
  return prMessage(7, delta!).content.split("\n").filter((l) => l.startsWith("- "));
}

test("a review summary line carries its state", () => {
  assert.deepEqual(lines({ id: "r1", kind: "review_summary", author: "alice", body: "lgtm", state: "approved" }), ["- review_summary alice (approved): lgtm"]);
  assert.deepEqual(lines({ id: "r2", kind: "review_summary", author: "alice", body: "fix it", state: "changes_requested" }), ["- review_summary alice (changes_requested): fix it"]);
});

test("an issue comment line is unchanged", () => {
  assert.deepEqual(lines({ id: "i1", kind: "issue", author: "bob", body: "hello" }), ["- issue bob: hello"]);
});
