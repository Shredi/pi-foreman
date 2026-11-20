// D105: after an update the sessions that still run older pi-foreman code are listed with their restart command (`foreman setup`, the update check).
// harnessid.mjs is the node side; tests/test_update_check_older_sessions.py holds the same fixture for the Python twin.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessId, olderSessions, olderSessionsLines, restartLine } from "../harnessid.mjs";
import { world } from "./_r46world.ts";
import { liveDir } from "../livestate.ts";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const CURRENT = { version: "2.0.0", commit: "abc1234" };
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The fixture shared with the Python twin test: same files, same expected lines. */
export const FIXTURE: Record<string, Record<string, unknown>> = {
  child: { sessionId: "child", label: "job", cwd: "/w/job", pid: 101, parentIntercom: "fm-parent", harness: { version: "1.0.0", commit: "old1234" } },
  plain: { sessionId: "plain", cwd: "/w/main", pid: 102 },
  current: { sessionId: "current", label: "same", pid: 103, parentIntercom: "fm-parent", harness: CURRENT },
  dead: { sessionId: "dead", label: "gone", pid: 104, parentIntercom: "fm-parent" },
  stale: { sessionId: "stale", label: "late", pid: 105, parentIntercom: "fm-parent", heartbeat: -200_000 },
  done: { sessionId: "done", label: "fin", pid: 106, parentIntercom: "fm-parent", state: "done" },
};

function agentWith(files: typeof FIXTURE): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d105-"));
  fs.mkdirSync(liveDir(d), { recursive: true });
  for (const [name, f] of Object.entries(files)) {
    const { heartbeat = 0, ...rest } = f;
    fs.writeFileSync(path.join(liveDir(d), `${name}.json`), JSON.stringify({ heartbeatAt: new Date(NOW + (heartbeat as number)).toISOString(), state: "idle", ...rest }));
  }
  return d;
}

test("older sessions: stamp differs or is missing; current, dead, stale, done and this process are skipped; the restart line fits the session", (t) => {
  const d = agentWith(FIXTURE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const list = olderSessions(d, CURRENT, { now: NOW, alive: (pid: number) => pid !== 104, self: 999 });
  assert.deepEqual(list.map((s: { sessionId: string }) => s.sessionId), ["child", "plain"]);
  assert.equal(list[0].restart, "foreman session restart job");
  assert.equal(list[1].restart, "quit it (/quit), then in /w/main: pi --session plain");
  assert.deepEqual(olderSessions(d, CURRENT, { now: NOW, alive: () => true, self: 101 }).map((s: { sessionId: string }) => s.sessionId).includes("child"), false, "this process is skipped");
  assert.deepEqual(olderSessionsLines(list), [
    "2 running sessions still run older pi-foreman code (an update does not reach a running session); restart each:",
    "  job: foreman session restart job",
    "  plain: quit it (/quit), then in /w/main: pi --session plain",
  ]);
  assert.deepEqual(olderSessionsLines([]), []);
  assert.equal(restartLine({ label: "x", parentIntercom: null, cwd: "/c", sessionId: "s" }), "quit it (/quit), then in /c: pi --session s");
});

test("harnessId reads the package version and the checkout commit; the adapter stamps the live file with it", async (t) => {
  const id = harnessId(PKG_ROOT);
  assert.match(id.version ?? "", /^\d/);
  const w = world(t, { ceremony: { default: "standard" } });
  await w.adapter();
  await new Promise((r) => setTimeout(r, 1300));
  const dir = liveDir(path.join(w.project, "..", "agent"));
  const f = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((n) => n.endsWith(".json"))[0]), "utf8")) as { harness?: unknown };
  assert.deepEqual(f.harness, id);
});
