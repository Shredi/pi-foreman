// More real adapter signals into the self-warm's tier choice (warmtiers-wiring.test.ts has the first set): a foreman_wait, a foreman_bg
// wait, a bg_run add-on task, an open dialog (live-state blocker) and a bash command in flight. Same rig: an 11 s TTL and a tiny
// budgetShare make the first warm refuse, and the `keepalive skipped budget` record names the tier that held and its activity reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { settleGraceMs } from "../selfwarm.ts";

const ROLES = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `pa/${r}-m` }]));
const config = { providers: { pa: { roles: { ...ROLES, foreman: { model: "pa/big" } }, cache: { ttlSeconds: 11, billing: "token", keepalive: { enabled: true, budgetShare: 0.01, compactMinTokens: 0 }, warmCompact: false } } } };
const registry = { find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }), getProviderAuthStatus: () => ({ configured: true }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rig = Awaited<ReturnType<typeof r11Rig>>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

async function settled(t: Parameters<typeof r11Rig>[0], tools: Map<string, Tool> = new Map()): Promise<Rig> {
  const r = await r11Rig(t, {}, {
    config,
    piExtra: { registerTool: (tool: Tool) => void tools.set(tool.name, tool) },
    ctx: { model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 }, modelRegistry: registry, isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }) },
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

test("a foreman_wait (timer) holds the half tier, reason wait", async (t) => {
  const tools = new Map<string, Tool>();
  const r = await settled(t, tools);
  const wait = tools.get("foreman_wait");
  assert.ok(wait, "foreman_wait is registered");
  const res = await wait.execute("c1", { action: "start", kind: "timer", seconds: 600, note: "hold" }, undefined, undefined, r.ctx);
  assert.ok(!res.isError, res.content[0].text);
  const hit = await skipped(r);
  assert.equal(hit.tier, "half");
  assert.equal(hit.activity, "wait");
  await wait.execute("c2", { action: "cancel", id: String(res.details.id) }, undefined, undefined, r.ctx);
});

test("a foreman_bg wait holds the half tier, reason bg_task", async (t) => {
  const tools = new Map<string, Tool>();
  const r = await settled(t, tools);
  const bg = tools.get("foreman_bg");
  assert.ok(bg, "foreman_bg is registered");
  const res = await bg.execute("c1", { command: `node -e "setTimeout(()=>{},9000)"`, note: "slow" }, undefined, undefined, r.ctx);
  assert.ok(!res.isError, res.content[0].text);
  const pid = Number(res.details.pid);
  try {
    const hit = await skipped(r);
    assert.equal(hit.tier, "half");
    assert.equal(hit.activity, "bg_task");
  } finally {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
});

test("a running bg_run add-on task (readOwnAddonTasks) holds the half tier, reason bg_task", async (t) => {
  const r = await settled(t);
  const dir = path.join(r.project, ".pi", "tasks", `${r.sessionId}-4242`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t1.json"), JSON.stringify({ id: "t1", status: "running", name: "build", startTime: Date.now() }));
  const hit = await skipped(r);
  assert.equal(hit.tier, "half");
  assert.equal(hit.activity, "bg_task");
});

test("an open dialog (live-state blocker) holds the half tier, reason dialog", async (t) => {
  const r = await settled(t);
  await r.fire("ui_prompt_start", {});
  const hit = await skipped(r);
  assert.equal(hit.tier, "half");
  assert.equal(hit.activity, "dialog");
});

test("a bash command in flight holds the half tier, reason command", async (t) => {
  const r = await settled(t);
  await r.call("bash", { command: "echo hi" });
  const hit = await skipped(r);
  assert.equal(hit.tier, "half");
  assert.equal(hit.activity, "command");
});

test("with none of the signals the same rig holds the quarter tier, reason idle", async (t) => {
  const hit = await skipped(await settled(t));
  assert.equal(hit.tier, "quarter");
  assert.equal(hit.activity, "idle");
});
