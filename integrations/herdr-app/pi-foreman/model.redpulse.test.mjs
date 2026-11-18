import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, prDotState, prCard, prState, prStateText } from "./model.js";

// A red PR pulses while a job still runs or the checks are not settled; once every job is finished it stands still.
const H1 = "1111111111111111111111111111111111111111";
const entry = (over = {}) => ({ number: 7, repo: "acme/app", title: "t", url: "https://github.com/acme/app/pull/7", state: "open", checks: [{ n: "ci", state: "ok" }], mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "clean", ...over });
const pr = (over) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];
// A PR known only from its session dot (unnamed jobs, no title, no feed twin).
const dotOnly = (checks, over = {}) => ({ number: 7, checks, jobs: checks.map((c) => ({ name: "", state: c.state })), ...over });
const failed = [{ n: "lint", state: "fail" }, { n: "ci", state: "pending" }];
const failedSettled = [{ n: "lint", state: "fail" }, { n: "ci", state: "ok" }];

test("failed + running: red, pulsing, the words say still running, state fail", () => {
  const p = pr({ checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
  assert.equal(prCard(p).state, "#7 · CI failing, still running");
});

test("failed + settled: red and still, CI failing", () => {
  const p = pr({ checks: failedSettled });
  assert.deepEqual(prDotState(p), { pulse: false, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing");
  assert.equal(prCard(p).state, "#7 · CI failing");
});

test("draft + failed + running: red and pulsing, not violet", () => {
  const p = pr({ state: "draft", checks: failed });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
});

test("failed + unsettled with no running job: red and pulsing while unsettled", () => {
  const p = pr({ checks: failedSettled, unsettled: true });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prState(p), "fail");
  assert.equal(prStateText(p), "CI failing, still running");
});

test("failed + unsettled, dot-only: the card status says still running", () => {
  const p = dotOnly(failedSettled, { unsettled: true });
  assert.deepEqual(prDotState(p), { pulse: true, fill: "red", conflict: false });
  assert.equal(prCard(p).status, "checks failed, still running");
});

test("failed + running, dot-only: the card status says still running", () => {
  assert.equal(prCard(dotOnly(failed)).status, "checks failed, still running");
});

test("failed + settled, dot-only: the card status stays checks failed", () => {
  assert.equal(prCard(dotOnly(failedSettled)).status, "checks failed");
});
