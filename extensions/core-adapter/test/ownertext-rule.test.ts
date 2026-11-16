// The one plain-language rule for owner text: OWNER_TEXT_POINTS is the single source; the foreman prompt carries it verbatim,
// the plan-review facts line points at it, and both hints name owner text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyVariants } from "../ledgercall.ts";
import { OWNER_TEXT_POINTS, ownerFactsLines, questionHint, showHint } from "../ownertext.ts";

const root = path.join(import.meta.dirname, "..", "..", "..");
const rules = fs.readFileSync(path.join(root, "instructions", "foreman.md"), "utf8").replace(/\r\n/g, "\n");
const defaults = { ladder: "on", ownerScript: "on", ownerReadable: "on", reviewMarks: "on", show: "on", protect: "on", proactive: "on" };

test("the rendered foreman prompt carries OWNER_TEXT_POINTS verbatim once, only with ownerReadable on", () => {
  const on = applyVariants(rules, defaults);
  assert.equal(on.split(OWNER_TEXT_POINTS).length - 1, 1);
  assert.match(on, /Text between sessions \(briefs, rulings, results, reports, handoff notes, ledger, commit messages\) stays dense/);
  assert.ok(!applyVariants(rules, { ...defaults, ownerReadable: "off" }).includes(OWNER_TEXT_POINTS));
});

test("the facts line carries the points, also for a plan that cannot be read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-rule-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "# P\n\n## For the owner\nWe ship it.\n");
    const lines = ownerFactsLines(["a.md", "missing.md"], dir);
    for (const l of lines) assert.ok(l.endsWith(`; judge it as owner text: ${OWNER_TEXT_POINTS}`), l);
    assert.match(lines[0], /^Owner section \(a\.md\): present/);
    assert.match(lines[1], /plan not readable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("both hints name owner text and keep their pinned words", () => {
  const q = questionHint({ questions: [{ question: "Change `index.ts`?" }] }, "") ?? "";
  assert.match(q, /owner text.*plain|plain.*owner text/s);
  assert.match(q, /jargon/);
  const h = showHint("") ?? "";
  assert.match(h, /owner text/);
  assert.match(h, /plain 2-3 sentence/);
});
