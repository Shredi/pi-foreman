import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// The Python rule (AGENTS.md): a new `.py` file is allowed only as a test, bench task data or the own legacy core.
// Existing non-test Python is listed in python-files.txt; the list shrinks as modules are ported to TypeScript.
const root = path.join(import.meta.dirname, "..", "..", "..");
const frozenPath = path.join(import.meta.dirname, "python-files.txt");

const ALLOWED = [
  /^tests\/(?:.+\/)?test_[^/]+\.py$/,
  /^bench\/tasks\//,
  /^bench\/review-samples\//,
  /^core\//,
];

const HINT = "new harness code is TypeScript; see AGENTS.md. A non-test Python helper needs an entry in extensions/core-adapter/test/python-files.txt";

/** Parses the frozen list: one path per line, CRLF or LF, blank lines dropped. */
export function parseFrozen(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** Returns one message per problem: a tracked `.py` that is neither allowed nor listed, or a listed path no longer tracked. */
export function checkPythonFiles(tracked: string[], frozen: string[]): string[] {
  const listed = new Set(frozen);
  const present = new Set(tracked);
  const problems: string[] = [];
  for (const file of tracked) {
    if (!listed.has(file) && !ALLOWED.some((re) => re.test(file))) problems.push(`${file}: ${HINT}`);
  }
  for (const file of frozen) {
    if (!present.has(file)) problems.push(`${file}: listed in python-files.txt but no longer tracked; remove the entry`);
  }
  return problems;
}

const isCheckout = fs.existsSync(path.join(root, ".git"));
const skipReason = isCheckout ? false : "not a git checkout";

test("python rule: the tracked .py files are allowed or in the frozen list", { skip: skipReason }, () => {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "*.py"], { encoding: "utf8" });
  const tracked = out.split("\0").filter((file) => file !== "");
  const frozen = parseFrozen(fs.readFileSync(frozenPath, "utf8"));
  assert.deepEqual(checkPythonFiles(tracked, frozen), []);
});

test("python rule: the frozen list is sorted and has no duplicates", () => {
  const frozen = parseFrozen(fs.readFileSync(frozenPath, "utf8"));
  assert.deepEqual(frozen, [...new Set(frozen)].sort());
});

test("python rule: a planted non-test helper fails and its path is named", () => {
  const problems = checkPythonFiles(["scripts/a.py", "scripts/new_tool.py"], ["scripts/a.py"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^scripts\/new_tool\.py: /);
  assert.match(problems[0], /AGENTS\.md/);
  assert.match(problems[0], /needs an entry in extensions\/core-adapter\/test\/python-files\.txt/);
});

test("python rule: a planted test file and a core file pass without a list entry", () => {
  const tracked = ["scripts/a.py", "tests/test_new.py", "tests/replay/test_x.py", "core/scripts/x.py", "bench/tasks/t/run.py", "bench/review-samples/s.py"];
  assert.deepEqual(checkPythonFiles(tracked, ["scripts/a.py"]), []);
});

test("python rule: a non-test file under tests/ or core/ is not allowed by name alone", () => {
  const problems = checkPythonFiles(["tests/helper.py"], []);
  assert.deepEqual(problems.map((p) => p.split(":")[0]), ["tests/helper.py"]);
});

test("python rule: a stale list entry fails and its path is named", () => {
  const problems = checkPythonFiles(["scripts/a.py"], ["scripts/a.py", "scripts/gone.py"]);
  assert.deepEqual(problems, ["scripts/gone.py: listed in python-files.txt but no longer tracked; remove the entry"]);
});

test("python rule: a frozen list with CRLF endings parses the same as LF", () => {
  const lf = "bench/harbor_agent.py\nscripts/a.py\n";
  const crlf = "bench/harbor_agent.py\r\nscripts/a.py\r\n";
  assert.deepEqual(parseFrozen(crlf), parseFrozen(lf));
  assert.deepEqual(parseFrozen(crlf), ["bench/harbor_agent.py", "scripts/a.py"]);
  assert.deepEqual(checkPythonFiles(["bench/harbor_agent.py", "scripts/a.py"], parseFrozen(crlf)), []);
});
