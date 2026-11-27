// D38: one full-suite rule per role. The reviewer runs full suites (the re-review line leaves the rerun to its judgement),
// the builder runs targeted tests, and the foreman rules say not to ask a builder for a full suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reReviewLine } from "../ledgerblock.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const FORBIDS = [/not the full suites?/i, /do not run[^.\n]*full suites?/i, /only the targeted tests/i, /no tsc or full suites/i];

test("D38: the reviewer role file names the full suite and does not forbid it", () => {
  const text = read("agents/reviewer.md");
  assert.match(text, /`npm test`/);
  for (const re of FORBIDS) assert.doesNotMatch(text, re);
});

test("D38: the rendered re-review line does not forbid full suites", () => {
  for (const sha of ["abc123", null]) {
    const line = reReviewLine(sha);
    for (const re of FORBIDS) assert.doesNotMatch(line, re);
    assert.match(line, /full suites again when the fix since the last review can affect them/);
  }
});

test("D38: the builder file and the foreman rules both say the reviewer runs full suites", () => {
  assert.match(read("agents/builder.md"), /full suites run once per change in the reviewer's review/);
  assert.match(read("instructions/foreman.md"), /never ask a builder for a full suite[^.\n]*the reviewer runs them/);
});

test("D219: the role files name `foreman test-run`, not the script path", () => {
  for (const f of ["agents/builder.md", "agents/reviewer.md"]) {
    const text = read(f);
    assert.match(text, /`foreman test-run /);
    assert.doesNotMatch(text, /foreman_test_run\.mjs/);
  }
  assert.match(read("agents/reviewer.md"), /foreman test-run --wait <id> --max 540/);
  assert.match(read("agents/builder.md"), /foreman test-run --targeted <files>/);
});

test("D183/D184/D221: reviewer names foreman_copy; both roles say read transcripts with the read tool; builder never stashes", () => {
  assert.match(read("agents/reviewer.md"), /^tools:.*foreman_copy/m);
  for (const f of ["agents/builder.md", "agents/reviewer.md"]) assert.match(read(f), /transcripts.*with the read tool/);
  assert.match(read("agents/builder.md"), /never use `git stash`[^.\n]*shared by all linked worktrees/);
});

test("D224: the foreman instructions state the 1000-character item limit", () => {
  assert.match(read("instructions/foreman.md"), /at most 1000 characters[^.\n]*keep evidence in a file and link it/);
});
