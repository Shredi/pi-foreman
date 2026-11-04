import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWait } from "../wait.ts";

// A wake that resolves while a run is active is not sent as a followUp (it would merge into that run and share its
// stop hold): it is held and goes out with triggerTurn when the adapter calls `settled` (agent_settled, after its reset).
function rig(intercom = false) {
  delete process.env.PI_SUBAGENT_CHILD;
  let tool: { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> } | undefined;
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>();
  const sent: { content: string; opts: Record<string, unknown> }[] = [];
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, h),
    registerTool: (t: never) => (tool = t),
    sendMessage: (m: { content: string }, opts: Record<string, unknown>) => sent.push({ content: m.content, opts }),
  };
  const session = { id: "s1", isChild: false, cwd: process.cwd(), agentDir: "/t/agent", overlay: null, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined, intercomRun: () => intercom };
  const handle = registerWait(pi as never, { session: async () => session as never, home: "/t/home", platform: process.platform });
  const state = { idle: true };
  const ctx = { mode: "tui", cwd: process.cwd(), isIdle: () => state.idle, sessionManager: { getSessionId: () => "s1" } };
  const start = (label: string) => tool!.execute("c", { action: "start", kind: "child", label }, undefined, undefined, ctx);
  return { handle, handlers, sent, state, ctx, start };
}

test("wait: an idle session is woken at once with triggerTurn", async () => {
  const r = rig();
  await r.start("a");
  r.handle.childNotice("s1", "a", "result", "/p");
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].opts, { triggerTurn: true });
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1, "nothing was held");
});

test("wait: a wake during a run is held and sent with triggerTurn at settle", async () => {
  const r = rig();
  await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  assert.equal(r.sent.length, 0, "no followUp into the running run");
  r.state.idle = true;
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].opts, { triggerTurn: true });
  assert.match(r.sent[0].content, /child a: result/);
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1, "a held wake is sent once");
});

test("wait: several outcomes during one run are one wake message", async () => {
  const r = rig();
  await r.start("a");
  await r.start("b");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  r.handle.childNotice("s1", "b", "update", "/q");
  assert.equal(r.sent.length, 0);
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].content, /child a: result/);
  assert.match(r.sent[0].content, /child b: update/);
});

test("wait: a wake during an intercom-triggered run is sent at once as a followUp, nothing held", async () => {
  const r = rig(true);
  await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].opts, { deliverAs: "followUp" });
  r.state.idle = true;
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1, "nothing was held");
});

test("wait: a wake during a non-intercom run is still held", async () => {
  const r = rig(false);
  await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  assert.equal(r.sent.length, 0);
});

test("wait: a session shutdown drops a held wake", async () => {
  const r = rig();
  await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  await r.handlers.get("session_shutdown")!({}, r.ctx);
  r.handle.settled("s1");
  assert.equal(r.sent.length, 0);
});
