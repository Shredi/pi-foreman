// D31 on Windows: the ledger path a task names may use backslashes, a drive letter in any case, or mixed separators.
// Pure checks that run on every platform; the end-to-end cases are in ledger-by-path.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { namedLedgerPaths, samePath, taskLedger } from "../ledgerpath.ts";

test("namedLedgerPaths takes backslash, drive-letter and mixed forms", () => {
  assert.deepEqual(namedLedgerPaths("build item 1 of C:\\Users\\me\\proj\\.workflow\\LEDGER-a.md now"), ["C:\\Users\\me\\proj\\.workflow\\LEDGER-a.md"]);
  assert.deepEqual(namedLedgerPaths("see c:/Users/me/proj/.workflow/LEDGER-a.md"), ["c:/Users/me/proj/.workflow/LEDGER-a.md"]);
  assert.deepEqual(namedLedgerPaths("see C:\\Users/me\\proj/.workflow\\LEDGER-a.md."), ["C:\\Users/me\\proj/.workflow\\LEDGER-a.md"]);
  assert.deepEqual(namedLedgerPaths("`.workflow\\LEDGER-x.md`"), [".workflow\\LEDGER-x.md"]);
});

test("namedLedgerPaths refuses non-ledger names and counts a repeated path once", () => {
  assert.deepEqual(namedLedgerPaths("C:\\p\\.workflow\\notes.md"), []);
  assert.deepEqual(namedLedgerPaths("C:\\p\\.workflow\\LEDGER-a-archive.md"), []);
  assert.deepEqual(namedLedgerPaths("C:\\p\\.workflow\\LEDGER-a.md and C:\\p\\.workflow\\LEDGER-a.md"), ["C:\\p\\.workflow\\LEDGER-a.md"]);
  assert.equal(namedLedgerPaths("C:\\p\\.workflow\\LEDGER-a.md C:\\p\\.workflow\\LEDGER-b.md").length, 2);
});

test("samePath is case-insensitive on win32 only", () => {
  assert.equal(samePath("C:\\Proj\\.workflow", "c:\\proj\\.WORKFLOW", "win32"), true);
  assert.equal(samePath("C:\\Proj\\.workflow", "C:\\Other\\.workflow", "win32"), false);
  assert.equal(samePath("/a/B", "/a/b", "linux"), false);
  assert.equal(samePath("/a/b", "/a/b", "darwin"), true);
});

test("taskLedger keeps the bound ledger for a Windows path that does not exist here", () => {
  const t = taskLedger("build item 1 of C:\\nope\\.workflow\\LEDGER-a.md", process.cwd(), "/bound/.workflow/LEDGER-b.md", []);
  assert.equal(t.named, false);
  assert.equal(t.path, "/bound/.workflow/LEDGER-b.md");
});
