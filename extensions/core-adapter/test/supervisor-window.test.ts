import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPERVISOR_REQUEST_TYPE, SupervisorWindow } from "../supervisor.ts";

function openWindow(): SupervisorWindow {
  const w = new SupervisorWindow();
  w.onMessage({ customType: SUPERVISOR_REQUEST_TYPE, details: { requestId: "r1", agent: "builder", runId: "run1" } });
  assert.equal(w.open.size, 1);
  return w;
}

const builderTools = () => ["read", "edit", "write"];

test("bg_wait is not refused while a child supervisor ask is open", () => {
  const w = openWindow();
  assert.equal(w.check("bg_wait", { id: "bg1" }, builderTools), undefined);
});

test("a tool outside the role's tools is still refused while an ask is open", () => {
  const w = openWindow();
  assert.match(w.check("bash", { command: "ls" }, builderTools)?.reason ?? "", /bash is not in the builder role's tools/);
});
