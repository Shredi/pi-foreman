// scripts/foreman_test_run.mjs: reuse of a recorded passing full-suite run.
import "./_sandbox-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_test_run.mjs");
const { treeKey } = await import(pathToFileURL(SCRIPT).href);

const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-reuse-")));
  dirs.push(d);
  return d;
}

// one small git checkout is the cwd of every wrapper run, so the tree key is stable and does not depend on this worktree
const repo = tmp();
const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
git("init", "-q");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git("add", "a.txt");
git("commit", "-q", "-m", "init");
const TREE = treeKey(repo);
assert.match(TREE, /^[0-9a-f]{40}$/);

const histDir = (dir) => path.join(dir, "test-history");
const history = (dir) => fs.readFileSync(path.join(histDir(dir), "history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function env(dir, extra) {
  const e = { ...process.env, FOREMAN_TEST_LOCK_DIR: dir, FOREMAN_TEST_REUSE: "1", ...extra };
  for (const k of ["CI", "NODE_TEST_CONTEXT", "FOREMAN_TEST_LOCK", "FOREMAN_TEST_TIMEOUT", "FOREMAN_TEST_DETACH", "FOREMAN_TEST_RUN_ID", "FOREMAN_TEST_DETACHED"]) if (!(k in (extra ?? {}))) delete e[k];
  for (const [k, v] of Object.entries(extra ?? {})) if (v === null) delete e[k];
  return e;
}
const wrap = (dir, args, extra, cwd = repo) => spawnSync(process.execPath, [SCRIPT, ...args], { env: env(dir, extra), encoding: "utf8", cwd });
const CODE = 'console.log("ran")';
const execArgs = (code) => ["--exec", "--", process.execPath, "-e", code];
const hashOf = (code) => createHash("sha256").update(JSON.stringify([process.execPath, "-e", code])).digest("hex");
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** A recorded passing run `src1` of CODE in the repo; `extra` overrides fields. */
const source = (code = CODE, extra = {}) => ({ id: "src1", mode: "suite", kind: "exec", detached: false, command: "x", commandHash: hashOf(code), cwd: repo, treeStart: TREE, tree: TREE, enqueued: ago(5000), acquired: ago(4000), ended: ago(3000), exit: 0, ...extra });
function seed(dir, lines, file = "history.jsonl") {
  fs.mkdirSync(histDir(dir), { recursive: true });
  fs.writeFileSync(path.join(histDir(dir), file), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
const ranOnly = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ran$/m);
  assert.doesNotMatch(r.stdout, /reused run/);
};
const reused = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /foreman_test_run: reused run src1 \(passed, same code, ended \d{4}-/);
  assert.doesNotMatch(r.stdout, /^ran$/m);
};

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("reuse: a second foreground run of the same code is answered by the first", () => {
  const dir = tmp();
  ranOnly(wrap(dir, execArgs(CODE)));
  const first = history(dir)[0];
  assert.equal(first.treeStart, TREE);
  assert.equal(first.commandHash, hashOf(CODE));
  const r = wrap(dir, execArgs(CODE));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`reused run ${first.id} \\(passed, same code, ended `));
  assert.doesNotMatch(r.stdout, /^ran$/m);
});

test("reuse: a run answered from an earlier one writes a history line with reusedFrom", () => {
  const dir = tmp();
  seed(dir, [source()]);
  reused(wrap(dir, execArgs(CODE)));
  const lines = history(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].reusedFrom, "src1");
  assert.equal(lines[1].exit, 0);
  assert.equal(lines[1].commandHash, hashOf(CODE));
  assert.notEqual(lines[1].id, "src1");
});

test("reuse: the log path of the source is printed when the log exists", () => {
  const dir = tmp();
  seed(dir, [source()]);
  fs.writeFileSync(path.join(histDir(dir), "src1.log"), "log\n");
  const r = wrap(dir, execArgs(CODE));
  reused(r);
  assert.match(r.stdout, /foreman_test_run: log .*src1\.log/);
});

test("reuse: a source found only in an archive file is used", () => {
  const dir = tmp();
  seed(dir, [source()], "history-abc-1.jsonl");
  reused(wrap(dir, execArgs(CODE)));
});

test("reuse: a detached start is answered by a recorded run with a done file and --wait reports it", () => {
  const dir = tmp();
  seed(dir, [source()]);
  fs.writeFileSync(path.join(histDir(dir), "src1.done.json"), JSON.stringify({ id: "src1", exit: 0, ended: ago(3000), waitedMs: 0, ranMs: 1000 }));
  const r = wrap(dir, execArgs(CODE), { FOREMAN_TEST_DETACH: "1" });
  reused(r);
  assert.match(r.stdout, /--wait src1/);
  const w = wrap(dir, ["--wait", "src1"]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /run src1 done, exit 0/);
});

test("reuse miss: a detached source whose done file is missing runs normally", () => {
  const dir = tmp();
  seed(dir, [source()]);
  const r = wrap(dir, execArgs(CODE), { FOREMAN_TEST_DETACH: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /reused run/);
  const id = /run ([a-z0-9-]+) detached/.exec(r.stdout)[1];
  assert.notEqual(id, "src1");
  const w = wrap(dir, ["--wait", id, "--max", "60"]);
  assert.match(w.stdout, /run [a-z0-9-]+ done, exit 0/);
});

test("reuse miss: no record", () => {
  ranOnly(wrap(tmp(), execArgs(CODE)));
});

test("reuse miss: the source failed", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { exit: 1 })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: the source has another tree", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { tree: "0".repeat(40), treeStart: "0".repeat(40) })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: the source has an empty tree", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { tree: "", treeStart: "" })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: treeStart differs from tree (the code changed during the source run)", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { treeStart: "1".repeat(40) })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: a source line without treeStart", () => {
  const dir = tmp();
  const { treeStart, ...old } = source();
  seed(dir, [old]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: a source older than the window", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { ended: ago(25 * 3600_000) })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse: FOREMAN_TEST_REUSE_HOURS widens the window", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { ended: ago(25 * 3600_000) })]);
  reused(wrap(dir, execArgs(CODE), { FOREMAN_TEST_REUSE_HOURS: "48" }));
});

test("reuse miss: another cwd", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { cwd: tmp() })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: another command", () => {
  const dir = tmp();
  seed(dir, [source('console.log("other")')]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: another kind", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { kind: "node" })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: a reusedFrom line is never a source", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { reusedFrom: "older" })]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: a line without commandHash is never a source", () => {
  const dir = tmp();
  const { commandHash, ...old } = source();
  seed(dir, [old]);
  ranOnly(wrap(dir, execArgs(CODE)));
});

test("reuse miss: two commands that share their first 119 characters do not reuse each other", () => {
  const dir = tmp();
  const pad = `/*${"x".repeat(150)}*/`;
  const a = `console.log("ran");${pad}1`;
  const b = `console.log("ran");${pad}2`;
  ranOnly(wrap(dir, execArgs(a)));
  ranOnly(wrap(dir, execArgs(b)));
  const r = wrap(dir, execArgs(a));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reused run/);
});

test("reuse off: FOREMAN_TEST_REUSE=0 always runs", () => {
  const dir = tmp();
  seed(dir, [source()]);
  ranOnly(wrap(dir, execArgs(CODE), { FOREMAN_TEST_REUSE: "0" }));
});

test("reuse off: a truthy CI without FOREMAN_TEST_REUSE runs; an explicit FOREMAN_TEST_REUSE=1 wins over CI", () => {
  const dir = tmp();
  seed(dir, [source()]);
  ranOnly(wrap(dir, execArgs(CODE), { CI: "1", FOREMAN_TEST_REUSE: null }));
  // the CI run above recorded a newer pass, which is the source now
  assert.match(wrap(dir, execArgs(CODE), { CI: "1", FOREMAN_TEST_REUSE: "1" }).stdout, /reused run/);
});

test("reuse: a targeted run is never reused", () => {
  const dir = tmp();
  const file = path.join(tmp(), "ok.test.mjs");
  fs.writeFileSync(file, 'import { test } from "node:test";\ntest("x", () => {});\n');
  for (let i = 0; i < 2; i++) {
    const r = wrap(dir, ["--targeted", file]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /reused run/);
  }
  const lines = history(dir);
  assert.deepEqual(lines.map((l) => [l.mode, l.reusedFrom]), [["targeted", undefined], ["targeted", undefined]]);
  assert.ok(lines[0].treeStart, "a targeted run records treeStart too");
});

test("history: --history counts reuse lines in a separate reused figure and keeps them out of the runs figure", () => {
  const dir = tmp();
  seed(dir, [source(CODE, { id: "a" }), source(CODE, { id: "b", reusedFrom: "a", acquired: null }), source(CODE, { id: "c", reusedFrom: "a", acquired: null })]);
  const r = wrap(dir, ["--history"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^suite exec: runs 1; waited 0 /m);
  assert.match(r.stdout, /^suite exec: reused 2$/m);
  seed(dir, [source(CODE, { id: "a" })]);
  assert.doesNotMatch(wrap(dir, ["--history"]).stdout, /reused/);
});
