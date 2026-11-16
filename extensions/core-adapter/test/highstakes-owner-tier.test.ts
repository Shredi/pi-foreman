// The heavy reason is dropped by the owner's /ceremony tier below heavy, not by whichever source set the tier last.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, pr, setup, settle, stakes } from "./_hsrig.ts";

const NOT_DUE = /high_stakes/;
const FINISH = /a high-stakes review must run/;
const finishLedger = () => "# Ledger: x\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n";

async function heavyFired(t: Parameters<typeof setup>[0]) {
  const r = await setup(t, { tier: "heavy" });
  commitIn(r.w.project, "src/a/x.ts");
  await build(r.a);
  assert.deepEqual(await stakes(r.w), ["heavy"]);
  return r;
}

test("after the owner's /ceremony standard, foreman_triage standard keeps the gates open", async (t) => {
  const { a } = await heavyFired(t);
  await a.command("ceremony", "standard");
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  await a.writeLedger(finishLedger());
  assert.doesNotMatch(await pr(a), NOT_DUE);
  assert.doesNotMatch(await settle(a), FINISH);
});

test("after the owner's /ceremony trivial, an automatic raise to standard keeps the gates open", async (t) => {
  const { a } = await heavyFired(t);
  await a.command("ceremony", "trivial");
  await build(a);
  await build(a);
  await a.writeLedger(finishLedger());
  assert.doesNotMatch(await pr(a), NOT_DUE);
  assert.doesNotMatch(await settle(a), FINISH);
});

test("after the owner's /ceremony heavy, the foreman lowering the tier leaves the gate shut", async (t) => {
  const { a } = await heavyFired(t);
  await a.command("ceremony", "heavy");
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  await a.writeLedger(finishLedger());
  assert.match(await pr(a), NOT_DUE);
  assert.match(await settle(a), FINISH);
});
