// What stays of the old permission overlay's tests after its deletion: the wildcard syntax and the shell lexer, both kept modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { wildcardRegExp } from "../glob.ts";
import { parseShell } from "../psunits.ts";

const home = path.join(os.tmpdir(), "pf-overlay-home");

test("wildcard syntax is the permission system's", () => {
  const re = (p: string): RegExp => wildcardRegExp(p, { home, ignoreCase: false, foldSeparators: false });
  assert.ok(re("git status *").test("git status"));
  assert.ok(re("git status *").test("git status -s"));
  assert.ok(!re("git status *").test("git statusx"));
  assert.ok(re("a?c").test("abc"));
  assert.ok(!re("a?c").test("abbc"));
  assert.ok(re("**/x").test("a/b/x"));
  assert.ok(re("~/.aws/*").test(path.join(home, ".aws", "credentials")));
  assert.ok(re("a.b").test("a.b") && !re("a.b").test("axb"));
});

test("the lexer splits operators and drops quotes", () => {
  const p = parseShell("a 'b c' \"d e\" | f; g && h $(i j) `k`");
  assert.deepEqual(p.pipelines[0], [["a", "b c", "d e"], ["f"]]);
  assert.deepEqual(p.pipelines.slice(1, 3), [[["g"]], [["h", "$"]]]);
  assert.deepEqual(p.subs, ["i j", "k"]);
});
