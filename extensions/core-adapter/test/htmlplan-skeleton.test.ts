import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "../htmlmd.ts";
import { planFormIssues } from "../ownertext.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("plan skeleton: converts with the owner section first, a mermaid fence, a table and no hidden facts", () => {
  const html = fs.readFileSync(path.join(root, "instructions", "plan-skeleton.html"), "utf8");
  const r = htmlToMarkdown(html);
  assert.equal(r.title, "Plan title");
  assert.match(r.markdown, /^# Plan title\n\n## For the owner\n/);
  assert.match(r.markdown, /```mermaid\nflowchart LR/);
  assert.match(r.markdown, /\| Topic \| Decision \| Reason \|/);
  assert.deepEqual(r.hidden, []);
  assert.deepEqual(planFormIssues(r.markdown, {}), []);
});

test("foreman.md names the skeleton by placeholder, once", () => {
  const text = fs.readFileSync(path.join(root, "instructions", "foreman.md"), "utf8");
  assert.equal(text.split("{{planSkeleton}}").length - 1, 1);
});
