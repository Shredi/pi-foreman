import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./model.js";

const RAW_IMG = /(^|[^\\])<img/i;

test("a backslash-escaped backtick before a raw img does not hide it", () => {
  for (const s of ['\\`<img src="x">', 'a \\`<img src="x">`']) {
    const out = sanitize(s);
    assert.ok(!RAW_IMG.test(out), out);
  }
});

test("a list item's fence ends at a less-indented line, whose img is not kept", () => {
  const out = sanitize('- item\n  ```\n  code\n<img src="x">\n  ```\n');
  assert.ok(!RAW_IMG.test(out), out);
});

test("placeholder bytes inside a fenced block are stripped", () => {
  const out = sanitize("```\na\u0001b\u0002c\n```");
  assert.ok(!/[\u0001\u0002]/.test(out), JSON.stringify(out));
  assert.equal(out, "```\nabc\n```");
});
