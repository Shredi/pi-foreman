// Reviewer pairs wired into the launch (idle-router PR B): the review rule judges the live model, the rank checks the base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const ROLES = (p: string) => Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `${p}/${r}-m`, ...(r === "reviewer" ? { strong: { model: `${p}/reviewer-s` } } : {}) }]));

const config = {
  ladder: { reviewerClimb: { enabled: true } },
  providers: {
    pa: {
      roles: { ...ROLES("pa"), foreman: { model: "pa/big", idle: { model: "pb/small", thinking: "low" } } },
      cache: { ttlSeconds: 300, billing: "token" },
      ranks: [{ match: "big", tier: 2 }, { match: "top", tier: 1 }, { match: "*-m", tier: 3 }, { match: "*-s", tier: 3 }],
    },
    pb: { roles: ROLES("pb"), cache: { ttlSeconds: 1800, billing: "token" }, ranks: [{ match: "small", tier: 3 }, { match: "*-m", tier: 3 }] },
  },
};

async function rig(t: Parameters<typeof r11Rig>[0], reviewModel: unknown, model: { provider: string; id: string } | undefined, ceremony: Record<string, unknown> = {}) {
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  return r11Rig(t, { reviewModel, ...ceremony }, {
    config,
    ctx: { model, modelRegistry: reg, ui: { notify: () => undefined, confirm: async () => false, select: async () => "allow once", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, registerCommand: () => undefined, appendEntry: () => undefined },
    deps: { piVersion: async () => "1.4.0" },
  });
}

const models = (input: Record<string, unknown>): unknown[] => (input.tasks as Record<string, unknown>[]).map((e) => String(e.model).split(":")[0]);

test("a reviewer launched from a downshifted turn gets the pair of the live model; a builder in the same launch is unchanged", async (t) => {
  const r = await rig(t, { "pb/small": "pa/big:high" }, { provider: "pa", id: "big" });
  await r.noticeTurn();
  assert.equal(`${(r.ctx.model as { provider: string }).provider}/${(r.ctx.model as { id: string }).id}`, "pb/small");
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "items 1" }, { agent: "builder", task: "x" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  // the pair is written after the rank check, which judged the base pa/big: pa/big is not refused as its own reviewer
  assert.deepEqual(models(input), ["pa/big", "pa/builder-m"]);
  assert.deepEqual(r.events("review_model").map((e) => [e.from, e.to, e.reason]), [["pa/reviewer-m", "pa/big", "paired"]]);
});

test("a live model without a pair leaves the reviewer on the role map", async (t) => {
  const r = await rig(t, { "pb/small": "pa/big" }, { provider: "pa", id: "big" });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "items 1" }] };
  await r.launch(input);
  assert.deepEqual(models(input), ["pa/reviewer-m"]);
  assert.deepEqual(r.events("review_model"), []);
});

test("explicit pins: a honoured launch model is kept (paired_skipped, explicit); a refused id and the keyword strong are not pinned", async (t) => {
  const r = await rig(t, { "pa/big": "pb/mid" }, { provider: "pa", id: "big" });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "a", model: "pa/picked-m" }, { agent: "reviewer", task: "b", model: "pa/top" }, { agent: "reviewer", task: "c", model: "strong" }], reason: "the bottom rung cannot do this review" };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.deepEqual(models(input), ["pa/picked-m", "pb/mid", "pb/mid"]);
  assert.deepEqual(r.events("review_model").map((e) => [e.from, e.reason, e.pin ?? null]), [["pa/picked-m", "paired_skipped", "explicit"], ["pa/reviewer-m", "paired", null], ["pa/reviewer-s", "paired", null]]);
});

test("a launch that passes the mapped model itself is not pinned", async (t) => {
  const r = await rig(t, { "pa/big": "pb/mid" }, { provider: "pa", id: "big" });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "a", model: "pa/reviewer-m" }] };
  await r.launch(input);
  assert.deepEqual(models(input), ["pb/mid"]);
});

test("reviewByOccasion models are pinned occasion; a security rung is pinned security_rung", async (t) => {
  const r = await rig(t, { "pa/big": "pb/mid" }, { provider: "pa", id: "big" }, { reviewByOccasion: { "pre-pr": { model: "pa/picked-m" } } });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "branch [pre-pr]" }, { agent: "reviewer", task: "items 1" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.deepEqual(models(input), ["pa/picked-m", "pb/mid"]);
  assert.deepEqual(r.events("review_model").map((e) => [e.reason, e.pin ?? null]), [["paired_skipped", "occasion"], ["paired", null]]);
});

test("an occasion model with the mapped reviewer's base is still pinned occasion", async (t) => {
  const r = await rig(t, { "pa/big": "pb/mid" }, { provider: "pa", id: "big" }, { reviewByOccasion: { "pre-pr": { model: "pa/reviewer-m:high" } } });
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "branch [pre-pr]" }] };
  const res = await r.launch(input);
  assert.equal(res.res?.block, undefined, String(res.res?.reason));
  assert.deepEqual(models(input), ["pa/reviewer-m"]);
  assert.deepEqual(r.events("review_model").map((e) => [e.reason, e.pin ?? null]), [["paired_skipped", "occasion"]]);
});

test("a missing live model does not throw and launches", async (t) => {
  const r = await rig(t, { "pa/big": "pb/mid" }, undefined);
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "items 1" }] };
  await assert.doesNotReject(r.launch(input));
  assert.deepEqual(r.events("review_model"), []);
});

test("a pair that replaces a review_fail_repeat climb drops its rung_up trace; without a pair the climb is traced", async (t) => {
  for (const pair of [true, false]) {
    const r = await rig(t, pair ? { "pa/big": "pb/mid" } : { "pb/small": "pb/mid" }, { provider: "pa", id: "big" });
    for (const id of ["run-1", "run-2"]) {
      const rev = { agent: "reviewer", task: "review the diff" };
      const l = await r.launch(rev);
      await r.started(l.id, rev, id);
      r.end({ runId: id, agent: "reviewer", status: "completed", success: true, summary: "1. FAIL a.ts:1 broken" });
    }
    const input: Record<string, unknown> = { agent: "reviewer", task: "review the diff again" };
    await r.launch(input);
    assert.equal(String(input.model).split(":")[0], pair ? "pb/mid" : "pa/reviewer-s");
    assert.equal(r.events("rung_up").filter((e) => e.reason === "review_fail_repeat").length, pair ? 0 : 1);
  }
});
