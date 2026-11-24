// D166: two checkouts, each with a standing pre-pr PASS on its head: the foreman may mark V.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [ ] V. fresh-eyes verification passed\n";
const markV = async (a: Rig): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", { action: "mark", items: ["V"] }, undefined, undefined, a.ctx)) as { content: { text: string }[] };
  return r.content.map((c) => c.text).join("\n");
};

test("mark V is accepted with a standing pre-pr PASS in each of two checkouts", async (t) => {
  const { a, w } = await setup(t);
  w.state.answer = "allow once";
  const b = worktree(w, "wtb");
  await a.writeLedger(LEDGER);
  await build(a);
  await build(a, {}, b);
  await tick(300);
  const text = await markV(a);
  assert.doesNotMatch(text, /V closes after a reviewer PASS that still stands|refused/, text);
  assert.match(text, /\[x\] V\./);
});
