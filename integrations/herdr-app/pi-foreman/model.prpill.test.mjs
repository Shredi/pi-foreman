import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, enrichPrs, prDotState, prState, prStateText, prCard, prSummary, sortPrs } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const ok = [{ n: "ci", state: "ok" }];
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const entry = (over = {}) => ({ number: 7, repo: "acme/app", title: "t", url: url(7), state: "open", author: "me", checks: ok, mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "clean", ...over });
const review = (over = {}) => ({ n: 7, repo: "acme/app", host: "", head: H1, state: "ok", ...over });
const session = (waits, dot = "ok") => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", glyph: "⏳", own: cost, tot: cost, children: [],
  repoUrl: "https://github.com/acme/app", repo: "acme/app", branch: "feat", waits,
  dots: [{ n: 7, state: dot, label: "#7", src: "pr", url: url(7) }],
});
const wait = (rev) => ({ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [7], ...(rev ? { review: rev } : {}) });
/** The session's PR chip as main.js shows it: the dot PR, fact attached by the model, enriched from the feed twin. */
const chip = (feed, waits, dot) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [session(waits, dot)], openPrs: feed }));
  return enrichPrs(buildTree(doc.nodes)[0].prs, doc.openPrs)[0];
};
const feedOnly = (over) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];

test("owned PR: the five states", () => {
  const w = [wait([review()])];
  assert.equal(prState(chip([entry({ state: "draft" })], w)), "wip");
  assert.equal(prState(chip([entry({ checks: [{ n: "ci", state: "pending" }] })], w)), "pending");
  assert.equal(prState(chip([entry({ checks: [{ n: "ci", state: "fail" }] })], w)), "fail");
  assert.equal(prState(chip([entry()], [wait([review({ state: "unreviewed" })])])), "unreviewed");
  const ready = chip([entry()], w);
  assert.equal(prState(ready), "ok");
  assert.equal(prStateText(ready), "ready to merge");
  assert.deepEqual(prDotState(ready), { ring: false, fill: "green", conflict: false });
});

test("a session fact about an older head never shows ready on a newer host head", () => {
  const pr = chip([entry({ head: H2 })], [wait([review({ head: H1 })])]);
  assert.equal(prState(pr), "unreviewed");
  assert.equal(prStateText(pr), "CI passing, not reviewed");
  assert.equal(prDotState(pr).fill, "blue");
  assert.equal(prState(chip([entry({ head: H2 })], [wait([review({ head: H1, state: "wip" })])])), "unreviewed");
});

test("a wip fact for the host's head is work in progress, with its own look and hover text", () => {
  const pr = chip([entry()], [wait([review({ state: "wip" })])]);
  assert.equal(prState(pr), "wip");
  assert.equal(prDotState(pr).fill, "violet");
  assert.equal(prCard(pr).state, "#7 · work in progress");
});

test("an unreviewed fact (draft flow off: the PR is open) shows not reviewed, never ready", () => {
  const pr = chip([entry({ state: "open" })], [wait([review({ state: "unreviewed" })])]);
  assert.equal(prState(pr), "unreviewed");
  assert.match(prCard(pr).state, /not reviewed/);
});

test("blocked or behind shows running, not ready", () => {
  for (const mergeState of ["blocked", "behind"]) {
    const pr = chip([entry({ mergeState })], [wait([review()])]);
    assert.equal(prState(pr), "pending", mergeState);
    assert.equal(prStateText(pr), "CI running");
    assert.deepEqual(prDotState(pr), { ring: true, fill: "amber", conflict: false });
  }
  assert.equal(prState(feedOnly({ mergeState: "behind" })), "pending");
});

test("dirty or unknown merge state is never ready", () => {
  for (const mergeState of ["dirty", "unknown"]) assert.notEqual(prStateText(chip([entry({ mergeState })], [wait([review()])])), "ready to merge");
});

test("an owned PR with no checks: ready only when the watch confirmed it", () => {
  const none = entry({ checks: [] });
  const confirmed = chip([none], [wait([review({ noChecks: true })])], "none");
  assert.equal(prStateText(confirmed), "ready to merge");
  assert.equal(prState(confirmed), "ok");
  assert.equal(prStateText(chip([none], [wait([review()])], "none")), "no CI checks");
  assert.equal(prState(chip([none], [wait([review({ noChecks: true, state: "unreviewed" })])], "none")), "unreviewed");
  assert.equal(prState(chip([none], [wait([review({ noChecks: true, head: H2 })])], "none")), "none");
});

test("host facts only without a session fact: draft, running, red, green and mergeable", () => {
  assert.equal(prState(feedOnly({ state: "draft" })), "wip");
  assert.equal(prState(feedOnly({ checks: [{ n: "ci", state: "pending" }] })), "pending");
  assert.equal(prState(feedOnly({ checks: [{ n: "ci", state: "fail" }] })), "fail");
  const g = feedOnly();
  assert.equal(prState(g), "ok");
  assert.equal(prStateText(g), "ready to merge (CI passing, no review claim)");
  assert.equal(prStateText(feedOnly({ mergeable: "CONFLICTING", mergeState: "dirty" })), "CI passing");
  assert.equal(prStateText(chip([entry()], [wait(null)])), "ready to merge (CI passing, no review claim)");
});

test("the existing unreviewed wait field keeps working beside the pill", () => {
  const w = { ...wait(null), unreviewed: [{ n: 7, repo: "acme/app", host: "" }] };
  assert.equal(chip([entry()], [w]).unreviewed, true);
});

test("an older live file without review and an older feed without head and merge state behave as today", () => {
  const old = entry();
  delete old.head;
  delete old.mergeState;
  const pr = chip([old], [wait(null)]);
  assert.equal(prStateText(pr), "CI passing");
  assert.equal(prState(pr), "ok");
  const draftOld = feedOnly({ state: "draft", head: undefined, mergeState: undefined });
  assert.equal(prStateText(draftOld), "CI passing");
  assert.equal(prState(chip([old], [wait([review()])])), "unreviewed"); // a fact, but the host's head is unknown: never ready
});

test("sort and summary follow the pill", () => {
  const mk = (number, over) => ({ ...feedOnly(over), number, url: url(number) });
  const prs = [mk(1, { state: "draft" }), mk(2), mk(3, { checks: [{ n: "ci", state: "fail" }] }), mk(4, { checks: [{ n: "ci", state: "pending" }] })];
  assert.deepEqual(sortPrs(prs).map((p) => p.number), [3, 4, 2, 1]);
  assert.equal(prSummary(prs), "4 PRs · 1 failing · 1 pending · 1 in progress");
  assert.equal(prSummary([mk(5), mk(6)]), "2 PRs · all green");
});
