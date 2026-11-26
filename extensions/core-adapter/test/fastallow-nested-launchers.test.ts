// B2 revision: a launcher that starts the program it is given (`npx`, `find -exec`) is read at any depth, and the harness's own test commands run silent.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { MATRIX_ROLES, makeLayout, matrixOracle } from "./_gate-gen.ts";

const base = fs.realpathSync(mkTestTmp("fastallow-nested-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const oracle = matrixOracle(makeLayout(path.join(base, "gate")));

test("npx around find -exec around a push to main is never silent, for main, builder and reviewer", { skip: posixOnly }, () => {
  const line = `npx sh -c 'find . -exec sh -c "git push origin main" \\;'`;
  for (const role of MATRIX_ROLES) assert.notEqual(oracle(line, role), "silent", role);
});

test("the nested launcher shape the seeded sample found (eval > npx > pushd into home, then a relative script) is never silent", { skip: posixOnly }, () => {
  const line = `eval 'npx sh -c '\\''d=~/x; pushd "$d" && ./run.sh'\\'''`;
  for (const role of MATRIX_ROLES) assert.notEqual(oracle(line, role), "silent", role);
  assert.notEqual(oracle(`npx sh -c 'd=~/x; pushd "$d" && ./run.sh'`, "reviewer"), "silent");
});

test("find -exec and npx with a harmless inner command stay silent for a builder", { skip: posixOnly }, () => {
  assert.equal(oracle("npx sh -c 'find . -exec ls \\;'", "builder"), "silent");
  assert.equal(oracle("npx tsc -p .", "builder"), "silent");
});

test("FOREMAN_TEST_* settings in front of the harness test commands run silent for every role", { skip: posixOnly }, () => {
  for (const line of ["FOREMAN_TEST_DETACH=1 npm test", "FOREMAN_TEST_TIMEOUT=600 npm run test:node"]) {
    for (const role of MATRIX_ROLES) assert.equal(oracle(line, role), "silent", `${role}: ${line}`);
  }
});

test("a FOREMAN_ name that steers a harness folder still marks the line", { skip: posixOnly }, () => {
  for (const line of ["FOREMAN_SCRATCH=/etc npm test", "FOREMAN_OUT=/etc npm test"]) {
    for (const role of MATRIX_ROLES) assert.notEqual(oracle(line, role), "silent", `${role}: ${line}`);
  }
});

test("an assignment unit with a subscript on a text value is not a default-assign allow", { skip: posixOnly }, () => {
  for (const role of MATRIX_ROLES) assert.notEqual(oracle("x=a; a[$x]=1", role), "silent", role);
});
