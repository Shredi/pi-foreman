// The harness plan stylesheet: no hidden-style patterns, and the plan skeleton carries it unchanged and converts to the plan text the pages are made from.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "../htmlmd.ts";
import { renderPage, STYLE } from "../pages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skeleton = fs.readFileSync(path.join(root, "instructions", "plan-skeleton.html"), "utf8");

test("stylesheet: the converter finds no hidden-style fact in it", () => {
  assert.deepEqual(htmlToMarkdown(`<style>${STYLE}</style><p>x</p>`).hidden, []);
  assert.deepEqual(htmlToMarkdown(renderPage({ title: "T", kicker: "k", markdown: "## For the owner\n\nGoal.\n", fold: () => true, source: "p.md" })).hidden, []);
});

test("skeleton: its style is the harness plan stylesheet", () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(skeleton)?.[1];
  assert.equal(style, STYLE);
});

test("skeleton: the callouts, goal and numbered steps convert to the plan text", () => {
  const md = htmlToMarkdown(skeleton).markdown;
  assert.match(md, /^# Plan title\n\n## For the owner\n\n\*\*Goal:\*\* one sentence/);
  assert.match(md, /\n1\. The first step, short\.\n2\. The next step, short\.\n/);
  assert.match(md, /\n> \[!WARNING\]\n> \*\*Heads-up\*\*\n>\n> - What could surprise the owner\.\n/);
  assert.match(md, /\n> \[!NOTE\]\n> \*\*Decided for you\*\*\n/);
  assert.match(md, /\n## Reviewer detail: files, callers, tests\n/);
});
