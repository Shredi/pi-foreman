// scripts/foreman_test_run.mjs: the machine-wide test lock and the --test-concurrency cap.
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { testConcurrency, nodeTestArgs, acquireLock, LockWaitTimeout, killTree } = await import(pathToFileURL(SCRIPT).href);

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
    assert.match(lines[0], /^waiting for the test lock held by pid \d+ \(cwd .+\), started \d\d:\d\d$/);
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

// --- time limit, bounded lock wait, kill path ---

/** Runs the wrapper with raw arguments (wrapper options first). */
function runRaw(dir, args, extra = {}) {
  return spawn(process.execPath, [SCRIPT, ...args], { env: env(dir, extra), stdio: ["ignore", "pipe", "pipe"] });
}

const execArgs = (code) => ["--exec", "--", process.execPath, "-e", code];
const marker = (dir) => path.join(dir, "ran");
const touchMarker = (dir) => `require("fs").writeFileSync(${JSON.stringify(marker(dir))}, "x")`;
const liveLock = (dir, cwd = "/x") => fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd }));
const gone = async (pid) => {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test("the time limit stops the run and a grandchild that ignores SIGTERM, releases the lock and exits 124", async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "grandchild.pid");
  try {
    const grand = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grand)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
    const r = await finish(runRaw(dir, ["--timeout", "3", ...execArgs(parent)]));
    assert.equal(r.code, 124);
    assert.match(r.err, /^foreman_test_run: time limit of 3 s reached after 3\.\d s; stopped the run\n$/);
    assert.ok(!fs.existsSync(lockFile(dir)));
    assert.ok(fs.existsSync(pidFile), "the grandchild started");
    assert.ok(await gone(Number(fs.readFileSync(pidFile, "utf8"))), "the grandchild is gone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the time limit through the env applies with the lock off", async () => {
  const dir = tmp();
  try {
    const r = await finish(runRaw(dir, execArgs(`setInterval(() => {}, 1000)`), { FOREMAN_TEST_LOCK: "0", FOREMAN_TEST_TIMEOUT: "0.5" }));
    assert.equal(r.code, 124);
    assert.match(r.err, /time limit of 0\.5 s reached after 0\.\d s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a limit that is not reached keeps the child exit code and prints nothing; the flag wins over the env", async () => {
  const dir = tmp();
  try {
    const r = await finish(runRaw(dir, ["--timeout", "60", ...execArgs("process.exit(3)")], { FOREMAN_TEST_TIMEOUT: "abc" }));
    assert.equal(r.code, 3);
    assert.equal(r.err, "");
    const e = await finish(runRaw(dir, execArgs("process.exit(5)"), { FOREMAN_TEST_TIMEOUT: "" }));
    assert.equal(e.code, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, args, extra] of [
  ["--timeout abc", ["--timeout", "abc"], {}],
  ["--timeout 0", ["--timeout", "0"], {}],
  ["--timeout -1", ["--timeout", "-1"], {}],
  ["--timeout without a value", ["--timeout"], {}],
  ["FOREMAN_TEST_TIMEOUT=abc", [], { FOREMAN_TEST_TIMEOUT: "abc" }],
  ["FOREMAN_TEST_TIMEOUT=0", [], { FOREMAN_TEST_TIMEOUT: "0" }],
]) {
  test(`an invalid limit (${name}) exits 2 without running or taking the lock`, async () => {
    const dir = tmp();
    try {
      const r = await finish(runRaw(dir, [...args, ...execArgs(touchMarker(dir))], extra));
      assert.equal(r.code, 2);
      assert.match(r.err, /^foreman_test_run: (--timeout|FOREMAN_TEST_TIMEOUT) needs a positive number of seconds\n$/);
      assert.ok(!fs.existsSync(marker(dir)));
      assert.ok(!fs.existsSync(lockFile(dir)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a free lock prints no wait line", async () => {
  const dir = tmp();
  try {
    const r = await finish(runRaw(dir, ["--timeout", "30", ...execArgs("")]));
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock names a live holder, repeats the line and throws LockWaitTimeout after maxWaitMs", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/some/where");
    let err = "";
    const seen = [];
    await assert.rejects(
      acquireLock(lockFile(dir), { pollMs: 10, announceMs: 60, maxWaitMs: 300, stderr: { write: (s) => (err += s) }, onHolder: (h) => seen.push(h) }),
      (e) => e instanceof LockWaitTimeout && e.holder.pid === process.pid && e.holder.cwd === "/some/where",
    );
    const lines = err.trim().split("\n");
    assert.match(lines[0], /^waiting for the test lock held by pid \d+ \(cwd \/some\/where\), started \d\d:\d\d$/);
    assert.ok(lines.length >= 2);
    assert.match(lines[1], /^still waiting for the test lock held by pid \d+ \(cwd \/some\/where\), started \d\d:\d\d; waited [\d.]+ min$/);
    assert.equal(seen[0].pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock file without a cwd prints cwd unknown", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    let err = "";
    await assert.rejects(acquireLock(lockFile(dir), { pollMs: 10, maxWaitMs: 50, stderr: { write: (s) => (err += s) } }), LockWaitTimeout);
    assert.match(err, /^waiting for the test lock held by pid \d+ \(cwd unknown\), started \d\d:\d\d\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock takes a dead holder's lock at once even with a short bound", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: dead.pid, started: new Date().toISOString(), cwd: "/x" }));
    const release = await acquireLock(lockFile(dir), { pollMs: 10, maxWaitMs: 1000, stderr: { write() {} } });
    release();
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live holder that outlasts FOREMAN_TEST_LOCK_WAIT_MINUTES ends the run with 75 and the command is not run", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/held/here");
    const r = await finish(runRaw(dir, execArgs(touchMarker(dir)), { FOREMAN_TEST_LOCK_WAIT_MINUTES: "0.02" }));
    assert.equal(r.code, 75);
    assert.match(r.err, /^waiting for the test lock held by pid \d+ \(cwd \/held\/here\), started \d\d:\d\d\n/);
    assert.match(r.err, /foreman_test_run: gave up waiting for the test lock after [\d.]+ min; held by pid \d+ \(cwd \/held\/here\), started \d\d:\d\d\n$/);
    assert.ok(!fs.existsSync(marker(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the time limit during the lock wait exits 124, names the holder and does not run the command", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/held/here");
    const r = await finish(runRaw(dir, ["--timeout", "1", ...execArgs(touchMarker(dir))]));
    assert.equal(r.code, 124);
    assert.match(r.err, /time limit of 1 s reached after 1\.\d s; stopped the run; waited for the lock held by pid \d+ \(cwd \/held\/here\), started \d\d:\d\d\n$/);
    assert.ok(!fs.existsSync(marker(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("killTree on Windows calls taskkill /pid <pid> /T /F by full path", async () => {
  const calls = [];
  await killTree(4242, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnSync: (cmd, args) => calls.push([cmd, args]) });
  assert.deepEqual(calls, [[path.win32.join("C:\\Windows", "System32", "taskkill.exe"), ["/pid", "4242", "/T", "/F"]]]);
  const bare = [];
  await killTree(7, { platform: "win32", env: {}, spawnSync: (cmd, args) => bare.push([cmd, args]) });
  assert.deepEqual(bare, [["taskkill", ["/pid", "7", "/T", "/F"]]]);
});

test("killTree on POSIX signals the tree with SIGTERM, then SIGKILLs the union of both listings after the grace", async () => {
  const sent = [];
  const before = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 99, ppid: 1 }];
  const after = [{ pid: 10, ppid: 1 }, { pid: 13, ppid: 10 }, { pid: 99, ppid: 1 }];
  const lists = [before, after];
  await killTree(10, { platform: "linux", list: () => lists.shift(), kill: (p, s) => sent.push([p, s]), graceMs: 20 });
  const term = sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort();
  const kill = sent.filter(([, s]) => s === "SIGKILL").map(([p]) => p).sort();
  assert.deepEqual(term, [10, 11, 12]);
  assert.deepEqual(kill, [10, 11, 12, 13]);
  assert.ok(sent.findIndex(([, s]) => s === "SIGKILL") > sent.findLastIndex(([, s]) => s === "SIGTERM"));
});

test("killTree falls back to the child alone with a note when the process list fails", async () => {
  const sent = [];
  let err = "";
  await killTree(10, { platform: "darwin", list: () => undefined, kill: (p, s) => sent.push([p, s]), graceMs: 5, stderr: { write: (s) => (err += s) } });
  assert.deepEqual(sent, [[10, "SIGTERM"], [10, "SIGKILL"]]);
  assert.match(err, /could not list processes; stopping the main test process only/);
});
