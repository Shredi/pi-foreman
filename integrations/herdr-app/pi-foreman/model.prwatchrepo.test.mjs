import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, openPrGroups } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const ref = (n, repo = "owner/repo-b", host = "github.com") => ({ n, repo, host });
const watch = (prs, prRefs) => [{ kind: "pr", note: "watching", age_s: 0, prs, ...(prRefs ? { prRefs } : {}) }];
const sess = (key, over = {}) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children: [], ...over,
});
const pr = (number, over = {}) => ({
  repo: "owner/repo-b", headRepo: "owner/repo-b", number, title: `t${number}`, url: `https://github.com/owner/repo-b/pull/${number}`, state: "open",
  author: "o", checks: [], headRefName: "feat/x", ...over,
});
const parse = (roots, openPrs) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs }));
const chips = (got) => got.nodes.map((n) => n.prs.map((p) => p.number));

test("a session in repo-a carries the chip of the PR in repo-b it watches (ref names the repository)", () => {
  const got = parse([sess("s", { repo: "owner/repo-a", branch: "main", waits: watch([5], [ref(5)]) })], [pr(5)]);
  assert.deepEqual(chips(got), [[5]]);
  const tops = buildTree(got.nodes);
  assert.deepEqual(openPrGroups(got.openPrs, tops, new Set(tops)).flatMap((g) => g.prs.map((p) => p.number)), []);
});

test("a session with no repository of its own carries the chip of a referenced PR", () => {
  const got = parse([sess("s", { waits: watch([5], [ref(5)]) })], [pr(5)]);
  assert.deepEqual(chips(got), [[5]]);
});

test("the repository compares case-insensitively; a host on both sides must agree", () => {
  const roots = (r) => [sess("s", { repo: "owner/repo-a", waits: watch([5], [r]) })];
  assert.deepEqual(chips(parse(roots(ref(5, "Owner/Repo-B")), [pr(5)])), [[5]]);
  assert.deepEqual(chips(parse(roots(ref(5, "owner/repo-b", "")), [pr(5, { url: "" })])), [[5]]);
  assert.deepEqual(chips(parse(roots(ref(5, "owner/repo-b", "ghe.example")), [pr(5)])), [[]]);
});

test("a ref for another repository or number does not attach", () => {
  const roots = [sess("s", { repo: "owner/repo-a", waits: watch([5], [ref(5, "owner/repo-c")]) })];
  assert.deepEqual(chips(parse(roots, [pr(5)])), [[]]);
  assert.deepEqual(chips(parse([sess("s", { repo: "owner/repo-a", waits: watch([6], [ref(6)]) })], [pr(5)])), [[]]);
});

test("a number-only watch of another repository still does not attach (old live file)", () => {
  const got = parse([sess("s", { repo: "owner/repo-a", branch: "main", waits: watch([5]) })], [pr(5)]);
  assert.deepEqual(chips(got), [[]]);
});

test("a PR named by a ref and by branch attaches once; malformed refs are dropped", () => {
  const got = parse([sess("s", { repo: "owner/repo-b", branch: "feat/x", waits: watch([5], [ref(5), { n: "x" }, null, { n: 5 }]) })], [pr(5)]);
  assert.deepEqual(chips(got), [[5]]);
  assert.deepEqual(got.nodes[0].waits[0].prRefs, [{ n: 5, repo: "owner/repo-b", host: "github.com" }]);
});

test("a wait without prRefs parses as before", () => {
  const got = parse([sess("s", { repo: "owner/repo-a", waits: watch([5]) })], []);
  assert.equal("prRefs" in got.nodes[0].waits[0], false);
  assert.deepEqual(got.nodes[0].waits[0].prs, [5]);
});
