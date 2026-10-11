import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANNER_OWN_RUNG_HINT, rolesOfModel } from "../ranks.ts";

test("rolesOfModel: the agents of the entries that launch a model, nested included", () => {
  const input = { tasks: [{ agent: "planner", model: "a/mid" }, { parallel: [{ agent: "builder", model: "a/mid" }, { agent: "reviewer", model: "a/top" }] }] };
  assert.deepEqual(rolesOfModel(input, "a/mid"), ["planner", "builder"]);
  assert.deepEqual(rolesOfModel({ agent: "planner", model: "a/mid" }, "a/mid"), ["planner"]);
  assert.deepEqual(rolesOfModel(input, "a/none"), []);
});

test("the planner hint names the own-rung cause and the way out", () => {
  assert.match(PLANNER_OWN_RUNG_HINT, /planner role sits on the foreman's own rung.*plan it yourself.*lower rung/);
});
