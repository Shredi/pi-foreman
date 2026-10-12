import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";

type W = { id: string; kind: string; note: string };

function rig(waits: W[], runs = 0, cancel = true) {
  const log: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const pending = [...waits];
  const deps: CloseDeps = {
    activeWaits: () => pending,
    activeRuns: () => runs,
    ...(cancel ? { cancelWaits: () => (log.push("cancelWaits"), pending.splice(0).map((w) => w.id)) } : {}),
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void traces.push(r),
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => false,
    setTimer: () => () => undefined,
  };
  return { log, traces, flow: new CloseFlow(deps), ctx: { isIdle: () => true, shutdown: () => undefined } };
}

test("close: a pending own wait is cancelled and the close is accepted", () => {
  const r = rig([{ id: "w1", kind: "child", note: "p1" }, { id: "w2", kind: "timer", note: "" }]);
  r.flow.request({ source: "herdr", file: "/x/r.md" }, r.ctx);
  assert.ok(r.log.includes("cancelWaits"));
  assert.equal(r.flow.active, true);
  assert.ok(r.log.some((l) => l.startsWith("notify:") && l.includes("cancelled waits: w1, w2")));
  assert.ok(r.log.some((l) => l.startsWith("prompt:")));
  assert.deepEqual(r.traces.map((t) => t.decision ?? t.event), ["waits_cancelled", "accepted", "turn"]);
  const t = r.traces[0];
  assert.equal(t.count, 2);
  assert.equal(t.note, 'w1 child "p1", w2 timer');
});

test("close: an active child run still refuses before any wait is cancelled", () => {
  const r = rig([{ id: "w1", kind: "timer", note: "" }], 1);
  r.flow.request({ source: "herdr", file: "/x/r.md" }, r.ctx);
  assert.equal(r.flow.active, false);
  assert.ok(!r.log.includes("cancelWaits"));
  assert.ok(r.log.some((l) => l.includes("1 child run(s) still active")));
});

test("close: without cancelWaits a pending wait still refuses", () => {
  const r = rig([{ id: "w1", kind: "timer", note: "ci" }], 0, false);
  r.flow.request({ source: "herdr", file: "/x/r.md" }, r.ctx);
  assert.equal(r.flow.active, false);
  assert.ok(r.log.some((l) => l.includes("1 foreman_wait pending")));
});
