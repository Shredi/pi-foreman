// pi-subagents 0.89: the parent wake is a custom run (`sendMessage(..., { triggerTurn: true })`, no wake text, no `input` event). The adapter
// classifies it by the custom message type, runs the trailing catch-up at each custom `message_end`, and a wake never counts as the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_MESSAGE_TYPES, causeOfCustom } from "../usage.ts";
import { userPromptOf } from "../review.ts";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig } from "./_r11rig.ts";
import { world } from "./_r46world.ts";
import { loopRefused, stopLoop } from "./_loopstop.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;

/** One custom run as Pi 1.5 runs it with no `input`: before_agent_start, message_end of the custom message, agent_start, agent_end. */
async function wakeRun(r: Rig, message: Record<string, unknown>): Promise<unknown> {
  await r.fire("before_agent_start", { messageType: "custom", message, systemPrompt: "", systemPromptOptions: { sections: {} } });
  const out = await r.fire("message_end", { message });
  await r.fire("agent_start", {});
  await r.fire("agent_end", {});
  return out;
}
const custom = (customType: string, content = "update", details: unknown = {}) => ({ role: "custom", customType, content, details });
const causes = (r: Rig): unknown[] => r.events("turn").map((e) => e.cause);

for (const type of ["subagent_control_notice", "subagent_steering_notice", "subagent-compaction-resume", "subagent-notify"]) {
  test(`0.89 wake: a custom ${type} run has the turn cause child`, async (t) => {
    const r = await r11Rig(t);
    assert.equal(causeOfCustom(type), "child");
    await wakeRun(r, custom(type));
    assert.deepEqual(causes(r), ["child"]);
  });
}

test("0.89 wake: subagent_watchdog_clarification is no child message (cause other)", async (t) => {
  const r = await r11Rig(t);
  assert.equal(CHILD_MESSAGE_TYPES.includes("subagent_watchdog_clarification"), false);
  assert.equal(causeOfCustom("subagent_watchdog_clarification"), null);
  await wakeRun(r, custom("subagent_watchdog_clarification"));
  assert.deepEqual(causes(r), ["other"]);
});

test("0.89 wake: the idle model treats a steering or control wake as a child wake, a watchdog run is left alone", async (t) => {
  const roles = ["explorer", "builder", "reviewer"];
  const mk = (p: string) => Object.fromEntries(roles.map((x) => [x, { model: `${p}/${x}-m` }]));
  const config = {
    providers: {
      pa: { roles: { ...mk("pa"), foreman: { model: "pa/big", idle: { model: "pb/small", thinking: "low" } } }, cache: { ttlSeconds: 300, billing: "token" }, ranks: [{ match: "big", tier: 2 }, { match: "*-m", tier: 3 }] },
      pb: { roles: mk("pb"), cache: { ttlSeconds: 1800, billing: "token" }, ranks: [{ match: "small", tier: 3 }, { match: "*-m", tier: 3 }] },
    },
  };
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  const modelOf = (r: Rig): string => `${(r.ctx.model as { provider: string }).provider}/${(r.ctx.model as { id: string }).id}`;
  const make = (): Promise<Rig> => r11Rig(t, {}, { config, ctx: { model: { provider: "pa", id: "big" }, modelRegistry: reg }, piExtra: { appendEntry: () => undefined }, deps: { piVersion: async () => "1.5.0" } });
  for (const [type, after] of [["subagent_steering_notice", "pb/small"], ["subagent_control_notice", "pb/small"], ["subagent-compaction-resume", "pb/small"], ["subagent_watchdog_clarification", "pa/big"]]) {
    const r = await make();
    assert.equal(modelOf(r), "pa/big");
    await r.noticeTurn(type);
    assert.equal(modelOf(r), after, type);
  }
});

test("0.89 wake: a subagent-notify custom run lifts no [review_loop] stop", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.ok(loopRefused(await a.launch("builder")), "the stop is set");
  const msg = custom("subagent-notify", "Background task completed: **builder**");
  await a.fire("before_agent_start", { messageType: "custom", message: msg, systemPrompt: "", systemPromptOptions: { sections: {} } });
  await a.fire("message_end", { message: msg });
  await a.fire("agent_start", {});
  await a.fire("agent_end", {});
  assert.ok(loopRefused(await a.launch("builder")), "the wake did not lift the stop");
  assert.equal((await w.traceEvents()).filter((e) => e.event === "chain_clear" || e.event === "cap_reset").length, 0);
});

test("0.89 wake: a subagent-notify custom run resets no finish-refusal count", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n");
  const settle = (): Promise<unknown> => a.fire("agent_before_settle", { outcome: "completed", entries: [] });
  const count = async (name: string): Promise<number> => (await w.traceEvents()).filter((e) => e.event === name).length;
  await settle();
  await settle();
  assert.equal(await count("finish_refused"), 2);
  const msg = custom("subagent-notify", "Background task completed: **builder**");
  await a.fire("before_agent_start", { messageType: "custom", message: msg, systemPrompt: "", systemPromptOptions: { sections: {} } });
  await a.fire("message_end", { message: msg });
  await settle();
  assert.equal(await count("finish_refused"), 2, "no third refusal: the count was not reset");
  assert.equal(await count("ceremony_incomplete"), 1);
});

test("0.89 wake: a subagent-notify custom run resets no read budget", async (t) => {
  const r = await r11Rig(t);
  const warn = DEFAULT_READ_LIMITS.before.warn;
  const reminds = (): number => r.events("read_budget").filter((e) => e.action === "remind").length;
  for (let i = 0; i < warn - 1; i++) await r.call("grep", { pattern: `src${i}`, path: "src" });
  assert.equal(reminds(), 0);
  await wakeRun(r, custom("subagent-notify", "Background task completed: **builder**"));
  for (let i = 0; i < 2; i++) await r.call("grep", { pattern: `more${i}`, path: "src" });
  assert.equal(reminds(), 1, "the count carried over the wake, so the reminder fires");
});

test("0.89 wake: a notice held without a turn is caught up at the next custom message_end", async (t) => {
  const r = await r11Rig(t);
  const held = { type: "custom_message", id: "h1", customType: "subagent_supervisor_request", content: "ask", details: { id: "q1", requestId: "q1", runId: "run-held", agent: "explorer", expectsReply: true, requestBody: "please" } };
  const branch: unknown[] = [{ type: "message", id: "m0", message: { role: "assistant" } }, held];
  Object.assign(r.ctx.sessionManager, { getBranch: () => branch });
  assert.equal(r.events("supervisor_request").length, 0);
  // the compaction resume is a custom run, not an input: the held request still reaches the adapter
  await wakeRun(r, custom("subagent-compaction-resume", "resume"));
  assert.equal(r.events("supervisor_request").length, 1);
  // handled once: the next custom message_end does not handle it again
  await wakeRun(r, custom("subagent-compaction-resume", "resume again"));
  assert.equal(r.events("supervisor_request").length, 1);
});

test("0.89 wake: a stale-only control notice wake shows no notice text and runs as a child turn", async (t) => {
  const r = await r11Rig(t);
  r.channel("subagent:async-complete", { runId: "run-ended", agent: "builder", status: "completed", success: true, summary: "done" });
  const notice = custom("subagent_control_notice", "tool 'bash' open for 240s", { event: { type: "needs_attention", reason: "tool_open_threshold", runId: "run-ended", toolCallId: "c1" } });
  const out = (await wakeRun(r, notice)) as { message?: { display?: boolean } } | undefined;
  assert.equal(out?.message?.display, false);
  assert.deepEqual(causes(r), ["child"]);
});

test("userPromptOf on a custom run (a 0.89 wake) is null", () => {
  assert.equal(userPromptOf({ messageType: "custom", message: custom("subagent-notify") }), null);
  assert.equal(userPromptOf({ messageType: "custom", prompt: "typed" }), null);
});
