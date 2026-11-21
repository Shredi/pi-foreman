// D146: the foreman may mark V after any reviewer PASS that stands: later work does not matter, a FAIL after the PASS, no PASS yet, or another
// checkout whose last review failed keeps V open (ledgercall.ts vOpen).
import assert from "node:assert/strict";
import { test } from "node:test";
import { planLedgerCall } from "../ledgercall.ts";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { build, end, launch, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const mark = { action: "mark", items: ["V"] };
const refused = (gate: { last: string | null; revised: boolean; passRun?: string; failed?: boolean }): boolean => "error" in planLedgerCall(mark, { child: false, gate });

test("pure: V opens on a PASS gate (revised or not, with or without a run id) or a PASS run id with no FAIL; never on a FAIL or no PASS", () => {
  assert.equal(refused({ last: "pass", revised: true }), false, "work after the PASS");
  assert.equal(refused({ last: "pass", revised: false }), false);
  assert.equal(refused({ last: "none", revised: false, passRun: "r1" }), false, "a later review ended without a verdict");
  assert.equal(refused({ last: null, revised: true, passRun: "r1" }), false, "another checkout never reviewed");
  assert.equal(refused({ last: "fail", revised: false, passRun: "r1" }), true, "a checkout whose last review failed");
  assert.equal(refused({ last: "fail", revised: true }), true);
  assert.equal(refused({ last: null, revised: false }), true, "no PASS yet");
  assert.equal(refused({ last: "none", revised: false }), true, "no PASS run");
});

const markV = async (a: Rig): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", mark, undefined, undefined, a.ctx)) as { content: { text: string }[] };
  return r.content.map((c) => c.text).join("\n");
};
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [ ] V. fresh-eyes verification passed\n";
const FAIL = "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL";
const REFUSED = /V closes after a reviewer PASS that still stands/;

test("wiring: PASS, then a builder launch: mark V is accepted", async (t) => {
  const { a } = await setup(t);
  await a.writeLedger(LEDGER);
  await build(a);
  await tick(300);
  const b = await launch(a, "builder", "build more");
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done");
  const text = await markV(a);
  assert.doesNotMatch(text, REFUSED, text);
  assert.match(text, /\[x\] V\./);
});

test("wiring: a FAIL after the PASS refuses V; no PASS yet refuses V", async (t) => {
  const none = await setup(t);
  await none.a.writeLedger(LEDGER);
  assert.match(await markV(none.a), REFUSED, "no PASS yet");
  const { a } = await setup(t);
  await a.writeLedger(LEDGER);
  await build(a);
  await tick(300);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch again"), "reviewer", FAIL);
  await tick(300);
  assert.match(await markV(a), REFUSED, "FAIL after PASS");
});

test("wiring: checkout B's last review FAIL keeps V open while checkout A passed", async (t) => {
  const { a, w } = await setup(t);
  w.state.answer = "allow once"; // a launch in another checkout asks the gate
  const b = worktree(w, "wtb");
  await a.writeLedger(LEDGER);
  await build(a);
  await tick(300);
  const rb = await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: b });
  assert.equal(rb.blocked, null, String(rb.blocked));
  await end(a, rb, "reviewer", FAIL, b);
  await tick(300);
  assert.match(await markV(a), REFUSED);
});

const seq = (...vs: ("pass" | "fail" | null)[]) => vs.reduce((g, v, i) => onReviewVerdicts(g, [v], i, `r${i}`), initialReviewGate());

test("pure: a review without a verdict keeps a standing FAIL (PASS, FAIL, none refuses V; a later PASS opens it; PASS, none stays open)", () => {
  assert.equal(refused(seq("pass", "fail", null)), true);
  assert.equal(refused(seq("pass", "fail", null, null)), true, "two runs without a verdict");
  assert.equal(refused(seq("pass", "fail", null, "pass")), false);
  assert.equal(refused(seq("pass", null)), false);
  assert.equal(refused({ last: "none", revised: false, passRun: "r1", failed: true }), true);
  assert.equal(refused({ last: "none", revised: false, passRun: "r1" }), false);
});

test("wiring: PASS, FAIL, a reviewer run with no verdict: mark V stays refused; a later PASS opens it", async (t) => {
  const { a } = await setup(t);
  await a.writeLedger(LEDGER);
  await build(a);
  await tick(300);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch again"), "reviewer", FAIL);
  await tick(300);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch once more"), "reviewer", "no verdict");
  await tick(300);
  assert.match(await markV(a), REFUSED, "the FAIL still stands");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch finally"), "reviewer", "Overall verdict: PASS");
  await tick(300);
  const text = await markV(a);
  assert.doesNotMatch(text, REFUSED, text);
});
