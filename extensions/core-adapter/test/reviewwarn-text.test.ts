import { test } from "node:test";
import assert from "node:assert/strict";
import { noClassifierModelText } from "../reviewwarn.ts";

test("noClassifierModelText lists what is judge-first now, not deploys or forge writes", () => {
  const t = noClassifierModelText("fake");
  assert.ok(t.includes("every judge-first call (a delete or write whose target the code cannot read, a global install, a network write, losing local git work, a protected target, and with gate.unclassified: judge a line the code cannot classify) is refused with that reason"), t);
  assert.ok(!t.includes("deploys") && !t.includes("forge writes"), t);
  assert.ok(t.includes("providers.<p>.roles.review.model"), t);
});
