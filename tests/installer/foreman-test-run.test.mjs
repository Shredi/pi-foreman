// scripts/foreman_test_run.mjs: the machine-wide test lock and the --test-concurrency cap.
import { test, after } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { testConcurrency, nodeTestArgs, acquireLock, LockWaitTimeout, killTree, targetedSettings, slotPaths } = await import(pathToFileURL(SCRIPT).href);

const MADE = [];
after(() => {
  for (const d of MADE) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-run-")));
  MADE.push(d);
  return d;
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
/** The stderr of a run without its first line (the run id line every run prints). */
const noStart = (err) => err.replace(/^foreman_test_run: run \S+ \(pid \d+, cwd [^\n]*\); stop it with: [^\n]*\n/, "");

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
    const lines = noStart(second.err).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^waiting for the test lock held by run \S+ \(pid \d+, cwd .+\), since \d\d:\d\d: .+, queue position 1 of 1$/);
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
    assert.equal(noStart(r.err), "");
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live, heartbeating lock older than the cap is not taken over", async () => {
  const dir = tmp();
  try {
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    fs.writeFileSync(lockFile(dir), JSON.stringify({ id: "hb-live", pid: process.pid, started: old, cwd: "/x" }));
    const r = await finish(run(dir, `console.log("ran")`, { FOREMAN_TEST_LOCK_MAX_MINUTES: "1", FOREMAN_TEST_LOCK_WAIT_MINUTES: "0.02" }));
    assert.equal(r.code, 75);
    assert.doesNotMatch(r.out, /ran/);
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, process.pid);
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
    assert.match(noStart(r.err), /^foreman_test_run: time limit of 3 s reached after 3\.\d s; stopped the run\n$/);
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
    assert.equal(noStart(r.err), "");
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
    assert.equal(noStart(r.err), "");
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
    assert.match(lines[0], /^waiting for the test lock held by run unknown \(pid \d+, cwd \/some\/where\), since \d\d:\d\d: unknown, queue position 1 of 1$/);
    assert.ok(lines.length >= 2);
    assert.match(lines[1], /^still waiting for the test lock held by run unknown \(pid \d+, cwd \/some\/where\), since \d\d:\d\d: unknown, queue position 1 of 1; waited [\d.]+ min$/);
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
    assert.match(err, /^waiting for the test lock held by run unknown \(pid \d+, cwd unknown\), since \d\d:\d\d: unknown, queue position 1 of 1\n$/);
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
    assert.match(noStart(r.err), /^waiting for the test lock held by run unknown \(pid \d+, cwd \/held\/here\), since \d\d:\d\d: unknown, queue position 1 of 1\n/);
    assert.match(r.err, /foreman_test_run: gave up waiting for the test lock after [\d.]+ min; held by run unknown \(pid \d+, cwd \/held\/here\), since \d\d:\d\d: unknown\n$/);
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
    assert.match(r.err, /time limit of 1 s reached after 1\.\d s; stopped the run; waited for the lock held by run unknown \(pid \d+, cwd \/held\/here\), since \d\d:\d\d: unknown\n$/);
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

const queueDir = (dir) => `${lockFile(dir)}.queue`;
const tickets = (dir) => (fs.existsSync(queueDir(dir)) ? fs.readdirSync(queueDir(dir)).sort() : []);
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, "condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quiet = { write() {} };

test("queue: three waiters behind a holder acquire in arrival order and leave no tickets", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/held");
    const order = [];
    const waiters = [];
    for (const n of [1, 2, 3]) {
      waiters.push(
        acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet }).then((release) => {
          order.push(n);
          release();
        }),
      );
      await until(() => tickets(dir).length === n);
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(order, []);
    fs.rmSync(lockFile(dir));
    await Promise.all(waiters);
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(tickets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("queue: a waiter touches its ticket as a heartbeat", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/held");
    const w = acquireLock(lockFile(dir), { pollMs: 10, maxWaitMs: 400, stderr: quiet });
    const caught = assert.rejects(w, LockWaitTimeout);
    await until(() => tickets(dir).length === 1);
    const file = path.join(queueDir(dir), tickets(dir)[0]);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(file, old, old);
    await until(() => fs.statSync(file).mtimeMs > Date.now() - 5000);
    await caught;
    assert.deepEqual(tickets(dir), [], "the ticket is removed on timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("queue: a dead-pid ticket at the head is skipped and removed", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.mkdirSync(queueDir(dir), { recursive: true });
    const name = `${"1".padStart(15, "0")}-000000-${dead.pid}.json`;
    fs.writeFileSync(path.join(queueDir(dir), name), "{}");
    const release = await acquireLock(lockFile(dir), { pollMs: 10, maxWaitMs: 2000, stderr: quiet });
    release();
    assert.deepEqual(tickets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("queue: a live ticket with a heartbeat older than 30 s is dropped, a fresh one keeps its place", async () => {
  const dir = tmp();
  try {
    fs.mkdirSync(queueDir(dir), { recursive: true });
    const stale = path.join(queueDir(dir), `${"1".padStart(15, "0")}-000000-${process.pid}.json`);
    const fresh = path.join(queueDir(dir), `${"2".padStart(15, "0")}-000000-${process.pid}.json`);
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(fresh, "{}");
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(stale, old, old);
    await assert.rejects(acquireLock(lockFile(dir), { pollMs: 10, maxWaitMs: 200, stderr: quiet }), LockWaitTimeout);
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(fresh));
    assert.ok(!fs.existsSync(lockFile(dir)), "the waiter behind the fresh ticket did not take the lock");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("queue: a waiter whose ticket vanished queues again at the end", async () => {
  const dir = tmp();
  try {
    liveLock(dir, "/held");
    const order = [];
    const take = (n) =>
      acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet }).then((release) => {
        order.push(n);
        release();
      });
    const first = take(1);
    await until(() => tickets(dir).length === 1);
    const firstTicket = tickets(dir)[0];
    const second = take(2);
    await until(() => tickets(dir).length === 2);
    fs.rmSync(path.join(queueDir(dir), firstTicket));
    await until(() => tickets(dir).length === 2 && !tickets(dir).includes(firstTicket));
    assert.equal(tickets(dir).length, 2);
    fs.rmSync(lockFile(dir));
    await Promise.all([first, second]);
    assert.deepEqual(order, [2, 1]);
    assert.deepEqual(tickets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- run ids, stop, list, holder line, heartbeat, run cap, progress-based give-up ----

/** Starts the wrapper in `cwd`; collects stderr and stdout; `done` resolves with the exit code. */
function launch(dir, cwd, args, extra = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: env(dir, extra), stdio: ["ignore", "pipe", "pipe"] });
  const h = { child, out: "", err: "", id: () => /foreman_test_run: run (\S+) \(pid/.exec(h.err)?.[1] };
  child.stdout.on("data", (d) => (h.out += d));
  child.stderr.on("data", (d) => (h.err += d));
  h.done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return h;
}

const runsDir = (dir) => path.join(dir, "test-runs");
const recordOf = (dir, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir(dir), `${id}.json`), "utf8"));
  } catch {
    return undefined;
  }
};
const waitFor = async (cond, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    assert.ok(Date.now() < end, "condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** A holder run that exits with `code` after `ms`, in its own cwd. */
const holdRun = (dir, cwd, ms, code, extra) => launch(dir, cwd, execArgs(`setTimeout(() => process.exit(${code}), ${ms})`), extra);
const controlRun = (dir, cwd, args) => finish(spawn(process.execPath, [SCRIPT, ...args], { cwd, env: env(dir), stdio: ["ignore", "pipe", "pipe"] }));

test("a run prints its run id line, keeps a record while it runs and removes it on exit, also with the lock off", async () => {
  const dir = tmp();
  try {
    for (const extra of [{}, { FOREMAN_TEST_LOCK: "0" }]) {
      const h = launch(dir, dir, execArgs(`setTimeout(() => {}, 800)`), extra);
      const id = await waitFor(() => h.id());
      assert.match(h.err, new RegExp(`^foreman_test_run: run ${id} \\(pid ${h.child.pid}, cwd ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\); stop it with: node scripts/foreman_test_run\\.mjs --stop ${id}\n`));
      const rec = await waitFor(() => recordOf(dir, id)?.state === "running" && recordOf(dir, id));
      assert.equal(rec.pid, h.child.pid);
      assert.equal(rec.cwd, dir);
      assert.match(rec.command, /-e/);
      assert.ok(!Number.isNaN(Date.parse(rec.started)));
      assert.equal(await h.done, 0);
      assert.equal(recordOf(dir, id), undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock file carries the run id and the command", async () => {
  const dir = tmp();
  try {
    const r = await finish(run(dir, `console.log(require("fs").readFileSync(${JSON.stringify(lockFile(dir))}, "utf8"))`));
    const info = JSON.parse(r.out);
    assert.match(info.id, /^[a-z0-9]+-\d+$/);
    assert.match(info.command, /-e/);
    assert.ok(info.command.length <= 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--stop of a queued run drops it (exit 130, nothing run) and the holder in another cwd finishes with its own code", async () => {
  const dir = tmp();
  const cwdA = tmp();
  const cwdB = tmp();
  try {
    const a = holdRun(dir, cwdA, 2500, 7);
    const aId = await waitFor(() => a.id());
    await waitFor(() => recordOf(dir, aId)?.state === "running");
    const b = launch(dir, cwdB, execArgs(touchMarker(dir)));
    const bId = await waitFor(() => b.id());
    await waitFor(() => recordOf(dir, bId)?.state === "waiting");
    const s = await controlRun(dir, cwdB, ["--stop", bId]);
    assert.equal(s.code, 0);
    assert.equal(await b.done, 130);
    assert.match(b.err, new RegExp(`foreman_test_run: run ${bId} stopped on request\n$`));
    assert.ok(!fs.existsSync(marker(dir)));
    assert.equal(tickets(dir).length, 0);
    assert.equal(recordOf(dir, bId), undefined);
    assert.equal(await a.done, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--stop of a running run stops its child tree and releases the lock; a queued run in another cwd then runs", async () => {
  const dir = tmp();
  const cwdA = tmp();
  const cwdB = tmp();
  const pidFile = path.join(dir, "grandchild.pid");
  try {
    const grand = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grand)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
    const a = launch(dir, cwdA, execArgs(parent));
    const aId = await waitFor(() => a.id());
    await waitFor(() => fs.existsSync(pidFile));
    const b = launch(dir, cwdB, execArgs(`console.log("b ran")`));
    const bId = await waitFor(() => b.id());
    await waitFor(() => recordOf(dir, bId)?.state === "waiting");
    const s = await controlRun(dir, cwdA, ["--stop", aId]);
    assert.equal(s.code, 0);
    assert.match(s.out, new RegExp(`run ${aId} stopped`));
    assert.equal(await a.done, 130);
    assert.match(a.err, new RegExp(`foreman_test_run: run ${aId} stopped on request\n$`));
    assert.ok(await gone(Number(fs.readFileSync(pidFile, "utf8"))), "the grandchild is gone");
    assert.equal(recordOf(dir, aId), undefined);
    assert.equal(await b.done, 0);
    assert.match(b.out, /b ran/);
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--stop of an unknown id exits 1; a record of a dead pid is cleaned", async () => {
  const dir = tmp();
  try {
    const r = await controlRun(dir, dir, ["--stop", "nope-1"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no running run nope-1/);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.mkdirSync(runsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(runsDir(dir), "old-1.json"), JSON.stringify({ id: "old-1", pid: dead.pid, cwd: dir, command: "x", started: new Date().toISOString(), state: "running" }));
    const d = await controlRun(dir, dir, ["--stop", "old-1"]);
    assert.equal(d.code, 1);
    assert.equal(recordOf(dir, "old-1"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--stop-cwd stops this cwd's runs only; another cwd's run stays alive and finishes", async () => {
  const dir = tmp();
  const cwdA = tmp();
  const cwdB = tmp();
  try {
    const a = holdRun(dir, cwdA, 2500, 7);
    const aId = await waitFor(() => a.id());
    await waitFor(() => recordOf(dir, aId)?.state === "running");
    const b = launch(dir, cwdB, execArgs(touchMarker(dir)));
    const bId = await waitFor(() => b.id());
    await waitFor(() => recordOf(dir, bId)?.state === "waiting");
    const s = await controlRun(dir, cwdB, ["--stop-cwd"]);
    assert.equal(s.code, 0);
    assert.equal(await b.done, 130);
    assert.ok(!fs.existsSync(marker(dir)));
    assert.ok(recordOf(dir, aId), "the other cwd's run is still recorded");
    assert.equal(await a.done, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--list prints the holder and the runs, one line each", async () => {
  const dir = tmp();
  try {
    const a = holdRun(dir, dir, 60_000, 0);
    const aId = await waitFor(() => a.id());
    await waitFor(() => recordOf(dir, aId)?.state === "running", 30_000);
    const r = await controlRun(dir, dir, ["--list"]);
    assert.equal(r.code, 0);
    const lines = r.out.trim().split("\n");
    assert.match(lines[0], new RegExp(`^holder: run ${aId} \\(pid \\d+, cwd .+\\), since \\d\\d:\\d\\d: .+`));
    assert.match(lines[1], new RegExp(`^run ${aId} \\(pid \\d+, cwd .+\\), running, since \\d\\d:\\d\\d: .+`));
    assert.equal((await controlRun(dir, dir, ["--stop", aId])).code, 0);
    assert.equal(await a.done, 130);
    assert.equal((await controlRun(dir, dir, ["--list"])).out, "holder: none\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const writeHolder = (dir, id, extra = {}) =>
  fs.writeFileSync(lockFile(dir), JSON.stringify({ id, pid: process.pid, started: new Date().toISOString(), cwd: "/h", command: `cmd ${id}`, ...extra }));

test("the wait line names id, cwd, since, command and queue position, and is printed again at once when the holder changes", async () => {
  const dir = tmp();
  try {
    writeHolder(dir, "aaa-1");
    let err = "";
    const p = acquireLock(lockFile(dir), { pollMs: 10, announceMs: 600_000, maxWaitMs: 2000, stderr: { write: (s) => (err += s) } });
    await until(() => err.includes("aaa-1"));
    assert.match(err, /^waiting for the test lock held by run aaa-1 \(pid \d+, cwd \/h\), since \d\d:\d\d: cmd aaa-1, queue position 1 of 1\n$/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(err.split("\n").length, 2, "no repeat without a holder change");
    writeHolder(dir, "bbb-2");
    await until(() => err.includes("bbb-2"));
    assert.match(err.trim().split("\n")[1], /^waiting for the test lock held by run bbb-2 .*: cmd bbb-2, queue position 1 of 1$/);
    fs.rmSync(lockFile(dir));
    (await p)();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead holder is taken over, and so is a live holder whose heartbeat is older than 60 s", async () => {
  const dir = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeHolder(dir, "dead-1", { pid: dead.pid });
    (await acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 1000 }))();
    writeHolder(dir, "stale-1");
    const past = new Date(Date.now() - 61_000);
    fs.utimesSync(lockFile(dir), past, past);
    const release = await acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 1000 });
    release();
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the holder touches the lock file as a heartbeat and stops at release", async () => {
  const dir = tmp();
  try {
    const release = await acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, heartbeatMs: 20, id: "hb-1", command: "c" });
    const past = new Date(Date.now() - 30_000);
    fs.utimesSync(lockFile(dir), past, past);
    await until(() => Date.now() - fs.statSync(lockFile(dir)).mtimeMs < 5000);
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).id, "hb-1");
    release();
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live holder passing FOREMAN_TEST_LOCK_MAX_MINUTES stops its own run, releases the lock and exits 124", async () => {
  const dir = tmp();
  try {
    const h = launch(dir, dir, execArgs(`setInterval(() => {}, 1000)`), { FOREMAN_TEST_LOCK_MAX_MINUTES: "0.02" });
    const id = await waitFor(() => h.id());
    assert.equal(await h.done, 124);
    assert.match(h.err, new RegExp(`foreman_test_run: run ${id} passed the run cap of 0\\.02 min; stopped the run\n$`));
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the give-up timer counts from the last holder change: no progress ends the wait, a changing holder keeps it going", async () => {
  const dir = tmp();
  try {
    writeHolder(dir, "a-1");
    await assert.rejects(acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 200 }), (e) => e instanceof LockWaitTimeout);
    let n = 0;
    const swap = setInterval(() => writeHolder(dir, `h-${n++}`), 250);
    const p = acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 400 });
    setTimeout(() => {
      clearInterval(swap);
      fs.rmSync(lockFile(dir), { force: true });
    }, 1100);
    (await p)();
    assert.ok(n >= 3, "the holder changed several times past maxWaitMs");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- targeted mode: shared slots ----

const T2 = { FOREMAN_TEST_TARGETED_SLOTS: "2" };
const slotFile = (dir, k) => path.join(dir, `test-slot-${k}`);

/** A test file that passes once `release` exists. */
function gateTest(where, release) {
  const f = path.join(where, `gate-${Math.random().toString(36).slice(2)}.test.mjs`);
  fs.writeFileSync(
    f,
    `import { test } from "node:test";\nimport * as fs from "node:fs";\ntest("gate", async () => { while (!fs.existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 20)); });\n`,
  );
  return f;
}
const targetedRun = (dir, cwd, file, extra = {}) => launch(dir, cwd, ["--targeted", file], { ...T2, ...extra });

test("targetedSettings: defaults, overrides, invalid values, at least 1 worker", () => {
  assert.deepEqual(targetedSettings({ env: {}, cores: 16 }), { slots: 2, concurrency: 4 });
  assert.deepEqual(targetedSettings({ env: { FOREMAN_TEST_TARGETED_SLOTS: "3", FOREMAN_TEST_TARGETED_SHARE: "2" }, cores: 16 }), { slots: 3, concurrency: 8 });
  assert.deepEqual(targetedSettings({ env: { FOREMAN_TEST_TARGETED_SLOTS: "0", FOREMAN_TEST_TARGETED_SHARE: "x" }, cores: 16 }), { slots: 2, concurrency: 4 });
  assert.deepEqual(targetedSettings({ env: { FOREMAN_TEST_TARGETED_SLOTS: "-1", FOREMAN_TEST_TARGETED_SHARE: "1.5" }, cores: 8 }), { slots: 2, concurrency: 2 });
  assert.equal(targetedSettings({ env: { FOREMAN_TEST_TARGETED_SHARE: "64" }, cores: 4 }).concurrency, 1);
  assert.equal(targetedSettings({ env: { FOREMAN_TEST_CONCURRENCY: "9" }, cores: 8 }).concurrency, 2);
  assert.deepEqual(slotPaths({ FOREMAN_TEST_LOCK_DIR: "/x" }, 2).map((p) => path.basename(p)), ["test-slot-0", "test-slot-1"]);
});

test("targeted: two runs hold slots at once, a third waits and prints both holders, then runs when one frees", async () => {
  const dir = tmp();
  const cwd = tmp();
  try {
    const rel = [path.join(cwd, "r0"), path.join(cwd, "r1"), path.join(cwd, "r2")];
    const a = targetedRun(dir, cwd, gateTest(cwd, rel[0]));
    const b = targetedRun(dir, cwd, gateTest(cwd, rel[1]));
    const aId = await waitFor(() => a.id());
    const bId = await waitFor(() => b.id());
    await waitFor(() => recordOf(dir, aId)?.state === "running" && recordOf(dir, bId)?.state === "running");
    assert.equal(recordOf(dir, aId).mode, "targeted");
    assert.ok(fs.existsSync(slotFile(dir, 0)) && fs.existsSync(slotFile(dir, 1)));
    const c = targetedRun(dir, cwd, gateTest(cwd, rel[2]));
    const cId = await waitFor(() => c.id());
    await waitFor(() => /waiting for a targeted test slot/.test(c.err));
    assert.match(c.err, /waiting for a targeted test slot \(2 of 2 busy\), queue position 1 of 1; held by: run \S+ \(pid \d+, cwd [^)]*\), since \d\d:\d\d: [^;]*; run /);
    assert.ok(c.err.includes(`run ${aId} `) && c.err.includes(`run ${bId} `));
    assert.equal(recordOf(dir, cId).state, "waiting");
    fs.writeFileSync(rel[0], "");
    assert.equal(await a.done, 0);
    await waitFor(() => recordOf(dir, cId)?.state === "running");
    fs.writeFileSync(rel[1], "");
    fs.writeFileSync(rel[2], "");
    assert.equal(await b.done, 0);
    assert.equal(await c.done, 0);
    assert.ok(!fs.existsSync(slotFile(dir, 0)) && !fs.existsSync(slotFile(dir, 1)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("targeted: a full-suite lock holder does not block a targeted run, and a targeted run does not block the suite", async () => {
  const dir = tmp();
  const cwd = tmp();
  try {
    const hold = holdRun(dir, cwd, 2500, 7);
    const hId = await waitFor(() => hold.id());
    await waitFor(() => recordOf(dir, hId)?.state === "running");
    const rel = path.join(cwd, "rel");
    const t = targetedRun(dir, cwd, gateTest(cwd, rel));
    const tId = await waitFor(() => t.id());
    await waitFor(() => recordOf(dir, tId)?.state === "running");
    assert.ok(!/waiting/.test(t.err));
    const suite = launch(dir, cwd, execArgs("process.exit(0)"));
    await waitFor(() => /waiting for the test lock/.test(suite.err));
    assert.ok(!/targeted/.test(suite.err));
    fs.writeFileSync(rel, "");
    assert.equal(await t.done, 0);
    assert.equal(await hold.done, 7);
    assert.equal(await suite.done, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("targeted: a dead-pid slot holder is taken over", async () => {
  const dir = tmp();
  const cwd = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    for (const k of [0, 1]) fs.writeFileSync(slotFile(dir, k), JSON.stringify({ id: `dead-${k}`, pid: dead.pid, started: new Date().toISOString(), cwd: "/x", command: "c" }));
    const rel = path.join(cwd, "rel");
    fs.writeFileSync(rel, "");
    const t = targetedRun(dir, cwd, gateTest(cwd, rel));
    assert.equal(await t.done, 0);
    assert.ok(!/waiting for a targeted/.test(t.err));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("targeted: --stop of a queued targeted run exits 130 and leaves the slot holders alive; --list shows the slots", async () => {
  const dir = tmp();
  const cwd = tmp();
  try {
    const rel = path.join(cwd, "rel");
    const a = targetedRun(dir, cwd, gateTest(cwd, rel));
    const b = targetedRun(dir, cwd, gateTest(cwd, rel));
    const aId = await waitFor(() => a.id());
    const bId = await waitFor(() => b.id());
    await waitFor(() => recordOf(dir, aId)?.state === "running" && recordOf(dir, bId)?.state === "running");
    const c = targetedRun(dir, cwd, gateTest(cwd, rel));
    const cId = await waitFor(() => c.id());
    await waitFor(() => recordOf(dir, cId)?.state === "waiting");
    const l = await controlRun(dir, cwd, ["--list"]);
    assert.match(l.out, /slot 0: run \S+/);
    assert.match(l.out, /slot 1: run \S+/);
    const s = await controlRun(dir, cwd, ["--stop", cId]);
    assert.equal(s.code, 0);
    assert.equal(await c.done, 130);
    assert.equal(recordOf(dir, aId)?.state, "running");
    assert.equal(recordOf(dir, bId)?.state, "running");
    fs.writeFileSync(rel, "");
    assert.equal(await a.done, 0);
    assert.equal(await b.done, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- old-format locks, signals while waiting, stop file cleanup ----

test("a live lock without an id is not taken over for its file age (no heartbeat), only when started is older than the max", async () => {
  const dir = tmp();
  try {
    const idless = (started) => fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, started, cwd: "/old" }));
    idless(new Date().toISOString());
    const past = new Date(Date.now() - 61_000);
    fs.utimesSync(lockFile(dir), past, past);
    await assert.rejects(acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 300 }), (e) => e instanceof LockWaitTimeout);
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).cwd, "/old", "the old-format lock is still there");
    const h = await finish(spawn(process.execPath, [SCRIPT, "--exec", "--", process.execPath, "-e", ""], { env: env(dir, { FOREMAN_TEST_LOCK_WAIT_MINUTES: "0.005" }), stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(h.code, 75);
    idless(new Date(Date.now() - 31 * 60_000).toISOString());
    const release = await acquireLock(lockFile(dir), { pollMs: 10, stderr: quiet, maxWaitMs: 1000 });
    release();
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM while waiting removes the record and the ticket", { skip: process.platform === "win32" && "SIGTERM is TerminateProcess on Windows, no handler runs" }, async () => {
  const dir = tmp();
  try {
    writeHolder(dir, "busy-1");
    const h = launch(dir, dir, execArgs(""));
    const id = await waitFor(() => h.id());
    await waitFor(() => h.err.includes("waiting for the test lock") && recordOf(dir, id)?.state === "waiting");
    h.child.kill("SIGTERM");
    assert.equal(await h.done, 143);
    assert.equal(recordOf(dir, id), undefined);
    assert.deepEqual(fs.readdirSync(runsDir(dir)), []);
    assert.deepEqual(tickets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop file is removed when the run ends", async () => {
  const dir = tmp();
  try {
    writeHolder(dir, "busy-1");
    const s = launch(dir, dir, execArgs(""));
    const sid = await waitFor(() => s.id());
    await waitFor(() => recordOf(dir, sid)?.state === "waiting");
    const stop = path.join(runsDir(dir), `${sid}.stop`);
    fs.writeFileSync(stop, "");
    assert.equal(await s.done, 130);
    assert.ok(!fs.existsSync(stop));
    assert.deepEqual(fs.readdirSync(runsDir(dir)), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock's started is the moment it was taken, not when the wait began", async () => {
  const dir = tmp();
  try {
    writeHolder(dir, "first-1");
    const p = acquireLock(lockFile(dir), { pollMs: 10, announceMs: 600_000, maxWaitMs: 10_000, stderr: { write: () => {} } });
    await new Promise((r) => setTimeout(r, 1500));
    const released = Date.now();
    fs.rmSync(lockFile(dir));
    const release = await p;
    const started = Date.parse(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).started);
    assert.ok(started >= released - 50, `started ${released - started} ms before the release`);
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Run temp root: the command's TMPDIR points into a pf-run-* dir the run removes at its end. These runs use their own temp base and HOME,
// so neither the sweep nor the root touches the real temp dir.
function rootEnv(dir, extra = {}) {
  const b = tmp();
  const home = tmp();
  const e = env(dir, { TMPDIR: b, TMP: b, TEMP: b, HOME: home, USERPROFILE: home, ...extra });
  delete e.FOREMAN_TEST_TMP_ROOT;
  delete e.PI_FOREMAN_TEST_TMP;
  return { e, bases: [b, path.join(home, ".cache", "pi-foreman-tests")] };
}
const runRoots = (bases) => bases.flatMap((b) => (fs.existsSync(b) ? fs.readdirSync(b).filter((n) => n.startsWith("pf-run-")).map((n) => path.join(b, n)) : []));
const spawnExec = (e, code, extraArgs = []) => finish(spawn(process.execPath, [SCRIPT, ...extraArgs, "--exec", "--", process.execPath, "-e", code], { env: e, stdio: ["ignore", "pipe", "pipe"] }));
const SHOW_ROOT = `console.log(JSON.stringify({ tmp: process.env.TMPDIR, root: process.env.FOREMAN_TEST_TMP_ROOT, exists: require("fs").existsSync(process.env.FOREMAN_TEST_TMP_ROOT), os: require("os").tmpdir() }))`;

test("a run's command sees TMPDIR inside a pf-run- root, which is gone after the run", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir);
  const r = await spawnExec(e, SHOW_ROOT);
  assert.equal(r.code, 0);
  const seen = JSON.parse(r.out);
  assert.equal(seen.tmp, seen.root);
  assert.equal(seen.os, seen.root);
  assert.ok(path.basename(seen.root).startsWith("pf-run-"));
  assert.ok(bases.includes(path.dirname(seen.root)));
  assert.equal(seen.exists, true);
  assert.ok(!fs.existsSync(seen.root));
  assert.deepEqual(runRoots(bases), []);
  assert.doesNotMatch(r.err, /temp entries left/);
});

test("node mode puts the spawn-count dir inside the run root", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir);
  const file = path.join(dir, "t.test.mjs");
  fs.writeFileSync(file, `import { test } from "node:test"; test("x", () => { console.log("SC=" + process.env.FOREMAN_SPAWN_COUNT_DIR); });`);
  const r = await finish(spawn(process.execPath, [SCRIPT, file], { env: e, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(r.code, 0, r.err);
  const sc = /SC=(\S+)/.exec(r.out)?.[1];
  assert.ok(sc && path.basename(path.dirname(sc)).startsWith("pf-run-") && bases.includes(path.dirname(path.dirname(sc))), sc);
  assert.deepEqual(runRoots(bases), []);
});

test("entries a test left in the run root are named on stderr (a warning, exit code kept) and removed", async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir);
  const mk = (n) => `require("fs").mkdirSync(require("path").join(process.env.FOREMAN_TEST_TMP_ROOT, ${JSON.stringify(n)}))`;
  const r = await spawnExec(e, `${mk("pf-leak-a")}; ${mk("pf-leak-b")}; process.exit(0)`);
  assert.equal(r.code, 0);
  assert.match(r.err, /test-run: 2 temp entries left by this run: pf-leak-a, pf-leak-b\n/);
  assert.deepEqual(runRoots(bases), []);
});

test("the end warning names at most five leftovers", async () => {
  const dir = tmp();
  const { e } = rootEnv(dir);
  const code = `for (let i = 0; i < 7; i++) require("fs").mkdirSync(require("path").join(process.env.FOREMAN_TEST_TMP_ROOT, "pf-l" + i))`;
  const r = await spawnExec(e, code);
  assert.match(r.err, /test-run: 7 temp entries left by this run: pf-l0, pf-l1, pf-l2, pf-l3, pf-l4\n/);
});

test("a nested run reuses the outer root and does not remove it", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir, { FOREMAN_TEST_LOCK: "0" });
  const inner = `const r = require("child_process").spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}, "--exec", "--", process.execPath, "-e", ${JSON.stringify(SHOW_ROOT)}], { encoding: "utf8" });
    const inn = JSON.parse(r.stdout);
    console.log(JSON.stringify({ outer: process.env.FOREMAN_TEST_TMP_ROOT, inner: inn.root, stillThere: require("fs").existsSync(process.env.FOREMAN_TEST_TMP_ROOT), err: r.stderr }))`;
  const r = await spawnExec(e, inner);
  assert.equal(r.code, 0, r.err);
  const seen = JSON.parse(r.out);
  assert.equal(seen.inner, seen.outer);
  assert.equal(seen.stillThere, true);
  assert.doesNotMatch(seen.err, /temp entries left/);
  assert.deepEqual(runRoots(bases), []);
});

test("--stop of a running run removes its root", async () => {
  const dir = tmp();
  const cwd = tmp();
  const { e, bases } = rootEnv(dir);
  const up = path.join(dir, "up");
  const child = spawn(process.execPath, [SCRIPT, ...execArgs(`require("fs").writeFileSync(${JSON.stringify(up)}, process.env.FOREMAN_TEST_TMP_ROOT); setTimeout(() => {}, 60000)`)], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const root = await waitFor(() => fs.existsSync(up) && fs.readFileSync(up, "utf8"));
  assert.ok(fs.existsSync(root));
  const id = /foreman_test_run: run (\S+) \(pid/.exec(err)[1];
  const s = await finish(spawn(process.execPath, [SCRIPT, "--stop", id], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(s.code, 0);
  assert.equal(await done, 130);
  assert.ok(!fs.existsSync(root));
  assert.deepEqual(runRoots(bases), []);
});

test("a run that gives up waiting for the lock (75) leaves no root behind", async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir, { FOREMAN_TEST_LOCK_WAIT_MINUTES: "0.02" });
  liveLock(dir, "/held/here");
  const r = await spawnExec(e, touchMarker(dir));
  assert.equal(r.code, 75);
  assert.ok(!fs.existsSync(marker(dir)));
  assert.deepEqual(runRoots(bases), []);
});

test("the start sweep removes old pf- entries in the temp base and leaves fresh and non-pf ones", async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir);
  const [b] = bases;
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const n of ["pf-old-sweep", "keep-old"]) {
    fs.mkdirSync(path.join(b, n));
    fs.utimesSync(path.join(b, n), old, old);
  }
  fs.mkdirSync(path.join(b, "pf-fresh-sweep"));
  const r = await spawnExec(e, "");
  assert.equal(r.code, 0);
  assert.deepEqual(fs.readdirSync(b).sort(), ["keep-old", "pf-fresh-sweep"]);
});

test("a detached run's command sees TMPDIR inside a pf-run- root, removed by the worker after the run; --wait and --history sweep nothing", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const { e, bases } = rootEnv(dir);
  delete e.CI;
  const [b] = bases;
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const mkOld = (n) => {
    fs.mkdirSync(path.join(b, n));
    fs.utimesSync(path.join(b, n), old, old);
  };
  // the control calls leave an old pf- entry alone
  mkOld("pf-old-control");
  for (const args of [["--wait", "nope", "--max", "1"], ["--history"]]) {
    await finish(spawn(process.execPath, [SCRIPT, ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] }));
  }
  assert.ok(fs.existsSync(path.join(b, "pf-old-control")));
  // the launcher returns at once and leaves no root; the worker makes one for the command
  const code = `setTimeout(() => { console.log("SEEN=" + JSON.stringify({ tmp: process.env.TMPDIR, root: process.env.FOREMAN_TEST_TMP_ROOT, exists: require("fs").existsSync(process.env.FOREMAN_TEST_TMP_ROOT) })); }, 1500)`;
  const launch = await spawnExec({ ...e, FOREMAN_TEST_DETACH: "1" }, code);
  assert.equal(launch.code, 0, launch.err);
  assert.deepEqual(runRoots(bases), []);
  const id = /run ([a-z0-9-]+) detached/.exec(launch.out)[1];
  const w = await finish(spawn(process.execPath, [SCRIPT, "--wait", id, "--max", "30"], { env: e, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(w.code, 0, w.out + w.err);
  const seen = JSON.parse(/SEEN=(.*)/.exec(w.out)[1]);
  assert.equal(seen.tmp, seen.root);
  assert.ok(path.basename(seen.root).startsWith("pf-run-"));
  assert.ok(bases.includes(path.dirname(seen.root)));
  assert.equal(seen.exists, true);
  // the done file is written before the root is removed: poll briefly
  for (let i = 0; i < 100 && fs.existsSync(seen.root); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(!fs.existsSync(seen.root));
  assert.deepEqual(runRoots(bases), []);
  // the worker's start swept the old entry (a run mode), proving the sweep ran in the worker and not in the control calls
  assert.ok(!fs.existsSync(path.join(b, "pf-old-control")));
});

// --- signals sent to the wrapper itself ---

const POSIX_ONLY = { skip: process.platform === "win32" && "POSIX signals" };
/** A command that ignores SIGTERM and SIGHUP, starts a grandchild doing the same, and records the grandchild's pid. */
function stubbornTree(pidFile) {
  const grand = `process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  return `process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grand)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
}

test("SIGTERM to a running wrapper stops the whole tree, releases the lock, exits 143 and lets a queued caller run", POSIX_ONLY, async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "grandchild.pid");
  try {
    const holder = launch(dir, dir, execArgs(stubbornTree(pidFile)));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
    const grandPid = Number(fs.readFileSync(pidFile, "utf8"));
    const second = launch(dir, dir, execArgs(touchMarker(dir)));
    const sid = await waitFor(() => second.id());
    await waitFor(() => recordOf(dir, sid)?.state === "waiting");
    const sent = Date.now();
    holder.child.kill("SIGTERM");
    assert.equal(await holder.done, 143);
    assert.ok(Date.now() - sent < 15_000, "the wrapper exited promptly");
    assert.ok(await gone(grandPid), "the grandchild is gone");
    assert.equal(await second.done, 0);
    assert.ok(fs.existsSync(marker(dir)), "the queued caller ran");
    assert.ok(!fs.existsSync(lockFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGHUP to a running wrapper stops the whole tree, releases the lock and exits 129", POSIX_ONLY, async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "grandchild.pid");
  try {
    const holder = launch(dir, dir, execArgs(stubbornTree(pidFile)));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
    const grandPid = Number(fs.readFileSync(pidFile, "utf8"));
    holder.child.kill("SIGHUP");
    assert.equal(await holder.done, 129);
    assert.ok(await gone(grandPid), "the grandchild is gone");
    assert.ok(!fs.existsSync(lockFile(dir)));
    const later = await finish(run(dir, "process.exit(0)"));
    assert.equal(later.code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGHUP to a queued wrapper drops its ticket and does not block a later caller", POSIX_ONLY, async () => {
  const dir = tmp();
  try {
    const holder = launch(dir, dir, execArgs(`setInterval(() => {}, 1000)`));
    await waitFor(() => holder.id() && recordOf(dir, holder.id())?.state === "running");
    const waiter = launch(dir, dir, execArgs(touchMarker(dir)));
    const wid = await waitFor(() => waiter.id());
    await waitFor(() => recordOf(dir, wid)?.state === "waiting" && tickets(dir).length === 1);
    waiter.child.kill("SIGHUP");
    assert.equal(await waiter.done, 129);
    assert.deepEqual(tickets(dir), []);
    assert.equal(recordOf(dir, wid), undefined);
    const later = launch(dir, dir, execArgs(touchMarker(dir)));
    const lid = await waitFor(() => later.id());
    await waitFor(() => recordOf(dir, lid)?.state === "waiting");
    holder.child.kill("SIGINT");
    assert.equal(await holder.done, 130);
    assert.equal(await later.done, 0);
    assert.ok(fs.existsSync(marker(dir)), "the later caller ran");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeTestArgs forwards --test-shard to node, before --test", () => {
  assert.deepEqual(nodeTestArgs(["--import", "./h.mjs", "--test-shard=2/3", "a/*.ts", "b/*.ts"], 2), ["--import", "./h.mjs", "--test-shard=2/3", "--test", "--test-concurrency=2", "a/*.ts", "b/*.ts"]);
});
