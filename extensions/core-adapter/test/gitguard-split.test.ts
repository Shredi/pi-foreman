import { test } from "node:test";
import assert from "node:assert/strict";
import { mainNeedsGitGuard } from "../gitguard.ts";
import { readFileSync } from "node:fs";
import { probeFileHit, reassemblesToken } from "../splitliteral.ts";

// R6 lane 1c: the same fixture tests/test_git_guard_split_literal.py reads (git_guard.py, child mode)
const CASES = JSON.parse(readFileSync(new URL("../../../tests/fixtures/split-literal-cases.json", import.meta.url), "utf8")) as { deny: string[]; allow: string[]; probeDeny: string[]; probeAllow: string[] };

test("fixture deny lines reassemble a guarded token", () => {
  for (const cmd of CASES.deny) assert.equal(reassemblesToken([cmd]), true, cmd);
});

test("fixture allow lines do not", () => {
  for (const cmd of CASES.allow) assert.equal(reassemblesToken([cmd]), false, cmd);
});

test("probe-file scan: char codes, base64 and fragments are hits, ordinary strings are not", () => {
  for (const src of CASES.probeDeny) assert.equal(probeFileHit(src), true, src);
  for (const src of CASES.probeAllow) assert.equal(probeFileHit(src), false, src);
  for (const cmd of CASES.deny) assert.equal(probeFileHit(cmd), true, cmd);
});

// ledger item 7f: a main-role line that spells a guarded token from pieces reaches the guard (git_guard.py denies it)
test("split-literal lines run the git guard in the main role", () => {
  for (const cmd of [
    "cat '.g''it'/config",
    "echo $'.'\"git\"",
    "python3 -c 'p = \".g\" + \"it\"; open(p)'",
    "node -e \"x = '.' + 'g' + 'it'\"",
    "echo 'GI'T~1",
    "cat $'\\x2egit'/x",
  ]) assert.equal(mainNeedsGitGuard(cmd), true, cmd);
});

test("ordinary lines still skip the guard", () => {
  for (const cmd of ["ls -la", "echo a.b", "python3 -c 'print(\"a\" + \"b\")'", "echo \"x\" > out.txt", "cat 'a b'"]) assert.equal(mainNeedsGitGuard(cmd), false, cmd);
});
