import { test } from "node:test";
import assert from "node:assert/strict";
import { outputPathBlock, uncheckedHeavyBlock } from "../actions.ts";

test("launch: output/outputMode refused at the top level and in every step; unchecked workflow refused at heavy", () => {
  const re = /^pi-foreman: subagent launch refused \[launch_refused:output_path\]: /;
  assert.equal(outputPathBlock({ agent: "builder", task: "t" }), undefined);
  assert.equal(outputPathBlock({ agent: "explorer", task: "t", output: false }), undefined);
  assert.match(outputPathBlock({ agent: "builder", task: "t", output: "/abs/src/x.ts" }) ?? "", re);
  assert.match(outputPathBlock({ agent: "explorer", task: "t", output: true }) ?? "", re);
  assert.match(outputPathBlock({ agent: "explorer", task: "t", outputMode: "inline" }) ?? "", re);
  assert.match(outputPathBlock({ chain: [{ agent: "explorer", task: "a" }, { agent: "reviewer", task: "b", output: "../x.md" }] }) ?? "", re);
  assert.match(outputPathBlock({ chain: [{ parallel: [{ agent: "explorer", task: "a", outputMode: "file-only" }] }] }) ?? "", re);
  assert.match(outputPathBlock({ tasks: [{ agent: "explorer", task: "a", output: "o.md" }] }) ?? "", re);
  assert.match(uncheckedHeavyBlock("workflow", "heavy") ?? "", /^pi-foreman: subagent launch refused \[launch_refused:unchecked_heavy\]: 'workflow'/);
  assert.equal(uncheckedHeavyBlock("schedule.create", "standard"), undefined);
  assert.equal(uncheckedHeavyBlock(undefined, "heavy"), undefined);
});
