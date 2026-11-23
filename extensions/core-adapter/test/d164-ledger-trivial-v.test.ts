// D164: a ledger created at the trivial tier has no V item; when the tier rises above trivial the bound ledger gets V once.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { ledgerInitContent, withVItem } from "../ledgercall.ts";
import { openLedgerItems } from "../verdict.ts";
import { settle, setup, tick } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";
import { boundLedger } from "../marker.ts";
import * as path from "node:path";

test("ledgerInitContent: trivial adds no V, standard, heavy and an unrecorded tier do", () => {
  assert.doesNotMatch(ledgerInitContent("t", "trivial", ["a"]), /V\./);
  assert.deepEqual(openLedgerItems(ledgerInitContent("t", "trivial", ["a"])), { nums: [1], v: false });
  for (const tier of ["standard", "heavy", null]) assert.match(ledgerInitContent("t", tier, ["a"]), /- \[ \] V\. fresh-eyes verification passed\n$/);
});

test("withVItem: appends once, keeps the line endings, sees a closed V and a V inside a fence", () => {
  const out = withVItem("# LEDGER t\nTier: trivial\n\n- [ ] 1. a");
  assert.equal(out, "# LEDGER t\nTier: trivial\n\n- [ ] 1. a\n- [ ] V. fresh-eyes verification passed\n");
  assert.equal(withVItem(out as string), null);
  assert.equal(withVItem("- [x] V. fresh-eyes verification passed\n"), null);
  assert.equal(withVItem("- [ ] 1. a\r\n"), "- [ ] 1. a\r\n- [ ] V. fresh-eyes verification passed\r\n");
  assert.match(withVItem("```\n- [ ] V. in a fence\n```\n") as string, /passed\n$/);
});

const init = async (a: Rig, params: Record<string, unknown>): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", { action: "init", ...params }, undefined, undefined, a.ctx)) as { content: { text: string }[] };
  return r.content.map((c) => c.text).join("\n");
};

test("end to end: init at trivial has no V and a read-only session ends; the rise to standard appends V once", async (t) => {
  const { a, w } = await setup(t, { noOwner: true, tier: "trivial" });
  await a.command("ceremony", "trivial");
  const text = await init(a, { topic: "d164", texts: ["look into it"] });
  assert.match(text, /created/, text);
  const file = boundLedger(path.join(path.dirname(w.project), "agent", "pi-foreman", "state"), a.ctx.sessionManager.getSessionId()) ?? path.join(w.project, ".workflow", "LEDGER-d164.md");
  const body = () => fs.readFileSync(file, "utf8");
  assert.match(body(), /Tier: trivial/);
  assert.doesNotMatch(body(), /V\./);
  assert.equal(await settle(a), "", "a read-only trivial session ends");
  await a.command("ceremony", "standard");
  await tick(50);
  assert.equal(body().match(/- \[ \] V\. /g)?.length, 1, body());
  await a.command("ceremony", "trivial");
  await a.command("ceremony", "standard");
  await tick(50);
  assert.equal(body().match(/V\./g)?.length, 1, "V is not added twice");
});
