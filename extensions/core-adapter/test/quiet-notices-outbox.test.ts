// Quiet notices (item 4): the merge notice and the `foreman:closed` ack ask pi-intercom not to wake an idle parent (`noWake: true` in the
// outbox request); the close-reason line and every other outbox send keep waking (no field). An older pi-intercom drops the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, INTERCOM_OUTBOX_EVENT, mergeNotifier, outboxSend, outboxSendDetailed } from "../close.ts";
import type { CloseDeps, OutboxOpts } from "../close.ts";

const HANDOFF = "/h/20261102-120000-demo";
const FILE = "/x/.workflow/r.md";

/** A bus that records every outbox request and answers it `sent`. */
function bus() {
  const reqs: Record<string, unknown>[] = [];
  const handlers: ((d: unknown) => void)[] = [];
  const events = {
    on: (_ev: string, fn: (d: unknown) => void) => {
      handlers.push(fn);
      return () => undefined;
    },
    emit: (ev: string, data: unknown) => {
      if (ev !== INTERCOM_OUTBOX_EVENT) return;
      reqs.push(data as Record<string, unknown>);
      queueMicrotask(() => handlers.forEach((h) => h({ requestId: (data as { requestId: string }).requestId, status: "sent" })));
    },
  };
  return { events, reqs };
}

test("outboxSend / outboxSendDetailed carry noWake only when asked", async () => {
  const b = bus();
  await outboxSend(b.events, "parent-1", "plain", "close");
  await outboxSend(b.events, "parent-1", "quiet", "close", undefined, { noWake: true });
  await outboxSendDetailed(b.events, "parent-1", "quiet2", "close", undefined, { noWake: true });
  await outboxSendDetailed(b.events, "parent-1", "plain2", "close", undefined, {});
  assert.deepEqual(b.reqs.map((r) => [r.message, "noWake" in r ? r.noWake : "absent"]), [["plain", "absent"], ["quiet", true], ["quiet2", true], ["plain2", "absent"]]);
});

test("the merge notice goes out quiet", async () => {
  const b = bus();
  const notify = mergeNotifier({ handoff: HANDOFF, parent: "parent-1", remote: false, notify: () => undefined, reply: (to, t, o) => outboxSend(b.events, to, t, "close", undefined, o), trace: () => undefined });
  notify(7);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.reqs.length, 1);
  assert.match(String(b.reqs[0].message), /^PR #7 merged; demo stays open/);
  assert.equal(b.reqs[0].noWake, true);
});

function flowRig(o: { merged?: boolean; refuse?: boolean }) {
  const b = bus();
  const sends: Promise<unknown>[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t, opts?: OutboxOpts) => {
      const p = outboxSend(b.events, to, t, "close", undefined, opts);
      sends.push(p);
      return p;
    },
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    watchedPrs: () => [],
    ...(o.merged ? { mergedPr: () => 7, mergedOwn: () => true, selfFinish: async () => ({ lines: o.refuse ? ["cleanup: not started (worktree_dirty)"] : [] }) } : {}),
  };
  const ctx = { isIdle: () => true, shutdown: () => undefined };
  return { b, flow: new CloseFlow(deps), ctx, sends };
}

async function closeIt(r: ReturnType<typeof flowRig>): Promise<void> {
  const { closePrompt } = await import("../close.ts");
  await r.flow.request({ source: "intercom-parent", file: FILE, replyTo: "parent-1" }, r.ctx, true);
  r.flow.onInput(closePrompt(FILE), "extension");
  r.flow.onModelReply("stop");
  await r.flow.onSettled(r.ctx);
  await Promise.all(r.sends);
}

test("the foreman:closed ack goes out quiet", async () => {
  const r = flowRig({});
  await closeIt(r);
  assert.equal(r.b.reqs.length, 1);
  assert.match(String(r.b.reqs[0].message), /^foreman:closed /);
  assert.equal(r.b.reqs[0].noWake, true);
});

test("the close-reason line before the ack keeps waking, the ack is quiet", async () => {
  const r = flowRig({ merged: true, refuse: true });
  await closeIt(r);
  const msgs = r.b.reqs.map((q) => [String(q.message).slice(0, 14), "noWake" in q ? q.noWake : "absent"]);
  assert.deepEqual(msgs, [["PR #7 merged, ", "absent"], ["foreman:closed", true]]);
});
