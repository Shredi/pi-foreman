// Cleanup of the record folders (plan structured-verdicts §7 "Cleanup"): at session start the folders of sessions whose last write is older than
// 7 days are removed, newer ones and the own session's folder stay.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRecordDir, recordDir, recordSessionDir, sweepRecords, VERDICT_FILE } from "../verdict.ts";

const DAY = 24 * 60 * 60 * 1000;

function folder(agentDir: string, session: string, ageMs: number, now: number): string {
  const dir = recordDir(agentDir, session, "L1");
  makeRecordDir(dir);
  fs.writeFileSync(path.join(dir, VERDICT_FILE), "{}");
  const t = new Date(now - ageMs);
  for (const p of [path.join(dir, VERDICT_FILE), dir, recordSessionDir(agentDir, session)]) fs.utimesSync(p, t, t);
  return recordSessionDir(agentDir, session);
}

test("sweepRecords removes session folders older than 7 days and keeps newer ones", (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sweep-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const now = Date.now();
  const old = folder(agentDir, "old-session", 8 * DAY, now);
  const fresh = folder(agentDir, "fresh-session", 6 * DAY, now);
  sweepRecords(agentDir, now);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("sweepRecords keeps the own session folder however old, and does nothing without a records root", (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sweep-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  sweepRecords(agentDir, Date.now());
  const now = Date.now();
  const own = folder(agentDir, "own-session", 30 * DAY, now);
  sweepRecords(agentDir, now, "own-session");
  assert.equal(fs.existsSync(own), true);
});
