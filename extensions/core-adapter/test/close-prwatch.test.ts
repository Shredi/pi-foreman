// Close refusal while a watched PR is open (ledger 2): fresh pr_status first, phase `refreshing`, no watch = synchronous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, closePrompt } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prtrack.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const snap = (): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [], status: {} });
const REFUSED = "pi-foreman: close refused: PR #7 open and watched (merge it, or pr_unwatch)";

/** A real PrWatches (fake timers, a controllable pr_status) wired into a CloseFlow like index.ts does. */
function rig(opts: { fresh?: () => Promise<"open" | "merged" | "closed" | "unknown"> } = {}) {
  const log: string[] = [];
  const timers: Timers = { set: () => 0, clear: () => undefined };
  let freshCalls = 0;
  const watches = new PrWatches({
    poll: async () => ({ snap: snap() }),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers,
    fresh: async () => (freshCalls++, opts.fresh ? opts.fresh() : "open"),
  });
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void log.push(`trace:${r.decision}`),
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    watchedPrs: () => watches.numbers(),
    refreshWatched: () => watches.refresh(),
  };
  let idle = true;
  const ctx = { isIdle: () => idle, shutdown: () => void log.push("shutdown") };
  return { log, watches, flow: new CloseFlow(deps), ctx, freshCalls: () => freshCalls, setIdle: (v: boolean) => void (idle = v) };
}

const req = { source: "intercom-parent" as const, file: "/x/.workflow/r.md", replyTo: "parent-1" };

test("close: refused while a watched PR is open; the parent gets the refusal; nothing is sent to the model", async () => {
  const r = rig();
  r.watches.start(K, snap());
  await r.flow.request(req, r.ctx, true);
  assert.equal(r.flow.active, false);
  assert.ok(r.log.includes(`notify:${REFUSED}`));
  assert.ok(r.log.includes(`reply:parent-1:${REFUSED}`));
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")));
  assert.equal(r.freshCalls(), 1, "one fresh pr_status for the one watched PR");
  assert.equal(r.watches.has(K), true, "the watch stays armed");
});

test("close: allowed once the PR is merged or closed (fresh pr_status ends the watch without a message), or after pr_unwatch", async () => {
  for (const state of ["merged", "closed"] as const) {
    const r = rig({ fresh: async () => state });
    r.watches.start(K, snap());
    await r.flow.request(req, r.ctx);
    assert.equal(r.watches.has(K), false, state);
    assert.equal(r.flow.active, true, state);
    assert.ok(r.log.includes(`prompt:${closePrompt("/x/.workflow/r.md")}`), state);
  }
  const u = rig();
  u.watches.start(K, snap());
  u.watches.unwatch(7);
  await u.flow.request(req, u.ctx);
  assert.equal(u.flow.active, true);
  assert.equal(u.freshCalls(), 0, "no watch, no lookup");
});

test("close: a PR merged since the last tick does not refuse (the fresh pr_status sees it); a failed lookup keeps the refusal", async () => {
  const r = rig({ fresh: async () => "merged" });
  r.watches.start(K, snap());
  await r.flow.request(req, r.ctx);
  assert.ok(!r.log.some((l) => l.includes("close refused")));
  const f = rig({ fresh: async () => { throw new Error("offline"); } });
  f.watches.start(K, snap());
  await f.flow.request(req, f.ctx);
  assert.ok(f.log.includes(`notify:${REFUSED}`));
});

test("close: two closes during the refresh: the second is refused as in progress", async () => {
  let release: () => void = () => undefined;
  const r = rig({ fresh: () => new Promise((res) => (release = () => res("merged"))) });
  r.watches.start(K, snap());
  const first = r.flow.request(req, r.ctx);
  assert.equal(r.flow.active, true, "phase refreshing counts as active");
  const second = r.flow.request({ source: "herdr", file: "/x/.workflow/r.md" }, r.ctx);
  assert.equal(second, undefined, "refused synchronously");
  assert.ok(r.log.includes("notify:pi-foreman: close refused: a close is already in progress"));
  release();
  await first;
  assert.equal(r.log.filter((l) => l.startsWith("prompt:")).length, 1);
});

test("close: with no watch the request stays synchronous (no promise, the prompt is sent at once)", () => {
  const r = rig();
  const ret = r.flow.request(req, r.ctx);
  assert.equal(ret, undefined);
  assert.ok(r.log.includes(`prompt:${closePrompt("/x/.workflow/r.md")}`));
});

test("close: a busy session refreshes again when it turns idle (closeTurn), and a PR opened meanwhile still refuses", async () => {
  const r = rig({ fresh: async () => "open" });
  r.setIdle(false);
  await r.flow.request(req, r.ctx); // no watch yet: accepted, waits for idle
  r.watches.start(K, snap());
  r.setIdle(true);
  await r.flow.onSettled(r.ctx);
  assert.equal(r.freshCalls(), 1);
  assert.ok(r.log.includes(`notify:${REFUSED}`));
  assert.equal(r.flow.active, false);
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")));
});
