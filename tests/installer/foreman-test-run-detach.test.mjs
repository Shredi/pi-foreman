// scripts/foreman_test_run.mjs: the run history, detached runs and --wait.
import "./_sandbox-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { appendHistory, historyLines } = await import(pathToFileURL(SCRIPT).href);

const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-detach-")));
  dirs.push(d);
  return d;
}

/** Stops every run that still has a record in `dir` (by its recorded pid) and removes `dir`. */
function cleanup(dir) {
  const runs = path.join(dir, "test-runs");
  try {
    for (const n of fs.readdirSync(runs)) {
      if (!n.endsWith(".json") || n.endsWith(".done.json")) continue;
      try {
        process.kill(JSON.parse(fs.readFileSync(path.join(runs, n), "utf8")).pid);
      } catch {}
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

function env(dir, extra = {}) {
  const e = { ...process.env, FOREMAN_TEST_LOCK_DIR: dir, ...extra };
  for (const k of ["CI", "NODE_TEST_CONTEXT", "FOREMAN_TEST_LOCK", "FOREMAN_TEST_TIMEOUT", "FOREMAN_TEST_DETACH", "FOREMAN_TEST_RUN_ID", "FOREMAN_TEST_DETACHED"]) if (!(k in extra)) delete e[k];
  return e;
}

const wrapper = (dir, args, extra = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { env: env(dir, extra), encoding: "utf8" });
const exec = (dir, code, extra = {}, pre = []) => wrapper(dir, [...pre, "--exec", "--", process.execPath, "-e", code], extra);
const runsDir = (dir) => path.join(dir, "test-runs");
const histDir = (dir) => path.join(dir, "test-history");
const history = (dir) => fs.readFileSync(path.join(histDir(dir), "history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const holdLock = (dir) => fs.writeFileSync(path.join(dir, "test-lock"), JSON.stringify({ id: "held", pid: process.pid, started: new Date().toISOString(), cwd: process.cwd(), command: "held" }));
const idOf = (out) => /run ([a-z0-9-]+)/.exec(out)[1];

test("history: a line per run with the exit code, kind, mode and times", () => {
  const dir = tmp();
  try {
    assert.equal(exec(dir, "process.exit(0)").status, 0);
    assert.equal(exec(dir, "process.exit(1)").status, 1);
    const ok = path.join(dir, "ok.test.mjs");
    fs.writeFileSync(ok, 'import { test } from "node:test";\ntest("x", () => {});\n');
    assert.equal(wrapper(dir, [ok]).status, 0);
    const [a, b, c] = history(dir);
    assert.equal(a.exit, 0);
    assert.equal(b.exit, 1);
    assert.deepEqual([a.kind, a.mode, a.detached], ["exec", "suite", false]);
    assert.match(a.tree, /^[0-9a-f]{40}$/, "the repository checkout gives a tree key");
    assert.deepEqual([c.kind, c.mode, c.exit], ["node", "suite", 0]);
    for (const e of [a, b, c]) {
      assert.ok(e.id && e.cwd && e.command);
      assert.ok(Date.parse(e.enqueued) <= Date.parse(e.acquired) && Date.parse(e.acquired) <= Date.parse(e.ended));
    }
  } finally {
    cleanup(dir);
  }
});

test("history: give-up 75, time limit 124 while queued (acquired null) and 124 while running, stop 130", async () => {
  const dir = tmp();
  try {
    holdLock(dir);
    assert.equal(exec(dir, "0", { FOREMAN_TEST_LOCK_WAIT_MINUTES: "0.02" }).status, 75);
    assert.equal(exec(dir, "0", {}, ["--timeout", "1"]).status, 124);
    const queued = spawn(process.execPath, [SCRIPT, "--exec", "--", process.execPath, "-e", "0"], { env: env(dir), stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    queued.stderr.on("data", (d) => (err += d));
    const closed = new Promise((r) => queued.on("close", r));
    while (!/stop it with/.test(err)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(wrapper(dir, ["--stop", idOf(err)]).status, 0);
    assert.equal(await closed, 130);
    fs.rmSync(path.join(dir, "test-lock"));
    assert.equal(exec(dir, "setTimeout(() => {}, 30000)", {}, ["--timeout", "1"]).status, 124);
    const [r75, q124, r130, run124] = history(dir);
    assert.deepEqual([r75.exit, r75.acquired], [75, null]);
    assert.deepEqual([q124.exit, q124.acquired], [124, null]);
    assert.equal(r130.exit, 130);
    assert.equal(r130.acquired, null);
    assert.equal(run124.exit, 124);
    assert.ok(run124.acquired);
    const out = historyLines(history(dir)).join("\n");
    assert.match(out, /exit 75 1; exit 124 queued 1, running 1; exit 130 1/);
  } finally {
    cleanup(dir);
  }
});

test("history: --history prints the figures of a seeded file and --days filters", () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const at = (ms) => new Date(now - ms).toISOString();
    const entry = (waitS, runS, exit, agoMs, extra = {}) => ({ id: "x", mode: "suite", kind: "exec", enqueued: at(agoMs + (waitS + runS) * 1000), acquired: at(agoMs + runS * 1000), ended: at(agoMs), exit, ...extra });
    fs.mkdirSync(histDir(dir), { recursive: true });
    const lines = [entry(0, 10, 0, 1000), entry(60, 20, 0, 2000), entry(120, 30, 1, 3000), entry(0, 0, 75, 4000, { acquired: null, enqueued: at(4000 + 90_000) }), entry(0, 0, 124, 5000, { acquired: null, enqueued: at(5000 + 5_000) }), entry(0, 40, 124, 6000), entry(0, 5, 0, 10 * 86_400_000)];
    fs.writeFileSync(path.join(histDir(dir), "history.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    const r = wrapper(dir, ["--history", "--days", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^suite exec: runs 6; waited 3 \(wait median 90\.0 s, p90 120\.0 s, max 120\.0 s\); exit 75 1; exit 124 queued 1, running 1; exit 130 0; run median 20\.0 s, p90 40\.0 s$/m);
    assert.match(wrapper(dir, ["--history", "--days", "30"]).stdout, /runs 7;/);
    assert.equal(wrapper(dir, ["--history", "--days", "x"]).status, 2);
  } finally {
    cleanup(dir);
  }
});

test("history: rotation renames to unique archives and keeps the newest two", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 6; i++) appendHistory(dir, { n: i, pad: "x".repeat(50) }, { maxBytes: 10, keep: 2 });
    const names = fs.readdirSync(dir);
    assert.equal(names.filter((n) => /^history-.*\.jsonl$/.test(n)).length, 2, names.join());
    assert.equal(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
    const kept = names.filter((n) => /^history-/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")).n);
    assert.equal(new Set(kept).size, 2);
    assert.ok(kept.every((n) => n >= 3), `newest archives kept: ${kept}`);
  } finally {
    cleanup(dir);
  }
});

test("history: an unwritable history leaves the exit code unchanged", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "test-history"), "a file where the history directory should be");
    assert.equal(exec(dir, "process.exit(0)").status, 0);
    assert.equal(exec(dir, "process.exit(3)").status, 3);
  } finally {
    cleanup(dir);
  }
});

test("detach: returns at once, runs in the background with one id, a log and a done file; the run id stays out of the command's env", async () => {
  const dir = tmp();
  try {
    const t0 = Date.now();
    const r = exec(dir, `setTimeout(() => { console.log("RUNID=" + process.env.FOREMAN_TEST_RUN_ID + " DETACHED=" + process.env.FOREMAN_TEST_DETACHED + " DETACH=" + process.env.FOREMAN_TEST_DETACH); process.exit(7); }, 1500)`, { FOREMAN_TEST_DETACH: "1", FOREMAN_TEST_TIMEOUT: "0.2" });
    assert.ok(Date.now() - t0 < 1400, "returned before the run ended");
    assert.equal(r.status, 0, r.stderr);
    const id = /run ([a-z0-9-]+) detached; log (.+?); collect with: node scripts\/foreman_test_run\.mjs --wait \1/.exec(r.stdout);
    assert.ok(id, r.stdout);
    assert.equal(id[2], path.join(histDir(dir), `${id[1]}.log`));
    const w = wrapper(dir, ["--wait", id[1], "--max", "30"]);
    assert.equal(w.status, 7, w.stdout + w.stderr);
    assert.match(w.stdout, new RegExp(`foreman_test_run: run ${id[1]} done, exit 7, waited [\\d.]+ min, ran \\d+ s\\n$`));
    assert.match(w.stdout, /RUNID=undefined DETACHED=undefined DETACH=undefined/);
    const done = JSON.parse(fs.readFileSync(path.join(histDir(dir), `${id[1]}.done.json`), "utf8"));
    assert.equal(done.exit, 7);
    const [h] = history(dir);
    assert.deepEqual([h.id, h.detached, h.exit], [id[1], true, 7]);
    const recordFile = path.join(runsDir(dir), `${id[1]}.json`);
    const deadline = Date.now() + 10_000;
    while (fs.existsSync(recordFile) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    assert.ok(!fs.existsSync(recordFile), "record removed");
  } finally {
    cleanup(dir);
  }
});

test("detach: a done file implies its history line is already written", async () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 3; i++) {
      const r = exec(dir, "process.exit(4)", { FOREMAN_TEST_DETACH: "1" });
      assert.equal(r.status, 0, r.stderr);
      const id = idOf(r.stdout);
      const doneFile = path.join(histDir(dir), `${id}.done.json`);
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(doneFile) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 10));
      assert.ok(fs.existsSync(doneFile), "done file appeared");
      const h = history(dir).find((e) => e.id === id);
      assert.ok(h, `history line for ${id} present when the done file exists`);
      assert.equal(h.exit, 4);
    }
  } finally {
    cleanup(dir);
  }
});

test("detach: a leading --detach flag works; each start sweeps old done files and logs only", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(histDir(dir), { recursive: true });
    const old = new Date(Date.now() - 8 * 86_400_000);
    for (const n of ["old.done.json", "old.log", "fresh.done.json", "keep.stop"]) fs.writeFileSync(path.join(histDir(dir), n), "{}");
    for (const n of ["old.done.json", "old.log", "keep.stop"]) fs.utimesSync(path.join(histDir(dir), n), old, old);
    const r = exec(dir, "0", {}, ["--detach"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /detached/);
    const names = fs.readdirSync(histDir(dir));
    assert.ok(!names.includes("old.done.json") && !names.includes("old.log"), names.join());
    assert.ok(names.includes("fresh.done.json") && names.includes("keep.stop"), names.join());
  } finally {
    cleanup(dir);
  }
});

test("wait: queued with its position while a held lock blocks the run, then the run's exit after the release", () => {
  const dir = tmp();
  try {
    holdLock(dir);
    const r = exec(dir, "process.exit(5)", { FOREMAN_TEST_DETACH: "1" });
    const id = idOf(r.stdout);
    const w = wrapper(dir, ["--wait", id, "--max", "2"]);
    assert.equal(w.status, 3, w.stdout + w.stderr);
    assert.match(w.stdout, new RegExp(`run ${id} queued, position 1 of 1, lock held by run held`));
    fs.rmSync(path.join(dir, "test-lock"));
    const w2 = wrapper(dir, ["--wait", id, "--max", "30"]);
    assert.equal(w2.status, 5, w2.stdout + w2.stderr);
    assert.match(w2.stdout, /done, exit 5/);
  } finally {
    cleanup(dir);
  }
});

test("wait: starting, died, unknown run and bad arguments", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(histDir(dir), { recursive: true });
    fs.mkdirSync(runsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(histDir(dir), "young-1.log"), "booting\n");
    const s = wrapper(dir, ["--wait", "young-1", "--max", "1"]);
    assert.equal(s.status, 3);
    assert.match(s.stdout, /run young-1 starting/);
    const logFile = path.join(histDir(dir), "gone-1.log");
    fs.writeFileSync(logFile, "line one\nline two\n");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(logFile, old, old);
    const g = wrapper(dir, ["--wait", "gone-1", "--max", "1"]);
    assert.equal(g.status, 1);
    assert.match(g.stdout, /line two\n.*run gone-1 died/);
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    assert.ok(dead.pid);
    fs.writeFileSync(path.join(runsDir(dir), "dead-1.json"), JSON.stringify({ id: "dead-1", pid: dead.pid, cwd: dir, command: "x", started: new Date().toISOString(), mode: "suite", state: "running" }));
    const d = wrapper(dir, ["--wait", "dead-1", "--max", "1"]);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /run dead-1 died/);
    const u = wrapper(dir, ["--wait", "nosuch-1", "--max", "1"]);
    assert.equal(u.status, 2);
    assert.match(u.stdout, /run nosuch-1 unknown run/);
    assert.equal(wrapper(dir, ["--wait", "Bad/Id"]).status, 2);
    assert.equal(wrapper(dir, ["--wait", "young-1", "--max", "abc"]).status, 2);
  } finally {
    cleanup(dir);
  }
});

test("a done file is not taken for a run record by --list", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(runsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(runsDir(dir), "fin-1.done.json"), JSON.stringify({ id: "fin-1", pid: 999999, exit: 0 }));
    const r = wrapper(dir, ["--list"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /fin-1/);
    assert.ok(fs.existsSync(path.join(runsDir(dir), "fin-1.done.json")));
  } finally {
    cleanup(dir);
  }
});
