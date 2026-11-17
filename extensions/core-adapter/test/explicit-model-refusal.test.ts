// D36: an explicit builder `model` the rank rules do not allow (or with no rank rules at all) is refused with the reason and, with ranks, the
// allowed models. The role's mapped model, the keywords and the strong rung's own model are exempt. Other roles keep the replacement, and the
// launch result names it (`model switched:`). A foreman session with no rank rules gets one boot notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;

const RANKS = [{ match: "above", tier: 0 }, { match: "foreman", tier: 1 }, { match: "strongb", tier: 3 }, { match: "builder", tier: 3 }, { match: "lower", tier: 3 }];

/** A foreman on fake/foreman; the builder maps to fake/builder with the strong rung `strong`. */
async function rig(t: Parameters<typeof r11Rig>[0], opts: { ranks?: boolean; strong?: string } = {}): Promise<{ a: Rig; notes: string[] }> {
  const notes: string[] = [];
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: opts.strong ?? "fake/strongb" } } };
  const base = reviewAllowOpts();
  const ui = { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const a = await r11Rig(t, { default: "standard" }, {
    ctx: { ...base.ctx, ui, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles, ...(opts.ranks ? { ranks: RANKS } : {}) } } },
  });
  return { a, notes };
}

const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });
const texts = (res: unknown): string => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

test("no ranks, an explicit builder model outside the ladder: refused naming the setup, no run", async (t) => {
  const { a } = await rig(t);
  const { res } = await a.launch(builder({ model: "fake/other" }));
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /^pi-foreman: launch refused \[model_not_allowed\] fake\/other: no rank rules configured \(run foreman config apply-preset or set providers\.<p>\.ranks\)/);
  assert.deepEqual(a.events("launch_refused").map((r) => r.reason), ["model_not_allowed"]);
});

test("no ranks, an explicit model equal to the role's mapped model: launches as today", async (t) => {
  const { a } = await rig(t);
  const input = builder({ model: "fake/builder" });
  const { res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(input.model, "fake/builder");
});

test("no ranks, the strong rung's own model: launches on the strong rung without a reason", async (t) => {
  const { a } = await rig(t);
  const input = builder({ model: "fake/strongb" });
  const { res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(input.model, "fake/strongb");
});

test("ranks allowing the strong rung's model: launches on it, with or without a reason", async (t) => {
  const { a } = await rig(t, { ranks: true });
  const withReason = builder({ model: "fake/strongb", reason: "hard parser" });
  assert.equal((await a.launch(withReason)).res, undefined);
  assert.equal(withReason.model, "fake/strongb");
  const bare = builder({ model: "fake/strongb" });
  const { res } = await a.launch(bare);
  assert.equal(res, undefined, res?.reason);
  assert.equal(bare.model, "fake/strongb");
  assert.doesNotMatch(JSON.stringify(a.events("launch_refused")), /strong_no_reason/);
});

test("ranks forbidding the strong rung's model: refused by the rank loop with the relaunch hint", async (t) => {
  const { a } = await rig(t, { ranks: true, strong: "fake/above" });
  const { res } = await a.launch(builder({ model: "fake/above", reason: "hard" }));
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /rank_policy:below/);
  assert.doesNotMatch(res?.reason ?? "", /model_not_allowed/);
  assert.match(res?.reason ?? "", /Relaunch with model "default"/);
});

test("ranks set, an unranked explicit model: refused with the reason and the allowed list", async (t) => {
  const { a } = await rig(t, { ranks: true });
  const { res } = await a.launch(builder({ model: "other/unknown" }));
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /\[model_not_allowed\] other\/unknown: model not ranked\./);
  assert.match(res?.reason ?? "", /Allowed models for builder: .*fake\/lower/);
  assert.match(res?.reason ?? "", /Drop `model` or pick one of them/);
});

test("ranks set, an allowed explicit model: launches on it", async (t) => {
  const { a } = await rig(t, { ranks: true });
  const input = builder({ model: "fake/lower", reason: "a one-line fix" });
  const { res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(input.model, "fake/lower");
});

test("a bare model id without the provider: refused with the prefix reason", async (t) => {
  for (const ranks of [false, true]) {
    const { a } = await rig(t, { ranks });
    const { res } = await a.launch(builder({ model: "lower" }));
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", /\[model_not_allowed\] lower: model id needs the provider\/ prefix/);
  }
});

test("a reviewer's explicit model with no ranks is replaced as today and the result carries a model switched line", async (t) => {
  const { a } = await rig(t);
  const input = { agent: "reviewer", task: "review item 1", model: "fake/other" };
  const { id, res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(input.model, "fake/reviewer");
  const text = texts(await a.started(id, input, "run-r1"));
  assert.match(text, /^model switched: fake\/other -> fake\/reviewer \(no rank rules configured/m);
  assert.doesNotMatch(text.split("\n").filter((l) => l.startsWith("model switched")).join("\n"), /^pi-foreman: launched/);
});

test("boot notice: once with no rank rules, none with ranks", async (t) => {
  const none = await rig(t);
  assert.equal(none.notes.filter((n) => /no model rank rules/.test(n)).length, 1);
  assert.match(none.notes.find((n) => /no model rank rules/.test(n)) ?? "", /foreman config apply-preset/);
  assert.deepEqual(none.a.events("model_override"), []);
  const some = await rig(t, { ranks: true });
  assert.equal(some.notes.filter((n) => /no model rank rules/.test(n)).length, 0);
});
