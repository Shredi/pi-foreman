// Linear inline and heading patterns, single escaping of link targets, and the plan page state after a reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { planVersionHash } from "../checkpoint.ts";
import { renderMarkdown } from "../pages.ts";
import type { PagesIndex } from "../pages.ts";
import { Show } from "../show.ts";

const timed = (label: string, fn: () => void) => {
  const t0 = Date.now();
  fn();
  assert.ok(Date.now() - t0 < 300, `${label} took ${Date.now() - t0} ms`);
};

test("a heading line of 80k spaces, and unclosed emphasis of 20k openers, render in under 300 ms", () => {
  timed("spaces", () => renderMarkdown(`# a${" ".repeat(80000)}b`));
  timed("trailing spaces", () => renderMarkdown(`# a${" ".repeat(80000)}`));
  timed("hash spaces", () => renderMarkdown(`#${" ".repeat(80000)}`));
  timed("**", () => renderMarkdown("**x ".repeat(20000)));
  timed("__", () => renderMarkdown("__x ".repeat(20000)));
  timed("~~", () => renderMarkdown("~~x ".repeat(20000)));
});

test("ordinary headings and emphasis render as before", () => {
  assert.match(renderMarkdown("# Title\n"), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown("### Title ###\n"), /<h3>Title<\/h3>/);
  assert.match(renderMarkdown("## Title   ##   \n"), /<h2>Title<\/h2>/);
  assert.match(renderMarkdown("## C#\n"), /<h2>C#<\/h2>/);
  assert.match(renderMarkdown("#   spaced  \n"), /<h1>spaced<\/h1>/);
  assert.ok(!/<h\d>/.test(renderMarkdown("#nospace\n")));
  assert.ok(!/<h\d>/.test(renderMarkdown("####### seven\n")));
  assert.match(renderMarkdown("a **b** c __d__ e ~~f~~ g\n"), /<p>a <strong>b<\/strong> c <strong>d<\/strong> e <del>f<\/del> g<\/p>/);
  assert.match(renderMarkdown("**a**b**c**\n"), /<strong>a<\/strong>b<strong>c<\/strong>/);
  assert.match(renderMarkdown("**a\nb**\n"), /<strong>a b<\/strong>/);
  assert.match(renderMarkdown("snake__case__word\n"), /snake__case__word/);
  assert.match(renderMarkdown("** x ** and **y**\n"), /\*\* x \*\* and <strong>y<\/strong>/);
  assert.match(renderMarkdown("*one* and _two_\n"), /<em>one<\/em> and <em>two<\/em>/);
});

test("a link target with a quote is escaped once", () => {
  const html = renderMarkdown('[x](https://example.com/a"b)');
  assert.match(html, /<a href="https:\/\/example\.com\/a&quot;b">/);
  assert.ok(!html.includes("&amp;quot;"), html);
  assert.match(renderMarkdown("[x](https://example.com/?a=1&b=2)"), /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
});

test("plan page: an approved plan stays approved after a reload when the plan is unchanged", async (t) => {
  const root = fs.realpathSync.native(mkTestTmp("pf-pages-lin-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  for (const d of [path.join(ws, ".git"), scratch, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const plan = path.join(scratch, "plan-widget.md");
  const A = "# Plan A\n\n## For the owner\nShip it.\n\n## Goal\nShip it.\n";
  fs.writeFileSync(plan, A);
  const start = () => Show.start({ agentDir: path.join(root, "agent"), sessionId: "sess-1", cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: null })!;
  const first = start();
  await first.checkpointed(plan);
  first.planDecided("approved", planVersionHash(Buffer.from(A)));
  await first.idle();
  const state = (s: Show) => (JSON.parse(fs.readFileSync(path.join(s.dir, "pages", "pages.json"), "utf8")) as PagesIndex).pages.find((p) => p.id === "plan")!.state;
  assert.equal(state(first), "approved");
  const second = start();
  second.planWritten(plan);
  await second.idle();
  assert.equal(state(second), "approved");
  assert.match(fs.readFileSync(path.join(second.dir, "pages", "plan.html"), "utf8"), /Plan v1 · approved/);
  fs.writeFileSync(plan, `${A}\nMore.\n`);
  second.planWritten(plan);
  await second.idle();
  assert.equal(state(second), "draft");
});
