import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVars } from "../shellvars.ts";

// one command per pipeline, one unit, as the parsed words
const line = (...cmds: string[][]): { pipes: string[][][]; seps: string[] } => ({ pipes: cmds.map((c) => [c]), seps: cmds.map((_, i) => (i < cmds.length - 1 ? ";" : "end")) });
const resolved = (...cmds: string[][]): number => {
  const { pipes, seps } = line(...cmds);
  return resolveVars(pipes, seps, {}).size;
};

test("control: a plain assignment resolves", () => {
  assert.equal(resolved(["H=/ok/dir"], ["cp", "plan.md", "$H/plan.md"]), 1);
});

test("append, element, let, declare, read and export forms leave the variable unknown", () => {
  for (const setter of [["H+=/../../src/f"], ["H[0]=/x"], ["let", "H=1"], ["declare", "H=/x"], ["typeset", "H=/x"], ["export", "H=/x"], ["read", "H"], ["unset", "H"]]) {
    assert.equal(resolved(["H=/ok/dir"], setter, ["cp", "plan.md", "$H/plan.md"]), 0, setter.join(" "));
  }
});

test("eval, source, ((..)) and IFS poison the whole line", () => {
  assert.equal(resolved(["H=/ok/dir"], ["eval", "H=/x"], ["cp", "a", "$H/b"]), 0);
  assert.equal(resolved(["H=/ok/dir"], ["source", "f"], ["cp", "a", "$H/b"]), 0);
  assert.equal(resolved(["H=/ok/dir"], [".", "f"], ["cp", "a", "$H/b"]), 0);
  assert.equal(resolved(["H=/ok/dir"], ["((H=1))"], ["cp", "a", "$H/b"]), 0);
  assert.equal(resolved(["IFS=Z"], ["H=/ok/dir/aZ"], ["cp", "plan.md", "$H"]), 0);
  assert.equal(resolved(["IFS=Z"], ["H=/ok/dir"], ["cp", "plan.md", "$H"]), 0);
});

test("a value with blanks never resolves", () => {
  assert.equal(resolved(["H=/ok/dir/a /src/f"], ["cp", "plan.md", "$H"]), 0);
  assert.equal(resolved(["H=/ok/dir/a\t/src/f"], ["cp", "plan.md", "$H"]), 0);
});
