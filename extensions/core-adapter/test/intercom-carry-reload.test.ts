// PR 2 of the intercom round: the parent's question records are in memory only. A second adapter over the same world and handoff dir (a /reload) gets no
// reminder for a question the first one recorded; the same flow without the reload does (the control that keeps the first case from passing for nothing).
import "./_hermetic-env.mjs";
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHILD_BLOCKED_TYPE } from "../childblocked.ts";
import { writeRegistry } from "../session.ts";
import { world } from "./_r46world.ts";

const MIN = 60_000;
after(() => mock.timers.reset());

async function flow(t: { after(fn: () => void | Promise<void>): void }, reload: boolean) {
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const w = world(t, { sent });
  // the mock clock starts ahead of the files the world writes, so the rig's wait for a newer clock ends at once
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() + 60_000 });
  t.after(() => mock.timers.reset());
  const first = await w.adapter("startup");
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const sessionId = (first.ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261114-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: sessionId, handoff, status: "open" }] });
  const body = "Question: which option?";
  await first.fire("message_end", { message: { role: "custom", customType: "intercom_message", content: `**From fm-job-1**\n\n${body}`, details: { from: { id: "fm-job-1", name: "fm-job-1" }, bodyText: body, message: { content: { text: `**From fm-job-1**\n\n${body}` } } } } });
  if (reload) {
    await first.down();
    await w.adapter("reload");
  }
  for (let i = 0; i < 12; i++) mock.timers.tick(MIN);
  return sent.filter((s) => s.message.customType === CHILD_BLOCKED_TYPE && /for your answer to its question/.test(s.message.content));
}

test("control: a question recorded by the adapter gets its reminder", async (t) => {
  assert.equal((await flow(t, false)).length, 1);
});

test("the records are gone after a reload: the second adapter sends no reminder for the first one's question", async (t) => {
  assert.equal((await flow(t, true)).length, 0);
});
