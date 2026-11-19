// `foreman reports list|show|set|expire` (reports-cli.ts): output, exit codes and the store it works on; no import or migrate command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, type ReportsDeps } from "../reports-cli.ts";
import { DATA_LINE, foldRows, readRows, recordReport, storeFor } from "../reports.ts";
import type { Writer } from "../reports.ts";

const DAY = 86_400_000;
function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-reports-cli-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const w = (cwd: string, session: string, now?: number): Writer => ({ cwd, role: "foreman", session, runId: null, source: "agent", repo: null, workspace: null, branch: null, ...(now ? { now } : {}) });
const rep = (subject: string) => ({ kind: "rule", subject, what: "what happened", effect: "blocked" });

async function cli(cwd: string, argv: string[], now = Date.now(), expireDays?: number) {
  let out = "";
  let err = "";
  const deps = (): ReportsDeps => ({ cwd, now: () => now, expireDays: async () => expireDays });
  const code = await main(argv, (s) => (out += s), (s) => (err += s), deps);
  return { code, out, err };
}

test("list opens with the data line, defaults to open entries, --state and --json work", async (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "s1"), rep("alpha"));
  recordReport(w(dir, "s1"), rep("beta"));
  const key = foldRows(readRows(storeFor(dir).file))[0].key;
  assert.equal((await cli(dir, ["set", key, "done"])).code, 0);
  const open = await cli(dir, ["list"]);
  assert.equal(open.code, 0);
  assert.equal(open.out.split("\n")[0], DATA_LINE);
  assert.equal(open.out.trim().split("\n").length, 2);
  assert.equal((await cli(dir, ["list", "--state", "done"])).out.trim().split("\n").length, 2);
  assert.equal((await cli(dir, ["list", "--state", "all"])).out.trim().split("\n").length, 3);
  const json = JSON.parse((await cli(dir, ["list", "--state", "all", "--json"])).out) as { key: string }[];
  assert.equal(json.length, 2);
});

test("show prints one entry with its reports; an unknown key exits 1; --json carries the rows", async (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "s1"), { ...rep("alpha"), suggest: "do x" });
  const key = foldRows(readRows(storeFor(dir).file))[0].key;
  const s = await cli(dir, ["show", key.slice(0, 6)]);
  assert.equal(s.code, 0);
  assert.match(s.out, /subject "alpha"/);
  assert.match(s.out, /suggest "do x"/);
  assert.equal(s.out.split("\n")[0], DATA_LINE);
  assert.equal(JSON.parse((await cli(dir, ["show", key, "--json"])).out).reports.length, 1);
  const none = await cli(dir, ["show", "ffffffffffff"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no entry/);
});

test("set changes the state with label, pr and reason; bad input prints usage and exits 2", async (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "s1"), rep("alpha"));
  const key = foldRows(readRows(storeFor(dir).file))[0].key;
  assert.match((await cli(dir, ["set", key, "planned", "--label", "round 4"])).out, /is now planned/);
  assert.match((await cli(dir, ["set", key, "done", "--pr", "12"])).out, /is now done/);
  const e = foldRows(readRows(storeFor(dir).file))[0];
  assert.deepEqual([e.state, e.pr, e.label], ["done", 12, null], "each state row stands for itself");
  for (const bad of [["set", key], ["set", key, "expired"], ["set", key, "done", "--pr", "x"], ["set", key, "done", "--pr"], ["set", key, "done", "--bogus", "1"], ["list", "--state", "weird"], ["nope"], [], ["import"], ["migrate"]]) {
    const r = await cli(dir, bad);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, /usage: foreman reports list/);
  }
  assert.equal((await cli(dir, ["set", "ffffffffffff", "done"])).code, 1);
});

test("expire uses --days, then retro.expireDays, then 14, and archives with --archive-days", async (t) => {
  const dir = tmp(t);
  const t0 = Date.parse("2030-01-01T00:00:00Z");
  recordReport(w(dir, "s1", t0), rep("alpha"));
  assert.equal((await cli(dir, ["expire"], t0 + 10 * DAY)).out, "expired 0, archived 0\n");
  assert.equal((await cli(dir, ["expire"], t0 + 10 * DAY, 5)).out, "expired 1, archived 0\n");
  assert.equal((await cli(dir, ["expire", "--days", "1", "--archive-days", "3"], t0 + 20 * DAY, 99)).out, "expired 0, archived 2\n");
  assert.equal((await cli(dir, ["expire", "--days", "0"])).code, 2);
});

test("outside git every folder is its own workspace", async (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "s1"), rep("alpha"));
  fs.mkdirSync(path.join(dir, "sub"));
  // outside git every folder is its own workspace: a subfolder sees an empty list
  assert.match((await cli(path.join(dir, "sub"), ["list"])).out, /no entries/);
});
