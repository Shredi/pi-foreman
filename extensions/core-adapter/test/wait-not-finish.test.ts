import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";

// A turn end with a wake source pending (foreman_wait, running subagent, notifying bg task) is a pause:
// neither the ledger stop guard nor the finish gate runs, and nothing is spent.
const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. open item\n- [ ] V. fresh-eyes verification passed\n";
type R = { continue?: boolean; entries?: { customType?: string }[] } | undefined;

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(LEDGER);
  const settle = async (): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
  const wait = async (): Promise<string> => {
    const r = (await a.tool("foreman_wait")!.execute("w", { action: "start", kind: "timer", seconds: 3600 }, undefined, undefined, a.ctx)) as { details: { id: string } };
    return String(r.details.id);
  };
  const skips = async () => (await w.traceEvents()).filter((e) => e.event === "finish_gate");
  const types = (r: R) => (r?.entries ?? []).map((e) => e.customType);
  return { w, a, settle, wait, skips, types };
}

test("no pending source: the stop guard holds as before and no skip is traced", async (t) => {
  const { a, settle, skips, types } = await rig(t);
  void a;
  const r = await settle();
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-stop-gate"]);
  assert.deepEqual(await skips(), []);
});

test("active wait: both gates stay silent, the skip is traced with the wait id, nothing is spent", async (t) => {
  const { a, settle, wait, skips } = await rig(t);
  const id = await wait();
  assert.equal(await settle(), undefined);
  assert.equal(await settle(), undefined, "repeated settles stay silent");
  const ev = await skips();
  assert.equal(ev.length, 2);
  assert.equal(ev[0].skipped, "pending_wait");
  assert.equal(ev[0].runId, `wait:${id}`);
  await a.tool("foreman_wait")!.execute("c", { action: "cancel", id }, undefined, undefined, a.ctx);
  // the stop guard's once-per-session reminder was not consumed: it still holds after the wait is gone
  const r = await settle();
  assert.equal(r?.continue, true);
  assert.deepEqual((r?.entries ?? []).map((e) => e.customType), ["pi-foreman-stop-gate"]);
});

test("finish gate: a wait spends no refusal; a cancelled wait re-arms the gate", async (t) => {
  const { w, a, settle, wait, types } = await rig(t);
  // a closed ledger: only the finish gate (builder + reviewer missing at standard) can hold
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n");
  const id = await wait();
  for (let i = 0; i < 3; i++) assert.equal(await settle(), undefined);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "finish_refused").length, 0);
  await a.tool("foreman_wait")!.execute("c", { action: "cancel", id }, undefined, undefined, a.ctx);
  const r = await settle();
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "finish_refused").length, 1);
});

test("a running subagent skips the gates", async (t) => {
  const { a, settle, skips } = await rig(t);
  const run = await a.reviewLaunch();
  assert.equal(run.blocked, null);
  assert.equal(await settle(), undefined);
  const ev = await skips();
  assert.equal(ev.length, 1);
  assert.match(String(ev[0].runId), /run:/);
  a.endRun(run.id, "Overall verdict: PASS");
});

test("a timer wait that resolves by itself brings the gates back", async (t) => {
  const { a, settle } = await rig(t);
  await a.tool("foreman_wait")!.execute("w", { action: "start", kind: "timer", seconds: 1 }, undefined, undefined, a.ctx);
  assert.equal(await settle(), undefined, "pending while the timer runs");
  let r: R;
  for (let i = 0; i < 50; i++) {
    await new Promise((res) => setTimeout(res, 100));
    r = await settle();
    if (r?.continue) break;
  }
  assert.equal(r?.continue, true, "the elapsed timer no longer holds the gates off");
});

function taskRecord(project: string, sessionId: string, flags: Record<string, boolean>, pid: number = process.pid) {
  const dir = path.join(project, ".pi", "tasks", `${sessionId}-${pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t1.json"), JSON.stringify({ id: "t1", status: "running", name: "build", startTime: Date.now(), ...flags }));
}

test("bg task: a running record of another pi process (foreign pid dir) is not counted", async (t) => {
  const { w, a, settle, skips } = await rig(t);
  const sid = (a.ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  taskRecord(w.project, sid, {}, process.pid + 1);
  const r = await settle();
  assert.equal(r?.continue, true, "a stale record wakes nobody");
  assert.deepEqual(await skips(), []);
});

test("bg task: counted by default, not counted with trigger off", async (t) => {
  const { w, a, settle, skips } = await rig(t);
  const sid = (a.ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  taskRecord(w.project, sid, { triggerOnCompletion: false });
  const r = await settle();
  assert.equal(r?.continue, true, "a task that wakes nobody is no pause");
  assert.deepEqual(await skips(), []);
  taskRecord(w.project, sid, {});
  assert.equal(await settle(), undefined);
  const ev = await skips();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].runId, "bg:t1");
});
