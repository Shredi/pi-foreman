import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewFacts } from "../diffscan.ts";
import { reviewResultsOfRunEnd } from "../occasion.ts";
import { PlanReviews, planFactsBlock, planPathsOf, planReviewHash, planReviewOn, planReviewRefusalText, planReviewResults, planReviewSection, type PlanVerdict } from "../planreview.ts";
import { applyReviewModelRule } from "../reviewerclimb.ts";
import { sanitizeTrace } from "../trace.ts";

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../config/foreman.defaults.json"), "utf8"));
const P = "/ws/.workflow/scratch/plan-x.md";
const A = planReviewHash(Buffer.from("# Plan A\n"));
const B = planReviewHash(Buffer.from("# Plan B\n"));
const C = planReviewHash(Buffer.from("# Plan C\n"));
const v = (hash: string, verdict: "pass" | "fail", findings: PlanVerdict["findings"] = Promise.resolve([])): PlanVerdict => ({ hash, verdict, model: "p/m-sonnet", findings });

test("plan review: heavy only by default; another tier keeps the old checkpoint", () => {
  assert.deepEqual(["trivial", "standard", "heavy"].map((t) => planReviewOn(DEFAULTS, t)), [false, false, true]);
  assert.equal(planReviewOn({}, "heavy"), false);
});

test("plan review: plan_review_required until a verdict exists for the plan's sha1", () => {
  assert.match(A, /^[0-9a-f]{40}$/);
  const r = new PlanReviews();
  assert.deepEqual(r.gate(P, A), { refusal: "plan_review_required", stale: false });
  const text = planReviewRefusalText("plan_review_required", ".workflow/scratch/plan-x.md", "heavy", false);
  assert.match(text, /foreman_checkpoint refused \[plan_review_required\]: .*"\[plan-review\]".*plan-x\.md and the ledger/);
  r.record(P, v(A, "pass"));
  assert.ok("verdict" in r.gate(P, A));
});

test("plan review: an edit changes the hash, so the earlier verdict no longer counts", () => {
  const r = new PlanReviews();
  r.record(P, v(A, "pass"));
  assert.deepEqual(r.gate(P, B), { refusal: "plan_review_required", stale: true });
  assert.match(planReviewRefusalText("plan_review_required", "plan-x.md", "heavy", true), /changed since its last review/);
  assert.deepEqual(r.gate("/ws/.workflow/scratch/plan-y.md", A), { refusal: "plan_review_required", stale: false }, "another plan path is another lineage");
});

test("plan review: a FAIL needs one revision; the re-review of a new hash opens even on FAIL", () => {
  const r = new PlanReviews();
  r.record(P, v(A, "fail"));
  assert.deepEqual(r.gate(P, A), { refusal: "plan_revision_required", stale: false });
  assert.match(planReviewRefusalText("plan_revision_required", "plan-x.md", "heavy", false), /\[plan_revision_required\]: .*back to the planner once/);
  assert.deepEqual(r.gate(P, B), { refusal: "plan_review_required", stale: true }, "revised but not re-reviewed yet");
  r.record(P, v(B, "fail"));
  const g = r.gate(P, B);
  assert.ok("verdict" in g && g.verdict.verdict === "fail");
  r.record(P, v(C, "fail"));
  assert.ok("verdict" in r.gate(P, C), "the revision is spent for this lineage");
});

test("plan review: the dialog section names the verdict, the reviewer model and at most 8 findings", () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ file: "plan-x.md", line: i + 1, class: "missing-item", note: `item ${i} not covered` }));
  const s = planReviewSection(v(A, "fail"), findings);
  const lines = s.split("\n");
  assert.equal(lines[0], "Plan review: FAIL (reviewer p/m-sonnet)");
  assert.equal(lines[1], "  plan-x.md:1 missing-item item 0 not covered");
  assert.equal(lines.length, 10);
  assert.equal(lines[9], "  (+2 more findings)");
  assert.equal(planReviewSection(v(A, "pass"), []), "Plan review: PASS (reviewer p/m-sonnet)\n  (no located findings)");
});

test("plan review: run-end results and the plan_review trace", () => {
  const launch = { entries: [{ role: "reviewer", occasion: "plan-review" as const, model: "p/m-sonnet", shadow: null }], started: 0, files: [], panel: null };
  const res = reviewResultsOfRunEnd({ runId: "r1", agent: "reviewer", status: "completed", success: true, output: "Verdict: FAIL\n1. FAIL plan-x.md:3 order" }, launch);
  const pr = planReviewResults(res);
  assert.deepEqual(pr.map((r) => [r.verdict, r.model, r.counts]), [["fail", "p/m-sonnet", false]]);
  assert.deepEqual(planReviewResults(reviewResultsOfRunEnd({ agent: "reviewer", status: "completed", success: true, output: "Verdict: PASS" })), [], "an item review is no plan review");
  assert.deepEqual(sanitizeTrace({ event: "plan_review", model: "p/m-sonnet", decision: "fail" }), { event: "plan_review", model: "p/m-sonnet", decision: "fail" });
  assert.deepEqual(planPathsOf(["plan-x.md", ".workflow/scratch/plan-y.md", "LEDGER-a.md"], ".workflow/scratch"), [path.join(".workflow/scratch", "plan-x.md"), ".workflow/scratch/plan-y.md"]);
});

test("plan review: the reviewer launch moves off the foreman's model (different-model rule)", () => {
  const roles = { foreman: { model: "p/m-opus" }, reviewer: { model: "p/m-opus", strong: { model: "p/m-sonnet" } } };
  const entry: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-x.md against the ledger", model: "p/m-opus:high" };
  const t = applyReviewModelRule(entry, roles, { config: {}, foreman: "p/m-opus", maxThinking: "medium", childMaxThinking: undefined });
  assert.deepEqual(t.map((r) => [r.from, r.to, r.reason]), [["p/m-opus", "p/m-sonnet", "same_as_foreman"]]);
  assert.notEqual(String(entry.model).split(":")[0], "p/m-opus");
});

test("plan review: the facts block carries the plan path and the open ledger items, no diff", async () => {
  const ledger = "# L\n- [x] 1. done item\n- [ ] 2. open item\n- [ ] 3. another\n";
  const block = planFactsBlock([".workflow/scratch/plan-x.md"], "LEDGER-a.md", ledger);
  assert.match(block, /Plan: \.workflow\/scratch\/plan-x\.md\nLedger: LEDGER-a\.md\n/);
  assert.match(block, /- \[ \] 2\. open item\n- \[ \] 3\. another$/);
  assert.doesNotMatch(block, /done item/);
  const input = { agent: "reviewer", task: "[plan-review] plan-x.md" };
  await new ReviewFacts().augment(input, process.cwd(), (task) => (task.includes("[plan-review]") ? block : null));
  assert.ok(input.task.startsWith(`[plan-review] plan-x.md\n${block}\n`), input.task);
  assert.match(input.task, /## Owner task text/);
  assert.doesNotMatch(input.task, /diff --git/);
});
