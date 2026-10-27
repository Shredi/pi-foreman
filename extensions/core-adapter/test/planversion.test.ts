import { test } from "node:test";
import assert from "node:assert/strict";
import { planBody, planSummary, planVersionHash, sha256 } from "../checkpoint.ts";

const BODY = "# Widget\n\n## Goal\nShip it.\n\n## Approach\nOne builder.\n";
const v = (s: string): string => planVersionHash(Buffer.from(s));

test("plan version: without an appendix it is sha256 of the whole file", () => {
  assert.equal(v(BODY), sha256(Buffer.from(BODY)));
  assert.equal(v(""), sha256(Buffer.from("")));
  assert.equal(v("no newline at end"), sha256(Buffer.from("no newline at end")));
});

test("plan version: the exact appendix headings end the body", () => {
  for (const h of ["## Ruling", "## Rulings", "## Parent ruling", "## Decision log", "<!-- plan-appendix -->", "## Ruling   "]) {
    assert.equal(v(`${BODY}\n${h}\nOwner says yes.\n`), v(BODY), h);
  }
});

test("plan version: ## Decisions and near misses are plan body", () => {
  // R46 item 3: `### Ruling`, `## ruling`, `## Decision Log` and `## Decision log: x` are appendix headings now (r46-appendix-headings.test.ts)
  for (const h of ["## Decisions", "## Rulings and more", " ## Ruling", "#### Ruling", "## Decision logic"]) {
    assert.notEqual(v(`${BODY}\n${h}\nx\n`), v(BODY), h);
  }
});

test("plan version: a heading starting ## Addendum is an appendix (prefix match)", () => {
  assert.equal(v(`${BODY}\n## Addendum\nx\n`), v(BODY));
  assert.equal(v(`${BODY}\n## Addendum 2: security review\nx\n`), v(BODY));
  assert.equal(v(`${BODY}\n### Addendum\nx\n`), v(BODY)); // R46 item 3: level 2 or 3
});

test("plan version: a body edit is a new version; edits below the heading are not", () => {
  const a = `${BODY}\n## Ruling\nfirst\n`;
  assert.equal(v(a), v(`${a}\nsecond ruling\n`));
  assert.notEqual(v(a), v(`${BODY.replace("One builder", "Two builders")}\n## Ruling\nfirst\n`));
});

test("plan version: the first appendix line ends the body, later headings are appendix text", () => {
  assert.equal(v(`${BODY}\n## Ruling\nx\n## Approach\nchanged\n`), v(BODY));
});

test("plan version: CRLF endings and a file that ends without a newline before the appendix", () => {
  assert.equal(v(`${BODY}\r\n## Ruling\r\nx\r\n`), v(BODY));
  assert.equal(planBody(Buffer.from(`${BODY}\n\n\n## Ruling\nx\n`)).toString(), BODY);
});

test("plan summary: the appendix is listed apart and its headings are not plan sections", () => {
  const text = `${BODY}\n## Ruling\nyes\n## Extra\n`;
  const out = planSummary(text, ".workflow/scratch/plan-w.md", "abcdef0123456789");
  assert.match(out, /Appendix: from "## Ruling" \(outside review and approval\)/);
  assert.doesNotMatch(out, /Extra/);
  assert.doesNotMatch(planSummary(BODY, "p", "abcdef0123456789"), /Appendix/);
});
