import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, enrichPrs, prDotState, prState, prStateText } from "./model.js";

// The check mark (`mark: "check"`) is for a ready PR only; every other state keeps its dot, and the still green dot has no mark.
const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const ok = [{ n: "ci", state: "ok" }];
const pending = [{ n: "ci", state: "pending" }];
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const entry = (over = {}) => ({ number: 7, repo: "acme/app", title: "t", url: url(7), state: "open", checks: ok, mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "clean", ...over });
const review = (over = {}) => ({ n: 7, repo: "acme/app", host: "", head: H1, state: "ok", ...over });
const session = (waits, dot = "ok") => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", glyph: "⏳", own: cost, tot: cost, children: [],
  repoUrl: "https://github.com/acme/app", repo: "acme/app", branch: "feat", waits,
  dots: [{ n: 7, state: dot, label: "#7", src: "pr", url: url(7) }],
});
const wait = (rev) => ({ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [7], ...(rev ? { review: rev } : {}) });
/** The session's PR as main.js shows it: the dot PR, the fact attached by the model, enriched from the feed twin. */
const chip = (feed, waits, dot) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [session(waits, dot)], openPrs: feed }));
  return enrichPrs(buildTree(doc.nodes)[0].prs, doc.openPrs)[0];
};
/** A PR of the feed alone (no session): judged on host facts. */
const host = (over = {}) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];

test("a ready PR reviewed on the host's head: the check mark, green, still", () => {
  const p = chip([entry()], [wait([review()])]);
  assert.deepEqual(prDotState(p), { pulse: false, fill: "green", mark: "check", conflict: false });
  assert.equal(prState(p), "ok");
  assert.equal(prStateText(p), "ready to merge");
});

test("a ready PR judged on host facts alone: the check mark too, with no review claim", () => {
  const p = host();
  assert.deepEqual(prDotState(p), { pulse: false, fill: "green", mark: "check", conflict: false });
  assert.equal(prStateText(p), "ready to merge (CI passing, no review claim)");
});

test("a ready PR with no checks confirmed for its head: the check mark", () => {
  const p = chip([entry({ checks: [] })], [wait([review({ noChecks: true })])], "none");
  assert.deepEqual(prDotState(p), { pulse: false, fill: "green", mark: "check", conflict: false });
  assert.equal(prStateText(p), "ready to merge");
});

test("running, waiting, failed, draft, unreviewed and unknown PRs carry no check mark", () => {
  assert.deepEqual(prDotState(host({ checks: pending })), { pulse: true, fill: "amber", conflict: false });
  assert.deepEqual(prDotState(host({ mergeState: "blocked" })), { pulse: false, fill: "amber", conflict: false });
  assert.deepEqual(prDotState(host({ mergeState: "behind" })), { pulse: false, fill: "amber", conflict: false });
  assert.deepEqual(prDotState(host({ checks: [{ n: "ci", state: "fail" }] })), { pulse: false, fill: "red", conflict: false });
  assert.deepEqual(prDotState(host({ state: "draft" })), { pulse: false, fill: "violet", conflict: false });
  assert.deepEqual(prDotState(chip([entry()], [wait([review({ state: "unreviewed" })])])), { pulse: false, fill: "blue", conflict: false });
  assert.deepEqual(prDotState(host({ checks: [] })), { pulse: false, fill: "dim", conflict: false });
  for (const p of [host({ checks: pending }), host({ mergeState: "blocked" }), host({ checks: [{ n: "ci", state: "fail" }] }), host({ state: "draft" }), host({ checks: [] })]) {
    assert.equal(prDotState(p).mark, undefined);
  }
});

test("the still green dot has no check mark: an older feed, or a merge not known to be mergeable", () => {
  const older = parseRadarDoc(JSON.stringify({ roots: [], openPrs: [{ number: 7, repo: "acme/app", title: "t", url: url(7), state: "open", checks: ok }] })).openPrs[0];
  assert.deepEqual(prDotState(older), { pulse: false, fill: "green", conflict: false });
  assert.deepEqual(prDotState(host({ mergeable: "CONFLICTING", mergeState: "dirty" })), { pulse: false, fill: "green", conflict: true });
  assert.deepEqual(prDotState(host({ mergeState: "unknown" })), { pulse: false, fill: "green", conflict: false });
  assert.equal(prStateText(host({ mergeState: "unknown" })), "CI passing");
  assert.equal(prState(host({ mergeState: "unknown" })), "ok", "the sort and the summary still count it green");
});

test("a fact about another head never gives the check mark: the PR is unreviewed", () => {
  const p = chip([entry()], [wait([review({ head: H2 })])]);
  assert.deepEqual(prDotState(p), { pulse: false, fill: "blue", conflict: false });
});

test("a ready PR reads ok for the sort and the summary, as before", () => {
  assert.equal(prState(host()), "ok");
  assert.equal(prState(chip([entry()], [wait([review()])])), "ok");
});
