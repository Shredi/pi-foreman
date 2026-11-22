// A resolved wait stays in the stored set until its wake is delivered, so a restart names it (with its outcome) instead of dropping it;
// the first outcome goes out at once (leading edge), later ones of the window are batched. Through the real adapter.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestWaits, lostWaitsMessage, WAITS_ENTRY, waitsEntry } from "../waitstate.ts";
import { WAKE_MESSAGE_TYPE } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

type Sent = { customType: string; content: string };
type Tool = { execute: (...a: unknown[]) => Promise<{ details?: Record<string, unknown> }> };
type Stored = { waits: { id: string; kind: string; note: string; outcome?: string }[] };

const until = async (f: () => boolean, ms = 6000): Promise<void> => {
  for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((res) => setTimeout(res, 10));
};

async function rig(t: { after(fn: () => void | Promise<void>): void }, idle: { v: boolean }) {
  const sent: { m: Sent; opts: Record<string, unknown> | undefined }[] = [];
  const appended: { type: string; data: unknown }[] = [];
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, {}, {
    ctx: { isIdle: () => idle.v },
    piExtra: {
      appendEntry: (type: string, data: unknown) => void appended.push({ type, data }),
      sendMessage: (m: Sent, opts?: Record<string, unknown>) => void sent.push({ m, opts }),
      registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d),
    },
  });
  const start = async (seconds: number, note: string) => String((await tools.get("foreman_wait")!.execute("w", { action: "start", kind: "timer", seconds, note }, undefined, undefined, r.ctx)).details?.id);
  const stored = (): Stored => (appended.filter((a) => a.type === WAITS_ENTRY).at(-1)?.data ?? { waits: [] }) as Stored;
  const wakes = () => sent.filter((s) => s.m.customType === WAKE_MESSAGE_TYPE);
  return { r, sent, appended, start, stored, wakes };
}

/** A new process of the same Pi session: what its session_start tells the agent about the stored set. */
async function restartWith(t: { after(fn: () => void | Promise<void>): void }, sessionId: string, data: unknown): Promise<Sent[]> {
  const sent: Sent[] = [];
  const branch = [{ type: "custom", customType: WAITS_ENTRY, data }];
  await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
    piExtra: { appendEntry: () => undefined, sendMessage: (m: Sent) => void sent.push(m), registerTool: () => undefined },
  });
  return sent.filter((m) => m.customType === WAKE_MESSAGE_TYPE);
}

test("first outcome with another wait active is sent at once; the second within the window is batched and still stored", async (t) => {
  const g = await rig(t, { v: true });
  const w1 = await g.start(1, "first");
  const w2 = await g.start(2, "second");
  const w3 = await g.start(3600, "long");
  await until(() => g.wakes().length > 0);
  assert.equal(g.wakes().length, 1, "w1 is sent at once although w3 is active");
  assert.deepEqual(g.wakes()[0].opts, { triggerTurn: true });
  assert.match(g.wakes()[0].m.content, new RegExp(`foreman_wait ${w1} \\(timer\\) "first": elapsed`));
  assert.deepEqual(g.stored().waits.map((w) => w.id).filter((id) => id !== w2 && id !== w3), [], "the delivered w1 left the stored set");
  await until(() => g.stored().waits.some((w) => w.id === w2 && w.outcome !== undefined), 6000);
  assert.equal(g.wakes().length, 1, "w2 resolved inside the window: batched, no wake yet");
  const s = g.stored().waits;
  assert.equal(s.find((w) => w.id === w2)?.outcome, "elapsed");
  assert.equal(s.find((w) => w.id === w3)?.outcome, undefined);

  // restore after an outcome held in the governor window names it with its outcome, and the active timer as lost
  const msgs = await restartWith(t, g.r.sessionId, { v: 1, piSessionId: g.r.sessionId, waits: s });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, new RegExp(`lost on restart: 1 wait died|lost on restart: 1 wait `));
  assert.match(msgs[0].content, new RegExp(`- ${w3} \\(timer\\) "long"`));
  assert.match(msgs[0].content, new RegExp(`result not delivered`));
  assert.match(msgs[0].content, new RegExp(`- ${w2} \\(timer\\) "second": elapsed`));
});

test("an outcome held while the agent is busy stays stored with its outcome until it is delivered", async (t) => {
  const idle = { v: false };
  const g = await rig(t, idle);
  const w1 = await g.start(1, "busy one");
  await until(() => g.stored().waits.some((w) => w.id === w1 && w.outcome !== undefined));
  assert.equal(g.wakes().length, 0, "held while busy");
  assert.equal(g.stored().waits.find((w) => w.id === w1)?.outcome, "elapsed");
  const msgs = await restartWith(t, g.r.sessionId, { v: 1, piSessionId: g.r.sessionId, waits: g.stored().waits });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, new RegExp(`- ${w1} \\(timer\\) "busy one": elapsed`));
  assert.doesNotMatch(msgs[0].content, /died with the old process/);
  idle.v = true;
  await g.r.fire("agent_settled", {});
  assert.equal(g.wakes().length, 1);
  assert.deepEqual(g.stored().waits, [], "delivered: gone from the stored set");
});

test("restore names every unresolved wait, a timer included, and an old-format entry restores as before", () => {
  const stored = waitsEntry("s", [{ id: "w1", kind: "timer", note: "t" }, { id: "w2", kind: "file", note: "f" }, { id: "w3", kind: "child", note: "c", outcome: "child a: result" }]);
  const msg = lostWaitsMessage(latestWaits([{ type: "custom", customType: WAITS_ENTRY, data: stored }], "s"))!;
  assert.deepEqual(msg.details, { lost: ["w1", "w2"], undelivered: ["w3"] });
  assert.match(msg.content, /- w1 \(timer\) "t"/);
  assert.match(msg.content, /- w2 \(file\) "f"/);
  assert.match(msg.content, /- w3 \(child\) "c": child a: result/);
  const old = { v: 1, piSessionId: "s", waits: [{ id: "w1", kind: "timer", note: "old" }] };
  const m2 = lostWaitsMessage(latestWaits([{ type: "custom", customType: WAITS_ENTRY, data: old }], "s"))!;
  assert.match(m2.content, /^foreman_wait lost on restart: 1 wait died/);
  assert.match(m2.content, /- w1 \(timer\) "old"/);
  assert.doesNotMatch(m2.content, /not delivered/);
});
