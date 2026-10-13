// R6 lane 7f: the scrub also catches `name.ext:12:3` and `key=file.ext`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubPaths } from "../trace.ts";

test("scrubPaths: a file name with :line:col and a key=file value become [path]", () => {
  assert.equal(scrubPaths("error at index.ts:12:3 in run"), "error at [path] in run");
  assert.equal(scrubPaths("failed file=b.txt retry=3"), "failed file=[path] retry=3");
  assert.equal(scrubPaths("see b.txt:7."), "see [path].");
  assert.equal(scrubPaths("ratio 3:4 mode=fast"), "ratio 3:4 mode=fast");
});
