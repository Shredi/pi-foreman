// Plan form by code (ownertext.ts planFormIssues, docs/ceremony.md): a `[plan-review]` launch on a plan whose owner section is
// missing, empty, not first or too long is refused with `[plan_form]` (trace `launch_refused`, reason `plan_form`; no `role_launch`);
// a clean plan and a plan that cannot be read launch; the write result of a plan carries the same faults. The two headings of a
// plan-first session are checked only when PI_FOREMAN_PLAN_PHASE is 1 and PI_FOREMAN_HANDOFF_DIR is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";
import { planFormIssues } from "../ownertext.ts";

const OWNER = "## For the owner\n\nGoal: ship the widget.\nSteps: one small change.\n\n";
const REST = "## Goal\nShip it.\n";
const HEADINGS = "## Decisions and assumptions\n1. none.\n\n## Open questions\n1. none.\n";
const clean = `# Widget\n\n${OWNER}${REST}`;
const longOwner = `## For the owner\n\n${Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the owner section.`).join("\n")}\n\n`;

const refused = (r: { blocked: string | null }): boolean => /\[plan_form\]/.test(r.blocked ?? "");

test("planFormIssues: missing, empty, not first, too long, headings; jargon is no issue", () => {
  assert.deepEqual(planFormIssues(clean, {}), []);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}`, {}), ["missing"]);
  assert.deepEqual(planFormIssues(`# W\n\n## For the owner\n\n## Goal\nx\n`, {}), ["empty"]);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}\n${OWNER}`, {}), ["not the first ## section"]);
  const long = planFormIssues(`# W\n\n${longOwner}${REST}`, {});
  assert.equal(long.length, 1);
  assert.match(long[0], /^too long \(14 lines wrapped at 100 columns/);
  assert.deepEqual(planFormIssues(`# W\n\n## For the owner\n\nSee \`src/a.ts\` and foo_bar.\n\n${REST}`, {}), []);
  assert.deepEqual(planFormIssues(clean, { requiredHeadings: ["Decisions and assumptions", "Open questions"] }), ["missing heading: Decisions and assumptions", "missing heading: Open questions"]);
  assert.deepEqual(planFormIssues(`${clean}\n${HEADINGS}`, { requiredHeadings: ["Decisions and assumptions", "Open questions"] }), []);
});

test("planFormIssues: required headings inside a fenced code block do not count", () => {
  const req = { requiredHeadings: ["Decisions and assumptions", "Open questions"] };
  const missing = ["missing heading: Decisions and assumptions", "missing heading: Open questions"];
  assert.deepEqual(planFormIssues(`${clean}\n\`\`\`\n${HEADINGS}\`\`\`\n`, req), missing);
  assert.deepEqual(planFormIssues(`${clean}\n~~~md\n${HEADINGS}~~~\n`, req), missing);
  assert.deepEqual(planFormIssues(`${clean}\n${HEADINGS}\n\`\`\`\n## Example\n\`\`\`\n`, req), []);
});

test("a [plan-review] launch on a plan with a clean owner section starts", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, clean);
  const a = await w.adapter("startup");
  assert.equal((await a.reviewLaunch()).blocked, null);
});

test("a [plan-review] launch is refused for each form fault, with a launch_refused record and no role_launch", async (t) => {
  const faults: [string, string, RegExp][] = [
    ["missing", `# W\n\n${REST}`, /missing/],
    ["empty", `# W\n\n## For the owner\n\n${REST}`, /empty/],
    ["not first", `# W\n\n${REST}\n${OWNER}`, /not the first/],
    ["too long", `# W\n\n${longOwner}${REST}`, /too long \(14 lines/],
  ];
  for (const [name, text, re] of faults) {
    const w = world(t);
    fs.writeFileSync(w.planFile, text);
    const a = await w.adapter("startup");
    const r = await a.reviewLaunch();
    assert.ok(refused(r), `${name}: ${r.blocked}`);
    assert.match(r.blocked ?? "", re, name);
    assert.match(r.blocked ?? "", /no reviewer was started/, name);
    const trace = await w.traceEvents();
    assert.ok(trace.some((e) => e.event === "launch_refused" && e.reason === "plan_form"), `${name}: launch_refused`);
    assert.ok(!trace.some((e) => e.event === "role_launch"), `${name}: no role_launch`);
  }
});

test("a plan that cannot be read does not refuse the launch", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal((await a.reviewLaunch("[plan-review] review .workflow/scratch/plan-ghost.md")).blocked, null);
});

test("a fixed plan launches again", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, `# W\n\n${REST}`);
  const a = await w.adapter("startup");
  assert.ok(refused(await a.reviewLaunch()));
  fs.writeFileSync(w.planFile, clean);
  assert.equal((await a.reviewLaunch()).blocked, null);
});

test("the two headings are required only in a plan-first session opened by a parent", async (t) => {
  const bare = world(t);
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  fs.writeFileSync(bare.planFile, clean);
  assert.equal((await (await bare.adapter("startup")).reviewLaunch()).blocked, null, "plan phase without a handoff dir");
  const parented = world(t, { handoff: true });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  fs.writeFileSync(parented.planFile, clean);
  const a = await parented.adapter("startup");
  const r = await a.reviewLaunch();
  assert.ok(refused(r), r.blocked ?? "started");
  assert.match(r.blocked ?? "", /Decisions and assumptions/);
  assert.match(r.blocked ?? "", /Open questions/);
  fs.writeFileSync(parented.planFile, `${clean}\n${HEADINGS}`);
  assert.equal((await a.reviewLaunch()).blocked, null);
  const outside = world(t, { handoff: true });
  delete process.env.PI_FOREMAN_PLAN_PHASE;
  fs.writeFileSync(outside.planFile, clean);
  assert.equal((await (await outside.adapter("startup")).reviewLaunch()).blocked, null, "a handoff dir without the plan phase");
});

test("the write result of a plan carries the form faults; a clean plan adds nothing", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  fs.writeFileSync(w.planFile, `# W\n\n${longOwner}${REST}`);
  const bad = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(bad.note, /too long \(14 lines/);
  assert.match(bad.note, /plan form is wrong/);
  fs.writeFileSync(w.planFile, clean);
  const ok = await a.call("write", { path: w.planFile, content: "x" });
  assert.equal(ok.note, "", "the result is left as it was");
});
