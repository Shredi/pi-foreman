// The `## Reviews` merge (prbody.ts): markers count only as whole lines, a stray closing marker is idempotent, suite commands are code spans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEWS_CLOSE, REVIEWS_OPEN, mergeReviewsBlock, reviewsBlock, reviewsLine } from "../prbody.ts";

const blockOf = (line: string): string => `${REVIEWS_OPEN}\n${line}\n${REVIEWS_CLOSE}`;

test("a body naming the marker strings in prose is not rewritten", () => {
  const body = `Changelog: the line sits between ${REVIEWS_OPEN} and ${REVIEWS_CLOSE} in the body.\n`;
  assert.equal(mergeReviewsBlock(body, blockOf("new")), `${body}\n## Reviews\n\n${blockOf("new")}\n`);
});

test("whole-line markers are replaced and the rest stays", () => {
  const body = `intro\n\n## Reviews\n\n${REVIEWS_OPEN}\nold\n${REVIEWS_CLOSE}\n\ntail\n`;
  assert.equal(mergeReviewsBlock(body, blockOf("new")), `intro\n\n## Reviews\n\n${blockOf("new")}\n\ntail\n`);
});

test("a stray closing marker line: repeated updates keep one ## Reviews section", () => {
  const body = `intro\n${REVIEWS_CLOSE}\nmore\n`;
  const once = mergeReviewsBlock(body, blockOf("one"));
  const twice = mergeReviewsBlock(once, blockOf("two"));
  assert.equal(twice.split("## Reviews").length - 1, 1);
  assert.equal(twice, mergeReviewsBlock(body, blockOf("two")));
});

test("suite commands are inline code spans: backticks and line breaks are taken out, an @mention pings no one", () => {
  const line = reviewsLine({ head: "abcdef1234", occasion: "pre-pr", run: "r1", suites: [{ command: "npm test `@someone`\n--x", result: "pass" }] });
  assert.match(line, /suites: `npm test @someone --x` \(pass\)/);
  assert.equal(reviewsBlock({ head: "abcdef1234", suites: [{ command: "``", result: "fail" }] }).includes("`unnamed` (fail)"), true);
});
