// Follow-up fixes: linear list scan, no backslash links, an unclosed owner diagram fence counts in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../pages.ts";
import { ownerSectionIssues } from "../ownertext.ts";

test("a list item with 20k blank lines renders fast, and a small case keeps its output", () => {
  const small = renderMarkdown("- a\n\n  b\n- c\n");
  assert.match(small, /<ul>[\s\S]*<li>[\s\S]*a[\s\S]*b[\s\S]*<\/li>[\s\S]*<li>[\s\S]*c[\s\S]*<\/li>[\s\S]*<\/ul>/);
  assert.ok(/<p>a<\/p>/.test(small) && /<p>b<\/p>/.test(small));
  const t0 = Date.now();
  renderMarkdown(`- a\n${"\n".repeat(20000)}  b\n`);
  renderMarkdown(`- a\n${"\n".repeat(20000)}`);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test("a link target with a backslash renders as plain text", () => {
  for (const url of ["\\\\host\\share", "/\\host", "a\\b"]) {
    const html = renderMarkdown(`[x](${url})`);
    assert.ok(!html.includes("<a "), html);
  }
  assert.match(renderMarkdown("[x](https://example.com/a)"), /<a href="https:\/\/example\.com\/a"/);
});

test("a long mermaid fence in the owner section, closed or not, is no length issue", () => {
  const body = Array.from({ length: 40 }, (_v, i) => `node${i}-->n${i + 1}`).join("\n");
  const plan = (fence: string) => `# P\n\n## For the owner\nWe ship it.\n\n${fence}\n\n## Goal\nShip.\n`;
  assert.deepEqual(ownerSectionIssues(plan(`\`\`\`mermaid\n${body}\n\`\`\``)), []);
  assert.deepEqual(ownerSectionIssues(plan(`\`\`\`mermaid\n${body}`)), []);
});
