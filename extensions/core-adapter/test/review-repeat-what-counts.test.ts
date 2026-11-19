// D76 addendum: after a PASS a ledger note and a script run that changes nothing in the checkout are no change; the refusal names what counts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { build, launch, setup, tick } from "./_hsrig.ts";

const COUNTS = /\(no builder run, new commit, changed file in the checkout, or ledger item added or rewritten\)/;

test("after a PASS: a ledger note and a script run without a checkout change are refused; a changed tracked file is allowed", async (t) => {
  const { a, w } = await setup(t);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [ ] 1. one\n");
  await build(a);
  await tick(300);
  const again = async () => (await launch(a, "reviewer", "review the branch again")).blocked;
  assert.match((await again()) ?? "", /the last review passed/);

  const r = (await a.tool("foreman_ledger")!.execute("id", { action: "note", item: 1, text: "a note" }, undefined, undefined, a.ctx)) as { isError?: boolean };
  assert.ok(!r.isError);
  assert.match((await again()) ?? "", COUNTS, "a ledger note alone is no change");

  // A successful owner-script run that left the checkout alone: only the file check counts.
  await a.fire("tool_result", { toolName: "foreman_script", toolCallId: "sc1", input: { action: "run", path: "/x/s.sh" }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  assert.match((await again()) ?? "", COUNTS, "a script run with no checkout change is still refused");

  fs.appendFileSync(path.join(w.project, ".gitignore"), "changed-after-pass\n");
  assert.equal(await again(), null, "a changed tracked file lets the launch through");
});
