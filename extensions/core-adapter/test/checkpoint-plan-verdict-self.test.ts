// R15 item 9 (security): a ruling-plan.md the session wrote itself (write/edit or a shell line) is no plan verdict; a parent-written one still is.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { readPlanVerdict } from "../checkpoint.ts";
import { SelfRulings, selfRulingAsk, selfRulingRefusal, SELF_RULING_REASON, snapshotRulings } from "../ruling.ts";
import { SteerWatch } from "../steerwatch.ts";

const await_ = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function rig(t: { after(fn: () => void): void }): { d: string; plan: string } {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpself2-")));
  t.after(() => rmTestTmp(d));
  const plan = path.join(d, "plan-x.md");
  fs.writeFileSync(plan, "p");
  await_(20);
  return { d, plan };
}

test("a shell line writing ruling-plan.md in the own handoff dir is refused like one writing ruling.md", async (t) => {
  const { d } = rig(t);
  for (const name of ["ruling.md", "ruling-plan.md"]) {
    assert.equal(await selfRulingRefusal("bash", { command: `printf APPROVED > ${path.join(d, name)}` }, d, [d]), SELF_RULING_REASON, name);
    assert.ok(await selfRulingAsk("bash", { command: `printf APPROVED > ${path.join(d, name)}` }, [d]), name);
  }
});

test("a ruling-plan.md changed by a shell command is tracked as self-written and gives no verdict", (t) => {
  const { d, plan } = rig(t);
  const self = new SelfRulings();
  const before = snapshotRulings([d]);
  fs.writeFileSync(path.join(d, "ruling-plan.md"), "APPROVED");
  self.markChanged(before, [d]);
  assert.equal(readPlanVerdict(d, plan, self), null);
  assert.deepEqual(readPlanVerdict(d, plan), { kind: "approve" }); // no tracking: the same file approves
});

test("a ruling-plan.md marked as self-written gives no verdict; a later parent write approves", (t) => {
  const { d, plan } = rig(t);
  const self = new SelfRulings();
  const f = path.join(d, "ruling-plan.md");
  fs.writeFileSync(f, "APPROVED");
  self.mark(f);
  assert.equal(readPlanVerdict(d, plan, self), null);
  await_(20);
  fs.writeFileSync(f, "APPROVED\n");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.deepEqual(readPlanVerdict(d, plan, self), { kind: "approve" });
});

test("a parent-written ruling-plan.md still approves with a SelfRulings in play", (t) => {
  const { d, plan } = rig(t);
  fs.writeFileSync(path.join(d, "ruling-plan.md"), "APPROVED");
  assert.deepEqual(readPlanVerdict(d, plan, new SelfRulings()), { kind: "approve" });
});

test("steerwatch still ignores ruling-plan.md", (t) => {
  const { d } = rig(t);
  const w = new SteerWatch(() => d);
  let fn: (() => void) | null = null;
  const got: string[] = [];
  w.start((x) => got.push(x), 10, { set: (f: () => void) => ((fn = f), 1), clear: () => void (fn = null) });
  fs.writeFileSync(path.join(d, "ruling-plan.md"), "APPROVED");
  (fn as (() => void) | null)?.();
  assert.deepEqual(got, []);
});
