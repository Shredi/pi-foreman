// scripts/foreman_ci.mjs: `npm run test:ci` runs every CI step a local machine can run, in CI's order. Unit test of the exported step table and the argument check; no step is run.
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "../../scripts/foreman_ci.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "foreman_ci.mjs");

test("the step table is in CI's order", () => {
  assert.deepEqual(STEPS.map((s) => s.name), ["unit", "core-pin", "ruff", "conformance", "node", "installer", "typecheck", "lint-ts", "replay", "bench"]);
  for (const s of STEPS) assert.equal(typeof s.run, "function", s.name);
});

test("the two test-runner steps print their own output; the others are captured", () => {
  assert.deepEqual(STEPS.filter((s) => s.inherited).map((s) => s.name), ["unit", "node"]);
});

test("importing the script runs no step (the main-module guard)", () => {
  // the import above would have run (or refused) the steps; reaching this line with the table in hand is the proof
  assert.ok(STEPS.length > 0);
});

test("--only takes every step name and refuses an unknown one without running anything", () => {
  const r = spawnSync(process.execPath, [script, "--only", "nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const named = /one of (.*)$/m.exec(r.stderr)?.[1]?.split(", ");
  assert.deepEqual(named, STEPS.map((s) => s.name));
});
