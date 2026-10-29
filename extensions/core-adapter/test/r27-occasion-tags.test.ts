// R27 item 3: occasion tags count only as standalone tokens (a mention in backticks, a fence or a harness line is not an occasion);
// the V refusal and the finish hint name the last counted PASS run; the reviewer's role_launch trace carries the occasion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { occasionOf } from "../occasion.ts";
import { initialReviewGate, onReviewVerdicts, onRevision, reviewHint } from "../bound.ts";
import { planLedgerCall } from "../ledgercall.ts";
import { r11Rig as baseRig, reviewAllowOpts } from "./_r11rig.ts";

const r11Rig = (t: Parameters<typeof baseRig>[0], ceremony: Record<string, unknown> = {}) => baseRig(t, ceremony, reviewAllowOpts());

test("occasionOf: the efc47f12 brief sentence mentions the tags in backticks: an item", () => {
  assert.equal(occasionOf("skipped for `[pre-pr]`, `[second-opinion]`, `[plan-review]` via `occasionOf`"), "item");
  assert.equal(occasionOf("review `[second-opinion]` wording"), "item");
});

test("occasionOf: a tag standing at the start of the task names its occasion", () => {
  assert.equal(occasionOf("[second-opinion] review the diff"), "second-opinion");
  assert.equal(occasionOf("review the branch\n[pre-pr] whole diff"), "pre-pr");
  assert.equal(occasionOf("(see the plan) [plan-review] check it"), "plan-review");
});

test("occasionOf: a tag in a fenced block or a [pi-foreman ...] harness line is not an occasion", () => {
  assert.equal(occasionOf("```\n[second-opinion]\n```\nreview items 1"), "item");
  assert.equal(occasionOf("[pi-foreman re-review] Review the revision diff since abc [pre-pr]\nreview items 1"), "item");
});

test("occasionOf: reason second-opinion still wins over a tag of another occasion", () => {
  assert.equal(occasionOf("[pre-pr] whole branch", "second-opinion"), "second-opinion");
  assert.equal(occasionOf("[plan-review] the plan", "second-opinion"), "second-opinion");
});

test("the V refusal and the finish hint name the last counted PASS run, or say there is none", () => {
  const passed = onRevision(onReviewVerdicts(initialReviewGate(), ["pass"], 1, "run-pass-1"));
  // a later FAIL keeps the last counted PASS named
  const failed = onReviewVerdicts(passed, ["fail"], 2, "run-fail-2");
  const refusal = planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate: failed });
  assert.ok("error" in refusal && refusal.error.includes("last counted PASS: run run-pass-1"), JSON.stringify(refusal));
  assert.equal(reviewHint(onRevision(onReviewVerdicts(initialReviewGate(), ["pass"], 1, "run-p"))), "(re-review needed: revised after the last PASS) (run run-p)");
  const none = planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate: initialReviewGate() });
  assert.ok("error" in none && none.error.includes("no counted PASS this round"), JSON.stringify(none));
});

test("role_launch of a reviewer traces its occasion; a plain review traces item", async (t) => {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const second = { agent: "reviewer", task: "[second-opinion] look at the branch" };
  assert.equal((await a.launch(second)).res, undefined);
  const plain = { agent: "reviewer", task: "review items 1" };
  assert.equal((await a.launch(plain)).res, undefined);
  const occasions = a.events("role_launch").map((r) => r.occasion);
  assert.deepEqual(occasions, ["second-opinion", "item"]);
});
