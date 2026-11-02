// r79 item 5 on the bundled ask tool: without a UI the result is an error (cancelled, error "no_ui"), never an answer,
// and it does not send the agent to the ask.md file path.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { askAnswered, resultText } from "../askhooks.ts";
import { ownerAnswered } from "../idlemodel.ts";

const FIX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ask-user-question-2.15.0.json"), "utf8"));

test("no UI: not an answer, not an owner answer, no ask.md pointer", () => {
  const r = FIX.noUi;
  assert.equal(r.details.cancelled, true);
  assert.equal(r.details.error, "no_ui");
  assert.equal(askAnswered(r.details, false), false);
  assert.equal(ownerAnswered("ask_user_question", r.details), false);
  assert.doesNotMatch(resultText(r.content), /ask\.md/);
});
