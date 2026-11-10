import test from "node:test";
import assert from "node:assert/strict";
import { parseRecords } from "./model.js";

test("parseRecords: pi-foreman background-task records count like pi-subagents ones", () => {
  const doc = JSON.stringify({
    records: {
      "subagents/abc": { app: "pi-subagents", state: "working", title: "explorer", msg: "Running" },
      "background-tasks/w1": { app: "pi-foreman", state: "working", title: "npm test", msg: "Running" },
      "background-tasks/w2": { app: "pi-foreman", state: "done", title: "old", msg: "Finished" },
      "other/x": { app: "someone-else", state: "working", title: "no", msg: "" },
    },
  });
  assert.deepEqual(parseRecords(doc), [
    { title: "explorer", state: "working", msg: "Running" },
    { title: "npm test", state: "working", msg: "Running" },
  ]);
});
