// PR 2 of the intercom round, parent side through the real adapter (index.ts wiring): an inbound intercom message from an open child whose first line
// starts with `Question` is recorded; the one-minute pass sends one reminder for it (node's mock setInterval and Date); the parent's own send to that child
// removes the record. Observed only through the message the pass sends: no trace event and no display is read.
import "./_hermetic-env.mjs";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first after the preload: the git answers are in place before the adapter loads
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHILD_BLOCKED_TYPE } from "../childblocked.ts";
import { writeRegistry } from "../session.ts";
import { r11Rig } from "./_r11rig.ts";

type Sent = { customType: string; content: string };
const MIN = 60_000;
const sent: { m: Sent; opts: Record<string, unknown> | undefined }[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
let shared: Awaited<ReturnType<typeof r11Rig>>;
before(async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  shared = await r11Rig({ after: (fn) => void cleanups.push(fn) }, {}, { deps: { spawner: inprocSpawner }, piExtra: { sendMessage: (m: Sent, opts?: Record<string, unknown>) => void sent.push({ m, opts }) } });
}, { timeout: 20_000 });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  mock.timers.reset();
}, { timeout: 20_000 });

async function rig(status = "open") {
  sent.length = 0;
  await shared.fire("agent_end", {});
  const r = shared;
  const handoff = path.join(r.agentDir, "pi-foreman", "handoffs", "20261114-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: r.sessionId, handoff, status }, { label: "other", child: "fm-other-1", parent: r.sessionId, handoff, status: "open" }] });
  const inbound = (id: string, body: string) => r.fire("message_end", { message: { role: "custom", customType: "intercom_message", content: `**From ${id}**\n\n${body}`, details: { from: { id, name: id }, bodyText: body, message: { content: { text: `**From ${id}**\n\n${body}` } } } } });
  const send = (to: string) => r.fire("tool_result", { toolName: "intercom", toolCallId: `s-${to}-${Date.now()}`, input: { action: "send", to, message: "Answer: A" }, details: { delivered: true }, content: [{ type: "text", text: `Message sent to ${to}` }], isError: false });
  // the adapter session is shared: the parent's send to each child drops a record an earlier case left
  await send("fm-job-1");
  await send("fm-other-1");
  const tick = (n: number) => { for (let i = 0; i < n; i++) mock.timers.tick(MIN); };
  const reminders = () => sent.filter((s) => s.m.customType === CHILD_BLOCKED_TYPE && /for your answer to its question/.test(s.m.content));
  return { inbound, send, tick, reminders };
}

test("a question of an open child gets one reminder with label and age, started as a turn; the child's text never enters it", async () => {
  const x = await rig();
  await x.inbound("fm-job-1", "Question: which secret_marker option?");
  x.tick(9);
  assert.equal(x.reminders().length, 0, "not before the configured seconds");
  x.tick(2);
  assert.equal(x.reminders().length, 1);
  assert.match(x.reminders()[0].m.content, /^Child session job has waited 1\d m? ?.*for your answer to its question\./);
  assert.equal(x.reminders()[0].m.content.includes("secret_marker"), false);
  assert.deepEqual(x.reminders()[0].opts, { triggerTurn: true }, "an idle parent gets a turn");
  x.tick(5);
  assert.equal(x.reminders().length, 1, "once per record");
});

test("no reminder for another sender, a message without the word or a Plan from line", async () => {
  const y = await rig();
  await y.inbound("stranger-1", "Question: who am I?");
  await y.inbound("fm-job-1", "Done: all fine");
  await y.inbound("fm-job-1", "Plan from job: plan.md");
  y.tick(12);
  assert.equal(y.reminders().length, 0);
});

test("a question of a closed child is not recorded: the child open again later gets no reminder for it", async () => {
  const x = await rig("closed");
  await x.inbound("fm-job-1", "Question: closed child?");
  // reopened before any pass runs and with no send to it (`rig()` would send): a record made while it was closed would now be reminded
  writeRegistry(shared.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: shared.sessionId, handoff: path.join(shared.agentDir, "pi-foreman", "handoffs", "20261114-080000-job"), status: "open" }] });
  x.tick(12);
  assert.equal(x.reminders().length, 0);
});

test("the parent's send to that child removes the record; a send to another session does not", async () => {
  const x = await rig();
  await x.inbound("fm-job-1", "Question: one?");
  await x.send("fm-other-1");
  x.tick(11);
  assert.equal(x.reminders().length, 1, "a send to another session leaves the record");
  const y = await rig();
  await y.inbound("fm-job-1", "Question: two?");
  await y.send("fm-job-1");
  y.tick(11);
  assert.equal(y.reminders().length, 0, "answered by the parent's send");
});
