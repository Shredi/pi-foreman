import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasOpenLedgerLine, markPassItems, openItemsOf } from "../reviewmarks.ts";
import type { VerdictItem } from "../verdict.ts";

const LEDGER = "- [ ] 1. a\n- [ ] 2. b\n- [x] 3. c\n- [ ] 10. j\n- [ ] V. v\n```\n- [ ] 7. fenced\n```\n";
const withLedger = (fn: (file: string) => Promise<void>) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
  try {
    const file = path.join(dir, "LEDGER.md");
    fs.writeFileSync(file, LEDGER);
    await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("openItemsOf: numbered open items outside fences, V left out; hasOpenLedgerLine counts V", () => {
  assert.deepEqual([...openItemsOf(LEDGER)], ["1", "2", "10"]);
  assert.equal(hasOpenLedgerLine("- [x] 1. a\n- [ ] V. v\n"), true);
  assert.equal(hasOpenLedgerLine("- [x] 1. a\n```\n- [ ] 2. b\n```\n"), false);
});

test("markPassItems: only the record's pass items are marked, by id: 10 never marks 1, fail and open items stay", withLedger(async (file) => {
  const marked: string[] = [];
  const items: VerdictItem[] = [{ id: 1, result: "pass" }, { id: 2, result: "fail" }, { id: 10, result: "pass" }];
  const r = await markPassItems(items, file, async (id) => (marked.push(id), true));
  assert.deepEqual(r, { items: ["1", "10"], skipped: [], noted: [] });
  assert.deepEqual(marked, ["1", "10"]);
}));

test("markPassItems: an item closed meanwhile (or never in the ledger, or fenced) is skipped; V goes last and only while open", withLedger(async (file) => {
  const marked: string[] = [];
  const items: VerdictItem[] = [{ id: "V", result: "pass" }, { id: 3, result: "pass" }, { id: 7, result: "pass" }, { id: 2, result: "pass" }];
  const r = await markPassItems(items, file, async (id) => (marked.push(id), true));
  assert.deepEqual(r, { items: ["2", "V"], skipped: ["3", "7"], noted: [] });
  assert.deepEqual(marked, ["2", "V"]);
  fs.writeFileSync(file, "- [ ] 1. a\n- [x] V. v\n");
  assert.deepEqual(await markPassItems([{ id: "V", result: "pass" }], file, async () => true), { items: [], skipped: ["V"], noted: [] });
}));

test("markPassItems: a mark that fails is skipped; no pass item and no note is null; a missing ledger skips everything", withLedger(async (file) => {
  const r = await markPassItems([{ id: 1, result: "pass" }, { id: 2, result: "pass" }], file, async (id) => id === "2");
  assert.deepEqual(r, { items: ["2"], skipped: ["1"], noted: [] });
  assert.equal(await markPassItems([{ id: 1, result: "fail" }, { id: 2, result: "open" }], file, async () => true), null);
  assert.equal(await markPassItems([], file, async () => true), null);
  assert.deepEqual(await markPassItems([{ id: 1, result: "pass" }], `${file}.missing`, async () => true), { items: [], skipped: ["1"], noted: [] });
}));
