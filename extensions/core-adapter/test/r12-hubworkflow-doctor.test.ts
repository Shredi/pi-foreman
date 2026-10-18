// R12 item 6: `paths.hubWorkflow` whose basename is `.workflow` makes the doctor WARN (hub ROOT, the renderer appends .workflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hubWorkflowDriftLines } from "../hubdrift.ts";

test("doctor_hub_workflow_basename_warns", () => {
  for (const v of ["/a/hub/.workflow", "/a/hub/.workflow/"]) {
    const lines = hubWorkflowDriftLines({ agentDir: "/nonexistent-agent", hubWorkflow: v, checkouts: [] });
    assert.equal(lines.length, 1, v);
    assert.ok(lines[0].startsWith("WARN ") && lines[0].includes("hub ROOT, the renderer appends .workflow"), lines[0]);
  }
  const list = hubWorkflowDriftLines({ agentDir: "/nonexistent-agent", hubWorkflow: ["/a/hub", "/b/.workflow"], checkouts: [] });
  assert.equal(list.filter((l) => l.includes("hub ROOT")).length, 1);
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: "/nonexistent-agent", hubWorkflow: "/a/hub", checkouts: [] }), []);
});
