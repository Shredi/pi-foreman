// roles-slim: three launchable roles; the heavy finish gate needs builder and reviewer only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredSteps } from "../bound.ts";
import { LAUNCH_ROLES, toolDefault } from "../defaults.ts";
import { childRoleIds, roleLaunchBlock } from "../roles.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("LAUNCH_ROLES has three ids; a removed role name is refused by the generic unknown-role path", () => {
  assert.deepEqual([...LAUNCH_ROLES].sort(), ["builder", "explorer", "reviewer"]);
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "foreman.defaults.json"), "utf8"));
  const allowed = childRoleIds(defaults.roles);
  assert.deepEqual(allowed, ["explorer", "builder", "reviewer"]);
  for (const old of ["planner", "finalizer", "senior-reviewer"]) {
    assert.equal(toolDefault("subagent", { agent: old, task: "t" }, { child: false }), undefined, old);
    assert.match(roleLaunchBlock({ agent: old, task: "t" }, allowed) ?? "", new RegExp(`agent '${old}' is not a pi-foreman role`), old);
  }
});

test("the default heavy finish gate needs builder and reviewer only", () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "foreman.defaults.json"), "utf8"));
  assert.deepEqual(requiredSteps(defaults.ceremony.required, "heavy"), ["builder", "reviewer"]);
});
