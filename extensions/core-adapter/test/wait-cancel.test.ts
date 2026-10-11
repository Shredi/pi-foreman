import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWait } from "../wait.ts";

// foreman_wait: the session hooks see the id of a started wait and of a cancelled one (the finish gate's
// waiting_for_parent state is cleared on a cancel when no other handoff wait remains).
test("wait: onStart gets the wait id and onCancel the cancelled id", async () => {
  delete process.env.PI_SUBAGENT_CHILD;
  let tool: { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> } | undefined;
  const pi = { on: () => undefined, registerTool: (t: never) => (tool = t), sendMessage: () => undefined };
  const started: string[] = [];
  const cancelled: string[] = [];
  const session = { id: "s1", isChild: false, cwd: process.cwd(), agentDir: "/t/agent", overlay: null, config: () => ({}), trace: () => undefined, onStart: (_s: unknown, id: string) => started.push(id), onCancel: (id: string) => cancelled.push(id) };
  registerWait(pi as never, { session: async () => session as never, home: "/t/home", platform: process.platform });
  const ctx = { mode: "tui", cwd: process.cwd(), isIdle: () => true, sessionManager: { getSessionId: () => "s1" } };
  const a = await tool!.execute("c1", { action: "start", kind: "timer", seconds: 3600 }, undefined, undefined, ctx);
  const id = String(a.details.id);
  assert.deepEqual(started, [id]);
  await tool!.execute("c2", { action: "cancel", id: "nope" }, undefined, undefined, ctx);
  assert.deepEqual(cancelled, [], "an unknown id is not a cancel");
  await tool!.execute("c3", { action: "cancel", id }, undefined, undefined, ctx);
  assert.deepEqual(cancelled, [id]);
});
