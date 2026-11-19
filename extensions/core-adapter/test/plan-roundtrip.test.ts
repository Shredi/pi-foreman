// Plan text -> page -> plan text: for each synthetic plan the converted body renders to the same page again (HTML fixed point), and a
// canonical plan comes back byte for byte. Known small losses (table alignment, spaces inside code spans, list tightness) stay out of the fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { foldPlanSection, renderMarkdown } from "../pages.ts";
import { htmlToMarkdown } from "../htmlmd.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plans");
const names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const planOpts = { fold: foldPlanSection, ownerLayout: true };

test("plan fixtures: the set is there", () => {
  assert.deepEqual(names, ["diagram-table.md", "long-folded.md", "many-boxes.md", "note-alert.md", "old-style.md", "open-questions.md", "short.md"]);
});

for (const name of names) {
  const md = fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n");
  const html = renderMarkdown(md, planOpts);
  const back = htmlToMarkdown(html);

  test(`round trip ${name}: the converted body renders to the identical page`, () => {
    assert.deepEqual(back.hidden, []);
    assert.equal(renderMarkdown(back.markdown, planOpts), html);
  });

  test(`round trip ${name}: a canonical plan comes back byte for byte`, () => {
    assert.equal(back.markdown, md);
  });
}

test("round trip: a marker without a body or with text after it stays a plain quote", () => {
  const md = "> [!NOTE]\n\n> [!NOTE] text\n\n> [!BUG]\n> x\n\n> first\n> [!TIP]\n> x\n";
  const html = renderMarkdown(md, planOpts);
  assert.doesNotMatch(html, /callout/);
  assert.equal(renderMarkdown(htmlToMarkdown(html).markdown, planOpts), html);
});

test("known loss: table alignment is lost on the way back, and a page made again from the copy shows it plainly", () => {
  const md = "| a | b |\n| :-- | --: |\n| 1 | 2 |\n";
  const html = renderMarkdown(md);
  assert.match(html, /text-align:left/);
  const back = htmlToMarkdown(html).markdown;
  assert.equal(back, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.doesNotMatch(renderMarkdown(back), /text-align/);
});
