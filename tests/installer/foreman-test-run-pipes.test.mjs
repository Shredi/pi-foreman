// A detached descendant that holds the tee pipes must not keep a generic run (and its lock) alive.
import { test, after } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const POSIX_ONLY = { skip: process.platform === "win32" };

const MADE = [];
const GRANDKIDS = [];
after(() => {
  for (const p of GRANDKIDS) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  for (const d of MADE) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pipes-")));
  MADE.push(d);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  assert.fail(`timeout: ${what}`);
}
function env(lock, out) {
  const e = { ...process.env, FOREMAN_TEST_LOCK_DIR: lock, FOREMAN_OUT: out, FOREMAN_TEST_REUSE: "0" };
  for (const k of ["CI", "NODE_TEST_CONTEXT", "FOREMAN_TEST_LOCK", "FOREMAN_TEST_DETACH", "FOREMAN_TEST_OUTER_RUN"]) delete e[k];
  return e;
}
// a child that leaves a reparented (double-forked) descendant holding its stdout/stderr, then stays alive itself
const childCode = (pidFile) =>
  `require('child_process').spawnSync('sh',['-c','sleep 120 & echo $! > '+${JSON.stringify(pidFile)}],{stdio:'inherit'});console.log('child up');setTimeout(()=>{},120000)`;

/** Starts the wrapper behind an intermediate sh so that killing the sh orphans it. */
function start(e, pidFile) {
  const sh = spawn("sh", ["-c", '"$@" & wait', "sh", process.execPath, SCRIPT, "--generic", "--", process.execPath, "-e", childCode(pidFile)], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  sh.stderr.on("data", (d) => (err += d));
  sh.stdout.resume();
  const info = () => /run (\S+) \(pid (\d+),/.exec(err);
  return { sh, err: () => err, id: () => info()?.[1], wpid: () => Number(info()?.[2]) };
}
const grandkid = (pidFile) => {
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  GRANDKIDS.push(pid);
  return pid;
};
async function laterCallerRuns(e) {
  const r = spawnSync(process.execPath, [SCRIPT, "--generic", "--", process.execPath, "-e", "console.log('later ran')"], { env: { ...e, FOREMAN_TEST_LOCK_WAIT_MINUTES: "1" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /later ran/);
}

test("a SIGKILLed caller with a pipe-holding descendant: the wrapper exits and a later caller gets the lock", POSIX_ONLY, async () => {
  const lock = tmp();
  const out = tmp();
  const dir = tmp();
  const pidFile = path.join(dir, "gk.pid");
  const e = env(lock, out);
  const run = start(e, pidFile);
  await until(() => fs.existsSync(pidFile) && run.wpid(), 20_000, "child up");
  const gk = grandkid(pidFile);
  const wpid = run.wpid();
  run.sh.kill("SIGKILL");
  await until(() => !alive(wpid), 20_000, "orphaned wrapper exit");
  assert.ok(alive(gk), "the descendant is still holding the pipes");
  await laterCallerRuns(e);
});

test("--stop ends a run whose descendant holds the pipes", POSIX_ONLY, async () => {
  const lock = tmp();
  const out = tmp();
  const dir = tmp();
  const pidFile = path.join(dir, "gk.pid");
  const e = env(lock, out);
  const run = start(e, pidFile);
  await until(() => fs.existsSync(pidFile) && run.id(), 20_000, "child up");
  const gk = grandkid(pidFile);
  const wpid = run.wpid();
  const s = spawnSync(process.execPath, [SCRIPT, "--generic", "--stop", run.id()], { env: e, encoding: "utf8", timeout: 30_000 });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  await until(() => !alive(wpid), 20_000, "wrapper exit after --stop");
  assert.ok(alive(gk), "the descendant is still holding the pipes");
  await laterCallerRuns(e);
});

test("a normal tee run still logs all output written before the child exited", POSIX_ONLY, () => {
  const lock = tmp();
  const out = tmp();
  const code = "for(let i=0;i<2000;i++)process.stdout.write('line '+i+' '+'x'.repeat(80)+'\\n');process.stderr.write('tail err\\n')";
  const r = spawnSync(process.execPath, [SCRIPT, "--generic", "--", process.execPath, "-e", code], { env: env(lock, out), cwd: tmp(), encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const logFile = /foreman_test_run: log (\S+\.log)/.exec(r.stderr)[1];
  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /line 1999 /);
  assert.match(log, /tail err/);
  assert.equal(log.split("\n").filter((l) => l.startsWith("line ")).length, 2000);
});
