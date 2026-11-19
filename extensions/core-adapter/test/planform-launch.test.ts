// Plan form by code (ownertext.ts planFormIssues, docs/ceremony.md): a `[plan-review]` launch on a plan whose owner section is
// missing, empty or not first is refused with `[plan_form]` (trace `launch_refused`, reason `plan_form`; no `role_launch`);
// a clean plan and a plan that cannot be read launch; the write result of a plan carries the same faults. The two headings of a
// plan-first session are checked only when PI_FOREMAN_PLAN_PHASE is 1 and PI_FOREMAN_HANDOFF_DIR is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";
import { planFormIssues } from "../ownertext.ts";

const OWNER = "## For the owner\n\n**Goal:** ship the widget.\n\n1. Make one small change.\n\n";
const REST = "## Goal\nShip it.\n";
const HEADINGS = "## Decisions and assumptions\n1. none.\n\n## Open questions\n1. none.\n";
const clean = `# Widget\n\n${OWNER}${REST}`;
const longOwner = `## For the owner\n\n${Array.from({ length: 40 }, (_, i) => `- Line ${i + 1} of the owner section, with a few more plain words to make it wide.`).join("\n")}\n\n`;

const refused = (r: { blocked: string | null }): boolean => /\[plan_form\]/.test(r.blocked ?? "");

test("planFormIssues: missing, empty, not first, headings; length and jargon are no issue", () => {
  assert.deepEqual(planFormIssues(clean, {}), []);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}`, {}), ["missing"]);
  assert.deepEqual(planFormIssues(`# W\n\n## For the owner\n\n## Goal\nx\n`, {}), ["empty"]);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}\n${OWNER}`, {}), ["not the first ## section"]);
  assert.deepEqual(planFormIssues(`# W\n\n## For the owner\n\nSee \`src/a.ts\` and foo_bar.\n\n${REST}`, {}), []);
  assert.deepEqual(planFormIssues(clean, { requiredHeadings: ["Decisions and assumptions", "Open questions"] }), ["missing heading: Decisions and assumptions", "missing heading: Open questions"]);
  assert.deepEqual(planFormIssues(`${clean}\n${HEADINGS}`, { requiredHeadings: ["Decisions and assumptions", "Open questions"] }), []);
});

test("a long owner section is no form fault; a missing or late one still is", async (t) => {
  const longText = `# W\n\n${longOwner}${REST}`;
  assert.ok(longOwner.length > 3000);
  assert.deepEqual(planFormIssues(longText, {}), []);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}`, {}), ["missing"]);
  assert.deepEqual(planFormIssues(`# W\n\n${REST}\n${longOwner}`, {}), ["not the first ## section"]);
  const w = world(t);
  fs.writeFileSync(w.planFile, longText);
  assert.equal((await (await w.adapter("startup")).reviewLaunch()).blocked, null);
  for (const text of [`# W\n\n${REST}`, `# W\n\n${REST}\n${longOwner}`]) {
    const x = world(t);
    fs.writeFileSync(x.planFile, text);
    assert.ok(refused(await (await x.adapter("startup")).reviewLaunch()));
  }
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

test("the two headings are not checked, in a plan-first session opened by a parent or elsewhere", async (t) => {
  const bare = world(t);
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  fs.writeFileSync(bare.planFile, clean);
  assert.equal((await (await bare.adapter("startup")).reviewLaunch()).blocked, null, "plan phase without a handoff dir");
  const parented = world(t, { handoff: true });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  fs.writeFileSync(parented.planFile, clean);
  const a = await parented.adapter("startup");
  const r = await a.reviewLaunch();
  assert.equal(r.blocked, null, "no refusal for the missing headings");
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
  fs.writeFileSync(w.planFile, `# W\n\n${REST}`);
  const bad = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(bad.note, /missing/);
  assert.match(bad.note, /plan form is wrong/);
  fs.writeFileSync(w.planFile, clean);
  const ok = await a.call("write", { path: w.planFile, content: "x" });
  assert.equal(ok.note, "", "the result is left as it was");
});

test("a [plan-review] launch naming the faulty plan by an @-prefixed path is refused", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, `# W\n\n${REST}`);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[plan-review] review @.workflow/scratch/plan-widget.md");
  assert.ok(refused(r), String(r.blocked));
  assert.match(r.blocked ?? "", /missing/);
});

test("a [plan-review] launch naming the faulty plan by a ~/ path is refused", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, `# W\n\n${REST}`);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }; // os.homedir() reads USERPROFILE on Windows
  process.env.HOME = w.project;
  process.env.USERPROFILE = w.project;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[plan-review] review ~/.workflow/scratch/plan-widget.md");
  assert.ok(refused(r), String(r.blocked));
});
