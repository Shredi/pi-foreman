// Plan asks-wait-for-owner D5, wired: while the owner is away past the grace, a launch whose child waits on a permission dialog does not hold the
// `subagent` reason of the keep-alive tier (an active run, and a pending foreground launch alike); a launch that works keeps it. The same ask-less
// launch is the control. Presence is stubbed as away since long ago; a tiny budgetShare makes the first warm refuse and the `keepalive skipped
// budget` record names the tier that held (polled, no fixed wait).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { writeChildAsk } from "../childask.ts";
import { Presence } from "../presence.ts";
import { BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 15000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}

const ROLES = ["explorer", "builder", "reviewer"];
const config = {
  providers: {
    fake: { roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) },
    pa: { roles: { ...Object.fromEntries(ROLES.map((r) => [r, { model: `pa/${r}-m` }])), foreman: { model: "pa/big" } }, cache: { ttlSeconds: 11, billing: "token", keepalive: { enabled: true, budgetShare: 0.01, compactMinTokens: 0 }, warmCompact: false } },
  },
};
const registry = { find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }), getProviderAuthStatus: () => ({ configured: true }) };
const FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", cause: "no rule matches", reason: "r", inputHash: "h1" };

async function rig(t: T) {
  t.after(() => mock.restoreAll());
  mock.method(Presence.prototype, "away", () => true);
  mock.method(Presence.prototype, "awaySince", () => Date.now() - 60 * 60_000);
  mock.method(Presence.prototype, "enabled", () => true);
  mock.method(Presence.prototype, "sample", () => null);
  mock.method(Presence.prototype, "refresh", async () => undefined);
  mock.method(Presence.prototype, "armBefore", () => undefined);
  let shown = 0;
  const ui = { notify: () => undefined, confirm: async () => false, select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((res) => { shown += 1; opts?.signal?.addEventListener("abort", () => res(undefined), { once: true }); }), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, {
    config,
    ctx: { ui, model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 }, modelRegistry: registry, isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }) },
  });
  await r.fire("agent_start", {});
  await r.fire("context_with_system", { messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }, { role: "user", content: "hi" }] });
  const answered = () => r.fire("message_end", { message: { role: "assistant", provider: "pa", model: "big", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 } } });
  await answered();
  const launch = async () => {
    const input: Record<string, unknown> = { agent: "builder", task: "go" };
    const { id } = await r.launch(input);
    const b = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
    return { id, input, askDir: b.askDir as string, launchId: b.launchId as string };
  };
  const ask = async (askDir: string, launchId: string) => {
    const before = shown;
    writeChildAsk(askDir, { ...FIELDS, run: launchId });
    await until(() => shown === before + 1);
  };
  const tier = async (): Promise<Record<string, unknown>> => {
    await answered(); // the launching request's own end (its message_end ran before the launch)
    await r.fire("agent_settled", {});
    return until(() => r.events("keepalive").find((e) => e.outcome === "skipped" && e.reason === "budget")).catch((e: Error) => { throw new Error(`${e.message} ${JSON.stringify(r.events("keepalive"))}`); });
  };
  return { ...r, launch, ask, tier };
}

test("away: a run that waits on its ask does not hold the subagent reason", async (t) => {
  const r = await rig(t);
  const l = await r.launch();
  await r.started(l.id, l.input, "run-1");
  await r.ask(l.askDir, l.launchId);
  const hit = await r.tier();
  assert.deepEqual([hit.tier, hit.activity, hit.presence], ["quarter", "idle", "away"]);
});

test("away: a run without an open ask holds the half tier (control)", async (t) => {
  const r = await rig(t);
  const l = await r.launch();
  await r.started(l.id, l.input, "run-1");
  const hit = await r.tier();
  assert.deepEqual([hit.tier, hit.activity], ["half", "subagent"]);
});

test("away: a pending foreground launch whose child waits on its ask does not hold the subagent reason", async (t) => {
  const r = await rig(t);
  const l = await r.launch(); // no tool result yet: the launch stays pending
  await r.ask(l.askDir, l.launchId);
  const hit = await r.tier();
  assert.deepEqual([hit.tier, hit.activity, hit.presence], ["quarter", "idle", "away"]);
});

test("away: a waiting launch beside a working one keeps the half tier", async (t) => {
  const r = await rig(t);
  const a = await r.launch();
  await r.started(a.id, a.input, "run-1");
  await r.ask(a.askDir, a.launchId);
  const b = await r.launch();
  await r.started(b.id, b.input, "run-2");
  const hit = await r.tier();
  assert.deepEqual([hit.tier, hit.activity], ["half", "subagent"]);
});
