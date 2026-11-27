// D201: the frozen expected set is filtered by the current phase rules on every poll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectStep } from "../prwatch.ts";
import type { ExpectInput, Run } from "../prwatch.ts";

const SHA = "abcdef0123456789";
const run = (name: string): Run => ({ id: name, name, bucket: "passed", url: `https://h.invalid/${name}`, expected: true });
const input = (o: Partial<ExpectInput> = {}): ExpectInput => ({ head: SHA, runs: [run("quick")], cut: false, draft: false, upgrade: false, baseline: { names: ["quick", "ci", "slow"] }, ...o });

test("expectStep: a frozen name the rules no longer expect drops out on the next poll; a name still expected stays", () => {
  let r = expectStep(undefined, input(), 0);
  assert.deepEqual(r.facts?.missing, ["ci", "slow"]);
  r = expectStep(r.state, input({ expected: (n) => n !== "ci" }), 1000);
  assert.deepEqual(r.state.names, ["quick", "ci", "slow"], "the frozen set itself is untouched");
  assert.deepEqual(r.facts?.missing, ["slow"]);
  r = expectStep(r.state, input({ expected: () => false }), 2000);
  assert.equal(r.facts, undefined, "no expected name left: no veto");
  r = expectStep(r.state, input({ expected: (n) => n === "ci" }), 3000);
  assert.deepEqual(r.facts?.missing, ["ci"], "a rule change back brings it back");
});
