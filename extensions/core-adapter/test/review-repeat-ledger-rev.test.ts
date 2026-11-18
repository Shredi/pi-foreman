// D76: after a reviewer PASS only a ledger subject change (an added or rewritten item, a write or edit of the ledger file) lets the next
// reviewer launch through; mark, note and defer through foreman_ledger and the harness's own marks do not. The count is persisted.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { build, launch, setup, tick } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const REFUSED = /the last review passed/;
const ledger = async (a: Rig, params: Record<string, unknown>): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", params, undefined, undefined, a.ctx)) as { content: { text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  assert.ok(!r.isError, text);
  return text;
};
const passed = async (t: Parameters<typeof setup>[0], text?: string) => {
  const s = await setup(t);
  if (text) await s.a.writeLedger(`# Ledger: x\nTier: standard\n\n${text}`);
  await build(s.a);
  await tick(300);
  assert.match((await launch(s.a, "reviewer", "review the branch again")).blocked ?? "", REFUSED, "no change since the PASS: a repeat");
  return s;
};

test("PASS, then an upsert of an item's text: the next reviewer launch is not refused", async (t) => {
  const { a } = await passed(t);
  assert.match(await ledger(a, { action: "upsert", item: 1, text: "item, reworded" }), /upserted 1/);
  assert.equal((await launch(a, "reviewer", "review the branch again")).blocked, null);
});

test("PASS, then an added item: the next reviewer launch is not refused", async (t) => {
  const { a } = await passed(t);
  await ledger(a, { action: "add", text: "a new item" });
  assert.equal((await launch(a, "reviewer", "review the branch again")).blocked, null);
});

test("PASS, then a direct write of the ledger file: the next reviewer launch is not refused", async (t) => {
  const { a, w } = await passed(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  await a.fire("tool_result", { toolName: "edit", toolCallId: "ed1", input: { path: file }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  assert.equal((await launch(a, "reviewer", "review the branch again")).blocked, null);
});

test("PASS, then mark, note and defer through the tool: still refused; an unchanged upsert is no change", async (t) => {
  const { a } = await passed(t, "- [ ] 1. one\n- [ ] 2. two\n- [ ] 3. three\n- [x] V. fresh-eyes verification passed\n");
  await ledger(a, { action: "upsert", item: 1, text: "one" }); // the same text: a no-op
  await ledger(a, { action: "mark", items: [1], text: "done" });
  await ledger(a, { action: "note", item: 2, text: "a note" });
  await ledger(a, { action: "defer", item: 3, text: "later" });
  assert.match((await launch(a, "reviewer", "review the branch again")).blocked ?? "", REFUSED);
});

test("a reload alone changes nothing: the next reviewer launch is still refused", async (t) => {
  const { a, w } = await passed(t);
  await a.down();
  const b = await w.adapter("reload");
  assert.match((await launch(b, "reviewer", "review the branch again")).blocked ?? "", REFUSED);
});

test("the count survives a reload: an upsert before it still lets the next reviewer launch through", async (t) => {
  const { a, w } = await passed(t);
  await ledger(a, { action: "upsert", item: 1, text: "item, reworded" });
  await tick(50);
  await a.down();
  const b = await w.adapter("reload");
  assert.equal((await launch(b, "reviewer", "review the branch again")).blocked, null);
});

test("planstate: the ledger count is written when set and read back; an entry without it loads as no count", async () => {
  const { buildCeremonyState, latestCeremonyState, CEREMONY_ENTRY } = await import("../planstate.ts");
  const entry = (data: unknown) => [{ type: "custom", customType: CEREMONY_ENTRY, data }];
  const base = { plan: null, lineages: [], planPhase: false };
  assert.equal(latestCeremonyState(entry(buildCeremonyState({ ...base, ledgerRev: 3 })))?.ledgerRev, 3);
  assert.equal("ledgerRev" in buildCeremonyState(base), false);
  assert.equal(latestCeremonyState(entry(buildCeremonyState(base)))?.ledgerRev, undefined);
  assert.equal(latestCeremonyState(entry({ ...buildCeremonyState(base), ledgerRev: "x" }))?.ledgerRev, undefined);
});
