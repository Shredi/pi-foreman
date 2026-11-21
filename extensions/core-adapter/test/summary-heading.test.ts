// The plan's first section is `## Summary` (the older `## For the owner` stays accepted): the reader, the texts that name it,
// the write-time jargon advice and the dialog's alert markers (agreeing with the page renderer).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { ownerFactsLines, ownerSection, ownerSectionIssues, ownerSummary, planFormIssues } from "../ownertext.ts";
import { readPlan } from "../checkpoint.ts";
import { claimsHintLine } from "../planreview.ts";
import { foldPlanSection, renderMarkdown, renderPage } from "../pages.ts";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumhead-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), `# P\n\n## Summary\nPlain.\n`);
    fs.writeFileSync(path.join(dir, "b.md"), `# P\n\n${REST}`);
    fs.writeFileSync(path.join(dir, "c.md"), `# P\n\n## Summary\n\n${REST}`);
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
  fs.writeFileSync(w.planFile, "# W\n\n## Goal\nx\n\n## Summary\n**Goal:** We change `src/a.ts`.\n\n1. Ship it.\n");
  const r = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(r.note, /^ok\npi-foreman: the plan form is wrong \(not the first ## section\)/);
  assert.match(r.note, ADVICE);
  assert.doesNotMatch(r.note.split("\n")[1], /advice/);
  fs.writeFileSync(w.planFile, "# W\n\n## Summary\n\n**Goal:** ship the widget.\n\n1. Ship it.\n\n" + REST);
  assert.ok(["", `ok\n${claimsHintLine(w.planFile)}`].includes((await a.call("write", { path: w.planFile, content: "x" })).note), "no plan-form advice, at most the claims hint");
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
    ["> [!NOTE] x\n> body", false], // text after the marker
    ["> [!WARNING]\n> **Outer**\n> > [!NOTE]\n> > body", true], // a box inside a box loses its marker in the dialog too
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

// ---------------------------------------------------------------- the plan page: the owner layout and the fold

const planPage = (md: string): string => renderPage({ title: "P", kicker: "k", markdown: md, fold: foldPlanSection, source: "p.md" });
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

for (const h of ["Summary", "For the owner"]) {
  test(`plan page: a \`## ${h}\` section alone gets the owner layout and stays unfolded`, () => {
    const html = planPage(`# P\n\n## ${h}\nGoal: ship.\n\n## Goal\nShip it.\n`);
    assert.equal(count(html, /<section class="owner">/g), 1);
    assert.match(html, new RegExp(`<section class="owner">\\n<div class="o-main">\\n<h2>${h}</h2>\\n<p class="goal">Goal: ship\\.</p>`));
    assert.doesNotMatch(html, /<details class="fold" id="(summary|for-the-owner)"/);
    assert.match(html, /<details class="fold" id="goal">/);
  });
}

test("plan page, both headings, Summary first: the first wraps, the later For the owner is an ordinary unfolded section", () => {
  const html = planPage("# P\n\n## Summary\nFirst words.\n\n## Work\nx\n\n## For the owner\nSecond words.\n");
  assert.equal(count(html, /<section class="owner">/g), 1);
  const owner = html.slice(html.indexOf('<section class="owner">'), html.indexOf("</section>"));
  assert.match(owner, /<h2>Summary<\/h2>/);
  assert.match(owner, /First words\./);
  assert.doesNotMatch(owner, /Second words|For the owner/);
  assert.match(html, /<h2>For the owner<\/h2>\n<p>Second words\.<\/p>/);
  assert.doesNotMatch(html, /<details class="fold" id="for-the-owner"/);
  assert.match(html, /<nav class="index"><span>In the details<\/span><a href="#work">Work<\/a><\/nav>/);
});

test("plan page, both headings, For the owner first: the first wraps, the later Summary is an ordinary unfolded section", () => {
  const html = planPage("# P\n\n## For the owner\nFirst words.\n\n## Work\nx\n\n## Summary\nSecond words.\n");
  assert.equal(count(html, /<section class="owner">/g), 1);
  const owner = html.slice(html.indexOf('<section class="owner">'), html.indexOf("</section>"));
  assert.match(owner, /<h2>For the owner<\/h2>/);
  assert.match(owner, /First words\./);
  assert.doesNotMatch(owner, /Second words|Summary/);
  assert.match(html, /<h2>Summary<\/h2>\n<p>Second words\.<\/p>/);
  assert.doesNotMatch(html, /<details class="fold" id="summary"/);
  assert.match(html, /<nav class="index"><span>In the details<\/span><a href="#work">Work<\/a><\/nav>/);
});

test("fold: Summary and For the owner stay unfolded whatever the case or blanks; other names fold", () => {
  for (const h of ["Summary", "  SUMMARY ", "For the owner", "  for the OWNER "]) assert.equal(foldPlanSection(h), false, h);
  assert.equal(foldPlanSection("Summaries"), true);
});

// ---------------------------------------------------------------- both headings: the reader, the facts line and the launch

test("both headings: planFormIssues judges the first owner-named section only", () => {
  assert.deepEqual(planFormIssues(`# P\n\n## Summary\nPlain.\n\n## For the owner\n\n${REST}`, {}), []);
  assert.deepEqual(planFormIssues(`# P\n\n## For the owner\nPlain.\n\n## Summary\n\n${REST}`, {}), []);
});

test("both headings: ownerSummary shows the first section's body only, labelled Summary", () => {
  assert.equal(ownerSummary("# P\n\n## Summary\nFirst words.\n\n## Work\nx\n\n## For the owner\nSecond words.\n"), "Summary\n  First words.");
  assert.equal(ownerSummary("# P\n\n## For the owner\nFirst words.\n\n## Summary\nSecond words.\n"), "Summary\n  First words.");
});

test("both headings: the facts line says present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumhead-"));
  try {
    fs.writeFileSync(path.join(dir, "both.md"), "# P\n\n## Summary\nPlain.\n\n## For the owner\nMore.\n\n## Goal\nx\n");
    assert.match(ownerFactsLines(["both.md"], dir)[0], /^Summary section \(both\.md\): present \(checked by the harness\)/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("both headings: a [plan-review] launch passes when the first owner-named section is filled, in either order", async (t) => {
  for (const text of [
    `# W\n\n## Summary\nGoal: ship.\n\n${REST}`,
    `# W\n\n## For the owner\nGoal: ship.\n\n${REST}`,
    `# W\n\n## Summary\nGoal: ship.\n\n${REST}\n## For the owner\nMore.\n`,
    `# W\n\n## For the owner\nGoal: ship.\n\n${REST}\n## Summary\n\n`,
  ]) {
    const w = world(t);
    fs.writeFileSync(w.planFile, text);
    assert.equal((await (await w.adapter("startup")).reviewLaunch()).blocked, null, text);
  }
});

test("both headings: an empty first owner-named section is refused even with a filled later one", async (t) => {
  for (const text of [`# W\n\n## Summary\n\n${REST}\n## For the owner\nGoal: ship.\n`, `# W\n\n## For the owner\n\n${REST}\n## Summary\nGoal: ship.\n`]) {
    const w = world(t);
    fs.writeFileSync(w.planFile, text);
    const r = await (await w.adapter("startup")).reviewLaunch();
    assert.ok(refused(r), text);
    assert.match(r.blocked ?? "", /empty/, text);
  }
});

// ---------------------------------------------------------------- both headings in an HTML plan: the page's copy, through the launch

const HTML_TASK = "[plan-review] review .workflow/scratch/plan-widget.html";

/** The launch result of a page with `page` as its text: the copy is generated from it as the harness does, then a review is launched. */
async function htmlLaunch(t: { after(fn: () => void | Promise<void>): void }, page: string): Promise<{ blocked: string | null }> {
  const w = world(t);
  fs.rmSync(w.planFile); // the markdown fixture would be a hand-written copy beside the page
  fs.writeFileSync(path.join(w.project, ".workflow", "scratch", "plan-widget.html"), page);
  readPlan(".workflow/scratch/plan-widget.html", { cwd: w.project, home: path.dirname(w.project), platform: process.platform, scratchDir: ".workflow/scratch" });
  const a = await w.adapter("startup");
  return a.reviewLaunch(HTML_TASK);
}

test("both headings, HTML plan: a filled Summary first, a later For the owner: the launch is not refused", async (t) => {
  const r = await htmlLaunch(t, "<html><body><h1>Widget</h1><h2>Summary</h2><p>Goal: ship the widget.</p><h2>Goal</h2><p>Ship it.</p><h2>For the owner</h2><p>More.</p></body></html>");
  assert.equal(r.blocked, null, String(r.blocked));
});

test("both headings, HTML plan: a filled For the owner first, a later empty Summary: the launch is not refused", async (t) => {
  const r = await htmlLaunch(t, "<html><body><h1>Widget</h1><h2>For the owner</h2><p>Goal: ship the widget.</p><h2>Goal</h2><p>Ship it.</p><h2>Summary</h2></body></html>");
  assert.equal(r.blocked, null, String(r.blocked));
});

test("both headings, HTML plan: an empty Summary first, a filled For the owner later: the launch is refused as empty", async (t) => {
  const r = await htmlLaunch(t, "<html><body><h1>Widget</h1><h2>Summary</h2><h2>Goal</h2><p>Ship it.</p><h2>For the owner</h2><p>Goal: ship the widget.</p></body></html>");
  assert.ok(refused(r), String(r.blocked));
  assert.match(r.blocked ?? "", /empty/);
});

test("alert markers: a box inside a plain quote loses its marker as on the page", () => {
  const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
  const cases: [string, number][] = [
    ["> text\n> > [!NOTE]\n> > body", 1],
    ["> [!NOTE]\n> a\n\nplain\n\n> text\n> > [!TIP]\n> > b\n\n> [!WARNING]\n> c", 3],
  ];
  for (const [body, boxes] of cases) {
    const md = `## Summary\n\n${body}\n`;
    assert.equal(count(renderMarkdown(md), /<blockquote class="callout/g), boxes, body);
    const dialog = ownerSummary(md);
    assert.equal(count(dialog, /\[!/g), 0, `${body}\n${dialog}`);
  }
  assert.match(ownerSummary("## Summary\n\n> text\n> > plain\n"), /\n {2}> text\n {2}> > plain$/);
});

test("the write result names the form hints of a Summary and gives none for a complete one", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  fs.writeFileSync(w.planFile, "# W\n\n## Summary\n\nWe ship the widget.\n\n" + REST);
  const r = await a.call("write", { path: w.planFile, content: "x" });
  assert.match(r.note, /pi-foreman: advice: the Summary section misses parts of its form \(.*\): a \*\*Goal:\*\* paragraph, numbered steps, boxes at the end\. This never blocks a review\./);
  assert.match(r.note, /goal|numbered/i);
  fs.writeFileSync(w.planFile, "# W\n\n## Summary\n\n**Goal:** ship the widget.\n\n1. Ship it.\n\n" + REST);
  assert.equal((await a.call("write", { path: w.planFile, content: "x" })).note, "");
});
