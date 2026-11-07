import test from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, fenceOpen, fenceCloses, toLines } from "./model.js";

const split = (md) => { const lines = toLines(md); return splitBlocks(lines).map((b) => [b.kind, lines.slice(b.start, b.end).join("\n")]); };

test("paragraphs, lists and tables split on blank lines; a heading is a block of its own", () => {
  const md = "# Title\nintro line\nsecond line\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n## Next\ntext";
  assert.deepEqual(split(md), [
    ["heading", "# Title"], ["text", "intro line\nsecond line"], ["text", "- a\n- b"],
    ["text", "| x | y |\n|---|---|\n| 1 | 2 |"], ["heading", "## Next"], ["text", "text"],
  ]);
});

test("a fence stays whole across blank lines and lines that look like headings", () => {
  const md = "before\n```ts\n# not a heading\n\ncode\n```\nafter";
  assert.deepEqual(split(md), [["text", "before"], ["fence", "```ts\n# not a heading\n\ncode\n```"], ["text", "after"]]);
});

test("a fence closes only with the same character and at least the opening length", () => {
  assert.deepEqual(split("````\n```\ninner\n```\n````\nx"), [["fence", "````\n```\ninner\n```\n````"], ["text", "x"]]);
  assert.deepEqual(split("~~~\n```\n~~\n~~~\nx"), [["fence", "~~~\n```\n~~\n~~~"], ["text", "x"]]);
  assert.deepEqual(split("```\nbody\n~~~\nstill\n````\nx"), [["fence", "```\nbody\n~~~\nstill\n````"], ["text", "x"]]);
});

test("an unclosed fence runs to the end of the document", () => {
  assert.deepEqual(split("a\n\n```\nx\n\ny"), [["text", "a"], ["fence", "```\nx\n\ny"]]);
});

test("fence marker lines are recorded; a backtick fence info string holds no backtick", () => {
  const lines = toLines("```js\nx\n```");
  assert.deepEqual(splitBlocks(lines)[0].fenceMarkers, [0, 2]);
  assert.equal(fenceOpen("``` a`b"), null);
  assert.deepEqual(fenceOpen("~~~ a`b"), { ch: "~", len: 3, info: "a`b" });
  assert.equal(fenceCloses("```  ", { ch: "`", len: 3 }), true);
  assert.equal(fenceCloses("``` x", { ch: "`", len: 3 }), false);
  assert.equal(fenceCloses("``", { ch: "`", len: 3 }), false);
});

test("CRLF input splits like LF input", () => {
  assert.deepEqual(split("a\r\n\r\nb"), [["text", "a"], ["text", "b"]]);
});
