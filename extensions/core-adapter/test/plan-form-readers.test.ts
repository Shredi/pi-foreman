// The plan readers agree (docs/ceremony.md): appendix headings with a long or medium dash, the Summary form hints, the end of the owner card, closing-hash
// headings, the planSummary title and goal, and nested boxes in the dialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isAppendixLine, planBody, planSummary, planTitle, planVersionHash } from "../checkpoint.ts";
import { htmlToMarkdown } from "../htmlmd.ts";
import { ownerFactsLines, ownerFormHints, ownerSection, ownerSectionIssues, ownerSummary, planFormIssues } from "../ownertext.ts";
import { foldPlanSection, renderMarkdown } from "../pages.ts";
import { titleOf } from "../show.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const BODY = "# Widget\n\n## Goal\nShip it.\n";
const FULL = "## Summary\n\n**Goal:** ship the widget.\n\n1. Do one thing.\n2. Do the next.\n\n> [!NOTE]\n> **Decided for you**\n> - one\n\n> [!TIP]\n> **Decided by you**\n> - two\n";

test("appendix: a long dash and a medium dash after the word keep the plan version, in text and in bytes", () => {
  const base = planVersionHash(Buffer.from(BODY));
  for (const dash of [EM, EN, "-"]) {
    for (const h of [`## Ruling ${dash} x`, `### Rulings ${dash} x`, `## Addendum ${dash} late`, `## Decision log ${dash} 2`]) {
      assert.equal(planVersionHash(Buffer.from(`${BODY}\n${h}\nlater words\n`)), base, h);
      assert.ok(isAppendixLine(h), h);
    }
  }
  assert.equal(planBody(Buffer.from(`${BODY}\n## Ruling ${EM} x\nlater\n`)).toString("utf8"), BODY);
});

test("appendix: other separators and words stay plan body", () => {
  const base = planVersionHash(Buffer.from(BODY));
  for (const h of ["## Rulings2", "## Ruling notes", "## Ruling ##", `## Ruling${EM}x`, "## Ruling ~ x", "## Ruling = x"]) {
    assert.notEqual(planVersionHash(Buffer.from(`${BODY}\n${h}\nlater words\n`)), base, h);
    assert.equal(isAppendixLine(h), false, h);
  }
});

test("form hints: each missing part, none for a complete summary, never in planFormIssues", () => {
  assert.deepEqual(ownerFormHints(`# W\n\n${FULL}\n## Work\nx\n`), []);
  assert.deepEqual(ownerFormHints("## Summary\n\n1. Do it.\n"), ["no **Goal:** paragraph"]);
  assert.deepEqual(ownerFormHints("## Summary\n\n**Goal:** ship it.\n"), ["no numbered steps"]);
  assert.deepEqual(ownerFormHints("## Summary\n\n**Goal:** ship it.\n\n1. Do it.\n\n> [!NOTE]\n> **Label**\n> - a\n\nA closing sentence.\n"), ["a box is not at the end"]);
  assert.deepEqual(ownerFormHints("## Summary\n\nplain\n"), ["no **Goal:** paragraph", "no numbered steps"]);
  assert.deepEqual(ownerFormHints("# W\n\n## Work\nx\n"), []);
  assert.deepEqual(ownerFormHints("## Summary\n\n**Goal:** ship it.\n\n```\n1. fenced\n```\n"), ["no numbered steps"]);
  assert.deepEqual(planFormIssues("# W\n\n## Summary\n\nplain\n", {}), []);
  assert.deepEqual(ownerSectionIssues("# W\n\n## Summary\n\nplain\n"), []);
});

test("form hints: the skeleton page gives none", () => {
  const html = fs.readFileSync(path.join(root, "instructions", "plan-skeleton.html"), "utf8");
  assert.deepEqual(ownerFormHints(htmlToMarkdown(html).markdown), []);
});

test("form hints: the facts line carries them after the checked prefix", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "pf-hints-"));
  try {
    fs.writeFileSync(path.join(dir, "p.md"), "# W\n\n## Summary\n\nplain\n");
    fs.writeFileSync(path.join(dir, "q.md"), `# W\n\n${FULL}`);
    const [bad] = ownerFactsLines(["p.md"], dir);
    assert.match(bad, /: present \(checked by the harness\); form hints: no \*\*Goal:\*\* paragraph; no numbered steps; judge it as owner text/);
    const [ok] = ownerFactsLines(["q.md"], dir);
    assert.doesNotMatch(ok, /form hints/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("page: a level-1 heading after the summary ends the owner card", () => {
  const html = renderMarkdown(`${FULL}\n# Later title\n\nafter\n\n## Work\nx\n`, { ownerLayout: true, fold: foldPlanSection });
  const card = /<section class="owner">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(card, /Decided for you/);
  assert.doesNotMatch(card, /Later title|after/);
  assert.match(html, /<h1>Later title<\/h1>/);
  assert.match(html, /<details class="fold" id="work">/);
  assert.equal(ownerSection(`${FULL}\n# Later title\n\nafter\n`)?.lines.join("\n").includes("Later title"), false, "the dialog ends there too");
});

test("closing-hash headings: Summary and Open questions read alike for the reader, the form check and the page", () => {
  const md = "# W\n\n## Summary ##\n\n**Goal:** ship it.\n\n1. Do it.\n\n## Work\nx\n\n## Open questions ##\n1. none.\n";
  assert.deepEqual(ownerSectionIssues(md), []);
  assert.deepEqual(planFormIssues(md, { requiredHeadings: ["Open questions"] }), []);
  assert.deepEqual(ownerSection(md)?.lines, ["**Goal:** ship it.", "", "1. Do it."]);
  const html = renderMarkdown(md, { ownerLayout: true, fold: foldPlanSection });
  assert.match(html, /<section class="owner">/);
  assert.match(html, /<details class="fold" id="work">/);
  assert.match(planSummary(md, ".workflow/scratch/plan-w.md", "abcdef0123456789"), /Sections: Summary · Work · Open questions\nOpen questions: 1\n/);
});

test("planTitle and planSummary: a heading wins, else the topic; the goal is the **Goal:** paragraph", () => {
  const noH1 = `${FULL}\n## Work\nx\n`;
  assert.equal(planTitle(["## Summary"], "widget"), "widget");
  assert.equal(planTitle(["# Own", "## Summary"], "widget"), "Own");
  assert.equal(planTitle(["x"], null), null);
  const s = planSummary(noH1, ".workflow/scratch/plan-widget.md", "abcdef0123456789").split("\n");
  assert.equal(s[0], "Plan: widget");
  assert.equal(s[1], "Goal: ship the widget.");
  assert.equal(planSummary(`# Own title\n\n${FULL}`, ".workflow/scratch/plan-widget.md", "ab").split("\n")[0], "Plan: Own title");
  const forOwner = planSummary(noH1.replace("## Summary", "## For the owner"), "plan-widget.md", "ab").split("\n");
  assert.equal(forOwner[1], "Goal: ship the widget.");
  const multi = planSummary("## Summary\n\n**Goal:** first line\nsecond line\n\n1. x\n", "plan-w.md", "ab").split("\n");
  assert.deepEqual(multi.slice(1, 3), ["Goal: first line", "  second line"]);
});

test("planSummary: the old ## Goal heading is the fallback; a fenced **Goal:** is ignored", () => {
  const old = planSummary("# W\n\n## Summary\n\nplain\n\n## Goal\nold goal\n", "plan-w.md", "ab").split("\n");
  assert.equal(old[1], "Goal: old goal");
  const fenced = planSummary("# W\n\n## Summary\n\n```\n**Goal:** fake\n```\n", "plan-w.md", "ab");
  assert.doesNotMatch(fenced, /Goal: fake/);
});

test("page title: a plan without a heading gets its topic, one with a heading keeps it", () => {
  assert.equal(titleOf(Buffer.from("## Summary\n\nx\n"), "widget"), "widget");
  assert.equal(titleOf(Buffer.from("# Own\n\n## Summary\n"), "widget"), "Own");
  assert.equal(titleOf(Buffer.from("## Summary\n\nx\n")), "## Summary", "topic-less: the first line as before");
});

test("dialog: a box inside a box loses its marker like the page's callout; a plain quote inside keeps its lines", () => {
  const md = "## Summary\n\n> [!WARNING]\n> **Outer**\n> > [!TIP]\n> > **Inner**\n> > - one\n> >\n> > > quoted\n";
  const out = ownerSummary(md);
  assert.doesNotMatch(out, /\[!/);
  assert.match(out, /\*\*Outer\*\*/);
  assert.match(out, /\*\*Inner\*\*/);
  assert.match(out, /> quoted/);
  const html = renderMarkdown(md);
  assert.equal(html.match(/class="callout/g)?.length, 2, "the page renders both boxes");
});
