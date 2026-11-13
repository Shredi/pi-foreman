// r42: the delivery of the parent's blocked-child notice through the real adapter (index.ts wiring of childblocked.ts): the 60 s timer is driven with
// node's mock setInterval, the child's live file and registry entry are written for real. The notice is one custom message of its own type, never
// `foreman_wake`; it leaves armed waits, the waiting-for-parent flag, the finish gate and the turn cause as they were.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHILD_BLOCKED_TYPE } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { writeRegistry } from "../session.ts";
import { WAKE_MESSAGE_TYPE } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0] & { mock: { timers: { enable(o: { apis: string[] }): void; tick(ms: number): void } } };
type Sent = { customType: string; content: string; display?: boolean };
type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> };
const MIN = 60_000;

async function rig(t: T) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: { m: Sent; opts: Record<string, unknown> | undefined }[] = [];
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, {}, { piExtra: { sendMessage: (m: Sent, opts?: Record<string, unknown>) => void sent.push({ m, opts }), registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d) } });
  const handoff = path.join(r.agentDir, "pi-foreman", "handoffs", "20261113-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: r.sessionId, handoff, status: "open" }] });
  const live = (f: Record<string, unknown>) => {
    fs.mkdirSync(liveDir(r.agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(r.agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date().toISOString(), ...f }));
  };
  const blocked = () => live({ blockedOn: "owner", blockedKind: "approval", ownerBlockedSince: new Date(Date.now() - 20 * MIN).toISOString() });
  const tick = () => t.mock.timers.tick(MIN);
  const wait = (params: Record<string, unknown>) => tools.get("foreman_wait")!.execute("w", params, undefined, undefined, r.ctx);
  /** The adapter's side of a message the harness appended: message_end, then the turn it started (before_agent_start, agent_start, agent_end). */
  const deliver = async (customType: string, content: string, details?: unknown) => {
    await r.fire("message_end", { message: { role: "custom", customType, content, ...(details ? { details } : {}) } });
    const turn = await r.noticeTurn(customType);
    await r.fire("agent_start", {});
    return turn;
  };
  const settle = () => r.fire("agent_before_settle", { outcome: "completed", entries: [] });
  return { ...r, sent, tools, handoff, live, blocked, tick, wait, deliver, settle };
}
const notices = (x: Awaited<ReturnType<typeof rig>>) => x.sent.filter((s) => s.m.customType === CHILD_BLOCKED_TYPE);

test("delivery: one custom message of its own type with a turn for the notice, none for the quiet note, never foreman_wake, never system text", async (t) => {
  const x = await rig(t as T);
  x.blocked();
  x.tick();
  x.tick();
  assert.equal(x.sent.length, 1, "one notice, no repeat");
  assert.equal(x.sent[0].m.customType, CHILD_BLOCKED_TYPE);
  assert.notEqual(x.sent[0].m.customType, WAKE_MESSAGE_TYPE);
  assert.deepEqual(x.sent[0].opts, { triggerTurn: true });
  assert.match(x.sent[0].m.content, /^Child session job has waited on its owner since .* \(approval\)\. Information only/);
  const turn = (await x.deliver(CHILD_BLOCKED_TYPE, x.sent[0].m.content)) as { systemPrompt?: string; message?: unknown } | undefined;
  assert.equal(JSON.stringify(turn ?? {}).includes("Child session job"), false, "nothing of it reaches the system prompt or a hook message");
  x.live({});
  x.tick();
  assert.equal(x.sent.length, 2);
  assert.equal(x.sent[1].m.customType, CHILD_BLOCKED_TYPE);
  assert.match(x.sent[1].m.content, /^Child session job: its dialog was answered after /);
  assert.deepEqual(x.sent[1].opts, { triggerTurn: false }, "the quiet note starts no turn");
  assert.deepEqual(x.events("child_blocked_notice").map((e) => e.label), ["job"]);
  assert.deepEqual(x.events("child_blocked_cleared").map((e) => e.label), ["job"]);
});

test("delivery: an armed child wait for the same label stays armed through the notice and still resolves on a later result", async (t) => {
  const x = await rig(t as T);
  const started = await x.wait({ action: "start", kind: "child", label: "job", note: "p1" });
  const id = String(started.details?.id);
  x.blocked();
  x.tick();
  assert.equal(notices(x).length, 1);
  await x.deliver(CHILD_BLOCKED_TYPE, notices(x)[0].m.content);
  assert.match((await x.wait({ action: "list" })).content[0].text, new RegExp(id), "the wait is still listed");
  assert.equal(x.sent.filter((s) => s.m.customType === WAKE_MESSAGE_TYPE).length, 0, "the notice woke no wait");
  x.live({});
  x.tick();
  assert.match((await x.wait({ action: "list" })).content[0].text, new RegExp(id), "nor does the quiet note");
  // the child's result arrives later as an intercom message: the wait resolves with it
  const msg = { role: "custom", customType: "intercom_message", details: { from: { id: "fm-job-1" }, message: { id: "m1", content: { text: "foreman:result /h/result.md" } } } };
  await r11Fire(x, msg);
  await until(() => x.sent.some((s) => s.m.customType === WAKE_MESSAGE_TYPE));
  assert.match(x.sent.find((s) => s.m.customType === WAKE_MESSAGE_TYPE)!.m.content, /child job: result \/h\/result\.md/);
});
const r11Fire = (x: Awaited<ReturnType<typeof rig>>, message: unknown) => x.fire("message_end", { message });
async function until(f: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(f(), "timed out");
}

test("delivery: with a file wait on a child's result.md armed, the notice and the quiet note leave the flag and the handoff waits as they were; the finish gate and the turn cause too", async (t) => {
  const x = await rig(t as T);
  const w = await x.wait({ action: "start", kind: "file", path: path.join(x.handoff, "result.md"), note: "" });
  const id = String(w.details?.id);
  assert.deepEqual(x.events("waiting_for_parent").map((e) => e.decision), ["set"]);
  x.blocked();
  x.tick();
  await x.deliver(CHILD_BLOCKED_TYPE, notices(x)[0].m.content);
  assert.equal(await x.settle(), undefined, "the notice turn ends: the finish gate does not refuse it");
  assert.equal(x.events("finish_refused").length, 0);
  await x.fire("agent_end", {});
  x.live({});
  x.tick();
  assert.equal(notices(x).length, 2, "the quiet note");
  await x.deliver(CHILD_BLOCKED_TYPE, notices(x)[1].m.content);
  await x.fire("agent_end", {});
  assert.deepEqual(x.events("turn").map((e) => e.cause), ["other", "other"], "never `wake`");
  assert.deepEqual(x.events("waiting_for_parent").map((e) => e.decision), ["set"], "the flag was not touched");
  // the handoff wait is still tracked: cancelling it is what clears the flag
  await x.wait({ action: "cancel", id });
  assert.deepEqual(x.events("waiting_for_parent").map((e) => e.decision), ["set", "cleared"]);
});

test("delivery, control: a foreman_wake message does clear the handoff waits and records the cause wake (so the checks above are sensitive)", async (t) => {
  const x = await rig(t as T);
  const w = await x.wait({ action: "start", kind: "file", path: path.join(x.handoff, "result.md"), note: "" });
  await x.deliver(WAKE_MESSAGE_TYPE, "woken", { kinds: ["file"] });
  await x.fire("agent_end", {});
  assert.equal(x.events("turn").at(-1)!.cause, "wake");
  await x.wait({ action: "cancel", id: String(w.details?.id) });
  assert.deepEqual(x.events("waiting_for_parent").map((e) => e.decision), ["set"], "the wake reset the handoff waits: the cancel clears nothing");
});
