import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, openPrGroups, prCard, UNREVIEWED } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const dots = [
  { n: 5, state: "ok", label: "#5", src: "pr", url: "https://example.test/acme/widgets/pull/5" },
  { n: 6, state: "ok", label: "#6", src: "pr", url: "https://example.test/acme/widgets/pull/6" },
];
const live = (waits) => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", glyph: "⏳", hcTerminal: "t1", own: cost, tot: cost,
  children: [], waits, repoUrl: "https://example.test/acme/widgets", repo: "acme/widgets", dots,
});
const prWatch = (extra = {}) => ({ id: "pr_watch", kind: "pr", note: "2 pr watch", age_s: 0, left_s: 0, prs: [5, 6], ...extra });
const prsOf = (waits) => {
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots: [live(waits)], openPrs: [] }));
  return buildTree(parsed.nodes)[0].prs;
};
const mark = (n, over = {}) => ({ n, repo: "acme/widgets", host: "example.test", ...over });

test("a watched PR the watch reports as unreviewed carries the token; the other PR of the session does not", () => {
  const prs = prsOf([prWatch({ unreviewed: [mark(5)] })]);
  assert.deepEqual(prs.map((p) => [p.number, p.unreviewed === true]), [[5, true], [6, false]]);
  assert.match(prCard(prs[0]).state, new RegExp(`^#5 · .* · ${UNREVIEWED}$`));
  assert.equal(prCard(prs[1]).state.includes(UNREVIEWED), false);
});

test("followed-only: a wait without an unreviewed list, or an empty one, marks nothing", () => {
  for (const waits of [[prWatch()], [prWatch({ unreviewed: [] })], []]) assert.ok(prsOf(waits).every((p) => !p.unreviewed));
});

test("the token goes with the list: a PASS (or an ended PR) removes the entry and the flag", () => {
  assert.equal(prsOf([prWatch({ unreviewed: [mark(5)] })])[0].unreviewed, true);
  assert.equal(prsOf([prWatch({ unreviewed: [] })])[0].unreviewed, undefined);
});

test("matched by repository and host: another repository or host with the same number is not flagged", () => {
  assert.ok(prsOf([prWatch({ unreviewed: [mark(5, { repo: "acme/gears" })] })]).every((p) => !p.unreviewed));
  assert.ok(prsOf([prWatch({ unreviewed: [mark(5, { host: "other.test" })] })]).every((p) => !p.unreviewed));
});

test("the flag survives into the Open PRs section for a session that is not shown", () => {
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots: [live([prWatch({ unreviewed: [mark(6)] })])], openPrs: [] }));
  const groups = openPrGroups(parsed.openPrs, buildTree(parsed.nodes), new Set());
  assert.deepEqual(groups.flatMap((g) => g.prs).map((p) => [p.number, p.unreviewed === true]).sort(), [[5, false], [6, true]]);
});
