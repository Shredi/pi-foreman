// The rank_policy refusal names the cause when the refused model is a role's normal model: the foreman must run on a model ranked above it.
// Only the first role whose own policy refuses is named; a strong rung, an unranked model and an unranked foreman get no sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalModelSentence, rankRefusal } from "../ranks.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const RANKS = [{ match: "foreman", tier: 1 }, { match: "strong", tier: 0 }, { match: "*", tier: 3 }];
const sentence = (model: string, role: string, how = "above"): string => `${model} is the ${role}'s normal model: run the foreman on a model ranked ${how} it.`;
const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });

interface Opts {
  roles?: Record<string, unknown>;
  ranks?: unknown[];
  ladder?: Record<string, unknown>;
}
async function rig(t: Parameters<typeof r11Rig>[0], o: Opts = {}) {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder" }, ...o.roles };
  const ctx = { ...reviewAllowOpts().ctx, model: { provider: "fake", id: "foreman" } };
  return r11Rig(t, { default: "standard" }, { ctx, config: { providers: { fake: { review: { model: "m" }, roles, ranks: o.ranks ?? RANKS } }, ...(o.ladder ? { ladder: o.ladder } : {}) } });
}

// one rig, two launches: the explorer (at-or-below) and the builder (below) both map to the foreman's model (a reviewer cannot sit in a group launch)
test("builder normal model ties with the foreman: the sentence with 'above'; explorer listed first passes, the builder is refused: the sentence names the builder", async (t) => {
  const roles = { explorer: { model: "fake/foreman" }, builder: { model: "fake/foreman" } };
  const a = await rig(t, { roles, ladder: { rolePolicy: { explorer: "at-or-below" } } });
  const alone = (await a.launch(builder())).res;
  assert.equal(alone?.block, true);
  assert.ok(alone?.reason?.includes("[rank_policy:below]"));
  assert.ok(alone?.reason?.includes(` ${sentence("fake/foreman", "builder")}`));
  const both = (await a.launch({ tasks: [{ agent: "explorer", task: "look around" }, builder()] })).res;
  assert.equal(both?.block, true);
  assert.ok(both?.reason?.includes(sentence("fake/foreman", "builder")));
  assert.ok(!both?.reason?.includes("the explorer's normal model"));
});

// the other conditions on the pure function
const cfg = (ranks: unknown[] = RANKS, ladder: Record<string, unknown> = {}): Record<string, unknown> => ({ providers: { fake: { ranks } }, ...(Object.keys(ladder).length ? { ladder } : {}) });
const normal = (role: string, model: string): Record<string, any> => ({ [role]: { model } });

test("explorer normal model ties with the foreman: the sentence names the explorer", () => {
  assert.equal(normalModelSentence(cfg(), "fake/foreman", "fake/foreman", ["explorer"], normal("explorer", "fake/foreman")), sentence("fake/foreman", "explorer"));
});

test("builder normal model above the foreman: the sentence", () => {
  assert.equal(normalModelSentence(cfg(), "fake/foreman", "fake/strong", ["builder"], normal("builder", "fake/strong")), sentence("fake/strong", "builder"));
});

test("reviewer normal model above the foreman under at-or-below: 'at or above'", () => {
  const config = cfg(RANKS, { rolePolicy: { reviewer: "at-or-below" } });
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/strong", ["reviewer"], normal("reviewer", "fake/strong")), sentence("fake/strong", "reviewer", "at or above"));
});

test("reviewer first passes, the builder on the same model is refused: the sentence names the builder", () => {
  const config = cfg(RANKS, { rolePolicy: { reviewer: "at-or-below" } });
  const roleMap = { ...normal("reviewer", "fake/foreman"), ...normal("builder", "fake/foreman") };
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/foreman", ["reviewer", "builder"], roleMap), sentence("fake/foreman", "builder"));
});

test("a strong rung (the [research] marker raised the explorer to it, not its normal model): no sentence", () => {
  const roleMap = { explorer: { model: "fake/explorer", strong: { model: "fake/foreman" } } };
  assert.equal(normalModelSentence(cfg(), "fake/foreman", "fake/foreman", ["explorer"], roleMap), null);
});

test("an unranked normal model: no sentence", () => {
  assert.equal(normalModelSentence(cfg([{ match: "foreman", tier: 1 }]), "fake/foreman", "fake/builder", ["builder"], normal("builder", "fake/builder")), null);
});

test("an unranked foreman: no sentence", () => {
  assert.equal(normalModelSentence(cfg([{ match: "builder", tier: 3 }]), "fake/foreman", "fake/builder", ["builder"], normal("builder", "fake/builder")), null);
});

test("normalModelSentence: an explicit other model, a strong model and a policy-passing role give null", () => {
  const config = { providers: { fake: { ranks: RANKS } } };
  const roleMap = { builder: { model: "fake/builder", strong: { model: "fake/strong" } }, explorer: { model: "fake/foreman" } };
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/strong", ["builder"], roleMap), null);
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/other", ["builder"], roleMap), null);
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/builder", ["builder"], roleMap), null);
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/foreman", [], roleMap), null);
  assert.equal(normalModelSentence(config, "fake/foreman", "fake/foreman:high", ["explorer"], roleMap), sentence("fake/foreman", "explorer"));
});

test("rankRefusal keeps its message byte for byte", () => {
  const config = { providers: { fake: { ranks: RANKS } } };
  assert.equal(
    rankRefusal(config, "fake/foreman", "fake/foreman", "builder")?.message,
    'pi-foreman: launch refused [rank_policy:below]: child model fake/foreman (tier 1) is not below the foreman model fake/foreman (tier 1). Add a ranks entry for it, map the role to a lower-ranked model, or set ladder.childPolicy to "any" in the user or overlay config.',
  );
});
