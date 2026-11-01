// Idle rung gates (idle-router PR A): while the foreman is downshifted to a rung of another provider, the child role map,
// foreman_session_open and the doctor still judge the BASE model; a manual /model re-keys them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { defaultSpawner } from "../spawn.ts";

const A = { provider: "pa", id: "big" };
const B = { provider: "pb", id: "small" };
const ROLES = (p: string) => Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `${p}/${r}-m` }]));

const config = {
  providers: {
    pa: {
      roles: { ...ROLES("pa"), foreman: { model: "pa/big", idle: { model: "pb/small", thinking: "low" } } },
      cache: { ttlSeconds: 300, billing: "token" },
      ranks: [{ match: "big", tier: 2 }, { match: "top", tier: 1 }, { match: "*-m", tier: 3 }],
    },
    pb: { roles: ROLES("pb"), cache: { ttlSeconds: 1800, billing: "token" }, ranks: [{ match: "small", tier: 3 }, { match: "picked", tier: 2 }, { match: "*-m", tier: 3 }] },
  },
};

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, s: undefined, u: undefined, ctx: unknown) => Promise<{ content?: { text?: string }[] }> };

async function rig(t: Parameters<typeof r11Rig>[0], over: { config?: Record<string, unknown>; cfgIdle?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
  const notes: string[] = [];
  const spawned: string[][] = [];
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  const r = await r11Rig(t, {}, {
    config: over.config ?? config,
    ctx: { model: { ...A }, modelRegistry: reg, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (tool: Tool) => void tools.set(tool.name, tool),
      registerCommand: (n: string, c: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, c),
      appendEntry: () => undefined,
    },
    deps: {
      piVersion: async () => "1.4.0",
      spawner: (cmd: string, args: string[], o: never) => (args.some((a) => a.endsWith("foreman_session.py")) ? (spawned.push(args), Promise.resolve({ code: 0, stdout: "handoff: x", stderr: "", timedOut: false })) : defaultSpawner(cmd, args, o)),
    },
  });
  return { ...r, tools, commands, notes, spawned };
}

/** A notice turn on a cold cache: pa/big -> pb/small. */
async function downshift(r: Awaited<ReturnType<typeof rig>>): Promise<void> {
  await r.noticeTurn();
  assert.deepEqual((r.ctx.model as { provider: string; id: string }).provider + "/" + (r.ctx.model as { id: string }).id, "pb/small");
}

test("downshifted: a builder launch keeps the base provider's role map; a manual /model re-keys it", async (t) => {
  const r = await rig(t);
  await downshift(r);
  const input: Record<string, unknown> = { agent: "builder", task: "x" };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.equal(String(input.model).split(":")[0], "pa/builder-m");
  // the user's pick closes the downshift and becomes the base
  r.setModel({ provider: "pb", id: "picked" });
  await r.fire("model_select", { source: "set", model: { provider: "pb", id: "picked" }, previousModel: { provider: "pb", id: "small" } });
  const after: Record<string, unknown> = { agent: "builder", task: "y" };
  await r.launch(after);
  assert.equal(String(after.model).split(":")[0], "pb/builder-m");
});

test("downshifted: foreman_session_open judges and shows the base model", async (t) => {
  const r = await rig(t);
  await downshift(r);
  const open = r.tools.get("foreman_session_open")!;
  const ok = await open.execute("o1", { label: "demo", brief: "b.md", dryRun: true }, undefined, undefined, r.ctx);
  assert.ok(ok);
  const argv = r.spawned[0];
  assert.equal(argv[argv.indexOf("--own-model") + 1], "pa/big");
  // pa/top outranks the base pa/big: refused although the live model pb/small has no ranks
  const refused = await open.execute("o2", { label: "demo", brief: "b.md", model: "pa/top", dryRun: true }, undefined, undefined, r.ctx);
  assert.match(refused.content?.[0]?.text ?? "", /session_rank/);
  assert.equal(r.spawned.length, 1);
});

test("downshifted: the doctor judges the base model's cache and lists the idle rung", async (t) => {
  const r = await rig(t);
  await downshift(r);
  await r.commands.get("foreman")!.handler("doctor", r.ctx);
  const text = r.notes.join("\n");
  assert.doesNotMatch(text, /INFO no providers\.pb\.roles\.foreman\.idle/);
  assert.doesNotMatch(text, /idle rung .* has no cache entry/);
});

test("cache_warming_decision: a self-owned policy answers stop only while no turn runs", async (t) => {
  const sw = { providers: { pa: { roles: ROLES("pa"), cache: { ttlSeconds: 1800, billing: "token", keepalive: { enabled: true } } } } };
  let idle = true;
  const r = await r11Rig(t, {}, {
    config: sw,
    ctx: { model: { provider: "pa", id: "big", api: "openai-responses" }, isIdle: () => idle, hasPendingMessages: () => false },
    piExtra: { getSettings: () => ({ cacheWarming: "idle" }) },
  });
  await r.fire("agent_start", {}); // binds the self-warmer's context
  idle = true;
  assert.deepEqual(await r.fire("cache_warming_decision", {}), { action: "stop" });
  idle = false;
  assert.equal(await r.fire("cache_warming_decision", {}), undefined);
});

test("the doctor warns when the idle rung's provider has no cache entry", async (t) => {
  const noCache = { providers: { ...config.providers, pb: { roles: ROLES("pb") } } };
  const r = await rig(t, { config: noCache });
  await r.commands.get("foreman")!.handler("doctor", r.ctx);
  assert.match(r.notes.join("\n"), /WARN idle rung pb\/small: provider pb has no cache entry/);
});
