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
  const input: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x" };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.equal(String(input.model).split(":")[0], "pa/top");
  assert.deepEqual(r.events("review_occasion").map((e) => [e.model_overridden, e.policy_override]), [[true, true]]);
});

// a reviewer never launches inside a group, so the other launch is a single one of the same role: the skip belongs to the occasion model only
test("item 1: another launch that carries the same model is still rank-checked", async (t) => {
  const r = await rig(t, { reviewByOccasion: { "plan-review": { model: "pa/top" } } }, "pa/top");
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1" };
  const res = await r.launch(input);
  assert.equal(res.res?.block, true);
});

test("a plan-review or second-opinion keeps its mapped model with highStakes.model set (the key replaces no other review's model)", async (t) => {
  for (const task of ["[plan-review] x", "[second-opinion] x"]) {
    const r = await rig(t, { highStakes: { model: "pa/top" } });
    const input: Record<string, unknown> = { agent: "reviewer", task };
    const res = await r.launch(input);
    assert.equal(res.res?.block, undefined, String(res.res?.reason));
    assert.equal(String(input.model).split(":")[0], "pa/reviewer-m");
    assert.deepEqual(r.events("review_stakes"), []);
  }
});
