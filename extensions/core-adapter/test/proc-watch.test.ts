// The process watch of the spawn guard: _proc-watch.cjs (title record, parent watch), the leftover and FOREMAN_TEST_FILE parts of
// _spawn-count.mjs, and the NODE_OPTIONS and env the wrapper builds for a node-mode run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeOptionsWithWatch, nodeRunEnv, readSpawnCounts, titledFiles } from "../../../scripts/foreman_test_run.mjs";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(HERE, "_proc-watch.cjs");
const COUNTER = pathToFileURL(path.join(HERE, "_spawn-count.mjs")).href;
const WRAPPER = path.join(HERE, "..", "..", "..", "scripts", "foreman_test_run.mjs");

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ["FOREMAN_SPAWN_GUARD_EXEMPT", "FOREMAN_SPAWN_COUNT_DIR", "FOREMAN_TEST_FILE", "FOREMAN_TEST_WRAPPER_PID", "NODE_TEST_CONTEXT", "NODE_OPTIONS", "CI"]) if (!(k in extra)) delete env[k];
  return env;
}

/** Runs `node -e code` with the watch preload in NODE_OPTIONS and the count dir set; returns the parsed records. */
function runWatched(code: string, extra: NodeJS.ProcessEnv = {}): Array<Record<string, unknown>> {
  const dir = mkTestTmp("pf-proc-watch-");
  try {
    const env = cleanEnv({ FOREMAN_SPAWN_COUNT_DIR: dir, NODE_OPTIONS: nodeOptionsWithWatch(undefined, WATCH), ...extra });
    const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readSpawnCounts(dir);
  } finally {
    rmTestTmp(dir);
  }
}

test("the watch writes a titled record when process.title changed, and none without a change", () => {
  const titled = runWatched(`process.title = "x";`);
  assert.equal(titled.length, 1);
  assert.equal(titled[0].titled, true);
  assert.deepEqual(runWatched(`0;`), []);
});

test("the titled record names FOREMAN_TEST_FILE when set, else the script basename, and 'test runner' under --test", () => {
  assert.equal(runWatched(`process.title = "x";`, { FOREMAN_TEST_FILE: "some/a.test.ts" })[0].file, "some/a.test.ts");
  const dir = mkTestTmp("pf-proc-watch-script-");
  try {
    fs.writeFileSync(path.join(dir, "titled-probe.cjs"), `process.title = "x";\n`);
    const env = cleanEnv({ FOREMAN_SPAWN_COUNT_DIR: dir, NODE_OPTIONS: nodeOptionsWithWatch(undefined, WATCH) });
    const r = spawnSync(process.execPath, [path.join(dir, "titled-probe.cjs")], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(titledFiles(readSpawnCounts(dir)), ["titled-probe.cjs"]);

    // The runner: `node --test` with a file that changes nothing; the runner itself changes no title, so run the runner with a title-setting preload.
    fs.writeFileSync(path.join(dir, "ok.test.cjs"), `require("node:test").test("ok", () => {});\n`);
    fs.writeFileSync(path.join(dir, "set-title.cjs"), `if (process.execArgv.includes("--test")) process.title = "runner-title";\n`);
    const runner = spawnSync(process.execPath, ["--require", path.join(dir, "set-title.cjs"), "--test", path.join(dir, "ok.test.cjs")], { env, encoding: "utf8" });
    assert.equal(runner.status, 0, runner.stderr);
    assert.ok(titledFiles(readSpawnCounts(dir)).includes("test runner"), JSON.stringify(readSpawnCounts(dir)));
  } finally {
    rmTestTmp(dir);
  }
});

test("without FOREMAN_SPAWN_COUNT_DIR the watch is inactive", () => {
  const dir = mkTestTmp("pf-proc-watch-off-");
  try {
    const env = cleanEnv({ NODE_OPTIONS: nodeOptionsWithWatch(undefined, WATCH) });
    const r = spawnSync(process.execPath, ["-e", `process.title = "x";`], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    rmTestTmp(dir);
  }
});

function countedRun(code: string): Array<Record<string, unknown>> {
  const dir = mkTestTmp("pf-spawn-left-");
  try {
    const script = path.join(dir, "stand-in.mjs");
    fs.writeFileSync(script, code);
    const env = cleanEnv({ FOREMAN_SPAWN_COUNT_DIR: dir });
    const r = spawnSync(process.execPath, ["--import", COUNTER, script], { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readSpawnCounts(dir);
  } finally {
    rmTestTmp(dir);
  }
}

test("the counter preload sets FOREMAN_TEST_FILE to the script label, so a descendant is named by it", () => {
  const records = countedRun(`import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, ["-p", "process.env.FOREMAN_TEST_FILE"], { encoding: "utf8" });\nif (process.env.FOREMAN_TEST_FILE !== "stand-in.mjs" || r.stdout.trim() !== "stand-in.mjs") process.exit(3);\n`);
  assert.equal(records.length, 1);
  assert.equal(records[0].file, "stand-in.mjs");
});

test("a child that started a long-lived child and exited lists one leftover; a child whose own child ended lists none", () => {
  const long = countedRun(`import { spawn } from "node:child_process";\nconst c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", detached: true });\nc.unref();\nprocess.on("exit", () => {\n  try { process.kill(c.pid, "SIGKILL"); } catch {}\n});\n`);
  // the kill above runs after the counter's exit handler (registered first), so the child is still alive when it checks
  assert.deepEqual(long[0].leftovers, ["node"]);
  const ended = countedRun(`import { spawn } from "node:child_process";\nconst c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });\nawait new Promise((r) => c.on("exit", r));\n`);
  assert.equal(ended[0].leftovers, undefined);
  assert.equal(ended[0].node, 1);
});

test("nodeOptionsWithWatch keeps an existing value and appends --require; an existing identical entry is not doubled", () => {
  const one = nodeOptionsWithWatch("--no-warnings", WATCH);
  assert.equal(one, `--no-warnings --require=${JSON.stringify(path.resolve(WATCH))}`);
  assert.equal(nodeOptionsWithWatch(one, WATCH), one);
  assert.equal(nodeOptionsWithWatch(undefined, WATCH), `--require=${JSON.stringify(path.resolve(WATCH))}`);
});

test("nodeOptionsWithWatch round-trips a preload path with a backslash and a space", { skip: process.platform === "win32" }, () => {
  const dir = mkTestTmp("pf-proc-watch-path-");
  try {
    const odd = path.join(dir, "a b\\c");
    fs.mkdirSync(odd);
    const preload = path.join(odd, "probe.cjs");
    const marker = path.join(dir, "marker");
    fs.writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`);
    const env = cleanEnv({ NODE_OPTIONS: nodeOptionsWithWatch(undefined, preload) });
    const r = spawnSync(process.execPath, ["-e", "0"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "loaded");
  } finally {
    rmTestTmp(dir);
  }
});

test("nodeRunEnv sets the count dir, the wrapper pid and the preload; --exec mode adds neither", () => {
  const e = nodeRunEnv({ NODE_OPTIONS: "--no-warnings", PATH: "/bin" }, "/tmp/x", 4242);
  assert.equal(e.FOREMAN_SPAWN_COUNT_DIR, "/tmp/x");
  assert.equal(e.FOREMAN_TEST_WRAPPER_PID, "4242");
  assert.match(e.NODE_OPTIONS, /^--no-warnings --require=".*_proc-watch\.cjs"$/);

  const dir = mkTestTmp("pf-proc-watch-exec-");
  try {
    const code = `console.log(JSON.stringify({ o: process.env.NODE_OPTIONS ?? null, p: process.env.FOREMAN_TEST_WRAPPER_PID ?? null, d: process.env.FOREMAN_SPAWN_COUNT_DIR ?? null }))`;
    const r = spawnSync(process.execPath, [WRAPPER, "--exec", "--", process.execPath, "-e", code], { env: cleanEnv({ FOREMAN_TEST_LOCK: "0" }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { o: null, p: null, d: null });
  } finally {
    rmTestTmp(dir);
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("parent watch: after the wrapper is SIGKILLed, the runner and the file processes stop and at most two files start", { skip: process.platform === "win32" }, async () => {
  const dir = mkTestTmp("pf-parent-watch-");
  const pids = new Set<number>();
  try {
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const fixtures = [1, 2, 3].map((n) => {
      const f = path.join(dir, `sleep${n}.test.cjs`);
      fs.writeFileSync(f, `require("node:fs").writeFileSync(require("node:path").join(process.env.PF_OUT, "${n}.json"), JSON.stringify({ pid: process.pid, runner: process.ppid }));\nsetTimeout(() => {}, 60000);\n`);
      return f;
    });
    const env = cleanEnv({ FOREMAN_TEST_LOCK: "0", FOREMAN_TEST_CONCURRENCY: "1", PF_OUT: out });
    const wrapper = spawn(process.execPath, [WRAPPER, ...fixtures], { env, stdio: "ignore" });
    const started = () => fs.readdirSync(out).filter((n) => n.endsWith(".json"));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (started().length === 0 && Date.now() - t0 < 20000) await sleep(50);
    assert.ok(started().length >= 1, "no fixture started");
    wrapper.kill("SIGKILL");
    const read = () => {
      for (const n of started()) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(out, n), "utf8"));
          pids.add(r.pid);
          pids.add(r.runner);
        } catch {}
      }
    };
    read();
    const t1 = Date.now();
    while (Date.now() - t1 < 20000) {
      read();
      if ([...pids].every((p) => !alive(p))) break;
      await sleep(200);
    }
    read();
    const survivors = [...pids].filter(alive);
    assert.deepEqual(survivors, [], "processes still running after the wrapper was killed");
    assert.ok(started().length <= 2, `${started().length} files started`);
  } finally {
    for (const p of pids) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
    rmTestTmp(dir);
  }
});
