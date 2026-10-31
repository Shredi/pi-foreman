import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, openPrGroups, openPrsAge, shownNodes } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const live = {
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", glyph: "⏳", hcTerminal: "t1", own: cost, tot: cost,
  children: [], waits: [], repoUrl: "https://example.test/acme/widgets",
  dots: [
    { n: 5, state: "ok", label: "#5", src: "pr", url: "https://example.test/acme/widgets/pull/5" },
    { n: 6, state: "ok", label: "#6", src: "pr" },
  ],
};
const open = (number, over = {}) => ({
  repo: "acme/widgets", number, title: `t${number}`, url: `https://example.test/acme/widgets/pull/${number}`, state: "open", author: "o", checks: [], ...over,
});
const doc = (openPrs, extra = {}) => JSON.stringify({ v: 1, roots: [live], openPrs, ...extra });

function groups(openPrs) {
  const parsed = parseRadarDoc(doc(openPrs));
  const tops = buildTree(parsed.nodes);
  return openPrGroups(parsed.openPrs, tops, shownNodes(joinAgents([{ address: "t1" }], tops)));
}

test("openPrs under a live agent are not listed again: by url", () => {
  const got = groups([open(5), open(9)]);
  assert.deepEqual(got.flatMap((g) => g.prs.map((p) => p.number)), [9]);
});

test("openPrs under a live agent are not listed again: by repo and number when a url is missing", () => {
  const got = groups([open(6, { url: "" }), open(5, { url: "" }), open(10, { url: "" })]);
  assert.deepEqual(got.flatMap((g) => g.prs.map((p) => p.number)), [10]);
});

test("a different repository with the same number is kept", () => {
  const got = groups([open(5, { repo: "acme/gears", url: "https://example.test/acme/gears/pull/5" })]);
  assert.equal(got[0].repo, "acme/gears");
  assert.equal(got[0].prs[0].number, 5);
});

test("openPrsAt is read as a time and shown as an age", () => {
  const at = "2026-10-31T10:00:00Z";
  const parsed = parseRadarDoc(doc([], { openPrsAt: at }));
  assert.equal(parsed.openPrsAt, Date.parse(at));
  assert.equal(openPrsAge(parsed.openPrsAt, Date.parse(at) + 12 * 60_000 + 5000), "updated 12m ago");
  assert.equal(openPrsAge(parsed.openPrsAt, Date.parse(at) - 5000), "updated 0s ago");
  assert.equal(openPrsAge(null, 1), "");
  assert.equal("openPrsAt" in parseRadarDoc(doc([], { openPrsAt: "nope" })), false);
  assert.equal("openPrsAt" in parseRadarDoc(doc([])), false);
});
