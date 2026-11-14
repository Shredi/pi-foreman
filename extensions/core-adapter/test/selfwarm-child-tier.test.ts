// A child session (PI_SUBAGENT_CHILD) is wired like the parent: its running turn holds the half tier, an idle child the quarter tier,
// with no presence probe (the owner counts as present). Same rig as warmtiers-wiring.test.ts: an 11 s TTL and a tiny budgetShare make the
// first warm refuse, and the `keepalive skipped budget` record names the tier that held.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { settleGraceMs, AWAY_GRACE_MS, SelfWarm, type WarmSignals } from "../selfwarm.ts";
import type { Presence } from "../presence.ts";

const ROLES = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `pa/${r}-m` }]));
const config = { providers: { pa: { roles: { ...ROLES, foreman: { model: "pa/big" } }, cache: { ttlSeconds: 11, billing: "token", keepalive: { enabled: true, budgetShare: 0.01, compactMinTokens: 0 }, warmCompact: false } } } };
const registry = { find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }), getProviderAuthStatus: () => ({ configured: true }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rig = Awaited<ReturnType<typeof r11Rig>>;

async function childRig(t: Parameters<typeof r11Rig>[0], idle: () => boolean): Promise<Rig> {
  const r = await r11Rig(t, {}, {
    child: true,
    config,
    ctx: { model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 }, modelRegistry: registry, isIdle: idle, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }) },
  });
  await r.fire("agent_start", {});
  await r.fire("context_with_system", { messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }, { role: "user", content: "hi" }] });
  await r.fire("message_end", { message: { role: "assistant", provider: "pa", model: "big", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 } } });
  return r;
}

const skipped = async (r: Rig): Promise<Record<string, unknown>> => {
  await r.fire("agent_settled", {});
  await sleep(settleGraceMs(11) + 1500);
  const hit = r.events("keepalive").find((e) => e.outcome === "skipped" && e.reason === "budget");
  assert.ok(hit, JSON.stringify(r.events("keepalive")));
  return hit;
};

test("a child whose turn is running (ctx not idle) holds the half tier, reason turn", async (t) => {
  let idle = true;
  const r = await childRig(t, () => idle);
  idle = false;
  const hit = await skipped(r);
  assert.equal(hit.tier, "half");
  assert.equal(hit.activity, "turn");
  assert.equal(hit.presence, "present");
});

test("an idle child holds the quarter tier, reason idle, presence present", async (t) => {
  const r = await childRig(t, () => true);
  const hit = await skipped(r);
  assert.equal(hit.tier, "quarter");
  assert.equal(hit.activity, "idle");
  assert.equal(hit.presence, "present");
});

// plan asks-wait-for-owner D5: the wait on the parent's ruling is the signal (a child cannot see presence); decided at a given time, no clock
function childWarm(sig: () => WarmSignals): SelfWarm {
  const never = (): never => {
    throw new Error("not used");
  };
  return new SelfWarm({
    now: () => 0, isChild: true, policy: () => null, presence: {} as Presence, signals: sig, queued: () => false, rates: () => null, compact: () => null,
    trace: () => undefined, replayable: () => true, replay: never, record: () => null,
  });
}
const RUNNING: WarmSignals = { strongA: null, turn: true, question: false, dialog: false, command: false };

test("a child blocked on its parent's ruling: half before the wait has lasted the grace, quarter from then on", () => {
  const since = 5_000_000;
  const sw = childWarm(() => ({ ...RUNNING, parentWaitSince: since }));
  const before = sw.tierAt(since + AWAY_GRACE_MS - 1);
  assert.deepEqual([before.tier, before.reason, before.presence], ["half", "turn", "present"]);
  const after = sw.tierAt(since + AWAY_GRACE_MS);
  assert.deepEqual([after.tier, after.reason, after.presence], ["quarter", "idle", "present"]);
});

test("a child whose turn runs without a wait on its parent stays at half however late", () => {
  const sw = childWarm(() => ({ ...RUNNING, parentWaitSince: null }));
  assert.equal(sw.tierAt(10 * AWAY_GRACE_MS).tier, "half");
  const none = childWarm(() => RUNNING);
  assert.equal(none.tierAt(10 * AWAY_GRACE_MS).tier, "half");
});
