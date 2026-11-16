import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, openPrGroups, shownNodes } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const url = (n, repo = "acme/widgets") => `https://example.test/${repo}/pull/${n}`;
const session = (key, over = {}) => ({
  key, kind: "session", name: key, state: "working", sym: "working", glyph: "⏳", hcTerminal: key === "fm-a" ? "t1" : "t2", own: cost, tot: cost,
  children: [], waits: [], repoUrl: "https://example.test/acme/widgets", dots: [], ...over,
});
const open = (number, over = {}) => ({ repo: "acme/widgets", number, title: `t${number}`, url: url(number), state: "open", author: "o", checks: [], ...over });
const hide = (number, over = {}) => open(number, { hiddenRepo: true, ...over });
const numbers = (g) => g.flatMap((x) => x.prs.map((p) => p.number));

function groups(openPrs, roots = [session("fm-a")], shownAddresses = [{ address: "t1" }]) {
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs }));
  const tops = buildTree(parsed.nodes);
  return openPrGroups(parsed.openPrs, tops, shownNodes(joinAgents(shownAddresses, tops)));
}

test("normOpenPrs keeps hiddenRepo: true only", () => {
  const got = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs: [hide(1), open(2), open(3, { hiddenRepo: "yes" })] })).openPrs;
  assert.equal(got[0].hiddenRepo, true);
  assert.ok(!("hiddenRepo" in got[1]));
  assert.ok(!("hiddenRepo" in got[2]));
});

test("a marked feed entry has no row; other repos are unchanged", () => {
  const got = groups([hide(1), open(2, { repo: "acme/gears", url: url(2, "acme/gears") })]);
  assert.deepEqual(got.map((g) => g.repo), ["acme/gears"]);
});

test("without a mark nothing changes", () => {
  assert.deepEqual(numbers(groups([open(1), open(2)])).sort(), [1, 2]);
});

test("an unmarked entry of a marked repo (another machine's copy) is skipped too", () => {
  assert.deepEqual(numbers(groups([hide(1), open(1), open(9)])), []);
});

test("the repository match ignores case", () => {
  assert.deepEqual(numbers(groups([hide(1, { repo: "Acme/Widgets" }), open(2)])), []);
});

test("a session chip of a hidden repo stays", () => {
  const root = session("fm-a", { repo: "acme/widgets", dots: [{ n: 56, state: "ok", label: "#56", src: "pr", url: url(56) }] });
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, now: "2026-11-02T20:23:27Z", roots: [root], openPrs: [hide(77)], openPrsAt: "2026-11-02T20:22:18Z" }));
  assert.deepEqual(parsed.nodes[0].prs.map((p) => p.number), []);
  assert.deepEqual(parsed.openPrs.map((p) => p.number), [77], "the feed keeps the entry for covered");
});

test("a step-(b) PR of a hidden repo is skipped, with and without a twin", () => {
  const hidden = session("fm-b", { hcTerminal: "t2", dots: [{ n: 5, state: "ok", label: "#5", src: "pr", url: url(5) }, { n: 6, state: "ok", label: "#6", src: "pr" }] });
  const shownOnly = [{ address: "t1" }];
  assert.deepEqual(numbers(groups([open(5), open(6)], [session("fm-a"), hidden], shownOnly)).sort(), [5, 6]);
  assert.deepEqual(numbers(groups([hide(5)], [session("fm-a"), hidden], shownOnly)), []);
  assert.deepEqual(numbers(groups([hide(77)], [session("fm-a"), hidden], shownOnly)), [], "a feed entry of the repo hides it for twinless PRs too");
});

test("a step-(b) PR of a repo the feed does not list stays", () => {
  const hidden = session("fm-b", { hcTerminal: "t2", dots: [{ n: 5, state: "ok", label: "#5", src: "pr", url: url(5) }] });
  assert.deepEqual(numbers(groups([hide(1, { repo: "acme/other", url: url(1, "acme/other") })], [session("fm-a"), hidden], [{ address: "t1" }])), [5]);
});

test("two merged feeds: one machine's mark hides the repo", () => {
  const a = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs: [open(1)] })).openPrs;
  const b = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs: [hide(1), open(3, { repo: "acme/gears", url: url(3, "acme/gears") })] })).openPrs;
  assert.deepEqual(numbers(openPrGroups([...a, ...b], [], new Set())), [3]);
});
