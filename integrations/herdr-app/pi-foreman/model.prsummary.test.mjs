import test from "node:test";
import assert from "node:assert/strict";
import { prSummary, prState, enrichPrs, prDotState } from "./model.js";

const pr = (number, checks, extra = {}) => ({ number, checks, ...extra });

test("a failing chip gives 1 failing, not all green", () => {
  assert.equal(prSummary([pr(66, ["fail", "ok"]), pr(67, ["ok"])]), "2 PRs · 1 failing");
});

test("a merged or closed PR is not counted", () => {
  assert.equal(prSummary([pr(66, ["ok"]), pr(56, [], { state: "merged" }), pr(55, ["fail"], { state: "closed" })]), "1 PR · all green");
  assert.equal(prSummary([pr(56, [], { state: "merged" })]), "");
});

test("a pending chip counts as pending, also next to passed jobs", () => {
  assert.equal(prSummary([pr(1, ["run"]), pr(2, ["ok", "run"]), pr(3, ["ok"])]), "3 PRs · 2 pending");
});

test("all green only when every counted chip is green", () => {
  assert.equal(prSummary([pr(1, ["ok"]), pr(2, ["ok", "ok"])]), "2 PRs · all green");
});

test("the summary state is the chip's: prState follows prDotState", () => {
  for (const checks of [["fail"], ["ok", "run"], ["run"], ["ok"], []]) {
    const d = prDotState(pr(1, checks));
    const want = d.fill === "red" ? "fail" : d.ring || d.fill === "amber" ? "pending" : d.fill === "green" ? "ok" : "none";
    assert.equal(prState(pr(1, checks)), want);
  }
});

test("a PR whose checks and state come from its feed twin is summed as drawn", () => {
  const bare = [{ number: 66, url: "https://github.com/o/r/pull/66" }, { number: 56, url: "https://github.com/o/r/pull/56" }];
  const feed = [
    { number: 66, url: "https://github.com/o/r/pull/66", checks: ["fail"], jobs: [{ name: "ci", state: "fail" }] },
    { number: 56, url: "https://github.com/o/r/pull/56", state: "merged" },
  ];
  assert.equal(prSummary(bare), "2 PRs · all green"); // unenriched: the old mismatch
  assert.equal(prSummary(enrichPrs(bare, feed)), "1 PR · 1 failing");
});
