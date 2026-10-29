// R12 item 6: `paths.hubWorkflow` whose basename is `.workflow` makes the doctor WARN (hub ROOT, the renderer appends .workflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB_ROOT_FIX, hubWorkflowDriftLines } from "../hubdrift.ts";

test("doctor_hub_workflow_basename_warns", () => {
  for (const v of ["/a/hub/.workflow", "/a/hub/.workflow/"]) {
    const lines = hubWorkflowDriftLines({ hubWorkflow: v });
    assert.equal(lines.length, 1, v);
    assert.ok(lines[0].startsWith("WARN ") && lines[0].includes(HUB_ROOT_FIX), lines[0]);
  }
  const list = hubWorkflowDriftLines({ hubWorkflow: ["/a/hub", "/b/.workflow"] });
  assert.equal(list.filter((l) => l.includes("hub ROOT")).length, 1);
  assert.deepEqual(hubWorkflowDriftLines({ hubWorkflow: "/a/hub" }), []);
});
