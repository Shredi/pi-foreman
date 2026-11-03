// An inRun close request (before_agent_start of a triggerTurn run) while a PR is watched: the fresh pr_status still runs first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";

const REFUSED = "pi-foreman: close refused: PR #7 open and watched (merge it, or pr_unwatch)";
const req = { source: "intercom-parent" as const, file: "/x/.workflow/r.md", replyTo: "parent-1" };

function rig(state: "open" | "merged") {
  const log: string[] = [];
  let watched = [7];
  let fresh = 0;
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void log.push(`trace:${r.decision}`),
    markCause: () => void log.push("markCause"),
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    watchedPrs: () => watched,
    refreshWatched: async () => {
      fresh++;
      if (state === "merged") watched = [];
    },
  };
  return { log, flow: new CloseFlow(deps), fresh: () => fresh };
}

const ctx = { isIdle: () => false };

test("inRun close while the watched PR is open: fresh lookup, refused, no prompt, flow not active", async () => {
  const r = rig("open");
  const p = r.flow.request(req, ctx, false, true);
  assert.equal(r.flow.active, true, "refreshing");
  await p;
  assert.equal(r.fresh(), 1);
  assert.equal(r.flow.active, false);
  assert.ok(r.log.includes(`reply:parent-1:${REFUSED}`));
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")));
});

test("inRun close once the PR is merged: the run is the close turn, markCause, and no prompt is sent", async () => {
  const r = rig("merged");
  await r.flow.request(req, ctx, false, true);
  assert.equal(r.fresh(), 1);
  assert.equal(r.flow.active, true);
  assert.ok(r.log.includes("markCause"));
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")));
});
