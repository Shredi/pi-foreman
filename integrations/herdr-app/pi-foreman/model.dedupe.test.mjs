import test from "node:test";
import assert from "node:assert/strict";
import { prTones, parseRadarDoc, buildTree, joinAgents, openPrGroups, shownNodes } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const repoUrl = "https://example.test/acme/widgets";
const dot = (n) => ({ n, state: "ok", label: `#${n}`, src: "pr", url: `${repoUrl}/pull/${n}` });
const sess = (key, name, hc, dots) => ({
  key, kind: "session", name, state: "working", sym: "working", glyph: "", hcTerminal: hc, own: cost, tot: cost,
  children: [], waits: [], repoUrl, dots,
});
const open = (number) => ({ repo: "acme/widgets", number, title: `t${number}`, url: `${repoUrl}/pull/${number}`, state: "open", author: "o", checks: [] });

function run(roots, feed, agents) {
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs: feed }));
  const tops = buildTree(parsed.nodes);
  const groups = openPrGroups(parsed.openPrs, tops, shownNodes(joinAgents(agents, tops)));
  return groups.flatMap((g) => g.prs.map((p) => p.number));
}

test("prTones: green is the ANSI green, not the blue done colour", () => {
  const t = { done: "blue", working: "w", blocked: "red", dim: "dim", ansi2: "g2", ansi10: "g10", ansi3: "y3" };
  assert.equal(prTones(t).green, "g2");
  assert.equal(prTones({ ...t, ansi2: undefined }).green, "g10");
  assert.equal(prTones({ ...t, ansi2: undefined, ansi10: undefined }).green, "blue");
  assert.equal(prTones(t).amber, "y3");
  assert.equal(prTones(t).red, "red");
});

test("a PR of a shown session is on its row only, not in Open PRs", () => {
  assert.deepEqual(run([sess("a", "a", "t1", [dot(5)])], [open(5), open(9)], [{ address: "t1" }]), [9]);
});

test("a PR of a session that is not shown is listed once, under the first such session, not again from the feed", () => {
  const roots = [sess("a", "a", "", [dot(5)]), sess("b", "b", "", [dot(5), dot(6)])];
  assert.deepEqual(run(roots, [open(5)], []).sort(), [5, 6]);
});

test("a feed PR no session owns stays in the feed", () => {
  assert.deepEqual(run([sess("a", "a", "", [dot(5)])], [open(7)], []).sort(), [5, 7]);
});

test("a PR owned by a shown session and several hidden ones, and the feed, is not listed at all", () => {
  const roots = [sess("s", "shown", "t1", [dot(50), dot(55)]), sess("p", "p", "", [dot(50), dot(55)]),
    sess("r", "r", "", [dot(50), dot(55)]), sess("m", "m", "", [dot(50)])];
  assert.deepEqual(run(roots, [open(50), open(51)], [{ address: "t1" }]), [51]);
});

test("the 4x / 3x case: no shown owner, #50 and #55 appear once each", () => {
  const roots = [sess("p", "p", "", [dot(50), dot(55)]), sess("r", "r", "", [dot(50), dot(55)]), sess("m", "m", "", [dot(50)])];
  const got = run(roots, [open(51), open(50)], []);
  assert.deepEqual(got.slice().sort(), [50, 51, 55]);
});
