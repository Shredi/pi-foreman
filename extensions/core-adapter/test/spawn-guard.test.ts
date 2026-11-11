// The spawn guard of scripts/foreman_test_run.mjs: summing, the summary line, both failure modes (any npm, over budget), and the
// counter preload (_spawn-count.mjs) run in a child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SPAWN_BUDGET, npmCountsByFile, readSpawnCounts, spawnBudget, spawnGuardFailures, spawnSummaryLine, sumSpawnCounts } from "../../../scripts/foreman_test_run.mjs";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

// `node --import` takes a URL or a bare specifier; a Windows drive path would read as a URL scheme, so pass file URLs.
const HERMETIC = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "_hermetic-env.mjs")).href;
const COUNTER = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "_spawn-count.mjs")).href;

test("sumSpawnCounts adds the per-process counts by kind; unknown kinds and bad numbers are handled", () => {
  const t = sumSpawnCounts([{ git: 2, python: 1 }, { git: 1, npm: 3, node: 4 }, { zsh: 5, git: -1, node: 1.5 }, null, {}]);
  assert.deepEqual(t, { git: 3, python: 1, node: 4, npm: 3, other: 5, total: 16 });
  assert.deepEqual(sumSpawnCounts([]), { git: 0, python: 0, node: 0, npm: 0, other: 0, total: 0 });
});

test("spawnSummaryLine names every kind", () => {
  assert.equal(spawnSummaryLine({ git: 3, python: 1, node: 4, npm: 0, other: 2, total: 10 }), "child processes: 10 (git 3, python 1, node 4, npm 0, other 2)");
});

test("spawnGuardFailures: a passed run with any npm fails", () => {
  const f = spawnGuardFailures(0, { git: 0, python: 0, node: 0, npm: 1, other: 0, total: 1 }, 100);
  assert.equal(f.length, 1);
  assert.match(f[0], /started npm 1 time/);
});

test("spawnGuardFailures: a passed run over the budget fails, at the budget it passes", () => {
  const t = { git: 5, python: 0, node: 0, npm: 0, other: 0, total: 5 };
  assert.deepEqual(spawnGuardFailures(0, t, 5), []);
  const f = spawnGuardFailures(0, t, 4);
  assert.equal(f.length, 1);
  assert.match(f[0], /5 child processes, over the budget of 4/);
});

test("spawnGuardFailures: a run that failed already adds nothing; both modes can fire together", () => {
  const t = { git: 9, python: 0, node: 0, npm: 2, other: 0, total: 11 };
  assert.deepEqual(spawnGuardFailures(1, t, 0), []);
  assert.equal(spawnGuardFailures(0, t, 0).length, 2);
});

test("sumSpawnCounts ignores the file label of a count file, so a file-labelled record sums like the older shape", () => {
  assert.deepEqual(sumSpawnCounts([{ file: "a.test.ts", git: 2, npm: 1 }]), { git: 2, python: 0, node: 0, npm: 1, other: 0, total: 3 });
});

test("npmCountsByFile lists the npm starts per file, largest first; older records count as no file; zero and bad counts are left out", () => {
  const records = [
    { file: "b.test.ts", npm: 1, git: 4 },
    { file: "a.test.ts", npm: 2 },
    { file: "c.test.ts", npm: 0, git: 3 },
    { npm: 3, git: 1 },
    { file: "d.test.ts", npm: -1 },
    null,
  ];
  assert.deepEqual(npmCountsByFile(records), [["(no file)", 3], ["a.test.ts", 2], ["b.test.ts", 1]]);
  assert.deepEqual(npmCountsByFile([{ git: 2 }]), []);
});

test("spawnGuardFailures names each file with its npm starts under the npm failure; without the list it stays one line", () => {
  const t = { git: 0, python: 0, node: 0, npm: 3, other: 0, total: 3 };
  const f = spawnGuardFailures(0, t, 100, [["a.test.ts", 2], ["b.test.ts", 1]]);
  assert.equal(f.length, 3);
  assert.match(f[0], /started npm 3 time/);
  assert.equal(f[1], "  npm 2 in a.test.ts");
  assert.equal(f[2], "  npm 1 in b.test.ts");
  assert.equal(spawnGuardFailures(0, t, 100).length, 1);
});

test("the counter preload labels each count file with its script: relative to the cwd, the basename outside it, '-' for -e", () => {
  const dir = mkTestTmp("pf-spawn-label-");
  const outside = mkTestTmp("pf-spawn-outside-");
  try {
    fs.writeFileSync(path.join(dir, "probe-label.mjs"), "export {};\n");
    fs.writeFileSync(path.join(outside, "probe-outside.mjs"), "export {};\n");
    const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_SPAWN_COUNT_DIR: dir };
    delete env.FOREMAN_SPAWN_GUARD_EXEMPT;
    const runs = [
      ["probe-label.mjs"],
      [path.join(outside, "probe-outside.mjs")],
      ["-e", "0"],
    ];
    for (const args of runs) {
      const r = spawnSync(process.execPath, ["--import", COUNTER, ...args], { cwd: dir, env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.deepEqual(readSpawnCounts(dir).map((c) => c.file).sort(), ["-", "probe-label.mjs", "probe-outside.mjs"]);
  } finally {
    rmTestTmp(dir);
    rmTestTmp(outside);
  }
});

test("spawnBudget: FOREMAN_TEST_SPAWN_BUDGET when a non-negative integer, else the default", () => {
  assert.equal(spawnBudget({}), DEFAULT_SPAWN_BUDGET);
  assert.equal(spawnBudget({ FOREMAN_TEST_SPAWN_BUDGET: "123" }), 123);
  assert.equal(spawnBudget({ FOREMAN_TEST_SPAWN_BUDGET: "0" }), 0);
  assert.equal(spawnBudget({ FOREMAN_TEST_SPAWN_BUDGET: "-1" }), DEFAULT_SPAWN_BUDGET);
  assert.equal(spawnBudget({ FOREMAN_TEST_SPAWN_BUDGET: "x" }), DEFAULT_SPAWN_BUDGET);
});

function npmCountOf(code: string): number {
  const dir = mkTestTmp("pf-spawn-npm-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_SPAWN_COUNT_DIR: dir };
    delete env.FOREMAN_SPAWN_GUARD_EXEMPT;
    const r = spawnSync(process.execPath, ["--import", HERMETIC, "-e", code], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readdirSync(dir).length, 1);
    return sumSpawnCounts(readSpawnCounts(dir)).npm;
  } finally {
    rmTestTmp(dir);
  }
}

test("an npm started through a shell is counted from the fake npm log", { skip: process.platform === "win32" }, () => {
  const n = npmCountOf(`require("node:child_process").spawnSync("sh", ["-c", "npm root -g"]);`);
  assert.ok(n >= 1, `npm count ${n}`);
});

test("an npx started through a shell is counted from the fake npm log", { skip: process.platform === "win32" }, () => {
  const n = npmCountOf(`require("node:child_process").spawnSync("sh", ["-c", "npx -v"]);`);
  assert.ok(n >= 1, `npm count ${n}`);
});

test("npx counts as npm, through the fake npx on PATH", { skip: process.platform === "win32" }, () => {
  const dir = mkTestTmp("pf-spawn-npx-");
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_SPAWN_COUNT_DIR: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.FOREMAN_SPAWN_GUARD_EXEMPT;
    const code = `require("node:child_process").spawnSync("npx", ["--version"]);`;
    const r = spawnSync(process.execPath, ["--import", COUNTER, "-e", code], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sumSpawnCounts(readSpawnCounts(dir)).npm, 1);
  } finally {
    rmTestTmp(dir);
  }
});

test("a direct npm spawn that hits the fake counts once", { skip: process.platform === "win32" }, () => {
  assert.equal(npmCountOf(`require("node:child_process").spawnSync("npm", ["root", "-g"]);`), 1);
});

test("the counter preload writes per-kind counts on exit and skips exempt spawns", () => {
  const dir = mkTestTmp("pf-spawn-count-");
  try {
    const code = [
      `const cp = require("node:child_process");`,
      `cp.spawnSync(process.execPath, ["-e", "0"]);`,
      `cp.execFileSync(process.execPath, ["-e", "0"]);`,
      `cp.spawnSync("git", ["--version"]);`,
      `cp.spawnSync("npm-does-not-exist-pf", ["x"]);`,
      `process.env.FOREMAN_SPAWN_GUARD_EXEMPT = "1";`,
      `cp.spawnSync(process.execPath, ["-e", "0"]);`,
    ].join("\n");
    const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_SPAWN_COUNT_DIR: dir };
    delete env.FOREMAN_SPAWN_GUARD_EXEMPT;
    const r = spawnSync(process.execPath, ["--import", COUNTER, "-e", code], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.deepEqual(sumSpawnCounts(readSpawnCounts(dir)), { git: 1, python: 0, node: 2, npm: 0, other: 1, total: 4 });
  } finally {
    rmTestTmp(dir);
  }
});
