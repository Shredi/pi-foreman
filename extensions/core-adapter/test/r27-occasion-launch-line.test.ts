// R27 item 4: the launch result of a reviewer names its occasion when it is not `item`; a plain review gets no such line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig as baseRig, reviewAllowOpts } from "./_r11rig.ts";

const r11Rig = (t: Parameters<typeof baseRig>[0], ceremony: Record<string, unknown> = {}) => baseRig(t, ceremony, reviewAllowOpts());

const texts = (res: unknown): string[] => ((res as { content?: { text: string }[] } | undefined)?.content ?? []).map((c) => c.text);

test("a [second-opinion] reviewer launch result names the advisory occasion; a plain one does not", async (t) => {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const second = { agent: "reviewer", task: "[second-opinion] look at the branch" };
  const launched = await a.launch(second);
  assert.equal(launched.res, undefined);
  const res = await a.started(launched.id, second, "run-so");
  assert.ok(texts(res).includes("occasion: second-opinion (advisory: marks no items, does not open the review gate)"), JSON.stringify(res));

  const plain = { agent: "reviewer", task: "review items 1" };
  const plainLaunch = await a.launch(plain);
  const plainRes = await a.started(plainLaunch.id, plain, "run-plain");
  assert.ok(!texts(plainRes).some((x) => x.startsWith("occasion:")), JSON.stringify(plainRes));
});

test("a [pre-pr] reviewer launch result names that it counts for items and the PR gate", async (t) => {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const pre = { agent: "reviewer", task: "review the whole branch\n[pre-pr]" };
  const launched = await a.launch(pre);
  const res = await a.started(launched.id, pre, "run-pre");
  assert.ok(texts(res).includes("occasion: pre-pr (counts for items and the PR gate)"), JSON.stringify(res));
});
