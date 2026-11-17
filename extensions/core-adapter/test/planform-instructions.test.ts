// Form checks that became instructions: two diagrams and missing plan-first headings pass the plan form; the owner
// section's presence, content and position still refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";

const D = "```mermaid\ngraph TD\nA-->B\n```\n";
const plan = (owner: string) => `# W\n\n${owner}## Goal\nShip it.\n`;
const refused = (r: { blocked: string | null }): boolean => /\[plan_form\]/.test(r.blocked ?? "");

test("two diagrams in the owner section: no plan_form refusal", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, plan(`## For the owner\n\nGoal: ship.\n${D}\nThen more.\n${D}\n`));
  assert.equal((await (await w.adapter("startup")).reviewLaunch()).blocked, null);
});

test("a parented plan-first plan without the two headings: no refusal", async (t) => {
  const w = world(t, { handoff: true });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  fs.writeFileSync(w.planFile, plan("## For the owner\n\nGoal: ship.\n\n"));
  assert.equal((await (await w.adapter("startup")).reviewLaunch()).blocked, null);
  delete process.env.PI_FOREMAN_PLAN_PHASE;
});

test("a missing, empty or late owner section is still refused", async (t) => {
  for (const text of [plan(""), plan("## For the owner\n\n"), `# W\n\n## Goal\nx\n\n## For the owner\n\nGoal.\n`]) {
    const w = world(t);
    fs.writeFileSync(w.planFile, text);
    assert.ok(refused(await (await w.adapter("startup")).reviewLaunch()), text);
  }
});
