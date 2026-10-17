// Ledger 10b: a chair/parent steer file written in the handoff dir while a launch-wait holds is delivered once.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { SteerWatch, STEER_WATCH_HEADER } from "../steerwatch.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-sw-")));
  t.after(() => rmTestTmp(d));
  return d;
}

function fakeTimers() {
  let fn: (() => void) | null = null;
  return { set: (f: () => void) => ((fn = f), 1), clear: () => void (fn = null), tick: () => fn?.(), active: () => fn !== null };
}

const put = (dir: string, name: string, text: string, mtimeSec: number): void => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, "utf8");
  fs.utimesSync(f, mtimeSec, mtimeSec);
};

test("a steer file written during a wait is delivered once", (t) => {
  const dir = tmp(t);
  const w = new SteerWatch(() => dir);
  const tm = fakeTimers();
  const got: string[] = [];
  const stop = w.start((x) => got.push(x), 10, tm);
  tm.tick();
  assert.deepEqual(got, []);
  put(dir, "steer-1.md", "use approach B", 2000);
  tm.tick();
  assert.equal(got.length, 1);
  assert.ok(got[0].includes(STEER_WATCH_HEADER) && got[0].includes("use approach B"));
  tm.tick();
  assert.equal(got.length, 1);
  put(dir, "ruling-2.md", "A", 3000);
  tm.tick();
  assert.equal(got.length, 2);
  put(dir, "steer-1.md", "changed", 4000); // a newer mtime is a new steer
  tm.tick();
  assert.equal(got.length, 3);
  stop();
  assert.equal(tm.active(), false);
});

test("a file already present at the first wait is not delivered; a non-steer file is ignored", (t) => {
  const dir = tmp(t);
  put(dir, "ruling-1.md", "old", 1000);
  put(dir, "notes.md", "x", 1000);
  const w = new SteerWatch(() => dir);
  const tm = fakeTimers();
  const got: string[] = [];
  w.start((x) => got.push(x), 10, tm);
  tm.tick();
  put(dir, "notes2.md", "y", 5000);
  tm.tick();
  assert.deepEqual(got, []);
  // a second wait on the same watcher does not redeliver a delivered steer
  put(dir, "steer.md", "go", 6000);
  tm.tick();
  assert.equal(got.length, 1);
  const tm2 = fakeTimers();
  w.start((x) => got.push(x), 10, tm2);
  tm2.tick();
  assert.equal(got.length, 1);
});

test("no handoff dir: nothing is polled and nothing changes", (t) => {
  const none = new SteerWatch(() => undefined);
  const tm = fakeTimers();
  const stop = none.start(() => assert.fail("no steer expected"), 10, tm);
  assert.equal(tm.active(), false);
  stop();
  assert.equal(none.take(), "");
  const missing = new SteerWatch(() => path.join(tmp(t), "absent"));
  assert.equal(missing.take(), "");
});
