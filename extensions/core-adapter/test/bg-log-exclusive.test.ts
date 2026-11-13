// The background log is created exclusively: an existing file is never truncated or appended to; a taken name is retried with a new one (bounded). No process is started: spawn is a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { BG_LOG_TRIES, spawnDetached, spawnIntoNewLog, spawnWithFreshLog } from "../bg.ts";

const stubSpawn = (calls: unknown[][] = []) => ((...a: unknown[]) => (calls.push(a), { pid: 4242, on: () => undefined, unref: () => undefined })) as never;

test("spawnIntoNewLog: an existing log is left intact and reported as taken, nothing is spawned", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const log = path.join(dir, "wait-w1.log");
  fs.writeFileSync(log, "earlier run\n");
  const calls: unknown[][] = [];
  for (const platform of ["linux", "win32"]) {
    const r = spawnIntoNewLog("echo x", dir, log, platform, {}, stubSpawn(calls));
    assert.ok("error" in r && r.exists === true, JSON.stringify(r));
  }
  assert.equal(fs.readFileSync(log, "utf8"), "earlier run\n");
  assert.equal(calls.length, 0);
});

test("spawnDetached: an existing log is left intact and the call fails without an `exists` field", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const log = path.join(dir, "wait-w1.log");
  fs.writeFileSync(log, "earlier run\n");
  const r = spawnDetached("echo x", dir, log, "linux");
  assert.ok("error" in r && !("exists" in r), JSON.stringify(r));
  assert.equal(fs.readFileSync(log, "utf8"), "earlier run\n");
});

test("spawnIntoNewLog: a new log is created", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const log = path.join(dir, "sub", "wait-w1.log");
  const r = spawnIntoNewLog("echo x", dir, log, "linux", {}, stubSpawn());
  assert.deepEqual(r, { pid: 4242 });
  assert.equal(fs.readFileSync(log, "utf8"), "");
});

test("spawnWithFreshLog: a taken name is retried with the next name; the taken file stays intact", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const taken = [path.join(dir, "a.log"), path.join(dir, "b.log")];
  for (const f of taken) fs.writeFileSync(f, `keep ${path.basename(f)}\n`);
  const names = [...taken, path.join(dir, "c.log")];
  let i = 0;
  const calls: unknown[][] = [];
  const r = spawnWithFreshLog("echo x", dir, () => names[i++], "linux", {}, stubSpawn(calls));
  assert.deepEqual(r, { pid: 4242, log: names[2] });
  assert.equal(calls.length, 1);
  for (const f of taken) assert.equal(fs.readFileSync(f, "utf8"), `keep ${path.basename(f)}\n`);
});

test("spawnWithFreshLog: gives up after the bounded number of tries and says so; nothing is spawned or changed", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const log = path.join(dir, "a.log");
  fs.writeFileSync(log, "keep\n");
  let tries = 0;
  const calls: unknown[][] = [];
  const r = spawnWithFreshLog("echo x", dir, () => (tries++, log), "linux", {}, stubSpawn(calls));
  assert.ok("error" in r && /after \d+ tries/.test(r.error), JSON.stringify(r));
  assert.equal(tries, BG_LOG_TRIES);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(log, "utf8"), "keep\n");
});

test("spawnWithFreshLog: another failure is not retried", (t) => {
  const dir = mkTestTmp("pf-bglogx-");
  t.after(() => rmTestTmp(dir));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  let tries = 0;
  const r = spawnWithFreshLog("echo x", dir, () => (tries++, path.join(blocker, "x.log")), "linux", {}, stubSpawn());
  assert.ok("error" in r);
  assert.equal(tries, 1);
});
