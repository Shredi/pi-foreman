import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, latestWatches, PR_MESSAGE_TYPE, PRWATCH_ENTRY, PrWatches } from "../prwatch.ts";
import type { ChecksAnswer, Snapshot, Timers, WatchRecord } from "../prwatch.ts";
import { r11Rig } from "./_r11rig.ts";

const chk = (name: string, conclusion: string | null = null) => ({ name, status: "completed", conclusion, url: `https://h.invalid/${name}` });
const checks = (o: Partial<ChecksAnswer>): ChecksAnswer => ({ pending: [], failed: [], passed: [], summary: "s", ...o });
const SID = "sess-1";

function harness(poll: (n: number, cwd?: string) => Promise<Snapshot | { error: string }>) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let clock = 1_000_000;
  const sent: { msg: { customType: string; content: string; details: Record<string, unknown> }; idle: boolean }[] = [];
  const traces: Record<string, unknown>[] = [];
  const persisted: WatchRecord[][] = [];
  const w = new PrWatches({ poll: async (n, _u, cwd) => poll(n, cwd), cwd: () => "/work", persist: (x) => void persisted.push(x), send: (msg, idle) => void sent.push({ msg, idle }), idle: () => true, trace: (r) => void traces.push(r), intervalMs: () => 5000, now: () => clock, timers: fake });
  const settle = () => new Promise((r) => setImmediate(r));
  return { w, sent, traces, persisted, timers, settle, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const entry = (watches: unknown, piSessionId: string | undefined = SID, v: unknown = 1) => [{ type: "custom", customType: PRWATCH_ENTRY, data: { v, piSessionId, watches } }];

test("persist: start writes the record, an end removes it", async () => {
  const h = harness(async () => ({ checks: checks({ failed: [chk("b", "failure")] }) }));
  h.w.start(7, "checks", baselineOf({ checks: checks({ pending: [chk("b")] }) }), 600_000);
  assert.equal(h.persisted.length, 1);
  const rec = h.persisted[0][0];
  assert.equal(rec.n, 7);
  assert.equal(rec.cwd, "/work");
  assert.equal(rec.deadline, h.now() + 600_000);
  assert.deepEqual(rec.checks, [["b", "pending:"]]);
  h.advance(5000);
  [...h.timers].reverse().find((t) => t.live && t.ms === 5000)!.fn();
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.persisted.at(-1), []);
});

test("clear() persists nothing and sends nothing", () => {
  const h = harness(async () => ({}));
  h.w.start(7, "checks", baselineOf({ checks: checks({ pending: [chk("b")] }) }), 600_000);
  const before = h.persisted.length;
  h.w.clear();
  assert.equal(h.persisted.length, before);
  assert.equal(h.sent.length, 0);
});

test("restore: a check that failed while the session was down fires at once against the stored baseline", async () => {
  const a = harness(async () => ({}));
  a.w.start(7, "checks", baselineOf({ checks: checks({ pending: [chk("b")] }) }), 600_000);
  const stored = a.persisted[0];
  const polled: (string | undefined)[] = [];
  const h = harness(async (_n, cwd) => (polled.push(cwd), { checks: checks({ failed: [chk("b", "failure")] }) }));
  h.advance(60_000);
  h.w.restore(latestWatches(entry(JSON.parse(JSON.stringify(stored))), SID));
  assert.equal(h.w.has(7), true);
  await h.settle();
  assert.deepEqual(polled, ["/work"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].msg.customType, PR_MESSAGE_TYPE);
  assert.match(h.sent[0].msg.content, /PR #7 checks finished/);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "checks" }]);
  assert.equal(h.w.has(7), false);
});

test("restore: remaining time is kept (the stopper uses deadline - now) and polling continues", async () => {
  const h = harness(async () => ({ checks: checks({ pending: [chk("b")] }) }));
  const rec: WatchRecord = { n: 3, until: "any", checks: [["b", "pending:"]], commentIds: [], deadline: h.now() + 90_000, timeoutMs: 600_000, startedAt: h.now() - 510_000, cwd: "/w" };
  h.w.restore(latestWatches(entry([rec]), SID));
  await h.settle();
  assert.equal(h.timers[0].ms, 90_000);
  assert.ok(h.timers.some((t) => t.live && t.ms === 5000));
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.persisted.at(-1)?.map((r) => r.n), [3]);
});

test("restore: an expired watch gives exactly one lost message and a trace without the number", async () => {
  const h = harness(async () => ({}));
  const rec: WatchRecord = { n: 42, until: "any", checks: [], commentIds: [], deadline: h.now() - 1, timeoutMs: 600_000, startedAt: 0, cwd: "/w" };
  h.w.restore(latestWatches(entry([rec]), SID));
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].msg.customType, PR_MESSAGE_TYPE);
  assert.match(h.sent[0].msg.content, /watch lost on restart: deadline passed/);
  assert.equal(h.sent[0].idle, true);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "lost" }]);
  assert.ok(!JSON.stringify(h.traces).includes("42"));
  assert.equal(h.w.size(), 0);
  assert.deepEqual(h.persisted.at(-1), []);
});

test("restore: a malformed entry and a malformed record each give a lost notice without a number", async () => {
  for (const branch of [entry("not a list"), entry([{ n: "x" }]), [{ type: "custom", customType: PRWATCH_ENTRY, data: "junk" }], entry([], "")]) {
    const h = harness(async () => ({}));
    h.w.restore(latestWatches(branch, SID));
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].msg.content, /watch lost on restart: /);
    assert.equal(h.sent[0].msg.details.number, undefined);
    assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "lost" }]);
  }
});

test("restore: another session id, no entry, an unknown version are ignored or lost correctly", () => {
  const h = harness(async () => ({}));
  const rec: WatchRecord = { n: 5, until: "any", checks: [], commentIds: [], deadline: h.now() + 1000, timeoutMs: 1000, startedAt: 0, cwd: "/w" };
  h.w.restore(latestWatches(entry([rec], "other"), SID));
  h.w.restore(latestWatches([], SID));
  assert.equal(h.sent.length, 0);
  assert.equal(h.w.size(), 0);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.timers.length, 0);
});

test("restore: only the latest entry counts", () => {
  const h = harness(async () => ({}));
  const rec: WatchRecord = { n: 5, until: "any", checks: [], commentIds: [], deadline: h.now() + 1000, timeoutMs: 1000, startedAt: 0, cwd: "/w" };
  const r = latestWatches([...entry([rec]), ...entry([])], SID);
  assert.deepEqual(r, { status: "ok", watches: [], bad: 0 });
});

test("wiring: a resumed adapter session reports an expired watch once, empties the set, and shutdown appends nothing", async (t) => {
  const appended: { type: string; data: Record<string, unknown> }[] = [];
  const sent: { content: string; customType: string }[] = [];
  const sid = "resume-sid";
  const rec: WatchRecord = { n: 99, until: "any", checks: [], commentIds: [], deadline: Date.now() - 1000, timeoutMs: 600_000, startedAt: 0, cwd: "/w" };
  const branch = entry([rec], sid);
  const rig = await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => sid, getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
    piExtra: { appendEntry: (type: string, data: Record<string, unknown>) => void appended.push({ type, data }), sendMessage: (m: { content: string; customType: string }) => void sent.push(m) },
  });
  const lost = sent.filter((m) => m.customType === PR_MESSAGE_TYPE);
  assert.equal(lost.length, 1);
  assert.match(lost[0].content, /PR #99 watch lost on restart: deadline passed/);
  const sets = appended.filter((a) => a.type === PRWATCH_ENTRY);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].data, { v: 1, piSessionId: sid, watches: [] });
  assert.deepEqual(rig.events("pr_watch").map((e) => e.outcome), ["lost"]);
  assert.ok(!JSON.stringify(rig.events("pr_watch")).includes("99"));
  await rig.fire("session_shutdown", {});
  assert.equal(appended.filter((a) => a.type === PRWATCH_ENTRY).length, 1);
});

test("wiring: another session id's entry is ignored by the adapter", async (t) => {
  const sent: { customType: string }[] = [];
  const appended: string[] = [];
  const rec: WatchRecord = { n: 99, until: "any", checks: [], commentIds: [], deadline: Date.now() - 1000, timeoutMs: 600_000, startedAt: 0, cwd: "/w" };
  const branch = entry([rec], "someone-else");
  await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => "mine", getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
    piExtra: { appendEntry: (type: string) => void appended.push(type), sendMessage: (m: { customType: string }) => void sent.push(m) },
  });
  assert.equal(sent.filter((m) => m.customType === PR_MESSAGE_TYPE).length, 0);
  assert.equal(appended.filter((a) => a === PRWATCH_ENTRY).length, 0);
});
