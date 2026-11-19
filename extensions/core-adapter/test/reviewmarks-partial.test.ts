import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markPassItems } from "../reviewmarks.ts";
import { checkVerdictCall, type VerdictItem } from "../verdict.ts";

// An item the reviewer gives result `open` with a note is the old PARTIAL: it is never marked, and its note goes to the ledger (reviewer: <note>).
const withLedger = async (fn: (file: string) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rmp-"));
  try {
    const file = path.join(dir, "LEDGER.md");
    fs.writeFileSync(file, "- [ ] 1. a\n- [ ] 2. b\n- [ ] 3. c\n- [x] 4. d\n- [ ] V. v\n");
    await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("markPassItems marks pass items and notes open items that carry a note, only while the item is open", async () => {
  await withLedger(async (file) => {
    const marked: string[] = [];
    const noted: string[][] = [];
    const items: VerdictItem[] = [
      { id: 1, result: "pass", note: "ok" },
      { id: 2, result: "open", note: "config part only" },
      { id: 3, result: "open", note: "deploy open" },
      { id: 4, result: "open", note: "closed meanwhile" },
    ];
    const r = await markPassItems(items, file, async (n) => (marked.push(n), true), async (n, t) => (noted.push([n, t]), true));
    assert.deepEqual(r, { items: ["1"], skipped: [], noted: ["2", "3"] });
    assert.deepEqual(marked, ["1"]);
    assert.deepEqual(noted, [["2", "config part only"], ["3", "deploy open"]]);
  });
});

test("an open item without a note is not noted; V is never noted", async () => {
  await withLedger(async (file) => {
    const noted: string[] = [];
    const r = await markPassItems([{ id: 2, result: "open" }, { id: "V", result: "open", note: "not yet" }], file, async () => true, async (n) => (noted.push(n), true));
    assert.equal(r, null);
    assert.deepEqual(noted, []);
  });
});

test("the verdict check bounds a note: one line, at most 200 characters", () => {
  const ok = checkVerdictCall({ verdict: "pass", items: [{ id: 2, result: "open", note: "x".repeat(200) }] }, [2]);
  assert.ok("call" in ok);
  assert.equal(ok.call.items[0].note?.length, 200);
  assert.ok("error" in checkVerdictCall({ verdict: "pass", items: [{ id: 2, result: "open", note: "x".repeat(201) }] }, [2]));
  assert.ok("error" in checkVerdictCall({ verdict: "pass", items: [{ id: 2, result: "open", note: "a\nb" }] }, [2]));
});
