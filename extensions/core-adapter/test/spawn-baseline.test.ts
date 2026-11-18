// The per-file spawn baseline of scripts/foreman_test_run.mjs: label normalization, reading the baseline, the growth ranking, the failure text
// with the refresh command, the write decision, the runner flag, and that the two npm scripts agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldWriteBaseline, readSpawnBaseline, spawnCountsByFile, spawnGrowth, spawnGrowthLines, splitRunnerFlags } from "../../../scripts/foreman_test_run.mjs";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("spawnCountsByFile sums every kind per file, joins both separators to one label, and names a record without a file", () => {
  const by = spawnCountsByFile([
    { file: "extensions\\core-adapter\\test\\a.test.ts", git: 2, python: 1 },
    { file: "extensions/core-adapter/test/a.test.ts", git: 3, npm: 1 },
    { file: "b.test.ts", node: 4, git: -1, other: 1.5 },
    { git: 2 },
    { file: "empty.test.ts" },
    null,
  ]);
  assert.deepEqual(by, { "extensions/core-adapter/test/a.test.ts": 7, "b.test.ts": 4, "(no file)": 2 });
});

test("spawnGrowth: largest growth first, new files count fully and are marked, equal and shrunk files are left out, capped at n", () => {
  const baseline = { "a.ts": 10, "b.ts": 10, "c.ts": 10, "d.ts": 10 };
  const g = spawnGrowth({ "a.ts": 15, "b.ts": 10, "c.ts": 4, "d.ts": 30, "new.ts": 12 }, baseline);
  assert.deepEqual(g, [
    { file: "d.ts", now: 30, baseline: 10, delta: 20, isNew: false },
    { file: "new.ts", now: 12, baseline: 0, delta: 12, isNew: true },
    { file: "a.ts", now: 15, baseline: 10, delta: 5, isNew: false },
  ]);
  assert.deepEqual(spawnGrowth({ "a.ts": 15, "d.ts": 30 }, baseline, 1).map((x) => x.file), ["d.ts"]);
  assert.deepEqual(spawnGrowth({ "a.ts": 10 }, baseline), []);
  // a name like "constructor" is a new file, not a baseline entry
  assert.equal(spawnGrowth({ constructor: 3 }, {})[0].isNew, true);
});

test("spawnGrowth ties break by file name", () => {
  assert.deepEqual(spawnGrowth({ "b.ts": 5, "a.ts": 5 }, {}).map((x) => x.file), ["a.ts", "b.ts"]);
});

test("readSpawnBaseline: the files map of a good file; null when missing, unparsable or of the wrong shape", (t) => {
  const dir = mkTestTmp("pf-spawn-baseline-");
  t.after(() => rmTestTmp(dir));
  const write = (name: string, text: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  assert.deepEqual(readSpawnBaseline(write("ok.json", JSON.stringify({ measured: "2026-11-18", files: { "a.ts": 3, "b.ts": 0 } }))), { "a.ts": 3, "b.ts": 0 });
  assert.equal(readSpawnBaseline(path.join(dir, "missing.json")), null);
  assert.equal(readSpawnBaseline(write("bad.json", "{ not json")), null);
  assert.equal(readSpawnBaseline(write("nofiles.json", "{}")), null);
  assert.equal(readSpawnBaseline(write("null.json", JSON.stringify({ files: null }))), null);
  assert.equal(readSpawnBaseline(write("array.json", JSON.stringify({ files: [1] }))), null);
  assert.equal(readSpawnBaseline(write("neg.json", JSON.stringify({ files: { "a.ts": -1 } }))), null);
  assert.equal(readSpawnBaseline(write("frac.json", JSON.stringify({ files: { "a.ts": 1.5 } }))), null);
  assert.equal(readSpawnBaseline(write("str.json", JSON.stringify({ files: { "a.ts": "3" } }))), null);
});

test("spawnGrowthLines: growth, new files, the refresh command; a missing baseline says so", () => {
  const lines = spawnGrowthLines(
    [
      { file: "d.ts", now: 30, baseline: 10, delta: 20, isNew: false },
      { file: "new.ts", now: 12, baseline: 0, delta: 12, isNew: true },
    ],
    { "d.ts": 10 },
  );
  assert.equal(lines[0], "  +20 d.ts (now 30, baseline 10)");
  assert.equal(lines[1], "  +12 new.ts (new)");
  assert.equal(lines[2], "refresh the list with: npm run test:node:baseline (only when the limit changes)");
  assert.equal(lines.length, 3);
  const none = spawnGrowthLines([], null);
  assert.equal(none.length, 1);
  assert.match(none[0], /baseline is missing or unreadable/);
  assert.deepEqual(spawnGrowthLines([], {}), ["refresh the list with: npm run test:node:baseline (only when the limit changes)"]);
});

test("shouldWriteBaseline: only with the flag and an exit code of 0", () => {
  assert.equal(shouldWriteBaseline(0, true), true);
  assert.equal(shouldWriteBaseline(1, true), false);
  assert.equal(shouldWriteBaseline(0, false), false);
  assert.equal(shouldWriteBaseline(0, undefined), false);
});

test("splitRunnerFlags takes only a leading flag; one after --exec --, after the first glob or after node options stays", () => {
  assert.deepEqual(splitRunnerFlags(["--write-spawn-baseline", "--import", "x.mjs", "a*.ts"]), { writeBaseline: true, rest: ["--import", "x.mjs", "a*.ts"] });
  assert.deepEqual(splitRunnerFlags(["--exec", "--", "cmd", "--write-spawn-baseline"]), { writeBaseline: false, rest: ["--exec", "--", "cmd", "--write-spawn-baseline"] });
  assert.deepEqual(splitRunnerFlags(["a*.ts", "--write-spawn-baseline"]), { writeBaseline: false, rest: ["a*.ts", "--write-spawn-baseline"] });
  assert.deepEqual(splitRunnerFlags(["--import", "x.mjs", "--write-spawn-baseline"]), { writeBaseline: false, rest: ["--import", "x.mjs", "--write-spawn-baseline"] });
  assert.deepEqual(splitRunnerFlags([]), { writeBaseline: false, rest: [] });
});

test("package.json: test:node:baseline equals test:node apart from the leading flag", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  const runner = "node scripts/foreman_test_run.mjs ";
  assert.ok(scripts["test:node"].startsWith(runner));
  assert.equal(scripts["test:node:baseline"], `${runner}--write-spawn-baseline ${scripts["test:node"].slice(runner.length)}`);
});
