import { test } from "node:test";
import assert from "node:assert/strict";
import { latestWatches, PR_MESSAGE_TYPE, PRWATCH_ENTRY, PrWatches } from "../prwatch.ts";
import type { Timers, WatchPoll, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { r11Rig } from "./_r11rig.ts";

const SID = "sess-1";
const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123", base: "main", updatedAt: "t0", runs: [], ...o });

function harness(poll: (key: PrKey, cwd?: string) => Promise<WatchPoll>) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let clock = 1_000_000;
  const sent: { msg: { customType: string; content: string; details: Record<string, unknown> }; idle: boolean }[] = [];
  const traces: Record<string, unknown>[] = [];
  const persisted: WatchRecord[][] = [];
  const w = new PrWatches({ poll: async (key, cwd) => poll(key, cwd), cwd: () => "/work", persist: (x) => void persisted.push(x), send: (msg, idle) => void sent.push({ msg, idle }), idle: () => true, trace: (r) => void traces.push(r), intervalMs: () => 5000, now: () => clock, timers: fake });
  const settle = () => new Promise((r) => setImmediate(r));
  return { w, sent, traces, persisted, timers, settle, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const entry = (watches: unknown, piSessionId: string | undefined = SID, v: unknown = 2) => [{ type: "custom", customType: PRWATCH_ENTRY, data: { v, piSessionId, watches } }];

test("persist: start writes a v2 record with the key and the baseline state, an unwatch removes it", () => {
  const h = harness(async () => ({ snap: snap() }));
  h.w.start(K, snap({ head: "abc", comments: [{ id: "c1", kind: "issue", author: "a", body: "b" }] }));
  assert.equal(h.persisted.length, 1);
  const rec = h.persisted[0][0];
  assert.deepEqual(rec.key, K);
  assert.equal(rec.cwd, "/work");
  assert.equal(rec.state.head, "abc");
  assert.deepEqual(rec.state.commentIds, ["c1"]);
  assert.equal("deadline" in rec, false);
  h.w.unwatch(7);
  assert.deepEqual(h.persisted.at(-1), []);
});

test("clear() persists nothing and sends nothing", () => {
  const h = harness(async () => ({ snap: snap() }));
  h.w.start(K, snap());
  const before = h.persisted.length;
  h.w.clear();
  assert.equal(h.persisted.length, before);
  assert.equal(h.sent.length, 0);
});

test("restore: a v2 watch resumes without a deadline; a check that failed while the session was down fires at once", async () => {
  const a = harness(async () => ({ snap: snap() }));
  a.w.start(K, snap({ runs: [{ id: "1", name: "b", bucket: "pending", url: "" }] }));
  const stored = a.persisted[0];
  const polled: (string | undefined)[] = [];
  const h = harness(async (_k, cwd) => (polled.push(cwd), { snap: snap({ runs: [{ id: "1", name: "b", bucket: "failed", url: "https://h.invalid/b" }] }) }));
  h.advance(3_600_000 * 24);
  h.w.restore(latestWatches(entry(JSON.parse(JSON.stringify(stored))), SID));
  assert.equal(h.w.has(K), true);
  await h.settle();
  assert.deepEqual(polled, ["/work"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].msg.customType, PR_MESSAGE_TYPE);
  assert.match(h.sent[0].msg.content, /PR #7 checks finished: fail/);
  assert.equal(h.w.has(K), true); // stays armed
  assert.ok(h.timers.some((t) => t.live));
  assert.deepEqual(h.persisted.at(-1)?.map((r) => r.key.n), [7]);
});

test("restore: a v1 record converts to a number-only key and keeps polling", async () => {
  const h = harness(async () => ({ snap: snap({ runs: [{ id: "1", name: "b", bucket: "pending", url: "" }] }) }));
  const v1 = { n: 3, until: "any", checks: [["b", "pending:"]], commentIds: ["c1"], deadline: h.now() + 90_000, timeoutMs: 600_000, startedAt: h.now() - 510_000, cwd: "/w" };
  const r = latestWatches(entry([v1], SID, 1), SID);
  assert.equal(r.status, "ok");
  h.w.restore(r);
  assert.equal(h.w.has({ host: "", repo: "", n: 3 }), true);
  await h.settle();
  assert.equal(h.w.size(), 1);
  assert.equal(h.persisted.at(-1)?.[0].state.commentIds[0], "c1");
  assert.equal(h.persisted.at(-1)?.[0].startedAt, h.now() - 510_000);
});

test("restore: a malformed entry and a malformed record each give a lost notice without a number", async () => {
  for (const branch of [entry("not a list"), entry([{ n: "x" }]), entry([{ key: { host: "h" }, cwd: "/w", startedAt: 1, state: {} }]), [{ type: "custom", customType: PRWATCH_ENTRY, data: "junk" }], entry([], "")]) {
    const h = harness(async () => ({ gone: true }));
    h.w.restore(latestWatches(branch, SID));
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].msg.content, /watch lost on restart: /);
    assert.equal(h.sent[0].msg.details.number, undefined);
    assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "lost" }]);
  }
});

test("restore: another session id, no entry, an unknown version are ignored or lost correctly", () => {
  const h = harness(async () => ({ gone: true }));
  const rec = { key: K, cwd: "/w", startedAt: 0, state: { head: "", failedIds: [], ci: "", mergeable: "", commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" } };
  h.w.restore(latestWatches(entry([rec], "other"), SID));
  h.w.restore(latestWatches([], SID));
  assert.equal(latestWatches(entry([rec], SID, 3), SID).status, "malformed");
  assert.equal(h.sent.length, 0);
  assert.equal(h.w.size(), 0);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.timers.length, 0);
});

test("restore: only the latest entry counts", () => {
  const rec = { key: K, cwd: "/w", startedAt: 0, state: { head: "", failedIds: [], ci: "", mergeable: "", commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" } };
  const r = latestWatches([...entry([rec]), ...entry([])], SID);
  assert.deepEqual(r, { status: "ok", watches: [], bad: 0 });
});

test("wiring: a resumed adapter session reports an unreadable watch once, persists v2, and shutdown appends nothing", async (t) => {
  const appended: { type: string; data: Record<string, unknown> }[] = [];
  const sent: { content: string; customType: string }[] = [];
  const sid = "resume-sid";
  const branch = entry([{ n: "x" }], sid);
  const rig = await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => sid, getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
    piExtra: { appendEntry: (type: string, data: Record<string, unknown>) => void appended.push({ type, data }), sendMessage: (m: { content: string; customType: string }) => void sent.push(m) },
  });
  const lost = sent.filter((m) => m.customType === PR_MESSAGE_TYPE);
  assert.equal(lost.length, 1);
  assert.match(lost[0].content, /watch lost on restart: a stored watch is unreadable/);
  const sets = appended.filter((a) => a.type === PRWATCH_ENTRY);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].data, { v: 2, piSessionId: sid, watches: [] });
  assert.deepEqual(rig.events("pr_watch").map((e) => e.outcome), ["lost"]);
  await rig.fire("session_shutdown", {});
  assert.equal(appended.filter((a) => a.type === PRWATCH_ENTRY).length, 1);
});

test("wiring: another session id's entry is ignored by the adapter", async (t) => {
  const sent: { customType: string }[] = [];
  const appended: string[] = [];
  const branch = entry([{ n: "x" }], "someone-else");
  await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => "mine", getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
    piExtra: { appendEntry: (type: string) => void appended.push(type), sendMessage: (m: { customType: string }) => void sent.push(m) },
  });
  assert.equal(sent.filter((m) => m.customType === PR_MESSAGE_TYPE).length, 0);
  assert.equal(appended.filter((a) => a === PRWATCH_ENTRY).length, 0);
});
