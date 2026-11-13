// ladder.equalOnStrongRisk through the real adapter hooks (index.ts rank loop): a builder whose risk tag sends it to its strong rung may run
// on the foreman's own model when that is exactly the strong model, only with the key on; every other refusal keeps today's text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const BIG = "x\n".repeat(1700);
const RANKS = [{ match: "foreman", tier: 0 }, { match: "strong", tier: 0 }, { match: "*", tier: 3 }];
// the text of today's refusal of a tie (the foreman and the child both on fake/foreman, tier 0)
const TODAY = 'pi-foreman: launch refused [rank_policy:below]: child model fake/foreman (tier 0) is not below the foreman model fake/foreman (tier 0). Add a ranks entry for it, map the role to a lower-ranked model, or set ladder.childPolicy to "any" in the user or overlay config.';
const NOTE = /ladder\.equalOnStrongRisk/;

type Rig = Awaited<ReturnType<typeof r11Rig>>;
interface Opts {
  key?: boolean;
  strong?: string | null; // the builder's strong model; null = none mapped
  builder?: string; // the builder's normal model
  reviewer?: string;
  ranks?: unknown[];
  model?: string; // the foreman's own model id (provider fake)
}
const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });

async function rig(t: Parameters<typeof r11Rig>[0], o: Opts = {}): Promise<Rig> {
  const roles: Record<string, unknown> = {
    explorer: { model: "fake/explorer" },
    reviewer: { model: o.reviewer ?? "fake/reviewer" },
    builder: { model: o.builder ?? "fake/builder", ...(o.strong === null ? {} : { strong: { model: o.strong ?? "fake/foreman" } }) },
  };
  const ctx = { ...reviewAllowOpts().ctx, model: { provider: "fake", id: o.model ?? "foreman" } };
  return r11Rig(t, { default: "standard" }, {
    ctx,
    config: { providers: { fake: { review: { model: "m" }, roles, ranks: o.ranks ?? RANKS } }, ...(o.key === undefined ? {} : { ladder: { equalOnStrongRisk: o.key } }) },
  });
}

const refusals = (a: Rig): Record<string, unknown>[] => a.events("launch_refused").filter((r) => r.reason === "rank_policy");

test("key on, risk tag, parent on the strong model: launched, one launch line, one rank_equal_model event", async (t) => {
  const a = await rig(t, { key: true });
  const input = builder({ risk: ["guard", "security"] });
  const { id, res } = await a.launch(input);
  assert.equal(res, undefined);
  assert.equal(input.model, "fake/foreman");
  const result = (await a.started(id, input, "run-1")) as { content: { text: string }[] };
  const lines = result.content.map((c) => c.text).filter((x) => x.includes("own model"));
  assert.deepEqual(lines, ["pi-foreman: builder runs on the foreman's own model fake/foreman (ladder.equalOnStrongRisk, risk: guard,security)."]);
  const ev = a.events("rank_equal_model");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].role, ev[0].model, ev[0].policy, ev[0].risk], ["builder", "fake/foreman", "below", "guard,security"]);
  assert.ok("foreman" in ev[0]);
  assert.deepEqual(refusals(a), []);
  assert.deepEqual(a.events("strong_unmapped"), []);
});

test("key off: refused, the reason names the key and keeps today's text before it", async (t) => {
  for (const key of [undefined, false]) {
    const a = await rig(t, { key });
    const res = (await a.launch(builder({ risk: ["guard"] }))).res;
    assert.equal(res?.block, true);
    assert.ok(res?.reason?.startsWith(TODAY), res?.reason);
    assert.match(res?.reason ?? "", NOTE);
    assert.equal(refusals(a).length, 1);
    assert.deepEqual(a.events("rank_equal_model"), []);
  }
});

test("an ordinary refusal is byte-identical to today's: a size-only climb, with the key on or off", async (t) => {
  for (const key of [true, false]) {
    const a = await rig(t, { key });
    fs.writeFileSync(path.join(a.project, "big.py"), BIG);
    const input = builder({ size: { files: ["big.py"] } });
    const res = (await a.launch(input)).res;
    assert.equal(input.model, "fake/foreman");
    assert.equal(res?.block, true);
    assert.equal(res?.reason, TODAY);
    assert.deepEqual(a.events("rank_equal_model"), []);
  }
});

test("key on, bottom-rung launch on the parent's model: refused with today's text", async (t) => {
  const a = await rig(t, { key: true, builder: "fake/foreman", strong: "fake/strong" });
  const res = (await a.launch(builder({ size: { files: ["new.py"] } }))).res;
  assert.equal(res?.reason, TODAY);
  const noSize = (await a.launch(builder())).res;
  assert.equal(noSize?.reason, TODAY);
});

test("key on, parent below the strong model: refused, the reason is not extended", async (t) => {
  const ranks = [{ match: "foreman", tier: 2 }, { match: "strong", tier: 0 }, { match: "*", tier: 3 }];
  const a = await rig(t, { key: true, strong: "fake/strong", ranks });
  const res = (await a.launch(builder({ risk: ["guard"] }))).res;
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /\[rank_policy:below\].*fake\/strong \(tier 0\) is not below the foreman model fake\/foreman \(tier 2\)/);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
});

test("key on, unranked models fail closed", async (t) => {
  const a = await rig(t, { key: true, ranks: [{ match: "other", tier: 0 }] });
  const res = (await a.launch(builder({ risk: ["guard"] }))).res;
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /is unranked/);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
  assert.deepEqual(a.events("rank_equal_model"), []);
});

test("key on, a different model of the same rank: refused, the reason is not extended", async (t) => {
  const a = await rig(t, { key: true, strong: "fake/strong" });
  const res = (await a.launch(builder({ risk: ["guard"] }))).res;
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /child model fake\/strong \(tier 0\) is not below the foreman model fake\/foreman \(tier 0\)/);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
});

test("key on, a reviewer sharing the model in a parallel launch: refused", async (t) => {
  const a = await rig(t, { key: true, reviewer: "fake/foreman" });
  const res = (await a.launch({ tasks: [builder({ risk: ["guard"] }), { agent: "reviewer", task: "review it" }] })).res;
  assert.equal(res?.block, true);
  assert.equal(refusals(a).length, 1);
  assert.deepEqual(a.events("rank_equal_model"), []);
});

test("key on, a design-only fallback to strong: refused", async (t) => {
  const a = await rig(t, { key: true });
  const res = (await a.launch(builder({ risk: ["design"] }))).res;
  assert.equal(res?.block, true);
  assert.ok(res?.reason?.startsWith(TODAY), res?.reason);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
  assert.deepEqual(a.events("rank_equal_model"), []);
});

test("key on, a risk tag but no strong model mapped and the normal model is the parent's: refused", async (t) => {
  const a = await rig(t, { key: true, strong: null, builder: "fake/foreman" });
  const res = (await a.launch(builder({ risk: ["guard"] }))).res;
  assert.equal(res?.block, true);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
  assert.deepEqual(a.events("rank_equal_model"), []);
});

test("key on, an explicit normal model with a reason and a risk tag: refused", async (t) => {
  const a = await rig(t, { key: true, strong: "fake/strong", builder: "fake/foreman" });
  const res = (await a.launch(builder({ model: "default", reason: "one-line fix", risk: ["guard"] }))).res;
  assert.equal(res?.block, true);
  assert.doesNotMatch(res?.reason ?? "", NOTE);
  assert.deepEqual(a.events("rank_equal_model"), []);
});
