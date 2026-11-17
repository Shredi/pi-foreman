import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("builder role prompt carries the scope fence (120a)", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "agents", "builder.md"), "utf8");
  assert.ok(text.includes("Scope fence: do only what the task names, for the inputs it names; add an abstraction only when two or more callers use it, and an option or flag only when something sets it."));
});
