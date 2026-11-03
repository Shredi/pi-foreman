import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const sess = (key, over = {}) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children: [], ...over,
});
const pr = (over = {}) => ({
  repo: "acme/widgets", number: 5, title: "t5", url: "https://example.test/acme/widgets/pull/5", state: "open",
  author: "o", checks: [], headRefName: "feat/5", ...over,
});
const prsOf = (roots, openPrs) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs })).nodes.map((n) => n.prs.map((p) => p.number));

test("the PR head branch gets the chip; a watched foreign PR on another branch gets none", () => {
  const roots = [sess("a", { repo: "acme/widgets", branch: "feat/5" }), sess("b", { repo: "acme/widgets", branch: "feat/other" })];
  assert.deepEqual(prsOf(roots, [pr()]), [[5], []]);
});

test("a fork PR chips the fork session, not an upstream session on the same branch name", () => {
  const roots = [sess("up", { repo: "acme/widgets", branch: "feat/5" }), sess("fork", { repo: "someone/widgets", branch: "feat/5" })];
  assert.deepEqual(prsOf(roots, [pr({ headRepo: "someone/widgets" })]), [[], [5]]);
});

test("a feed without headRepo falls back to the base repo", () => {
  const roots = [sess("up", { repo: "acme/widgets", branch: "feat/5" }), sess("fork", { repo: "someone/widgets", branch: "feat/5" })];
  assert.deepEqual(prsOf(roots, [pr()]), [[5], []]);
});
