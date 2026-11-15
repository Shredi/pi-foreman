// A design-risk builder entry is rated to the top rung (ladder.sizing.topRung). When the rank policy refuses the climb to the strong rung and the harness
// skips it, the entry stays on its normal model: the top rung is written only into an entry whose climb was not skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

// under policy `below` the foreman (tier 2) launches tiers above 2 only; a non-monotone map has the top rung pass while the strong rung does not
// `foreman2` (tier 1, above the foreman at tier 2) launches the strong rung too: one rig serves both cases, the session model switched between the launches
async function rig(t: Parameters<typeof r11Rig>[0]) {
  const ranks = [{ match: "foreman2", tier: 1 }, { match: "foreman", tier: 2 }, { match: "strong", tier: 2 }, { match: "top", tier: 5 }, { match: "*", tier: 5 }];
  const roles = {
    explorer: { model: "fake/explorer" },
    reviewer: { model: "fake/reviewer" },
    builder: { model: "fake/builder", strong: { model: "fake/strong" } },
  };
  const ctx = { ...reviewAllowOpts().ctx, model: { provider: "fake", id: "foreman" } };
  return r11Rig(t, { default: "standard" }, { ctx, config: { providers: { fake: { review: { model: "m" }, roles, ranks } }, ladder: { sizing: { topRung: "fake/top" } } } });
}
const design = (): Record<string, unknown> => ({ agent: "builder", task: "build it", risk: ["design"] });

test("a skipped design entry stays on its normal model although a top rung is configured and allowed; one whose climb is allowed still gets the top rung", async (t) => {
  const a = await rig(t);
  const skipped = design(); // the strong rung ties with the foreman: refused, the climb is skipped; the top rung is allowed
  const { res } = await a.launch(skipped);
  assert.equal(res, undefined, res?.reason);
  assert.equal(skipped.model, "fake/builder");
  assert.deepEqual(a.events("launch_refused"), []);
  assert.deepEqual(a.events("rung_top").map((r) => [r.model, r.source]), [["fake/builder", "sizing:risk_top"]]);

  a.setModel({ provider: "fake", id: "foreman2" }); // both rungs allowed
  const climbed = design();
  const second = await a.launch(climbed);
  assert.equal(second.res, undefined, second.res?.reason);
  assert.equal(String(climbed.model).split(":")[0], "fake/top");
  assert.equal(a.events("rung_top").length, 1); // no new rung_top: the first launch's only
});
