// scripts/test_tmp_root_preload.mjs and tests/_isolation.py: a direct run makes a run root per process, removes it at exit, never sweeps.
import { test, after } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRELOAD = pathToFileURL(path.join(ROOT, "scripts", "test_tmp_root_preload.mjs")).href;
const DAY = 24 * 60 * 60 * 1000;

const MADE = [];
after(() => {
  for (const d of MADE) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
function scratch() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-tmppre-test-")));
  MADE.push(d);
  return d;
}
/** The child env: a fake TMPDIR (base) and HOME, no outer root. */
function childEnv(base, home, extra = {}) {
  const env = { ...process.env };
  delete env.FOREMAN_TEST_TMP_ROOT;
  delete env.PI_FOREMAN_TEST_TMP;
  delete env.NODE_TEST_CONTEXT;
  return { ...env, TMPDIR: base, TMP: base, TEMP: base, HOME: home, USERPROFILE: home, ...extra };
}
function old(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - 5 * DAY);
  fs.utimesSync(dir, t, t);
}
/** Both places a run root may land (the fake TMPDIR, or the fake HOME cache when TMPDIR is under /tmp or on win32). */
function bases(base, home) {
  return [base, path.join(home, ".cache", "pi-foreman-tests")];
}

test("the node preload gives each file process its own root, removes it at exit, and never sweeps", () => {
  const dir = scratch();
  const base = path.join(dir, "base");
  const home = path.join(dir, "home");
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  for (const b of bases(base, home)) old(path.join(b, "pf-ancient"));
  for (const n of ["a", "b"]) {
    fs.writeFileSync(
      path.join(dir, `${n}.test.mjs`),
      `import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
test("${n}", () => {
  const root = process.env.FOREMAN_TEST_TMP_ROOT;
  fs.writeFileSync(path.join(${JSON.stringify(out)}, "${n}.json"), JSON.stringify({ root, existed: fs.existsSync(root), tmp: fs.realpathSync(os.tmpdir()), under: path.basename(root).startsWith("pf-run-") }));
  fs.mkdirSync(path.join(root, "inner"));
});
`,
    );
  }
  fs.mkdirSync(base, { recursive: true });
  const r = spawnSync(process.execPath, ["--import", PRELOAD, "--test", path.join(dir, "a.test.mjs"), path.join(dir, "b.test.mjs")], { env: childEnv(base, home), encoding: "utf8", cwd: dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const recs = ["a", "b"].map((n) => JSON.parse(fs.readFileSync(path.join(out, `${n}.json`), "utf8")));
  const allowed = bases(base, home).map((b) => fs.realpathSync(fs.existsSync(b) ? b : path.dirname(b)));
  for (const rec of recs) {
    assert.ok(rec.under && rec.existed, "a pf-run- root existed during the file");
    assert.ok(allowed.some((b) => fs.realpathSync(path.dirname(rec.root)).startsWith(b) || b.startsWith(fs.realpathSync(path.dirname(rec.root)))), `root ${rec.root} is under a fake base`);
    assert.ok(!fs.existsSync(rec.root), "the root is removed after the process exits");
  }
  for (const b of bases(base, home)) {
    assert.ok(fs.existsSync(path.join(b, "pf-ancient")), `the preload did not sweep ${b}`);
    assert.deepEqual(fs.readdirSync(b).filter((n) => n.startsWith("pf-run-")), [], "no run root left");
  }
});

test("the node preload reuses an outer root and removes nothing of it", () => {
  const dir = scratch();
  const outer = path.join(dir, "outer");
  fs.mkdirSync(outer);
  const r = spawnSync(process.execPath, ["--import", PRELOAD, "-e", "process.stdout.write(process.env.FOREMAN_TEST_TMP_ROOT)"], { env: childEnv(path.join(dir, "b"), path.join(dir, "h"), { FOREMAN_TEST_TMP_ROOT: outer }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, outer);
  assert.ok(fs.existsSync(outer));
});

const PYTHON = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
const py = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });
const skipPy = py.status === 0 ? false : "no python";

test("tests/_isolation.py makes a pf-run- root for TMPDIR and removes it at exit", { skip: skipPy }, () => {
  const dir = scratch();
  const base = path.join(dir, "base");
  const home = path.join(dir, "home");
  fs.mkdirSync(base);
  const code = "import tests._isolation, os, sys, tempfile, json; print(json.dumps({'root': os.environ['FOREMAN_TEST_TMP_ROOT'], 'tmpdir': os.environ.get('TMPDIR'), 'gettemp': tempfile.gettempdir()}))";
  const r = spawnSync(PYTHON, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); ${code}`], { env: childEnv(base, home), encoding: "utf8", cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.ok(path.basename(rec.root).startsWith("pf-run-"));
  if (process.platform !== "win32") {
    assert.equal(rec.tmpdir, rec.root);
    assert.equal(path.resolve(rec.gettemp), path.resolve(rec.root));
  }
  assert.ok(!fs.existsSync(rec.root), "the root is removed after the process exits");
});

test("tests/_isolation.py reuses an outer root and does not remove it", { skip: skipPy }, () => {
  const dir = scratch();
  const outer = path.join(dir, "outer");
  fs.mkdirSync(outer);
  fs.mkdirSync(path.join(dir, "b"));
  const code = "import tests._isolation, os, tempfile; print(os.environ['FOREMAN_TEST_TMP_ROOT'])";
  const r = spawnSync(PYTHON, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); ${code}`], { env: childEnv(path.join(dir, "b"), path.join(dir, "h"), { FOREMAN_TEST_TMP_ROOT: outer }), encoding: "utf8", cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), outer);
  assert.ok(fs.existsSync(outer));
});
