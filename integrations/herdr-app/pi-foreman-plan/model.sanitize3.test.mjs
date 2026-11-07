import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./model.js";

const IMG = /(^|[^\\])!\[/;
const nested = (n, open, close = "") => "!" + open.repeat(n) + close + "[a](https://t/x.png)";

test("ten nested tags before a link cannot rejoin into an image", () => {
  const out = sanitize(nested(10, "<x>"));
  assert.ok(!IMG.test(out), out);
});

test("nine empty marks at depth ten cannot rejoin into an image", () => {
  const direct = sanitize("!" + "<mark></mark>".repeat(9) + "[a](https://t/x.png)");
  assert.ok(!IMG.test(direct), direct);
});

test("depths 1 to 20 never yield an image or a raw tag", () => {
  for (const open of ["<x>", "<mark></mark>", "<b>", "<!-- -->"]) {
    for (let n = 1; n <= 20; n++) {
      for (const links of [true, false]) {
        const out = sanitize(nested(n, open), { links });
        assert.ok(!IMG.test(out), `${open} ${n}: ${out}`);
        assert.ok(!/(^|[^\\])<[A-Za-z]/.test(out.replace(/<(?:del|br|sub|sup|kbd)>/g, "")), `${open} ${n}: ${out}`);
      }
    }
  }
});

test("fences and inline code stay literal in hard mode", () => {
  const md = "```\n<x>![a](b)\n```\n`<x>![a]` " + "<<b>".repeat(12) + "z";
  const out = sanitize(md);
  assert.ok(out.startsWith("```\n<x>![a](b)\n```\n`<x>![a]` "), out);
});

test("200k nested marks still finish", () => {
  const out = sanitize("<mark>".repeat(200000) + "x");
  assert.equal(typeof out, "string");
});
