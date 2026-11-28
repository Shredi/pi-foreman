// instructions/brief-skeleton.html converts to a copy with the goal, steps, boxes and `## Suggested skills`, and holds no hidden-style text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "../htmlmd.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("brief skeleton: goal, numbered steps, a diagram, boxes, the sections and no hidden facts", () => {
  const r = htmlToMarkdown(fs.readFileSync(path.join(root, "instructions", "brief-skeleton.html"), "utf8"));
  assert.equal(r.title, "Brief title");
  assert.match(r.markdown, /^# Brief title\n\n## Summary\n\n\*\*Goal:\*\* /);
  assert.match(r.markdown, /\n1\. The first step, short\.\n2\. /);
  assert.match(r.markdown, /```mermaid\nflowchart LR/);
  assert.match(r.markdown, /> \[!WARNING\]/);
  assert.match(r.markdown, /> \[!NOTE\]/);
  for (const h of ["## Task", "## Artifacts", "## Constraints", "## Suggested skills"]) assert.ok(r.markdown.includes(`\n${h}\n`), h);
  assert.doesNotMatch(r.markdown, /report back/i);
  assert.deepEqual(r.hidden, []);
});

test("foreman.md names the brief skeleton by placeholder, once, and the skeleton file exists", () => {
  const text = fs.readFileSync(path.join(root, "instructions", "foreman.md"), "utf8");
  assert.equal(text.split("{{briefSkeleton}}").length - 1, 1);
  assert.ok(fs.existsSync(path.join(root, "instructions", "brief-skeleton.html")));
});
