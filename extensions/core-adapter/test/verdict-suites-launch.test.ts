// The pre-pr review launch asks for CI suites, and the run end shows them in the verdict file (index.ts, verdict.ts PRE_PR_SUITES_LINE, reviews.ts suitesLine).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tick, world } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";
import { PRE_PR_SUITES_LINE, recordOf, writeRecord, type VerdictCall } from "../verdict.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] V. fresh-eyes verification passed\n";
const SUITES = [{ command: "npm test", result: "pass" as const }, { command: "npm run typecheck", result: "pass" as const }];

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

/** Ends launch `id` with a record call `call` and an output file `file`; the harness appends its lines to the file. */
async function end(a: Rig, id: string, call: VerdictCall, file: string): Promise<string> {
  fs.writeFileSync(file, "Overall verdict: PASS\n");
  const b = bindingOf(a.inputOf(id));
  assert.ok(b?.verdictDir && b.launchId);
  writeRecord(b.verdictDir, recordOf(b.launchId, call));
  await a.endEvent({ runId: `run-${id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "report", artifactPaths: { outputPath: file } }] });
  for (let i = 0; i < 40 && !/^Head: /m.test(fs.readFileSync(file, "utf8")); i++) await tick(50);
  return fs.readFileSync(file, "utf8");
}

test("a [pre-pr] launch carries the CI-suites line; an item review and a plan review do not", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const pre = await a.reviewLaunch("[pre-pr] review the diff");
  assert.equal(pre.blocked, null, String(pre.blocked));
  assert.equal(pre.task.split(PRE_PR_SUITES_LINE).length - 1, 1);
  assert.ok(pre.task.indexOf(PRE_PR_SUITES_LINE) < pre.task.indexOf("[pi-foreman verdict items]"), "the items line stays last");
  assert.match(PRE_PR_SUITES_LINE, /every test suite the repository's CI runs that can run locally/);
  assert.match(PRE_PR_SUITES_LINE, /review_verdict suites/);
  const item = await a.reviewLaunch("review item 1 of the diff");
  assert.equal(item.blocked, null, String(item.blocked));
  assert.doesNotMatch(item.task, /pre-pr suites/);
  const plan = await a.reviewLaunch();
  assert.equal(plan.blocked, null, String(plan.blocked));
  assert.doesNotMatch(plan.task, /pre-pr suites/);
});

test("the output file of a [pre-pr] PASS gets the suites line before the Head line", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const r = await a.reviewLaunch("[pre-pr] review the diff");
  const text = await end(a, r.id, { verdict: "pass", items: [], findings: [], suites: SUITES }, path.join(w.project, "pre.md"));
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.at(-1)?.startsWith("Head: "), true);
  assert.equal(lines.at(-2), "suites: npm test (pass), npm run typecheck (pass)");
});

test("a [pre-pr] PASS without suites says so", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const pre = await a.reviewLaunch("[pre-pr] review the diff");
  const text = await end(a, pre.id, { verdict: "pass", items: [], findings: [] }, path.join(w.project, "pre2.md"));
  assert.equal(text.trimEnd().split("\n").at(-2), "suites: none named by the pre-pr reviewer");
});

test("an item PASS without suites gets no suites line", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const item = await a.reviewLaunch("review item 1 of the diff");
  assert.equal(item.blocked, null, String(item.blocked));
  const text = await end(a, item.id, { verdict: "pass", items: [], findings: [] }, path.join(w.project, "item.md"));
  assert.doesNotMatch(text, /^suites:/m);
});

test("a [pre-pr] FAIL without suites gets no suites line", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const pre = await a.reviewLaunch("[pre-pr] review the diff");
  const text = await end(a, pre.id, { verdict: "fail", items: [], findings: [{ kind: "defect", text: "broken", file: "a.ts", line: 1 }] }, path.join(w.project, "fail.md"));
  assert.doesNotMatch(text, /^suites:/m);
});
