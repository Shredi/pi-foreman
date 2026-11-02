// scripts/replay_run.mjs on fake replay modules: pool bound, serial order, exit codes and failure tails.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runner = path.join(repo, "scripts", "replay_run.mjs");

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-replay-run-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A unittest module that records its start and end (time.time()) in the log dir, sleeps, then runs `body`. */
function fakeModule(name, body) {
  return `import os, time, unittest

def mark(ev):
    with open(os.path.join(os.environ["REPLAY_RUN_LOG"], "${name}." + ev), "w") as f:
        f.write(repr(time.time()))

class T(unittest.TestCase):
    def test_run(self):
        mark("start")
        try:
            time.sleep(1.0)
${body.map((l) => `            ${l}`).join("\n")}
        finally:
            mark("end")
`;
}

const passing = (name) => fakeModule(name, ["pass"]);
const failing = (name) =>
  fakeModule(name, ["for i in range(120):", "    print('filler line %03d' % i)", "self.fail('boom-marker')"]);

function makeDir(name, modules) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(modules)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

function makeLog(name) {
  const log = path.join(tmp, name);
  fs.mkdirSync(log);
  return log;
}

function run(dir, { jobs, serial = "", log }) {
  const env = { ...process.env, REPLAY_RUN_LOG: log };
  if (jobs !== undefined) env.FOREMAN_REPLAY_JOBS = String(jobs);
  return spawnSync(process.execPath, [runner, "--dir", dir, "--serial", serial], { env, encoding: "utf8", timeout: 180_000 });
}

function readStamps(log, name) {
  const read = (ev) => {
    const f = path.join(log, `${name}.${ev}`);
    return fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : null;
  };
  return { start: read("start"), end: read("end") };
}

test("pool stays within FOREMAN_REPLAY_JOBS and the serial module starts after the pool", () => {
  const log = makeLog("log-pool");
  const dir = makeDir("pool", {
    "test_fake_a.py": passing("test_fake_a"),
    "test_fake_b.py": passing("test_fake_b"),
    "test_fake_c.py": passing("test_fake_c"),
    "test_fake_d.py": failing("test_fake_d"),
    "test_fake_serial.py": passing("test_fake_serial"),
  });
  const r = run(dir, { jobs: 2, serial: "test_fake_serial", log });
  assert.equal(r.status, 1, r.stdout + r.stderr);

  const pool = ["test_fake_a", "test_fake_b", "test_fake_c", "test_fake_d"].map((m) => readStamps(log, m));
  for (const s of pool) assert.ok(s.start !== null && s.end !== null, "every pool module ran");
  // Peak overlap of the pool: a module is in flight from its start to its end.
  let peak = 0;
  for (const s of pool) {
    const inFlight = pool.filter((o) => o.start <= s.start && s.start < o.end).length;
    peak = Math.max(peak, inFlight);
  }
  assert.ok(peak <= 2, `pool peak ${peak} exceeds FOREMAN_REPLAY_JOBS=2`);
  assert.ok(peak === 2, `pool never ran two modules at once (peak ${peak})`);

  const serial = readStamps(log, "test_fake_serial");
  assert.ok(serial.start !== null, "serial module ran");
  const poolEnd = Math.max(...pool.map((s) => s.end));
  assert.ok(serial.start >= poolEnd, "serial module started before the pool finished");
});

test("exit 0 and a PASS line per module when every module passes", () => {
  const log = makeLog("log-pass");
  const dir = makeDir("all-pass", {
    "test_fake_a.py": passing("test_fake_a"),
    "test_fake_serial.py": passing("test_fake_serial"),
  });
  const r = run(dir, { jobs: 2, serial: "test_fake_serial", log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS test_fake_a 1 tests [\d.]+s$/m);
  assert.match(r.stdout, /^PASS test_fake_serial 1 tests [\d.]+s$/m);
  assert.match(r.stdout, /replay modules: 2 passed, 0 failed/);
});

test("exit 1, FAIL line and the last 80 lines of the failing module", () => {
  const log = makeLog("log-fail");
  const dir = makeDir("one-fail", {
    "test_fake_a.py": passing("test_fake_a"),
    "test_fake_fail.py": failing("test_fake_fail"),
  });
  const r = run(dir, { jobs: 2, log });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL test_fake_fail 1 tests [\d.]+s$/m);
  assert.match(r.stdout, /^PASS test_fake_a 1 tests/m);
  assert.match(r.stdout, /--- FAIL test_fake_fail: last 80 lines ---/);
  assert.match(r.stdout, /boom-marker/);
  assert.match(r.stdout, /filler line 119/);
  assert.doesNotMatch(r.stdout, /filler line 000/);
  assert.match(r.stdout, /replay modules: 1 passed, 1 failed/);
});

test("exit 2 when the directory holds no replay module", () => {
  const dir = makeDir("empty", { "helper.py": "" });
  const r = run(dir, { jobs: 2, log: tmp });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no replay modules \(test_\*\.py\) found/);
});

test("exit 2 for a FOREMAN_REPLAY_JOBS that is not a positive integer", () => {
  const dir = makeDir("bad-jobs", { "test_fake_a.py": passing("test_fake_a") });
  const r = run(dir, { jobs: "0", log: tmp });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /FOREMAN_REPLAY_JOBS must be a positive integer/);
});

// --shard, FOREMAN_REPLAY_SHARD and --list: selection on dummy modules (only the one run test starts Python).
const POOL_MODULES = Array.from({ length: 10 }, (_, k) => `test_shard_p${String(k).padStart(2, "0")}`);
const SERIAL_MODULES = ["test_shard_s0", "test_shard_s1", "test_shard_s2"];
const SHARD_ARGS = ["--serial", SERIAL_MODULES.join(",")];

let shardFixture;
function fixtureDir() {
  if (!shardFixture) {
    shardFixture = makeDir("shard-fixture", Object.fromEntries([...POOL_MODULES, ...SERIAL_MODULES].map((m) => [`${m}.py`, ""])));
  }
  return shardFixture;
}

/** Runs the runner on the fixture dir; FOREMAN_REPLAY_SHARD is cleared unless the env names it. */
function runRunner(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!("FOREMAN_REPLAY_SHARD" in env)) delete childEnv.FOREMAN_REPLAY_SHARD;
  return spawnSync(process.execPath, [runner, "--dir", fixtureDir(), ...args], { env: childEnv, encoding: "utf8", timeout: 180_000 });
}

/** The stems `--list` prints for these args (CRLF-safe). */
function listStems(args, env) {
  const r = runRunner(["--list", ...SHARD_ARGS, ...args], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

test("--list with no shard prints every module, pool first then serial", () => {
  assert.deepEqual(listStems([]), [...POOL_MODULES, ...SERIAL_MODULES]);
});

test("shards 1..n are disjoint and their union is every module for n = 1..4 and n above the module count", () => {
  const all = [...POOL_MODULES, ...SERIAL_MODULES].sort();
  for (const n of [1, 2, 3, 4, 20]) {
    const seen = [];
    for (let i = 1; i <= n; i += 1) seen.push(...listStems(["--shard", `${i}/${n}`]));
    assert.equal(new Set(seen).size, seen.length, `n=${n}: a module is in two shards`);
    assert.deepEqual([...seen].sort(), all, `n=${n}: union is not every module`);
  }
});

test("a shard lists the same modules on every run", () => {
  assert.deepEqual(listStems(["--shard", "2/3"]), listStems(["--shard", "2/3"]));
});

test("serial modules land on different shards", () => {
  for (const n of [2, 3, 4]) {
    const shardOf = new Map();
    for (let i = 1; i <= n; i += 1) {
      for (const stem of listStems(["--shard", `${i}/${n}`])) {
        if (SERIAL_MODULES.includes(stem)) shardOf.set(stem, i);
      }
    }
    assert.equal(shardOf.size, SERIAL_MODULES.length, `n=${n}: a serial module is in no shard`);
    assert.equal(new Set(shardOf.values()).size, Math.min(SERIAL_MODULES.length, n), `n=${n}: ${JSON.stringify([...shardOf])}`);
  }
});

test("within a shard the serial modules come after the pool modules", () => {
  for (let i = 1; i <= 3; i += 1) {
    const stems = listStems(["--shard", `${i}/3`]);
    const first = stems.findIndex((s) => SERIAL_MODULES.includes(s));
    if (first === -1) continue;
    assert.ok(stems.slice(first).every((s) => SERIAL_MODULES.includes(s)), `shard ${i}/3: ${stems.join(" ")}`);
  }
});

test("FOREMAN_REPLAY_SHARD selects the same shard as the flag", () => {
  assert.deepEqual(listStems([], { FOREMAN_REPLAY_SHARD: "2/3" }), listStems(["--shard", "2/3"]));
});

test("the --shard flag wins over FOREMAN_REPLAY_SHARD", () => {
  assert.deepEqual(listStems(["--shard", "1/3"], { FOREMAN_REPLAY_SHARD: "3/3" }), listStems(["--shard", "1/3"]));
});

test("bad shard specs exit 2 with usage, from the flag or the env", () => {
  for (const spec of ["0/4", "5/4", "a/b", "1/0", "", "1/4/2"]) {
    const r = runRunner(["--list", ...SHARD_ARGS, "--shard", spec]);
    assert.equal(r.status, 2, `--shard "${spec}": ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: node scripts\/replay_run\.mjs/);
  }
  const r = runRunner(["--list", ...SHARD_ARGS], { FOREMAN_REPLAY_SHARD: "5/4" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /FOREMAN_REPLAY_SHARD must be i\/n/);
});

test("--list starts no Python", () => {
  const r = runRunner(["--list", ...SHARD_ARGS, "--shard", "1/4"], { PI_FOREMAN_PYTHON: path.join(tmp, "no-such-python") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a shard with no modules exits 0 and says so", () => {
  const r = runRunner([...SHARD_ARGS, "--shard", "20/20"], { PI_FOREMAN_PYTHON: path.join(tmp, "no-such-python") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /shard 20\/20 selects no module/);
});

test("a sharded run executes only its modules and names the shard in the summary", () => {
  const log = makeLog("log-shard-run");
  const dir = makeDir("shard-run", {
    "test_fake_a.py": passing("test_fake_a"),
    "test_fake_b.py": passing("test_fake_b"),
  });
  const r = spawnSync(process.execPath, [runner, "--dir", dir, "--shard", "2/2"], {
    env: { ...process.env, REPLAY_RUN_LOG: log, FOREMAN_REPLAY_SHARD: "" },
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS test_fake_b 1 tests/m);
  assert.doesNotMatch(r.stdout, /test_fake_a/);
  assert.match(r.stdout, /replay modules: 1 passed, 0 failed \(1 modules, \d+ workers, 0 serial, shard 2\/2, wall /);
  assert.equal(readStamps(log, "test_fake_a").start, null, "shard 2/2 ran test_fake_a");
});
