import { test } from "node:test";
import assert from "node:assert/strict";
import { LadderState } from "../ladder.ts";

const ROLES = { builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } } };

test("the strong_no_reason refusal says where to pass reason", () => {
  const block = new LadderState().plan({ agent: "builder", task: "t", model: "strong" }, ROLES).block ?? "";
  assert.match(block, /\[strong_no_reason\]/);
  assert.match(block, /pass `reason` as an extra top-level field of the subagent call/);
});
