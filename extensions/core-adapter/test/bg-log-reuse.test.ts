// A reload restarts the wait id sequence (w1 again) while an earlier foreman_bg run lives on: the new run must get its own log.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { bgLogPath, freshBgLogPath, spawnDetached } from "../bg.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("freshBgLogPath: the same session and wait id after a simulated reload gets a different log; the first log stays intact", async (t) => {
  const dir = mkTestTmp("pf-bglogreuse-");
  t.after(() => rmTestTmp(dir));
  const first = freshBgLogPath(dir, "s1", "w1");
  assert.equal(first, bgLogPath(dir, "s1", "w1"));
  const a = spawnDetached("echo first-run", dir, first);
  assert.ok("pid" in a, JSON.stringify(a));
  for (let i = 0; i < 50 && !/first-run/.test(fs.existsSync(first) ? fs.readFileSync(first, "utf8") : ""); i++) await sleep(100);
  // reload: a fresh runtime hands out w1 again
  const second = freshBgLogPath(dir, "s1", "w1");
  assert.notEqual(second, first);
  assert.equal(path.dirname(second), path.dirname(first));
  const b = spawnDetached("echo second-run", dir, second);
  assert.ok("pid" in b, JSON.stringify(b));
  for (let i = 0; i < 50 && !/second-run/.test(fs.existsSync(second) ? fs.readFileSync(second, "utf8") : ""); i++) await sleep(100);
  assert.match(fs.readFileSync(first, "utf8"), /first-run/);
  assert.doesNotMatch(fs.readFileSync(first, "utf8"), /second-run/);
  assert.match(fs.readFileSync(second, "utf8"), /second-run/);
  assert.notEqual(freshBgLogPath(dir, "s1", "w1"), second);
});
