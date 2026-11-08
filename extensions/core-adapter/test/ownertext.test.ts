// Owner-readable text (ownertext.ts): the owner section rules, the facts lines, the checkpoint summary, the question prefix and hint, the show hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ownerFactsLines, ownerSection, ownerSectionIssues, ownerSummary, prefixQuestions, questionHint, questionPrefix, showHint } from "../ownertext.ts";

const GOOD = "# Plan\n\n## For the owner\nWe make the report page faster.\nFirst we measure, then we fix the slowest part.\nHeads-up: the page is briefly slower while we measure.\nWe assume the old report format stays.\n\n## Goal\nShip it.\n";

test("a good owner section has no issues and is found", () => {
  assert.deepEqual(ownerSectionIssues(GOOD), []);
  const s = ownerSection(GOOD)!;
  assert.equal(s.first, true);
  assert.equal(s.lines.length, 4);
});

test("missing, not first, too long and empty are reported", () => {
  assert.deepEqual(ownerSectionIssues("# P\n\n## Goal\nx\n"), ["missing"]);
  assert.ok(ownerSectionIssues("# P\n\n## Goal\nx\n\n## For the owner\nPlain words here.\n").some((i) => /not the first/.test(i)));
  const long = `# P\n\n## For the owner\n${Array.from({ length: 12 }, (_, i) => `Line number ${i} in plain words.`).join("\n")}\n\n## Goal\nx\n`;
  assert.ok(ownerSectionIssues(long).some((i) => /too long/.test(i)));
  const wide = `# P\n\n## For the owner\n${"word ".repeat(250)}\n`;
  assert.ok(ownerSectionIssues(wide).some((i) => /too long/.test(i)), "wrapped at 100 columns and over 1000 characters");
  assert.ok(ownerSectionIssues("# P\n\n## For the owner\n\n## Goal\nx\n").some((i) => /empty/.test(i)));
});

test("an owner heading inside an appendix does not count", () => {
  assert.deepEqual(ownerSectionIssues("# P\n\n## Goal\nx\n\n## Addendum 1: r\n## For the owner\nPlain.\n"), ["missing"]);
});

test("jargon: code spans, paths, identifiers and ids are reported", () => {
  const issue = (line: string) => ownerSectionIssues(`# P\n\n## For the owner\n${line}\n`).some((i) => /jargon/.test(i));
  assert.ok(issue("We change `index.ts` today."));
  assert.ok(issue("We edit extensions/core-adapter/index.ts."));
  assert.ok(issue("We call plan_review again."));
  assert.ok(issue("We rename planFactsBlock."));
  assert.ok(issue("This is ledger item R46 for issue #123."));
  assert.ok(!issue("We make the page faster and keep the old look. Cost is about 5/10 of last time."));
});

test("ownerFactsLines resolves relative paths and names a missing section", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), GOOD);
    fs.writeFileSync(path.join(dir, "b.md"), "# P\n\n## Goal\nx\n");
    const lines = ownerFactsLines(["a.md", "b.md", "c.md"], dir);
    assert.match(lines[0], /Owner section \(a\.md\): present/);
    assert.match(lines[1], /Owner section \(b\.md\): missing/);
    assert.match(lines[2], /not readable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ownerSummary: the section, cleaned, or the warning line", () => {
  const s = ownerSummary(GOOD.replace("faster.", "faster.\u001b[31m"));
  assert.match(s, /^For the owner\n {2}We make the report page faster\./);
  assert.ok(!s.includes("\u001b"));
  assert.match(ownerSummary("# P\n\n## Goal\nx\n"), /^⚠ No "For the owner" summary/);
});

test("question prefix: idempotent, session label only for an opened session", () => {
  const input = { questions: [{ question: "Which way?", options: [{ label: "A" }] }] };
  const p = questionPrefix("widget", "plan-ui");
  assert.equal(p, "[widget · plan-ui] ");
  assert.equal(prefixQuestions(input, p), 1);
  assert.equal(prefixQuestions(input, p), 0);
  assert.equal(input.questions[0].question, "[widget · plan-ui] Which way?");
  assert.equal(questionPrefix("widget", null), "[widget] ");
});

test("question hint: jargon in the question or an option description, plain text none", () => {
  const p = "[w] ";
  assert.equal(questionHint({ questions: [{ question: "[w] Should the page load faster, even if it looks plainer?", options: [{ description: "Faster, plainer." }] }] }, p), null);
  assert.match(questionHint({ questions: [{ question: "[w] Change `index.ts`?", options: [] }] }, p) ?? "", /jargon/);
  assert.match(questionHint({ questions: [{ question: "Fine?", options: [{ description: "uses plan_review_required" }] }] }, p) ?? "", /jargon/);
});

test("show hint: a short plain opening passes, a table, a long paragraph or a code start gets the hint", () => {
  assert.equal(showHint("# Title\n\nThis explains the cache. It keeps the page fast.\n\n| a | b |\n"), null);
  assert.match(showHint("| a | b |\n|---|---|\n| 1 | 2 |\n") ?? "", /plain 2-3 sentence/);
  assert.match(showHint("One. Two. Three. Four. Five.\n") ?? "", /plain/);
  assert.match(showHint("```mermaid\ngraph TD\n```\n") ?? "", /plain/);
  assert.match(showHint("") ?? "", /plain/);
});
