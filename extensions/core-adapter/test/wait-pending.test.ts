import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { registerWait } from "../wait.ts";
import { WAITS_ENTRY } from "../waitstate.ts";

// Every resolved wait yields exactly one wake; until it is sent, `foreman_wait list` shows it as "wake pending" and the stored set keeps it.
function rig(windowSeconds = 0) {
  delete process.env.PI_SUBAGENT_CHILD;
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> } | undefined;
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>();
  const sent: { content: string; opts: Record<string, unknown> }[] = [];
  const appended: { type: string; data: { waits: { id: string; outcome?: string }[] } }[] = [];
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, h),
    registerTool: (t: never) => (tool = t),
    sendMessage: (m: { content: string }, opts: Record<string, unknown>) => sent.push({ content: m.content, opts }),
    appendEntry: (type: string, data: never) => appended.push({ type, data }),
  };
  const session = { id: "s1", isChild: false, cwd: process.cwd(), agentDir: "/t/agent", roots: null, config: () => ({ wait: { batchWindowSeconds: windowSeconds } }), trace: () => undefined, intercomRun: () => false };
  const handle = registerWait(pi as never, { session: async () => session as never, home: "/t/home", platform: process.platform });
  const state = { idle: true };
  const ctx = { mode: "tui", cwd: process.cwd(), isIdle: () => state.idle, sessionManager: { getSessionId: () => "s1" } };
  const start = async (label: string) => String((await tool!.execute("c", { action: "start", kind: "child", label }, undefined, undefined, ctx)).details.id);
  const list = async () => (await tool!.execute("c", { action: "list" }, undefined, undefined, ctx)).content[0].text;
  const stored = () => appended.filter((a) => a.type === WAITS_ENTRY).at(-1)?.data.waits ?? [];
  return { handle, handlers, sent, state, ctx, start, list, stored, appended };
}

test("pending: an idle resolve gives exactly one triggered wake", async () => {
  const r = rig();
  await r.start("a");
  r.handle.childNotice("s1", "a", "result", "/p");
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].opts, { triggerTurn: true });
});

test("pending: a resolve during a run is listed as wake pending until settled, then sent once", async () => {
  const r = rig();
  const id = await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  assert.equal(r.sent.length, 0);
  const during = await r.list();
  assert.match(during, new RegExp(`${id} child.* resolved, wake pending: child a: result`));
  assert.equal(r.stored().find((w) => w.id === id)?.outcome, "child a: result /p");
  r.state.idle = true;
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].opts, { triggerTurn: true });
  assert.equal(await r.list(), "No active waits.");
  assert.deepEqual(r.stored(), []);
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
});

test("pending: two resolutions plus an unrelated run in the batch window are both delivered once", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const r = rig(30);
  await r.start("a");
  await r.start("b");
  await r.start("c");
  r.handle.childNotice("s1", "a", "result", "/pa");
  assert.equal(r.sent.length, 1, "leading edge goes out at once");
  r.handle.childNotice("s1", "b", "result", "/pb");
  assert.equal(r.sent.length, 1, "b waits for the window");
  assert.match(await r.list(), /resolved, wake pending: child b: result/);
  // an unrelated run (subagent notice): starts, settles, no wait involved
  r.state.idle = false;
  r.handle.settled("s1");
  assert.equal(r.sent.length, 1);
  mock.timers.tick(30_000); // the window ends inside a later run: held
  assert.equal(r.sent.length, 1);
  assert.match(await r.list(), /resolved, wake pending: child b: result/);
  r.state.idle = true;
  r.handle.settled("s1");
  assert.equal(r.sent.length, 2);
  assert.deepEqual(r.sent[1].opts, { triggerTurn: true });
  assert.match(r.sent[0].content, /child a: result/);
  assert.match(r.sent[1].content, /child b: result/);
  assert.doesNotMatch(r.sent[1].content, /child a: result/);
  r.handle.settled("s1");
  mock.timers.tick(60_000);
  assert.equal(r.sent.length, 2);
  assert.deepEqual(r.stored().map((w) => w.id), [r.stored()[0]?.id].filter(Boolean), "only the active c remains stored");
  assert.equal(r.stored().some((w) => w.outcome !== undefined), false);
});

test("pending: a shutdown between resolve and delivery keeps the outcome stored, and restore delivers it with its text", async () => {
  const r = rig();
  const id = await r.start("a");
  r.state.idle = false;
  r.handle.childNotice("s1", "a", "result", "/p");
  await r.handlers.get("session_shutdown")!({}, r.ctx);
  const entry = r.appended.filter((a) => a.type === WAITS_ENTRY).at(-1)!;
  assert.equal(entry.data.waits.find((w) => w.id === id)?.outcome, "child a: result /p");
  // the new process
  const r2 = rig();
  const branch = [{ type: "custom", customType: WAITS_ENTRY, data: { ...entry.data, piSessionId: "s1" } }];
  const ctx2 = { ...r2.ctx, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } };
  await r2.handle.restore(ctx2 as never);
  assert.equal(r2.sent.length, 1);
  assert.deepEqual(r2.sent[0].opts, { triggerTurn: true });
  assert.match(r2.sent[0].content, new RegExp(`${id} \\(child\\).*child a: result /p`));
  assert.doesNotMatch(r2.sent[0].content, /died with the old process/);
});
