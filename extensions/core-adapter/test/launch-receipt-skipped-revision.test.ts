// D19: a revision climb after a review FAIL that the rank policy skips names the same trigger as the unskipped one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

test("a rank-skipped climb after a FAIL names the revision after FAIL", async (t) => {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: "fake/strong" } } };
  const ranks = [{ match: "foreman*", tier: 2 }, { match: "strong", tier: 2 }, { match: "*", tier: 5 }];
  const a = await r11Rig(t, { default: "standard" }, { ctx: reviewAllowOpts().ctx, config: { providers: { fake: { review: { model: "m" }, roles, ranks } } } });
  const first = { agent: "builder", task: "build it" };
  const { id } = await a.launch(first);
  await a.started(id, first, "run-b");
  a.end({ runId: "run-b", agent: "builder", success: true, summary: "done" });
  const review = { agent: "reviewer", task: "review item 1" };
  const r = await a.launch(review);
  await a.started(r.id, review, "run-r");
  a.end({ runId: "run-r", agent: "reviewer", success: true, summary: "Verdict: FAIL\n- a finding" });
  const again = { agent: "builder", task: "build it" };
  const l = await a.launch(again);
  const out = (await a.started(l.id, again, "run-b2")) as { content: { text: string }[] } | undefined;
  const text = (out?.content ?? []).map((c) => c.text).filter((x) => x.startsWith("pi-foreman: launched")).join("\n");
  assert.equal(text, "pi-foreman: launched builder on fake/builder (strong rung skipped by rank policy: revision after FAIL).");
});
