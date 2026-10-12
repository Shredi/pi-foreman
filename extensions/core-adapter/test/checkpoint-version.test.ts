import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builderLaunchRefusal, currentPlanHash, planVersionHash, readPlan, sha256 } from "../checkpoint.ts";
import type { PlanRecord } from "../checkpoint.ts";

const PLAN = "# Widget\n\n## Goal\nShip the widget.\n\n## Approach\nx\n";

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ckv-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const file = path.join(ws, ".workflow/scratch/plan-widget.md");
  fs.writeFileSync(file, PLAN);
  return { file, opts: { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" } };
}

test("checkpoint version: readPlan hashes the version, the bytes hash stays available", (t) => {
  const { file, opts } = workspace(t);
  fs.appendFileSync(file, "\n## Ruling\nOwner: ship it.\n");
  const r = readPlan(file, opts);
  assert.ok("plan" in r);
  assert.equal(r.plan.hash, sha256(Buffer.from(PLAN)));
  assert.equal(r.plan.hash, planVersionHash(r.plan.bytes));
  assert.notEqual(r.plan.hash, sha256(r.plan.bytes));
});

test("checkpoint version: an approval survives a ruling append; a body edit is plan_changed", (t) => {
  const { file, opts } = workspace(t);
  const r = readPlan(file, opts);
  assert.ok("plan" in r);
  const rec: PlanRecord = { topic: "widget", path: r.plan.path, hash: r.plan.hash, status: "approved", approvedAt: "t", by: "user" };
  assert.equal(builderLaunchRefusal(rec, "heavy", currentPlanHash(rec, opts)), null);
  fs.appendFileSync(file, "\n## Decision log\n- 1: use the small variant\n");
  assert.equal(builderLaunchRefusal(rec, "heavy", currentPlanHash(rec, opts)), null, "ruling appended");
  fs.appendFileSync(file, "\n## Addendum 2\nmore\n");
  assert.equal(builderLaunchRefusal(rec, "heavy", currentPlanHash(rec, opts)), null, "addendum appended");
  fs.writeFileSync(file, PLAN.replace("small", "x").replace("x\n", "y\n") + "\n## Ruling\nr\n");
  assert.equal(builderLaunchRefusal(rec, "heavy", currentPlanHash(rec, opts)), "plan_changed", "body edit");
});

test("checkpoint version: a body edit above an existing ruling is a new version", (t) => {
  const { file, opts } = workspace(t);
  fs.appendFileSync(file, "\n## Ruling\nr\n");
  const a = readPlan(file, opts);
  fs.writeFileSync(file, PLAN.replace("Ship", "Ship soon") + "\n## Ruling\nr\n");
  const b = readPlan(file, opts);
  assert.ok("plan" in a && "plan" in b);
  assert.notEqual(a.plan.hash, b.plan.hash);
});
