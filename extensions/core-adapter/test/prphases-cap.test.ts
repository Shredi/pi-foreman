// The 64-glob cap of gate/ignore lists (prphases.ts) and the stand-in run of a gate source that did not answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePhases } from "../prphases.ts";
import { parseWakeRules } from "../prwake.ts";

const globs = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`);

test("parsePhases: 64 gate and ignore globs are kept, 65 drops the rule naming 64", () => {
  const ok = parsePhases([{ gate: globs(64), ignore: globs(64) }]);
  assert.equal(ok.rules.length, 1);
  assert.equal(ok.rules[0].gate.length, 64);
  for (const key of ["gate", "ignore"]) {
    const bad = parsePhases([{ [key]: globs(65) }]);
    assert.equal(bad.rules.length, 0);
    assert.match(bad.errors[0], /at most 64 globs/);
  }
});

test("prWake still caps its glob lists at 50", () => {
  const r = parseWakeRules([{ source: "*", wake: true, checks: globs(51) }]);
  assert.match(String(r.errors[0]), /1\.\.50 globs/);
  assert.equal(parseWakeRules([{ source: "*", wake: true, checks: globs(50) }]).errors.length, 0);
});
