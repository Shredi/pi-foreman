// tools.prPhases (prphases.ts): parsing, the union of the rules of one repository, the phase of a check, the gate state, the pure sort of one head and the pr_checks tags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateOf, gatedRepo, mergeLabelOf, parsePhases, phaseOf, phasesStep, ruledRepo, tagChecks, viewOf } from "../prphases.ts";
import type { PhaseRule } from "../prphases.ts";
import type { Run } from "../prwatch.ts";
import { checksLine } from "../reviews.ts";
import { WAKE_KINDS, parseWakeRules, wakes } from "../prwake.ts";

const rules = (raw: unknown): PhaseRule[] => parsePhases(raw).rules;
const run = (name: string, bucket: Run["bucket"], o: Partial<Run> = {}): Run => ({ id: name, name, bucket, url: "u", ...o });

test("parsePhases: a bad rule is dropped with one message, the others apply", () => {
  const r = parsePhases([{ gate: ["a"] }, { gate: "x" }, 5, { nope: 1 }, { repos: [], gate: ["b"] }, { mergeLabel: "a,b" }, { mergeLabel: "-x" }, { gate: ["ok"], ignore: ["i"], mergeLabel: "merge" }]);
  assert.equal(r.rules.length, 2);
  assert.equal(r.errors.length, 6);
  assert.match(r.errors[0], /^tools\.prPhases\[1\]/);
  assert.deepEqual(r.rules[1], { repos: null, gate: ["ok"], ignore: ["i"], mergeLabel: "merge" });
  assert.deepEqual(parsePhases(undefined), { rules: [], errors: [] });
  assert.equal(parsePhases({}).errors.length, 1);
});

test("parsePhases: at most 32 rules", () => {
  const r = parsePhases(Array.from({ length: 40 }, () => ({ gate: ["x"] })));
  assert.equal(r.rules.length, 32);
  assert.equal(r.errors.length, 1);
});

test("repository globs are over the lowercased owner/name and the rule's default is every repository", () => {
  const rs = rules([{ repos: ["Acme/*"], gate: ["g"] }, { repos: ["other/app"], gate: ["h"] }]);
  assert.deepEqual(viewOf(rs, "ACME/Widgets").gate, ["g"]);
  assert.deepEqual(viewOf(rs, "other/app").gate, ["h"]);
  assert.equal(ruledRepo(rs, "x/y"), false);
  assert.equal(ruledRepo(rules([{ ignore: ["i"] }]), "x/y"), true);
});

test("rules add up (union), ignore wins over gate, the last merge label wins", () => {
  const rs = rules([{ gate: ["ci/gate"], mergeLabel: "first" }, { repos: ["acme/*"], gate: ["ci/*"], ignore: ["ci/gate", "review-*"] }, { repos: ["acme/*"], mergeLabel: "last" }, { repos: ["acme/*"] }]);
  const v = viewOf(rs, "acme/app");
  assert.deepEqual(v.gate, ["ci/gate", "ci/*"]);
  assert.deepEqual(v.ignore, ["ci/gate", "review-*"]);
  assert.equal(v.mergeLabel, "last");
  assert.equal(phaseOf(rs, "acme/app", { name: "ci/gate" }), "ignore");
  assert.equal(phaseOf(rs, "acme/app", { name: "ci/other" }), 2);
  assert.equal(phaseOf(rs, "acme/app", { name: "build" }), 1);
  assert.equal(mergeLabelOf(rs, "elsewhere/x"), "first");
});

test("check names match case-insensitively, by the run's name or its raw name; a source check is `<source>/<name>`", () => {
  const rs = rules([{ gate: ["CI/Gate", "deploy"], ignore: ["lint"] }]);
  assert.equal(phaseOf(rs, "a/b", { name: "ci/gate" }), 2);
  assert.equal(phaseOf(rs, "a/b", { name: "ext/deploy", source: "ext" }), 2, "the raw name without the source prefix");
  assert.equal(phaseOf(rs, "a/b", { name: "ext/lint", source: "ext" }), "ignore");
  assert.equal(phaseOf(rs, "a/b", { name: "ext/deploy" }), 1, "no source: the whole name only");
  assert.equal(phaseOf(rules([{ gate: ["ext/*"] }]), "a/b", { name: "ext/x", source: "ext" }), 2, "or the prefixed name");
});

test("gated: a gate list or a merge label; ignore alone is ruled but not gated", () => {
  assert.equal(gatedRepo(rules([{ gate: ["g"] }]), "a/b"), true);
  assert.equal(gatedRepo(rules([{ mergeLabel: "m" }]), "a/b"), true);
  assert.equal(gatedRepo(rules([{ ignore: ["i"] }]), "a/b"), false);
  assert.equal(ruledRepo(rules([{ ignore: ["i"] }]), "a/b"), true);
  assert.equal(gatedRepo(rules([{ repos: ["x/*"], gate: ["g"] }]), "a/b"), false);
});

test("gateOf: running beats failed beats waiting beats passed; nothing is absent", () => {
  assert.equal(gateOf([]), undefined);
  assert.equal(gateOf([{ bucket: "passed" }]), undefined, "a phase-1 run is no gate run");
  assert.deepEqual(gateOf([{ bucket: "pending", phase: 2 }, { bucket: "failed", phase: 2 }]), { state: "running" });
  assert.deepEqual(gateOf([{ bucket: "failed", phase: 2 }], ["x"]), { state: "failed", waiting: ["x"] });
  assert.deepEqual(gateOf([], ["x"]), { state: "waiting", waiting: ["x"] });
  assert.deepEqual(gateOf([{ bucket: "passed", phase: 2 }]), { state: "passed" });
  assert.equal(gateOf([{ bucket: "passed", phase: "ignore" }]), undefined);
});

test("phasesStep: no matching rule gives the input back; a rule tags the runs, filters required and finds the gate names with no run", () => {
  const runs = [run("build", "passed"), run("ci/gate", "pending"), run("review", "failed")];
  assert.deepEqual(phasesStep([], "a/b", runs, ["build"]), { runs, required: ["build"] });
  const rs = rules([{ gate: ["ci/gate", "deploy"], ignore: ["review"] }]);
  const s = phasesStep(rs, "a/b", runs, ["build", "ci/gate", "deploy", "review"]);
  assert.deepEqual(s.runs.map((r) => [r.name, r.phase, r.gates]), [["build", undefined, undefined], ["ci/gate", 2, false], ["review", "ignore", false]]);
  assert.deepEqual(s.required, ["build"]);
  assert.deepEqual(s.gate, { state: "running", waiting: ["deploy"] });
  assert.equal(s.gated, true);
  assert.equal(s.ruled, true);
  const again = phasesStep(rs, "a/b", s.runs, ["build", "ci/gate", "deploy", "review"]);
  assert.deepEqual(again, s, "idempotent on its own output");
  const noReq = phasesStep(rs, "a/b", runs);
  assert.equal("required" in noReq, false);
  assert.equal("required" in phasesStep(rs, "a/b", runs, null) && phasesStep(rs, "a/b", runs, null).required, null);
  assert.equal(phasesStep(rules([{ ignore: ["review"] }]), "a/b", runs).gated, undefined);
});

test("tagChecks: gate and not-counted checks are tagged, the summary counts phase 1 only, unknown repository leaves the answer and says so", () => {
  const res = { action: "pr_checks", pending: [{ name: "ci/gate" }], failed: [{ name: "review" }, { name: "lint" }], passed: [{ name: "build" }], summary: "1 passed, 2 failed (review, lint), 1 pending", required: false };
  const rs = rules([{ gate: ["ci/gate"], ignore: ["review"] }]);
  const out = tagChecks(rs, "acme/app", res) as typeof res & { pending: { phase?: string }[]; failed: { phase?: string; name: string }[] };
  assert.equal(out.pending[0].phase, "gate");
  assert.deepEqual((out.failed as { phase?: string }[]).map((e) => e.phase), ["not counted", undefined]);
  assert.equal(out.summary, "1 passed, 1 failed (lint), 0 pending");
  assert.equal(tagChecks([], "acme/app", res), res);
  const scoped = rules([{ repos: ["acme/*"], gate: ["ci/gate"], ignore: ["review"] }]);
  assert.equal(tagChecks(scoped, "elsewhere/x", { ...res }).summary, res.summary, "no rule matches this repository: unchanged");
  const unknown = tagChecks(rs, null, res);
  assert.equal(unknown.phases, "repository unknown");
  assert.deepEqual(unknown.failed, res.failed);
  const only = tagChecks(rs, "acme/app", { ...res, failed: [{ name: "review" }], pending: [], passed: [] });
  assert.equal(only.summary, "no checks reported");
});

test("checksLine (the review panel): a not-counted or gate failure never makes the line", () => {
  assert.equal(checksLine({ failed: [{ name: "review", phase: "not counted" }, { name: "g", phase: "gate" }], pending: [], summary: "3 passed, 0 failed, 0 pending" }), "");
  assert.match(checksLine({ failed: [{ name: "review", phase: "not counted" }, { name: "lint" }], pending: [], summary: "x" }), /^PR checks:/);
});

test("wake: gate_failed and gate_settled are wake kinds, they wake by default for GitHub and for a source rule, and a `checks` glob applies to gate_failed", () => {
  assert.ok(WAKE_KINDS.includes("gate_failed") && WAKE_KINDS.includes("gate_settled"));
  const { rules: wr } = parseWakeRules(undefined);
  for (const kind of ["gate_failed", "gate_settled"] as const) {
    assert.equal(wakes(wr, { kind, source: "github", repo: "a/b" }), true);
    assert.equal(wakes(wr, { kind, source: "ci", repo: "a/b" }), true);
  }
  const quiet = parseWakeRules([{ events: ["gate_failed"], checks: ["flaky-*"], wake: false }]).rules;
  assert.equal(wakes(quiet, { kind: "gate_failed", source: "github", repo: "a/b", check: "flaky-x" }), false);
  assert.equal(wakes(quiet, { kind: "gate_failed", source: "github", repo: "a/b", check: "deploy" }), true);
  assert.equal(parseWakeRules([{ events: ["nope"], wake: true }]).errors.length, 1);
});
