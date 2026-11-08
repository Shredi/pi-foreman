// jargonHits: product names such as Node.js are plain words; file names stay flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jargonHits } from "../ownertext.ts";

test("capitalised product names ending in .js are not jargon", () => {
  assert.deepEqual(jargonHits("We run Node.js and Next.js for the site."), []);
});

test("file names stay flagged", () => {
  assert.deepEqual(jargonHits("See x.ts and README.md for details."), ["x.ts", "README.md"]);
});
