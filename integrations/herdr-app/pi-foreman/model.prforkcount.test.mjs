import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, prSummary } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const sess = (key, over = {}) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children: [], ...over,
});
const pr = (over = {}) => ({
  repo: "acme/widgets", number: 5, title: "t5", url: "https://example.test/acme/widgets/pull/5", state: "open",
  author: "o", checks: [], headRefName: "feat/5", headRepo: "someone/widgets", ...over,
});
const nodesOf = (roots, openPrs) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs })).nodes;
const forks = () => [
  sess("a", { repo: "someone/widgets", branch: "feat/5" }),
  sess("b", { repo: "someone/widgets", branch: "feat/5" }),
];

test("a fork PR shown on two sessions is counted once", () => {
  const nodes = nodesOf(forks(), [pr()]);
  assert.deepEqual(nodes.map((n) => n.prs.length), [1, 1]);
  assert.equal(prSummary(nodes.flatMap((n) => n.prs)), "1 PR");
});

test("a merged fork PR gets no chip and no count", () => {
  const nodes = nodesOf(forks(), [pr({ state: "merged" })]);
  assert.deepEqual(nodes.map((n) => n.prs.length), [0, 0]);
  assert.equal(prSummary(nodes.flatMap((n) => n.prs)), "");
});
