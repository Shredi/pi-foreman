import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markPassItems, partialItemsOf, passItemsOf, verdictItemsOf } from "../reviewmarks.ts";

test("unqualified PASS forms mark", () => {
  for (const line of ["1. PASS", "1. PASS: ok", "1. PASS - ok", "1. PASS — ok", "1. PASS evidence here", "**1. PASS** x"]) {
    assert.deepEqual(passItemsOf(line), ["1"], line);
    assert.deepEqual(partialItemsOf(line), [], line);
  }
});

test("qualified PASS and PARTIAL never mark and are partial items", () => {
  for (const line of ["2. PASS (partial)", "2. PASS (config part only) x", "2. PASS [x]", "2. PASS partial", "2. PASS  Partially done", "2. PARTIAL: deploy open"]) {
    assert.deepEqual(passItemsOf(line), [], line);
    assert.deepEqual(partialItemsOf(line).map((p) => p.n), ["2"], line);
  }
  assert.equal(partialItemsOf("- **2. PARTIAL: deploy open**")[0].note, "PARTIAL: deploy open");
  assert.equal(partialItemsOf(`2. PASS (${"x".repeat(300)})`)[0].note.length, 200);
});

test("decorated qualified PASS never marks and is noted; decorated unqualified PASS marks", () => {
  for (const line of ["**1. PASS** (partial)", "1. `PASS` (partial)", "1. `1. PASS` (config part only)", "- **1. PASS** [x]", "**1. PASS** partial"]) {
    assert.deepEqual(passItemsOf(line), [], line);
    assert.deepEqual(partialItemsOf(line).map((p) => p.n), ["1"], line);
  }
  for (const line of ["**1. PASS** x", "`1. PASS`", "1. `1. PASS` - ok"]) {
    assert.deepEqual(passItemsOf(line), ["1"], line);
    assert.deepEqual(partialItemsOf(line), [], line);
  }
});

test("FAIL parsing unchanged; V is never marked or noted", () => {
  assert.deepEqual(verdictItemsOf("1. FAIL a\n2. PASS (partial)\n3. FAIL b", "FAIL"), ["1", "3"]);
  assert.deepEqual(passItemsOf("V. PASS"), []);
  assert.deepEqual(partialItemsOf("V. PASS (partial)\nV. PARTIAL"), []);
});

test("markPassItems marks unqualified and notes open qualified items only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rmp-"));
  const file = path.join(dir, "LEDGER.md");
  fs.writeFileSync(file, "- [ ] 1. a\n- [ ] 2. b\n- [ ] 3. c\n- [x] 4. d\n- [ ] V. v\n");
  const marked: string[] = [];
  const noted: string[][] = [];
  const text = "1. PASS: ok\n2. PASS (config part only)\n3. PARTIAL: deploy open\n4. PASS partial\nV. PASS (x)";
  const r = await markPassItems(text, file, async (n) => (marked.push(n), true), async (n, t) => (noted.push([n, t]), true));
  assert.deepEqual(r, { items: ["1"], skipped: [], noted: ["2", "3"] });
  assert.deepEqual(marked, ["1"]);
  assert.deepEqual(noted, [["2", "PASS (config part only)"], ["3", "PARTIAL: deploy open"]]);
  assert.equal(await markPassItems("nothing here", file, async () => true), null);
  fs.rmSync(dir, { recursive: true });
});
