// A close refused for an open watched PR changes nothing: pending foreman_waits are not cancelled (ledger 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";

const REFUSED = "pi-foreman: close refused: PR #7 open and watched (merge it, or pr_unwatch)";
const req = { source: "intercom-parent" as const, file: "/x/.workflow/r.md", replyTo: "parent-1" };

function rig(prState: "open" | "merged") {
  const log: string[] = [];
  let waits = [{ id: "w1", kind: "time", note: "n" }];
  let watched = [7];
  let cancelCalls = 0;
  const deps = {
    activeWaits: () => waits,
    cancelWaits: () => (cancelCalls++, waits.splice(0).map((w) => w.id)),
    activeRuns: () => 0,
    sendUserMessage: (t: string) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to: string, t: string) => void log.push(`reply:${to}:${t}`),
    notify: (t: string) => void log.push(`notify:${t}`),
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    watchedPrs: () => watched,
    refreshWatched: async () => {
      if (prState === "merged") watched = [];
    },
  } as unknown as CloseDeps;
  const flow = new CloseFlow(deps);
  return { log, flow, waits: () => waits, cancelCalls: () => cancelCalls };
}

const ctx = { isIdle: () => true };

test("close refused for an open watched PR: waits are not cancelled and no 'cancelled waits' notice", async () => {
  const r = rig("open");
  await r.flow.request(req, ctx);
  assert.ok(r.log.includes(`notify:${REFUSED}`));
  assert.equal(r.cancelCalls(), 0);
  assert.ok(!r.log.some((l) => l.includes("cancelled waits")));
  assert.equal(r.waits().length, 1, "the wait is still there");
});

test("control: PR merged (no watch left): the waits are cancelled as before", async () => {
  const r = rig("merged");
  await r.flow.request(req, ctx);
  assert.equal(r.cancelCalls(), 1);
  assert.ok(r.log.includes("notify:pi-foreman: closing; cancelled waits: w1"));
  assert.equal(r.waits().length, 0);
  assert.ok(!r.log.includes(`notify:${REFUSED}`));
});
