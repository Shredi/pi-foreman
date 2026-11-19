// A removal of a record folder that fails (plan structured-verdicts §7 "Cleanup") neither throws out of sweepRecords nor stops session start or shutdown.
// The failure is real: a session folder that is read-only cannot lose its launch folder. Skipped where permissions do not bind (root, Windows).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRecordDir, recordDir, recordSessionDir, sweepRecords, VERDICT_FILE } from "../verdict.ts";
import { r11Rig } from "./_r11rig.ts";

const DAY = 24 * 60 * 60 * 1000;
const bound = process.platform !== "win32" && process.getuid?.() !== 0;

/** A record folder of `session`, `ageMs` old; `readOnly` makes its session dir unremovable. Returns the session dir. */
function folder(agentDir: string, session: string, ageMs: number, readOnly: boolean): string {
  const dir = recordDir(agentDir, session, "L1");
  makeRecordDir(dir);
  fs.writeFileSync(path.join(dir, VERDICT_FILE), "{}");
  const when = new Date(Date.now() - ageMs);
  for (const p of [path.join(dir, VERDICT_FILE), dir, recordSessionDir(agentDir, session)]) fs.utimesSync(p, when, when);
  const sessionDir = recordSessionDir(agentDir, session);
  if (readOnly) fs.chmodSync(sessionDir, 0o555);
  return sessionDir;
}

const reopen = (dirs: string[]): void => {
  for (const d of dirs) if (fs.existsSync(d)) fs.chmodSync(d, 0o755);
};

test("sweepRecords: a folder that cannot be removed does not throw and does not stop the sweep of the others", { skip: !bound }, (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sweep-fail-"));
  const dirs: string[] = [];
  t.after(() => {
    reopen(dirs);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  for (const [name, readOnly] of [["a-stuck", true], ["b-stuck", true], ["c-removable", false], ["d-removable", false]] as const) dirs.push(folder(agentDir, name, 8 * DAY, readOnly));
  assert.doesNotThrow(() => sweepRecords(agentDir, Date.now()));
  assert.deepEqual(dirs.map((d) => fs.existsSync(d)), [true, true, false, false]);
});

test("session start and shutdown go through when a record folder cannot be removed", { skip: !bound }, async (t) => {
  const r = await r11Rig(t, {});
  const old = folder(r.agentDir, "old-session", 8 * DAY, true);
  const own = folder(r.agentDir, r.sessionId, 0, true);
  try {
    await assert.doesNotReject(async () => r.fire("session_start", { reason: "startup" }), "the sweep of a stuck folder does not stop the start");
    assert.equal(fs.existsSync(old), true);
    await assert.doesNotReject(async () => r.fire("session_shutdown", {}), "the removal of a stuck own folder does not stop the shutdown");
    assert.equal(fs.existsSync(own), true);
  } finally {
    reopen([old, own]);
  }
});
