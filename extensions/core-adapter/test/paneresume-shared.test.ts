// Crash restart, shared modules it changed: floors protect state/panes, the identity entry carries the launch keys (shape, no-append rule),
// LiveInit.endedBy is read by stop(), LiveInit.taskEnded drops ended tasks from the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, pathFloors, type FloorEnv } from "../floors.ts";
import { captureIdentity, latestIdentity } from "../identity.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], protectedBranches: [], currentBranch: () => "x", remoteHead: () => "main", pkgRoot: "/pkg" };
const PANES = "/h/me/.pi/agent/pi-foreman/state/panes";

test("floors: an agent write into state/panes is refused (write tool and shell), a read is not", () => {
  assert.ok(pathFloors({ path: `${PANES}/t1.json`, content: "{}" }, env, "write"), "write tool");
  assert.ok(pathFloors({ path: `${PANES}/t1.json`, old_string: "a", new_string: "b" }, env, "edit"), "edit tool");
  for (const l of [`tee ${PANES}/t1.json`, `rm ${PANES}/t1.json`, `echo x > ${PANES}/t1.json`, `rm -r ${PANES}`]) {
    assert.ok(lineFloors(l, parseShell(l, { cwd: env.cwd }), env), l);
  }
  for (const l of [`cat ${PANES}/t1.json`, `ls ${PANES}`]) assert.equal(lineFloors(l, parseShell(l, { cwd: env.cwd }), env), null, l);
});

const HANDOFF = { PI_FOREMAN_HANDOFF_DIR: "/h/handoff", PI_INTERCOM_STABLE_ID: "child-1" };
const BASE_SHAPE = { v: 1, piSessionId: "s1", child: "child-1", parentLabel: null, handoff: "/h/handoff", model: null, remoteParent: null, sessionName: null };

test("identity: an entry without the new keys keeps today's exact shape; the new keys are written only when set", () => {
  assert.deepEqual(captureIdentity(HANDOFF, "s1", undefined), BASE_SHAPE);
  assert.deepEqual(Object.keys(captureIdentity(HANDOFF, "s1", undefined) as object), Object.keys(BASE_SHAPE));
  const full = captureIdentity({ ...HANDOFF, PI_FOREMAN_PERMS_PROFILE: "mine", PI_FOREMAN_PLAN_PHASE: "1", PI_BG_FEATURES: "process,poll", PI_BG_B: "x", PI_BG_BAD: "a;b", PI_BG_lower: "x", OTHER: "y" }, "s1", undefined);
  if (process.platform !== "win32") assert.deepEqual(full, { ...BASE_SHAPE, permsProfile: "mine", planPhase: "1", bgEnv: { PI_BG_B: "x", PI_BG_FEATURES: "process,poll" } });
  assert.deepEqual(captureIdentity({ ...HANDOFF, PI_FOREMAN_PLAN_PHASE: "2" }, "s1", undefined), BASE_SHAPE, "a plan phase other than 1 is not captured");
  assert.equal(captureIdentity({ PI_FOREMAN_PERMS_PROFILE: "mine" }, "s1", undefined), null, "a plain session has no identity entry");
});

test("identity: latestIdentity reads the launch keys back, so an unchanged identity compares equal (no append); a changed one differs", () => {
  const e = { PI_FOREMAN_PERMS_PROFILE: "mine", PI_FOREMAN_PLAN_PHASE: "1", PI_BG_FEATURES: "process" };
  const first = captureIdentity({ ...HANDOFF, ...e }, "s1", undefined);
  const stored = latestIdentity([{ type: "custom", customType: "pi-foreman-identity", data: JSON.parse(JSON.stringify(first)) }]);
  assert.equal(JSON.stringify(stored), JSON.stringify(captureIdentity({ ...HANDOFF, ...e }, "s1", undefined)), "unchanged: equal as JSON");
  assert.notEqual(JSON.stringify(stored), JSON.stringify(captureIdentity({ ...HANDOFF, ...e, PI_FOREMAN_PERMS_PROFILE: "other" }, "s1", undefined)), "changed: a new entry");
  const plain = latestIdentity([{ type: "custom", customType: "pi-foreman-identity", data: BASE_SHAPE }]);
  assert.deepEqual(plain, BASE_SHAPE);
  const dirty = latestIdentity([{ type: "custom", customType: "pi-foreman-identity", data: { ...BASE_SHAPE, planPhase: "x", bgEnv: { PI_BG_OK: "1", PI_BG_BAD: "a;b" } } }]);
  assert.equal(dirty?.planPhase, undefined);
  assert.deepEqual(dirty?.bgEnv, { PI_BG_OK: "1" });
});

function liveRig(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(mkTestTmp("pf-prs-"));
  t.after(() => rmTestTmp(root));
  return { agentDir: path.join(root, "agent"), cwd: path.join(root, "project") };
}
const NO = () => undefined;

function task(cwd: string, session: string, id: string, extra: Record<string, unknown> = {}): void {
  const base = path.join(cwd, ".pi", "tasks", `${session}-4321`);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, `${id}.json`), JSON.stringify({ id, status: "running", startTime: Date.now() - 5000, name: `job ${id}`, pid: 7, ...extra }));
}

test("LiveInit.endedBy is read by stop() for its last write; without it the record has no endedBy", (t) => {
  const { agentDir, cwd } = liveRig(t);
  const file = path.join(liveDir(agentDir), "sess-a.json");
  let flag: "signal" | undefined;
  const a = LiveState.start({ agentDir, sessionId: "sess-a", cwd, mode: "tui", env: {}, endedBy: () => flag }, () => [], NO, () => [], NO, () => []) as LiveState;
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).endedBy, undefined, "running: not set");
  flag = "signal";
  a.stop();
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(rec.state, "done");
  assert.equal(rec.endedBy, "signal");
  const b = LiveState.start({ agentDir, sessionId: "sess-b", cwd, mode: "tui", env: {} }, () => [], NO, () => [], NO, () => []) as LiveState;
  b.stop();
  const plain = JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), "sess-b.json"), "utf8"));
  assert.equal(plain.state, "done");
  assert.equal("endedBy" in plain, false);
  const c = LiveState.start({ agentDir, sessionId: "sess-c", cwd, mode: "tui", env: {}, endedBy: () => { throw new Error("boom"); } }, () => [], NO, () => [], NO, () => []) as LiveState;
  c.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), "sess-c.json"), "utf8")).state, "done", "a throwing callback does not break stop()");
});

test("LiveInit.taskEnded drops ended tasks from the record; default keeps all (sliced to 20)", (t) => {
  const { agentDir, cwd } = liveRig(t);
  for (let i = 0; i < 25; i++) task(cwd, "sess-t", `dead${String(i).padStart(2, "0")}`, { pid: 1, startTime: Date.now() - 9000 });
  task(cwd, "sess-t", "live-one", { pid: 2, startTime: Date.now() - 1000 });
  const read = (id: string): { tasks?: { id: string }[] } => JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), `${id}.json`), "utf8"));
  const kept = LiveState.start({ agentDir, sessionId: "sess-t", cwd, mode: "tui", env: {}, taskEnded: (x) => x.pid === 1 }, () => [], NO, () => [], NO, () => []) as LiveState;
  assert.deepEqual(read("sess-t").tasks?.map((x) => x.id), ["live-one"], "dead tasks are dropped from the record");
  kept.stop();
  const all = LiveState.start({ agentDir, sessionId: "sess-t", cwd, mode: "tui", env: {} }, () => [], NO, () => [], NO, () => []) as LiveState;
  assert.equal(read("sess-t").tasks?.length, 20, "default: none dropped, sliced to 20");
  all.stop();
});

test("LiveInit.taskEnded: a live task older than 25 newer dead ones is still in the record", (t) => {
  const { agentDir, cwd } = liveRig(t);
  for (let i = 0; i < 25; i++) task(cwd, "sess-o", `dead${String(i).padStart(2, "0")}`, { pid: 1, startTime: Date.now() - 5000 - i });
  task(cwd, "sess-o", "live-one", { pid: 2, startTime: Date.now() - 600_000 });
  const live = LiveState.start({ agentDir, sessionId: "sess-o", cwd, mode: "tui", env: {}, taskEnded: (x) => x.pid === 1 }, () => [], NO, () => [], NO, () => []) as LiveState;
  const rec = JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), "sess-o.json"), "utf8")) as { tasks?: { id: string }[] };
  assert.deepEqual(rec.tasks?.map((x) => x.id), ["live-one"], "ended tasks are dropped before the 20-entry cap");
  live.stop();
});

test("deadTasks names a dead task older than 20 newer live ones", async (t) => {
  const { cwd } = liveRig(t);
  for (let i = 0; i < 20; i++) task(cwd, "sess-d", `live${String(i).padStart(2, "0")}`, { pid: 2, startTime: Date.now() - 5000 - i });
  task(cwd, "sess-d", "dead-old", { pid: 1, startTime: Date.now() - 600_000 });
  const { deadTasks } = await import("../paneresume.ts");
  assert.deepEqual(deadTasks(cwd, "sess-d", (x) => x.pid === 1).map((x) => x.id), ["dead-old"]);
});
