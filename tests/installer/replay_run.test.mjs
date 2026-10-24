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
