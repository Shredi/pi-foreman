import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../permoverlay.ts";
import { GRAMMAR, grammarStatements, resolveVars } from "../shellvars.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "shellvars-grammar.json"), "utf8"));

const count = (cmd: string, env: Record<string, string> = {}): number => {
  const p = parseShell(cmd);
  return resolveVars(p.pipelines, p.seps, env, () => false, cmd).size;
};

test("the grammar constants equal the shared fixture", () => {
  assert.deepEqual(GRAMMAR, fixture);
});

test("every forbidden token ends resolution", () => {
  assert.notEqual(grammarStatements("H=/ok; cp f $H"), null);
  for (const tok of fixture.forbidden as string[]) {
    assert.equal(grammarStatements(`H=/ok; cp f $H x${tok}y`), null, tok);
    assert.equal(grammarStatements(`H=/ok; cp f $H ${tok}`), null, tok);
  }
});

test("positive rows resolve", () => {
  assert.equal(count("D=/ok/scratch/x; mkdir -p $D"), 1);
  assert.equal(count("mkdir -p $FOREMAN_SCRATCH/probe/x", { FOREMAN_SCRATCH: "/ok/scratch" }), 1);
  assert.equal(count('H=/ok/handoff; cp plan.md "$H/plan.md"'), 1);
});

test("S1/S2 forms and conditional assignments resolve nothing", () => {
  const h = "/ok/handoff";
  for (const cmd of [
    `false | # c\nH=${h}\ncp f $H`,
    `printf -vH ${h}; cp f $H`,
    `declare -n H=X; cp f $H`,
    `typeset -n H=X; cp f $H`,
    `H=${h}; : $[H=0]; cp f $H`,
    `H=${h}; : \${X:H=0}; cp f $H`,
    `H=${h}; : \${A[H=0]}; cp f $H`,
    `H=${h}; exec {H}>f; cp f $H`,
    `H=${h}; wait -n -p H; cp f $H`,
    `H=${h}; coproc H { :; }; cp f $H`,
    `H=${h}; true | read H; cp f $H`,
    `IFS=/; H=${h}; cp f $H`,
    `H=/ok/work; false && H=${h}; cp f $H`,
  ]) assert.equal(count(cmd), 0, cmd);
});
