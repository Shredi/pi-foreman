// High stakes through the launch wiring: with a self-pair for the foreman, a differing highStakes.model runs.
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

test("a self-pair for the foreman and a differing highStakes.model: the high-stakes launch runs on the high-stakes model", async (t) => {
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  const r = await r11Rig(t, { reviewModel: { "pa/mid": "pa/mid" }, highStakes: { model: "pa/top" } }, {
    config,
    ctx: { model: { provider: "pa", id: "mid" }, modelRegistry: reg, ui: { notify: () => undefined, confirm: async () => false, select: async () => "allow once", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, registerCommand: () => undefined, appendEntry: () => undefined },
    deps: { piVersion: async () => "1.4.0" },
  });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "[second-opinion] x" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.equal(String((input.tasks as Record<string, unknown>[])[0].model).split(":")[0], "pa/top");
  assert.deepEqual(r.events("review_model").map((e) => [e.reason, e.pin]), [["paired_skipped", "occasion"]]);
  assert.deepEqual(r.events("review_stakes").map((e) => e.model_applied), [true]);
});
