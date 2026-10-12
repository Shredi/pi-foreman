import { test } from "node:test";
import assert from "node:assert/strict";
import { mainNeedsGitGuard } from "../gitguard.ts";

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
