import { test } from "node:test";
import assert from "node:assert/strict";
import { childRoleIds, roleLaunchBlock, roleModelBlock } from "../roles.ts";
import type { RoleResolution } from "../roles.ts";

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

const RESOLVED: RoleResolution = {
  provider: "fake",
  source: "cli",
  roles: {
    explorer: { model: "fake/explorer" },
    builder: { error: "role builder has no model for provider fake and no fallback" },
    reviewer: { thinking: "low" },
    finalizer: { model: "other/finalizer" }, // resolved through providers.fake.fallback
  },
};
const NO_BUILDER = "pi-foreman: role 'builder' has no model for provider 'fake' and no fallback; add providers.fake.roles.builder.model to foreman.json (or a providers.fake.fallback) and restart the session.";

test("model check: resolved and fallback-resolved roles pass", () => {
  assert.equal(roleModelBlock({ agent: "explorer", task: "t" }, RESOLVED), undefined);
  assert.equal(roleModelBlock({ agent: "finalizer", task: "t" }, RESOLVED), undefined);
});

test("model check: role with a resolve error or without a model is refused", () => {
  assert.equal(roleModelBlock({ agent: "builder", task: "t" }, RESOLVED), NO_BUILDER);
  assert.match(roleModelBlock({ agent: "reviewer", task: "t" }, RESOLVED) ?? "", /role 'reviewer' has no model for provider 'fake'/);
  assert.match(roleModelBlock({ agent: "senior-reviewer", task: "t" }, RESOLVED) ?? "", /role 'senior-reviewer'/);
});

test("model check: no roles map, no provider or no config CLI is refused", () => {
  assert.match(roleModelBlock({ agent: "explorer", task: "t" }, { ...RESOLVED, roles: {} }) ?? "", /role 'explorer' has no model/);
  assert.match(roleModelBlock({ agent: "explorer", task: "t" }, { provider: undefined, roles: {}, source: "cli" }) ?? "", /no provider is active/);
  assert.match(roleModelBlock({ agent: "explorer", task: "t" }, { ...RESOLVED, source: "defaults" }) ?? "", /config could not be loaded/);
});

test("model check: management calls pass, tasks and chain entries are checked", () => {
  assert.equal(roleModelBlock({ action: "status", agent: "builder" }, RESOLVED), undefined);
  assert.equal(roleModelBlock({ action: "list" }, { provider: undefined, roles: {}, source: "defaults" }), undefined);
  assert.equal(roleModelBlock({ tasks: [{ agent: "explorer", task: "a" }, { agent: "builder", task: "b" }] }, RESOLVED), NO_BUILDER);
  assert.equal(roleModelBlock({ chain: [{ agent: "explorer" }, { parallel: [{ agent: "finalizer", task: "x" }] }] }, RESOLVED), undefined);
  assert.equal(roleModelBlock({ chain: [{ agent: "explorer" }, { parallel: [{ agent: "builder", task: "x" }] }] }, RESOLVED), NO_BUILDER);
});
