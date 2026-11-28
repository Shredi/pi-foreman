// scripts/foreman_test_run.mjs generic mode: `foreman test-run [--detach] [--targeted] -- <cmd>`, one log per run, nested runs.
import { test, after } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { genericArgs } = await import(pathToFileURL(SCRIPT).href);

const MADE = [];
after(() => {
  for (const d of MADE) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-generic-")));
  MADE.push(d);
  return d;
};
function env(lockDir, out, extra = {}) {
  const e = { ...process.env, FOREMAN_TEST_LOCK_DIR: lockDir, FOREMAN_OUT: out, FOREMAN_TEST_REUSE: "0", ...extra };
  for (const k of ["CI", "NODE_TEST_CONTEXT", "FOREMAN_TEST_LOCK", "FOREMAN_TEST_DETACH", "FOREMAN_TEST_OUTER_RUN"]) delete e[k];
  return { ...e, ...extra };
}
const foreman = (args, e, cwd) => spawnSync(process.execPath, [SCRIPT, "--generic", ...args], { env: e, cwd, encoding: "utf8", timeout: 60_000 });

test("genericArgs maps the generic form to --exec and rejects a missing command", () => {
  assert.deepEqual(genericArgs(["--", "npm", "test"]), ["--exec", "--", "npm", "test"]);
  assert.deepEqual(genericArgs(["--targeted", "--detach", "--", "x"]), ["--detach", "--targeted", "--exec", "--", "x"]);
  assert.deepEqual(genericArgs(["--wait", "abc"]), ["--wait", "abc"]);
  assert.deepEqual(genericArgs(["--targeted", "--import", "./x.mjs", "a.test.mjs"]), ["--targeted", "--import", "./x.mjs", "a.test.mjs"]);
  assert.equal(genericArgs(["npm", "test"]), undefined);
  assert.equal(genericArgs(["--targeted"]), undefined);
  assert.equal(genericArgs(["--"]), undefined);
});

test("a foreground run in a temp repo writes one log under FOREMAN_OUT and prints its path", () => {
  const lock = tmp();
  const out = tmp();
  const repo = tmp();
  const r = foreman(["--", process.execPath, "-e", "console.log('hello from generic'); console.error('err line'); process.exit(4)"], env(lock, out), repo);
  assert.equal(r.status, 4);
  const m = /foreman_test_run: log (\S+\.log)/.exec(r.stderr);
  assert.ok(m, r.stderr);
  assert.ok(m[1].startsWith(path.join(out, "test-runs")), m[1]);
  const log = fs.readFileSync(m[1], "utf8");
  assert.match(log, /hello from generic/);
  assert.match(log, /err line/);
  assert.match(r.stdout, /hello from generic/);
});

test("without FOREMAN_OUT the log goes to the temp dir", () => {
  const lock = tmp();
  const e = env(lock, "");
  delete e.FOREMAN_OUT;
  const r = foreman(["--", process.execPath, "-e", "0"], e, tmp());
  assert.equal(r.status, 0);
  const m = /foreman_test_run: log (\S+\.log)/.exec(r.stderr);
  assert.ok(m, r.stderr);
  assert.ok(m[1].startsWith(path.join(os.tmpdir(), "pi-foreman-test-runs")), m[1]);
  fs.rmSync(m[1], { force: true });
  try {
    fs.rmdirSync(path.dirname(m[1]));
  } catch {}
});

test("--detach returns at once with the log path; --wait collects it", () => {
  const lock = tmp();
  const out = tmp();
  const e = env(lock, out);
  const t0 = Date.now();
  const r = foreman(["--detach", "--", process.execPath, "-e", "setTimeout(()=>console.log('late done'),1500)"], e, tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 1400, "detach did not return at once");
  const m = /run (\S+) detached; log (\S+\.log); collect with: foreman test-run --wait (\S+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.ok(m[2].startsWith(path.join(out, "test-runs")));
  const w = foreman(["--wait", m[1], "--max", "30"], e, tmp());
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /late done/);
  assert.match(w.stdout, /run \S+ done, exit 0/);
});

test("--stop finds a detached generic run by id", () => {
  const lock = tmp();
  const out = tmp();
  const e = env(lock, out);
  const r = foreman(["--detach", "--", process.execPath, "-e", "setTimeout(()=>{},60000)"], e, tmp());
  const id = /run (\S+) detached/.exec(r.stdout)[1];
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(lock, "test-runs", `${id}.json`)) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const s = foreman(["--stop", id], e, tmp());
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /stopped/);
});

test("an inner runner under a live outer generic run does not wait on the lock", () => {
  const lock = tmp();
  const out = tmp();
  const repo = tmp();
  // the inner command is what `npm test` would do: call the runner again
  const inner = `const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(SCRIPT)},'--exec','--',process.execPath,'-e','console.log("inner ran")'],{stdio:'inherit'});process.exit(r.status)`;
  const r = foreman(["--", process.execPath, "-e", inner], env(lock, out, { FOREMAN_TEST_LOCK_WAIT_MINUTES: "1" }), repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inner ran/);
  assert.match(r.stderr, /running without the lock/);
  const hist = fs.readFileSync(path.join(lock, "test-history", "history.jsonl"), "utf8").trim().split("\n");
  assert.equal(hist.length, 1);
});
