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
// A PR known only from its session dot (unnamed jobs, no title): the card names the checks in its status line.
const dotOnly = (checks, over = {}) => ({ number: 7, checks, jobs: checks.map((c) => ({ name: "", state: c.state })), ...over });

test("draft + running: a violet pulse, the state reads wip, the words say CI running", () => {
  const p = pr({ state: "draft", checks: pending });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress, CI running");
  assert.equal(prCard(dotOnly(pending, { state: "draft", head: H1 })).status, "checks running");
});

test("draft + unsettled: the same violet pulse", () => {
  const p = pr({ state: "draft", checks: passed, unsettled: true });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress, CI running");
});

test("draft + failed with a job running: red and pulsing like any failed PR", () => {
  const p = pr({ state: "draft", checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
  assert.equal(prCard(dotOnly(failed, { state: "draft", head: H1 })).status, "checks failed, still running");
});

test("draft settled: violet and still", () => {
  const p = pr({ state: "draft", checks: passed });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "violet", conflict: false });
  assert.equal(prState(p), "wip");
  assert.equal(prStateText(p), "work in progress");
});

test("running: amber pulse, pending", () => {
  const p = pr({ checks: pending });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI running");
  assert.equal(prCard(dotOnly(pending)).status, "checks running");
});

test("unsettled: amber pulse even with every passed check shown", () => {
  const p = pr({ checks: passed, unsettled: true });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI running");
});

test("failed: red, pulsing while a job runs, still once settled", () => {
  const p = pr({ checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
  assert.equal(prCard(dotOnly(failed)).status, "checks failed, still running");
});

test("passed: green and still, ready to merge", () => {
  const p = pr({ checks: passed });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "green", mark: "check", conflict: false });
  assert.equal(prState(p), "ok");
  assert.equal(prCard(dotOnly(passed)).status, "checks passed");
});

test("merge blocked with every check passed: a still amber dot, the state pending", () => {
  const p = pr({ checks: passed, mergeState: "blocked" });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prState(p), "pending");
  assert.equal(prStateText(p), "CI passing, merge blocked");
});

const partly = [{ n: "lint", state: "ok" }, { n: "ci", state: "pending" }];

test("partly passed, partly running: amber pulse, never green (clean, blocked, untracked)", () => {
  for (const over of [{ mergeState: "clean" }, { mergeState: "blocked" }, { head: undefined, mergeState: undefined }]) {
    const p = pr({ checks: partly, ...over });
    assert.deepEqual(prDotState(p), { pulse: true, fill: "amber", conflict: false });
    assert.equal(prState(p), "pending");
    assert.equal(prStateText(p), "CI running");
  }
});

test("draft partly passed, partly running: violet pulse; with a failure: red, pulsing while the job runs", () => {
  assert.deepEqual(prDotState(pr({ state: "draft", checks: partly })), { pulse: true, fill: "violet", conflict: false });
  const failing = pr({ checks: [...partly, { n: "lint2", state: "fail" }] });
  assert.deepEqual(prDotState(failing), { pulse: true, fill: "red", conflict: false });
});

test("a running draft counts, sorts and summarises as a draft", () => {
  const running = pr({ state: "draft", checks: pending });
  const settled = pr({ state: "draft", checks: passed });
  assert.equal(prState(running), prState(settled));
  assert.equal(prSummary([running]), prSummary([settled]));
  const failing = pr({ number: 8, checks: failed });
  assert.equal(prState(failing), "fail");
  assert.deepEqual(sortPrs([running, failing]).map((p) => p.number), [8, 7]);
});
