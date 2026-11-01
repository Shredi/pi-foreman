import { test } from "node:test";
import assert from "node:assert/strict";
import { rolesOfModel } from "../ranks.ts";

test("rolesOfModel: the agents of the entries that launch a model, nested included", () => {
  const input = { tasks: [{ agent: "builder", model: "a/mid" }, { parallel: [{ agent: "builder", model: "a/mid" }, { agent: "reviewer", model: "a/top" }] }] };
  assert.deepEqual(rolesOfModel(input, "a/mid"), ["builder", "builder"]);
  assert.deepEqual(rolesOfModel({ agent: "builder", model: "a/mid" }, "a/mid"), ["builder"]);
  assert.deepEqual(rolesOfModel(input, "a/none"), []);
});
