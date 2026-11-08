// Review stakes wired into the launch: the rank policy skips an occasion model, still checks the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const ROLES = (p: string) => Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `${p}/${r}-m` }]));
const config = {
  providers: {
    pa: {
      roles: { ...ROLES("pa"), foreman: { model: "pa/mid" } },
      cache: { ttlSeconds: 300, billing: "token" },
      ranks: [{ match: "top", tier: 1 }, { match: "mid", tier: 2 }, { match: "*-m", tier: 3 }],
    },
  },
};

async function rig(t: Parameters<typeof r11Rig>[0], ceremony: Record<string, unknown>, reviewer = "pa/reviewer-m") {
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.providers.pa.roles.reviewer = { model: reviewer };
  return r11Rig(t, ceremony, {
    config: cfg,
    ctx: { model: { provider: "pa", id: "mid" }, modelRegistry: reg, ui: { notify: () => undefined, confirm: async () => false, select: async () => "allow once", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, registerCommand: () => undefined, appendEntry: () => undefined },
    deps: { piVersion: async () => "1.4.0" },
  });
}

test("item 1: an occasion model ranked above the foreman runs, traced policy_override", async (t) => {
  const r = await rig(t, { reviewByOccasion: { "plan-review": { model: "pa/top" } } });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "[plan-review] x" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.equal(String((input.tasks as Record<string, unknown>[])[0].model).split(":")[0], "pa/top");
  assert.deepEqual(r.events("review_occasion").map((e) => [e.model_overridden, e.policy_override]), [[true, true]]);
});

test("item 1: another entry that carries the same model is still rank-checked", async (t) => {
  const r = await rig(t, { reviewByOccasion: { "plan-review": { model: "pa/top" } } }, "pa/top");
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "[plan-review] x" }, { agent: "reviewer", task: "items 1" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, true);
});

test("item 8: highStakes.model on a high-stakes launch is used as set and traced review_stakes", async (t) => {
  const r = await rig(t, { highStakes: { model: "pa/top" } });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "[second-opinion] x" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.deepEqual(r.events("review_stakes").map((e) => [e.reasons, e.model_applied, e.policy_override]), [["occasion", true, true]]);
});

async function reviewEnd(r: Awaited<ReturnType<typeof rig>>, task: string, runId: string): Promise<void> {
  const rev = { agent: "reviewer", task };
  const l = await r.launch(rev);
  await r.started(l.id, rev, runId);
  r.end({ runId, agent: "reviewer", status: "completed", success: true, summary: "1. PASS a.ts:1 fine\nverdict: PASS" });
}

test("risk tags survive a plan-review result and are cleared by an item review", async (t) => {
  const r = await rig(t, { highStakes: { model: "pa/top" } });
  await r.launch({ agent: "builder", task: "build it", risk: ["security"] });
  await reviewEnd(r, "[plan-review] x", "run-p");
  const before = r.events("review_stakes").length;
  await r.launch({ agent: "reviewer", task: "items 1" });
  assert.deepEqual(r.events("review_stakes").slice(before).map((e) => e.tags), ["security"]);
  await reviewEnd(r, "items 1", "run-i");
  const mid = r.events("review_stakes").length;
  await r.launch({ agent: "reviewer", task: "items 1" });
  assert.equal(r.events("review_stakes").length, mid, "the item review cleared the tags");
});

test("a plan-review launches with or without highStakes.model and is traced high stakes by occasion", async (t) => {
  for (const configured of [false, true]) {
    const r = await rig(t, configured ? { highStakes: { model: "pa/top" } } : {});
    const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "[plan-review] x" }] };
    const res = await r.launch(input);
    assert.equal(res.res?.block, undefined, String(res.res?.reason));
    assert.deepEqual(r.events("review_stakes").map((e) => [e.reasons, e.model_applied]), [["occasion", configured]]);
  }
});
