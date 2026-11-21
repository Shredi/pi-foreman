// D72: in a session with no builder and no project edit, `mark V` is also accepted when every plan lineage's latest verdict is a PASS on
// its current version (index.ts planOnlyPass); the code-review path and its refusal text are unchanged.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { planLedgerCall, V_ATTESTED_NOTE, V_REFUSAL } from "../ledgercall.ts";
import { build, end, launch, setup, tick } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const NONE = { last: null, revised: false };

test("pure: planPass lets mark V through with the attested note; without it the refusal keeps its pinned text and names the plan-review way", () => {
  const ok = planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate: NONE, planPass: true });
  assert.deepEqual(ok, { calls: [["mark", "V", V_ATTESTED_NOTE, "--verifier"]], items: "V", attested: true });
  for (const planPass of [false, undefined]) {
    const r = planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate: NONE, planPass });
    assert.ok("error" in r);
    assert.ok(r.error.includes(V_REFUSAL));
    assert.match(r.error, /\[plan-review\] PASS on the current version of every plan/);
  }
  assert.ok("error" in planLedgerCall({ action: "mark", items: ["V"] }, { child: false, gate: { last: "fail", revised: true }, planPass: false }));
});

const markV = async (a: Rig): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", { action: "mark", items: ["V"] }, undefined, undefined, a.ctx)) as { content: { text: string }[] };
  return r.content.map((c) => c.text).join("\n");
};
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [ ] V. fresh-eyes verification passed\n";
const planned = async (t: Parameters<typeof setup>[0], verdict: "PASS" | "FAIL" = "PASS") => {
  const s = await setup(t);
  await s.a.writeLedger(LEDGER);
  assert.equal(await s.a.review(verdict), null);
  await tick(100);
  return s;
};

test("wiring: a plan-only session closes V after a PASS on the current plan version", async (t) => {
  const { a } = await planned(t);
  const text = await markV(a);
  assert.doesNotMatch(text, /refused|V closes after/, text);
  assert.match(text, /\[x\] V\./);
});

test("wiring: refused after the plan body changed since the PASS, and after a FAIL", async (t) => {
  const { a, w } = await planned(t);
  fs.appendFileSync(w.planFile, "\nOne more step before the first.\n");
  assert.match(await markV(a), /V closes after a reviewer PASS that still stands/);
  const f = await planned(t, "FAIL");
  assert.match(await markV(f.a), /V closes after a reviewer PASS that still stands/);
});

test("wiring: refused while another plan's latest review is a FAIL", async (t) => {
  const { a, w } = await planned(t);
  fs.copyFileSync(w.planFile, path.join(path.dirname(w.planFile), "plan-other.md"));
  const r = await a.reviewLaunch("[plan-review] review .workflow/scratch/plan-other.md");
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRun(r.id, "1. FAIL plan-other.md:1 gap\nOverall verdict: FAIL");
  await tick(100);
  assert.match(await markV(a), /V closes after a reviewer PASS that still stands/);
});

test("wiring: refused with a builder launched (running, then completed)", async (t) => {
  const { a } = await planned(t);
  const b = await launch(a, "builder", "build the widget");
  assert.equal(b.blocked, null, String(b.blocked));
  assert.match(await markV(a), /V closes after a reviewer PASS that still stands/, "running");
  await end(a, b, "builder", "done");
  assert.match(await markV(a), /V closes after a reviewer PASS that still stands/, "completed");
});

test("wiring: refused with a project edit counted", async (t) => {
  const { a, w } = await planned(t);
  await a.fire("tool_result", { toolName: "write", toolCallId: "e1", input: { path: path.join(w.project, "src", "x.ts"), content: "x\n" }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  assert.match(await markV(a), /V closes after a reviewer PASS that still stands/);
});

test("wiring: the code-review path still closes V after a [pre-pr] PASS", async (t) => {
  const { a } = await setup(t);
  await a.writeLedger(LEDGER);
  await build(a);
  await tick(300);
  assert.doesNotMatch(await markV(a), /V closes after/);
});
