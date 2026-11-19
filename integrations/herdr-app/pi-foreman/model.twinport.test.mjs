import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, twinOf, openPrGroups, prSummary, sortPrs } from "./model.js";

// The default port is the same address: `https://github.com:443/...` and `https://github.com/...` are one PR, as a browser reads them.
const H1 = "1111111111111111111111111111111111111111";
const feedEntry = (url, over = {}) => ({ number: 7, repo: "acme/app", title: "Change", url, state: "open", checks: [{ n: "ci", state: "ok" }], mergeable: "MERGEABLE", head: H1, mergeState: "clean", headRefName: "feat", ...over });
const session = (url) => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", own: { in: 0, out: 0, cost: 0, uncached: 0 }, tot: { in: 0, out: 0, cost: 0, uncached: 0 }, children: [],
  waits: [], repoUrl: "https://github.com/acme/app", repo: "acme/app", branch: "other",
  dots: [{ n: 7, state: "ok", label: "#7", src: "pr", url }],
});
const PLAIN = "https://github.com/acme/app/pull/7";
const WITH_443 = "https://github.com:443/acme/app/pull/7";
const WITH_8443 = "https://github.com:8443/acme/app/pull/7";

const pr = (url) => ({ number: 7, repo: "acme/app", url, state: "open" });
const feedWith = (url) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [feedEntry(url)] })).openPrs;

test("a host with the default port and one without are the same PR: the twin is found", () => {
  const feed = feedWith(WITH_443);
  assert.equal(twinOf(pr(PLAIN), feed), feed[0]);
  const feed2 = feedWith(PLAIN);
  assert.equal(twinOf(pr(WITH_443), feed2), feed2[0], "and the other way round");
});

test("a host with another port is a different address: no twin by URL", () => {
  const feed = feedWith(WITH_8443);
  assert.equal(twinOf(pr(PLAIN), feed), null);
});

test("the host compares in lower case, as GitHub does", () => {
  const feed = feedWith("https://GitHub.com/acme/app/pull/7");
  assert.equal(twinOf(pr(PLAIN), feed), feed[0]);
});

test("Open PRs lists a PR once when a session shows the other spelling of its address", () => {
  const parsed = parseRadarDoc(JSON.stringify({ roots: [session(PLAIN)], openPrs: [feedEntry(WITH_443)] }));
  const tops = buildTree(parsed.nodes);
  const groups = openPrGroups(parsed.openPrs, tops, new Set());
  assert.equal(groups.flatMap((g) => g.prs).length, 1);
});

test("a PR listed twice with the two spellings is counted once in the summary and the sort", () => {
  const list = [{ ...pr(PLAIN), checks: [{ n: "ci", state: "ok" }] }, { ...pr(WITH_443), checks: [{ n: "ci", state: "fail" }] }];
  assert.equal(prSummary(list), "1 PR · all green", "one PR, the first spelling kept");
  assert.equal(sortPrs(list).length, 1);
});
