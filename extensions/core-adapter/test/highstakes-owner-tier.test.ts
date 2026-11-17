// The heavy reason is dropped by the owner's /ceremony tier below heavy, not by whichever source set the tier last.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, pr, setup, settle, stakes } from "./_hsrig.ts";

const NOT_DUE = /high_stakes/;
const FINISH = /a high-stakes review must run/;
const finishLedger = () => "# Ledger: x\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n";

// One session walks the owner's tiers in turn: each step is judged on the gates after it.
test("the owner's /ceremony standard after heavy fired drops the reason at both gates and foreman_triage standard keeps them open; after /ceremony heavy foreman_triage standard is refused and the gate shuts; after /ceremony trivial an automatic raise to standard keeps them open", async (t) => {
  const { w, a } = await setup(t, { tier: "heavy" });
  commitIn(w.project, "src/a/x.ts");
  await build(a);
  assert.deepEqual(await stakes(w), ["heavy"]);
  assert.match(await pr(a), /\[pr_refused:high_stakes_required\]/, "the PR gate asks while heavy");
  assert.match(await settle(a), FINISH, "the finish gate asks while heavy");

  await a.command("ceremony", "standard");
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  await a.writeLedger(finishLedger());
  assert.doesNotMatch(await pr(a), NOT_DUE, "the PR gate no longer asks");
  assert.doesNotMatch(await settle(a), FINISH, "the finish gate no longer asks");

  await a.command("ceremony", "heavy");
  const triage = await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  assert.match(JSON.stringify(triage), /foreman_triage never lowers a recorded or escalated tier/);
  assert.match(await pr(a), NOT_DUE);
  assert.match(await settle(a), FINISH);

  await a.command("ceremony", "trivial");
  await build(a);
  await build(a);
  assert.doesNotMatch(await pr(a), NOT_DUE);
  assert.doesNotMatch(await settle(a), FINISH);
});
