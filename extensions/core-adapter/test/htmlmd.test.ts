import { test } from "node:test";
import assert from "node:assert/strict";
import { HTML_MAX_BYTES, hiddenFactsLine, htmlToMarkdown, mermaidPres, normalizedPage } from "../htmlmd.ts";

const md = (html: string): string => htmlToMarkdown(html).markdown;

test("htmlmd: headings, paragraphs, emphasis, code, links", () => {
  const out = md("<h1>Title</h1><p>one <strong>two</strong> <em>three</em> <code>x</code></p><h2>Sub</h2><p><a href=\"https://a.example/x\">link</a></p>");
  assert.match(out, /^# Title\n\none \*\*two\*\* \*(three)\* `x`\n\n## Sub\n\n\[link\]\(https:\/\/a\.example\/x\)\n$/);
});

test("htmlmd: a javascript: link keeps its text and drops the target", () => {
  const out = md("<p><a href=\"javascript:alert(1)\">go</a></p>");
  assert.ok(!out.includes("javascript"));
  assert.match(out, /go/);
});

test("htmlmd: lists and nested lists", () => {
  const out = md("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>x</li><li>y</li></ol>");
  assert.match(out, /- a\n {2}- b\n- c/);
  assert.match(out, /1\. x\n2\. y/);
});

test("htmlmd: tables become pipe tables", () => {
  const out = md("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
  assert.match(out, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
});

test("htmlmd: a mermaid pre becomes a mermaid fence, other pre a plain fence", () => {
  const out = md("<pre class=\"mermaid\">graph TD\n  A-->B</pre><pre><code class=\"language-js\">let a = 1;</code></pre>");
  assert.match(out, /```mermaid\ngraph TD\n {2}A-->B\n```/);
  assert.match(out, /```js\nlet a = 1;\n```/);
});

test("htmlmd: entities decode; script and style text is dropped; comments are dropped", () => {
  const out = md("<p>a &amp; b &lt;c&gt; &#65; &#x42;</p><script>alert(1)</script><style>p{color:red}</style><!-- note -->");
  assert.match(out, /a & b <c> A B/);
  assert.ok(!/alert|color:red|note/.test(out));
});

test("htmlmd: CRLF and BOM are normalised, output is deterministic", () => {
  const a = md("﻿<h1>T</h1>\r\n<p>x</p>\r\n");
  assert.equal(a, md("<h1>T</h1>\n<p>x</p>\n"));
  assert.ok(!a.includes("\r"));
  assert.equal(md("<p>x</p>"), md("<p>x</p>"));
});

test("htmlmd: unknown tags keep their text; unclosed tags and implied end tags do not lose text", () => {
  const out = md("<p>one<p>two<custom-tag>three</custom-tag><ul><li>a<li>b");
  for (const w of ["one", "two", "three", "a", "b"]) assert.ok(out.includes(w), w);
});

test("htmlmd: title from the first h1, else the title element", () => {
  assert.equal(htmlToMarkdown("<title>T1</title><h1>H1</h1>").title, "H1");
  assert.equal(htmlToMarkdown("<title>T1</title><p>x</p>").title, "T1");
});

test("htmlmd: hidden-style facts count what the copy does not show", () => {
  const r = htmlToMarkdown("<p style=\"display:none\">a</p><p hidden>b</p><span style=\"font-size:0\">c</span><div style=\"opacity:0\">d</div><style>p::after{content:'x'}</style>");
  const line = hiddenFactsLine(r.hidden);
  assert.match(line, /display:none/);
  assert.match(line, /hidden attribute/);
  assert.match(line, /font-size:0/);
  assert.match(line, /opacity:0/);
  assert.equal(hiddenFactsLine([]), null);
});

test("htmlmd: input over the bound is cut and flagged", () => {
  const r = htmlToMarkdown(`<p>${"x".repeat(HTML_MAX_BYTES + 10)}</p>`);
  assert.equal(r.truncated, true);
  assert.equal(htmlToMarkdown("<p>x</p>").truncated, false);
});

test("htmlmd: adversarial 256 KiB inputs finish quickly", () => {
  const inputs = [
    "<".repeat(HTML_MAX_BYTES),
    "<div>".repeat(Math.floor(HTML_MAX_BYTES / 5)),
    "<a ".repeat(Math.floor(HTML_MAX_BYTES / 3)),
    "<li><ul>".repeat(Math.floor(HTML_MAX_BYTES / 8)),
    "<!--".repeat(Math.floor(HTML_MAX_BYTES / 4)),
    "<p x=\"".repeat(Math.floor(HTML_MAX_BYTES / 6)),
    "&amp;".repeat(Math.floor(HTML_MAX_BYTES / 5)),
    "<table><tr><td>".repeat(Math.floor(HTML_MAX_BYTES / 15)),
  ];
  for (const html of inputs) {
    const t = Date.now();
    htmlToMarkdown(html);
    assert.ok(Date.now() - t < 5000, `slow input ${html.slice(0, 12)}`);
  }
});

test("htmlmd: mermaidPres spans index the normalized page and carry the copy's diagram text", () => {
  const html = "<html><body><p>x</p><pre class=\"mermaid\">graph TD\n A-->B</pre><pre>plain</pre></body></html>";
  const pres = mermaidPres(html);
  assert.equal(pres.length, 1);
  const page = normalizedPage(html);
  assert.ok(page.slice(pres[0].start, pres[0].end).startsWith("<pre class=\"mermaid\">"));
  assert.ok(page.slice(pres[0].start, pres[0].end).endsWith("</pre>"));
  assert.match(pres[0].text, /^graph TD/);
});
