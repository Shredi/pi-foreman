// R16 item 7 (P3): the R14 chair's dialog misses as named cases (fixtures/r16-dialogs.json): the self-ruling refusals (self_ruling_refusal),
// the own run dirs and results JSON (own_run_dir), the own bg outputs (own_bg_output), and the trace reads (trace_read, not state_usage_read).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { DIALOG_FAMILIES, dialogFamily, dialogFields, dialogReport } from "../dialogs.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FX: { cases: { name: string; line: string; family: string }[] } = JSON.parse(fs.readFileSync(path.join(dir, "fixtures", "r16-dialogs.json"), "utf8"));

for (const c of FX.cases) {
  test(`r16 dialog ${c.name} is ${c.family}`, () => {
    assert.equal(dialogFamily(c.line), c.family);
  });
}

test("r16 dialogs: the self_ruling_refusal and trace_read families are listed", () => {
  assert.ok((DIALOG_FAMILIES as readonly string[]).includes("self_ruling_refusal"));
  assert.ok((DIALOG_FAMILIES as readonly string[]).includes("trace_read"));
});

test("r16 dialogs: the fixture's per-family counts are what foreman_dialogs reports", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r16d-")));
  t.after(() => rmTestTmp(root));
  const file = path.join(root, "trace-r16.jsonl");
  // the records index.ts emits for an asked overlay line: the family is decided at emit time from the raw command
  fs.writeFileSync(file, FX.cases.map((c) => JSON.stringify({ event: "overlay", toolFamily: "bash", decision: "ask-approved", command: c.line, ...dialogFields(c.line) })).join("\n") + "\n");
  const rep = dialogReport(file);
  const want: Record<string, number> = Object.fromEntries(DIALOG_FAMILIES.map((f) => [f, 0]));
  for (const c of FX.cases) want[c.family]++;
  for (const f of DIALOG_FAMILIES) assert.equal(rep[f].count, want[f], f);
});
