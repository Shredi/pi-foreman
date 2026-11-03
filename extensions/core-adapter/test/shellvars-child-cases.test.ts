// A7: child-only single literal assignment substitution; the fixture is read by tests/test_shellvars_child_cases.py too.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../shellast.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fx = JSON.parse(fs.readFileSync(path.join(PKG, "tests", "fixtures", "shellvars-child-cases.json"), "utf8")) as { cases: Array<{ line: string; resolved: string | null }> };
const SCRATCH = "/tmp/pi-foreman-scratch/s1/L1";

/** The operands of `probe` when the segment is resolved, else null. */
const probe = (line: string, env: Record<string, string>): string | null => {
  const seg = parseShell(line, { cwd: "/w/proj", env }).find((s) => s.program === "probe");
  assert.ok(seg, line);
  return seg.opaque ? null : seg.argv[0];
};

test("child: a sole literal assignment is substituted at each fixture position; every other form stays unresolved", () => {
  for (const c of fx.cases) {
    const line = c.line.replaceAll("@SCRATCH@", SCRATCH);
    const want = c.resolved === null ? null : c.resolved.replaceAll("@SCRATCH@", SCRATCH);
    assert.equal(probe(line, { FOREMAN_SCRATCH: SCRATCH }), want, c.line);
  }
});

test("foreman / round (no child scratch binding): nothing is substituted", () => {
  for (const c of fx.cases) assert.equal(probe(c.line.replaceAll("@SCRATCH@", SCRATCH), {}), null, c.line);
});
