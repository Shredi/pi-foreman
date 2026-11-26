import { test } from "node:test";
import assert from "node:assert/strict";
import { noClassifierModelText } from "../reviewwarn.ts";

test("noClassifierModelText points to the judge-first list and claims no judge-first kind runs", () => {
  const t = noClassifierModelText("fake");
  assert.ok(t.includes("docs/permissions.md#who-decides"), t);
  assert.ok(t.includes("refused"), t);
  assert.ok(t.includes("nobody is asked"), t);
  assert.ok(!/judge-first[^.;]*\bruns?\b/.test(t.split("Everything else")[0]), t);
  assert.ok(!t.includes("deploys") && !t.includes("forge writes"), t);
  assert.ok(t.includes("providers.<p>.roles.review.model"), t);
});

test("noClassifierModelText says a protected target is refused unless its check is ask", () => {
  const t = noClassifierModelText("fake");
  assert.ok(t.includes("unless that target's check is set to ask"), t);
  assert.ok(!t.includes("sees the write"), t);
});
