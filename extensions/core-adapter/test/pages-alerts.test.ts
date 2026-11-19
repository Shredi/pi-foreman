// Alerts, the owner layout, open questions and the fold markup of the markdown pages (pages.ts), and the alert look below an HTML plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldPlanSection, renderHtmlPlanPage, renderMarkdown, renderPage } from "../pages.ts";

const TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const planOpts = { fold: foldPlanSection, ownerLayout: true };

test("alerts: each of the five types renders a callout with its data-alert, the label text decides nothing", () => {
  for (const t of TYPES) {
    const html = renderMarkdown(`> [!${t}]\n> **Anything**\n> body\n`);
    assert.match(html, new RegExp(`^<blockquote class="callout callout-${t.toLowerCase()}" data-alert="${t.toLowerCase()}"><p><strong>Anything</strong> body</p></blockquote>$`));
  }
});

test("alerts: lower case and trailing blanks work, the body is markdown with lists", () => {
  const html = renderMarkdown("> [!warning]  \n> **Heads-up**\n>\n> - a\n> - `b`\n");
  assert.match(html, /<blockquote class="callout callout-warning" data-alert="warning"><p><strong>Heads-up<\/strong><\/p>\n<ul>\n<li>a<\/li>\n<li><code>b<\/code><\/li>\n<\/ul><\/blockquote>/);
});

test("alerts: a marker with text after it, an unknown type, a marker on a later line and an empty body stay plain quotes", () => {
  for (const md of ["> [!NOTE] text\n> body\n", "> [!BUG]\n> body\n", "> first\n> [!NOTE]\n> body\n", "> [!NOTE]\n", "> [!NOTE]\n>\n", "> [!NOTE]\n\ntext\n"]) {
    const html = renderMarkdown(md);
    assert.doesNotMatch(html, /callout|data-alert/, md);
    assert.match(html, /^<blockquote>/, md);
  }
  assert.match(renderMarkdown("> [!NOTE] text\n> body\n"), /\[!NOTE\] text/);
});

test("alerts: a plain quote is unchanged", () => {
  assert.equal(renderMarkdown("> quoted\n"), "<blockquote><p>quoted</p></blockquote>");
});

test("alerts: a note page renders them with the base style and no owner layout", () => {
  const html = renderPage({ title: "N", kicker: "Note v1", markdown: "> [!TIP]\n> **Next**\n> go\n", source: "note.md" });
  assert.match(html, /<blockquote class="callout callout-tip" data-alert="tip">/);
  assert.match(html, /\.callout\{/);
  assert.doesNotMatch(html, /class="owner"|<body class="plan"|nav class="index"/);
});

test("alerts: the rulings below an HTML plan render them and the block carries the scoped callout style", () => {
  const page = "<!doctype html><html><head><title>t</title></head><body><h1>t</h1></body></html>";
  const html = renderHtmlPlanPage({ title: "t", kicker: "k", html: page, rulings: "> [!NOTE]\n> **Ruling**\n> yes\n", source: "plan.html" });
  assert.match(html, /<blockquote class="callout callout-note" data-alert="note">/);
  assert.match(html, /<section id="pi-foreman-rulings"[^>]*><style>#pi-foreman-rulings\{/);
  assert.match(html, /#pi-foreman-rulings \.callout-warning\{/);
  const none = renderHtmlPlanPage({ title: "t", kicker: "k", html: page, rulings: "", source: "plan.html" });
  assert.doesNotMatch(none, /callout/);
  assert.match(none, /id="pi-foreman-banner"/);
});

const OWNER = (body: string, rest = ""): string => `## For the owner\n${body}\n${rest}`;

test("owner layout: the goal class is on the first block when it is a paragraph, and on nothing else", () => {
  const html = renderMarkdown(OWNER("\n**Goal:** x.\n\nSecond paragraph.\n"), planOpts);
  assert.equal(count(html, /class="goal"/g), 1);
  assert.match(html, /<h2>For the owner<\/h2>\n<p class="goal"><strong>Goal:<\/strong> x\.<\/p>\n<p>Second paragraph\.<\/p>/);
  for (const first of ["- a\n- b\n", "| a | b |\n| --- | --- |\n| 1 | 2 |\n", "1. a\n"]) assert.doesNotMatch(renderMarkdown(OWNER(first), planOpts), /class="goal"/, first);
});

test("owner layout: a top-level ordered list is the path, a nested one and a bullet list are not", () => {
  const html = renderMarkdown(OWNER("\nGoal.\n\n1. one\n   1. inner\n2. two\n\n- bullet\n"), planOpts);
  assert.equal(count(html, /<ol class="path">/g), 1);
  assert.equal(count(html, /<ol/g), 2);
  assert.match(html, /<ul>\n<li>bullet/);
  assert.match(renderMarkdown(OWNER("\n3. three\n4. four\n"), planOpts), /<ol class="path" start="3">/);
});

test("owner layout: only the trailing run of alerts goes to the side column, in source order", () => {
  const a = (t: string): string => `> [!${t}]\n> **${t}**\n> text\n`;
  const html = renderMarkdown(OWNER(`\nGoal.\n\n${a("NOTE")}\n${a("TIP")}\nAfter.\n\n${a("WARNING")}\n${a("CAUTION")}`), planOpts);
  const side = html.slice(html.indexOf('<div class="o-side">'));
  assert.equal(count(side, /<blockquote/g), 2);
  assert.match(side, /callout-warning[\s\S]*callout-caution/);
  const main = html.slice(0, html.indexOf('<div class="o-side">'));
  assert.match(main, /callout-note[\s\S]*callout-tip[\s\S]*<p>After\.<\/p>/);
  assert.equal(count(html, /<blockquote/g), 4);
});

test("owner layout: with no trailing alert there is no side column", () => {
  const html = renderMarkdown(OWNER("\nGoal.\n\n1. a\n"), planOpts);
  assert.match(html, /^<section class="owner">\n<div class="o-main">/);
  assert.doesNotMatch(html, /o-side/);
});

test("owner layout: no owner section, no wrapper; fold or a note page alone adds none; the heading is not repeated", () => {
  assert.doesNotMatch(renderMarkdown("## Work\n\n1. a\n", planOpts), /class="owner"/);
  const md = OWNER("\nGoal.\n\n1. a\n");
  assert.doesNotMatch(renderMarkdown(md, { fold: foldPlanSection }), /class="owner"|class="goal"|class="path"/);
  assert.doesNotMatch(renderMarkdown(md), /class="owner"/);
  assert.equal(count(renderMarkdown(md, planOpts), /<h2>For the owner<\/h2>/g), 1);
  assert.doesNotMatch(renderPage({ title: "N", kicker: "k", markdown: md, source: "n.md" }), /class="owner"/);
  assert.match(renderPage({ title: "P", kicker: "k", markdown: md, fold: foldPlanSection, source: "p.md" }), /<section class="owner">/);
});

test("open questions: highlighted with the owner layout, plain without it", () => {
  const md = "## Work\n\nx\n\n## Open questions\n\n1. Which one?\n";
  assert.match(renderMarkdown(md, planOpts), /<section class="questions">\n<h2>Open questions<\/h2>\n<ol>\n<li>Which one\?<\/li>\n<\/ol>\n<\/section>/);
  assert.doesNotMatch(renderMarkdown(md, { fold: foldPlanSection }), /questions"/);
  assert.doesNotMatch(renderMarkdown(md), /questions"/);
});

test("fold: the summary holds the h2, ids are unique slugs, heading text is escaped", () => {
  const md = "## Notes\n\na\n\n## Notes\n\nb\n\n## <b>Odd & \"quoted\"</b> `x`\n\nc\n\n## ###\n\nd\n";
  const html = renderMarkdown(md, { fold: () => true });
  assert.match(html, /<details class="fold" id="notes"><summary><h2>Notes<\/h2><\/summary>/);
  assert.match(html, /<details class="fold" id="notes-2"><summary><h2>Notes<\/h2><\/summary>/);
  assert.match(html, /id="b-odd-quoted-b-x"><summary><h2>&lt;b&gt;Odd &amp; &quot;quoted&quot;&lt;\/b&gt; <code>x<\/code><\/h2>/);
  assert.equal(count(html, /id="([^"]*)"/g), 4);
  assert.equal(new Set([...html.matchAll(/id="([^"]*)"/g)].map((m) => m[1])).size, 4);
  assert.doesNotMatch(html, /<b>/);
});

test("fold: the page index lists the folded sections only, after the owner section", () => {
  const md = "# T\n\n## For the owner\n\nGoal.\n\n## Work & more\n\nx\n\n## Open questions\n\nNone.\n\n## Notes\n\ny\n";
  const html = renderPage({ title: "T", kicker: "k", markdown: md, fold: foldPlanSection, source: "p.md" });
  const nav = /<nav class="index"><span>In the details<\/span>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
  assert.equal(nav, '<a href="#work-more">Work &amp; more</a><a href="#notes">Notes</a>');
  assert.ok(html.indexOf('<section class="owner">') < html.indexOf('<nav class="index">'));
  assert.ok(html.indexOf('<nav class="index">') < html.indexOf('id="work-more"'));
  assert.match(html, /<body class="plan">/);
  const none = renderPage({ title: "T", kicker: "k", markdown: "## For the owner\n\nGoal.\n", fold: foldPlanSection, source: "p.md" });
  assert.doesNotMatch(none, /<nav/);
  const noOwner = renderPage({ title: "T", kicker: "k", markdown: "## Work\n\nx\n", fold: foldPlanSection, source: "p.md" });
  assert.ok(noOwner.indexOf("<nav") < noOwner.indexOf("<details"));
});

test("fold: a link in a heading does not nest a link in the index", () => {
  const html = renderPage({ title: "T", kicker: "k", markdown: "## See [docs](https://example.com/a)\n\nx\n", fold: foldPlanSection, source: "p.md" });
  assert.match(html, /<nav class="index"><span>In the details<\/span><a href="#see-docs-https-example-com-a">See docs<\/a><\/nav>/);
});
