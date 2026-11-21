// scripts/test_tmp_root.mjs: the per-run temp root and the start sweep. Every test uses its own bases; the real temp dir is never swept.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createRunRoot, leftovers, removeRunRoot, sweepStale, realTmpBase, RUN_PREFIX } = await import(pathToFileURL(path.join(ROOT, "scripts", "test_tmp_root.mjs")).href);

const MADE = [];
after(() => {
  for (const d of MADE) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
function base() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-tmproot-test-")));
  MADE.push(d);
  return d;
}
const DAY = 24 * 60 * 60 * 1000;
/** A top-level entry `name` in `b` whose mtime is `ageMs` old. */
function entry(b, name, ageMs, { file = false } = {}) {
  const p = path.join(b, name);
  if (file) fs.writeFileSync(p, "x");
  else {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "f"), "x");
  }
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

test("createRunRoot makes pf-run-* under the base and names it in the env; removeRunRoot removes it with its content", () => {
  const b = base();
  const { root, env } = createRunRoot(b);
  assert.equal(path.dirname(root), b);
  assert.ok(path.basename(root).startsWith(RUN_PREFIX));
  assert.equal(env.FOREMAN_TEST_TMP_ROOT, root);
  assert.equal(env.PI_FOREMAN_TEST_TMP, root);
  if (process.platform === "win32") assert.equal(env.TMPDIR, undefined);
  else assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], [root, root, root]);
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "top.txt"), "x");
  assert.deepEqual(leftovers(root).sort(), ["a", "top.txt"]);
  removeRunRoot(root);
  assert.ok(!fs.existsSync(root));
  assert.deepEqual(leftovers(root), []);
  removeRunRoot(root); // already gone: no throw
});

test("realTmpBase is os.tmpdir() unless that is under /tmp or win32, then the cache base", () => {
  const t = path.resolve(os.tmpdir());
  const under = t === "/tmp" || t.startsWith("/tmp/");
  if (process.platform === "win32" || under) assert.equal(realTmpBase(), path.join(os.homedir(), ".cache", "pi-foreman-tests"));
  else assert.equal(realTmpBase(), os.tmpdir());
});

test("sweepStale removes old pf- entries only: prefix, age, top level", () => {
  const b = base();
  entry(b, "pf-old-dir", 3 * DAY);
  entry(b, "pf-old-file", 3 * DAY, { file: true });
  entry(b, "pf-new-dir", 1000);
  entry(b, "other-old-dir", 3 * DAY);
  entry(b, "pf-just-inside", DAY - 60_000);
  // an old pf- dir nested in a fresh non-pf dir, and in a fresh pf- dir: never reached
  const keep = entry(b, "keep", 1000);
  const nested = entry(keep, "pf-nested-old", 3 * DAY);
  const fresh = entry(b, "pf-fresh-parent", 1000);
  const nested2 = entry(fresh, "pf-nested-old2", 3 * DAY);
  const r = sweepStale({ bases: [b] });
  assert.equal(r.removed, 2);
  assert.deepEqual(fs.readdirSync(b).sort(), ["keep", "other-old-dir", "pf-fresh-parent", "pf-just-inside", "pf-new-dir"]);
  assert.ok(fs.existsSync(nested) && fs.existsSync(nested2));
});

test("sweepStale takes `now` and `maxAgeMs` and ignores a missing base", () => {
  const b = base();
  entry(b, "pf-a", 2000);
  const r = sweepStale({ bases: [path.join(b, "missing"), b], maxAgeMs: 1000 });
  assert.equal(r.removed, 1);
  entry(b, "pf-b", 1000);
  assert.equal(sweepStale({ bases: [b], now: Date.now() + 10 * DAY }).removed, 1);
});

test("sweepStale does not follow a symlink: the link goes, the target stays", { skip: process.platform === "win32" }, () => {
  const b = base();
  const target = base();
  fs.writeFileSync(path.join(target, "precious"), "x");
  const link = path.join(b, "pf-link");
  fs.symlinkSync(target, link);
  const old = new Date(Date.now() - 3 * DAY);
  fs.lutimesSync(link, old, old);
  const r = sweepStale({ bases: [b] });
  assert.equal(r.removed, 1);
  assert.ok(!fs.existsSync(link));
  assert.ok(fs.existsSync(path.join(target, "precious")));
});

test("sweepStale keeps the persistent pf-rb-work cache", () => {
  const b = base();
  entry(b, "pf-rb-work", 30 * DAY);
  entry(b, "pf-rb-work-other", 30 * DAY);
  assert.equal(sweepStale({ bases: [b] }).removed, 1);
  assert.deepEqual(fs.readdirSync(b), ["pf-rb-work"]);
});

test("sweepStale skips an entry another user owns (where getuid exists)", { skip: typeof process.getuid !== "function" }, (t) => {
  const b = base();
  entry(b, "pf-mine", 3 * DAY);
  const real = process.getuid;
  t.mock.method(process, "getuid", () => real.call(process) + 1);
  const r = sweepStale({ bases: [b] });
  assert.equal(r.removed, 0);
  assert.ok(fs.existsSync(path.join(b, "pf-mine")));
});

test("sweepStale stops at the cap", () => {
  const b = base();
  for (let i = 0; i < 5; i++) entry(b, `pf-old-${i}`, 3 * DAY);
  const r = sweepStale({ bases: [b], cap: 3 });
  assert.equal(r.removed, 3);
  assert.equal(fs.readdirSync(b).length, 2);
});

test("sweepStale stops when the time budget is spent", () => {
  const b = base();
  entry(b, "pf-old-0", 3 * DAY);
  assert.equal(sweepStale({ bases: [b], budgetMs: -1 }).removed, 0);
});

test("leftovers leaves tool caches out of the count", () => {
  const b = base();
  fs.mkdirSync(path.join(b, "node-compile-cache"));
  fs.mkdirSync(path.join(b, "jiti"));
  fs.mkdirSync(path.join(b, "tsx-501"));
  assert.deepEqual(leftovers(b), []);
  fs.mkdirSync(path.join(b, "pf-leak"));
  assert.deepEqual(leftovers(b), ["pf-leak"]);
});
