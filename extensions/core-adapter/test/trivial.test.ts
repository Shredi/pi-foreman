// Trivial builder path (frugal-roles D6): the escalation decision at finish, the effective required
// steps, and the launch rules at trivial. Pure functions; no git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeSpawn, onStrongLaunch, userOverride, initialCeremony } from "../ceremony.ts";
import { scanDiff } from "../diffscan.ts";
import { diffShape, effectiveRequired, hasTestCommand, trivialBuilderPath, trivialFacts, trivialVerdict } from "../trivial.ts";

const BOUND = { files: 2, lines: 40, newFiles: 0 };
const diff = (file: string, removed: string[], added: string[], extra = ""): string =>
  `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((l) => `-${l}`).join("\n")}\n${added.map((l) => `+${l}`).join("\n")}\n`;
const TRACKED = ["calc.py", "test_calc.py"];
const verdict = (d: string, opts: { tracked?: string[]; untracked?: { path: string; lines: number }[]; cmd?: boolean } = {}) =>
  trivialVerdict(trivialFacts(d, scanDiff(d), opts.untracked ?? [], opts.tracked ?? TRACKED, opts.cmd ?? false), BOUND);

const BODY = diff("calc.py", ["    return a - b"], ["    return a + b"]);

test("one internal change with a test beside it is trivial", () => {
  assert.equal(verdict(BODY), null);
  assert.deepEqual(diffShape(BODY + diff(".workflow/LEDGER-x.md", ["- [ ] 1. x"], ["- [x] 1. x"])), { files: ["calc.py"], lines: 2, newFiles: 0 });
});

test("a changed test file escalates, before any other reason", () => {
  assert.equal(verdict(BODY + diff("test_calc.py", ["    assert add(1, 2) == 3"], ["    assert add(1, 2) > 0"]))?.reason, "test_file");
});

test("two source files escalate", () => {
  assert.equal(verdict(BODY + diff("util.py", ["x = 1"], ["x = 2"]))?.reason, "files");
  assert.equal(verdict(BODY, { untracked: [{ path: "extra.py", lines: 1 }] })?.reason, "files", "an untracked file counts");
});

test("an exported signature change escalates; a schema file escalates", () => {
  assert.equal(verdict(diff("calc.py", ["def add(a, b):"], ["def add(a, b, c=0):"]))?.reason, "signature");
  assert.equal(verdict(diff("db/schema.sql", ["a int"], ["a bigint"]), { tracked: ["db/schema.sql", "db/test_db.py"] })?.reason, "schema");
});

test("over trivialBound escalates (lines, new file)", () => {
  const many = Array.from({ length: 30 }, (_, i) => `    x${i} = ${i}`);
  assert.equal(verdict(diff("calc.py", many, many.map((l) => `${l} + 1`)))?.reason, "bound");
  assert.equal(verdict(diff("calc.py", [], ["x = 1"], "new file mode 100644\n"))?.reason, "bound");
});

test("no covering test escalates; a project test command covers", () => {
  assert.equal(verdict(BODY, { tracked: ["calc.py"] })?.reason, "no_test");
  assert.equal(verdict(BODY, { tracked: ["calc.py", "go.mod"], cmd: hasTestCommand(["go.mod"], () => null) }), null);
  assert.equal(verdict(diff("src/a.ts", ["  return 1;"], ["  return 2;"]), { tracked: ["src/a.ts", "src/test/a.test.ts"] }), null, "a test below the dir counts");
  assert.equal(hasTestCommand(["package.json"], () => '{"scripts":{"build":"tsc"}}'), false);
});

test("required steps at trivial: builder path only with a ledger, builder dropped in bounded mode", () => {
  assert.equal(trivialBuilderPath({ trivial: ["builder"] }), true);
  assert.equal(trivialBuilderPath({ trivial: [] }), false);
  assert.deepEqual(effectiveRequired(["builder"], "trivial", { bounded: false, ledger: true }), ["builder"]);
  assert.deepEqual(effectiveRequired(["builder"], "trivial", { bounded: false, ledger: false }), []);
  assert.deepEqual(effectiveRequired(["builder"], "trivial", { bounded: true, ledger: true }), []);
  assert.deepEqual(effectiveRequired(["builder", "reviewer"], "standard", { bounded: true, ledger: false }), ["builder", "reviewer"]);
});

test("at trivial on the builder path a builder launch stays trivial; a strong launch without a trigger escalates", () => {
  const t = userOverride(initialCeremony("standard"), "trivial");
  const b = beforeSpawn(t, ["builder"], true);
  assert.equal(b.tier, "trivial");
  assert.equal(b.trivialBuilder, true);
  assert.equal(beforeSpawn(t, ["builder"]).tier, "standard", "earlier trivial: any non-explorer launch escalates");
  assert.equal(beforeSpawn(t, ["reviewer"], true).tier, "standard");
  assert.equal(onStrongLaunch(b, ["foreman"]).tier, "standard");
  assert.equal(onStrongLaunch(b, ["context"]).tier, "trivial", "a ladder trigger keeps trivial");
});
