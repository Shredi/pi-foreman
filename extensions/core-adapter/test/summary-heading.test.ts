// The plan's first section is `## Summary` (the older `## For the owner` stays accepted): the reader, the texts that name it,
// the write-time jargon advice and the dialog's alert markers (agreeing with the page renderer).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";
import { ownerFactsLines, ownerSection, ownerSectionIssues, ownerSummary, planFormIssues } from "../ownertext.ts";
import { renderMarkdown } from "../pages.ts";

const REST = "## Goal\nShip it.\n";
const refused = (r: { blocked: string | null }): boolean => /\[plan_form\]/.test(r.blocked ?? "");

test("both headings are the owner section, any case", () => {
  for (const h of ["## Summary", "## summary  ", "## For the owner", "## FOR THE OWNER"]) {
    assert.deepEqual(planFormIssues(`# P\n\n${h}\nPlain words.\n\n${REST}`, {}), [], h);
  }
});

test("Summary not first, empty, or only below the appendix is refused", () => {
  assert.deepEqual(planFormIssues(`# P\n\n${REST}\n## Summary\nPlain.\n`, {}), ["not the first ## section"]);
  assert.deepEqual(planFormIssues(`# P\n\n## Summary\n\n${REST}`, {}), ["empty"]);
  assert.deepEqual(planFormIssues(`# P\n\n## Summary\n\n${REST}\n## For the owner\nFilled.\n`, {}), ["empty"]);
  assert.deepEqual(planFormIssues(`# P\n\n## For the owner\n\n${REST}\n## Summary\nFilled.\n`, {}), ["empty"]);
  assert.deepEqual(planFormIssues(`# P\n\n${REST}`, {}), ["missing"]);
  assert.deepEqual(planFormIssues("# P\n\n## Goal\nx\n\n## Addendum 1: r\n## Summary\nPlain.\n", {}), ["missing"]);
});

test("For the owner first with a later Summary passes; the later one is ordinary", () => {
  const text = `# P\n\n## For the owner\nPlain words.\n\n${REST}\n## Summary\nOld recap.\n`;
  assert.deepEqual(planFormIssues(text, {}), []);
  assert.deepEqual(ownerSection(text)?.lines, ["Plain words."]);
});

test("the facts line says Summary section in each variant", () => {
  const dir = fs.mkdtempSync("/tmp/sumhead-");
  try {
    fs.writeFileSync(`${dir}/a.md`, `# P\n\n## Summary\nPlain.\n`);
    fs.writeFileSync(`${dir}/b.md`, `# P\n\n${REST}`);
    fs.writeFileSync(`${dir}/c.md`, `# P\n\n## Summary\n\n${REST}`);
    const l = ownerFactsLines(["a.md", "b.md", "c.md", "none.md"], dir);
    assert.match(l[0], /^Summary section \(a\.md\): present \(checked by the harness\)/);
    assert.match(l[1], /^Summary section \(b\.md\): missing/);
    assert.match(l[2], /^Summary section \(c\.md\): issues: empty/);
    assert.match(l[3], /^Summary section \(none\.md\): plan not readable/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("the refusal and the write note name the heading", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  fs.writeFileSync(w.planFile, `# W\n\n${REST}`);
  assert.match((await a.call("write", { path: w.planFile, content: "x" })).note, /must be a non-empty ## Summary \(## For the owner is still accepted\)/);
  const r = await a.reviewLaunch();
  assert.ok(refused(r));
  assert.match(r.blocked ?? "", /must be a non-empty ## Summary \(## For the owner is still accepted\)/);
});

const ADVICE = /\npi-foreman: advice: the Summary section reads like jargon \(`src\/a\.ts`[^)]*\); the owner reads it cold, write it in plain words\. This never blocks a review\.$/;

test("jargon in the Summary gets an advice line and never blocks a review", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  fs.writeFileSync(w.planFile, "# W\n\n## Summary\n\nWe change `src/a.ts`.\n\n" + REST);
  const r = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(r.note, /^ok\npi-foreman: advice: the Summary section reads like jargon/);
  assert.doesNotMatch(r.note, /plan form is wrong/);
  assert.equal((await a.reviewLaunch()).blocked, null);
});

test("a form fault and jargon give both lines, form first; a clean plan gets neither", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  fs.writeFileSync(w.planFile, "# W\n\n## Goal\nx\n\n## Summary\nWe change `src/a.ts`.\n");
  const r = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(r.note, /^ok\npi-foreman: the plan form is wrong \(not the first ## section\)/);
  assert.match(r.note, ADVICE);
  assert.doesNotMatch(r.note.split("\n")[1], /advice/);
  fs.writeFileSync(w.planFile, "# W\n\n## Summary\n\nGoal: ship the widget.\n\n" + REST);
  assert.equal((await a.call("write", { path: w.planFile, content: "x" })).note, "");
});

// The dialog drops a marker line exactly when the page renders a callout.
const agrees = (body: string): { dialog: string; callout: boolean } => {
  const md = `## Summary\n\n${body}\n`;
  return { dialog: ownerSummary(md), callout: /class="callout/.test(renderMarkdown(md)) };
};

test("alert markers: dialog and page agree on malformed input", () => {
  const cases: [string, boolean][] = [
    ["> [!NOTE]\n> **Label**\n> - one", true],
    ["> [!NOTE]", false], // marker without a body
    ["> [!NOTE]\n>\n", false],
    ["> text\n> [!NOTE]\n> body", false], // marker mid-quote
    ["> [!NOTE]\nlazy body", true], // lazy continuation line is the body
    [">\t[!NOTE]\n> body", false], // tab after `>` is not the marker form
  ];
  for (const [body, callout] of cases) {
    const r = agrees(body);
    assert.equal(r.callout, callout, body);
    assert.equal(!/\[!NOTE\]/.test(r.dialog), callout, `${body}\n${r.dialog}`);
  }
});

test("alert markers: the issue strings are unchanged", () => {
  assert.deepEqual(ownerSectionIssues("# P\n\n## Goal\nx\n"), ["missing"]);
});
