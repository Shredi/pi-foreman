import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./model.js";

test("text around a removed tag cannot re-form an image tag", () => {
  const out = sanitize("<<span>img src=https://t/x.png>");
  assert.ok(!/<img/i.test(out), out);
});

test("text around a removed tag or comment cannot re-form an image", () => {
  for (const s of ["!<x>[a](https://t/x.png)", "!<!-- -->[a](https://t/x.png)"]) {
    const out = sanitize(s);
    assert.ok(!/(^|[^\\])!\[/.test(out), out);
  }
});

test("a scheme re-joined across a removed tag is stable, and inert without a link handler", () => {
  const s = "[a](java<x>script:alert)";
  const out = sanitize(s);
  assert.equal(sanitize(out), out);
  assert.equal(sanitize(s, { links: false }), "a");
});

test("200k nested marks finish without throwing", () => {
  const out = sanitize("<mark>".repeat(200000) + "x" + "</mark>".repeat(200000));
  assert.equal(out, "**x**");
});

test("a fence holding <<span>img> stays untouched", () => {
  const f = "```\n<<span>img src=https://t/x.png>\n```";
  assert.equal(sanitize(f), f);
});

test("mark whitespace moves outside the asterisks and an empty mark vanishes", () => {
  assert.equal(sanitize("<mark> b </mark>"), " **b** ");
  assert.equal(sanitize("a<mark></mark>b"), "ab");
  assert.equal(sanitize("a<mark>  </mark>b"), "a  b");
});
