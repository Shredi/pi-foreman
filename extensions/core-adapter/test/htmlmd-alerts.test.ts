// htmlmd: alert blockquotes and a heading inside <summary> convert back to the markdown the pages are made from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown } from "../htmlmd.ts";

const md = (html: string): string => htmlToMarkdown(html).markdown;

test("htmlmd: a data-alert blockquote becomes a marker line and a quoted body, for each of the five types", () => {
  for (const t of ["note", "tip", "important", "warning", "caution"]) {
    assert.equal(md(`<blockquote class="callout callout-${t}" data-alert="${t}"><p><strong>Label</strong></p><ul><li>a</li><li>b</li></ul></blockquote>`), `> [!${t.toUpperCase()}]\n> **Label**\n>\n> - a\n> - b\n`);
  }
  assert.equal(md('<blockquote data-alert="WARNING"><p>x</p></blockquote>'), "> [!WARNING]\n> x\n");
});

test("htmlmd: another data-alert value, none, or an empty body stays a plain quote or nothing", () => {
  assert.equal(md('<blockquote data-alert="bug"><p>x</p></blockquote>'), "> x\n");
  assert.equal(md('<blockquote data-alert=""><p>x</p></blockquote>'), "> x\n");
  assert.equal(md("<blockquote><p>x</p></blockquote>"), "> x\n");
  assert.equal(md('<blockquote data-alert="note"></blockquote>'), "");
});

test("htmlmd: a heading as the whole summary is that heading, any other summary stays bold", () => {
  assert.equal(md('<details class="fold" id="plan"><summary><h2>Plan</h2></summary><p>Text</p></details>'), "## Plan\n\nText\n");
  assert.equal(md("<details><summary> <h3>Inner <code>x</code></h3> </summary><p>t</p></details>"), "### Inner `x`\n\nt\n");
  assert.equal(md("<details><summary>Plain</summary><p>t</p></details>"), "**Plain**\n\nt\n");
  assert.equal(md("<details><summary>Lead <h2>Mixed</h2></summary><p>t</p></details>"), "**Lead Mixed**\n\nt\n");
  assert.equal(md("<dl><dt><h2>x</h2></dt></dl>"), "**x**\n");
});

test("htmlmd: the hidden-style facts of the new markup are unchanged", () => {
  const r = htmlToMarkdown('<blockquote class="callout" data-alert="note"><p>x</p></blockquote><details><summary><h2>H</h2></summary>y</details>');
  assert.deepEqual(r.hidden, []);
  const hidden = htmlToMarkdown('<blockquote data-alert="note" style="display:none"><p>x</p></blockquote>');
  assert.deepEqual(hidden.hidden, [{ kind: "display:none", count: 1 }]);
});
