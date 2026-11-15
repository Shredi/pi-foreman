import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskHeader } from "../childask.ts";

test("ask header: `# Ask <n>: <topic>` on the first line only", () => {
  assert.deepEqual(parseAskHeader("# Ask 2: which schema?\n\nbody"), { n: 2, topic: "which schema?" });
  assert.equal(parseAskHeader("body\n# Ask 2: x"), null);
  assert.equal(parseAskHeader("# Ask two: x"), null);
  assert.equal(parseAskHeader("# Ask 3:"), null);
});
