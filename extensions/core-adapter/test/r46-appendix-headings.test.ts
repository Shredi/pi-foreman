// R46 item 3: appendix headings are level 2 or 3, case-insensitive, whole word, in the listed forms; one predicate
// serves the version hash (planBody) and the owner's summary (planSummary). The revision text names the body, not an Addendum.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBody, planSummary, planVersionHash } from "../checkpoint.ts";
import { planReviewRefusalText } from "../planreview.ts";

const BODY = "# Widget\n\n## Goal\nShip it.\n";
const version = (extra: string): string => planVersionHash(Buffer.from(BODY + extra));

test("appendix heading variants keep the plan version", () => {
  const base = planVersionHash(Buffer.from(BODY));
  for (const h of ["### Addendum", "## addenda", "## Ruling 2", "## Addendum 2: x", "## Ruling (parent)", "### Parent ruling", "## DECISION LOG", "## Rulings", "## Addendum - late", "<!-- plan-appendix -->"]) {
    assert.equal(version(`\n${h}\nlater words\n`), base, h);
  }
});

test("non-appendix headings stay body", () => {
  const base = planVersionHash(Buffer.from(BODY));
  for (const h of ["## Decision logic", "## Ruling out X", "## Decisions", "#### Addendum", "# Addendum", "## Addendums"]) {
    assert.notEqual(version(`\n${h}\nmore\n`), base, h);
  }
});

test("planSummary cuts at the same headings as the version", () => {
  for (const h of ["### Addendum", "## addenda", "## Ruling 2"]) {
    const text = `${BODY}\n${h}\nsecret words\n`;
    const s = planSummary(text, ".workflow/scratch/plan-x.md", "abc");
    assert.match(s, /Appendix: from/, h);
    assert.ok(!/Ruling 2\b.*·|addenda.*·/i.test(s.split("\n").find((l) => l.startsWith("Sections:")) ?? ""), h);
    assert.equal(planBody(Buffer.from(text)).toString(), BODY);
  }
  const s = planSummary(`${BODY}\n## Decision logic\nx\n`, "p", "abc");
  assert.doesNotMatch(s, /Appendix:/);
  assert.match(s, /Decision logic/);
});

test("plan_revision_required says: revise the body above the appendix; an Addendum is not a revision", () => {
  const text = planReviewRefusalText("plan_revision_required", ".workflow/scratch/plan-x.md", "heavy", false);
  assert.match(text, /body above the appendix/);
  assert.match(text, /an Addendum is not a revision/i);
});
