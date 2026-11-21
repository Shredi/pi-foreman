// Gates round PR D: the per-checkout high-stakes launch hold (item 12), a plan-only heavy finish (13), empty fillers of optional launch fields (14).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { launchRefusal } from "../highstakes.ts";
import { takeLaunchFlags, takeSizing } from "../sizing.ts";
import { planMcpLaunch } from "../mcplaunch.ts";
import { filler } from "../jsontext.ts";
import { end, hsRun, launch, settle, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const PASS = "Overall verdict: PASS";
const review = async (a: Rig, cwd?: string, extra: Record<string, unknown> = {}) => {
  const r = await launch(a, "reviewer", "[pre-pr] review the branch", { ...(cwd ? { cwd } : {}), ...extra });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", PASS, cwd);
};
const builder = async (a: Rig, cwd?: string) => {
  const b = await launch(a, "builder", "build the widget", cwd ? { cwd } : {});
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", cwd);
};

// ---------------------------------------------------------------- item 12

test("12: a high-stakes FAIL in another checkout does not hold the launch here (pure)", () => {
  const run = (cwd: string) => ({ verdict: "fail" as const, cwd, head: null, revised: false });
  const input = (root?: string) => ({ model: "m", single: true, resume: false, running: false, gate: { last: "pass" as const, revised: false }, state: { runs: [run("/a")] } as never, ...(root ? { root } : {}) });
  assert.equal(launchRefusal(input("/a"))?.reason, "high_stakes_early");
  assert.equal(launchRefusal(input("/b")), null);
  assert.equal(launchRefusal(input())?.reason, "high_stakes_early", "no root: any uncleared FAIL holds");
});

test("12: after a high-stakes FAIL in a checkout, a fix and a fresh normal PASS there allow the next launch; another checkout is never held", async (t) => {
  const s = await setup(t);
  const { a } = s;
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  await builder(a);
  await review(a);
  await hsRun(a, "FAIL");
  const held = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.match(held.blocked ?? "", /\[high_stakes_early\]/, "own checkout: still held");
  // the other checkout: its own PASS stands, the FAIL of the own checkout is not its hold
  await builder(a, b);
  await review(a, b);
  const other = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: b });
  assert.equal(other.blocked, null, String(other.blocked));
  await end(a, other, "reviewer", PASS, b);
});

test("12: the same cwd, fix and fresh normal PASS clear a high-stakes FAIL (git)", async (t) => {
  const { a } = await setup(t);
  await builder(a);
  await review(a);
  await hsRun(a, "FAIL");
  await builder(a);
  await review(a);
  await tick(200);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(again.blocked, null, String(again.blocked));
});

test("12: the same cwd, fix and fresh normal PASS clear a high-stakes FAIL (non-git directory)", async (t) => {
  const { a, w } = await setup(t);
  const nowhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-nogit-")));
  t.after(() => fs.rmSync(nowhere, { recursive: true, force: true }));
  w.state.answer = "allow once";
  await builder(a, nowhere);
  await review(a, nowhere);
  await hsRun(a, "FAIL", nowhere);
  const held = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: nowhere });
  assert.match(held.blocked ?? "", /\[high_stakes_early\]/, "held in its own directory");
  await builder(a, nowhere);
  await review(a, nowhere);
  await tick(200);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: nowhere });
  assert.equal(again.blocked, null, String(again.blocked));
});

test("12: a high-stakes launch may name items the normal PASS closed, or none; a normal launch naming them is still refused", async (t) => {
  const { a } = await setup(t);
  await builder(a);
  await review(a);
  await tick(200);
  const normal = await launch(a, "reviewer", "[pre-pr] review the branch", { items: ["1"] });
  assert.match(normal.blocked ?? "", /not open on the ledger/);
  const named = await launch(a, "reviewer", "[high-stakes] review the whole change", { items: ["1"] });
  assert.equal(named.blocked, null, String(named.blocked));
  await end(a, named, "reviewer", PASS);
  const none = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.doesNotMatch(none.blocked ?? "", /not open/);
});

// ---------------------------------------------------------------- item 13

test("13: a plan-only heavy session (plan-review PASS, approved checkpoint, plan under .workflow/, all items closed, no builder) finishes without a builder or reviewer", async (t) => {
  const { a, w } = await setup(t, { tier: "heavy" });
  const plan = path.join(w.project, ".workflow", "plan-extra.md");
  fs.writeFileSync(plan, "# Extra plan\n");
  await a.fire("tool_result", { toolName: "write", toolCallId: "pw1", input: { path: plan, content: "# Extra plan\n" }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  await tick(100);
  assert.equal(await settle(a), "");
});

// ---------------------------------------------------------------- item 14

test("14: filler detection", () => {
  for (const v of ["", {}, "{}"]) assert.equal(filler(v), true, JSON.stringify(v));
  for (const v of [[], "[]", "x", { a: 1 }, 0, false, null, undefined]) assert.equal(filler(v), false, JSON.stringify(v));
});

test("14: '' and {} count as absent for reads, install, occasion, items", () => {
  for (const f of ["", {}]) {
    const input: Record<string, unknown> = { agent: "builder", task: "t", reads: f, install: f, occasion: f, items: f };
    const r = takeLaunchFlags(input);
    assert.equal(r.error, undefined, `reads/install ${JSON.stringify(f)}`);
    assert.equal(r.occasionError, undefined, `occasion ${JSON.stringify(f)}`);
    assert.equal(r.occasions.size, 0);
    assert.equal(r.items.size, 0);
    assert.deepEqual([...r.entries.values()], [{}]);
  }
  const bad = takeLaunchFlags({ agent: "builder", task: "t", reads: "x" });
  assert.match(bad.error ?? "", /reads is not a positive integer/);
});

test("14: items: [] keeps meaning no items", () => {
  const r = takeLaunchFlags({ agent: "reviewer", task: "t", items: [] });
  assert.equal(r.items.size, 1);
});

test("14: '' and {} count as absent for size and risk", () => {
  for (const f of ["", {}]) {
    const r = takeSizing({ agent: "builder", task: "t", size: f, risk: f });
    assert.equal(r.error, undefined, JSON.stringify(f));
    assert.deepEqual([...r.carried], []);
  }
  assert.ok(takeSizing({ agent: "builder", task: "t", size: "x" }).error);
});

test("14: '' and {} count as absent for mcp", () => {
  for (const f of ["", {}]) {
    const plan = planMcpLaunch({ agent: "builder", task: "t", mcp: f }, {});
    assert.equal(plan.refusal, undefined, JSON.stringify(f));
    assert.equal(plan.mcp, undefined);
  }
  assert.ok(planMcpLaunch({ agent: "builder", task: "t", mcp: "x" }, {}).refusal);
});
