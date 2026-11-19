// The empty form of `item` reaches foreman_ledger through Pi's own argument check (the registered schema, validateToolArguments), then execute.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { setup } from "./_hsrig.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. one\n- [ ] 2. two\n- [ ] V. fresh-eyes verification passed\n";

test("foreman_ledger: item \"\" passes Pi's check and counts as absent; a non-empty bad item is still refused", async (t) => {
  const { a, w } = await setup(t);
  await a.writeLedger(LEDGER);
  const tool = a.tool("foreman_ledger")! as unknown as { name: string; parameters: unknown; execute: (...x: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> };
  const check = (args: Record<string, unknown>) => validateToolArguments({ name: tool.name, description: "d", parameters: tool.parameters } as never, { type: "toolCall", id: "c", name: tool.name, arguments: args } as never) as Record<string, unknown>;
  const run = async (args: Record<string, unknown>) => tool.execute("id", check(args), undefined, undefined, a.ctx);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");

  const up = await run({ action: "upsert", item: "", entries: [{ item: 2, text: "dos" }] });
  assert.ok(!up.isError, up.content[0].text);
  assert.match(fs.readFileSync(file, "utf8"), /\] 2\. dos/);

  const note = await run({ action: "note", item: "", items: [2], text: "x" });
  assert.ok(!note.isError, note.content[0].text);

  const both = await run({ action: "note", item: "", items: [], text: "x" });
  assert.ok(both.isError);
  assert.match(both.content[0].text, /needs exactly one item/);

  assert.throws(() => check({ action: "upsert", item: "x", entries: [{ text: "t" }] }));
});
