// Ceremony gate (plan D1, D2): trivial bound tally and the required steps before finish. Temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addChange, changedLines, emptySteps, emptyTally, finishRefusal, missingSteps, overBound, pendingChange, readBound, requiredSteps, stepsOfRunEnd } from "../bound.ts";
import { escalate, initialCeremony } from "../ceremony.ts";
import { recordLaunchRoles } from "../actions.ts";
import { foremanTriage } from "../triage.ts";

test("changedLines counts added + removed lines like numstat", () => {
  assert.equal(changedLines("", ""), 0);
  assert.equal(changedLines("a\nb\nc\n", "a\nB\nc\n"), 2);
  assert.equal(changedLines("", "x\ny\n"), 2);
  assert.equal(changedLines("a\nb\n", "a\nb\nc\n"), 1);
  assert.equal(changedLines("a\nb\nc\nd\n", "b\nc\nd\ne\n"), 2);
});

test("pendingChange: edit, write (new and existing), copy; the bound is checked on the tally with the pending call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bound-"));
  const abs = (raw: unknown) => (typeof raw === "string" ? path.resolve(dir, raw) : null);
  const a = path.join(dir, "a.txt");
  fs.writeFileSync(a, "one\ntwo\n");
  const all = new Set([a, path.join(dir, "b.txt"), path.join(dir, "c.txt")]);
  const edit = pendingChange("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "uno" }, { oldText: "two", newText: "dos\ntres" }] }, all, abs);
  assert.deepEqual(edit, { files: [a], lines: 5, newFiles: 0 });
  const write = pendingChange("write", { path: "a.txt", content: "one\ntwo\nthree\n" }, all, abs);
  assert.deepEqual(write, { files: [a], lines: 1, newFiles: 0 });
  const created = pendingChange("write", { path: "b.txt", content: "x\n" }, all, abs);
  assert.equal(created.newFiles, 1);
  const copy = pendingChange("foreman_copy", { src: "a.txt", dst: "c.txt" }, all, abs);
  assert.deepEqual(copy, { files: [path.join(dir, "c.txt")], lines: 2, newFiles: 1 });
  assert.deepEqual(pendingChange("edit", { path: ".workflow/x.md", oldText: "a", newText: "b" }, all, abs), emptyTally(), "only the given project targets count");
  const bound = readBound({ files: 2, lines: 40, newFiles: 0 });
  const t = addChange(addChange(emptyTally(), edit), write);
  assert.deepEqual(t, { files: [a], lines: 6, newFiles: 0 });
  assert.equal(overBound(t, bound), false);
  assert.equal(overBound(addChange(t, created), bound), true, "a new file at trivial crosses the default bound");
  assert.equal(overBound(addChange(t, { files: [], lines: 35, newFiles: 0 }), bound), true);
  assert.deepEqual(readBound({ files: "x" }), { files: 2, lines: 40, newFiles: 0 });
});

test("a bound escalation is automatic and foreman_triage still cannot lower it", () => {
  const t = foremanTriage(initialCeremony("standard"), "trivial", "typo");
  assert.ok("state" in t);
  const up = escalate(t.state, "standard", "auto", "trivial bound crossed");
  assert.equal(up.tier, "standard");
  const low = foremanTriage(up, "trivial", "still small");
  assert.ok("error" in low && /never lowers/.test(low.error));
});

test("required steps: list per tier, counted from run-end events; failed or timed-out builders do not count", () => {
  const req = { standard: ["builder", "reviewer"], heavy: ["builder", "reviewer", "finalizer", "bogus"] };
  assert.deepEqual(requiredSteps(req, "trivial"), []);
  assert.deepEqual(requiredSteps(req, "heavy"), ["builder", "reviewer", "finalizer"]);
  assert.deepEqual(stepsOfRunEnd({ runId: "r", agent: "builder", success: true }), ["builder"]);
  assert.deepEqual(stepsOfRunEnd({ runId: "r", agent: "builder", success: false, timedOut: true }), []);
  assert.deepEqual(stepsOfRunEnd({ runId: "r", results: [{ agent: "builder", status: "failed", success: false, error: "Subagent timed out." }] }), []);
  assert.deepEqual(
    stepsOfRunEnd({ runId: "r", results: [{ agent: "builder", status: "completed", success: true }, { agent: "senior-reviewer", status: "completed", success: true, output: "Verdict: APPROVE" }, { agent: "finalizer", status: "completed" }] }),
    ["builder", "reviewer", "finalizer"],
  );
  assert.deepEqual(stepsOfRunEnd({ runId: "r", agent: "reviewer", success: true, summary: "looked at it" }), [], "a review without a verdict does not count");
  const counts = emptySteps();
  counts.builder++;
  assert.deepEqual(missingSteps(counts, requiredSteps(req, "standard")), ["reviewer"]);
  assert.match(finishRefusal("standard", ["reviewer"]), /finish refused: tier standard requires reviewer; launch them or ask the owner to lower the tier with \/ceremony/);
});

test("launch recording covers chain and tasks launches and resumes", () => {
  const m = new Map<string, string[]>();
  recordLaunchRoles(m, { chain: [{ agent: "builder", task: "x" }, { parallel: [{ agent: "reviewer" }, { agent: "senior-reviewer" }] }] }, { runId: "c1" }, false);
  recordLaunchRoles(m, { tasks: [{ agent: "finalizer", task: "y" }] }, { asyncId: "t1" }, false);
  recordLaunchRoles(m, { agent: "builder", task: "z" }, { runId: "s1" }, true);
  recordLaunchRoles(m, { action: "resume", runId: "c1" }, { runId: "c2" }, false);
  recordLaunchRoles(m, { action: "status", runId: "c1" }, { runId: "c3" }, false);
  assert.deepEqual([...m.entries()], [["c1", ["builder", "reviewer", "senior-reviewer"]], ["t1", ["finalizer"]], ["c2", ["builder", "reviewer", "senior-reviewer"]]]);
});
