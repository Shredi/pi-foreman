import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels, launchModel } from "../launchmodel.ts";
import { topRoleEntry } from "../ranks.ts";
import { topRefusal } from "../topkeyword.ts";

const ROLES = {
  explorer: { model: "p1/small", thinking: "low" },
  builder: { model: "p1/mid", thinking: "medium", strong: { model: "p1/big", thinking: "high" } },
  reviewer: { model: "p2/huge", thinking: "medium" },
};
const CONFIG = { providers: { p1: { ranks: [{ match: "small", tier: 3 }, { match: "mid", tier: 2 }, { match: "big", tier: 1 }] }, p2: { ranks: [{ match: "huge", tier: 0 }] } } };

test("top resolves to the highest tier across the whole role map", () => {
  const top = topRoleEntry(CONFIG, ROLES);
  assert.deepEqual(top, { model: "p2/huge", thinking: "medium" });
  assert.equal(launchModel("explorer", ROLES, "top", "high", { top })?.model, "p2/huge:medium");
  const input: Record<string, unknown> = { agent: "explorer", task: "t", model: "top" };
  const res = applyLaunchModels(input, ROLES, "high", { top });
  assert.equal(input.model, "p2/huge:medium");
  assert.deepEqual(res.overrides, []);
});

test("a strong rung can be the top entry", () => {
  const cfg = { providers: { p1: { ranks: [{ match: "big", tier: 0 }, { match: "*", tier: 5 }] } } };
  assert.equal((topRoleEntry(cfg, ROLES) as { model: string }).model, "p1/big");
});

test("without ranks top falls back the way strong does", () => {
  assert.equal(topRoleEntry({}, ROLES), null);
  assert.equal(launchModel("explorer", ROLES, "top", "high", { top: null })?.model, "p1/small:low");
  const roles = { ...ROLES, explorer: { ...ROLES.explorer, strong: { model: "p1/mid", thinking: "low" } } };
  assert.equal(launchModel("explorer", roles, "top", "high", { top: null })?.model, "p1/mid:low");
});

test("a mapped model that is unranked never wins", () => {
  assert.equal(topRoleEntry({ providers: { p1: { ranks: [{ match: "mid", tier: 2 }] } } }, ROLES)?.model, "p1/mid");
});

const entry = (o: Record<string, unknown> = {}) => ({ agent: "explorer", task: "t", model: "top", reason: "steward pass", ...o });

test("top is refused outside the steward session", () => {
  const input = entry();
  assert.match(topRefusal([input], input, false) ?? "", /\[top_not_allowed\]/);
});

test("top is refused for builder and reviewer, also inside the steward session", () => {
  for (const agent of ["builder", "reviewer"]) {
    const input = entry({ agent });
    const no = topRefusal([input], input, true) ?? "";
    assert.match(no, /\[top_not_allowed\]/);
    assert.ok(!no.includes("\n"));
  }
});

test("top is refused without a reason, a reason on the launch or on the entry counts", () => {
  const bare = entry({ reason: undefined });
  assert.match(topRefusal([bare], bare, true) ?? "", /needs a reason/);
  const blank = entry({ reason: "  " });
  assert.match(topRefusal([blank], blank, true) ?? "", /needs a reason/);
  const top = { agent: "explorer", task: "t", model: "top" };
  assert.equal(topRefusal([top], { reason: "why", tasks: [top] }, true), null);
});

test("an explorer in the steward session with a reason is allowed; other models never trigger the rule", () => {
  const ok = entry();
  assert.equal(topRefusal([ok], ok, true), null);
  const plain = { agent: "builder", task: "t", model: "strong" };
  assert.equal(topRefusal([plain], plain, false), null);
  const level = entry({ model: "top:high", agent: "builder" });
  assert.match(topRefusal([level], level, true) ?? "", /explorer role only/);
});
