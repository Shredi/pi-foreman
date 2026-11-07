import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "./model.js";

test("every image opener is escaped: inline, reference style, and several on a line", () => {
  assert.equal(sanitize("![a](https://x/y.png)"), "!\\[a](https://x/y.png)");
  assert.equal(sanitize("![ref][1]\n\n[1]: https://x"), "!\\[ref][1]\n\n[1]: https://x");
  assert.equal(sanitize("![a]![b]"), "!\\[a]!\\[b]");
  assert.equal(sanitize("a \\![b]"), "a \\![b]", "an already escaped bang is left alone");
});

test("HTML tags go, the text inside stays, the allow-list keeps its tags without attributes", () => {
  assert.equal(sanitize("<script>alert(1)</script>x"), "alert(1)x");
  assert.equal(sanitize('<img src="https://t/x.png" onerror="y">after'), "after");
  assert.equal(sanitize('<a href="https://x">link</a>'), "link");
  assert.equal(sanitize('<mark class="x" style="color:red">m</mark> <del>d</del> <sub>s</sub><sup>u</sup> <kbd>k</kbd>'), "<mark>m</mark> <del>d</del> <sub>s</sub><sup>u</sup> <kbd>k</kbd>");
  assert.equal(sanitize("a<br/>b<br />c<BR>d"), "a<br>b<br>c<br>d");
  assert.equal(sanitize("<iframe src=x></iframe><div>y</div>"), "y");
  assert.equal(sanitize("<!-- hidden -->visible"), "visible");
  assert.equal(sanitize("a <!-- multi\nline --> b"), "a \n b", "a comment across lines is dropped");
});

test("comparison signs that are not tags stay", () => {
  assert.equal(sanitize("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
  assert.equal(sanitize("a<b"), "a\\<b", "a bracket that could start a tag is escaped");
});

test("an unfinished tag on a line cannot open an HTML block: its bracket is escaped", () => {
  assert.equal(sanitize("<img src=x\nonerror=y>"), "\\<img src=x\nonerror=y>");
});

test("https autolinks stay, other schemes are removed", () => {
  assert.equal(sanitize("see <https://example.org/a?b=1>."), "see <https://example.org/a?b=1>.");
  assert.equal(sanitize("<javascript:alert(1)> <http://x> <mailto:a@b.c>"), "\\<javascript:alert(1)> \\<http://x> \\<mailto:a@b.c>");
});

test("fences and inline code spans stay as written", () => {
  const fence = "```html\n<script>x</script> ![a](b)\n```";
  assert.equal(sanitize(fence), fence);
  assert.equal(sanitize("~~~~\n<b>\n~~~\n![x]\n~~~~\n<b>y</b>"), "~~~~\n<b>\n~~~\n![x]\n~~~~\ny");
  assert.equal(sanitize("use `<b>` and `![a]` then <b>x</b>"), "use `<b>` and `![a]` then x");
  assert.equal(sanitize("two ``a ` <i> `` ok <i>"), "two ``a ` <i> `` ok ");
  assert.equal(sanitize("`unclosed <b>x</b>"), "`unclosed x");
});

test("the document after an unclosed fence stays code", () => {
  assert.equal(sanitize("```\n<b>x</b>\n![a]"), "```\n<b>x</b>\n![a]");
});

test("without a link handler links are inert: inline links become text, autolinks code", () => {
  assert.equal(sanitize("[docs](https://x/y) and <https://z>", { links: false }), "docs and `https://z`");
  assert.equal(sanitize("`[a](b)`", { links: false }), "`[a](b)`");
});
