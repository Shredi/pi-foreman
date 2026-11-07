import test from "node:test";
import assert from "node:assert/strict";
import { markBlocks, compareTarget, isAppendixLine, MAX_LINES } from "./model.js";

const marks = (text, base) => markBlocks(text, base).blocks.map((b) => [b.mark, b.text.split("\n")[0]]);

const BASE = "# Plan\n\n## Goal\nShow the plan.\n\n## Phases\n\n| Phase | What |\n|---|---|\n| 1 | panel |\n\n```ts\nconst a = 1;\n```\n";

test("a block of only inserted lines is NEW, one with some inserted lines is CHANGED, the rest and headings are plain", () => {
  const cur = "# Plan\n\n## Goal\nShow the plan.\n\n> New in v2: a quote\n\n## Phases\n\n| Phase | What |\n|---|---|\n| 1 | panel |\n| 2 | diff |\n\n```ts\nconst a = 1;\n```\n";
  const m = marks(cur, BASE);
  assert.deepEqual(m, [
    [null, "# Plan"], [null, "## Goal"], [null, "Show the plan."], ["new", "> New in v2: a quote"], [null, "## Phases"],
    ["changed", "| Phase | What |"], [null, "```ts"],
  ]);
  assert.equal(markBlocks(cur, BASE).adds, 2);
});

test("a new heading is never marked; the NEW block under it is", () => {
  const m = marks(`${BASE}\n## Extra\n\nbrand new paragraph\n`, BASE);
  assert.deepEqual(m.slice(-2), [[null, "## Extra"], ["new", "brand new paragraph"]]);
});

test("structural lines are ignored: a new fence block counts its content lines, a lone new marker line counts nothing", () => {
  const cur = `${BASE}\n\`\`\`py\nprint(1)\n\`\`\`\n`;
  assert.equal(marks(cur, BASE).at(-1)[0], "new");
  const same = "a\n\n```\nx\n```\n";
  const grown = "a\n\n```\nx\n```\n\n---\n";
  assert.equal(marks(grown, same).at(-1)[0], null, "a thematic break alone has no counted line");
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  assert.deepEqual(marks(table, ""), [["new", "| a | b |"]]);
  assert.deepEqual(marks("| a | b |\n|:--|--:|", "| a | b |\n|---|---|"), [[null, "| a | b |"]], "only the delimiter row differs");
});

test("an inserted blank line or trailing space marks nothing", () => {
  assert.deepEqual(marks("a\n\n\nb  ", "a\n\nb"), [[null, "a"], [null, "b  "]]);
});

test("only the body above the first appendix heading is diffed; an appended ruling is never marked", () => {
  const cur = `${BASE}\n## Ruling\n\nAPPROVED by the parent.\n\n## Addendum\n\n1. nit\n`;
  const r = markBlocks(cur, BASE);
  assert.equal(r.adds, 0);
  assert.ok(r.blocks.some((b) => b.text.startsWith("APPROVED")) && r.blocks.every((b) => b.mark === null));
  // a changed ruling in the base is no change either
  assert.equal(markBlocks(BASE, `${BASE}\n## Ruling\nold\n`).adds, 0);
  assert.equal(isAppendixLine("## Decision log"), true);
  assert.equal(isAppendixLine("### Addendum 2"), true);
  assert.equal(isAppendixLine("## Rulings are fine"), false);
  assert.equal(isAppendixLine("<!-- plan-appendix -->  "), true);
  assert.equal(isAppendixLine("## Decisions and assumptions"), false);
});

test("no base: no marks, no badge", () => {
  const r = markBlocks(BASE, null);
  assert.equal(r.adds, 0);
  assert.equal(r.diff, null);
  assert.ok(r.blocks.every((b) => b.mark === null));
  assert.equal(markBlocks(BASE, undefined).adds, 0);
});

test("too large or too different: no marks and the note says why", () => {
  const big = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(markBlocks(big, "x").note, "Plan too large for marks (shown without)");
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join("\n");
  const r = markBlocks(b, a);
  assert.equal(r.note, "too many changes for marks");
  assert.equal(r.adds, 0);
});

test("comparison target: ruled while the hash moved past ruledHash, else prev; none for a foreign or missing snapshot", () => {
  const meta = { path: "/p/plan-x.md", ruledPath: "/p/plan-x.md", hash: "h2", ruledHash: "h1", prevHash: "h0" };
  assert.equal(compareTarget(meta), "ruled");
  assert.equal(compareTarget({ ...meta, hash: "h1" }), "prev");
  assert.equal(compareTarget({ ...meta, hash: "h1", prevHash: "" }), null, "no earlier snapshot: no marks, no fallback to the ruled one");
  assert.equal(compareTarget({ ...meta, ruledPath: "/p/plan-y.md" }), null);
  assert.equal(compareTarget({ ...meta, ruledPath: null }), null);
  assert.equal(compareTarget({ ...meta, path: null }), null);
  assert.equal(compareTarget({ ...meta, ruledHash: "" }), null);
  assert.equal(compareTarget(null), null);
});

test("blocks carry their line range for the diff view", () => {
  const r = markBlocks("a\nb\n\nc", null);
  assert.deepEqual(r.blocks.map((b) => [b.start, b.end]), [[0, 2], [3, 4]]);
});
