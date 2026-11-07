import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, openPrGroups } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const watch = (...prs) => [{ kind: "pr", note: "watching", age_s: 5, prs }];
const sess = (key, over = {}) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children: [], ...over,
});
const pr = (number, over = {}) => ({
  repo: "acme/widgets", number, title: `t${number}`, url: `https://example.test/acme/widgets/pull/${number}`, state: "open",
  author: "o", checks: [], headRefName: "feat/a", ...over,
});
const parse = (roots, openPrs) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs }));
const chips = (got) => got.nodes.map((n) => n.prs.map((p) => p.number));

test("a session that switched branch keeps the chip of the PR it watches", () => {
  const got = parse([sess("s", { repo: "acme/widgets", branch: "feat/b", waits: watch(7) })], [pr(7)]);
  assert.deepEqual(chips(got), [[7]]);
});

test("on the PR head branch and watching it too, the session gets one chip", () => {
  const got = parse([sess("s", { repo: "acme/widgets", branch: "feat/a", waits: watch(7) })], [pr(7)]);
  assert.deepEqual(chips(got), [[7]]);
});

test("a watched number of another repository does not attach", () => {
  const got = parse([sess("s", { repo: "acme/widgets", branch: "feat/b", waits: watch(7) })], [pr(7, { repo: "acme/gears" })]);
  assert.deepEqual(chips(got), [[]]);
});

test("an open tracked PR that matches no session is listed once under Open PRs", () => {
  const got = parse([sess("s", { repo: "acme/widgets", branch: "feat/b" })], [pr(7, { tracked: true })]);
  const tops = buildTree(got.nodes);
  const groups = openPrGroups(got.openPrs, tops, new Set(tops));
  assert.deepEqual(groups.flatMap((g) => g.prs.map((p) => p.number)), [7]);
});

test("a merged feed twin drops the chip and is not listed under Open PRs", () => {
  const got = parse([sess("s", { repo: "acme/widgets", branch: "feat/b", waits: watch(7), dots: [{ src: "pr", n: 7, state: "ok", label: "#7", repo: "acme/widgets" }] })], [pr(7, { state: "merged" })]);
  assert.deepEqual(chips(got), [[]]);
  const tops = buildTree(got.nodes);
  assert.deepEqual(openPrGroups(got.openPrs, tops, new Set(tops)), []);
});

test("a fork PR whose head repository is the session repository attaches by watch", () => {
  const got = parse([sess("s", { repo: "someone/widgets", branch: "feat/b", waits: watch(7) })], [pr(7, { headRepo: "someone/widgets" })]);
  assert.deepEqual(chips(got), [[7]]);
});
