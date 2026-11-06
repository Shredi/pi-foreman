// The real adapter's activity signals (running turn, subagent runs, in-flight question or command) reach the self-warm's tier choice.
// A 11 s TTL makes the settle check land after settleGraceMs(11) (2.75 s); a tiny budgetShare refuses the first warm, and the
// `keepalive skipped budget` record names the tier that held at its due time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { settleGraceMs } from "../selfwarm.ts";

const ROLES = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `pa/${r}-m` }]));
const config = { providers: { pa: { roles: { ...ROLES, foreman: { model: "pa/big" } }, cache: { ttlSeconds: 11, billing: "token", keepalive: { enabled: true, budgetShare: 0.01, compactMinTokens: 0 }, warmCompact: false } } } };
const registry = { find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }), getProviderAuthStatus: () => ({ configured: true }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rig = Awaited<ReturnType<typeof r11Rig>>;

async function settled(t: Parameters<typeof r11Rig>[0], idle: () => boolean = () => true): Promise<Rig> {
  const r = await r11Rig(t, {}, {
    config,
    ctx: { model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 }, modelRegistry: registry, isIdle: idle, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }) },
  });
  await r.fire("agent_start", {});
  await r.fire("context_with_system", { messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }, { role: "user", content: "hi" }] });
  await answered(r);
  return r;
}

/** A real request ends with a usage line: the budget has a prompt size. */
const answered = (r: Rig) => r.fire("message_end", { message: { role: "assistant", provider: "pa", model: "big", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 } } });

const tierOf = async (r: Rig): Promise<unknown> => {
  await r.fire("agent_settled", {});
  await sleep(settleGraceMs(11) + 1500);
  const hit = r.events("keepalive").find((e) => e.outcome === "skipped" && e.reason === "budget");
  assert.ok(hit, JSON.stringify(r.events("keepalive")));
  return hit.tier;
};

test("a settled owner with nothing running: the quarter tier", async (t) => {
  assert.equal(await tierOf(await settled(t)), "quarter");
});

test("a running subagent (activeRuns) holds the half tier", async (t) => {
  const r = await settled(t);
  const input = { agent: "builder", task: "x" };
  const l = await r.launch(input);
  await r.started(l.id, input, "run-1");
  await answered(r); // the launching request's own end (its message_end ran before the run started)
  assert.equal(await tierOf(r), "half");
});

test("a turn that is still running (ctx not idle) holds the half tier", async (t) => {
  let idle = true;
  const r = await settled(t, () => idle);
  idle = false;
  assert.equal(await tierOf(r), "half");
});

test("an ask_user_question call in flight holds the half tier", async (t) => {
  const r = await settled(t);
  await r.call("ask_user_question", { questions: [] });
  assert.equal(await tierOf(r), "half");
});
