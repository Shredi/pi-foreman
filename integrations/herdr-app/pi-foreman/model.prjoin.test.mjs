import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, openPrGroups, sessionTree, shownNodes, joinAgents, prCard, enrichPrs } from "./model.js";

// Nodes as radar emits them since the join: `repo` and `branch`, and no `dots`.
const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const sess = (key, over = {}, children = []) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children, ...over,
});
const pr = (number, over = {}) => ({
  repo: "acme/widgets", number, title: `t${number}`, url: `https://example.test/acme/widgets/pull/${number}`, state: "open",
  author: "o", checks: [{ n: "ci", state: "run", label: "ci" }], headRefName: `feat/${number}`, ...over,
});
const parse = (roots, openPrs) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs }));

test("a feed PR with the repo and head branch of a session lands on its row, root included", () => {
  const root = sess("fm-a", { repo: "acme/widgets", branch: "feat/5" }, [sess("fm-b", { repo: "acme/widgets", branch: "feat/6" })]);
  const got = parse([root], [pr(5), pr(6), pr(9)]);
  const [top] = buildTree(got.nodes);
  assert.deepEqual(top.prs.map((p) => p.number), [5]);
  assert.deepEqual(top.sessions[0].prs.map((p) => p.number), [6]);
  const tree = sessionTree(top);
  assert.deepEqual(tree.prs.map((p) => p.number), [5]);
});

test("no match: another repository, another branch, a session without repo or branch", () => {
  const roots = [sess("a", { repo: "acme/gears", branch: "feat/5" }), sess("b", { repo: "acme/widgets", branch: "other" }), sess("c", {}), sess("d", { repo: "acme/widgets" })];
  const got = parse(roots, [pr(5)]);
  assert.deepEqual(got.nodes.map((n) => n.prs.length), [0, 0, 0, 0]);
});

test("the repository compares case-insensitively; merged and closed PRs do not match", () => {
  const got = parse([sess("a", { repo: "Acme/Widgets", branch: "feat/5" }), sess("b", { repo: "acme/widgets", branch: "feat/6" })],
    [pr(5), pr(6, { state: "merged" })]);
  assert.deepEqual(got.nodes.map((n) => n.prs.length), [1, 0]);
});

test("a matched PR is not listed again under Open PRs; an unmatched one is", () => {
  const got = parse([sess("fm-a", { repo: "acme/widgets", branch: "feat/5" })], [pr(5), pr(9)]);
  const tops = buildTree(got.nodes);
  const groups = openPrGroups(got.openPrs, tops, new Set(tops));
  assert.deepEqual(groups.flatMap((g) => g.prs.map((p) => p.number)), [9]);
  const hidden = openPrGroups(got.openPrs, tops, new Set());
  assert.deepEqual(hidden.flatMap((g) => g.prs.map((p) => p.number)).sort((a, b) => a - b), [5, 9]);
});

test("an old pr dot and a matching feed PR on one session show once", () => {
  const dots = [{ n: 5, state: "ok", label: "#5", src: "pr", url: "https://example.test/acme/widgets/pull/5" }];
  const got = parse([sess("fm-a", { repo: "acme/widgets", branch: "feat/5", dots })], [pr(5)]);
  assert.equal(got.nodes[0].prs.length, 1);
});

test("shownNodes still covers the matched session", () => {
  const got = parse([sess("fm-a", { repo: "acme/widgets", branch: "feat/5", hcTerminal: "t1" })], [pr(5)]);
  const tops = buildTree(got.nodes);
  const shown = shownNodes(joinAgents([{ address: "t1" }], tops));
  assert.equal(openPrGroups(got.openPrs, tops, shown).length, 0);
});

test("the card names the base branch of the feed entry; without one it falls back", () => {
  const got = parse([sess("fm-a", { repo: "acme/widgets", branch: "feat/5" })], [pr(5, { mergeable: "CONFLICTING", baseRefName: "main" })]);
  assert.equal(got.openPrs[0].baseRef, "main");
  assert.equal(prCard(got.nodes[0].prs[0]).conflict, "conflicts with main");
  const [dotPr] = enrichPrs([{ number: 5, repo: "acme/widgets", url: "https://example.test/acme/widgets/pull/5", checks: [], jobs: [] }], got.openPrs);
  assert.equal(prCard(dotPr).conflict, "conflicts with main");
  const bare = parse([], [pr(6, { mergeable: "CONFLICTING" })]);
  assert.equal(prCard(bare.openPrs[0]).conflict, "conflicts with its base branch");
});
