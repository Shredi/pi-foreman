import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, enrichPrs, prDotState, prStateText, prGateText, prCard } from "./model.js";

// The tracker's phases (tools.prPhases): the dot, pill and counts read phase-1 checks only; the gate state is text; the card groups Gate and Not counted.
const H1 = "1111111111111111111111111111111111111111";
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const entry = (over = {}) => ({
  number: 7, repo: "acme/app", title: "t", url: url(7), state: "open", author: "me", mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "clean",
  checks: [{ n: "ci", state: "ok", label: "ci" }], ...over,
});
const feedOnly = (over) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];
const gateRun = (state) => ({ n: "ci/gate", state, label: "gate", phase: 2 });
const names = (c, key) => c.groups.find((g) => g.key === key)?.names ?? null;
const READY = { pulse: false, fill: "green", mark: "check", conflict: false };

test("gate failed with phase 1 green: green ready dot, text gate failed", () => {
  const pr = feedOnly({ checks: [{ n: "ci", state: "ok", label: "ci" }, gateRun("fail")], gate: { state: "failed" }, gated: true });
  assert.deepEqual(prDotState(pr), READY);
  assert.equal(prGateText(pr), "gate failed");
  const c = prCard(pr);
  assert.match(c.state, /gate failed$/);
  assert.equal(c.gate.tone, "red");
  assert.deepEqual(c.counts, { failed: 0, running: 0, passed: 1 });
  assert.deepEqual(names(c, "gate"), ["ci/gate (failed)"]);
});

test("a not-counted failing check keeps the PR green; the card lists it under Not counted", () => {
  const pr = feedOnly({ checks: [{ n: "ci", state: "ok", label: "ci" }, { n: "review-assign", state: "fail", label: "r", phase: "ignore" }], ruled: true });
  assert.deepEqual(prDotState(pr), READY);
  const c = prCard(pr);
  assert.equal(c.groups.find((g) => g.key === "ignored").label, "Not counted");
  assert.deepEqual(names(c, "ignored"), ["review-assign (failed)"]);
  assert.equal(names(c, "failed"), null);
  assert.equal(c.gate, undefined);
});

test("search-feed entry with a gate: text from gate.state, Gate group", () => {
  for (const state of ["waiting", "running", "failed", "passed"]) {
    const pr = feedOnly({ gate: { state, ...(state === "waiting" ? { waiting: ["ci/gate"] } : {}) }, gated: true });
    assert.equal(prGateText(pr), `gate ${state}`);
  }
  assert.equal(prGateText(feedOnly({ gate: { state: "bogus" } })), "");
  assert.equal(prGateText(feedOnly()), "");
  assert.deepEqual(names(prCard(feedOnly({ checks: [gateRun("run")], gate: { state: "running" } })), "gate"), ["ci/gate (running)"]);
});

test("gated + merge state blocked is the ready pill; ungated blocked is waiting", () => {
  assert.deepEqual(prDotState(feedOnly({ mergeState: "blocked", gated: true })), READY);
  assert.equal(prStateText(feedOnly({ mergeState: "blocked", gated: true })), "ready to merge (CI passing, no review claim)");
  assert.deepEqual(prDotState(feedOnly({ mergeState: "blocked" })), { pulse: false, fill: "amber", conflict: false });
  assert.equal(prStateText(feedOnly({ mergeState: "blocked" })), "CI passing, merge blocked");
  assert.deepEqual(prDotState(feedOnly({ mergeState: "behind", gated: true })), { pulse: false, fill: "amber", conflict: false });
});

test("gated head with only gate runs: no ready mark", () => {
  const pr = feedOnly({ checks: [gateRun("ok")], gate: { state: "passed" }, gated: true, mergeState: "blocked" });
  assert.notEqual(prDotState(pr).mark, "check");
  assert.equal(prDotState(pr).fill, "dim");
});

test("enrichPrs fills gate and gated from the feed twin", () => {
  const twin = feedOnly({ gate: { state: "running" }, gated: true });
  const [out] = enrichPrs([{ number: 7, repo: "acme/app", url: url(7), checks: [], jobs: [] }], [twin]);
  assert.deepEqual(out.gate, { state: "running" });
  assert.equal(out.gated, true);
});
