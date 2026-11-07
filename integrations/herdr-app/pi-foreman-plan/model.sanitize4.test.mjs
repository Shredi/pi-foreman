import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./model.js";

const IMG = /(^|[^\\])!\[/;

test("a backslash-escaped backtick does not hide an image", () => {
  const out = sanitize("\\`![a](https://t/x.png)`");
  assert.ok(!IMG.test(out), out);
});

test("a fence inside a list item does not hide an image", () => {
  const out = sanitize("- item\n  ```\n  ![a](https://t/x.png)\n  ```\n");
  assert.ok(!IMG.test(out), out);
});

test("a plain fence has its image syntax escaped", () => {
  assert.equal(sanitize("```\n![x](y)\n```"), "```\n!\\[x](y)\n```");
});

test("an inline code span has its image syntax escaped", () => {
  assert.equal(sanitize("`![x](y)`"), "`!\\[x](y)`");
});

test("an escaped image stays single-escaped", () => {
  const once = sanitize("![x](y)\n```\n![x](y)\n```");
  assert.equal(sanitize(once), once);
  assert.ok(!once.includes("\\\\["), once);
  assert.equal(sanitize("!\\[x](y)"), "!\\[x](y)");
});

test("tags and marks inside a fence stay literal", () => {
  const md = "```\n<x><mark>m</mark><b>\n```";
  assert.equal(sanitize(md), md);
});
