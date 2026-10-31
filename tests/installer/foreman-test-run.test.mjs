// scripts/foreman_test_run.mjs: the machine-wide test lock and the --test-concurrency cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { testConcurrency, nodeTestArgs } = await import(pathToFileURL(SCRIPT).href);

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-run-")));
}

function env(dir, extra = {}) {
  const e = { ...process.env, FOREMAN_TEST_LOCK_DIR: dir, ...extra };
  delete e.CI;
  delete e.NODE_TEST_CONTEXT;
  delete e.FOREMAN_TEST_LOCK;
  return { ...e, ...extra };
}

/** Runs the wrapper in --exec mode around a node one-liner. */
function run(dir, code, extra = {}) {
  return spawn(process.execPath, [SCRIPT, "--exec", "--", process.execPath, "-e", code], { env: env(dir, extra), stdio: ["ignore", "pipe", "pipe"] });
}

function finish(child) {
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
}

const lockFile = (dir) => path.join(dir, "test-lock");

test("the lock is taken during the run, released after it, and the exit code propagates", async () => {
  const dir = tmp();
  try {
    const r = await finish(run(dir, `console.log(require("fs").readFileSync(${JSON.stringify(lockFile(dir))}, "utf8")); process.exit(3)`));
    assert.equal(r.code, 3);
    const info = JSON.parse(r.out);
    assert.equal(typeof info.pid, "number");
    assert.ok(!Number.isNaN(Date.parse(info.started)));
    assert.equal(info.cwd, process.cwd());
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second run waits with one line until the first releases", async () => {
  const dir = tmp();
  try {
    const first = run(dir, `setTimeout(() => {}, 1500)`);
    const firstDone = finish(first);
    while (!fs.existsSync(lockFile(dir))) await new Promise((r) => setTimeout(r, 20));
    const second = await finish(run(dir, `console.log("second ran")`));
    await firstDone;
    assert.equal(second.code, 0);
    assert.match(second.out, /second ran/);
    const lines = second.err.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^waiting for the test lock held by pid \d+, started \d\d:\d\d$/);
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock of a dead pid is taken over", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: dead.pid ?? 2 ** 22 - 1, started: new Date().toISOString(), cwd: "/x" }));
    const r = await finish(run(dir, `console.log("ran")`));
    assert.equal(r.code, 0);
    assert.match(r.out, /ran/);
    assert.equal(r.err, "");
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock older than the cap is taken over even when its pid lives", async () => {
  const dir = tmp();
  try {
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, started: old, cwd: "/x" }));
    const r = await finish(run(dir, `console.log("ran")`, { FOREMAN_TEST_LOCK_MAX_MINUTES: "1" }));
    assert.equal(r.code, 0);
    assert.match(r.out, /ran/);
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt lock file older than a few seconds is taken over", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(lockFile(dir), "not json");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile(dir), past, past);
    const r = await finish(run(dir, `console.log("ran")`));
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, extra] of [["FOREMAN_TEST_LOCK=0", { FOREMAN_TEST_LOCK: "0" }], ["CI=1", { CI: "1" }]]) {
  test(`${name} runs without touching the lock`, async () => {
    const dir = tmp();
    try {
      // A live foreign holder would block a locking run; the switch ignores it and leaves it alone.
      const held = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd: "/x" });
      fs.writeFileSync(lockFile(dir), held);
      const child = spawn(process.execPath, [SCRIPT, "--exec", "--", process.execPath, "-e", "process.exit(4)"], { env: { ...env(dir), ...extra }, stdio: "ignore" });
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 4);
      assert.equal(fs.readFileSync(lockFile(dir), "utf8"), held);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("test mode runs node --test with a concurrency cap on a fixture file", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "a.test.mjs"), `import { test } from "node:test"; test("x", () => {});\n`);
    const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, "*.test.mjs")], { env: env(dir, { FOREMAN_TEST_CONCURRENCY: "1" }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pass 1/);
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("testConcurrency: env override, invalid env, 1 core, 12 cores", () => {
  assert.equal(testConcurrency({ env: { FOREMAN_TEST_CONCURRENCY: "3" }, cores: 12 }), 3);
  for (const bad of ["0", "-2", "abc", "1.5", ""]) assert.equal(testConcurrency({ env: { FOREMAN_TEST_CONCURRENCY: bad }, cores: 12 }), 6);
  assert.equal(testConcurrency({ env: {}, cores: 1 }), 1);
  assert.equal(testConcurrency({ env: {}, cores: 12 }), 6);
});

test("invoked through a symlinked directory the wrapper still runs the child and propagates its exit code", (t) => {
  const dir = tmp();
  try {
    const link = path.join(dir, "linked-scripts");
    try {
      fs.symlinkSync(path.dirname(SCRIPT), link, "dir");
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") return t.skip("symlinks not permitted");
      throw e;
    }
    const r = spawnSync(process.execPath, [path.join(link, "foreman_test_run.mjs"), "--exec", "--", process.execPath, "-e", "console.log('child ran'); process.exit(5)"], { env: env(dir), encoding: "utf8" });
    assert.equal(r.status, 5, r.stdout + r.stderr);
    assert.match(r.stdout, /child ran/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent waiters on a stale lock never hold the lock at the same time", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: dead.pid ?? 2 ** 22 - 1, started: new Date().toISOString(), cwd: "/x" }));
    const marker = path.join(dir, "marker");
    const code = `const fs=require("fs");try{fs.writeFileSync(${JSON.stringify(marker)},"x",{flag:"wx"})}catch{process.exit(9)}setTimeout(()=>{fs.rmSync(${JSON.stringify(marker)});},300)`;
    const results = await Promise.all(Array.from({ length: 4 }, () => finish(run(dir, code))));
    assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0]);
    assert.ok(!fs.existsSync(lockFile(dir)));
    assert.ok(!fs.existsSync(`${lockFile(dir)}.takeover`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an abandoned takeover mutex does not block a stale-lock takeover", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: dead.pid ?? 2 ** 22 - 1, started: new Date().toISOString(), cwd: "/x" }));
    const mutex = `${lockFile(dir)}.takeover`;
    fs.writeFileSync(mutex, "1");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(mutex, past, past);
    const r = await finish(run(dir, `console.log("ran")`));
    assert.equal(r.code, 0);
    assert.match(r.out, /ran/);
    assert.ok(!fs.existsSync(mutex));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeTestArgs keeps leading options before --test", () => {
  assert.deepEqual(nodeTestArgs(["--import", "./h.mjs", "a/*.ts", "b/*.ts"], 2), ["--import", "./h.mjs", "--test", "--test-concurrency=2", "a/*.ts", "b/*.ts"]);
  assert.deepEqual(nodeTestArgs(["x.test.ts"], 1), ["--test", "--test-concurrency=1", "x.test.ts"]);
});
