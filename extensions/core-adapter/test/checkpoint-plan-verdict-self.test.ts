// R15 item 9 (security), after PR 4 (the child owns its plan): a ruling the session wrote itself (write/edit or a shell line) is never a
// parent ruling; a parent-written one still is (parentApproval, the finish gate's note). `ruling-plan.md` is no longer a tracked name: it
// approves nothing, the shell line naming it still asks, the path rules still refuse a child's write of it, and the steer watch delivers it as a note.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";
import { parentApproval, SelfRulings, selfRulingAsk, selfRulingRefusal, SELF_RULING_REASON, snapshotRulings } from "../ruling.ts";
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

test("a shell line writing ruling.md in the own handoff dir is refused; one writing ruling-plan.md still asks and the path rules refuse its write", async (t) => {
  const { d } = rig(t);
  assert.equal(await selfRulingRefusal("bash", { command: `printf APPROVED > ${path.join(d, "ruling.md")}` }, d, [d]), SELF_RULING_REASON);
  // ruling-plan.md left the tracked names with the parent's plan approval: no literal-path refusal for it any more
  assert.equal(await selfRulingRefusal("bash", { command: `printf APPROVED > ${path.join(d, "ruling-plan.md")}` }, d, [d]), undefined);
  for (const name of ["ruling.md", "ruling-plan.md"]) assert.ok(await selfRulingAsk("bash", { command: `printf APPROVED > ${path.join(d, name)}` }, [d]), name);
  // the write protection of the handoff dir stays: a child's write tool gets no allow for either name in its own handoff dir
  const roots: GateRoots = { worktree: path.join(d, "wt"), scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, ownHandoff: d };
  assert.equal(pathDecide("write", { path: path.join(d, "plan.md") }, roots.worktree, roots)?.rule, "path-write-handoff", "the child's own plan.md is allowed in these roots");
  for (const name of ["ruling.md", "ruling-plan.md"]) assert.equal(pathDecide("write", { path: path.join(d, name) }, roots.worktree, roots)?.rule, undefined, name);
});

test("a ruling.md changed by a shell command is tracked as self-written and is no parent ruling", (t) => {
  const { d } = rig(t);
  const self = new SelfRulings();
  const before = snapshotRulings([d]);
  fs.writeFileSync(path.join(d, "ruling.md"), "APPROVED");
  self.markChanged(before, [d]);
  assert.equal(parentApproval([d], 0, self), null);
  assert.equal(parentApproval([d], 0), path.join(d, "ruling.md"), "no tracking: the same file counts");
});

test("a ruling.md marked as self-written is no parent ruling; a later parent write counts", (t) => {
  const { d } = rig(t);
  const self = new SelfRulings();
  const f = path.join(d, "ruling.md");
  fs.writeFileSync(f, "APPROVED");
  self.mark(f);
  assert.equal(parentApproval([d], 0, self), null);
  await_(20);
  fs.writeFileSync(f, "APPROVED\n");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.equal(parentApproval([d], 0, self), f);
});

test("a parent-written ruling.md still counts with a SelfRulings in play; a ruling-plan.md never does", (t) => {
  const { d } = rig(t);
  fs.writeFileSync(path.join(d, "ruling-plan.md"), "APPROVED");
  assert.equal(parentApproval([d], 0, new SelfRulings()), null, "ruling-plan.md is no parent ruling");
  fs.writeFileSync(path.join(d, "ruling.md"), "APPROVED");
  assert.equal(parentApproval([d], 0, new SelfRulings()), path.join(d, "ruling.md"));
});

test("steerwatch delivers a ruling-plan.md as a note like ruling.md", (t) => {
  const { d } = rig(t);
  const w = new SteerWatch(() => d);
  let fn: (() => void) | null = null;
  const got: string[] = [];
  w.start((x) => got.push(x), 10, { set: (f: () => void) => ((fn = f), 1), clear: () => void (fn = null) });
  fs.writeFileSync(path.join(d, "ruling-plan.md"), "APPROVED");
  (fn as (() => void) | null)?.();
  assert.equal(got.length, 1);
  assert.match(got[0], /ruling-plan\.md/);
});
