import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, prDotState, prState, prStateText, prCard, prSummary, sortPrs } from "./model.js";

// One open PR of the feed as radar gives it, with its host head and merge state (a clean PR unless `over` says otherwise).
const H1 = "1111111111111111111111111111111111111111";
const entry = (over = {}) => ({ number: 7, repo: "acme/app", title: "t", url: `https://github.com/acme/app/pull/${over.number ?? 7}`, state: "open", checks: [{ n: "ci", state: "ok" }], mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "clean", ...over });
const pr = (over) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];
const pending = [{ n: "ci", state: "pending" }];
const failed = [{ n: "lint", state: "fail" }, { n: "ci", state: "pending" }];
const passed = [{ n: "ci", state: "ok" }];
// A PR known only from its session dot (unnamed jobs, no title, no head, merge state or review fact).
const dotOnly = (checks, over = {}) => ({ number: 7, checks, jobs: checks.map((c) => ({ name: "", state: c.state })), ...over });

test("blocked with every check passed: a still amber dot, the words say merge blocked", () => {
  const p = pr({ mergeState: "blocked" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI passing, merge blocked");
  assert.equal(prCard(p).state, "#7 · CI passing, merge blocked");
});

test("behind with every check passed: a still amber dot, the words say branch behind", () => {
  const p = pr({ mergeState: "behind" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI passing, branch behind");
  assert.equal(prCard(p).state, "#7 · CI passing, branch behind");
});

test("blocked with a running check: still pulses and says CI running", () => {
  const p = pr({ mergeState: "blocked", checks: pending });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI running");
});

test("blocked with unsettled checks: still pulses and says CI running", () => {
  const p = pr({ mergeState: "blocked", checks: passed, unsettled: true });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI running");
});

test("blocked with a failed check and a check running: red and pulsing, CI failing, still running", () => {
  const p = pr({ mergeState: "blocked", checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
});

test("failed draft, tracked: red and still, CI failing, state fail", () => {
  const p = pr({ state: "draft", checks: [{ n: "ci", state: "fail" }] });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing");
  assert.equal(prCard(p).state, "#7 · CI failing");
});

test("failed draft, dot-only (no head, merge state or review fact): red and still, checks failed", () => {
  const p = dotOnly([{ n: "ci", state: "fail" }], { state: "draft" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing");
  assert.equal(prCard(p).status, "checks failed");
});

test("failed draft with a check still running: red and pulsing, CI failing, still running", () => {
  const p = pr({ state: "draft", checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
});

test("passed draft: violet and still, work in progress", () => {
  const p = pr({ state: "draft", checks: passed });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress");
});

test("running draft: violet pulse, work in progress, CI running", () => {
  const p = pr({ state: "draft", checks: pending });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress, CI running");
});

test("a failed draft counts, sorts and is urgent like any failed PR", () => {
  const draft = pr({ number: 1, state: "draft", checks: [{ n: "ci", state: "fail" }] });
  const plain = pr({ number: 2, checks: [{ n: "ci", state: "fail" }] });
  const ok = pr({ number: 3 });
  const waiting = pr({ number: 4, mergeState: "blocked" });
  const list = [ok, waiting, draft, plain];
  assert.deepEqual(sortPrs(list).map((p) => p.number), [2, 1, 4, 3], "failed first (newest first), then pending, then green");
  assert.equal(prSummary([draft, ok]), "2 PRs · 1 failing");
  assert.equal(prSummary(list), "4 PRs · 2 failing · 1 pending");
});

test("a blocked PR with passed checks counts as pending and sorts with the pending ones", () => {
  const waiting = pr({ number: 4, mergeState: "behind" });
  const running = pr({ number: 5, checks: pending });
  const ok = pr({ number: 6 });
  assert.deepEqual(sortPrs([ok, waiting, running]).map((p) => p.number), [5, 4, 6]);
  assert.equal(prSummary([waiting]), "1 PR · 1 pending");
  assert.equal(prSummary([waiting, ok]), "2 PRs · 1 pending");
});

// A PR the session opened with no checks confirmed for the head, and the session's review fact for that head.
const noChecksPr = (over) => ({ ...pr({ checks: [], ...over }), review: { state: "ok", head: H1, noChecks: true } });

test("no checks confirmed, blocked: a still amber dot, the words say no CI checks, merge blocked", () => {
  const p = noChecksPr({ mergeState: "blocked" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "no CI checks, merge blocked");
  assert.equal(prCard(p).state, "#7 · no CI checks, merge blocked");
  assert.equal(prSummary([p]), "1 PR · 1 pending");
});

test("no checks confirmed, behind: a still amber dot, the words say no CI checks, branch behind", () => {
  const p = noChecksPr({ mergeState: "behind" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "no CI checks, branch behind");
  assert.equal(prCard(p).state, "#7 · no CI checks, branch behind");
  assert.equal(prSummary([p]), "1 PR · 1 pending");
});

// Work in progress by the session's review fact, not a host draft.
const wipFact = (checks) => ({ ...pr({ checks }), review: { state: "wip", head: H1 } });

test("work in progress by the review fact with a failed check: red and still, CI failing", () => {
  const p = wipFact([{ n: "ci", state: "fail" }]);
  assert.deepEqual(prDotState(p), { pulse: false, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing");
});

test("work in progress by the review fact with running checks: violet pulse", () => {
  const p = wipFact(pending);
  assert.deepEqual(prDotState(p), { pulse: true, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress, CI running");
});
