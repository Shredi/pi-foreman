import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dropLock, ownsLock, takeLock, writeAtomic } from "../statefile.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pf-statefile-"));

test("takeLock: a second take is refused until the lock is dropped", () => {
  const dir = tmp();
  const lock = path.join(dir, "sub", "x.lock");
  const t = takeLock(lock, Date.now(), 60_000);
  assert.ok(t);
  assert.equal(ownsLock(lock, t), true);
  assert.equal(takeLock(lock, Date.now(), 60_000), null);
  dropLock(lock, t);
  assert.equal(fs.existsSync(lock), false);
  assert.ok(takeLock(lock, Date.now(), 60_000));
});

test("takeLock: a stale lock is taken over and the old owner no longer owns it", () => {
  const dir = tmp();
  const lock = path.join(dir, "x.lock");
  const old = takeLock(lock, Date.now(), 1000);
  assert.ok(old);
  const t2 = takeLock(lock, Date.now() + 5000, 1000);
  assert.ok(t2);
  assert.notEqual(t2, old);
  assert.equal(ownsLock(lock, old), false);
  assert.equal(ownsLock(lock, t2), true);
  dropLock(lock, old); // not the owner: leaves the lock
  assert.equal(fs.existsSync(lock), true);
});

test("ownsLock: false for a missing lock; dropLock of a missing lock does not throw", () => {
  const lock = path.join(tmp(), "none.lock");
  assert.equal(ownsLock(lock, "t"), false);
  dropLock(lock, "t");
});

test("writeAtomic: writes JSON, creates the directory, replaces the old file and leaves no tmp file", () => {
  const dir = tmp();
  const file = path.join(dir, "a", "b.json");
  writeAtomic(file, { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1 });
  writeAtomic(file, { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["b.json"]);
});

test("writeAtomic: a failure throws and removes the tmp file", () => {
  const dir = tmp();
  const file = path.join(dir, "target");
  fs.mkdirSync(file); // renaming a file over a directory fails
  assert.throws(() => writeAtomic(file, { v: 1 }));
  assert.deepEqual(fs.readdirSync(dir), ["target"]);
});
