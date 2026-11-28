// D224: the harness-written PASS note is skipped (traced `ledger_note_skipped`) when it would take the item line over the limit, so the mark still closes the item.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;
const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a reviewer PASS closes a 990-character item: the mark goes through without its note", { skip }, async (t) => {
  const entries: unknown[] = [];
  const base = reviewAllowOpts();
  const sessionManager = { getSessionId: () => process.env.PI_INTERCOM_SESSION_ID ?? "", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries };
  const a = await r11Rig(t, { default: "standard" }, {
    ...base,
    ctx: { ...base.ctx, sessionManager },
    piExtra: { appendEntry: (customType: string, data: unknown) => { if (customType === "pi-foreman-ledger-route") entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }); } },
  });
  const ledger = path.join(a.project, ".workflow", "LEDGER-long.md");
  const item = "L".repeat(990 - "- [ ] 1. ".length);
  await a.toolDoing("write", { path: ledger }, () => fs.writeFileSync(ledger, `# Long\n\n- [ ] 1. ${item}\n- [ ] V. verify\n`));
  const input: Record<string, unknown> = { agent: "reviewer", task: "review item 1" };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "long-run-1");
  assert.ok(a.record("long-run-1", { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  a.end({ runId: "long-run-1", agent: "reviewer", status: "completed", success: true, results: [{ agent: "reviewer", status: "completed", success: true, output: "see the record" }] });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/- \[x\] 1\./.test(fs.readFileSync(ledger, "utf8"))) await settle(100);
  const text = fs.readFileSync(ledger, "utf8");
  assert.match(text, /- \[x\] 1\. L+\n/, text);
  assert.ok(!text.includes("verified by reviewer PASS"), "the note was left out");
  assert.equal(a.events("ledger_note_skipped").filter((e) => e.reason === "item line limit").length, 1);
});
