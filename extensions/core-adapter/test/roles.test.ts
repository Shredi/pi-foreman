import { test } from "node:test";
import assert from "node:assert/strict";
import { childRoleIds, roleLaunchBlock } from "../roles.ts";

const ROLES = { foreman: {}, explorer: {}, builder: {}, reviewer: {}, "senior-reviewer": {}, finalizer: {} };
const allowed = childRoleIds(ROLES);

test("child role ids are the config roles without foreman", () => {
  assert.deepEqual(allowed, ["explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]);
  assert.deepEqual(childRoleIds(undefined), []);
});

test("single agent: role passes, builtin is refused with the allowed list", () => {
  assert.equal(roleLaunchBlock({ agent: "builder", task: "t" }, allowed), undefined);
  assert.equal(
    roleLaunchBlock({ agent: "worker", task: "t" }, allowed),
    "pi-foreman: agent 'worker' is not a pi-foreman role; launch one of: explorer, builder, reviewer, senior-reviewer, finalizer",
  );
  assert.match(roleLaunchBlock({ agent: "foreman", task: "t" }, allowed) ?? "", /agent 'foreman'/);
});

test("tasks entries are checked", () => {
  assert.equal(roleLaunchBlock({ tasks: [{ agent: "explorer", task: "a" }, { agent: "reviewer", task: "b" }] }, allowed), undefined);
  assert.match(roleLaunchBlock({ tasks: [{ agent: "explorer", task: "a" }, { agent: "scout", task: "b" }] }, allowed) ?? "", /agent 'scout'/);
});

test("chain and chain parallel entries are checked", () => {
  assert.equal(roleLaunchBlock({ chain: [{ agent: "explorer" }, { parallel: [{ agent: "builder", task: "x" }] }] }, allowed), undefined);
  assert.match(roleLaunchBlock({ chain: [{ agent: "planner" }] }, allowed) ?? "", /agent 'planner'/);
  assert.match(roleLaunchBlock({ chain: [{ agent: "explorer" }, { parallel: [{ agent: "builder", task: "x" }, { agent: "worker", task: "y" }] }] }, allowed) ?? "", /agent 'worker'/);
});

test("management calls with an action pass", () => {
  assert.equal(roleLaunchBlock({ action: "list" }, allowed), undefined);
  assert.equal(roleLaunchBlock({ action: "status", agent: "worker" }, allowed), undefined);
  assert.match(roleLaunchBlock({ action: "", agent: "worker", task: "t" }, allowed) ?? "", /agent 'worker'/);
});

test("an overlay-added role is allowed", () => {
  const withOverlay = childRoleIds({ ...ROLES, "doc-writer": {} });
  assert.equal(roleLaunchBlock({ agent: "doc-writer", task: "t" }, withOverlay), undefined);
  assert.equal(roleLaunchBlock({ agent: "doc-writer", task: "t" }, allowed)?.includes("agent 'doc-writer'"), true);
});
