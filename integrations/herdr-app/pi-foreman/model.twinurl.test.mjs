import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, openPrGroups, enrichPrs, prUrl, prCard } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const URL56 = "https://example.test/acme/widgets/pull/56";
// A session whose dot knows only the number: no url, and the node has no repoUrl.
const sess = {
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", own: cost, tot: cost, children: [], waits: [],
  dots: [{ n: 56, state: "ok", label: "#56", src: "pr" }],
};
const feedPr = {
  repo: "acme/widgets", number: 56, title: "Panes", url: URL56, state: "open", author: "o", baseRefName: "main", mergeable: "CONFLICTING",
  checks: [{ n: "ci", state: "fail", label: "ci" }, { n: "lint", state: "ok", label: "lint" }],
};
const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess], openPrs: [feedPr] }));
const tops = buildTree(parsed.nodes);

test("a PR of a non-shown session with only a number takes url, title and checks from its feed twin", () => {
  const [g] = openPrGroups(parsed.openPrs, tops, new Set());
  assert.equal(g.prs.length, 1);
  const [p] = g.prs;
  assert.equal(p.href, URL56);
  assert.equal(p.title, "Panes");
  assert.deepEqual(p.jobs.map((j) => j.name), ["ci", "lint"]);
  assert.deepEqual(p.checks, ["fail", "ok"]);
  assert.match(prCard(p).conflict, /conflicts with main/);
});

test("a PR on a shown session row gets the feed url through enrichPrs and prUrl", () => {
  const [own] = tops[0].prs;
  assert.equal(prUrl(tops[0], own), "");
  const [p] = enrichPrs([own], parsed.openPrs);
  assert.equal(prUrl(tops[0], p), URL56);
  assert.equal(p.title, "Panes");
  assert.equal(p.jobs.length, 2);
  assert.equal(p.baseRef, "main");
});
