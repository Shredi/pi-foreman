import { test } from "node:test";
import assert from "node:assert/strict";
import { passItemsOf, stripLineDecoration, verdictItemsOf } from "../reviewmarks.ts";

test("passItemsOf: plain, backticked, bold, paren, list and doubled bench forms", () => {
  for (const line of ["1. PASS", "`1. PASS`", "**1. PASS**", "1) PASS", "- 1. PASS", "* 1. PASS evidence", "1. `1. PASS`", "  1.PASS ok"]) {
    assert.deepEqual(passItemsOf(`${line} - evidence`), ["1"], line);
  }
  assert.deepEqual(passItemsOf("1. PASS a\n2. FAIL b\n`3. PASS`\n1. PASS again"), ["1", "3"]);
});

test("passItemsOf: PASSED in prose, PASS in a fenced block and 10. PASS do not mark item 1", () => {
  assert.deepEqual(passItemsOf("1. PASSED the tests, I think"), []);
  assert.deepEqual(passItemsOf("example:\n```\n1. PASS\n```\nnothing else"), []);
  assert.deepEqual(passItemsOf("10. PASS"), ["10"]);
  assert.deepEqual(passItemsOf("Overall: PASS, 1 file"), []);
});

test("verdictItemsOf reads FAIL lines with the same tokenizer; stripLineDecoration is exported", () => {
  assert.deepEqual(verdictItemsOf("**2. FAIL** missing test\n- `3) FAIL`", "FAIL"), ["2", "3"]);
  assert.equal(stripLineDecoration("- **`1. PASS`"), "1. PASS`");
});
