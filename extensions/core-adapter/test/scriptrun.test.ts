// The runner of an owner-approved script: bytes in, a private run file, fixed argv and environment, nothing left behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { freshScriptLogPath, runScript, scriptArgv, scriptEnv, scriptLogPath, scriptLogTail, scriptShell, scriptTimeoutSeconds } from "../scriptrun.ts";
import type { ScriptRunResult } from "../scriptrun.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HASH = "0123456789abcdef".repeat(4);
const PROBE = 'echo "self:$0"\necho "args:$*"\necho "dry:${DRY_RUN:-unset}"\necho "ic:${PI_INTERCOM_SESSION_ID:-unset}${PI_FOREMAN_PARENT_INTERCOM:-unset}"\nexit 3\n';

function dirs(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(mkTestTmp("pf-scriptrun-"));
  t.after(() => rmTestTmp(root));
  const tmp = path.join(root, "tmp");
  const ws = path.join(root, "ws");
  for (const d of [tmp, ws]) fs.mkdirSync(d);
  return { root, tmp, ws, log: (n: string) => path.join(root, "logs", n) };
}

function ran(r: Awaited<ReturnType<typeof runScript>>): ScriptRunResult {
  assert.ok(!("code" in r), JSON.stringify(r));
  assert.equal(r.error, undefined);
  return r;
}

const ENV = { ...process.env, DRY_RUN: "9", PI_INTERCOM_SESSION_ID: "sid", PI_FOREMAN_PARENT_INTERCOM: "parent" };

test("script run: a dry run gets --dry-run and DRY_RUN=1; the exit code comes back", async (t) => {
  const d = dirs(t);
  const r = ran(await runScript({ bytes: Buffer.from(PROBE), kind: "dry", cwd: d.ws, logPath: d.log("dry.log"), env: ENV, tmpDir: d.tmp }));
  assert.equal(r.exitCode, 3);
  assert.equal(r.kind, "dry");
  assert.equal(r.timedOut, false);
  const log = fs.readFileSync(d.log("dry.log"), "utf8");
  assert.match(log, /^args:--dry-run$/m);
  assert.match(log, /^dry:1$/m);
  assert.match(r.tail, /args:--dry-run/);
});

test("script run: a real run gets neither --dry-run nor DRY_RUN, even when the given env has DRY_RUN", async (t) => {
  const d = dirs(t);
  const r = ran(await runScript({ bytes: Buffer.from(PROBE), kind: "run", cwd: d.ws, logPath: d.log("run.log"), env: ENV, tmpDir: d.tmp }));
  assert.equal(r.exitCode, 3);
  const log = fs.readFileSync(d.log("run.log"), "utf8");
  assert.match(log, /^args:$/m);
  assert.match(log, /^dry:unset$/m);
});

test("script run: the intercom identity is stripped from the environment", async (t) => {
  const d = dirs(t);
  ran(await runScript({ bytes: Buffer.from(PROBE), kind: "run", cwd: d.ws, logPath: d.log("ic.log"), env: ENV, tmpDir: d.tmp }));
  assert.match(fs.readFileSync(d.log("ic.log"), "utf8"), /^ic:unsetunset$/m);
  const env = scriptEnv({ PATH: "/bin", DRY_RUN: "9", PI_INTERCOM_STABLE_ID: "x", PI_FOREMAN_HANDOFF_DIR: "y", SECRET_TOKEN: "kept" }, "run", "linux");
  assert.deepEqual(env, { PATH: "/bin", SECRET_TOKEN: "kept" });
  assert.equal(scriptEnv({ PATH: "/bin" }, "dry", "linux").DRY_RUN, "1");
  assert.deepEqual(scriptEnv({ dry_run: "1" }, "run", "win32"), { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" });
});

test("script run: the caller-named path is never executed; the run file and its dir are removed", async (t) => {
  const d = dirs(t);
  const named = path.join(d.ws, "job.sh");
  fs.writeFileSync(named, 'echo approved-text\necho "self:$0"\necho "cwd:$(pwd)"\n');
  const bytes = fs.readFileSync(named);
  fs.writeFileSync(named, "echo changed-afterwards\n");
  const r = ran(await runScript({ bytes, kind: "run", cwd: d.ws, logPath: d.log("bytes.log"), tmpDir: d.tmp }));
  assert.equal(r.exitCode, 0);
  const log = fs.readFileSync(d.log("bytes.log"), "utf8");
  assert.match(log, /approved-text/);
  assert.doesNotMatch(log, /changed-afterwards/);
  const self = /^self:(.*)$/m.exec(log)![1].trim();
  assert.notEqual(path.resolve(self), named);
  assert.ok(!fs.existsSync(self), "the run file is gone");
  assert.deepEqual(fs.readdirSync(d.tmp), [], "the private dir is gone");
  assert.equal(fs.readFileSync(named, "utf8"), "echo changed-afterwards\n");
  if (process.platform !== "win32") {
    assert.equal(path.dirname(path.dirname(self)), d.tmp);
    assert.equal(fs.realpathSync(/^cwd:(.*)$/m.exec(log)![1].trim()), d.ws);
  }
});

test("script run: the time limit kills the run; file and dir are removed", async (t) => {
  const d = dirs(t);
  const started = Date.now();
  const r = ran(await runScript({ bytes: Buffer.from("echo started\nsleep 30\necho never\n"), kind: "run", cwd: d.ws, logPath: d.log("limit.log"), timeoutSeconds: 0.5, tmpDir: d.tmp }));
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
  assert.ok(Date.now() - started < 20_000);
  assert.match(r.tail, /started/);
  assert.doesNotMatch(r.tail, /never/);
  assert.deepEqual(fs.readdirSync(d.tmp), []);
});

test("script run: an abort kills the run", async (t) => {
  const d = dirs(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const r = ran(await runScript({ bytes: Buffer.from("sleep 30\n"), kind: "dry", cwd: d.ws, logPath: d.log("abort.log"), signal: ac.signal, tmpDir: d.tmp }));
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.notEqual(r.exitCode, 0);
  assert.deepEqual(fs.readdirSync(d.tmp), []);
});

test("script run: a background child is gone after a normal exit", { skip: process.platform === "win32" }, async (t) => {
  const d = dirs(t);
  const r = ran(await runScript({ bytes: Buffer.from("sleep 60 >/dev/null 2>&1 &\necho \"bg:$!\"\nexit 0\n"), kind: "run", cwd: d.ws, logPath: d.log("bg.log"), tmpDir: d.tmp }));
  assert.equal(r.exitCode, 0);
  const pid = Number(/^bg:(\d+)$/m.exec(fs.readFileSync(d.log("bg.log"), "utf8"))![1]);
  assert.ok(pid > 1);
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(pid, 0);
      await sleep(100);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test("script run: Windows without Git Bash refuses with no_posix_shell and writes nothing", async (t) => {
  const d = dirs(t);
  const none = () => {
    throw new Error("no bash");
  };
  const r = await runScript({ bytes: Buffer.from("echo hi\n"), kind: "dry", cwd: d.ws, logPath: d.log("win.log"), platform: "win32", getShellConfig: none, tmpDir: d.tmp });
  assert.ok("code" in r);
  assert.equal(r.code, "no_posix_shell");
  assert.deepEqual(fs.readdirSync(d.tmp), []);
  assert.ok(!fs.existsSync(d.log("win.log")));
  assert.equal(scriptShell("win32", { getShellConfig: none }), null);
  assert.equal(scriptShell("win32", { getShellConfig: () => ({ shell: "C:\\Windows\\System32\\bash.exe", args: [], commandTransport: "stdin" }) }), null);
  assert.equal(scriptShell("win32", { getShellConfig: () => ({ shell: "C:\\Windows\\System32\\cmd.exe", args: ["/c"] }) }), null);
  assert.equal(scriptShell("win32", { getShellConfig: () => ({ shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] }) }), "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(scriptShell("linux"), "/bin/sh");
  assert.equal(scriptShell("darwin"), "/bin/sh");
});

test("script run: Pi's shellPath setting reaches the shell resolution on Windows; without it and without Git Bash the run refuses", async (t) => {
  const d = dirs(t);
  const asked: Array<string | undefined> = [];
  const only = (shellPath?: string) => {
    asked.push(shellPath);
    if (!shellPath) throw new Error("no bash");
    return { shell: shellPath, args: ["-c"] };
  };
  const given = "C:\\pf-no-such-dir\\bash.exe";
  assert.equal(scriptShell("win32", { getShellConfig: only, shellPath: given }), given);
  // the given shell is the one the runner starts (it does not exist here, so the start fails with its name)
  const r = await runScript({ bytes: Buffer.from("echo hi\n"), kind: "dry", cwd: d.ws, logPath: d.log("given.log"), platform: "win32", getShellConfig: only, shellPath: given, tmpDir: d.tmp });
  assert.ok(!("code" in r), JSON.stringify(r));
  assert.ok(r.error?.startsWith(`could not start ${given}:`), r.error);
  assert.deepEqual(fs.readdirSync(d.tmp), []);
  const none = await runScript({ bytes: Buffer.from("echo hi\n"), kind: "dry", cwd: d.ws, logPath: d.log("none.log"), platform: "win32", getShellConfig: only, tmpDir: d.tmp });
  assert.ok("code" in none);
  assert.equal(none.code, "no_posix_shell");
  assert.match(none.error, /set Pi's shellPath/);
  assert.deepEqual(asked, [given, given, undefined]);
});

test("script run: an already aborted signal spawns nothing and leaves no run file, dir or log", async (t) => {
  const d = dirs(t);
  const mark = path.join(d.root, "ran.txt");
  const ac = new AbortController();
  ac.abort();
  const r = ran(await runScript({ bytes: Buffer.from(`echo ran > '${mark}'\n`), kind: "run", cwd: d.ws, logPath: d.log("pre.log"), signal: ac.signal, tmpDir: d.tmp }));
  assert.equal(r.aborted, true);
  assert.equal(r.exitCode, null);
  assert.equal(r.tail, "");
  assert.ok(!fs.existsSync(mark), "the script did not run");
  assert.deepEqual(fs.readdirSync(d.tmp), []);
  assert.ok(!fs.existsSync(path.dirname(d.log("pre.log"))), "no log and no log dir");
});

test("script run: the argv is the run file, plus --dry-run on a dry run only", () => {
  assert.deepEqual(scriptArgv("/t/run.sh", "dry"), ["/t/run.sh", "--dry-run"]);
  assert.deepEqual(scriptArgv("/t/run.sh", "run"), ["/t/run.sh"]);
});

test("script run: the time limit defaults to 600 s and is capped at 3600 s", () => {
  assert.equal(scriptTimeoutSeconds(undefined), 600);
  assert.equal(scriptTimeoutSeconds(-1), 600);
  assert.equal(scriptTimeoutSeconds("5"), 600);
  assert.equal(scriptTimeoutSeconds(30), 30);
  assert.equal(scriptTimeoutSeconds(99_999), 3600);
});

test("script run: the log path is script-<name>-<hash8>-<dry|run>-<n>.log; a fresh one never names an existing file", (t) => {
  const d = dirs(t);
  assert.equal(scriptLogPath(d.root, "job.sh", HASH, "dry", 1), path.join(d.root, "script-job.sh-01234567-dry-1.log"));
  assert.equal(path.basename(scriptLogPath(d.root, "a b/c.sh", HASH, "run", 7)), "script-a_b_c.sh-01234567-run-7.log");
  assert.equal(freshScriptLogPath(d.root, "job.sh", HASH, "dry"), scriptLogPath(d.root, "job.sh", HASH, "dry", 1));
  fs.writeFileSync(scriptLogPath(d.root, "job.sh", HASH, "dry", 1), "");
  fs.writeFileSync(scriptLogPath(d.root, "job.sh", HASH, "dry", 2), "");
  assert.equal(freshScriptLogPath(d.root, "job.sh", HASH, "dry"), scriptLogPath(d.root, "job.sh", HASH, "dry", 3));
});

test("script run: an existing log is never overwritten", async (t) => {
  const d = dirs(t);
  fs.mkdirSync(path.dirname(d.log("x")), { recursive: true });
  fs.writeFileSync(d.log("old.log"), "earlier run\n");
  const r = await runScript({ bytes: Buffer.from("echo hi\n"), kind: "run", cwd: d.ws, logPath: d.log("old.log"), tmpDir: d.tmp });
  assert.ok(!("code" in r) && r.error);
  assert.equal(r.exitCode, null);
  assert.equal(fs.readFileSync(d.log("old.log"), "utf8"), "earlier run\n");
  assert.deepEqual(fs.readdirSync(d.tmp), []);
});

test("script run: the tail is the last 40 lines, at most 4 KiB, with secrets redacted; the log stays as written", (t) => {
  const d = dirs(t);
  const log = path.join(d.root, "tail.log");
  fs.writeFileSync(log, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\ntoken=hunter2secret\n");
  const tail = scriptLogTail(log).split("\n");
  assert.equal(tail.length, 40);
  assert.equal(tail[0], "line 61");
  assert.equal(tail[39], "token=[redacted]");
  assert.match(fs.readFileSync(log, "utf8"), /hunter2secret/);
  fs.writeFileSync(log, Array.from({ length: 30 }, (_, i) => `${i} ${"y z ".repeat(100)}`).join("\n") + "\n");
  const big = scriptLogTail(log);
  assert.ok(Buffer.byteLength(big) <= 4096);
  assert.match(big, /^\d+ y z /);
  assert.equal(scriptLogTail(path.join(d.root, "none.log")), "");
});
